// Deposits/loans/guarantees — read-only informational data shown on the
// dashboard alongside balances. No Priority integration (unlike accounts/
// credit cards): these are never pushed anywhere, just fetched and displayed.
import Database from 'better-sqlite3';
import path from 'node:path';

// Isolated connection to the same tact.db used by the main app (src/db.js
// creates the file/dir first — this module never runs standalone before it).
const DB_PATH = path.join(path.resolve('data'), 'tact.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS facilities (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id               TEXT NOT NULL REFERENCES banks(id),
    account_masked_number TEXT,
    corporate_name        TEXT,
    category              TEXT NOT NULL,   -- 'deposit' | 'loan' | 'guarantee'
    external_id           TEXT NOT NULL,   -- the bank's own id for this item
    label                 TEXT,            -- short product/type description
    principal_amount      REAL,
    current_amount        REAL,            -- current/revalued balance, or outstanding debt
    interest_rate         REAL,
    interest_desc         TEXT,
    start_date            TEXT,
    end_date              TEXT,
    next_payment_date     TEXT,
    next_payment_amount   REAL,
    counterparty          TEXT,            -- beneficiary name, for guarantees
    raw_json              TEXT,
    last_sync_at          TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bank_id, account_masked_number, category, external_id)
  );
  CREATE INDEX IF NOT EXISTS idx_facilities_category ON facilities(category);
`);

const stmtUpsert = db.prepare(`
  INSERT INTO facilities (
    bank_id, account_masked_number, corporate_name, category, external_id, label,
    principal_amount, current_amount, interest_rate, interest_desc,
    start_date, end_date, next_payment_date, next_payment_amount,
    counterparty, raw_json, last_sync_at
  ) VALUES (
    @bank_id, @account_masked_number, @corporate_name, @category, @external_id, @label,
    @principal_amount, @current_amount, @interest_rate, @interest_desc,
    @start_date, @end_date, @next_payment_date, @next_payment_amount,
    @counterparty, @raw_json, @last_sync_at
  )
  ON CONFLICT(bank_id, account_masked_number, category, external_id) DO UPDATE SET
    corporate_name      = excluded.corporate_name,
    label               = excluded.label,
    principal_amount    = excluded.principal_amount,
    current_amount      = excluded.current_amount,
    interest_rate       = excluded.interest_rate,
    interest_desc       = excluded.interest_desc,
    start_date          = excluded.start_date,
    end_date            = excluded.end_date,
    next_payment_date   = excluded.next_payment_date,
    next_payment_amount = excluded.next_payment_amount,
    counterparty        = excluded.counterparty,
    raw_json            = excluded.raw_json,
    last_sync_at        = excluded.last_sync_at
`);

export function upsertFacility(f) {
  stmtUpsert.run({
    bank_id: f.bankId,
    account_masked_number: f.accountMaskedNumber ?? null,
    corporate_name: f.corporateName ?? null,
    category: f.category,
    external_id: String(f.externalId),
    label: f.label ?? null,
    principal_amount: f.principalAmount ?? null,
    current_amount: f.currentAmount ?? null,
    interest_rate: f.interestRate ?? null,
    interest_desc: f.interestDesc ?? null,
    start_date: f.startDate ?? null,
    end_date: f.endDate ?? null,
    next_payment_date: f.nextPaymentDate ?? null,
    next_payment_amount: f.nextPaymentAmount ?? null,
    counterparty: f.counterparty ?? null,
    raw_json: JSON.stringify(f.raw ?? {}),
    last_sync_at: new Date().toISOString(),
  });
}

/**
 * Removes facilities for a bank+account+category that the bank no longer
 * reports (closed/paid-off) — mirrors deleteStaleCardTransactions. Called
 * once per bank/account/category after a sync with the full current list of
 * external_ids the bank just returned.
 */
export function deleteStaleFacilities(bankId, accountMaskedNumber, category, keepExternalIds) {
  if (!keepExternalIds.length) {
    return db.prepare(`
      DELETE FROM facilities WHERE bank_id = ? AND account_masked_number = ? AND category = ?
    `).run(bankId, accountMaskedNumber, category).changes;
  }
  const placeholders = keepExternalIds.map(() => '?').join(',');
  return db.prepare(`
    DELETE FROM facilities
    WHERE bank_id = ? AND account_masked_number = ? AND category = ?
      AND external_id NOT IN (${placeholders})
  `).run(bankId, accountMaskedNumber, category, ...keepExternalIds.map(String)).changes;
}

export function listFacilities() {
  return db.prepare(`
    SELECT bank_id, account_masked_number, corporate_name, category, external_id, label,
           principal_amount, current_amount, interest_rate, interest_desc,
           start_date, end_date, next_payment_date, next_payment_amount,
           counterparty, last_sync_at
    FROM facilities
    ORDER BY category, bank_id, end_date
  `).all();
}

export default db;
