import Database from 'better-sqlite3';
import path from 'node:path';

// Scoped, one-time repair for card_transactions rows synced BEFORE the
// billing_date fix (see the credit-cards billing-date-split fix): back
// then, the scraper forced every transaction in a fetched cycle onto the
// cycle's single headline debit date instead of each transaction's own real
// DebitDate. That mistake is frozen in already-synced rows forever, because
// the scraper only ever re-fetches the CURRENT closed cycle, never revisits
// old months — a fresh sync can't correct old data on its own.
//
// Each row still has the bank's original entry in raw_json, so billing_date
// can be recomputed directly from stored data, with no need to re-scrape.
//
// Deliberately scoped to ONE cashname per run (never "fix everything") —
// explicit user decision: only touch what's actively being worked on, never
// a blanket historical rewrite.
//
// Usage:
//   node src/repair-card-billing-dates.js --cashname=103-200-4547            # dry run — lists changes only
//   node src/repair-card-billing-dates.js --cashname=103-200-4547 --apply    # actually writes them

const cashnameArg = process.argv.find(a => a.startsWith('--cashname='));
const CASHNAME = cashnameArg ? cashnameArg.slice('--cashname='.length).trim() : null;
if (!CASHNAME) {
  console.error('Usage: node src/repair-card-billing-dates.js --cashname=<CASHNAME> [--apply]');
  console.error('A --cashname is required on purpose — this never touches more than one card at a time.');
  process.exit(1);
}

const DB_PATH = path.join(path.resolve('data'), 'tact.db');
const db = new Database(DB_PATH);

const ymdToIso = (s) => (s && String(s).length === 8) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}` : null;
const ymdIsrael = (isoUtc) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(isoUtc));
  } catch { return null; }
};

// Same field names/conversion each scraper itself uses for the real
// per-transaction debit date (see discount.js/poalim.js/leumi.js).
const REAL_DEBIT_DATE = {
  discount: (raw) => ymdToIso(raw.DebitDate),
  poalim: (raw) => ymdToIso(raw.debitDate),
  leumi: (raw) => (raw.DebitCardDebitPeriodUTC ? ymdIsrael(raw.DebitCardDebitPeriodUTC) : null),
};

const DRY_RUN = !process.argv.includes('--apply');
const today = new Date().toISOString().slice(0, 10);

const rows = db.prepare(`
  SELECT ct.id, ct.billing_date, ct.raw_json, cc.bank_id, cc.card_last4, cc.priority_cashname
  FROM card_transactions ct
  JOIN credit_cards cc ON cc.id = ct.card_id
  WHERE cc.priority_cashname = ?
`).all(CASHNAME);

if (rows.length === 0) {
  console.log(`No card_transactions found for cashname "${CASHNAME}" — check the exact CASHNAME spelling.`);
  db.close();
  process.exit(0);
}

const update = db.prepare(`UPDATE card_transactions SET billing_date = ? WHERE id = ?`);

let changed = 0, unchanged = 0, noRawDate = 0, skippedFuture = 0;

const run = db.transaction(() => {
  for (const row of rows) {
    const getReal = REAL_DEBIT_DATE[row.bank_id];
    if (!getReal) continue;

    let raw;
    try { raw = JSON.parse(row.raw_json); } catch { continue; }

    const realDate = getReal(raw);
    if (!realDate) { noRawDate++; continue; }

    // Same guard as the one-time purge in credit-cards/db.js — a real debit
    // date can never legitimately be in the future.
    if (realDate > today) { skippedFuture++; continue; }

    if (realDate !== row.billing_date) {
      console.log(`[${row.bank_id} card ${row.card_last4}] txn ${row.id}: billing_date ${row.billing_date} -> ${realDate}`);
      changed++;
      if (!DRY_RUN) update.run(realDate, row.id);
    } else {
      unchanged++;
    }
  }
});

run();

console.log(`\nCashname: ${CASHNAME}`);
console.log(`${DRY_RUN ? '[DRY RUN] would change' : 'Changed'} ${changed} row(s). ${unchanged} already correct. ${noRawDate} had no usable raw debit date. ${skippedFuture} skipped (would resolve to a future date).`);
if (DRY_RUN && changed > 0) {
  console.log('Re-run with --apply to write these changes.');
}

db.close();
