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
// FIBI's legacy login servlet (MatafLoginServlet) exposes a showCaptcha
// field and, like Mizrachi's mto.mizrahi-tefahot.co.il, appears to bot-check
// the login flow specifically in headless mode — the same real login form
// that a visible, human-driven browser sailed through timed out waiting for
// the post-login redirect when run headless. Stealth patches the headless
// fingerprints (navigator.webdriver etc.) the same way it does for Mizrachi.
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

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

  onProgress({ step: 'login-open-modal', message: 'פותח את חלונית ההתחברות…' });
  await page.waitForSelector('a.login-trigger', { timeout: 20_000 });
  await page.evaluate(() => {
    const el = document.querySelector('a.login-trigger');
    if (el) el.click();
  });

  // The MatafLoginServlet iframe can go through its own internal reload
  // right after appearing (a transient frame replaced almost immediately —
  // same class of race as the credit-card portlet's token-redirect frame),
  // so holding one frame reference across multiple awaited steps risks
  // "Attempted to use detached Frame". Poll fresh — re-querying
  // page.frames() and confirming #username is actually present — until a
  // stable one is found, rather than trusting the first url() match.
  let loginFrame = null;
  const frameWaitStart = Date.now();
  while (!loginFrame && Date.now() - frameWaitStart < 20_000) {
    const candidates = page.frames().filter(f => /MatafLoginServlet/.test(f.url()) && !f.isDetached());
    for (const frame of candidates) {
      try {
        const ready = await frame.evaluate(() => !!document.querySelector('#username'));
        if (ready) { loginFrame = frame; break; }
      } catch { /* detached mid-check — try the next candidate / next poll */ }
    }
    if (!loginFrame) await new Promise(r => setTimeout(r, 500));
  }
  if (!loginFrame) throw new Error('scrapeBeinleumi: login form iframe not found');

  onProgress({ step: 'login-form-found', message: 'טופס ההתחברות נמצא, ממלא פרטים…' });
  // Real per-character keyboard events, not a bulk value-set — the legacy
  // MatafLoginServlet form likely keeps #continueBtn disabled until its own
  // JS validation sees keyup events, so a native-setter bulk fill (which
  // worked for other banks' forms) can silently leave the button disabled
  // here, making the later click a no-op with no error.
  await loginFrame.type('#username', userId, { delay: 30 });
  await loginFrame.type('#password', password, { delay: 30 });

  onProgress({ step: 'login-submit', message: 'לוחץ כניסה, ממתין לאישור…' });
  await loginFrame.waitForFunction(() => {
    const btn = document.querySelector('#continueBtn');
    return btn && !btn.disabled;
  }, { timeout: 10_000 }).catch(() => {});
  await loginFrame.evaluate(() => {
    const btn = document.querySelector('#continueBtn');
    if (!btn) throw new Error('Login button not found');
    if (btn.disabled) throw new Error('scrapeBeinleumi: כפתור הכניסה עדיין מנוטרל אחרי מילוי הפרטים');
    btn.click();
  });

  try {
    await page.waitForFunction(() => location.href.includes('online.fibi.co.il'), { timeout: 60_000 });
  } catch {
    let hint = '';
    try {
      hint = await loginFrame.evaluate(() => {
        const captchaEl = document.querySelector('#showCaptcha, [name="showCaptcha"]');
        const hasCaptcha = !!(captchaEl && captchaEl.value && captchaEl.value !== 'false' && captchaEl.value !== '0');
        const errorText = (document.body.innerText || '').trim().slice(0, 300);
        return hasCaptcha ? `יתכן ואומת captcha. טקסט בטופס: ${errorText}` : `טקסט בטופס: ${errorText}`;
      });
    } catch { hint = 'לא ניתן היה לקרוא את תוכן הטופס (ה-iframe כבר לא קיים)'; }
    throw new Error(`scrapeBeinleumi: לא הופנה ל-online.fibi.co.il תוך 60 שניות אחרי לחיצת כניסה — ${hint}`);
  }
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

// The legacy MatafAngularRestApiService endpoints (e.g. userData) work with
// just the session cookie. The modern bff-* endpoints additionally require
// the Authorization bearer token the app itself only attaches via its own
// HttpClient interceptor — a plain fetch() without it gets a silent 401
// (body: null), which upstream turned into a confusing "no data" error
// instead of a clear auth failure. authHeaders is optional so callers that
// don't need it (userData) can omit it.
async function fetchJson(page, url, authHeaders = null) {
  return page.evaluate(async (url, authHeaders) => {
    const headers = authHeaders ? { ...authHeaders, 'x-fibi-transaction-id': crypto.randomUUID() } : undefined;
    const r = await fetch(url, { credentials: 'include', headers });
    return { status: r.status, body: r.ok ? await r.json() : null };
  }, url, authHeaders);
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

// FIBI's login occasionally times out waiting for the post-login redirect
// even with stealth applied and a real per-character typed form (observed
// live: worked, then failed the same way on a later attempt, no code
// change in between) — soft/probabilistic bot-scoring rather than a hard
// block, so one full retry with a completely fresh browser (new profile,
// new fingerprint) is worth it before giving up, same spirit as this app's
// other banks' pagination-retry patterns.
const isTransientLoginError = (err) => {
  const msg = String(err?.message || '');
  return msg.includes('לא הופנה ל-online.fibi.co.il') || msg.includes('detached Frame');
};

export async function scrapeBeinleumi({ credentials, daysBack = 30, showBrowser = false, onProgress = () => {} }) {
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptScrapeBeinleumi({ credentials, daysBack, showBrowser, onProgress });
    } catch (err) {
      if (!isTransientLoginError(err) || attempt === MAX_ATTEMPTS) throw err;
      onProgress({ step: 'retry', message: `ניסיון ${attempt} נכשל בהתחברות — מנסה שוב מהתחלה…` });
    }
  }
}

async function attemptScrapeBeinleumi({ credentials, daysBack, showBrowser, onProgress }) {
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

    const accountTypesResp = await fetchJson(page, `/appsng/bff-balancetransactions/api/v1/transactions/accountType?uid=${cryptoRandomUUID()}`, templateHeaders);
    const accountTypes = accountTypesResp.body?.accountType ?? [];
    const primaryType = accountTypes[0];
    if (!primaryType) throw new Error(`scrapeBeinleumi: no account type returned (HTTP ${accountTypesResp.status})`);

    const results = [];
    for (const acc of accounts) {
      const accountNumber = Number(acc.account);
      const branch = acc.branch;
      const maskedNumber = `${branch}-${acc.account}`;
      const corporateName = (acc.name || '').trim() || maskedNumber;

      onProgress({ step: 'fetching-account', message: `מוריד תנועות מחשבון ${maskedNumber}`, account: maskedNumber });

      const balResp = await fetchJson(page, `/appsng/bff-balancetransactions/api/v1/transactions/balances/${primaryType.accountType}?uid=${cryptoRandomUUID()}`, templateHeaders);
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
