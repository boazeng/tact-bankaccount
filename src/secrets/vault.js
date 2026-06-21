// AES-256-GCM encryption for secrets at rest.
//
// Stored format: "<base64-iv>:<base64-ciphertext>:<base64-tag>" — a single
// string column that holds everything needed to decrypt one value. A fresh
// random IV per encryption ensures identical plaintexts produce different
// ciphertexts (and that GCM's nonce-uniqueness requirement is met).
//
// The master key is BANK_VAULT_KEY in env (32 raw bytes hex-encoded = 64
// chars). Loss of the key means loss of all encrypted credentials —
// they can be re-entered via the UI, but only the original admin knew them.
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;          // GCM standard
const KEY_BYTES = 32;         // AES-256

function getKey() {
  const hex = process.env.BANK_VAULT_KEY;
  if (!hex) throw new Error('BANK_VAULT_KEY missing from env (run: openssl rand -hex 32)');
  if (hex.length !== KEY_BYTES * 2) {
    throw new Error(`BANK_VAULT_KEY must be ${KEY_BYTES * 2} hex chars (got ${hex.length})`);
  }
  return Buffer.from(hex, 'hex');
}

export function vaultConfigured() {
  const hex = process.env.BANK_VAULT_KEY;
  return !!hex && hex.length === KEY_BYTES * 2;
}

export function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':');
}

export function decrypt(stored) {
  if (stored == null || stored === '') return null;
  const key = getKey();
  const parts = String(stored).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted value format');
  const [ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
