// installAuth — mounts Google OAuth login, role-based authorization, and
// admin user management onto an Express app.
//
// The auth flow keys off two pieces of state: the user identity (from Google),
// and the user's grant for the current app (from user_apps). The current app
// is identified by `appId` so multiple apps can share one auth.db.
import path from 'node:path';
import { loadAuthConfig } from './config.js';
import { openUsersDb, ROLES, GLOBAL_APP, KNOWN_APPS, normEmail } from './users-db.js';
import { createSessions, COOKIE_NAME, STATE_COOKIE, parseCookies } from './sessions.js';
import { newState, buildLoginUrl, exchangeCode } from './oauth.js';

const PUBLIC_PREFIXES = [
  '/login', '/auth/', '/logout', '/emergency-login', '/no-access',
  '/static/', '/favicon', '/style.css', '/app.js',
];

const EMERGENCY_WINDOW_MS = 15 * 60 * 1000;
const EMERGENCY_MAX = 5;
const emergencyFails = new Map();

function emergencyBlocked(ip) {
  const now = Date.now();
  const hits = (emergencyFails.get(ip) || []).filter(t => now - t < EMERGENCY_WINDOW_MS);
  emergencyFails.set(ip, hits);
  return hits.length >= EMERGENCY_MAX;
}
function emergencyRecordFail(ip) {
  const hits = emergencyFails.get(ip) || [];
  hits.push(Date.now());
  emergencyFails.set(ip, hits);
}

