// Mizrahi-Tefahot Business scraper (mto.mizrahi-tefahot.co.il, Sky OnlineApp).
//
// Flow:
//   1. Navigate to the protected OnlineApp URL — SiteMinder auto-redirects to
//      the login form on www.mizrahi-tefahot.co.il.
//   2. Fill #userNumberDesktopHeb + #passwordDesktopHeb, click "כניסה".
//   3. If SMS 2FA appears → call onSmsRequired() and fill the OTP.
//   4. Wait for redirect back to mto.* and dashboard to load.
//   5. Refetch /SkyBL/logon → list of user's accounts (in body.user.Accounts).
//   6. For each account: changeAccount(index) → get428Index (transactions).
import puppeteer from 'puppeteer';

const PROTECTED_URL = 'https://mto.mizrahi-tefahot.co.il/OnlineApp/index.html';

// Mizrachi expects DD/MM/YYYY (not YYYYMMDD like other banks).
const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function scrapeMizrachi({ credentials, daysBack = 30, showBrowser = false, onProgress = () => {}, onSmsRequired }) {
  const { userId, password } = credentials;
  if (!userId || !password) throw new Error('scrapeMizrachi: missing userId/password');

  const today = new Date();
  const fromDate = new Date();
  fromDate.setDate(today.getDate() - daysBack);
  const fromStr = ddmmyyyy(fromDate);
  const toStr = ddmmyyyy(today);

  onProgress({ step: 'launch', message: 'מפעיל דפדפן…' });
  const browser = await puppeteer.launch({
    headless: !showBrowser,
    defaultViewport: showBrowser ? null : { width: 1400, height: 900 },
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      ...(showBrowser ? ['--start-maximized'] : []),
    ],
  });

  try {
    const [page] = showBrowser ? await browser.pages() : [await browser.newPage()];

    // Listen for the SPA's logon call — it carries the full accounts list,
    // which a refetch later won't return.
    let initialLogonBody = null;
    page.on('response', async (res) => {
      if (initialLogonBody) return;
      if (!res.url().includes('/Online/api/SkyBL/logon')) return;
      try { initialLogonBody = await res.text(); } catch {}
    });

    onProgress({ step: 'login', message: 'נכנס למזרחי-טפחות…' });
    await page.goto(PROTECTED_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

    await page.waitForSelector('#userNumberDesktopHeb', { timeout: 30_000 });
    await page.evaluate((uid, pwd) => {
      const setVal = (input, val) => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        native.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(document.querySelector('#userNumberDesktopHeb'), uid);
      setVal(document.querySelector('#passwordDesktopHeb'), pwd);
    }, userId, password);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /כניסה/.test(b.textContent || '') && !b.disabled);
      if (!btn) throw new Error('Login button not found');
      btn.click();
    });

    onProgress({ step: 'sms-wait', message: 'ממתין לתגובה מהבנק (SMS או דשבורד)…' });

    const result = await Promise.race([
      page.waitForFunction(
        () => !!document.querySelector('input[autocomplete="one-time-code"], input[type="tel"][maxlength], input[id*="otp" i], input[name*="otp" i]'),
        { timeout: 45_000 },
      ).then(() => 'sms').catch(() => null),
      page.waitForFunction(
        () => location.hostname.includes('mto.mizrahi-tefahot.co.il') && location.pathname.includes('/OnlineApp/'),
        { timeout: 45_000 },
      ).then(() => 'dashboard').catch(() => null),
    ]);

    if (result === 'sms') {
      if (typeof onSmsRequired !== 'function') {
        throw new Error('Mizrachi requested SMS code but no onSmsRequired callback was provided');
      }
      onProgress({ step: 'sms-required', message: 'הבנק שלח SMS — נדרש קוד' });
      const code = await onSmsRequired({ message: 'הזן את הקוד שקיבלת ב-SMS ממזרחי-טפחות' });
      if (!code) throw new Error('No SMS code provided');
      await page.evaluate((c) => {
        const el = document.querySelector('input[autocomplete="one-time-code"], input[type="tel"][maxlength], input[id*="otp" i], input[name*="otp" i]');
        if (!el) throw new Error('SMS input no longer present');
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        native.call(el, c);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /כניסה|אישור|המשך/.test(b.textContent || '') && !b.disabled);
        btn?.click();
      }, code);
      onProgress({ step: 'sms-submitted', message: 'נשלח קוד SMS, ממתין להתחברות…' });
      await page.waitForFunction(
        () => location.hostname.includes('mto.mizrahi-tefahot.co.il') && location.pathname.includes('/OnlineApp/'),
        { timeout: 60_000 },
      );
    } else if (!result) {
      throw new Error('Timeout waiting for SMS prompt or dashboard after login');
    }

    onProgress({ step: 'logged-in', message: 'מחובר — שולף רשימת חשבונות' });

    // Wait for the SPA's logon call to fire (it's part of the dashboard bootstrap).
    const waitStart = Date.now();
    while (!initialLogonBody && Date.now() - waitStart < 15_000) {
      await sleep(300);
    }
    if (!initialLogonBody) throw new Error('Did not capture /SkyBL/logon response within 15s after login');

    let logonBody = null;
    try { logonBody = JSON.parse(initialLogonBody); } catch {}

    // Look in the obvious places, then fall back to a recursive search.
    let accountsRaw = logonBody?.body?.user?.Accounts
      ?? logonBody?.user?.Accounts
      ?? logonBody?.body?.Accounts
      ?? logonBody?.Accounts;
    if (!Array.isArray(accountsRaw) || !accountsRaw.length) {
      const findAccounts = (obj, depth = 0) => {
        if (!obj || typeof obj !== 'object' || depth > 6) return null;
        if (Array.isArray(obj)) {
          if (obj.length && obj[0]?.SnifAndNumber400) return obj;
          for (const item of obj) {
            const found = findAccounts(item, depth + 1);
            if (found) return found;
          }
          return null;
        }
        for (const k of Object.keys(obj)) {
          const found = findAccounts(obj[k], depth + 1);
          if (found) return found;
        }
        return null;
      };
      accountsRaw = findAccounts(logonBody) ?? [];
    }

    if (!accountsRaw.length) {
      throw new Error('No accounts found in /SkyBL/logon response body');
    }

    onProgress({ step: 'accounts-found', message: `נמצאו ${accountsRaw.length} חשבונות`, count: accountsRaw.length });

    const results = [];
    for (let i = 0; i < accountsRaw.length; i++) {
      const acc = accountsRaw[i];
      const maskedNumber = acc.SnifAndNumber400 || `${acc.BranchForDispaly || acc.Branch}-${acc.Number}`;
      const corporateName = (acc.Name || '').trim();

      onProgress({
        step: 'fetching-account',
        message: `מוריד תנועות מחשבון ${maskedNumber} (${corporateName})`,
        account: maskedNumber,
      });

      // Switch to this account in the session
      const switchResp = await page.evaluate(async (idx) => {
        const r = await fetch('/Online/api/SkyBL/changeAccount', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
          body: JSON.stringify({ selectedAccountIndex: idx }),
        });
        return { status: r.status, text: await r.text() };
      }, i);

      let switchBody = null;
      try { switchBody = JSON.parse(switchResp.text || '{}'); } catch {}
      const balance = switchBody?.body?.YitraAdkanit != null
        ? Number(switchBody.body.YitraAdkanit)
        : (acc.Remain != null ? Number(acc.Remain) : null);

      // changeAccount may take a moment to propagate session state.
      await sleep(800);

      // Fetch transactions for this account
      const txnResp = await page.evaluate(async (from, to) => {
        const r = await fetch('/Online/api/SkyOSH/get428Index', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
          body: JSON.stringify({
            inToDate: to,
            inFromDate: from,
            inSugTnua: '',
            table: { sortExpression: 'MC02PeulaTaaEZ DESC', sortOrder: 'DESC', startRowIndex: 0, maxRow: 500, actionGuid: '' },
            isFromSearch: false,
          }),
        });
        const text = await r.text();
        const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return {
          status: r.status,
          redirected: r.redirected,
          finalUrl: r.url,
          contentType: r.headers.get('content-type'),
          title: titleMatch ? titleMatch[1] : null,
          text,
        };
      }, fromStr, toStr);

      if (txnResp.status >= 400) {
        onProgress({ step: 'account-error', message: `שגיאה בחשבון ${maskedNumber}: HTTP ${txnResp.status}`, account: maskedNumber });
        continue;
      }

      let txnBody = null;
      try { txnBody = JSON.parse(txnResp.text || '{}'); } catch {}

      // get428Index should always return JSON. A parse failure means something
      // other than the real API response came back (redirect, challenge page,
      // WAF block, etc.) — surface it as an explicit account-level error
      // instead of silently reporting zero transactions as a fake success.
      if (!txnBody) {
        const body = txnResp.text || '';
        const hasLoginForm = /userNumberDesktopHeb|passwordDesktopHeb/.test(body);
        const hasAppShell = /ng-version|app-root/.test(body);
        onProgress({
          step: 'account-error',
          message: `חשבון ${maskedNumber}: תגובה לא-תקינה מהבנק (לא JSON) — redirected=${txnResp.redirected} finalUrl=${txnResp.finalUrl} contentType=${txnResp.contentType} title="${txnResp.title || ''}" bodyLength=${body.length} hasLoginForm=${hasLoginForm} hasAppShell=${hasAppShell}. לא נמשכו תנועות. גוף התגובה (3000 תווים ראשונים): ${body.slice(0, 3000)}`,
          account: maskedNumber,
        });
        continue;
      }

      const rows = txnBody?.body?.table?.rows ?? [];
      const realRows = rows.filter(r => r.RecTypeSpecified && r.MC02PeulaTaaEZSpecified);

      const ymdIso = (raw) => raw ? String(raw).slice(0, 10) : null;
      const transactions = realRows.map(r => {
        const amountRaw = Number(String(r.MC02SchumEZ || 0).replace(/,/g, ''));
        const isCredit = r.MC02OfiSchumEZ === 1 || r.MC02OfiSchumEZ === '1';
        const signedAmount = isCredit ? Math.abs(amountRaw) : -Math.abs(amountRaw);
        const balanceRaw = r.MC02YitraEZ != null ? Number(String(r.MC02YitraEZ).replace(/,/g, '')) : null;
        const ref = r.MC02AsmEZ || r.MC02AsmahtaMekoritEZ || r.TransactionNumber;
        return {
          transactionID: `${maskedNumber}|${ymdIso(r.MC02PeulaTaaEZ) || ymdIso(r.TaarichEreh) || ''}|${ref || ''}|${r.RowNumber || ''}`,
          date: ymdIso(r.MC02PeulaTaaEZ) || ymdIso(r.TaarichEreh),
          effectiveDate: ymdIso(r.TaarichEreh) || ymdIso(r.MC02PeulaTaaEZ),
          description: r.MC02TnuaTeurEZ || r.Teur || '',
          extendedDescription: r.P428G2Details || null,
          amount: signedAmount,
          runningBalance: balanceRaw,
          beneficiaryName: r.NegdiShem || null,
          beneficiaryBankCode: r.NegdiBank != null ? String(r.NegdiBank) : null,
          beneficiaryBranch: r.NegdiSnif != null ? String(r.NegdiSnif) : null,
          beneficiaryAccountNumber: r.NegdiCheshbon != null ? String(r.NegdiCheshbon) : null,
          referenceNumber: ref != null ? String(ref) : null,
        };
      });

      results.push({
        account: {
          accountIndex: Number(acc.Number) || i,
          maskedNumber,
          corporateName: corporateName || maskedNumber,
          balance,
          iban: null,
          branchId: acc.BranchForDispaly || acc.Branch || null,
          branchName: null,
        },
        transactions: { history: transactions, pending: [] },
        additionalTransactionsFlag: false,
      });

      onProgress({
        step: 'account-done',
        message: `${maskedNumber}: ${transactions.length} תנועות, יתרה ₪${balance ?? '?'}`,
        account: maskedNumber,
        count: transactions.length,
      });
    }

    onProgress({ step: 'done', message: `סיום: ${results.length} חשבונות`, total: results.length });
    return { fromDate: fromStr, toDate: toStr, accounts: results };
  } finally {
    await browser.close();
  }
}

export const bankInfo = {
  id: 'mizrachi',
  nameHe: 'בנק מזרחי-טפחות',
};
