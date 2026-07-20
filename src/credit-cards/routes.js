import express from 'express';
import crypto from 'node:crypto';
import { requireRole } from '../auth/index.js';
import { resolveAllCredentialsForBank } from '../secrets/bank-creds.js';
import { bankRegistry } from '../scrapers/index.js';
import { scrapeDiscountCards, bankInfo as discountCardsInfo } from './scrapers/discount.js';
import { scrapePoalimCards, bankInfo as poalimCardsInfo } from './scrapers/poalim.js';
import { scrapeLeumiCards, bankInfo as leumiCardsInfo } from './scrapers/leumi.js';
import {
  upsertCard, updateCardLastSync, insertCardTransactions, deleteStaleCardTransactions,
  listCards, getCard, getCardTransactions, getPriorityPreviewForCard,
  setCardPriorityCashname, recordPagePushed,
} from './db.js';
import { pushCardPageToPriority, checkCardPageStatus, priorityConfigured } from './priority-push.js';

// Registry of bank card-scrapers implemented so far. Reuses the same
// bankRegistry entries from src/scrapers/index.js only for credential shape
// resolution (resolveAllCredentialsForBank needs it) — no scraping code is shared.
const cardScraperRegistry = {
  [discountCardsInfo.id]: { info: discountCardsInfo, scrape: scrapeDiscountCards },
  [poalimCardsInfo.id]: { info: poalimCardsInfo, scrape: scrapePoalimCards },
  [leumiCardsInfo.id]: { info: leumiCardsInfo, scrape: scrapeLeumiCards },
};

// In-memory map of in-flight card-scraper sessions waiting on user input (SMS
// code, etc.) — mirrors src/server.js's pendingInputs bridge but kept as its
// own instance on purpose (see plan: src/credit-cards/ shares no code with
// the rest of the app), keyed by the same per-sync syncId.
const pendingInputs = new Map();
const PENDING_INPUT_TIMEOUT_MS = 5 * 60 * 1000;

const router = express.Router();

// Lets the main dashboard (public/app.js) know which banks have a
// credit-card scraper implemented, so it can auto-trigger a card sync right
// after that bank's checking-account sync — without hardcoding bank ids in
// two places that could drift apart as more card scrapers get added.
router.get('/api/credit-cards/supported-banks', (req, res) => {
  res.json({ bankIds: Object.keys(cardScraperRegistry) });
});

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

/**
 * Preview + LIVE status against Priority itself for every page — never
 * trusts our own local card_priority_pushes bookkeeping, which is only an
 * audit log and can't tell whether every line actually landed (see
 * checkCardPageStatus). This is the fix for the UI claiming a page was
 * captured when Priority never actually got (all of) its lines.
 */
