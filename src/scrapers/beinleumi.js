// FIBI (בנק הבינלאומי) business scraper — fibi.co.il/business + online.fibi.co.il.
//
// Flow:
//   1. Navigate to the public marketing site, open the login modal
//      (a.login-trigger → Bootstrap modal → MatafLoginServlet iframe).
//   2. Fill #username/#password inside that iframe, click #continueBtn.
//   3. Wait for redirect to online.fibi.co.il (the Angular "PortalNG" shell).
//   4. The shell's own client-side routing (clicking "ניהול חשבון" → the
//      newly-revealed "תנועות בחשבון" item) is required to make the app
//      acquire a scoped bearer token for the bff-balancetransactions API —
//      a raw page.goto() to the deep-link route or a synthetic hash change
//      does NOT trigger that token exchange and gets a 401. So we drive a
//      real click sequence and intercept the resulting request's headers
//      (which include the bearer token), then reuse those headers — with a
//      fresh x-fibi-transaction-id — to fetch the actual desired date range.
import puppeteer from 'puppeteer';

const ymdIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const STRIP_HEADERS = [
  'cookie', 'host', ':authority', ':method', ':path', ':scheme', 'content-length',
  'origin', 'referer', 'connection', 'accept-encoding', 'user-agent',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
];

async function loginToFibi(page, loginUrl, userId, password, onProgress) {
  onProgress({ step: 'login', message: 'מתחבר לבנק…' });
  await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60_000 });

  await page.evaluate(() => {
    const btn = document.querySelector('#cookie_box_close');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 500));

  await page.evaluate(() => {
    const el = document.querySelector('a.login-trigger');
    if (el) el.click();
  });

  let loginFrame = null;
  const frameWaitStart = Date.now();
  while (!loginFrame && Date.now() - frameWaitStart < 20_000) {
    loginFrame = page.frames().find(f => /MatafLoginServlet/.test(f.url()));
    if (!loginFrame) await new Promise(r => setTimeout(r, 500));
  }
  if (!loginFrame) throw new Error('scrapeBeinleumi: login form iframe not found');

  await loginFrame.waitForSelector('#username', { timeout: 20_000 });
  await loginFrame.evaluate((uid, pwd) => {
    const setVal = (input, val) => {
      const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      native.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(document.querySelector('#username'), uid);
    setVal(document.querySelector('#password'), pwd);
  }, userId, password);

  await loginFrame.evaluate(() => {
    const btn = document.querySelector('#continueBtn');
    if (!btn) throw new Error('Login button not found');
    btn.click();
  });

  await page.waitForFunction(() => location.href.includes('online.fibi.co.il'), { timeout: 60_000 });
  onProgress({ step: 'init-session', message: 'טוען את מסך הבית…' });
  await new Promise(r => setTimeout(r, 6_000));
}

// Drives the real "ניהול חשבון" → "תנועות בחשבון" click sequence so the app
// runs its own token-bootstrap for the balance-transactions module. There
// are TWO DOM elements with the exact text "תנועות בחשבון" — an older
// quick-links shortcut (present before the click) and the real nav item
// (revealed only after opening the "ניהול חשבון" dropdown) — so we diff
// before/after to find the freshly-revealed one.
async function navigateToTransactions(page, onProgress) {
  onProgress({ step: 'navigate', message: 'עובר למסך תנועות בחשבון…' });

  const beforeHtml = await page.evaluate(() =>
    Array.from(document.querySelectorAll('*'))
      .filter(e => e.children.length === 0 && /^תנועות בחשבון$/.test((e.textContent || '').trim()))
      .map(e => e.outerHTML));

  const openedNav = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*'))
      .find(e => e.children.length === 0 && /^ניהול חשבון$/.test((e.textContent || '').trim()));
    if (el) { el.click(); return true; }
    return false;
  });
  if (!openedNav) throw new Error('scrapeBeinleumi: "ניהול חשבון" nav item not found');
  await new Promise(r => setTimeout(r, 2_000));

  const clicked = await page.evaluate((beforeHtml) => {
    const els = Array.from(document.querySelectorAll('*'))
      .filter(e => e.children.length === 0 && /^תנועות בחשבון$/.test((e.textContent || '').trim()));
    const fresh = els.find(e => !beforeHtml.includes(e.outerHTML));
    const target = fresh || els[0];
    if (target) { target.click(); return true; }
    return false;
  }, beforeHtml);
  if (!clicked) throw new Error('scrapeBeinleumi: "תנועות בחשבון" nav item not found');

  await page.waitForFunction(() => location.hash.includes('accountTransactions'), { timeout: 30_000 });
}

async function fetchJson(page, url) {
  return page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    return { status: r.status, body: r.ok ? await r.json() : null };
  }, url);
}

async function fetchTransactionsList(page, templateHeaders, accountNumber, accountType, branch, fromStr, toStr) {
  return page.evaluate(async (templateHeaders, accountNumber, accountType, branch, fromStr, toStr) => {
    const headers = { ...templateHeaders, 'x-fibi-transaction-id': crypto.randomUUID(), 'content-type': 'application/json' };
    const r = await fetch('/appsng/bff-balancetransactions/api/v1/transactions/list', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        initialRequest: { accountNumber, accountType, branch, startDate: fromStr, endDate: toStr, order: 1, language: 'HEB' },
      }),
    });
    return { status: r.status, body: r.ok ? await r.json() : await r.text() };
  }, templateHeaders, accountNumber, accountType, branch, fromStr, toStr);
}

