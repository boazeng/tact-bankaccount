// Bank-credentials service: read/write encrypted secrets to SQLite.
//
// Public surface:
//   listStatus()            — for the admin UI (NEVER returns decrypted values)
//   setCredentials(...)      — write/update one bank's credentials, encrypts
//   getCredentialsForSync(...) — decrypt for use by the scraper. Audited.
//   bootstrapFromEnvIfEmpty() — one-time import from env on first startup
//                              with the vault key set.
import db from '../db.js';
import { encrypt, decrypt, vaultConfigured } from './vault.js';

const stmtUpsert = db.prepare(`
  INSERT INTO bank_credentials (bank_id, username, password, login_url, updated_at, updated_by, is_set)
  VALUES (@bank_id, @username, @password, @login_url, datetime('now'), @updated_by, 1)
  ON CONFLICT(bank_id) DO UPDATE SET
    username   = COALESCE(excluded.username,   bank_credentials.username),
    password   = COALESCE(excluded.password,   bank_credentials.password),
    login_url  = COALESCE(excluded.login_url,  bank_credentials.login_url),
    updated_at = datetime('now'),
    updated_by = excluded.updated_by,
    is_set     = 1
`);
const stmtGetRaw = db.prepare(`SELECT * FROM bank_credentials WHERE bank_id = ?`);
const stmtList = db.prepare(`SELECT bank_id, updated_at, updated_by, is_set FROM bank_credentials`);
const stmtAudit = db.prepare(
  `INSERT INTO bank_credentials_audit (bank_id, action, actor, fields) VALUES (?, ?, ?, ?)`,
);
const stmtCount = db.prepare(`SELECT COUNT(*) AS n FROM bank_credentials`);

/**
 * Returns one row per known bank that has credentials set, with metadata only.
 * NEVER returns decrypted username/password/url.
 */
export function listStatus() {
  return stmtList.all().map(r => ({
    bank_id: r.bank_id,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
    is_set: r.is_set === 1,
  }));
}

/**
 * Set or update credentials for one bank. Partial updates supported — pass
 * only the fields you want to change. Blank/undefined fields preserve the
 * existing encrypted value via SQL's COALESCE.
 */
export function setCredentials(bankId, { username, password, loginUrl }, actor) {
  if (!vaultConfigured()) throw new Error('BANK_VAULT_KEY not configured');
  const updates = {
    bank_id: bankId,
    username:  username  ? encrypt(username)  : null,
    password:  password  ? encrypt(password)  : null,
    login_url: loginUrl  ? encrypt(loginUrl)  : null,
    updated_by: actor || 'unknown',
  };
  stmtUpsert.run(updates);
  const changed = [
    username ? 'username' : null,
    password ? 'password' : null,
    loginUrl ? 'loginUrl' : null,
  ].filter(Boolean);
  stmtAudit.run(bankId, 'set', actor || null, JSON.stringify(changed));
}

/**
 * Decrypt credentials for use by the scraper. Logs an audit row. This is the
 * ONLY function in the codebase that returns plaintext credentials — keep its
 * call sites limited to the sync handler.
 *
 * Returns null if the bank has no credentials stored (caller should fall back
 * to env-based credentials).
 */
export function getCredentialsForSync(bankId, triggeredBy = 'sync') {
  const row = stmtGetRaw.get(bankId);
  if (!row || row.is_set !== 1) return null;
  stmtAudit.run(bankId, 'sync_read', triggeredBy, null);
  return {
    username:  row.username  ? decrypt(row.username)  : null,
    password:  row.password  ? decrypt(row.password)  : null,
    loginUrl:  row.login_url ? decrypt(row.login_url) : null,
  };
}

/**
 * One-time import on startup: if the vault is configured AND env has bank
 * credentials AND DB has none, copy them in. Safe to call on every boot —
 * does nothing if DB already has rows.
 *
 * Each bank's env keys are looked up via the provided registry's
 * credentialsFromEnv function (so we use the same fallback rules the registry
 * already encodes).
 */
export function bootstrapFromEnvIfEmpty(bankRegistry) {
  if (!vaultConfigured()) return { skipped: true, reason: 'no vault key' };
  if (stmtCount.get().n > 0) return { skipped: true, reason: 'already populated' };

  let imported = 0;
  for (const [bankId, bank] of Object.entries(bankRegistry)) {
    const env = bank.credentialsFromEnv(process.env);
    // Different banks call the identifier field different names. Normalize.
    const username = env.username ?? env.userId;
    const password = env.password;
    const loginUrl = env.loginUrl;
    if (username && password && loginUrl) {
      stmtUpsert.run({
        bank_id: bankId,
        username:  encrypt(username),
        password:  encrypt(password),
        login_url: encrypt(loginUrl),
        updated_by: 'system-bootstrap',
      });
      stmtAudit.run(bankId, 'bootstrap', 'system', JSON.stringify(['username', 'password', 'loginUrl']));
      imported++;
    }
  }
  return { skipped: false, imported };
}

/**
 * Resolve credentials for the scraper. Prefers vault (DB) when configured and
 * set; falls back to env via the registry's credentialsFromEnv. Re-shapes the
 * result so each scraper still receives its expected property names.
 */
export function resolveCredentialsForBank(bankId, bankRegistry, actor = 'sync') {
  const expectsUserId = bankId !== 'leumi'; // only leumi uses `username` in its scraper

  const fromVault = vaultConfigured() ? getCredentialsForSync(bankId, actor) : null;
  if (fromVault && fromVault.username && fromVault.password && fromVault.loginUrl) {
    return expectsUserId
      ? { userId: fromVault.username, password: fromVault.password, loginUrl: fromVault.loginUrl }
      : { username: fromVault.username, password: fromVault.password, loginUrl: fromVault.loginUrl };
  }
  return bankRegistry[bankId].credentialsFromEnv(process.env);
}