router.get('/api/credit-cards/:cardId/priority-preview', async (req, res) => {
  const cardId = Number(req.params.cardId);
  const card = getCard(cardId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const pages = getPriorityPreviewForCard(cardId);

  if (card.priority_cashname && priorityConfigured()) {
    for (const page of pages) {
      try {
        const { status, missingCount, lineMatches, otherCashnamesOnDate } = await checkCardPageStatus(card.priority_cashname, page);
        page.priorityStatus = status;
        page.missingCount = missingCount;
        if (lineMatches) page.lines = lineMatches; // replaces page.lines with the same lines annotated with `matched`
        if (otherCashnamesOnDate?.length) page.otherCashnamesOnDate = otherCashnamesOnDate;
      } catch (e) {
        page.priorityStatus = 'unknown';
        page.statusError = e.message;
      }
    }
  }

  res.json({ card, pages });
});

router.put('/api/credit-cards/:cardId/cashname', requireRole('admin'), (req, res) => {
  const cardId = Number(req.params.cardId);
  const card = getCard(cardId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const cashname = (req.body?.cashname || '').trim();
  if (!cashname) return res.status(400).json({ error: 'cashname חובה' });
  setCardPriorityCashname(cardId, cashname);
  res.json({ ok: true });
});

/**
 * Pushes every page for one card, checking Priority itself (via
 * pushCardPageToPriority's internal diff) rather than our own local
 * bookkeeping — a page a previous attempt only partially landed gets
 * topped up here instead of being skipped as "already done". Safe to call
 * repeatedly: a fully-complete page is a fast no-op (findExistingCardPage +
 * one BANKLINESA lookup, nothing to POST).
 */
async function pushCardToPriority(card) {
  const today = new Date().toISOString().slice(0, 10);
  const pages = getPriorityPreviewForCard(card.id);
  const results = [];
  for (const page of pages) {
    // Last line of defense: never push a page dated in the future — a real
    // bank debit can't have happened yet. Confirmed live that stale data
    // from before a scraper fix reached Priority this way once already.
    if (page.curdate > today) {
      results.push({ curdate: page.curdate, ok: false, error: `דף עתידי (${page.curdate}) — לא נקלט` });
      continue;
    }
    try {
      const result = await pushCardPageToPriority(card.priority_cashname, page);
      const ok = result.failed.length === 0;
      // Only record success once every line is confirmed pushed — recording
      // on a partial failure is exactly the bug that made the UI claim a
      // page was captured when it wasn't.
      if (ok) recordPagePushed(card.id, page.curdate, result);
      results.push({ curdate: page.curdate, ok, ...result });
    } catch (e) {
      results.push({ curdate: page.curdate, ok: false, error: e.message });
    }
  }
  return results;
}

router.post('/api/credit-cards/:cardId/push-to-priority', requireRole('approver'), async (req, res) => {
  if (!priorityConfigured()) return res.status(500).json({ error: 'פריוריטי לא מוגדר (PRIORITY_URL_REAL/PRIORITY_USERNAME/PRIORITY_PASSWORD)' });
  const cardId = Number(req.params.cardId);
  const card = getCard(cardId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (!card.priority_cashname) return res.status(400).json({ error: 'לא הוגדר CASHNAME לכרטיס הזה' });

  try {
    const results = await pushCardToPriority(card);
    res.json({ results });
  } catch (e) {
    console.error('[credit-cards] push-to-priority error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/credit-cards/push-all-to-priority', requireRole('approver'), async (req, res) => {
  if (!priorityConfigured()) return res.status(500).json({ error: 'פריוריטי לא מוגדר (PRIORITY_URL_REAL/PRIORITY_USERNAME/PRIORITY_PASSWORD)' });

  const cards = listCards().filter(c => c.priority_cashname);
  const byCard = [];
  for (const card of cards) {
    try {
      const results = await pushCardToPriority(card);
      byCard.push({ cardId: card.id, cardLast4: card.card_last4, results });
    } catch (e) {
      byCard.push({ cardId: card.id, cardLast4: card.card_last4, error: e.message });
    }
  }
  res.json({ byCard });
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

  const syncId = crypto.randomUUID();

  // Same SMS bridge pattern as src/server.js's bank sync: the scraper calls
  // onSmsRequired, we emit an SSE event carrying syncId, the UI posts the code
  // back to POST /api/credit-cards/sync/:syncId/sms-code, which resolves this promise.
  const onSmsRequired = ({ message } = {}) => {
    send('sms-required', { syncId, message: message || 'נדרש קוד SMS' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingInputs.get(syncId)?.resolve === resolve) pendingInputs.delete(syncId);
        reject(new Error('SMS code timeout (5 min)'));
      }, PENDING_INPUT_TIMEOUT_MS);
      pendingInputs.set(syncId, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  };

  req.on('close', () => {
    const p = pendingInputs.get(syncId);
    if (p) { pendingInputs.delete(syncId); p.reject(new Error('Client disconnected')); }
  });

  try {
    send('sync-started', { syncId, bankId });
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
        onSmsRequired,
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

// User-input bridge for in-flight card syncs (SMS codes) — same shape as
// src/server.js's /api/sync/:syncId/sms-code, kept as its own route on
// purpose (see the isolated pendingInputs map above).
router.post('/api/credit-cards/sync/:syncId/sms-code', requireRole('approver'), (req, res) => {
  const { syncId } = req.params;
  const code = (req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'קוד חסר' });
  const pending = pendingInputs.get(syncId);
  if (!pending) return res.status(404).json({ error: 'אין סנכרון פעיל שמחכה לקוד (אולי פג תוקף)' });
  pendingInputs.delete(syncId);
  pending.resolve(code);
  res.json({ ok: true });
});

export default router;
