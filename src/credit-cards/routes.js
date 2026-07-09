import express from 'express';
import crypto from 'node:crypto';
import { requireRole } from '../auth/index.js';
import { resolveAllCredentialsForBank } from '../secrets/bank-creds.js';
import { bankRegistry } from '../scrapers/index.js';
import { scrapeDiscountCards, bankInfo as discountCardsInfo } from './scrapers/discount.js';
import { upsertCard, updateCardLastSync, insertCardTransactions, deleteStaleCardTransactions, listCards, getCard, getCardTransactions, getPriorityPreviewForCard } from './db.js';

// Registry of bank card-scrapers implemented so far. Reuses the same
// bankRegistry entries from src/scrapers/index.js only for credential shape
// resolution (resolveAllCredentialsForBank needs it) — no scraping code is shared.
const cardScraperRegistry = {
  [discountCardsInfo.id]: { info: discountCardsInfo, scrape: scrapeDiscountCards },
};

const router = express.Router();

router.get('/api/credit-cards', (req, res) => {
  res.json({ cards: listCards() });
});

router.get('/api/credit-cards/:cardId/transactions', (req, res) => {
  const cardId = Number(req.params.cardId);
  const card = getCard(cardId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const offset = Number(req.query.offset) || 0;
  const transactions = getCardTransactions(cardId, { limit, offset });
  res.json({ card, transactions });
});

router.get('/api/credit-cards/:cardId/priority-preview', (req, res) => {
  const cardId = Number(req.params.cardId);
  const card = getCard(cardId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json({ card, pages: getPriorityPreviewForCard(cardId) });
});

router.post('/api/credit-cards/:bankId/sync', requireRole('approver'), async (req, res) => {
  const bankId = req.params.bankId;
  const bank = cardScraperRegistry[bankId];
  if (!bank) return res.status(404).json({ error: `אין תמיכה עדיין בכרטיסי אשראי לבנק: ${bankId}` });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const allCredentialSets = resolveAllCredentialsForBank(bankId, bankRegistry, req.user?.email || 'sync-cards');
  if (!allCredentialSets.length) {
    send('error', { message: `אין פרטי כניסה מוגדרים ל-${bankId} — הגדר ב-/bank-credentials.html` });
    return res.end();
  }

  try {
    send('sync-started', { syncId: crypto.randomUUID(), bankId });
    send('progress', { step: 'start', message: `מתחיל סנכרון כרטיסי אשראי — ${bank.info.nameHe}` });

    let totalNewTxns = 0;
    let totalCards = 0;

    for (const { label, credentials } of allCredentialSets) {
      const missing = Object.entries(credentials).filter(([_, v]) => !v).map(([k]) => k);
      if (missing.length) {
        send('progress', { step: 'credential-skip', message: `דילוג על "${label}": חסרים ${missing.join(', ')}` });
        continue;
      }

      const result = await bank.scrape({
        credentials,
        onProgress: (p) => send('progress', p),
      });

      for (const entry of result.cards) {
        const cardId = upsertCard({
          bankId,
          accountMaskedNumber: entry.account.maskedNumber,
          cardLast4: entry.card.cardLast4,
          label: entry.card.label,
        });
        const newCount = insertCardTransactions(cardId, entry.transactions);

        // Remove rows for this same cycle that the bank no longer reports —
        // e.g. an entry the scraper previously mis-included and has since
        // learned to exclude (see the "not yet finalized" fix). Only cleans
        // up the exact billing_date just synced; other cycles are untouched.
        const billingDate = entry.transactions[0]?.billingDate;
        const staleRemoved = deleteStaleCardTransactions(
          cardId, billingDate, entry.transactions.map(t => t.transactionID),
        );

        updateCardLastSync(cardId);
        totalCards++;
        totalNewTxns += newCount;

        send('card-saved', {
          cardLast4: entry.card.cardLast4,
          account: entry.account.maskedNumber,
          fetched: entry.transactions.length,
          newSaved: newCount,
          staleRemoved,
        });
      }
    }

    send('done', { bankId, totalCards, totalNewTxns });
  } catch (err) {
    console.error('[credit-cards] sync error:', err);
    send('error', { message: err.message, stack: err.stack?.split('\n').slice(0, 5).join('\n') });
  } finally {
    res.end();
  }
});

export default router;
