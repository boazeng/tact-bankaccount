import Database from 'better-sqlite3';
import path from 'node:path';

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
`);

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
           c.is_active, c.last_sync_at,
           (SELECT COUNT(*) FROM card_transactions t WHERE t.card_id = c.id) AS txn_count,
           (SELECT MAX(purchase_date) FROM card_transactions t WHERE t.card_id = c.id) AS last_txn_date
    FROM credit_cards c
    ORDER BY c.bank_id, c.card_last4
  `).all();
}

export function getCard(cardId) {
  return db.prepare(`SELECT * FROM credit_cards WHERE id = ?`).get(cardId);
}

export function getCardTransactions(cardId, { limit = 200, offset = 0 } = {}) {
  return db.prepare(`
    SELECT id, purchase_date, billing_date, merchant_name, amount, currency,
           original_amount, installment_current, installment_total, status
    FROM card_transactions
    WHERE card_id = ?
    ORDER BY purchase_date DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(cardId, limit, offset);
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
 */
export function getPriorityPreviewForCard(cardId) {
  const txns = db.prepare(`
    SELECT bank_transaction_id, purchase_date, billing_date, merchant_name, amount
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

  const pages = [];
  for (const [curdate, group] of groups) {
    // amount < 0 is a purchase (debit); amount > 0 is a refund/credit the
    // bank already netted into this cycle — each keeps its own sign so the
    // closing line balances to the REAL bank charge, not a naive sum of
    // purchases that double-counts refunds as extra debits.
    const lines = group.map(t => ({
      curdate,
      valueDate: t.purchase_date,
      btcode: '00',
      details: (t.merchant_name || '').slice(0, 24),
      debit: Number(t.amount) < 0 ? Math.abs(Number(t.amount)) : 0,
      credit: Number(t.amount) > 0 ? Number(t.amount) : 0,
    }));
    const netTotal = group.reduce((sum, t) => sum - Number(t.amount), 0);
    lines.push({
      curdate,
      valueDate: curdate,
      btcode: '00',
      details: 'תשלום בפועל בבנק',
      debit: 0,
      credit: Math.round(netTotal * 100) / 100,
    });
    pages.push({ curdate, lines });
  }
  return pages.sort((a, b) => a.curdate < b.curdate ? -1 : 1);
}

export default db;
