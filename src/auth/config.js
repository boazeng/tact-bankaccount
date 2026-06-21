// Mirror of shared_auth/config.py — same env var names so creds carry over.
import dotenv from 'dotenv';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/.env' });

const required = (name) => {
  const v = (process.env[name] || '').trim();
  if (!v) throw new Error(`auth: missing required env var ${name}`);
  return v;
};

const optional = (name, fallback = '') => (process.env[name] || fallback).trim();

export function loadAuthConfig() {
  return {
    clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
    sessionSecret: required('AUTH_SESSION_SECRET'),
    emergencyToken: optional('AUTH_EMERGENCY_TOKEN'),
    superAdminEmail: optional('AUTH_SUPER_ADMIN_EMAIL').toLowerCase(),
    disabled: ['1', 'true', 'yes'].includes(optional('AUTH_DISABLED', 'false').toLowerCase()),
  };
}
