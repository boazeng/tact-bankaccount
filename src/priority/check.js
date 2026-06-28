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
    '$select': 'CASHNAME,CURDATE,CREDIT,DEBIT,BANKPAGE,KLINE,ERECONNUM,CURBAL',
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

  const allDates = ourTxns.flatMap(t => [t.date, t.effective_date]).filter(Boolean).sort();
  const fromDate = allDates[0];
  const toDate = allDates[allDates.length - 1];

  const priorityLines = await fetchPriorityLines(fromDate, toDate, cashName);

  const updates = [];
  let matched = 0;

  if (cashName) {
    // ── Step 1: build per-date indexes from Priority ─────────────────────
    const priorityByDate = new Map(); // date → [signed amount, ...]
    const dateToBankpage = new Map();
    // CURBAL: keep the balance of the last line per date (highest KLINE = end-of-day)
    const priorityBalByDate = new Map(); // date → { balance, kline }
    for (const line of priorityLines) {
      const date = (line.CURDATE || '').slice(0, 10);
      if (!date) continue;
      const credit = Number(line.CREDIT || 0);
      const debit = Number(line.DEBIT || 0);
      const amount = credit > 0 ? credit : -Math.abs(debit);
      if (!priorityByDate.has(date)) priorityByDate.set(date, []);
      priorityByDate.get(date).push(amount);
      if (!dateToBankpage.has(date)) dateToBankpage.set(date, String(line.BANKPAGE || ''));
      if (line.CURBAL != null) {
        const kline = Number(line.KLINE || 0);
        const cur = priorityBalByDate.get(date);
        if (!cur || kline > cur.kline) priorityBalByDate.set(date, { balance: Number(line.CURBAL), kline });
      }
    }

    // ── Step 2: build our bank's end-of-day balance per date ─────────────
    // Transactions are ordered by date, id ASC — last row per date has the end-of-day balance.
    const ourBalByDate = new Map(); // date → { balance, id }
    for (const txn of ourTxns) {
      if (txn.running_balance == null) continue;
      const cur = ourBalByDate.get(txn.date);
      if (!cur || txn.id > cur.id) ourBalByDate.set(txn.date, { balance: txn.running_balance, id: txn.id });
    }

    // ── Step 3: find balance fence date ──────────────────────────────────
    // The fence date is the latest date where Priority's end-of-day balance equals
    // our bank's end-of-day balance (within 0.01). All transactions on or before
    // the fence date are confirmed complete in Priority — no need to check individually.
    let fenceDate = null;
    if (priorityBalByDate.size > 0 && ourBalByDate.size > 0) {
      const candidateDates = [...ourBalByDate.keys()].filter(d => priorityBalByDate.has(d)).sort();
      for (const date of candidateDates) {
        const ourBal = ourBalByDate.get(date).balance;
        const prioBal = priorityBalByDate.get(date).balance;
        if (Math.abs(ourBal - prioBal) < 0.01) fenceDate = date;
      }
    }

    // ── Step 4: match each transaction ───────────────────────────────────
    for (const txn of ourTxns) {
      // Transactions on or before the fence date are verified by balance — all present.
      if (fenceDate && txn.date <= fenceDate) {
        matched++;
        updates.push({ id: txn.id, inPriority: 1, bankpage: dateToBankpage.get(txn.date) || null });
        continue;
      }
      // Post-fence: amount + date matching (±1 day).
      const checkDate = txn.effective_date || txn.date;
      const txnAmount = Number(txn.amount);
      let matchDate = null;
      for (const d of [checkDate, shiftDate(checkDate, -1), shiftDate(checkDate, +1)]) {
        const amounts = priorityByDate.get(d);
        if (amounts && amounts.some(a => Math.abs(a - txnAmount) < 0.005)) {
          matchDate = d;
          break;
        }
      }
      if (matchDate !== null) {
        matched++;
        updates.push({ id: txn.id, inPriority: 1, bankpage: dateToBankpage.get(matchDate) || null });
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
      fenceDate,
    };
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
 * Fetch all bank-account cash-journals from Priority's CASH entity (CASH_BANKS screen).
 * Filters to CASHTYPEDES = 'חשבון בנק'. Returns all fields so structured bank fields
 * (BANKNO, BRANCHNO, BANKACCOUNTNO) are available for direct matching when present.
 */
export async function fetchCashBanks() {
  if (!priorityConfigured()) {
    throw new Error('Priority not configured (missing PRIORITY_URL_REAL/USERNAME/PASSWORD in env)');
  }
  const params = new URLSearchParams({
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
 * Matching logic (in priority order):
 *  Pass 0: structured fields BANKNO+BRANCHNO+BANKACCOUNTNO (exact, if Priority returns them)
 *  Pass 1: branch + account both found in CASHDES text
 *  Pass 2: account number alone in CASHDES (only if exactly one hit)
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

  // Pass 0: structured bank fields — most reliable, no text parsing needed
  // Priority field names: BANKNO (בנק), BRANCHNO (סניף), BANKACCOUNTNO (חשבון)
  const hasStructured = cashBanks.some(cb => cb.BANKACCOUNTNO != null);
  if (hasStructured) {
    for (const cb of cashBanks) {
      const cbAccount = strip(cb.BANKACCOUNTNO);
      if (!cbAccount || cbAccount.length < 2) continue;
      const accountMatch = ourAccount === cbAccount || ourAccount.startsWith(cbAccount) || cbAccount.startsWith(ourAccount);
      if (!accountMatch) continue;
      if (ourBranch) {
        const cbBranch = strip(cb.BRANCHNO);
        if (cbBranch && cbBranch !== ourBranch) continue;
      }
      return cb.CASHNAME;
    }
  }

  // Pass 1: branch + account both found in CASHDES (branch guard allows short account numbers)
  const getDigitGroups = (des) => (des || '').match(/\d+/g) || [];
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
