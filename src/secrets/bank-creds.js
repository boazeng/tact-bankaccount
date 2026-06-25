// Bank-credentials service: read/write encrypted secrets to SQLite.
//
// Public surface:
//   listStatus()                       — admin UI metadata (never decrypted)
//   addCredentials(...)                — insert a new credential set for a bank
//   updateCredentials(...)             — partial-update an existing set by id
//   deleteCredentials(...)             — remove a credential set by id
//   getAllCredentialsForSync(...)       — decrypt all sets for a bank (scraper only)
//   resolveAllCredentialsForBank(...)  — vault → env fallback, shaped per scraper
//   bootstrapFromEnvIfEmpty()          — one-time import from env on first startup
import db from '../db.js';
import { encrypt, decrypt, vaultConfigured } from './vault.js';

const stmtInsert = db.prepare(`
  INSERT INTO bank_credentials (bank_id, label, username, password, login_url, updated_at, updated_by, is_set)
  VALUES (@bank_id, @label, @username, @password, @login_url, datetime('now'), @updated_by, 1)
`);

const stmtUpdate = db.prepare(`
  UPDATE bank_credentials SET
    label      = COALESCE(@label,     label),
    username   = COALESCE(@username,  username),
    password   = COALESCE(@password,  password),
    login_url  = COALESCE(@login_url, login_url),
    updated_at = datetime('now'),
    updated_by = @updated_by,
    is_set     = 1
  WHERE id = @id AND bank_id = @bank_id
`);

const stmtDelete = db.prepare(`DELETE FROM bank_credentials WHERE id = ? AND bank_id = ?`);

const stmtGetByBank = db.prepare(`SELECT * FROM bank_credentials WHERE bank_id = ? AND is_set = 1`);

const stmtList = db.prepare(
  `SELECT id, bank_id, label, updated_at, updated_by, is_set FROM bank_credentials`,
);

const stmtAudit = db.prepare(
  `INSERT INTO bank_credentials_audit (bank_id, credential_id, action, actor, fields)
   VALUES (?, ?, ?, ?, ?)`,
);

const stmtCountByBank = db.prepare(
  `SELECT COUNT(*) AS n FROM bank_credentials WHERE bank_id = ?`,
);

/**
 * Returns all credential metadata for all banks. Never returns decrypted values.
 * Multiple rows per bank when multiple credential sets exist.
 */
export function listStatus() {
  return stmtList.all().map(r => ({
    id: r.id,
    bank_id: r.bank_id,
    label: r.label,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
    is_set: r.is_set === 1,
  }));
}

/**
 * Add a new credential set for a bank. Username and password are required.
 */
export function addCredentials(bankId, { label = 'ראשי', username, password, loginUrl }, actor) {
  if (!vaultConfigured()) throw new Error('BANK_VAULT_KEY not configured');
  if (!username || !password) throw new Error('שם משתמש וסיסמה חובה');
  const result = stmtInsert.run({
    bank_id: bankId,
    label: (label || 'ראשי').trim(),
    username: encrypt(username),
    password: encrypt(password),
    login_url: loginUrl ? encrypt(loginUrl) : null,
    updated_by: actor || 'unknown',
  });
  const changed = ['username', 'password', loginUrl ? 'loginUrl' : null].filter(Boolean);
  stmtAudit.run(bankId, result.lastInsertRowid, 'set', actor || null, JSON.stringify(changed));
}

/**
 * Update an existing credential set by id. Partial update: blank fields preserve
 * the existing encrypted value via SQL COALESCE.
 */
export function updateCredentials(bankId, credId, { label, username, password, loginUrl }, actor) {
  if (!vaultConfigured()) throw new Error('BANK_VAULT_KEY not configured');
  const info = stmtUpdate.run({
    id: Number(credId),
    bank_id: bankId,
    label: label ? label.trim() : null,
    username: username ? encrypt(username) : null,
    password: password ? encrypt(password) : null,
    login_url: loginUrl ? encrypt(loginUrl) : null,
    updated_by: actor || 'unknown',
  });
  if (info.changes === 0) throw new Error('פרטי כניסה לא נמצאו');
  const changed = [
    label ? 'label' : null,
    username ? 'username' : null,
    password ? 'password' : null,
    loginUrl ? 'loginUrl' : null,
  ].filter(Boolean);
  stmtAudit.run(bankId, Number(credId), 'set', actor || null, JSON.stringify(changed));
}

/**
 * Delete a credential set by id. Logs an audit row.
 */
export function deleteCredentials(bankId, credId, actor) {
  stmtDelete.run(Number(credId), bankId);
  stmtAudit.run(bankId, Number(credId), 'delete', actor || null, null);
}

/**
 * Decrypt ALL credential sets for a bank, for use by the scraper. Logs one
 * audit row per set. Returns empty array if bank has no stored credentials.
 *
 * This is the ONLY function that returns plaintext — keep call sites limited
 * to the sync handler / resolveAllCredentialsForBank.
 */
export function getAllCredentialsForSync(bankId, triggeredBy = 'sync') {
  const rows = stmtGetByBank.all(bankId);
  return rows.map(row => {
    stmtAudit.run(bankId, row.id, 'sync_read', triggeredBy, null);
    return {
      credentialId: row.id,
      label: row.label,
      username: row.username ? decrypt(row.username) : null,
      password: row.password ? decrypt(row.password) : null,
      loginUrl: row.login_url ? decrypt(row.login_url) : null,
    };
  });
}

/**
 * Resolve all credential sets for the scraper. Prefers vault when configured;
 * falls back to env (single-element array). Re-shapes property names to match
 * each bank's scraper expectation (leumi → username, others → userId).
 */
export function resolveAllCredentialsForBank(bankId, bankRegistry, actor = 'sync') {
  const expectsUserId = bankId !== 'leumi';

  if (vaultConfigured()) {
    const fromVault = getAllCredentialsForSync(bankId, actor);
    if (fromVault.length > 0) {
      return fromVault.map(c => ({
        label: c.label,
        credentials: expectsUserId
          ? { userId: c.username, password: c.password, loginUrl: c.loginUrl }
          : { username: c.username, password: c.password, loginUrl: c.loginUrl },
      }));
    }
  }

  const envCreds = bankRegistry[bankId].credentialsFromEnv(process.env);
  return [{ label: 'env', credentials: envCreds }];
}

/**
 * One-time import per bank on startup: if vault is configured AND env has
 * credentials AND that bank has no stored rows, copy env creds in.
 * Safe to call on every boot — no-op per bank that already has rows.
 */
export function bootstrapFromEnvIfEmpty(bankRegistry) {
  if (!vaultConfigured()) return { skipped: true, reason: 'no vault key' };

  let imported = 0;
  for (const [bankId, bank] of Object.entries(bankRegistry)) {
    if (stmtCountByBank.get(bankId).n > 0) continue;
    const env = bank.credentialsFromEnv(process.env);
    const username = env.username ?? env.userId;
    const { password, loginUrl } = env;
    if (username && password && loginUrl) {
      const result = stmtInsert.run({
        bank_id: bankId,
        label: 'ראשי',
        username: encrypt(username),
        password: encrypt(password),
        login_url: encrypt(loginUrl),
        updated_by: 'system-bootstrap',
      });
      stmtAudit.run(bankId, result.lastInsertRowid, 'bootstrap', 'system',
        JSON.stringify(['username', 'password', 'loginUrl']));
      imported++;
    }
  }
  return { skipped: false, imported };
}
