// Shared bank-sync logic — used by both the interactive SSE route
// (POST /api/banks/:bankId/sync) and the unattended daily scheduler.
// Pulled out of server.js verbatim so the two callers can't drift apart;
// the only thing that differs between them is how progress is reported
// (onEvent) and how SMS prompts are handled (onSmsRequired).
import { getBank, bankRegistry } from './scrapers/index.js';
import {
  upsertAccount, insertTransactions, updateLastSync,
  getInactiveMaskedNumbers, getTransactionsForBalanceCheck,
} from './db.js';
import { resolveAllCredentialsForBank } from './secrets/bank-creds.js';
import { checkBalanceContinuity } from './balance-check.js';
// Poalim-only: it demands a fresh SMS code on every login, so bundling its
// credit-card fetch into this same bank-sync session (via scrapePoalim's
// fetchCards option) means the user types the code once instead of twice.
// Every other bank's card sync stays fully separate (see credit-cards/routes.js).
import {
  upsertCard, updateCardLastSync, insertCardTransactions, deleteStaleCardTransactions,
} from './credit-cards/db.js';
import { upsertFacility, deleteStaleFacilities } from './facilities/db.js';

/**
 * Syncs every account for one bank across all configured credential sets.
 * Returns the same shape the SSE route used to send as its 'done' event.
 * Throws on hard failures (unknown bank, missing/incomplete credentials,
 * scrape error) — callers decide how to surface that (SSE 'error' event,
 * or a caught/logged entry in the scheduler's summary).
 */
