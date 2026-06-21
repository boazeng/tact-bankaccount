// User database — central master DB used by multiple apps.
//
// Two-level schema:
//   - `users` table:      identity (email/name/active), kept compatible with
//                         legacy shared-auth (Python) so apps can still read it
//                         as a flat allowlist if they want.
//   - `user_apps` table:  per-app access grants. Each row says "this user can
//                         access this app, with this role". app_id = '*' is a
//                         wildcard meaning all apps.
//   - `apps` table:       registry of known applications (for the UI picker).
//
// The legacy `users.role` column is maintained as a best-effort denormalized
// view of the user's effective role, so Python apps that only know the old
// schema continue to grant the right level of access.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const ROLES = ['admin', 'approver', 'user'];
export const GLOBAL_APP = '*';
const ROLE_RANK = { admin: 3, approver: 2, user: 1 };

export const normEmail = (email) => (email || '').trim().toLowerCase();

export const KNOWN_APPS = [
  { id: 'tact-bankaccount', name_he: 'TACT — חשבונות בנק' },
  { id: 'accounting', name_he: 'הנהלת חשבונות' },
  { id: 'cmm', name_he: 'CMM — ליקויי בניה' },
];

export function openUsersDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      email          TEXT PRIMARY KEY,
      name           TEXT NOT NULL DEFAULT '',
      role           TEXT NOT NULL DEFAULT 'user',
      active         INTEGER NOT NULL DEFAULT 1,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login_at  TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_apps (
      email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      app_id  TEXT NOT NULL,
      role    TEXT NOT NULL DEFAULT 'user',
      PRIMARY KEY (email, app_id)
    );
    CREATE TABLE IF NOT EXISTS apps (
      id       TEXT PRIMARY KEY,
      name_he  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_apps_email ON user_apps(email);
    CREATE INDEX IF NOT EXISTS idx_user_apps_app ON user_apps(app_id);
  `);

  const seedApp = db.prepare(
    `INSERT INTO apps (id, name_he) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET name_he = excluded.name_he`,
  );
  for (const a of KNOWN_APPS) seedApp.run(a.id, a.name_he);

  const stmts = {
    getUser: db.prepare('SELECT * FROM users WHERE email = ?'),
    listUsers: db.prepare("SELECT * FROM users ORDER BY email"),
    upsertUser: db.prepare(`
      INSERT INTO users (email, name, role, active) VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        name = excluded.name, role = excluded.role, active = excluded.active
    `),
    addUserIfMissing: db.prepare(
      `INSERT OR IGNORE INTO users (email, name, role, active) VALUES (?, ?, ?, 1)`,
    ),
    deleteUser: db.prepare('DELETE FROM users WHERE email = ?'),
    touchLogin: db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE email = ?"),

    getAppsForUser: db.prepare('SELECT app_id, role FROM user_apps WHERE email = ?'),
    upsertUserApp: db.prepare(`
      INSERT INTO user_apps (email, app_id, role) VALUES (?, ?, ?)
      ON CONFLICT(email, app_id) DO UPDATE SET role = excluded.role
    `),
    clearUserApps: db.prepare('DELETE FROM user_apps WHERE email = ?'),
    deleteUserApp: db.prepare('DELETE FROM user_apps WHERE email = ? AND app_id = ?'),
    checkAccess: db.prepare(`
      SELECT role FROM user_apps
      WHERE email = ? AND app_id IN (?, '*')
      ORDER BY app_id = '*' LIMIT 1
    `),
    countActiveAdmins: db.prepare(`
      SELECT COUNT(DISTINCT u.email) AS n
      FROM users u JOIN user_apps ua ON ua.email = u.email
      WHERE u.active = 1 AND ua.role = 'admin' AND ua.app_id IN (?, '*')
    `),

    listApps: db.prepare('SELECT id, name_he FROM apps ORDER BY name_he'),
  };

  // Effective role for a user across all their apps — used to keep
  // legacy `users.role` column denormalized for Python apps.
  const effectiveRole = (email) => {
    const rows = stmts.getAppsForUser.all(normEmail(email));
    if (!rows.length) return 'user';
    return rows.reduce((best, r) =>
      (ROLE_RANK[r.role] || 0) > (ROLE_RANK[best] || 0) ? r.role : best, 'user');
  };

  const syncLegacyRole = (email) => {
    const e = normEmail(email);
    const user = stmts.getUser.get(e);
    if (!user) return;
    const role = effectiveRole(e);
    if (user.role !== role) {
      stmts.upsertUser.run(e, user.name, role, user.active);
    }
  };

  return {
    // ───── identity ─────
    get(email) {
      const row = stmts.getUser.get(normEmail(email));
      return row ? { ...row, active: row.active === 1 } : null;
    },
    listAll() {
      const users = stmts.listUsers.all().map(r => ({
        ...r,
        active: r.active === 1,
        apps: stmts.getAppsForUser.all(r.email),
      }));
      return users;
    },
    addIfMissing(email, name = '', { globalRole = 'user' } = {}) {
      stmts.addUserIfMissing.run(normEmail(email), name || '', ROLES.includes(globalRole) ? globalRole : 'user');
    },
    upsert(email, { name = '', active = true } = {}) {
      const e = normEmail(email);
      const existing = stmts.getUser.get(e);
      const role = existing ? existing.role : 'user';
      stmts.upsertUser.run(e, name || '', role, active ? 1 : 0);
      syncLegacyRole(e);
    },
    delete(email) {
      stmts.deleteUser.run(normEmail(email));
    },
    touchLogin(email) {
      stmts.touchLogin.run(normEmail(email));
    },

    // ───── per-app access ─────
    setAccess(email, grants) {
      // grants = { kind: 'global', role } | { kind: 'specific', apps: [{ id, role }] }
      const e = normEmail(email);
      const tx = db.transaction(() => {
        stmts.clearUserApps.run(e);
        if (grants.kind === 'global') {
          const role = ROLES.includes(grants.role) ? grants.role : 'user';
          stmts.upsertUserApp.run(e, GLOBAL_APP, role);
        } else {
          for (const a of grants.apps || []) {
            const role = ROLES.includes(a.role) ? a.role : 'user';
            stmts.upsertUserApp.run(e, a.id, role);
          }
        }
        syncLegacyRole(e);
      });
      tx();
    },
    getAppsFor(email) {
      return stmts.getAppsForUser.all(normEmail(email));
    },
    /**
     * Resolve the user's role for a specific app. Returns null if not authorized.
     * Falls back to the legacy `users.role` column when there are no rows in
     * user_apps yet (so a freshly-bootstrapped DB still works).
     */
    resolveRoleForApp(email, appId) {
      const e = normEmail(email);
      const user = stmts.getUser.get(e);
      if (!user || user.active !== 1) return null;
      const accessRow = stmts.checkAccess.get(e, appId);
      if (accessRow) return accessRow.role;
      const grants = stmts.getAppsForUser.all(e);
      if (grants.length === 0) {
        // Legacy: no user_apps rows yet → fall back to users.role as global.
        return user.role || 'user';
      }
      return null;
    },
    countActiveAdmins(appId) {
      return stmts.countActiveAdmins.get(appId).n;
    },

    // ───── apps registry ─────
    listApps() {
      return stmts.listApps.all();
    },
  };
}
