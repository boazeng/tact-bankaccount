import express from 'express';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Load env from the shared file on local dev. In production (docker) the
// vars are injected via env_file; the file path below won't exist, so this
// is a no-op there.
const tryLoadEnv = (p) => { if (p && fs.existsSync(p)) dotenv.config({ path: p }); };
tryLoadEnv(process.env.SHARED_ENV_FILE || 'C:/Users/User/Aiprojects/env/.env');
tryLoadEnv(process.env.BANK_ENV_FILE || 'C:/Users/User/Aiprojects/env/bank.env');

import { bankRegistry, getBank, listBanks } from './scrapers/index.js';
import {
  upsertBank, upsertAccount, insertTransactions, updateLastSync,
  listBanksWithAccounts, getAccount, getTransactions,
  setAccountActive, getInactiveMaskedNumbers,
  getTransactionsForPriorityCheck, updatePriorityStatus,
  getAccountBalances,
  setAccountPriorityCashname, getTransactionsForPush,
  batchSetPriorityCashnames,
} from './db.js';

const FLOW_BALANCE_MAPPING = [
  { bankId: 'poalim',   match: 'חניה',   flowKey: 'חניה_פועלים' },
  { bankId: 'poalim',   match: 'אנרגיה', flowKey: 'אנרגיה_פועלים' },
  { bankId: 'discount', match: null,      flowKey: 'אחזקה_דיסקונט' },
  { bankId: 'mizrachi', match: null,      flowKey: 'אחזקה_מזרחי' },
];

async function pushBalancesToFlow() {
  const flowUrl = process.env.FLOW_API_URL;
  const flowKey = process.env.FLOW_API_KEY;
  if (!flowUrl || !flowKey) return;

  const accounts = getAccountBalances();
  const payload = {};
  for (const rule of FLOW_BALANCE_MAPPING) {
    const acc = accounts.find(a =>
      a.bank_id === rule.bankId &&
      (!rule.match || (a.corporate_name || '').includes(rule.match))
    );
    if (acc != null) payload[rule.flowKey] = acc.last_balance;
  }
  if (Object.keys(payload).length === 0) return;

  const res = await fetch(`${flowUrl}/api/bank-balances-push`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${flowKey}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`flow responded ${res.status}`);
  console.log('[flow-push] balances pushed:', payload);
}
import { checkAgainstPriority, priorityConfigured, fetchCashBanks, matchCashnameToAccount } from './priority/check.js';
import { dryRunPush } from './priority/push.js';
import { installAuth, requireRole } from './auth/index.js';
import {
  listStatus as listBankCredentialsStatus,
  setCredentials as setBankCredentials,
  resolveCredentialsForBank,
  bootstrapFromEnvIfEmpty as bootstrapBankCredsFromEnv,
} from './secrets/bank-creds.js';
import { vaultConfigured } from './secrets/vault.js';

// In-memory map of in-flight scraper sessions waiting on user input (SMS code, etc.).
const pendingInputs = new Map();
const PENDING_INPUT_TIMEOUT_MS = 5 * 60 * 1000;


for (const b of listBanks()) {
  upsertBank(b.id, b.nameHe);
}

if (vaultConfigured()) {
  const result = bootstrapBankCredsFromEnv(bankRegistry);
  if (!result.skipped) console.log(`[bank-creds] bootstrap imported ${result.imported} bank(s) from env`);
} else {
  console.warn('[bank-creds] BANK_VAULT_KEY not set — credentials read from env only (no DB vault)');
}

const PORT = Number(process.env.PORT) || 3030;
const REDIRECT_URI = process.env.AUTH_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

const app = express();
app.use(express.json());

installAuth(app, {
  appId: 'tact-bankaccount',
  dbPath: process.env.AUTH_DB_PATH || 'C:/Users/User/Aiprojects/env/auth.db',
  redirectUri: REDIRECT_URI,
  initialUsers: [],
});

app.use(express.static(path.resolve('public')));

