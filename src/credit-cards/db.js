import Database from 'better-sqlite3';
import path from 'node:path';
import { findRealBankDebit } from './reconcile.js';

// Isolated connection to the same tact.db used by the main app (src/db.js
// creates the file/dir first — this module never runs standalone before it).
const DB_PATH = path.join(path.resolve('data'), 'tact.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS credit_cards (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id       TEXT NOT NULL REFERENCES banks(id),
    account_masked_number TEXT,
    card_last4    TEXT NOT NULL,
    label         TEXT,
    is_active     INTEGER NOT NULL DEFAULT 1,
    last_sync_at  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bank_id, card_last4)
  );

  CREATE TABLE IF NOT EXISTS card_transactions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id              INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
    bank_transaction_id  TEXT NOT NULL,
    purchase_date        TEXT NOT NULL,
    billing_date         TEXT,
    merchant_name        TEXT,
    amount               REAL NOT NULL,
    currency             TEXT DEFAULT 'ILS',
    original_amount      REAL,
    installment_current  INTEGER,
    installment_total    INTEGER,
    status               TEXT,
    raw_json             TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(card_id, bank_transaction_id)
  );
  CREATE INDEX IF NOT EXISTS idx_card_txn_card_date ON card_transactions(card_id, purchase_date DESC);

  -- One row per (card, billing_date) page actually pushed to Priority — the
  -- idempotency guard for push-to-priority (a page must never be created twice).
  CREATE TABLE IF NOT EXISTS card_priority_pushes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id       INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
    billing_date  TEXT NOT NULL,
    bpyear        TEXT,
    cash          TEXT,
    bpnum         TEXT,
    pushed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(card_id, billing_date)
  );
`);

const cardCols = db.prepare(`PRAGMA table_info(credit_cards)`).all().map(c => c.name);
if (!cardCols.includes('priority_cashname')) {
  db.exec(`ALTER TABLE credit_cards ADD COLUMN priority_cashname TEXT`);
}

// One-time cleanup: an earlier version of the scraper pulled the still-open
// current cycle, which could include a billing_date that hadn't happened
// yet (e.g. an upcoming debit date like 2026-07-15 while it was still June).
// That's never legitimate — a billing_date is only ever set from the bank's
// own DateOfPastDebit, which by definition already happened. Confirmed live:
// leftover future-dated rows from before this got pushed to Priority.
{
  const today = new Date().toISOString().slice(0, 10);
  const res = db.prepare(`DELETE FROM card_transactions WHERE billing_date > ?`).run(today);
  if (res.changes > 0) {
    console.log(`[credit-cards] purged ${res.changes} card_transactions with a future billing_date`);
  }
}

// One-time scoped repair (2026-07-20): rows for cashname "103-200-4547"
// synced BEFORE the billing_date fix (see the billing-date-split fix) are
// stuck with a wrong billing_date forever — the scraper never re-fetches an
// old closed cycle, so a fresh sync can't correct them on its own.
// Recomputes billing_date straight from each row's already-stored raw bank
// data (no re-scraping). Idempotent — once a row's billing_date matches
// what its raw data says, it's left alone, so this is a no-op on every
// startup after the first. Deliberately scoped to this one cashname only —
// see repair-card-billing-dates.js for the same fix on any other cashname
// later (explicit user decision: never a blanket historical rewrite).
{
  const REPAIR_CASHNAME = '103-200-4547';
  const ymdToIsoRaw = (s) => (s && String(s).length === 8) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}` : null;
  const ymdIsraelRaw = (isoUtc) => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(isoUtc));
    } catch { return null; }
  };
  const REAL_DEBIT_DATE = {
    discount: (raw) => ymdToIsoRaw(raw.DebitDate),
    poalim: (raw) => ymdToIsoRaw(raw.debitDate),
    leumi: (raw) => (raw.DebitCardDebitPeriodUTC ? ymdIsraelRaw(raw.DebitCardDebitPeriodUTC) : null),
  };
  const today = new Date().toISOString().slice(0, 10);
  const rowsToCheck = db.prepare(`
    SELECT ct.id, ct.billing_date, ct.raw_json, cc.bank_id
    FROM card_transactions ct
    JOIN credit_cards cc ON cc.id = ct.card_id
    WHERE cc.priority_cashname = ?
  `).all(REPAIR_CASHNAME);
  const updateBillingDate = db.prepare(`UPDATE card_transactions SET billing_date = ? WHERE id = ?`);
  let repairedCount = 0;
  for (const row of rowsToCheck) {
    const getReal = REAL_DEBIT_DATE[row.bank_id];
    if (!getReal) continue;
    let raw;
    try { raw = JSON.parse(row.raw_json); } catch { continue; }
    const realDate = getReal(raw);
    if (!realDate || realDate > today || realDate === row.billing_date) continue;
    updateBillingDate.run(realDate, row.id);
    repairedCount++;
  }
  if (repairedCount > 0) {
    console.log(`[credit-cards] repaired ${repairedCount} pre-fix billing_date row(s) for cashname ${REPAIR_CASHNAME}`);
  }
}

