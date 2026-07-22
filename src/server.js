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
import { runBankSync } from './sync-service.js';
import {
  upsertBank,
  listBanksWithAccounts, getAccount, getTransactions,
  setAccountActive, setAccountShowOnHome,
  getTransactionsForPriorityCheck, updatePriorityStatus,
  setAccountPriorityCashname, setAccountCorporateName, getTransactionsForDate,
  getEndOfDayBalance, getLastBalanceBefore, getFirstTransactionDate, getTransactionDatesInRange,
  markTransactionsPushed, deleteTransaction,
  getLastPushedAt,
} from './db.js';
import { getLastCardPushedAt } from './credit-cards/db.js';
import { listFacilities } from './facilities/db.js';

import { pushBalancesToFlow } from './flow-push.js';
import { autoMatchCashnames, pushAccountToPriority } from './priority-service.js';
import { startDailyScheduler } from './scheduler.js';
import { checkAgainstPriority, priorityConfigured, fetchCashBanks, matchCashnameToAccount, fetchBankPages, fetchPriorityLines, shiftDate, findLastLoadedPage, pickBalanceField } from './priority/check.js';
import { pushToPriority, buildBankLinePayload } from './priority/push.js';
import { installAuth, requireRole } from './auth/index.js';
import {
  listStatus as listBankCredentialsStatus,
  addCredentials as addBankCredentials,
  updateCredentials as updateBankCredentials,
  deleteCredentials as deleteBankCredentials,
  bootstrapFromEnvIfEmpty as bootstrapBankCredsFromEnv,
} from './secrets/bank-creds.js';
import { vaultConfigured } from './secrets/vault.js';
import creditCardsRouter from './credit-cards/routes.js';

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

