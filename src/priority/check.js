// Priority ERP check agent.
//
// For a given account, fetches BANKLINESA rows from Priority (the bank
// statement lines a bookkeeper has loaded into Priority) and matches them
// against our local transactions by (date, amount). Marks each of our
// transactions as in_priority=1 if a match exists, or 0 if it was checked
// but no match was found.
//
// Uses the same Priority credentials as the accounting project:
//   PRIORITY_URL_REAL, PRIORITY_USERNAME, PRIORITY_PASSWORD
// Env loading is handled by the server entry point.

const PRIORITY_URL = (process.env.PRIORITY_URL_REAL || '').replace(/\/$/, '');
const PRIORITY_USERNAME = process.env.PRIORITY_USERNAME || '';
const PRIORITY_PASSWORD = process.env.PRIORITY_PASSWORD || '';

const authHeader = 'Basic ' + Buffer.from(`${PRIORITY_USERNAME}:${PRIORITY_PASSWORD}`).toString('base64');
const headers = {
  authorization: authHeader,
  accept: 'application/json',
  'odata-version': '4.0',
};

function priorityConfigured() {
  return !!(PRIORITY_URL && PRIORITY_USERNAME && PRIORITY_PASSWORD);
}

/**
 * Fetch all BANKLINESA rows in [fromDate, toDate] (ISO YYYY-MM-DD strings).
 * Returns array of { CURDATE, CREDIT, DEBIT, DETAILS, CASHNAME, BANKPAGE, KLINE }.
 */
async function fetchPriorityLines(fromDate, toDate) {
  const filter = `CURDATE ge ${fromDate}T00:00:00Z and CURDATE le ${toDate}T23:59:59Z`;
  const params = new URLSearchParams({
    '$filter': filter,
    '$select': 'CASHNAME,CURDATE,DETAILS,CREDIT,DEBIT,BANKPAGE,KLINE,ERECONNUM',
    '$top': '2000',
  });
  const url = `${PRIORITY_URL}/BANKLINESA?${params}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Priority BANKLINESA query failed: HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.value || [];
}

/**
 * Match our transactions against Priority's BANKLINESA.
 *
 * ourTxns: [{ id, date: 'YYYY-MM-DD', amount: signed number }]
 *
 * Matching rule: same date AND same amount (after sign conversion).
 *   - Priority CREDIT > 0 → money in (positive amount)
 *   - Priority DEBIT > 0  → money out (negative amount)
 *
 * Returns:
 *   {
 *     ok: true,
 *     priorityLinesChecked: number,
 *     ourTxnsChecked: number,
 *     matched: number,
 *     updates: [{ id, inPriority: 0|1, bankpage: string|null }]
 *   }
 */
export async function checkAgainstPriority(ourTxns) {
  if (!priorityConfigured()) {
    throw new Error('Priority not configured (missing PRIORITY_URL_REAL/USERNAME/PASSWORD in env)');
  }
  if (!ourTxns.length) {
    return { ok: true, priorityLinesChecked: 0, ourTxnsChecked: 0, matched: 0, updates: [] };
  }

  const dates = ourTxns.map(t => t.date).filter(Boolean).sort();
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];

  const priorityLines = await fetchPriorityLines(fromDate, toDate);

  // Build an index: "YYYY-MM-DD|amount.toFixed(2)" → array of priority lines
  const index = new Map();
  for (const line of priorityLines) {
    const date = (line.CURDATE || '').slice(0, 10);
    const credit = Number(line.CREDIT || 0);
    const debit = Number(line.DEBIT || 0);
    const amount = credit > 0 ? credit : -Math.abs(debit);
    const key = `${date}|${amount.toFixed(2)}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(line);
  }

  const updates = [];
  let matched = 0;
  for (const txn of ourTxns) {
    const amount = Number(txn.amount);
    const key = `${txn.date}|${amount.toFixed(2)}`;
    const candidates = index.get(key) || [];
    if (candidates.length > 0) {
      matched++;
      updates.push({ id: txn.id, inPriority: 1, bankpage: String(candidates[0].BANKPAGE || '') });
    } else {
      updates.push({ id: txn.id, inPriority: 0, bankpage: null });
    }
  }

  return {
    ok: true,
    priorityLinesChecked: priorityLines.length,
    ourTxnsChecked: ourTxns.length,
    matched,
    updates,
    dateRange: { from: fromDate, to: toDate },
  };
}

/**
 * Fetch all CASHBANKS rows (cash journals / bank accounts configured in Priority).
 * Returns array of { CASHNAME, BANKNAME, BRANCHNUM, ACCOUNTNUM, BANKNUM }.
 */
export async function fetchCashBanks() {
  if (!priorityConfigured()) {
    throw new Error('Priority not configured (missing PRIORITY_URL_REAL/USERNAME/PASSWORD in env)');
  }
  // Fetch all fields so we can see exactly what Priority returns for CASHBANKS.
  // Once field names are confirmed, we can narrow with $select.
  const params = new URLSearchParams({
    '$top': '200',
    '$orderby': 'CASHNAME',
  });
  const url = `${PRIORITY_URL}/CASHBANKS?${params}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Priority CASHBANKS query failed: HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.value || [];
}

/**
 * Auto-match a single bank account to a Priority CASHNAME.
 *
 * Matching logic (in priority order):
 *  1. branch_id matches BRANCHNUM AND account number from masked_number matches ACCOUNTNUM
 *  2. Account number from masked_number matches ACCOUNTNUM alone (if unique)
 *
 * account: { branch_id, masked_number }
 * cashBanks: array from fetchCashBanks()
 * Returns CASHNAME string or null if no match.
 */
export function matchCashnameToAccount(account, cashBanks) {
  const strip = (s) => String(s || '').replace(/^0+/, '').replace(/\D/g, '');

  const ourBranch = strip(account.branch_id);
  // Extract digits from masked_number after the first separator
  const maskedParts = (account.masked_number || '').split(/[-/]/);
  const ourAccount = strip(maskedParts[1] || maskedParts[0] || '');

  if (!ourAccount) return null;

  // Pass 1: branch + account both match
  for (const cb of cashBanks) {
    const cbBranch = strip(cb.BRANCHNUM);
    const cbAccount = strip(cb.ACCOUNTNUM);
    if (!cbAccount) continue;
    if (cbBranch === ourBranch && ourAccount.startsWith(cbAccount)) return cb.CASHNAME;
    if (cbBranch === ourBranch && cbAccount.startsWith(ourAccount)) return cb.CASHNAME;
  }

  // Pass 2: account number alone (only if exactly one hit)
  const byAccount = cashBanks.filter(cb => {
    const cbAccount = strip(cb.ACCOUNTNUM);
    return cbAccount.length >= 4 && (ourAccount.startsWith(cbAccount) || cbAccount.startsWith(ourAccount));
  });
  if (byAccount.length === 1) return byAccount[0].CASHNAME;

  return null;
}

export { priorityConfigured };
