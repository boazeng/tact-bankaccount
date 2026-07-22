import puppeteer from 'puppeteer';
import { fetchLeumiLoansForAccount } from '../facilities/fetchers/leumi.js';

const ACCOUNTS_URL_FRAG = '/available-accounts/ils';
const TXN_DEFAULT_FRAG = '/transactions/default';

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));

// Leumi's transactions endpoint caps how many rows it returns per request and
// signals truncation via additionalTransactionsFlag instead of paginating —
// so a wide date range on a busy account silently drops the older rows in it.
// When that happens, bisect the range and re-fetch each half until either the
// flag clears or we're down to a single day (can't split further).
const MIN_WINDOW_DAYS = 1;

function splitRange(fromStr, toStr) {
  const fromD = parseYmd(fromStr);
  const toD = parseYmd(toStr);
  const midD = new Date(fromD.getTime() + Math.floor((toD - fromD) / 2));
  const nextD = new Date(midD);
  nextD.setDate(nextD.getDate() + 1);
  return { leftTo: ymd(midD), rightFrom: ymd(nextD) };
}

async function fetchLeumiHistory(page, idx, from, to, tplHeaders) {
  return page.evaluate(async (idx, from, to, tplHeaders) => {
    const headers = { ...tplHeaders };
    if (headers['x-message-id']) headers['x-message-id'] = crypto.randomUUID();
    if (headers['x-transaction-id']) headers['x-transaction-id'] = crypto.randomUUID();
    const r = await fetch(
      `/v1/corp/ui-corp-transactions/transactionsbydates/digitalfront/accounts/${idx}/transactions/bydates?periodType=1&fromDate=${from}&toDate=${to}`,
      { credentials: 'include', headers },
    );
    return { status: r.status, body: r.ok ? await r.json() : await r.text() };
  }, idx, from, to, tplHeaders);
}

async function fetchAllHistory(page, idx, fromStr, toStr, tplHeaders, onProgress, topResp) {
  const resp = topResp ?? await fetchLeumiHistory(page, idx, fromStr, toStr, tplHeaders);
  if (resp.status !== 200) return { status: resp.status, history: [], flagged: false, body: resp.body };
  const body = resp.body;
  const history = body.historyILSTrxItems ?? [];
  const flagged = body.additionalTransactionsFlag === true;
  const spanDays = Math.round((parseYmd(toStr) - parseYmd(fromStr)) / 86_400_000) + 1;
  if (!flagged || spanDays <= MIN_WINDOW_DAYS) {
    return { status: 200, history, flagged, body };
  }
  const { leftTo, rightFrom } = splitRange(fromStr, toStr);
  onProgress({ step: 'pagination-split', message: `יותר תנועות מהצפוי בטווח ${fromStr}–${toStr} — מפצל לשתי בקשות` });
  const left = await fetchAllHistory(page, idx, fromStr, leftTo, tplHeaders, onProgress);
  const right = await fetchAllHistory(page, idx, rightFrom, toStr, tplHeaders, onProgress);
  return { status: 200, history: [...left.history, ...right.history], flagged: left.flagged || right.flagged, body };
}

