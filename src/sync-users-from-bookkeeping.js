// One-off sync: import the 4 active admins from bookkeeping production into env/auth.db.
// Source: TACT bookkeeping user-management page (manual snapshot).
import { openUsersDb } from './auth/users-db.js';

const DB_PATH = 'C:/Users/User/Aiprojects/env/auth.db';

const usersFromBookkeeping = [
  { email: 'boazen@gmail.com',       name: 'בועז' },
  { email: 'boen01@gmail.com',       name: '' },
  { email: 'shelly5353@gmail.com',   name: 'שלי' },
  { email: 'yael.israel303@gmail.com', name: 'רעות' },
];

const db = openUsersDb(DB_PATH);
console.log(`Opened ${DB_PATH}\n`);

console.log('Before sync:');
for (const u of db.listAll()) {
  console.log(`  ${u.email} (${u.name || '—'}) active=${u.active} apps=${JSON.stringify(u.apps)}`);
}
console.log('');

let added = 0, updated = 0;
for (const src of usersFromBookkeeping) {
  const existing = db.get(src.email);
  db.addIfMissing(src.email, src.name, { globalRole: 'admin' });
  db.upsert(src.email, { name: src.name, active: true });
  db.setAccess(src.email, { kind: 'global', role: 'admin' });
  if (existing) updated++;
  else added++;
  console.log(`  ${existing ? '↺ updated' : '+ added'}: ${src.email} (${src.name || '—'}) → global admin`);
}

console.log(`\nDone: ${added} added, ${updated} updated.\n`);
console.log('After sync:');
for (const u of db.listAll()) {
  const access = u.apps.length
    ? u.apps.map(a => `${a.app_id}:${a.role}`).join(', ')
    : '(none)';
  console.log(`  ${u.email.padEnd(28)} ${(u.name || '—').padEnd(8)} active=${u.active} → ${access}`);
}
