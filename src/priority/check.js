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
 * Fetch all BANKLINESA rows in [fromDate, toDate] for a specific cashName.
 * Returns array of { CURDATE, CREDIT, DEBIT, CASHNAME, BANKPAGE, KLINE }.
 */
async function fetchPriorityLines(fromDate, toDate, cashName = null) {
  let filter = `CURDATE ge ${fromDate}T00:00:00Z and CURDATE le ${toDate}T23:59:59Z`;
  if (cashName) filter += ` and CASHNAME eq '${cashName}'`;
  const params = new URLSearchParams({
    '$filter': filter,
    '$select': 'CASHNAME,CURDATE,CREDIT,DEBIT,BANKPAGE,KLINE,ERECONNUM',
    '$top': '5000',
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

const shiftDate = (dateStr, days) => {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Match our transactions against Priority's BANKLINESA.
 *
 * When cashName is provided (preferred): uses day-level matching —
 *   if Priority has ANY entry for that CASHNAME on a given date (±1 day),
 *   all our transactions on that date are marked as in Priority.
 *   This mirrors how bookkeepers work: they import full days, not individual lines.
 *
 * When cashName is null: falls back to date+amount matching (legacy).
 *
 * ourTxns: [{ id, date: 'YYYY-MM-DD', amount: signed number }]
 */
export async function checkAgainstPriority(ourTxns, cashName = null) {
  if (!priorityConfigured()) {
    throw new Error('Priority not configured (missing PRIORITY_URL_REAL/USERNAME/PASSWORD in env)');
  }
  if (!ourTxns.length) {
    return { ok: true, priorityLinesChecked: 0, ourTxnsChecked: 0, matched: 0, updates: [] };
  }

  const dates = ourTxns.map(t => t.date).filter(Boolean).sort();
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];

  const priorityLines = await fetchPriorityLines(fromDate, toDate, cashName);

  const updates = [];
  let matched = 0;

  if (cashName) {
    // Day-level matching: build a Set of dates that exist in Priority for this account.
    // Index each date and its ±1 neighbours to absorb posting-date vs value-date skew.
    const priorityDates = new Set();
    // Also keep a map from date → first BANKPAGE seen that day (for the bankpage field)
    const dateToBankpage = new Map();
    for (const line of priorityLines) {
      const date = (line.CURDATE || '').slice(0, 10);
      if (!date) continue;
      for (const d of [shiftDate(date, -1), date, shiftDate(date, +1)]) {
        priorityDates.add(d);
        if (!dateToBankpage.has(d)) dateToBankpage.set(d, String(line.BANKPAGE || ''));
      }
    }
    for (const txn of ourTxns) {
      if (priorityDates.has(txn.date)) {
        matched++;
        updates.push({ id: txn.id, inPriority: 1, bankpage: dateToBankpage.get(txn.date) || null });
      } else {
        updates.push({ id: txn.id, inPriority: 0, bankpage: null });
      }
    }
  } else {
    // Legacy: date + amount matching (no CASHNAME filter available)
    const index = new Map();
    const addToIndex = (dateStr, amount, line) => {
      const key = `${dateStr}|${amount.toFixed(2)}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(line);
    };
    for (const line of priorityLines) {
      const date = (line.CURDATE || '').slice(0, 10);
      const credit = Number(line.CREDIT || 0);
      const debit = Number(line.DEBIT || 0);
      const amount = credit > 0 ? credit : -Math.abs(debit);
      addToIndex(date, amount, line);
      addToIndex(shiftDate(date, -1), amount, line);
      addToIndex(shiftDate(date, +1), amount, line);
    }
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
 * Fetch all bank-account cash-journals from Priority's CASH entity.
 * CASH is the OData entity for the CASH_BANKS screen.
 * Filters to CASHTYPEDES = 'חשבון בנק' and returns { CASHNAME, CASHDES }.
 * CASHDES contains the branch-account pattern, e.g. "בנק פועלים 610-681453 יעל ישראל".
 */
export async function fetchCashBanks() {
  if (!priorityConfigured()) {
    throw new Error('Priority not configured (missing PRIORITY_URL_REAL/USERNAME/PASSWORD in env)');
  }
  const params = new URLSearchParams({
    '$select': 'CASHNAME,CASHDES,CASHTYPEDES',
    '$filter': "CASHTYPEDES eq 'חשבון בנק'",
    '$top': '500',
  });
  const url = `${PRIORITY_URL}/CASH?${params}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Priority CASH query failed: HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.value || [];
}

/**
 * Auto-match a single bank account to a Priority CASHNAME.
 *
 * Uses Priority's CASH entity (CASHDES field contains "branch-account" pattern).
 * Example CASHDES: "בנק פועלים 610-681453 יעל ישראל"
 *
 * Matching logic:
 *  Pass 1: branch + account both found in CASHDES
 *  Pass 2: account number alone (only if exactly one hit among bank-type entries)
 *
 * account: { branch_id, masked_number }
 * cashBanks: array from fetchCashBanks()
 * Returns CASHNAME string or null if no match.
 */
export function matchCashnameToAccount(account, cashBanks) {
  const strip = (s) => String(s || '').replace(/^0+/, '').replace(/\D/g, '');

  const ourBranch = strip(account.branch_id);
  const maskedParts = (account.masked_number || '').split(/[-/]/);
  const ourAccount = strip(maskedParts[1] || maskedParts[0] || '');

  if (!ourAccount || ourAccount.length < 2) return null;

  // Extract all digit-sequences from CASHDES for comparison
  const getDigitGroups = (des) => (des || '').match(/\d+/g) || [];

  // Pass 1: branch + account both found in CASHDES (branch guard allows short account numbers)
  for (const cb of cashBanks) {
    const groups = getDigitGroups(cb.CASHDES);
    const hasBranch = ourBranch && groups.some(g => strip(g) === ourBranch);
    const hasAccount = groups.some(g => {
      const sg = strip(g);
      return sg.length >= 2 && (ourAccount.startsWith(sg) || sg.startsWith(ourAccount));
    });
    if (hasBranch && hasAccount) return cb.CASHNAME;
  }

  // Pass 2: account number alone — keep min length 4 to avoid false positives without branch guard
  const byAccount = cashBanks.filter(cb => {
    const groups = getDigitGroups(cb.CASHDES);
    return groups.some(g => {
      const sg = strip(g);
      return sg.length >= 4 && ourAccount.length >= 4 &&
             (ourAccount.startsWith(sg) || sg.startsWith(ourAccount));
    });
  });
  if (byAccount.length === 1) return byAccount[0].CASHNAME;

  return null;
}

export { priorityConfigured };