// no-cache (not no-store): browsers still keep a local copy but must
// revalidate with the server on every load, so a deploy that changes app.js
// is picked up immediately instead of silently serving a stale cached copy
// of the header/nav until a hard refresh.
app.use(express.static(path.resolve('public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
app.use(creditCardsRouter);

app.get('/api/banks', (req, res) => {
  const dbBanks = listBanksWithAccounts();
  const registryById = Object.fromEntries(listBanks().map(b => [b.id, b]));
  const merged = dbBanks.map(b => ({
    ...b,
    has_scraper: !!registryById[b.id],
  }));
  res.json({ banks: merged });
});

app.get('/api/facilities', (req, res) => {
  const all = listFacilities();
  res.json({
    deposits: all.filter(f => f.category === 'deposit'),
    loans: all.filter(f => f.category === 'loan'),
    guarantees: all.filter(f => f.category === 'guarantee'),
  });
});

app.get('/api/priority/last-push', (req, res) => {
  const candidates = [getLastPushedAt(), getLastCardPushedAt()].filter(Boolean);
  const lastPushedAt = candidates.length ? candidates.sort().at(-1) : null;
  res.json({ lastPushedAt });
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

  try {
    getBank(bankId);
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
    const result = await runBankSync(bankId, {
      daysBack,
      actor: req.user?.email || 'sync',
      onEvent: send,
      onSmsRequired,
    });
    send('done', result);
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
  const byBankId = {};
  for (const s of status) {
    if (!byBankId[s.bank_id]) byBankId[s.bank_id] = [];
    byBankId[s.bank_id].push(s);
  }
  res.json({
    vault_configured: vaultConfigured(),
    banks: allBanks.map(b => ({
      id: b.id,
      name_he: b.nameHe,
      credentials: (byBankId[b.id] || []).map(s => ({
        id: s.id,
        label: s.label,
        is_set: s.is_set === true,
        updated_at: s.updated_at || null,
        updated_by: s.updated_by || null,
      })),
    })),
  });
});

// Add a new credential set for a bank
app.post('/api/bank-credentials/:bankId', requireRole('admin'), (req, res) => {
  const bankId = req.params.bankId;
  if (!bankRegistry[bankId]) return res.status(404).json({ error: 'בנק לא ידוע' });
  if (!vaultConfigured()) return res.status(500).json({ error: 'BANK_VAULT_KEY לא מוגדר ב-env' });

  const label    = (req.body?.label    || '').trim() || 'ראשי';
  const username = (req.body?.username || '').trim() || null;
  const password = (req.body?.password || '').trim() || null;
  const loginUrl = (req.body?.loginUrl || '').trim() || null;

  try {
    addBankCredentials(bankId, { label, username, password, loginUrl }, req.user.email);
    res.json({ ok: true });
  } catch (e) {
    console.error('[bank-creds] add error:', e);
    res.status(400).json({ error: e.message });
  }
});

// Update an existing credential set
app.put('/api/bank-credentials/:bankId/:credId', requireRole('admin'), (req, res) => {
  const { bankId, credId } = req.params;
  if (!bankRegistry[bankId]) return res.status(404).json({ error: 'בנק לא ידוע' });
  if (!vaultConfigured()) return res.status(500).json({ error: 'BANK_VAULT_KEY לא מוגדר ב-env' });

  const label    = (req.body?.label    || '').trim() || null;
  const username = (req.body?.username || '').trim() || null;
  const password = (req.body?.password || '').trim() || null;
  const loginUrl = (req.body?.loginUrl || '').trim() || null;

  if (!label && !username && !password && !loginUrl) {
    return res.status(400).json({ error: 'יש למלא לפחות שדה אחד' });
  }
  try {
    updateBankCredentials(bankId, credId, { label, username, password, loginUrl }, req.user.email);
    res.json({ ok: true });
  } catch (e) {
    console.error('[bank-creds] update error:', e);
    res.status(400).json({ error: e.message });
  }
});

// Delete a credential set
app.delete('/api/bank-credentials/:bankId/:credId', requireRole('admin'), (req, res) => {
  const { bankId, credId } = req.params;
  if (!bankRegistry[bankId]) return res.status(404).json({ error: 'בנק לא ידוע' });
  try {
    deleteBankCredentials(bankId, credId, req.user.email);
    res.json({ ok: true });
  } catch (e) {
    console.error('[bank-creds] delete error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:id/check-priority', requireRole('approver'), async (req, res) => {
  const accountId = Number(req.params.id);
  const acc = getAccount(accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (!priorityConfigured()) {
    return res.status(500).json({ error: 'Priority not configured in env (PRIORITY_URL_REAL/USERNAME/PASSWORD)' });
  }
  try {
    const ourTxns = getTransactionsForPriorityCheck(accountId);
    const result = await checkAgainstPriority(ourTxns, acc.priority_cashname || null);
    updatePriorityStatus(result.updates);
    res.json({
      ok: true,
      checked: result.ourTxnsChecked,
      matched: result.matched,
      notMatched: result.ourTxnsChecked - result.matched,
      priorityLinesScanned: result.priorityLinesChecked,
      dateRange: result.dateRange,
      fenceDate: result.fenceDate || null,
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

app.post('/api/accounts/:id/show-on-home', requireRole('approver'), (req, res) => {
  const accountId = Number(req.params.id);
  const show = req.body?.show !== false;
  if (!getAccount(accountId)) return res.status(404).json({ error: 'Account not found' });
  setAccountShowOnHome(accountId, show);
  res.json({ ok: true, show });
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
  try {
    res.json(await autoMatchCashnames());
  } catch (e) {
    console.error('auto-match-cashnames error:', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Inspect BANKPAGES fields for a given account — used to discover available balance fields.
// Returns up to 3 recent BANKPAGES entries with all their raw fields.
app.get('/api/accounts/:id/priority-bankpages-sample', requireRole('approver'), async (req, res) => {
  const accountId = Number(req.params.id);
  const acc = getAccount(accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (!acc.priority_cashname) return res.status(400).json({ error: 'No priority_cashname set for this account' });
  if (!priorityConfigured()) return res.status(500).json({ error: 'Priority not configured' });
  try {
    const toDate = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    const pages = await fetchBankPages(fromDate, toDate, acc.priority_cashname);
    res.json({
      cashName: acc.priority_cashname,
      count: pages.length,
      fieldNames: pages[0] ? Object.keys(pages[0]).filter(k => !k.startsWith('@')) : [],
      sample: pages.slice(0, 3),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnostic: show what Priority BANKLINESA has for this account around a specific date.
// Query: GET /api/accounts/:id/priority-lines-debug?date=2026-06-26&days=2
app.get('/api/accounts/:id/priority-lines-debug', requireRole('approver'), async (req, res) => {
  const accountId = Number(req.params.id);
  const acc = getAccount(accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (!acc.priority_cashname) return res.status(400).json({ error: 'No priority_cashname set' });
  if (!priorityConfigured()) return res.status(500).json({ error: 'Priority not configured' });
  const pivotDate = req.query.date || new Date().toISOString().slice(0, 10);
  const days = Math.min(Number(req.query.days) || 3, 14);
  const fromDate = shiftDate(pivotDate, -days);
  const toDate   = shiftDate(pivotDate, +days);
  try {
    const lines = await fetchPriorityLines(fromDate, toDate, acc.priority_cashname);
    const byDate = {};
    for (const l of lines) {
      const d = (l.CURDATE || '').slice(0, 10);
      if (!byDate[d]) byDate[d] = [];
      const credit = Number(l.CREDIT || 0);
      const debit  = Number(l.DEBIT  || 0);
      byDate[d].push({ amount: credit > 0 ? credit : -Math.abs(debit), bankpage: l.BANKPAGE, kline: l.KLINE });
    }
    res.json({ cashName: acc.priority_cashname, fromDate, toDate, totalLines: lines.length, byDate });
  } catch (e) {
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

app.put('/api/accounts/:id/corporate-name', requireRole('approver'), (req, res) => {
  const accountId = Number(req.params.id);
  if (!getAccount(accountId)) return res.status(404).json({ error: 'Account not found' });
  const corporateName = (req.body?.corporateName || '').trim() || null;
  setAccountCorporateName(accountId, corporateName);
  res.json({ ok: true, corporateName });
});

app.post('/api/accounts/:id/push-to-priority', requireRole('approver'), async (req, res) => {
  const accountId = Number(req.params.id);
  const isPreview = req.query.preview === 'true';
  try {
    res.json(await pushAccountToPriority(accountId, { preview: isPreview }));
  } catch (e) {
    console.error('Push to Priority error:', e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Force-push all transactions for a specific date, bypassing Priority matching.
// Use when matching incorrectly marks transactions as "already in Priority".
// POST /api/accounts/:id/force-push-date?date=2026-06-26
app.post('/api/accounts/:id/force-push-date', requireRole('approver'), async (req, res) => {
  const accountId = Number(req.params.id);
  const date = (req.query.date || '').slice(0, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'נדרש פרמטר date בפורמט YYYY-MM-DD' });
  }
  const acc = getAccount(accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (!acc.priority_cashname) return res.status(400).json({ error: 'לא הוגדר שם קופה' });
  if (!priorityConfigured()) return res.status(500).json({ error: 'Priority not configured' });

  try {
    const txns = getTransactionsForDate(accountId, date);
    if (!txns.length) return res.json({ ok: true, pushed: 0, message: 'אין תנועות לתאריך זה' });

    const { pushed, failed } = await pushToPriority(txns, acc.priority_cashname, acc.bank_id);
    if (pushed.length > 0) markTransactionsPushed(pushed);

    // Balance verification: compare Priority's end-of-day balance with ours
    let balanceCheck = null;
    const ourBalRow = getEndOfDayBalance(accountId, date);
    if (ourBalRow) {
      try {
        const pages = await fetchBankPages(date, date, acc.priority_cashname);
        if (pages.length > 0) {
          const sample = pages[0];
          const candidates = Object.keys(sample).filter(k => /BAL/i.test(k) && sample[k] != null);
          const balField = candidates.find(k => /CLS|CLOSE|END/i.test(k))
            || candidates.find(k => /OP|OPEN|START/i.test(k))
            || candidates[0] || null;
          if (balField) {
            const priorityBal = Number(pages[0][balField]);
            const ourBal = ourBalRow.running_balance;
            const diff = Math.abs(priorityBal - ourBal);
            balanceCheck = { ourBalance: ourBal, priorityBalance: priorityBal, diff, match: diff < 0.01, field: balField };
          } else {
            balanceCheck = { error: `BANKPAGES נמצא אך ללא שדה יתרה. שדות: ${Object.keys(sample).join(', ')}` };
          }
        } else {
          balanceCheck = { error: 'BANKPAGES לא נמצא עבור תאריך זה בפריוריטי' };
        }
      } catch (e) {
        balanceCheck = { error: `שגיאה בשליפת BANKPAGES: ${e.message}` };
      }
    }

    res.json({
      ok: true,
      date,
      total: txns.length,
      pushed: pushed.length,
      failed: failed.length,
      failedDetails: failed.slice(0, 10),
      balanceCheck,
    });
  } catch (e) {
    console.error('force-push-date error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Deterministic day-by-day reconciliation, separate from push-to-priority's fuzzy
// amount/day matching. Anchors on the last BANKPAGES already loaded in Priority by
// comparing its OPENING balance (unaffected by that day's own line-entry errors)
// against our balance just before that date. Only once that anchor is confirmed
// does it push subsequent days one at a time, verifying each day's closing balance
// before moving to the next — stopping at the first push failure or balance mismatch
// rather than pushing blindly ahead.
// POST /api/accounts/:id/reconcile-priority?preview=true
app.post('/api/accounts/:id/reconcile-priority', requireRole('approver'), async (req, res) => {
  const accountId = Number(req.params.id);
  const isPreview = req.query.preview === 'true';
  let acc = getAccount(accountId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (!priorityConfigured()) {
    return res.status(500).json({ error: 'Priority not configured in env' });
  }
  if (!acc.priority_cashname) {
    try {
      const cashBanks = await fetchCashBanks();
      const discovered = matchCashnameToAccount(acc, cashBanks);
      if (discovered) {
        setAccountPriorityCashname(accountId, discovered);
        acc = { ...acc, priority_cashname: discovered };
      }
    } catch {}
    if (!acc.priority_cashname) {
      return res.status(400).json({ error: 'לא הוגדר שם קופה בפריוריטי לחשבון זה' });
    }
  }

  const cashName = acc.priority_cashname;
  try {
    // ── Step 1: anchor on the last BANKPAGES already loaded ──────────────
    let anchor;
    let fromDate;
    const lastPage = await findLastLoadedPage(cashName);
    if (!lastPage) {
      fromDate = getFirstTransactionDate(accountId);
      anchor = { skipped: true, reason: 'no BANKPAGES found for this cashName yet' };
      if (!fromDate) {
        return res.json({ ok: true, cashName, anchor, results: [], message: 'אין תנועות מקומיות לקליטה' });
      }
    } else {
      const lastLoadedDate = (lastPage.CURDATE || '').slice(0, 10);
      const openField = pickBalanceField(lastPage, 'open');
      if (!openField) {
        return res.json({
          ok: false, cashName, stage: 'anchor-field-missing', lastLoadedDate,
          availableFields: Object.keys(lastPage).filter(k => !k.startsWith('@')),
        });
      }
      // Balance as of the most recent transaction before the last loaded page —
      // NOT necessarily the calendar day before (gaps of several days with no
      // activity are normal; anchoring on a fixed "date - 1" silently fails then).
      const ourPrevBal = getLastBalanceBefore(accountId, lastLoadedDate);
      if (!ourPrevBal) {
        return res.json({ ok: false, cashName, stage: 'anchor-no-local-data', lastLoadedDate });
      }
      const priorityOpenBalance = Number(lastPage[openField]);
      const ourBalance = ourPrevBal.running_balance;
      const ourBalanceDate = ourPrevBal.date;
      const diff = Math.abs(priorityOpenBalance - ourBalance);
      if (diff >= 0.01) {
        return res.json({
          ok: false, cashName, stage: 'anchor-mismatch', lastLoadedDate, ourBalanceDate,
          priorityOpenBalance, ourBalance, diff,
        });
      }
      anchor = { skipped: false, lastLoadedDate, ourBalanceDate, priorityOpenBalance, ourBalance, matched: true };
      fromDate = shiftDate(lastLoadedDate, 1);
    }

    // ── Step 2: determine which local dates need pushing (today is never pushed) ─
    const toDate = shiftDate(new Date().toISOString().slice(0, 10), -1);
    const dates = fromDate <= toDate ? getTransactionDatesInRange(accountId, fromDate, toDate) : [];
    if (!dates.length) {
      return res.json({ ok: true, cashName, anchor, results: [], message: 'הכל עדכני — אין ימים חדשים לקליטה' });
    }

    // ── Step 3: push day-by-day, verifying closing balance before advancing ──
    const results = [];
    let stoppedAt = null;
    let stoppedReason = null;
    for (const date of dates) {
      const txns = getTransactionsForDate(accountId, date);

      if (isPreview) {
        results.push({ date, total: txns.length, preview: txns.map(t => buildBankLinePayload(t, acc.bank_id)) });
        continue;
      }

      const { pushed, failed } = await pushToPriority(txns, cashName, acc.bank_id);
      if (pushed.length > 0) markTransactionsPushed(pushed);

      let balanceCheck = null;
      try {
        const pages = await fetchBankPages(date, date, cashName);
        if (pages.length > 0) {
          const closeField = pickBalanceField(pages[0], 'close');
          const ourBalRow = getEndOfDayBalance(accountId, date);
          if (closeField && ourBalRow) {
            const priorityBalance = Number(pages[0][closeField]);
            const ourBalance = ourBalRow.running_balance;
            const diff = Math.abs(priorityBalance - ourBalance);
            balanceCheck = { ourBalance, priorityBalance, diff, match: diff < 0.01 };
          } else {
            balanceCheck = { error: !closeField ? 'לא נמצא שדה יתרת סגירה' : 'אין יתרה מקומית לתאריך זה' };
          }
        } else {
          balanceCheck = { error: 'BANKPAGES לא נמצא עבור תאריך זה בפריוריטי' };
        }
      } catch (e) {
        balanceCheck = { error: e.message };
      }

      results.push({
        date, total: txns.length, pushed: pushed.length, failed: failed.length,
        failedDetails: failed.slice(0, 10), balanceCheck,
      });

      if (failed.length > 0) {
        stoppedAt = date;
        stoppedReason = 'push-failed';
        break;
      }
      if (balanceCheck?.match === false || balanceCheck?.error) {
        stoppedAt = date;
        stoppedReason = balanceCheck.error ? 'balance-unverified' : 'balance-mismatch';
        break;
      }
    }

    res.json({ ok: !stoppedAt, dryRun: isPreview, cashName, anchor, results, stoppedAt, stoppedReason });
  } catch (e) {
    console.error('reconcile-priority error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.resolve('public/index.html')));

app.delete('/api/transactions/:id', requireRole('approver'), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const changed = deleteTransaction(id);
  if (!changed) return res.status(404).json({ error: 'Transaction not found' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`TACT BankAccount running at http://localhost:${PORT}`);
  console.log(`OAuth redirect URI: ${REDIRECT_URI}`);
});

startDailyScheduler();
