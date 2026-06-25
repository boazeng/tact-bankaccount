const PRIORITY_URL = (process.env.PRIORITY_URL_REAL || '').replace(/\/$/, '');
const PRIORITY_USERNAME = process.env.PRIORITY_USERNAME || '';
const PRIORITY_PASSWORD = process.env.PRIORITY_PASSWORD || '';

const authHeader = 'Basic ' + Buffer.from(`${PRIORITY_USERNAME}:${PRIORITY_PASSWORD}`).toString('base64');
const getHeaders = {
  authorization: authHeader,
  accept: 'application/json',
  'odata-version': '4.0',
};
const postHeaders = {
  ...getHeaders,
  'content-type': 'application/json',
};

/**
 * Maps a single local transaction to a Priority BANKLINES payload object.
 * CASHNAME is NOT included here — it belongs to the parent BANKPAGES record.
 */
export function buildBankLinePayload(txn) {
  const amount = Number(txn.amount);
  return {
    CURDATE: `${txn.date}T00:00:00Z`,
    DETAILS: (txn.description || '').slice(0, 24),
    CREDIT: amount > 0 ? amount : 0,
    DEBIT: amount < 0 ? Math.abs(amount) : 0,
    ...(txn.reference_number != null ? { REF: String(txn.reference_number).slice(0, 24) } : {}),
  };
}

/**
 * Find an existing BANKPAGES record for the given cashName and date (YYYY-MM-DD),
 * or create a new one. Returns { BPYEAR, CASH, BPNUM }.
 */
async function findOrCreateBankPage(cashName, dateStr) {
  const year = dateStr.slice(0, 4);
  // Priority BPNUMA convention: YYMMDD (2-digit year + month + day)
  const bpnuma = dateStr.slice(2, 4) + dateStr.slice(5, 7) + dateStr.slice(8, 10);

  const params = new URLSearchParams({
    '$filter': `CASHNAME eq '${cashName}' and BPYEAR eq '${year}' and BPNUMA eq '${bpnuma}'`,
    '$select': 'BPYEAR,CASH,BPNUM',
    '$top': '1',
  });
  const r = await fetch(`${PRIORITY_URL}/BANKPAGES?${params}`, { headers: getHeaders });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`BANKPAGES lookup failed: HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  if (data.value?.length > 0) {
    const { BPYEAR, CASH, BPNUM } = data.value[0];
    return { BPYEAR, CASH, BPNUM };
  }

  // Create a new BANKPAGES record for this date
  const r2 = await fetch(`${PRIORITY_URL}/BANKPAGES`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({
      CASHNAME: cashName,
      CURDATE: `${dateStr}T00:00:00Z`,
      BPYEAR: year,
      BPNUMA: bpnuma,
    }),
  });
  if (!r2.ok) {
    const text = await r2.text().catch(() => '');
    throw new Error(`BANKPAGES create failed: HTTP ${r2.status}: ${text.slice(0, 200)}`);
  }
  const data2 = await r2.json();
  return { BPYEAR: data2.BPYEAR, CASH: data2.CASH, BPNUM: data2.BPNUM };
}

function bankPageNavPath(bp) {
  return `BANKPAGES(BPYEAR='${bp.BPYEAR}',CASH=${bp.CASH},BPNUM=${bp.BPNUM})/BANKLINES_SUBFORM`;
}

/**
 * Push transactions to Priority via BANKPAGES → BANKLINES_SUBFORM navigation.
 * Groups by date, finds or creates a BANKPAGES record per date, then inserts lines.
 * txns: [{ id, date, description, amount, reference_number }]
 * Returns { pushed: [txnId, ...], failed: [{ id, error }, ...] }
 */
export async function pushToPriority(txns, cashName) {
  const pushed = [];
  const failed = [];

  // Group transactions by date
  const byDate = new Map();
  for (const txn of txns) {
    if (!byDate.has(txn.date)) byDate.set(txn.date, []);
    byDate.get(txn.date).push(txn);
  }

  for (const [date, dateTxns] of byDate) {
    let bankPage;
    try {
      bankPage = await findOrCreateBankPage(cashName, date);
    } catch (e) {
      for (const txn of dateTxns) {
        failed.push({ id: txn.id, error: `BankPage error for ${date}: ${e.message}` });
      }
      continue;
    }

    const url = `${PRIORITY_URL}/${bankPageNavPath(bankPage)}`;
    for (const txn of dateTxns) {
      const payload = buildBankLinePayload(txn);
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: postHeaders,
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          let msg = text.slice(0, 400);
          try { msg = JSON.parse(text)?.error?.message || msg; } catch {}
          failed.push({ id: txn.id, error: `HTTP ${r.status}: ${msg.slice(0, 200)}` });
        } else {
          pushed.push(txn.id);
        }
      } catch (e) {
        failed.push({ id: txn.id, error: e.message });
      }
    }
  }

  return { pushed, failed };
}