export async function runBankSync(bankId, { daysBack = 30, actor = 'sync', onEvent = () => {}, onSmsRequired } = {}) {
  const bank = getBank(bankId);

  const allCredentialSets = resolveAllCredentialsForBank(bankId, bankRegistry, actor);
  if (!allCredentialSets.length) {
    throw new Error(`אין פרטי כניסה מוגדרים ל-${bankId} — הגדר ב-/bank-credentials.html`);
  }
  for (const { label, credentials } of allCredentialSets) {
    const missing = Object.entries(credentials).filter(([_, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw new Error(`חסרים פרטי כניסה עבור "${label}" (${bankId}): ${missing.join(', ')}`);
    }
  }

  onEvent('progress', { step: 'start', message: `מתחיל סנכרון ${bank.info.nameHe} (${daysBack} ימים)` });

  const inactiveSet = getInactiveMaskedNumbers(bankId);
  let totalNew = 0;
  let totalAll = 0;
  let skippedInactive = 0;
  let totalNewCardTxns = 0;
  let totalCards = 0;
  const perAccount = [];
  let lastResult = null;

  for (const { label, credentials } of allCredentialSets) {
    if (allCredentialSets.length > 1) {
      onEvent('progress', { step: 'credential', message: `מתחבר עם פרטי כניסה: "${label}"` });
    }

    const result = await bank.scrape({
      credentials,
      daysBack,
      onProgress: (p) => onEvent('progress', p),
      onSmsRequired,
      // Ignored by every scraper except Poalim's — see the import comment above.
      fetchCards: bankId === 'poalim',
    });
    lastResult = result;

    for (const accResult of result.accounts) {
      const accountId = upsertAccount({
        bankId,
        accountIndex: accResult.account.accountIndex,
        maskedNumber: accResult.account.maskedNumber,
        corporateName: accResult.account.corporateName,
        iban: accResult.account.iban,
        balance: accResult.account.balance,
        branchId: accResult.account.branchId,
        branchName: accResult.account.branchName,
      });

      if (inactiveSet.has(accResult.account.maskedNumber)) {
        skippedInactive++;
        onEvent('account-skipped', {
          maskedNumber: accResult.account.maskedNumber,
          corporateName: accResult.account.corporateName,
          reason: 'inactive',
        });
        continue;
      }

      const todayStr = new Date().toISOString().slice(0, 10);
      const historyToSave = accResult.transactions.history.filter(t => (t.date || '').slice(0, 10) < todayStr);
      const pendingToSave = accResult.transactions.pending.filter(t => (t.date || '').slice(0, 10) < todayStr);
      const newHistory = insertTransactions(accountId, historyToSave, { status: 'completed' });
      const newPending = insertTransactions(accountId, pendingToSave, { status: 'pending' });
      const newCount = newHistory + newPending;
      const fetched = historyToSave.length + pendingToSave.length;

      updateLastSync(accountId, accResult.account.balance);

      // Deposits/loans/guarantees — informational only (no Priority push).
      // A bank returning nothing for a category just means it's actually
      // empty right now, and stale rows from the last sync (e.g. a loan that
      // got paid off) are removed the same way stale card transactions are.
      const facilities = accResult.facilities ?? { deposits: [], loans: [], guarantees: [] };
      for (const category of ['deposits', 'loans', 'guarantees']) {
        const items = facilities[category] ?? [];
        for (const item of items) {
          upsertFacility({
            ...item,
            bankId,
            accountMaskedNumber: accResult.account.maskedNumber,
            corporateName: accResult.account.corporateName,
          });
        }
        deleteStaleFacilities(
          bankId, accResult.account.maskedNumber, category.slice(0, -1),
          items.map(i => i.externalId),
        );
      }

      try {
        const balanceResult = checkBalanceContinuity(getTransactionsForBalanceCheck(accountId));
        if (!balanceResult.ok) {
          onEvent('balance-check', {
            accountId,
            maskedNumber: accResult.account.maskedNumber,
            corporateName: accResult.account.corporateName,
            mismatches: balanceResult.mismatches.slice(0, 10),
          });
        }
      } catch (e) {
        console.warn('[sync] balance-continuity check failed:', e.message);
      }

      totalNew += newCount;
      totalAll += fetched;
      perAccount.push({
        accountId,
        maskedNumber: accResult.account.maskedNumber,
        corporateName: accResult.account.corporateName,
        fetched,
        newSaved: newCount,
        dedupSkipped: fetched - newCount,
      });

      onEvent('account-saved', {
        maskedNumber: accResult.account.maskedNumber,
        corporateName: accResult.account.corporateName,
        fetched,
        newSaved: newCount,
        dedupSkipped: fetched - newCount,
      });
    }

    // Poalim-only combined session (see fetchCards above) — save the card
    // data it pulled through the SAME login, using the identical save logic
    // as runCardBankSync in credit-cards/routes.js so the two paths can't
    // silently diverge.
    for (const entry of result.cards ?? []) {
      const cardId = upsertCard({
        bankId,
        accountMaskedNumber: entry.account.maskedNumber,
        cardLast4: entry.card.cardLast4,
        label: entry.card.label,
        corporateName: entry.account.corporateName,
      });
      const newCardCount = insertCardTransactions(cardId, entry.transactions);
      const billingDates = [...new Set(entry.transactions.map(t => t.billingDate).filter(Boolean))];
      const keepIds = entry.transactions.map(t => t.transactionID);
      const staleRemoved = billingDates.reduce(
        (sum, date) => sum + deleteStaleCardTransactions(cardId, date, keepIds),
        0,
      );
      updateCardLastSync(cardId);
      totalCards++;
      totalNewCardTxns += newCardCount;

      onEvent('card-saved', {
        cardLast4: entry.card.cardLast4,
        account: entry.account.maskedNumber,
        fetched: entry.transactions.length,
        newSaved: newCardCount,
        staleRemoved,
      });
    }
  }

  return {
    bankId,
    bankName: bank.info.nameHe,
    daysBack,
    fromDate: lastResult?.fromDate,
    toDate: lastResult?.toDate,
    accountsCount: perAccount.length,
    skippedInactive,
    totalFetched: totalAll,
    totalNewSaved: totalNew,
    totalDedupSkipped: totalAll - totalNew,
    perAccount,
    totalCards,
    totalNewCardTxns,
  };
}
