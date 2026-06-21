// HMAC-signed timestamped cookie payload — equivalent to Python itsdangerous
// (different wire format, but same security properties: tamper-proof, expiring).
import crypto from 'node:crypto';

export const COOKIE_NAME = 'bz_auth';
export const STATE_COOKIE = 'bz_oauth_state';
export const DEFAULT_MAX_AGE = 12 * 60 * 60;  // 12h, same as Python version

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

export function createSessions(secret, { maxAge = DEFAULT_MAX_AGE } = {}) {
  const key = crypto.createHash('sha256').update('shared-auth-session|' + secret).digest();

  const sign = (data) => {
    const payload = b64url(JSON.stringify(data));
    const ts = Math.floor(Date.now() / 1000).toString();
    const tsEnc = b64url(ts);
    const body = `${payload}.${tsEnc}`;
    const sig = b64url(crypto.createHmac('sha256', key).update(body).digest());
    return `${body}.${sig}`;
  };

  const verify = (token) => {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [payload, tsEnc, sig] = parts;
    const expected = b64url(crypto.createHmac('sha256', key).update(`${payload}.${tsEnc}`).digest());
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const ts = Number(fromB64url(tsEnc).toString('utf8'));
    if (!Number.isFinite(ts)) return null;
    if (Date.now() / 1000 - ts > maxAge) return null;
    try {
      return JSON.parse(fromB64url(payload).toString('utf8'));
    } catch {
      return null;
    }
  };

  return { sign, verify, maxAge };
}

export function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out = {};
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}