// One-time scoped removal (2026-07-20): 3 specific transactions on cashname
// "103-200-4547" — purchased 2026-07-07 but stuck with billing_date
// 2026-07-02 (a purchase can't be debited before it happened; the repair
// above didn't change them, meaning the bank's own raw DebitDate genuinely
// reads 2026-07-02 for these rows, not just stale pre-fix data) — were
// blocking that page's push (real bank debit ₪6,602.24 vs our summed
// ₪7,027.24). Explicit user decision: remove exactly these 3 rows from our
// system; she'll enter them in Priority herself under the correct date.
// Matched by exact date+amount (not merchant text, which the UI truncates)
// so this can never touch any other row. Idempotent — matches nothing once
// already deleted.
{
  const REMOVE_CASHNAME = '103-200-4547';
  const res = db.prepare(`
    DELETE FROM card_transactions
    WHERE card_id IN (SELECT id FROM credit_cards WHERE priority_cashname = ?)
      AND purchase_date = '2026-07-07'
      AND billing_date = '2026-07-02'
      AND amount IN (-80, -55, -290)
  `).run(REMOVE_CASHNAME);
  if (res.changes > 0) {
    console.log(`[credit-cards] removed ${res.changes} stuck transaction(s) for cashname ${REMOVE_CASHNAME} (2026-07-02 mismatch)`);
  }
}

const stmtUpsertCard = db.prepare(`
  INSERT INTO credit_cards (bank_id, account_masked_number, card_last4, label)
  VALUES (@bank_id, @account_masked_number, @card_last4, @label)
  ON CONFLICT(bank_id, card_last4) DO UPDATE SET
    account_masked_number = excluded.account_masked_number,
    label = COALESCE(excluded.label, label)
  RETURNING id
`);

export function upsertCard({ bankId, accountMaskedNumber, cardLast4, label }) {
  const row = stmtUpsertCard.get({
    bank_id: bankId,
    account_masked_number: accountMaskedNumber ?? null,
    card_last4: cardLast4,
    label: label ?? null,
  });
  return row.id;
}

const stmtUpdateLastSync = db.prepare(
  `UPDATE credit_cards SET last_sync_at = ? WHERE id = ?`,
);
export function updateCardLastSync(cardId) {
  stmtUpdateLastSync.run(new Date().toISOString(), cardId);
}

const stmtInsertCardTxn = db.prepare(`
  INSERT INTO card_transactions (
    card_id, bank_transaction_id, purchase_date, billing_date, merchant_name,
    amount, currency, original_amount, installment_current, installment_total,
    status, raw_json
  ) VALUES (
    @card_id, @bank_transaction_id, @purchase_date, @billing_date, @merchant_name,
    @amount, @currency, @original_amount, @installment_current, @installment_total,
    @status, @raw_json
  )
  ON CONFLICT(card_id, bank_transaction_id) DO UPDATE SET
    purchase_date = excluded.purchase_date,
    billing_date = COALESCE(excluded.billing_date, billing_date),
    merchant_name = excluded.merchant_name,
    amount = excluded.amount,
    currency = excluded.currency,
    original_amount = excluded.original_amount,
    installment_current = excluded.installment_current,
    installment_total = excluded.installment_total,
    status = excluded.status,
    raw_json = excluded.raw_json
`);

export function insertCardTransactions(cardId, txns) {
  const insertMany = db.transaction((items) => {
    let newCount = 0;
    for (const t of items) {
      const res = stmtInsertCardTxn.run({
        card_id: cardId,
        bank_transaction_id: t.transactionID,
        purchase_date: t.purchaseDate,
        billing_date: t.billingDate ?? null,
        merchant_name: t.merchantName ?? null,
        amount: Number(t.amount ?? 0),
        currency: t.currency ?? 'ILS',
        original_amount: t.originalAmount ?? null,
        installment_current: t.installmentCurrent ?? null,
        installment_total: t.installmentTotal ?? null,
        status: t.status ?? 'posted',
        raw_json: JSON.stringify(t.raw ?? t),
      });
      if (res.changes > 0) newCount++;
    }
    return newCount;
  });
  return insertMany(txns);
}

