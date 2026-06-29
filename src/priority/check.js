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
export async function fetchPriorityLines(fromDate, toDate, cashName = null) {
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

export const shiftDate = (dateStr, days) => {
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
    // ── Step 1: build per-date amount index from BANKLINESA ──────────────
    const priorityByDate = new Map(); // date → [signed amount, ...]
    const dateToBankpage = new Map();
    for (const line of priorityLines) {
      const date = (line.CURDATE || '').slice(0, 10);
      if (!date) continue;
      const credit = Number(line.CREDIT || 0);
      const debit = Number(line.DEBIT || 0);
      const amount = credit > 0 ? credit : -Math.abs(debit);
      if (!priorityByDate.has(date)) priorityByDate.set(date, []);
      priorityByDate.get(date).push(amount);
      if (!dateToBankpage.has(date)) dateToBankpage.set(date, String(line.BANKPAGE || ''));
    }

    // ── Step 2: fetch BANKPAGES to get end-of-day balances ───────────────
    // BANKPAGES has one record per day. We auto-discover the balance field
    // (field name contains "BAL") since the name may vary by Priority version.
    const priorityBalByDate = new Map(); // date → closing balance
    try {
      const bankPages = await fetchBankPages(fromDate, toDate, cashName);
      if (bankPages.length > 0) {
        // Find the balance field: prefer closing/end balance over opening/start
        const sample = bankPages[0];
        const candidates = Object.keys(sample).filter(k => /BAL/i.test(k) && sample[k] != null);
        const balField = candidates.find(k => /CLS|CLOSE|END/i.test(k))
          || candidates.find(k => /OP|OPEN|START/i.test(k))
          || candidates[0] || null;
        if (balField) {
          console.log(`[priority-check] balance field: ${balField}`);
          for (const page of bankPages) {
            const date = (page.CURDATE || '').slice(0, 10);
            if (date && page[balField] != null) priorityBalByDate.set(date, Number(page[balField]));
          }
        }
      }
    } catch (e) {
      console.warn('[priority-check] BANKPAGES fetch failed (balance fence disabled):', e.message);
    }

    // ── Step 3: build our bank's end-of-day balance per date ─────────────
    // Transactions are ordered by date, id ASC — last row per date has end-of-day balance.
    const ourBalByDate = new Map(); // date → { balance, id }
    for (const txn of ourTxns) {
      if (txn.running_balance == null) continue;
      const cur = ourBalByDate.get(txn.date);
      if (!cur || txn.id > cur.id) ourBalByDate.set(txn.date, { balance: txn.running_balance, id: txn.id });
    }

    // ── Step 4: find balance fence date ──────────────────────────────────
    // Latest date where Priority's closing balance == our running balance (within ±0.01).
    // All our transactions on or before that date are confirmed present in Priority.
    // We never use balance MISMATCH to reject — only balance MATCH to confirm, because
    // the discovered balance field might be opening rather than closing balance.
    let fenceDate = null;
    if (priorityBalByDate.size > 0 && ourBalByDate.size > 0) {
      const candidateDates = [...ourBalByDate.keys()].filter(d => priorityBalByDate.has(d)).sort();
      for (const date of candidateDates) {
        const ourBal = ourBalByDate.get(date).balance;
        const prioBal = priorityBalByDate.get(date);
        if (Math.abs(ourBal - prioBal) < 0.01) fenceDate = date;
      }
    }

    // ── Step 5: match each transaction ───────────────────────────────────
    // Pre-fence: confirmed by balance — safe.
    // Post-fence: exact-date amount matching with consumed-entry tracking.
    //   Each Priority BANKLINESA entry can only match ONE of our transactions.
    //   Without this, two of our 4 NIS transactions on the same date would both
    //   match the single 4 NIS in Priority, hiding the second one as a false positive.
    //   No ±1 day — pre-fence covers shifted dates; ±1 caused false positives post-fence.
    const availableByDate = new Map(); // mutable copy for consumed tracking
    for (const [date, amounts] of priorityByDate) availableByDate.set(date, [...amounts]);

    for (const txn of ourTxns) {
      if (fenceDate && txn.date <= fenceDate) {
        matched++;
        updates.push({ id: txn.id, inPriority: 1, bankpage: dateToBankpage.get(txn.date) || null });
        continue;
      }
      const checkDate = txn.effective_date || txn.date;
      const txnAmount = Number(txn.amount);
      const available = availableByDate.get(checkDate);
      const idx = available ? available.findIndex(a => Math.abs(a - txnAmount) < 0.005) : -1;
      if (idx !== -1) {
        available.splice(idx, 1); // consume so it can't match a second transaction
        matched++;
        updates.push({ id: txn.id, inPriority: 1, bankpage: dateToBankpage.get(checkDate) || null });
      } else {
        updates.push({ id: txn.id, inPriority: 0, bankpage: null });
      }
    }

    // ── Step 6: detect balance discrepancy after fence ────────────────────
    // If a fence was found (meaning the discovered balance field is reliable),
    // look for the most recent date where Priority's balance ≠ our balance.
    // This catches false-positive matches where amount matching found a wrong entry.
    let balanceDiscrepancy = null;
    if (fenceDate && priorityBalByDate.size > 0 && ourBalByDate.size > 0) {
      const postFenceDates = [...ourBalByDate.keys()]
        .filter(d => d > fenceDate && priorityBalByDate.has(d))
        .sort();
      for (const date of postFenceDates) {
        const ourBal = ourBalByDate.get(date).balance;
        const prioBal = priorityBalByDate.get(date);
        if (Math.abs(ourBal - prioBal) >= 0.01) {
          balanceDiscrepancy = { date, ourBalance: ourBal, priorityBalance: prioBal, diff: Math.abs(ourBal - prioBal) };
          break;
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
      fenceDate,
      balanceDiscrepancy,
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

/**
 * Fetch BANKPAGES records for a cashName in [fromDate, toDate].
 * No $select — returns all fields so callers can discover available balance fields.
 */
export async function fetchBankPages(fromDate, toDate, cashName) {
  if (!priorityConfigured()) throw new Error('Priority not configured');
  const filter = `CASHNAME eq '${cashName}' and CURDATE ge ${fromDate}T00:00:00Z and CURDATE le ${toDate}T23:59:59Z`;
  const params = new URLSearchParams({ '$filter': filter, '$top': '500' });
  const url = `${PRIORITY_URL}/BANKPAGES?${params}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Priority BANKPAGES query failed: HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.value || [];
}

export { priorityConfigured };
