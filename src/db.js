import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_DIR = path.resolve('data');
const DB_PATH = path.join(DB_DIR, 'tact.db');

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS banks (
    id          TEXT PRIMARY KEY,
    name_he     TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id         TEXT NOT NULL REFERENCES banks(id),
    account_index   INTEGER NOT NULL,
    masked_number   TEXT NOT NULL,
    corporate_name  TEXT,
    iban            TEXT,
    last_balance    REAL,
    last_sync_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bank_id, masked_number)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id             INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    bank_transaction_id    TEXT NOT NULL,
    date                   TEXT NOT NULL,
    effective_date         TEXT,
    description            TEXT,
    extended_description   TEXT,
    amount                 REAL NOT NULL,
    running_balance        REAL,
    beneficiary_name       TEXT,
    beneficiary_bank_code  TEXT,
    beneficiary_branch     TEXT,
    beneficiary_account    TEXT,
    reference_number       TEXT,
    status                 TEXT,
    raw_json               TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, bank_transaction_id)
  );

  CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions(account_id, date DESC);
  CREATE INDEX IF NOT EXISTS idx_accounts_bank ON accounts(bank_id);

  -- Encrypted bank credentials. Multiple sets per bank supported (multi-account).
  -- Each field stored as AES-256-GCM ciphertext; decryption requires BANK_VAULT_KEY.
  -- UI/API NEVER returns decrypted values — only the scraper decrypts in-memory.
  CREATE TABLE IF NOT EXISTS bank_credentials (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id      TEXT NOT NULL,
    label        TEXT NOT NULL DEFAULT 'ראשי',
    username     TEXT,
    password     TEXT,
    login_url    TEXT,
    updated_at   TEXT,
    updated_by   TEXT,
    is_set       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS bank_credentials_audit (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id       TEXT NOT NULL,
    credential_id INTEGER,
    action        TEXT NOT NULL,                -- 'set' | 'sync_read' | 'bootstrap' | 'delete'
    actor         TEXT,                         -- email or 'system'
    fields        TEXT,                         -- json array of changed field names (never values)
    occurred_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_creds_audit_bank_time
    ON bank_credentials_audit(bank_id, occurred_at DESC);
`);

// ── migrations ───────────────────────────────────────────────────────────

// bank_credentials: migrate from single-cred (bank_id PK) to multi-cred (id AUTOINCREMENT)
const credCols = db.prepare(`PRAGMA table_info(bank_credentials)`).all().map(c => c.name);
if (!credCols.includes('id')) {
  db.exec(`
    CREATE TABLE bank_credentials_v2 (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id    TEXT NOT NULL,
      label      TEXT NOT NULL DEFAULT 'ראשי',
      username   TEXT,
      password   TEXT,
      login_url  TEXT,
      updated_at TEXT,
      updated_by TEXT,
      is_set     INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO bank_credentials_v2 (bank_id, label, username, password, login_url, updated_at, updated_by, is_set)
      SELECT bank_id, 'ראשי', username, password, login_url, updated_at, updated_by, is_set
      FROM bank_credentials;
    DROP TABLE bank_credentials;
    ALTER TABLE bank_credentials_v2 RENAME TO bank_credentials;
  `);
}

// Ensure the unique index exists (safe after migration — label column guaranteed present)
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_creds_bank_label ON bank_credentials(bank_id, label)`);

// bank_credentials_audit: add credential_id column if missing
const credAuditCols = db.prepare(`PRAGMA table_info(bank_credentials_audit)`).all().map(c => c.name);
if (!credAuditCols.includes('credential_id')) {
  db.exec(`ALTER TABLE bank_credentials_audit ADD COLUMN credential_id INTEGER`);
}

const accountCols = db.prepare(`PRAGMA table_info(accounts)`).all().map(c => c.name);
if (!accountCols.includes('branch_id')) {
  db.exec(`ALTER TABLE accounts ADD COLUMN branch_id TEXT`);
}
if (!accountCols.includes('branch_name')) {
  db.exec(`ALTER TABLE accounts ADD COLUMN branch_name TEXT`);
}
if (!accountCols.includes('is_active')) {
  db.exec(`ALTER TABLE accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
}

const txnCols = db.prepare(`PRAGMA table_info(transactions)`).all().map(c => c.name);
if (!txnCols.includes('in_priority')) {
  // null = not checked yet, 1 = found in Priority, 0 = checked, not found
  db.exec(`ALTER TABLE transactions ADD COLUMN in_priority INTEGER`);
}
if (!txnCols.includes('priority_checked_at')) {
  db.exec(`ALTER TABLE transactions ADD COLUMN priority_checked_at TEXT`);
}
if (!txnCols.includes('priority_bankpage')) {
  db.exec(`ALTER TABLE transactions ADD COLUMN priority_bankpage TEXT`);
}
if (!txnCols.includes('pushed_to_priority_at')) {
  db.exec(`ALTER TABLE transactions ADD COLUMN pushed_to_priority_at TEXT`);
}
if (!accountCols.includes('priority_cashname')) {
  db.exec(`ALTER TABLE accounts ADD COLUMN priority_cashname TEXT`);
}

// One-time backfill: Discount uses the same Urn for transfer + its associated
// fee, so legacy rows have bank_transaction_id = bare Urn. Append the bank-
// internal reference number so the dedup key matches the new composite format
// the scraper writes (`${Urn}-${OperationNumber}`) and the fee rows can land.
const discountBackfillNeeded = db.prepare(`
  SELECT 1 FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  WHERE a.bank_id = 'discount'
    AND t.bank_transaction_id NOT LIKE '%-%'
    AND json_extract(t.raw_json, '$.referenceNumber') IS NOT NULL
  LIMIT 1
`).get();
if (discountBackfillNeeded) {
  const stmt = db.prepare(`
    UPDATE transactions
    SET bank_transaction_id =
      bank_transaction_id || '-' || json_extract(raw_json, '$.referenceNumber')
    WHERE account_id IN (SELECT id FROM accounts WHERE bank_id = 'discount')
      AND bank_transaction_id NOT LIKE '%-%'
      AND json_extract(raw_json, '$.referenceNumber') IS NOT NULL
  `);
  const res = stmt.run();
  console.log(`[db] discount backfill: ${res.changes} transactions migrated to composite ID`);
}

// One-time Poalim migration: old key was `eventDate-ref-cat` which collided
// for paired transfer+fee and shared-ref זה"ב transfers. New key is
// `expandedEventDate` (13 digits, no dashes). Detect old-format rows and
// delete them so the next sync re-pulls everything with the correct keys.
const hasOldPoalim = db.prepare(`
  SELECT 1 FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  WHERE a.bank_id = 'poalim' AND t.bank_transaction_id LIKE '%-%'
  LIMIT 1
`).get();
if (hasOldPoalim) {
  const res = db.prepare(`
    DELETE FROM transactions
    WHERE account_id IN (SELECT id FROM accounts WHERE bank_id = 'poalim')
  `).run();
  console.log(`[db] poalim migration: deleted ${res.changes} old-format rows (re-sync needed to repopulate)`);
}

// Remove duplicate transactions: same account + same amount + dates within 3 days.
// Targets "זיכוי מיידי" (Poalim instant credit) that appears once on transfer date
// and again on settlement date with a different bank_transaction_id.
// Keeps the row with the later date (settled); removes the earlier (immediate).
{
  const dups = db.prepare(`
    SELECT t1.id AS keep_id, t2.id AS drop_id
    FROM transactions t1
    JOIN transactions t2
      ON  t2.account_id = t1.account_id
      AND t2.amount     = t1.amount
      AND t2.id        != t1.id
      AND t1.date      >  t2.date
      AND ABS(julianday(t1.date) - julianday(t2.date)) <= 3
    WHERE (
      -- same reference_number (non-null)
      (t1.reference_number IS NOT NULL AND t1.reference_number = t2.reference_number)
      OR
      -- description fallback ONLY when neither side has a reference_number to
      -- compare — falling back to description whenever refs merely differ
      -- (rather than being absent) wrongly merges distinct real transactions
      -- that share an amount + generic description within the 3-day window
      -- (recurring payments, common bank-side wording) on banks like Discount
      -- where reference_number is populated on nearly every row.
      (t1.reference_number IS NULL AND t2.reference_number IS NULL
        AND t1.description IS NOT NULL AND t1.description = t2.description)
    )
  `).all();
  if (dups.length) {
    const dropIds = [...new Set(dups.map(d => d.drop_id))];
    const del = db.prepare(`DELETE FROM transactions WHERE id = ?`);
    const tx = db.transaction(ids => { for (const id of ids) del.run(id); });
    tx(dropIds);
    console.log(`[db] dedup: removed ${dropIds.length} duplicate transaction(s) (same amount+description within 3 days)`);
  }
}

// Backfill branch_id for existing rows by parsing the prefix of masked_number
// (works for all current banks: "855-11200/06", "157-252378948", "610-118686",
// "461-550217"). Branch_name stays null until the next sync provides it.
const stmtBackfillBranch = db.prepare(
  `UPDATE accounts SET branch_id = ? WHERE id = ? AND branch_id IS NULL`,
);
const rowsNeedingBackfill = db.prepare(
  `SELECT id, masked_number FROM accounts WHERE branch_id IS NULL`,
).all();
for (const row of rowsNeedingBackfill) {
  const branch = (row.masked_number || '').split(/[-/]/)[0] || null;
  if (branch && /^\d+$/.test(branch)) stmtBackfillBranch.run(branch, row.id);
}

// ── statements ───────────────────────────────────────────────────────────
const stmtUpsertBank = db.prepare(`
  INSERT INTO banks (id, name_he) VALUES (?, ?)
  ON CONFLICT(id) DO UPDATE SET name_he = excluded.name_he
`);

const stmtUpsertAccount = db.prepare(`
  INSERT INTO accounts (bank_id, account_index, masked_number, corporate_name, iban, last_balance, branch_id, branch_name)
  VALUES (@bank_id, @account_index, @masked_number, @corporate_name, @iban, @last_balance, @branch_id, @branch_name)
  ON CONFLICT(bank_id, masked_number) DO UPDATE SET
    account_index  = excluded.account_index,
    corporate_name = excluded.corporate_name,
    iban           = COALESCE(excluded.iban, iban),
    last_balance   = excluded.last_balance,
    branch_id      = COALESCE(excluded.branch_id, branch_id),
    branch_name    = COALESCE(excluded.branch_name, branch_name)
  RETURNING id
`);

const stmtInsertTxn = db.prepare(`
  INSERT INTO transactions (
    account_id, bank_transaction_id, date, effective_date,
    description, extended_description, amount, running_balance,
    beneficiary_name, beneficiary_bank_code, beneficiary_branch, beneficiary_account,
    reference_number, status, raw_json
  ) VALUES (
    @account_id, @bank_transaction_id, @date, @effective_date,
    @description, @extended_description, @amount, @running_balance,
    @beneficiary_name, @beneficiary_bank_code, @beneficiary_branch, @beneficiary_account,
    @reference_number, @status, @raw_json
  )
  ON CONFLICT(account_id, bank_transaction_id) DO UPDATE SET
    extended_description = COALESCE(excluded.extended_description, extended_description),
    raw_json = excluded.raw_json
`);

const stmtUpdateLastSync = db.prepare(`
  UPDATE accounts SET last_sync_at = ?, last_balance = COALESCE(?, last_balance) WHERE id = ?
`);

export function upsertBank(id, nameHe) {
  stmtUpsertBank.run(id, nameHe);
}

export function upsertAccount({ bankId, accountIndex, maskedNumber, corporateName, iban, balance, branchId, branchName }) {
  const branchFromMasked = branchId ?? ((maskedNumber || '').split(/[-/]/)[0] || null);
  const row = stmtUpsertAccount.get({
    bank_id: bankId,
    account_index: accountIndex,
    masked_number: maskedNumber,
    corporate_name: corporateName ?? null,
    iban: iban ?? null,
    last_balance: balance ?? null,
    branch_id: branchFromMasked && /^\d+$/.test(String(branchFromMasked)) ? String(branchFromMasked) : (branchId ?? null),
    branch_name: branchName ?? null,
  });
  return row.id;
}

// Description fallback fires ONLY when the incoming txn and the stored candidate
// both lack a reference_number — see matching comment on the startup dedup pass
// above for why falling back whenever refs merely differ (not absent) is wrong.
const stmtFindDupByRef = db.prepare(`
  SELECT id FROM transactions
  WHERE account_id = ?
    AND amount = ?
    AND ABS(julianday(date) - julianday(?)) <= 3
    AND (
      reference_number = ?
      OR (reference_number IS NULL AND ? IS NULL AND description IS NOT NULL AND description = ?)
    )
  LIMIT 1
`);

export function insertTransactions(accountId, txns, { status = 'completed' } = {}) {
  const insertMany = db.transaction((items) => {
    let newCount = 0;
    for (const t of items) {
      const refNum = t.referenceNumber != null ? String(t.referenceNumber) : null;
      const desc = t.description ?? null;
      const date = (t.date || '').slice(0, 10);
      const amount = Number(t.amount ?? 0);
      if ((refNum || desc) && stmtFindDupByRef.get(accountId, amount, date, refNum, refNum, desc)) continue;
      const res = stmtInsertTxn.run({
        account_id: accountId,
        bank_transaction_id: String(t.transactionID ?? t.id ?? ''),
        date: (t.date || '').slice(0, 10),
        effective_date: (t.effectiveDate || '').slice(0, 10) || null,
        description: t.description ?? null,
        extended_description: t.extendedDescription ?? null,
        amount: Number(t.amount ?? 0),
        running_balance: t.runningBalance != null ? Number(t.runningBalance) : null,
        beneficiary_name: t.beneficiaryName ?? null,
        beneficiary_bank_code: t.beneficiaryBankCode ?? null,
        beneficiary_branch: t.beneficiaryBranch ?? null,
        beneficiary_account: t.beneficiaryAccountNumber ?? null,
        reference_number: t.referenceNumber != null ? String(t.referenceNumber) : null,
        status,
        raw_json: JSON.stringify(t),
      });
      if (res.changes > 0) newCount++;
    }
    return newCount;
  });
  return insertMany(txns);
}

export function updateLastSync(accountId, balance = null) {
  stmtUpdateLastSync.run(new Date().toISOString(), balance, accountId);
}

export function listBanksWithAccounts() {
  const banks = db.prepare(`SELECT id, name_he, enabled FROM banks WHERE enabled = 1 ORDER BY name_he`).all();
  const accountsByBank = db.prepare(`
    SELECT a.id, a.bank_id, a.account_index, a.masked_number, a.corporate_name,
           a.iban, a.last_balance, a.last_sync_at, a.branch_id, a.branch_name, a.is_active,
           a.priority_cashname,
           (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS txn_count,
           (SELECT MAX(date) FROM transactions t WHERE t.account_id = a.id) AS last_txn_date
    FROM accounts a
    WHERE a.bank_id = ?
    ORDER BY a.account_index
  `);
  // Branches summary considers active accounts only — inactive ones shouldn't
  // count toward the bank's displayed presence.
  const branchSummary = db.prepare(`
    SELECT branch_id, MAX(branch_name) AS branch_name, COUNT(*) AS account_count
    FROM accounts
    WHERE bank_id = ? AND branch_id IS NOT NULL AND is_active = 1
    GROUP BY branch_id
    ORDER BY branch_id
  `);
  const lastSyncByBank = db.prepare(
    `SELECT MAX(last_sync_at) AS last_sync_at FROM accounts WHERE bank_id = ? AND is_active = 1`,
  );

  return banks.map(b => ({
    ...b,
    accounts: accountsByBank.all(b.id).map(a => ({ ...a, is_active: a.is_active === 1 })),
    branches: branchSummary.all(b.id),
    last_sync_at: lastSyncByBank.get(b.id).last_sync_at,
  }));
}

const stmtSetAccountActive = db.prepare(
  `UPDATE accounts SET is_active = ? WHERE id = ?`,
);
export function setAccountActive(accountId, isActive) {
  const res = stmtSetAccountActive.run(isActive ? 1 : 0, accountId);
  return res.changes > 0;
}

const stmtAccountActive = db.prepare(`SELECT is_active FROM accounts WHERE id = ?`);
export function isAccountActive(accountId) {
  const row = stmtAccountActive.get(accountId);
  return row ? row.is_active === 1 : null;
}

const stmtInactiveByBank = db.prepare(
  `SELECT masked_number FROM accounts WHERE bank_id = ? AND is_active = 0`,
);
export function getInactiveMaskedNumbers(bankId) {
  return new Set(stmtInactiveByBank.all(bankId).map(r => r.masked_number));
}

export function getAccountByMaskedNumber(bankId, maskedNumber) {
  return db.prepare(`SELECT * FROM accounts WHERE bank_id = ? AND masked_number = ?`).get(bankId, maskedNumber);
}

export function getAccount(accountId) {
  return db.prepare(`
    SELECT a.*, b.name_he AS bank_name_he,
           (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS txn_count
    FROM accounts a
    JOIN banks b ON b.id = a.bank_id
    WHERE a.id = ?
  `).get(accountId);
}

export function getTransactions(accountId, { limit = 200, offset = 0 } = {}) {
  return db.prepare(`
    SELECT id, date, effective_date, description, extended_description, amount,
           running_balance, beneficiary_name, beneficiary_account, reference_number, status,
           in_priority, priority_checked_at, priority_bankpage
    FROM transactions
    WHERE account_id = ?
    ORDER BY date DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(accountId, limit, offset);
}

export function getAccountBalances() {
  return db.prepare(`
    SELECT bank_id, corporate_name, last_balance
    FROM accounts
    WHERE last_balance IS NOT NULL AND is_active = 1
  `).all();
}

export function getTransactionsForPriorityCheck(accountId) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT id, date, effective_date, amount, running_balance
    FROM transactions
    WHERE account_id = ?
      AND date < ?
    ORDER BY date, id
  `).all(accountId, today);
}

const stmtUpdatePriorityFound = db.prepare(`
  UPDATE transactions
  SET in_priority = 1, priority_checked_at = ?, priority_bankpage = ?
  WHERE id = ?
`);
const stmtUpdatePriorityNotFound = db.prepare(`
  UPDATE transactions
  SET in_priority = 0, priority_checked_at = ?, priority_bankpage = NULL,
      pushed_to_priority_at = NULL
  WHERE id = ?
`);
export function updatePriorityStatus(updates) {
  // updates = [{ id, inPriority: 0|1, bankpage: string|null }]
  // When not found: also reset pushed_to_priority_at so the transaction re-enters the push queue.
  const now = new Date().toISOString();
  const tx = db.transaction((items) => {
    for (const u of items) {
      if (u.inPriority) {
        stmtUpdatePriorityFound.run(now, u.bankpage ?? null, u.id);
      } else {
        stmtUpdatePriorityNotFound.run(now, u.id);
      }
    }
  });
  tx(updates);
}

const stmtSetPriorityCashname = db.prepare(
  `UPDATE accounts SET priority_cashname = ? WHERE id = ?`,
);
export function setAccountPriorityCashname(accountId, cashname) {
  stmtSetPriorityCashname.run(cashname ?? null, accountId);
}

export function batchSetPriorityCashnames(updates) {
  // updates: [{ accountId, cashname }]
  const tx = db.transaction((items) => {
    for (const u of items) stmtSetPriorityCashname.run(u.cashname ?? null, u.accountId);
  });
  tx(updates);
}

export function getEndOfDayBalance(accountId, date) {
  return db.prepare(`
    SELECT running_balance FROM transactions
    WHERE account_id = ? AND date = ? AND running_balance IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(accountId, date);
}

// Balance as of the most recent transaction strictly before `date` — NOT
// necessarily the calendar day before. Gaps of several days with no activity
// are normal (weekends, quiet accounts), so anchoring on a fixed "date - 1"
// silently fails whenever that exact day has no transactions.
export function getLastBalanceBefore(accountId, date) {
  return db.prepare(`
    SELECT date, running_balance FROM transactions
    WHERE account_id = ? AND date < ? AND running_balance IS NOT NULL
    ORDER BY date DESC, id DESC LIMIT 1
  `).get(accountId, date);
}

export function getTransactionsForBalanceCheck(accountId) {
  return db.prepare(`
    SELECT id, date, amount, running_balance
    FROM transactions
    WHERE account_id = ?
    ORDER BY date, id
  `).all(accountId);
}

export function getFirstTransactionDate(accountId) {
  const row = db.prepare(`
    SELECT MIN(date) AS date FROM transactions WHERE account_id = ?
  `).get(accountId);
  return row?.date || null;
}

export function getTransactionDatesInRange(accountId, fromDate, toDate) {
  return db.prepare(`
    SELECT DISTINCT date FROM transactions
    WHERE account_id = ? AND date >= ? AND date <= ?
    ORDER BY date
  `).all(accountId, fromDate, toDate).map(r => r.date);
}

// Credit-card billing_date must be matched against the checking account's
// own effective_date ("תאריך ערך") — the date the debit actually value-dated
// against the balance — not `date` (the operation/posting date), which can
// legitimately differ from it.
export function getTransactionsForEffectiveDate(accountId, effectiveDate) {
  return db.prepare(`
    SELECT id, date, effective_date, description, extended_description, beneficiary_name,
           beneficiary_bank_code, beneficiary_branch, beneficiary_account,
           amount, reference_number
    FROM transactions
    WHERE account_id = ? AND effective_date = ?
    ORDER BY id
  `).all(accountId, effectiveDate);
}

export function getTransactionsForDate(accountId, date) {
  return db.prepare(`
    SELECT id, date, description, extended_description, beneficiary_name,
           beneficiary_bank_code, beneficiary_branch, beneficiary_account,
           amount, reference_number
    FROM transactions
    WHERE account_id = ? AND date = ?
    ORDER BY id
  `).all(accountId, date);
}

export function getTransactionsForPush(accountId) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT id, date, description, extended_description, beneficiary_name,
           beneficiary_bank_code, beneficiary_branch, beneficiary_account,
           amount, reference_number
    FROM transactions
    WHERE account_id = ?
      AND in_priority = 0
      AND pushed_to_priority_at IS NULL
      AND date < ?
    ORDER BY date, id
  `).all(accountId, today);
}

export function markTransactionsPushed(ids) {
  const now = new Date().toISOString();
  const tx = db.transaction((idList) => {
    const stmt = db.prepare(
      `UPDATE transactions SET pushed_to_priority_at = ?, in_priority = 1 WHERE id = ?`,
    );
    for (const id of idList) stmt.run(now, id);
  });
  tx(ids);
}

export function deleteTransaction(id) {
  const r = db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  return r.changes > 0;
}

export default db;