export function installAuth(app, {
  appId,
  dbPath,
  redirectUri,
  initialUsers = [],
  publicPrefixes = [],
} = {}) {
  if (!appId) throw new Error('installAuth: appId is required (identifies this app in the central users DB)');
  if (!dbPath) throw new Error('installAuth: dbPath is required');
  if (!redirectUri) throw new Error('installAuth: redirectUri is required');

  const config = loadAuthConfig();
  const db = openUsersDb(path.resolve(dbPath));
  const sessions = createSessions(config.sessionSecret);

  for (const u of initialUsers) {
    db.addIfMissing(u.email, u.name || '', { globalRole: u.role || 'user' });
    if (u.role) db.setAccess(u.email, { kind: 'global', role: u.role });
  }
  if (config.superAdminEmail) {
    db.addIfMissing(config.superAdminEmail, 'super-admin', { globalRole: 'admin' });
    const grants = db.getAppsFor(config.superAdminEmail);
    if (!grants.some(g => g.app_id === GLOBAL_APP && g.role === 'admin')) {
      db.setAccess(config.superAdminEmail, { kind: 'global', role: 'admin' });
    }
  }

  const resolveUser = (email) => {
    email = normEmail(email);
    // Layer 1: super-admin always wins
    if (email && email === config.superAdminEmail) {
      return { email, role: 'admin', name: 'super-admin' };
    }
    const role = db.resolveRoleForApp(email, appId);
    if (!role) return null;
    const user = db.get(email);
    return { email, role, name: user?.name || '' };
  };

  const allPublic = [...PUBLIC_PREFIXES, ...publicPrefixes];

  const cookieOpts = {
    maxAge: sessions.maxAge * 1000,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  };

  // ───── Middleware ─────
  app.use((req, res, next) => {
    if (config.disabled) {
      req.user = { email: 'auth-disabled', role: 'admin', name: '' };
      return next();
    }
    const cookies = parseCookies(req);
    const user = sessions.verify(cookies[COOKIE_NAME]);
    req.user = user || null;
    req._cookies = cookies;

    if (user) return next();
    if (allPublic.some(p => req.path.startsWith(p))) return next();

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'לא מחובר' });
    }
    return res.redirect('/login');
  });

  // ───── Auth routes ─────
  app.get('/login', (req, res) => {
    const cookies = parseCookies(req);
    if (sessions.verify(cookies[COOKIE_NAME])) return res.redirect('/');
    res.sendFile(path.resolve('public/login.html'));
  });

  app.get('/auth/start', (req, res) => {
    const state = newState();
    const url = buildLoginUrl(config.clientId, redirectUri, state);
    res.cookie(STATE_COOKIE, sessions.sign({ state }), {
      ...cookieOpts, maxAge: 10 * 60 * 1000,
    });
    res.redirect(url);
  });

  app.get('/auth/callback', async (req, res) => {
    const cookies = parseCookies(req);
    const saved = sessions.verify(cookies[STATE_COOKIE]);
    const { code = '', state = '' } = req.query;
    if (!saved || saved.state !== state || !code) {
      return res.redirect('/no-access?reason=state');
    }
    let info;
    try {
      info = await exchangeCode(config.clientId, config.clientSecret, redirectUri, code);
    } catch (err) {
      console.error('[auth] OAuth callback failed:', err.message);
      return res.redirect('/no-access?reason=oauth');
    }
    if (!info.emailVerified) return res.redirect('/no-access?reason=unverified');
    const user = resolveUser(info.email);
    if (!user) {
      console.warn(`[auth] login rejected — no access to ${appId}: ${info.email}`);
      return res.redirect('/no-access?reason=notallowed');
    }
    db.touchLogin(user.email);
    res.cookie(COOKIE_NAME, sessions.sign(user), cookieOpts);
    res.clearCookie(STATE_COOKIE, { path: '/' });
    console.log(`[auth] login: ${user.email} (${user.role}) → ${appId}`);
    res.redirect('/');
  });

  app.get('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.redirect('/login');
  });

  app.get('/emergency-login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '?';
    if (emergencyBlocked(ip)) return res.status(429).send('<h1>429 — נחסם זמנית</h1>');
    const token = req.query.token || '';
    if (!config.emergencyToken || token !== config.emergencyToken) {
      emergencyRecordFail(ip);
      return res.status(403).send('<h1>403</h1>');
    }
    const user = {
      email: config.superAdminEmail || 'emergency',
      role: 'admin',
      name: 'emergency',
    };
    res.cookie(COOKIE_NAME, sessions.sign(user), cookieOpts);
    console.warn(`[auth] emergency login from ${ip}`);
    res.redirect('/');
  });

  app.get('/no-access', (req, res) => res.status(403).sendFile(path.resolve('public/no-access.html')));

  // ───── User-info & admin user management ─────
  app.get('/auth/me', (req, res) => res.json(req.user || {}));

  app.get('/auth/apps', requireRole('admin'), (req, res) => {
    res.json({ apps: db.listApps(), currentAppId: appId });
  });

  app.get('/auth/users', requireRole('admin'), (req, res) => {
    res.json({ users: db.listAll(), roles: ROLES, apps: db.listApps(), currentAppId: appId });
  });

  app.post('/auth/users', requireRole('admin'), (req, res) => {
    const email = normEmail(req.body?.email);
    const name = req.body?.name || '';
    const active = req.body?.active !== false;
    const access = req.body?.access;  // { kind: 'global'|'specific', role?, apps? }

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'אימייל לא תקין' });
    }
    if (!access || !['global', 'specific'].includes(access.kind)) {
      return res.status(400).json({ error: 'יש לבחור סוג גישה' });
    }
    if (access.kind === 'global' && !ROLES.includes(access.role)) {
      return res.status(400).json({ error: 'תפקיד לא תקין' });
    }
    if (access.kind === 'specific') {
      if (!Array.isArray(access.apps) || access.apps.length === 0) {
        return res.status(400).json({ error: 'יש לבחור לפחות אפליקציה אחת' });
      }
      for (const a of access.apps) {
        if (!a.id || !ROLES.includes(a.role)) {
          return res.status(400).json({ error: 'אפליקציה או תפקיד לא תקין' });
        }
      }
    }

    const admin = req.user;
    if (email === admin.email) {
      const stillAdminHere = access.kind === 'global' && access.role === 'admin'
        || (access.kind === 'specific' && access.apps.some(a => a.id === appId && a.role === 'admin'));
      if (!stillAdminHere || !active) {
        return res.status(400).json({ error: 'אי אפשר לשנות לעצמך תפקיד/סטטוס באפליקציה הזו' });
      }
    }

    const wasAdminHere = (() => {
      const existing = db.get(email);
      if (!existing || !existing.active) return false;
      const grants = db.getAppsFor(email);
      return grants.some(g => g.role === 'admin' && (g.app_id === appId || g.app_id === GLOBAL_APP));
    })();
    const willBeAdminHere = active && (
      (access.kind === 'global' && access.role === 'admin')
      || (access.kind === 'specific' && access.apps.some(a => a.id === appId && a.role === 'admin'))
    );
    if (wasAdminHere && !willBeAdminHere && db.countActiveAdmins(appId) <= 1) {
      return res.status(400).json({ error: 'חייב להישאר admin פעיל אחד לפחות באפליקציה הזו' });
    }

    db.upsert(email, { name, active });
    db.setAccess(email, access);
    res.json({ ok: true });
  });

  app.post('/auth/users/delete', requireRole('admin'), (req, res) => {
    const email = normEmail(req.body?.email);
    const admin = req.user;
    if (email === admin.email) return res.status(400).json({ error: 'אי אפשר למחוק את עצמך' });
    if (email === config.superAdminEmail) return res.status(400).json({ error: 'אי אפשר למחוק את ה-super-admin' });
    const existing = db.get(email);
    const wasAdminHere = existing && existing.active
      && db.getAppsFor(email).some(g => g.role === 'admin' && (g.app_id === appId || g.app_id === GLOBAL_APP));
    if (wasAdminHere && db.countActiveAdmins(appId) <= 1) {
      return res.status(400).json({ error: 'חייב להישאר admin פעיל אחד לפחות באפליקציה הזו' });
    }
    db.delete(email);
    res.json({ ok: true });
  });

  console.log(`[auth] installed — app=${appId}, db=${dbPath}, ${db.listAll().length} users`);
  return { db, config, sessions, requireLogin, requireRole, appId };
}

// ───── Route guards ─────
export function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'לא מחובר' });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'לא מחובר' });
    if (req.user.role !== 'admin' && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'אין לך הרשאה' });
    }
    next();
  };
}