export async function scrapeLeumi({ credentials, daysBack = 30, showBrowser = false, onProgress = () => {} }) {
  const { username, password, loginUrl } = credentials;
  if (!username || !password || !loginUrl) {
    throw new Error('scrapeLeumi: missing username/password/loginUrl');
  }

  const today = new Date();
  const fromDate = new Date();
  fromDate.setDate(today.getDate() - daysBack);
  const fromStr = ymd(fromDate);
  const toStr = ymd(today);

  onProgress({ step: 'launch', message: 'מפעיל דפדפן…' });
  const browser = await puppeteer.launch({
    headless: !showBrowser,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    let txnRequestHeaders = null;
    let accountsResponse = null;

    page.on('request', (req) => {
      if (req.url().includes(TXN_DEFAULT_FRAG) && !txnRequestHeaders) {
        txnRequestHeaders = req.headers();
      }
    });
    page.on('response', async (res) => {
      if (res.status() !== 200) return;
      try {
        if (res.url().includes(ACCOUNTS_URL_FRAG)) {
          accountsResponse = await res.json();
        }
      } catch {}
    });

    onProgress({ step: 'login', message: 'מתחבר לבנק…' });
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForSelector('input[placeholder="שם משתמש"]', { timeout: 30_000 });
    await page.type('input[placeholder="שם משתמש"]', username, { delay: 30 });
    await page.type('input[placeholder="סיסמה"]', password, { delay: 30 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => (b.textContent || '').includes('כניסה') && !b.disabled);
      if (!btn) throw new Error('Login button not found');
      btn.click();
    });

    await page.waitForFunction(() => location.href.includes('/digitalfront/'), { timeout: 60_000 });
    onProgress({ step: 'init-session', message: 'טוען עמוד תנועות לאתחול הסשן…' });
    await page.goto(
      'https://hb2.bankleumi.co.il/staticcontent/digitalfront/he/nis-accounts/nis-transactions/?accountIndex=1',
      { waitUntil: 'networkidle2', timeout: 60_000 },
    );
    await new Promise(r => setTimeout(r, 5_000));

    if (!accountsResponse) throw new Error('Failed to capture accounts list from Leumi');
    if (!txnRequestHeaders) throw new Error('Failed to capture SPA request headers from Leumi');

    const accountsItems = accountsResponse.accountsItems ?? [];
    onProgress({ step: 'accounts-found', message: `נמצאו ${accountsItems.length} חשבונות`, count: accountsItems.length });

    const templateHeaders = { ...txnRequestHeaders };
    for (const h of ['cookie', 'host', ':authority', ':method', ':path', ':scheme']) delete templateHeaders[h];

    const results = [];
    for (const acc of accountsItems) {
      onProgress({
        step: 'fetching-account',
        message: `מוריד תנועות מחשבון ${acc.maskedClientNumber} (${acc.corporateName.trim()})`,
        account: acc.maskedClientNumber,
      });

      const resp = await fetchLeumiHistory(page, acc.accountIndex, fromStr, toStr, templateHeaders);

      if (resp.status !== 200) {
        onProgress({ step: 'account-error', message: `שגיאה בחשבון ${acc.maskedClientNumber}: HTTP ${resp.status}`, account: acc.maskedClientNumber });
        continue;
      }

      const body = resp.body;
      const pending = body.todayILSTrxItems ?? body.pendingILSTrxItems ?? [];
      const { history, flagged } = await fetchAllHistory(page, acc.accountIndex, fromStr, toStr, templateHeaders, onProgress, resp);
      if (flagged) {
        onProgress({
          step: 'pagination-incomplete',
          message: `⚠ ${acc.maskedClientNumber}: ייתכן שעדיין חסרות תנועות — יום בודד חורג ממגבלת הבנק`,
          account: acc.maskedClientNumber,
        });
      }

      // masked_number for Leumi is "855-11200/06" → branch 855
      const branchId = (acc.maskedClientNumber || '').split('-')[0] || null;

      let loans = [];
      try {
        loans = await fetchLeumiLoansForAccount(page, acc.accountIndex, templateHeaders);
      } catch (e) {
        onProgress({ step: 'facilities-error', message: `שגיאה בשליפת הלוואות מחשבון ${acc.maskedClientNumber}: ${e.message}`, account: acc.maskedClientNumber });
      }

      results.push({
        account: {
          accountIndex: acc.accountIndex,
          maskedNumber: acc.maskedClientNumber,
          corporateName: acc.corporateName.trim(),
          balance: acc.balanceIncludingToday,
          iban: body.iban,
          branchId: branchId && /^\d+$/.test(branchId) ? branchId : null,
          branchName: null,
        },
        transactions: { history, pending },
        additionalTransactionsFlag: flagged,
        facilities: { deposits: [], loans, guarantees: [] },
      });

      onProgress({
        step: 'account-done',
        message: `${acc.maskedClientNumber}: ${history.length} תנועות + ${pending.length} ממתינות`,
        account: acc.maskedClientNumber,
        count: history.length + pending.length,
      });
    }

    onProgress({ step: 'done', message: `סיום: ${results.length} חשבונות`, total: results.length });
    return { fromDate: fromStr, toDate: toStr, accounts: results };
  } finally {
    await browser.close();
  }
}

export const bankInfo = {
  id: 'leumi',
  nameHe: 'בנק לאומי',
};
