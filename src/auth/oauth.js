// Mirror of shared_auth/oauth.py — Google OAuth 2.0 / OpenID Connect authorization-code flow.
import crypto from 'node:crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export const newState = () => crypto.randomBytes(24).toString('base64url');

export function buildLoginUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

function decodeIdToken(idToken) {
  // No signature verification needed: id_token came directly from Google's token
  // endpoint over authenticated TLS (same trust model as the Python version).
  const payload = idToken.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

export async function exchangeCode(clientId, clientSecret, redirectUri, code) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const claims = decodeIdToken(json.id_token);
  if (claims.aud !== clientId) {
    throw new Error('OAuth: aud does not match client_id');
  }
  return {
    email: (claims.email || '').trim().toLowerCase(),
    emailVerified: !!claims.email_verified,
    name: claims.name || '',
  };
}
