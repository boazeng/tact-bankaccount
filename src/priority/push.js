// Priority push module — builds BANKLINESA payloads from our transaction records.
//
// DRY-RUN ONLY: this module prepares and validates what would be sent to Priority
// but does NOT perform any HTTP POST. The actual write step will be added after
// the payload fields are verified against a live Priority BANKLINESA endpoint.
//
// Expected BANKLINESA fields (to be confirmed):
//   CASHNAME  – Priority cash journal name (e.g. "לאומי 1234")
//   CURDATE   – ISO datetime string ("2024-01-15T00:00:00Z")
//   DETAILS   – transaction description (max 250 chars)
//   CREDIT    – positive amount if money IN, else 0
//   DEBIT     – positive amount if money OUT, else 0
//   REFERENCE – bank reference number (optional)

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
    REFERENCE: txn.reference_number ? String(txn.reference_number).slice(0, 50) : '',
  };
}

/**
 * Dry-run: returns what would be sent to Priority without actually sending it.
 * txns: [{ id, date, description, amount, reference_number }]
 */
export function dryRunPush(txns, cashName) {
  const lines = txns.map(t => ({ _txnId: t.id, ...buildBankLinePayload(t, cashName) }));
  return { dryRun: true, cashName, count: lines.length, lines };
}