/**
 * Removes rows for a card/billing_date that are no longer part of the bank's
 * own answer for that cycle — e.g. an entry that was previously mis-included
 * (see the "not yet finalized" fix in the Discount scraper) needs to actually
 * disappear on the next sync, not just stop being re-inserted. Only touches
 * rows for the exact billing_date being synced, so other cycles are untouched.
 */
export function deleteStaleCardTransactions(cardId, billingDate, keepBankTransactionIds) {
  if (!billingDate || keepBankTransactionIds.length === 0) return 0;
  const placeholders = keepBankTransactionIds.map(() => '?').join(',');
  const res = db.prepare(`
    DELETE FROM card_transactions
    WHERE card_id = ? AND billing_date = ? AND bank_transaction_id NOT IN (${placeholders})
  `).run(cardId, billingDate, ...keepBankTransactionIds);
  return res.changes;
}

export function listCards() {
  return db.prepare(`
    SELECT c.id, c.bank_id, c.account_masked_number, c.card_last4, c.label,
           c.is_active, c.last_sync_at, c.priority_cashname,
           (SELECT COUNT(*) FROM card_transactions t WHERE t.card_id = c.id) AS txn_count,
           (SELECT MAX(purchase_date) FROM card_transactions t WHERE t.card_id = c.id) AS last_txn_date
    FROM credit_cards c
    ORDER BY c.bank_id, c.card_last4
  `).all();
}

const stmtSetCashname = db.prepare(`UPDATE credit_cards SET priority_cashname = ? WHERE id = ?`);
export function setCardPriorityCashname(cardId, cashname) {
  stmtSetCashname.run(cashname ?? null, cardId);
}

export function getCard(cardId) {
  return db.prepare(`SELECT * FROM credit_cards WHERE id = ?`).get(cardId);
}

