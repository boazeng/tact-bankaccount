const PRIORITY_URL = (process.env.PRIORITY_URL_REAL || '').replace(/\/$/, '');
const PRIORITY_USERNAME = process.env.PRIORITY_USERNAME || '';
const PRIORITY_PASSWORD = process.env.PRIORITY_PASSWORD || '';

const authHeader = 'Basic ' + Buffer.from(`${PRIORITY_USERNAME}:${PRIORITY_PASSWORD}`).toString('base64');
const postHeaders = {
  authorization: authHeader,
  accept: 'application/json',
  'content-type': 'application/json',
  'odata-version': '4.0',
};

/**
 * Maps a single local transaction to a Priority BANKLINESA payload object.
 */
export function buildBankLinePayload(txn, cashName) {
  const amount = Number(txn.amount);
  return {
    CASHNAME: cashName,
    CURDATE: `${txn.date}T00:00:00Z`,
    DETAILS: (txn.description || '').slice(0, 250),
    CREDIT: amount > 0 ? amount : 0,
    DEBIT: amount < 0 ? Math.abs(amount) : 0,
  };
}

/**
 * Push transactions to Priority's BANKLINESA entity via OData POST.
 * txns: [{ id, date, description, amount, reference_number }]
 * Returns { pushed: [txnId, ...], failed: [{ id, error }, ...] }
 */
export async function pushToPriority(txns, cashName) {
  const url = `${PRIORITY_URL}/BANKLINESA`;
  const pushed = [];
  const failed = [];

  for (const txn of txns) {
    const payload = buildBankLinePayload(txn, cashName);
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

  return { pushed, failed };
}