app.get('/api/banks', (req, res) => {
  const dbBanks = listBanksWithAccounts();
  const registryById = Object.fromEntries(listBanks().map(b => [b.id, b]));
  const merged = dbBanks.map(b => ({
    ...b,
    has_scraper: !!registryById[b.id],
  }));
  res.json({ banks: merged });
});

app.get('/api/accounts/:id', (req, res) => {
  const acc = getAccount(Number(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  res.json({ account: acc });
});

app.get('/api/accounts/:id/transactions', (req, res) => {
  const accountId = Number(req.params.id);
  const acc = getAccount(accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const offset = Number(req.query.offset) || 0;
  const txns = getTransactions(accountId, { limit, offset });
  res.json({ account: acc, transactions: txns });
});

app.post('/api/banks/:bankId/sync', requireRole('approver'), async (req, res) => {
  const bankId = req.params.bankId;
  const daysBack = Math.min(Number(req.query.days) || 30, 365);

  let bank;
  try {
    bank = getBank(bankId);
  } catch {
    return res.status(404).json({ error: `Unknown bank: ${bankId}` });
  }

  const syncId = crypto.randomUUID();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const credentials = resolveCredentialsForBank(bankId, bankRegistry, req.user?.email || 'sync');
  const missing = Object.entries(credentials).filter(([_, v]) => !v).map(([k]) => k);
  if (missing.length) {
    send('error', { message: `Missing credentials for ${bankId} (set them in /bank-credentials.html or env): ${missing.join(', ')}` });
    return res.end();
  }

  // SMS / interactive input bridge: scraper calls onSmsRequired, server emits
  // an SSE event with the syncId, UI posts the code back to /api/sync/:syncId/sms-code,
  // and we resolve the pending promise so the scraper can continue.
  const onSmsRequired = ({ message } = {}) => {
    send('sms-required', { syncId, message: message || 'נדרש קוד SMS' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingInputs.get(syncId)?.resolve === resolve) pendingInputs.delete(syncId);
        reject(new Error('SMS code timeout (5 min)'));
      }, PENDING_INPUT_TIMEOUT_MS);
      pendingInputs.set(syncId, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  };

  req.on('close', () => {
    const p = pendingInputs.get(syncId);
    if (p) { pendingInputs.delete(syncId); p.reject(new Error('Client disconnected')); }
  });

  try {
    send('sync-started', { syncId, bankId, daysBack });
    send('progress', { step: 'start', message: `מתחיל סנכרון ${bank.info.nameHe} (${daysBack} ימים)` });

    const result = await bank.scrape({
      credentials,
      daysBack,
      onProgress: (p) => send('progress', p),
      onSmsRequired,
    });

    const inactiveSet = getInactiveMaskedNumbers(bankId);

    let totalNew = 0;
    let totalAll = 0;
    let skippedInactive = 0;
    const perAccount = [];
    for (const accResult of result.accounts) {
      const accountId = upsertAccount({
        bankId,
        accountIndex: accResult.account.accountIndex,
        maskedNumber: accResult.account.maskedNumber,
        corporateName: accResult.account.corporateName,
        iban: accResult.account.iban,
        balance: accResult.account.balance,
        branchId: accResult.account.branchId,
        branchName: accResult.account.branchName,
      });

      if (inactiveSet.has(accResult.account.maskedNumber)) {
        skippedInactive++;
        send('account-skipped', {
          maskedNumber: accResult.account.maskedNumber,
          corporateName: accResult.account.corporateName,
          reason: 'inactive',
        });
        continue;
      }

      const newHistory = insertTransactions(accountId, accResult.transactions.history, { status: 'completed' });
      const newPending = insertTransactions(accountId, accResult.transactions.pending, { status: 'pending' });
      const newCount = newHistory + newPending;
      const fetched = accResult.transactions.history.length + accResult.transactions.pending.length;

      updateLastSync(accountId, accResult.account.balance);

      totalNew += newCount;
      totalAll += fetched;
      perAccount.push({
        accountId,
        maskedNumber: accResult.account.maskedNumber,
        corporateName: accResult.account.corporateName,
        fetched,
        newSaved: newCount,
        dedupSkipped: fetched - newCount,
      });

      send('account-saved', {
        maskedNumber: accResult.account.maskedNumber,
        corporateName: accResult.account.corporateName,
        fetched,
        newSaved: newCount,
        dedupSkipped: fetched - newCount,
      });
    }

    send('done', {
      bankId,
      bankName: bank.info.nameHe,
      daysBack,
      fromDate: result.fromDate,
      toDate: result.toDate,
      accountsCount: result.accounts.length - skippedInactive,
      skippedInactive,
      totalFetched: totalAll,
      totalNewSaved: totalNew,
      totalDedupSkipped: totalAll - totalNew,
      perAccount,
    });
    pushBalancesToFlow().catch(e => console.error('[flow-push] failed:', e.message));
  } catch (err) {
    console.error('Sync error:', err);
    send('error', { message: err.message, stack: err.stack?.split('\n').slice(0, 5).join('\n') });
  } finally {
    res.end();
  }
});

// ─── Bank credentials (admin only) ──────────────────────────────────────
// Status only — never returns decrypted values.
app.get('/api/bank-credentials', requireRole('admin'), (req, res) => {
  const allBanks = listBanks();
  const status = listBankCredentialsStatus();
  const byId = new Map(status.map(s => [s.bank_id, s]));
  res.json({
    vault_configured: vaultConfigured(),
    banks: allBanks.map(b => {
      const s = byId.get(b.id);
      return {
        id: b.id,
        name_he: b.nameHe,
        is_set: s?.is_set === true,
        updated_at: s?.updated_at || null,
        updated_by: s?.updated_by || null,
      };
    }),
  });
});

app.post('/api/bank-credentials/:bankId', requireRole('admin'), (req, res) => {
  const bankId = req.params.bankId;
  if (!bankRegistry[bankId]) return res.status(404).json({ error: 'בנק לא ידוע' });
  if (!vaultConfigured()) return res.status(500).json({ error: 'BANK_VAULT_KEY לא מוגדר ב-env' });

  const username = (req.body?.username || '').trim() || null;
  const password = (req.body?.password || '').trim() || null;
  const loginUrl = (req.body?.loginUrl || '').trim() || null;

  if (!username && !password && !loginUrl) {
    return res.status(400).json({ error: 'יש למלא לפחות שדה אחד' });
  }
  try {
    setBankCredentials(bankId, { username, password, loginUrl }, req.user.email);
    res.json({ ok: true });
  } catch (e) {
    console.error('[bank-creds] save error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:id/check-priority', requireRole('approver'), async (req, res) => {
  const accountId = Number(req.params.id);
  if (!getAccount(accountId)) return res.status(404).json({ error: 'Account not found' });
  if (!priorityConfigured()) {
    return res.status(500).json({ error: 'Priority not configured in env (PRIORITY_URL_REAL/USERNAME/PASSWORD)' });
  }
  try {
    const ourTxns = getTransactionsForPriorityCheck(accountId);
    const result = await checkAgainstPriority(ourTxns);
    updatePriorityStatus(result.updates);
    res.json({
      ok: true,
      checked: result.ourTxnsChecked,
      matched: result.matched,
      notMatched: result.ourTxnsChecked - result.matched,
      priorityLinesScanned: result.priorityLinesChecked,
      dateRange: result.dateRange,
    });
  } catch (e) {
    console.error('Priority check error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:id/active', requireRole('approver'), (req, res) => {
  const accountId = Number(req.params.id);
  const isActive = req.body?.active !== false;
  if (!getAccount(accountId)) return res.status(404).json({ error: 'Account not found' });
  setAccountActive(accountId, isActive);
  res.json({ ok: true, active: isActive });
});

// User-input bridge for in-flight syncs (SMS codes, etc.). Same auth as sync itself.
app.post('/api/sync/:syncId/sms-code', requireRole('approver'), (req, res) => {
  const { syncId } = req.params;
  const code = (req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'קוד חסר' });
  const pending = pendingInputs.get(syncId);
  if (!pending) return res.status(404).json({ error: 'אין סנכרון פעיל שמחכה לקוד (אולי פג תוקף)' });
  pendingInputs.delete(syncId);
  pending.resolve(code);
  res.json({ ok: true });
});

// ─── Priority push (dry-run) ─────────────────────────────────────────────

// Auto-match all accounts to their Priority CASHNAME based on branch+account number.
// Saves the matches to DB and returns per-account results.
app.post('/api/priority/auto-match-cashnames', requireRole('approver'), async (req, res) => {
  if (!priorityConfigured()) {
    return res.status(500).json({ error: 'Priority not configured in env' });
  }
  try {
    const cashBanks = await fetchCashBanks();
    const banks = listBanksWithAccounts();
    const allAccounts = banks.flatMap(b => b.accounts.filter(a => a.is_active));

    const updates = [];
    const results = allAccounts.map(acc => {
      const cashname = matchCashnameToAccount(acc, cashBanks);
      if (cashname) updates.push({ accountId: acc.id, cashname });
      return {
        accountId: acc.id,
        maskedNumber: acc.masked_number,
        corporateName: acc.corporate_name,
        cashname,
        matched: !!cashname,
      };
    });

    if (updates.length) batchSetPriorityCashnames(updates);

    res.json({
      ok: true,
      matched: updates.length,
      unmatched: allAccounts.length - updates.length,
      results,
      cashBanksCount: cashBanks.length,
      // First record fields — lets us verify the exact Priority field names
      cashBanksSample: cashBanks[0] ? Object.keys(cashBanks[0]) : [],
    });
  } catch (e) {
    console.error('auto-match-cashnames error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/priority/cash-banks', requireRole('approver'), async (req, res) => {
  if (!priorityConfigured()) {
    return res.status(500).json({ error: 'Priority not configured in env' });
  }
  try {
    const banks = await fetchCashBanks();
    res.json({ banks });
  } catch (e) {
    console.error('fetchCashBanks error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/accounts/:id/priority-cashname', requireRole('approver'), (req, res) => {
  const accountId = Number(req.params.id);
  if (!getAccount(accountId)) return res.status(404).json({ error: 'Account not found' });
  const cashname = (req.body?.cashname || '').trim() || null;
  setAccountPriorityCashname(accountId, cashname);
  res.json({ ok: true, cashname });
});

app.post('/api/accounts/:id/push-to-priority', requireRole('approver'), async (req, res) => {
  const accountId = Number(req.params.id);
  const acc = getAccount(accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (!priorityConfigured()) {
    return res.status(500).json({ error: 'Priority not configured in env' });
  }
  if (!acc.priority_cashname) {
    return res.status(400).json({ error: 'לא הוגדר שם קופה בפריוריטי לחשבון זה' });
  }
  try {
    // Step 1: check which transactions exist in Priority (updates in_priority column)
    const allTxns = getTransactionsForPriorityCheck(accountId);
    const checkResult = await checkAgainstPriority(allTxns);
    updatePriorityStatus(checkResult.updates);

    // Step 2: collect transactions not found in Priority and not yet pushed
    const missing = getTransactionsForPush(accountId);

    // Step 3: build dry-run payload (no actual POST to Priority)
    const dry = dryRunPush(missing, acc.priority_cashname);

    res.json({
      ok: true,
      dryRun: true,
      accountId,
      cashName: acc.priority_cashname,
      checked: checkResult.ourTxnsChecked,
      matched: checkResult.matched,
      missing: missing.length,
      preview: dry.lines.slice(0, 50),
      previewTotal: dry.lines.length,
      bankBalance: acc.last_balance,
      dateRange: checkResult.dateRange,
    });
  } catch (e) {
    console.error('Push to Priority error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.resolve('public/index.html')));

app.listen(PORT, () => {
  console.log(`TACT BankAccount running at http://localhost:${PORT}`);
  console.log(`OAuth redirect URI: ${REDIRECT_URI}`);
});