export function getCardTransactions(cardId, { limit = 200, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT id, purchase_date, billing_date, merchant_name, amount, currency,
           original_amount, installment_current, installment_total, status, raw_json
    FROM card_transactions
    WHERE card_id = ?
    ORDER BY purchase_date DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(cardId, limit, offset);
  // raw exposes the bank's own original entry (DebitDate/PurchaseDate/
  // OrderNumerator/installment fields as the bank itself named them) —
  // diagnostic only, for spotting cases like a stored billing_date that
  // doesn't match what the bank's own raw data actually says.
  return rows.map(({ raw_json, ...r }) => {
    let raw = null;
    try { raw = JSON.parse(raw_json); } catch {}
    return { ...r, raw };
  });
}

/**
 * Priority-shaped preview (BANKPAGES/BANKLINES layout) for a card's
 * transactions, grouped into one "page" per bank debit date: one DEBIT line
 * per purchase, plus a closing CREDIT line ("תשלום בפועל בבנק") equal to the
 * page's total, so the page nets to the single real bank debit. Not pushed
 * to Priority yet — preview only, per plan.
 *
 * Some rows come back from the bank without billing_date populated yet; those
 * are folded into the cycle's most common non-null billing_date rather than
 * being dropped or shown as their own stray group.
 *
 * Each page also carries `reconcile`: an independent check of the closing
 * line's amount against the REAL debit in the checking account's own
 * transactions (see reconcile.js) — not just our own summed card_transactions
 * rows. A real incident showed why this matters: a duplicate transaction bug
 * on the card side got silently summed straight into "amount debited",
 * producing a wrong total that looked internally consistent. `matched` is
 * `true`/`false` only when a unique real debit was found that day; `null`
 * means unverified (none found, or more than one candidate that day).
 */
export function getPriorityPreviewForCard(cardId) {
  const card = db.prepare(`
    SELECT bank_id, account_masked_number, card_last4 FROM credit_cards WHERE id = ?
  `).get(cardId);

  const txns = db.prepare(`
    SELECT bank_transaction_id, purchase_date, billing_date, merchant_name, amount, raw_json
    FROM card_transactions
    WHERE card_id = ?
    ORDER BY purchase_date, id
  `).all(cardId);

  const counts = new Map();
  for (const t of txns) {
    if (t.billing_date) counts.set(t.billing_date, (counts.get(t.billing_date) || 0) + 1);
  }
  let modeBillingDate = null;
  let modeCount = 0;
  for (const [date, count] of counts) {
    if (count > modeCount) { modeBillingDate = date; modeCount = count; }
  }

  const groups = new Map();
  for (const t of txns) {
    const date = t.billing_date || modeBillingDate || 'לא ידוע';
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(t);
  }

  // Defensive: a billing_date can never legitimately be in the future (it's
  // only ever set from the bank's own already-happened DateOfPastDebit). This
  // guards the Priority preview/push even if bad data somehow gets in again,
  // on top of the one-time purge above.
  const today = new Date().toISOString().slice(0, 10);

  const pages = [];
  for (const [curdate, group] of groups) {
    if (curdate > today) continue;
    // amount < 0 is a purchase (debit); amount > 0 is a refund/credit the
    // bank already netted into this cycle — each keeps its own sign so the
    // closing line balances to the REAL bank charge, not a naive sum of
    // purchases that double-counts refunds as extra debits.
    const lines = group.map(t => {
      // A purchase dated AFTER its own billing_date is physically
      // impossible (a debit can't happen before the purchase that caused
      // it) — surfaces the bank's own raw fields for that row directly in
      // this view, so an anomaly like this can be diagnosed without needing
      // separate DB/API access.
      let rawAnomaly = null;
      if (t.purchase_date > curdate) {
        try {
          const raw = JSON.parse(t.raw_json);
          rawAnomaly = {
            DebitDate: raw.DebitDate ?? raw.debitDate ?? null,
            PurchaseDate: raw.PurchaseDate ?? raw.eventDate ?? raw.DateDealUTC ?? null,
            OrderNumerator: raw.OrderNumerator ?? null,
            InstallmentNumber: raw.InstallmentNumber ?? raw.installmentNumber ?? null,
            TotalNumberOfInstallments: raw.TotalNumberOfInstallments ?? raw.totalNumberOfInstallments ?? null,
          };
        } catch {}
      }
      return {
        curdate,
        valueDate: t.purchase_date,
        btcode: '00',
        details: (t.merchant_name || '').slice(0, 24),
        debit: Number(t.amount) < 0 ? Math.abs(Number(t.amount)) : 0,
        credit: Number(t.amount) > 0 ? Number(t.amount) : 0,
        rawAnomaly,
      };
    });
    const netTotal = Math.round(group.reduce((sum, t) => sum - Number(t.amount), 0) * 100) / 100;
    lines.push({
      curdate,
      valueDate: curdate,
      btcode: '00',
      details: 'תשלום בפועל בבנק',
      debit: 0,
      credit: netTotal,
    });

    const debit = card
      ? findRealBankDebit({
          bankId: card.bank_id,
          accountMaskedNumber: card.account_masked_number,
          cardLast4: card.card_last4,
          date: curdate,
        })
      : { status: 'not-found', amount: null };
    const matched = debit.status === 'matched' ? Math.abs(debit.amount - netTotal) < 0.01 : null;

    pages.push({
      curdate,
      lines,
      reconcile: { status: debit.status, anchorAmount: debit.amount, computedSum: netTotal, matched },
    });
  }
  return pages.sort((a, b) => a.curdate < b.curdate ? -1 : 1);
}

// Audit log only — NOT the source of truth for "is this page fully in
// Priority" (see checkCardPageStatus in priority-push.js, which asks
// Priority itself). Upsert because a page can legitimately be recorded here
// more than once: a first push that lands only some lines, followed later by
// a top-up push that fills in the rest.
const stmtRecordPush = db.prepare(`
  INSERT INTO card_priority_pushes (card_id, billing_date, bpyear, cash, bpnum)
  VALUES (@card_id, @billing_date, @bpyear, @cash, @bpnum)
  ON CONFLICT(card_id, billing_date) DO UPDATE SET
    bpyear = excluded.bpyear, cash = excluded.cash, bpnum = excluded.bpnum,
    pushed_at = datetime('now')
`);
export function recordPagePushed(cardId, billingDate, { bpyear, cash, bpnum }) {
  stmtRecordPush.run({ card_id: cardId, billing_date: billingDate, bpyear, cash: String(cash), bpnum: String(bpnum) });
}

export default db;
