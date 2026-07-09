// Verifies that scraped bank transactions form an unbroken running-balance
// chain, day by day — independent of Priority. A break means the scrape
// itself missed or duplicated a transaction, before Priority is even involved.
//
// Within a day, id/insertion order can't disambiguate paired transfer+fee
// rows or shared-ref groups, so each day is reconstructed by chaining: given
// a known balance B, the next transaction is the one whose
// running_balance - amount == B. This mirrors the client-side check in
// public/app.js (kept separate since app.js isn't a shared ES module).

function greedyChain(txns, fromBalance) {
  const remaining = [...txns];
  const chain = [];
  let cur = fromBalance;
  while (true) {
    const idx = remaining.findIndex(t =>
      t.running_balance != null && t.amount != null &&
      Math.abs(Number(t.running_balance) - (cur + Number(t.amount))) < 0.01
    );
    if (idx === -1) break;
    const next = remaining.splice(idx, 1)[0];
    chain.push(next);
    cur = Number(next.running_balance);
  }
  for (const r of remaining) chain.push(r); // leftover → will surface as mismatches
  return chain;
}

function reconstructDay(dayTxns, startBalance) {
  if (dayTxns.length <= 1) return [...dayTxns];
  if (startBalance != null) return greedyChain(dayTxns, startBalance);
  // No anchor (first day in range) — try each txn as the day's first, keep the longest chain.
  let best = null;
  for (const anchor of dayTxns) {
    if (anchor.running_balance == null || anchor.amount == null) continue;
    const others = dayTxns.filter(t => t !== anchor);
    const chain = [anchor, ...greedyChain(others, Number(anchor.running_balance))];
    if (!best || chain.length > best.length) best = chain;
  }
  return best || [...dayTxns];
}

/**
 * transactions: [{ id, date: 'YYYY-MM-DD', amount, running_balance }], any order.
 * Returns { ok, mismatches: [{ id, date, expected, actual, diff }] }.
 */
export function checkBalanceContinuity(transactions) {
  const byDate = new Map();
  for (const t of transactions) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }

  const mismatches = [];
  let prevBalance = null;
  for (const date of [...byDate.keys()].sort()) {
    const ordered = reconstructDay(byDate.get(date), prevBalance);
    for (let i = 0; i < ordered.length; i++) {
      const cur = ordered[i];
      if (cur.running_balance == null || cur.amount == null) continue;
      if (i === 0 && prevBalance == null) continue; // first txn overall — nothing to compare against
      const refBalance = i === 0 ? prevBalance : ordered[i - 1].running_balance;
      const expected = Number(refBalance) + Number(cur.amount);
      const diff = Number(cur.running_balance) - expected;
      if (Math.abs(diff) >= 0.01) {
        mismatches.push({ id: cur.id, date: cur.date, expected, actual: Number(cur.running_balance), diff });
      }
    }
    if (ordered.length) prevBalance = ordered[ordered.length - 1].running_balance;
  }

  return { ok: mismatches.length === 0, mismatches };
}