// closingBalance is only populated by FIBI on the LAST transaction of each
// calendar day (days with several transactions show 0 on the others) — same
// per-day-only balance limitation as Mizrachi's plain-text parse.
function mapTransactions(rawTransactions) {
  const seenKeys = new Map();
  return rawTransactions.map((t) => {
    const date = (t.dateOfRegistration || '').slice(0, 10);
    const effectiveDate = (t.dateOfBusinessDay || '').slice(0, 10);
    const amount = Number(t.creditAmount || 0) - Number(t.debitAmount || 0);
    const description = (t.description || t.Name || '').trim();
    const extendedDescription = (t.Name && t.Name.trim() && t.Name.trim() !== description) ? t.Name.trim() : null;
    const refPart = t.documentNum || t.reference || 0;

    const baseKey = `${date}-${refPart}-${amount}-${description}`;
    const occurrence = (seenKeys.get(baseKey) ?? 0) + 1;
    seenKeys.set(baseKey, occurrence);

    return {
      transactionID: `${baseKey}-${occurrence}`,
      date,
      effectiveDate,
      description,
      extendedDescription,
      amount,
      runningBalance: t.lastTransactionOfDay ? t.closingBalance : null,
      beneficiaryName: t.CustomerName || null,
      beneficiaryBankCode: t.CorrespondentBank || null,
      beneficiaryBranch: t.CorrespondentBranch || null,
      beneficiaryAccountNumber: t.CorrespondentAccount || null,
      referenceNumber: refPart ? String(refPart) : null,
    };
  });
}

export async function scrapeBeinleumi({ credentials, daysBack = 30, showBrowser = false, onProgress = () => {} }) {
  const { userId, password, loginUrl } = credentials;
  if (!userId || !password) {
    throw new Error('scrapeBeinleumi: missing userId/password');
  }
  const HOME_URL = loginUrl || 'https://www.fibi.co.il/business/';

  const today = new Date();
  const fromDate = new Date();
  fromDate.setDate(today.getDate() - daysBack);
  const fromStr = ymdIso(fromDate);
  const toStr = ymdIso(today);

  onProgress({ step: 'launch', message: 'מפעיל דפדפן…' });
  const browser = await puppeteer.launch({
    headless: !showBrowser,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    let templateHeaders = null;
    page.on('request', (req) => {
      if (req.url().includes('/transactions/list') && !templateHeaders) {
        templateHeaders = req.headers();
      }
    });

    await loginToFibi(page, HOME_URL, userId, password, onProgress);
    await navigateToTransactions(page, onProgress);

    const headerWaitStart = Date.now();
    while (!templateHeaders && Date.now() - headerWaitStart < 20_000) {
      await new Promise(r => setTimeout(r, 300));
    }
    if (!templateHeaders) throw new Error('scrapeBeinleumi: failed to capture auth headers from transactions request');
    for (const h of STRIP_HEADERS) delete templateHeaders[h];

    onProgress({ step: 'accounts-lookup', message: 'טוען רשימת חשבונות…' });
    const userDataResp = await fetchJson(page, `/MatafAngularRestApiService/rest/utils/userData?uid=${cryptoRandomUUID()}`);
    const accounts = userDataResp.body?.accounts ?? [];
    onProgress({ step: 'accounts-found', message: `נמצאו ${accounts.length} חשבונות`, count: accounts.length });

    const accountTypesResp = await fetchJson(page, `/appsng/bff-balancetransactions/api/v1/transactions/accountType?uid=${cryptoRandomUUID()}`);
    const accountTypes = accountTypesResp.body?.accountType ?? [];
    const primaryType = accountTypes[0];
    if (!primaryType) throw new Error('scrapeBeinleumi: no account type returned');

    const results = [];
    for (const acc of accounts) {
      const accountNumber = Number(acc.account);
      const branch = acc.branch;
      const maskedNumber = `${branch}-${acc.account}`;
      const corporateName = (acc.name || '').trim() || maskedNumber;

      onProgress({ step: 'fetching-account', message: `מוריד תנועות מחשבון ${maskedNumber}`, account: maskedNumber });

      const balResp = await fetchJson(page, `/appsng/bff-balancetransactions/api/v1/transactions/balances/${primaryType.accountType}?uid=${cryptoRandomUUID()}`);
      const listResp = await fetchTransactionsList(page, templateHeaders, accountNumber, primaryType.accountType, branch, fromStr, toStr);

      if (listResp.status !== 200 || !listResp.body?.transactions) {
        onProgress({ step: 'account-error', message: `שגיאה בחשבון ${maskedNumber}: HTTP ${listResp.status}`, account: maskedNumber });
        continue;
      }

      const transactions = mapTransactions(listResp.body.transactions);

      results.push({
        account: {
          accountIndex: accountNumber,
          maskedNumber,
          corporateName,
          balance: balResp.body?.currentBalance ?? null,
          iban: null,
          branchId: branch,
          branchName: null,
        },
        transactions: { history: transactions, pending: [] },
        additionalTransactionsFlag: false,
      });

      onProgress({ step: 'account-done', message: `${maskedNumber}: ${transactions.length} תנועות`, account: maskedNumber, count: transactions.length });
    }

    onProgress({ step: 'done', message: `סיום: ${results.length} חשבונות`, total: results.length });
    return { fromDate: fromStr, toDate: toStr, accounts: results };
  } finally {
    await browser.close();
  }
}

// crypto.randomUUID() isn't global in Node < 19 without the import; use the
// webcrypto global that puppeteer's Node runtime always provides.
function cryptoRandomUUID() {
  return globalThis.crypto.randomUUID();
}

export const bankInfo = {
  id: 'beinleumi',
  nameHe: 'הבינלאומי',
};
