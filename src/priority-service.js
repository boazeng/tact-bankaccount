// Shared Priority push/match logic — used by the interactive routes
// (POST /api/priority/auto-match-cashnames, POST /api/accounts/:id/push-to-priority)
// and by the daily scheduler. Pulled out of server.js verbatim so the two
// callers can't drift apart.
import {
  getAccount, listBanksWithAccounts, getTransactionsForPriorityCheck, updatePriorityStatus,
  setAccountPriorityCashname, getTransactionsForPush, batchSetPriorityCashnames, markTransactionsPushed,
} from './db.js';
import { checkAgainstPriority, priorityConfigured, fetchCashBanks, matchCashnameToAccount, findLastLoadedPage } from './priority/check.js';
import { pushToPriority, buildBankLinePayload } from './priority/push.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function autoMatchCashnames() {
  if (!priorityConfigured()) throw new HttpError(500, 'Priority not configured in env');

  const cashBanks = await fetchCashBanks();
  const banks = listBanksWithAccounts();
  const allAccounts = banks.flatMap(b => b.accounts.filter(a => a.is_active));

  const updates = [];
  const results = allAccounts.map(acc => {
    const cashname = matchCashnameToAccount(acc, cashBanks);
    if (cashname) updates.push({ accountId: acc.id, cashname });
    return {
      accountId: acc.id,
      maskedNumber: acc.masked_number,
      corporateName: acc.corporate_name,
      cashname,
      matched: !!cashname,
    };
  });

  if (updates.length) batchSetPriorityCashnames(updates);

  return {
    ok: true,
    matched: updates.length,
    unmatched: allAccounts.length - updates.length,
    results,
    cashBanksCount: cashBanks.length,
    cashBanksSample: cashBanks[0] ? Object.keys(cashBanks[0]) : [],
  };
}

/**
 * Checks one account against Priority and pushes whatever is missing
 * (or just previews it, with { preview: true }).
 */
export async function pushAccountToPriority(accountId, { preview = false } = {}) {
  let acc = getAccount(accountId);
  if (!acc) throw new HttpError(404, 'Account not found');
  if (!priorityConfigured()) throw new HttpError(500, 'Priority not configured in env');

  if (!acc.priority_cashname) {
    // Try to auto-discover the cashname from Priority's CASH_BANKS before giving up
    try {
      const cashBanks = await fetchCashBanks();
      const discovered = matchCashnameToAccount(acc, cashBanks);
      if (discovered) {
        setAccountPriorityCashname(accountId, discovered);
        acc = { ...acc, priority_cashname: discovered };
      }
    } catch {}
    if (!acc.priority_cashname) {
      throw new HttpError(400, 'לא הוגדר שם קופה בפריוריטי לחשבון זה');
    }
  }

  // Step 1: check which transactions exist in Priority (updates in_priority column)
  const allTxns = getTransactionsForPriorityCheck(accountId);
  const checkResult = await checkAgainstPriority(allTxns, acc.priority_cashname || null);
  updatePriorityStatus(checkResult.updates);

  // Step 2: collect transactions not found in Priority and not yet pushed
  const missing = getTransactionsForPush(accountId);

  // Step 2.5: never auto-push a transaction dated before the most recent BANKPAGES
  // already loaded in Priority — a "missing" match there almost always means it was
  // entered manually under a different reference number, not that it's truly absent.
  // Pushing it anyway creates a duplicate (see the 2026-06-21 check-deposit incident).
  let minPushDate = null;
  try {
    const lastPage = await findLastLoadedPage(acc.priority_cashname);
    if (lastPage) minPushDate = (lastPage.CURDATE || '').slice(0, 10);
  } catch (e) {
    console.warn('[push-to-priority] findLastLoadedPage failed, skipping old-date guard:', e.message);
  }
  const toPush = minPushDate ? missing.filter(t => t.date >= minPushDate) : missing;
  const skippedOld = minPushDate ? missing.filter(t => t.date < minPushDate) : [];

  if (preview) {
    const lines = toPush.map(t => ({ _txnId: t.id, ...buildBankLinePayload(t, acc.bank_id) }));
    return {
      ok: true,
      dryRun: true,
      accountId,
      cashName: acc.priority_cashname,
      checked: checkResult.ourTxnsChecked,
      matched: checkResult.matched,
      missing: toPush.length,
      preview: lines.slice(0, 50),
      previewTotal: lines.length,
      bankBalance: acc.last_balance,
      dateRange: checkResult.dateRange,
      fenceDate: checkResult.fenceDate || null,
      balanceDiscrepancy: checkResult.balanceDiscrepancy || null,
      minPushDate,
      skippedOld: skippedOld.map(t => ({ id: t.id, date: t.date, amount: t.amount })),
    };
  }

  // Step 3: push missing transactions to Priority
  const { pushed, failed } = await pushToPriority(toPush, acc.priority_cashname, acc.bank_id);
  if (pushed.length > 0) markTransactionsPushed(pushed);

  const pushedSet = new Set(pushed);
  const pushedLines = toPush
    .filter(t => pushedSet.has(t.id))
    .map(t => buildBankLinePayload(t, acc.bank_id));

  return {
    ok: true,
    dryRun: false,
    accountId,
    cashName: acc.priority_cashname,
    checked: checkResult.ourTxnsChecked,
    matched: checkResult.matched,
    pushed: pushed.length,
    failed: failed.length,
    missing: failed.length,
    failedDetails: failed.slice(0, 10),
    preview: pushedLines.slice(0, 50),
    previewTotal: pushed.length,
    bankBalance: acc.last_balance,
    dateRange: checkResult.dateRange,
    fenceDate: checkResult.fenceDate || null,
    balanceDiscrepancy: checkResult.balanceDiscrepancy || null,
    minPushDate,
    skippedOld: skippedOld.map(t => ({ id: t.id, date: t.date, amount: t.amount })),
  };
}
