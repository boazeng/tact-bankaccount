// Hapoalim Business scraper (biz2.bankhapoalim.co.il).
//
// Flow:
//   1. Navigate to /biz-login/authenticate
//   2. Fill userId + password, click "כניסה"
//   3. Bank requests SMS OTP — we wait for it, then ask the caller for the
//      code via the `onSmsRequired` async callback
//   4. Fill OTP, submit, wait for dashboard
//   5. Read XSRF-TOKEN cookie, then use the API directly for accounts +
//      transactions (same pattern as Leumi/Discount)
import puppeteer from 'puppeteer';

const ACCOUNTS_URL = '/ServerServices/general/accounts?lang=he';
const TXN_URL_PREFIX = '/ServerServices/current-account/transactions';
const DASHBOARD_URL_FRAG = '/ng-portals/biz/he/';

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function scrapePoalim({ credentials, daysBack = 30, showBrowser = false, onProgress = () => {}, onSmsRequired }) {
  const { userId, password, loginUrl } = credentials;
  if (!userId || !password || !loginUrl) {
    throw new Error('scrapePoalim: missing userId/password/loginUrl');
  }
  if (typeof onSmsRequired !== 'function') {
    throw new Error('scrapePoalim: onSmsRequired callback is required (Poalim uses SMS 2FA)');
  }

  const today = new Date();
  const fromDate = new Date();
  fromDate.setDate(today.getDate() - daysBack);
  const fromStr = ymd(fromDate);
  const toStr = ymd(today);

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

    onProgress({ step: 'login', message: 'מתחבר לדף עסקי של בנק הפועלים…' });
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForSelector('#user-code', { timeout: 30_000 });

    await page.evaluate((uid, pwd) => {
      const setVal = (input, val) => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        native.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(document.querySelector('#user-code'), uid);
      setVal(document.querySelector('#password'), pwd);
    }, userId, password);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button[type="submit"]'))
        .find(b => /כניסה/.test(b.textContent || ''));
      if (!btn) throw new Error('Submit button not found');
      btn.click();
    });

    onProgress({ step: 'sms-wait', message: 'ממתין שהבנק יבקש קוד SMS…' });

    // Wait for either: SMS input page or dashboard (if no SMS this time)
    const smsAppeared = await Promise.race([
      page.waitForFunction(
        () => !!document.querySelector('input[autocomplete="one-time-code"], input[type="tel"][maxlength], input[id*="otp" i], input[name*="otp" i]'),
        { timeout: 30_000 },
      ).then(() => 'sms').catch(() => null),
      page.waitForFunction(
        () => location.href.includes('/ng-portals/biz/he/'),
        { timeout: 30_000 },
      ).then(() => 'dashboard').catch(() => null),
    ]);

    if (smsAppeared === 'sms') {
      onProgress({ step: 'sms-required', message: 'הבנק שלח SMS — נדרש קוד' });
      const code = await onSmsRequired({ message: 'הזן את הקוד שקיבלת ב-SMS מהבנק הפועלים' });
      if (!code) throw new Error('No SMS code provided');

      const smsField = await page.evaluateHandle(() =>
        document.querySelector('input[autocomplete="one-time-code"], input[type="tel"][maxlength], input[id*="otp" i], input[name*="otp" i]'),
      );
      await smsField.evaluate((el, val) => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        native.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, code);
      await sleep(500);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /כניסה|אישור|המשך/.test(b.textContent || '') && !b.disabled);
        btn?.click();
      });
      onProgress({ step: 'sms-submitted', message: 'נשלח קוד SMS, ממתין להתחברות…' });
    } else if (smsAppeared === 'dashboard') {
      onProgress({ step: 'login-no-sms', message: 'התחברות הצליחה ללא SMS' });
    } else {
      throw new Error('Timeout waiting for SMS prompt or dashboard after login');
    }

    await page.waitForFunction(() => location.href.includes('/ng-portals/biz/he/'), { timeout: 60_000 });
    await sleep(4_000);
    onProgress({ step: 'logged-in', message: 'מחובר — שולף רשימת חשבונות' });

    const accountsResp = await page.evaluate(async () => {
      const r = await fetch('/ServerServices/general/accounts?lang=he', {
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*' },
      });
      return { status: r.status, body: r.ok ? await r.json() : await r.text() };
    });
    if (accountsResp.status !== 200) {
      throw new Error(`Accounts API returned ${accountsResp.status}: ${String(accountsResp.body).slice(0, 200)}`);
    }
    const accountsList = Array.isArray(accountsResp.body) ? accountsResp.body : [];
    onProgress({ step: 'accounts-found', message: `נמצאו ${accountsList.length} חשבונות`, count: accountsList.length });

    const results = [];
    for (const acc of accountsList) {
      const accountId = `${acc.bankNumber}-${acc.branchNumber}-${acc.accountNumber}`;
      const productLabel = acc.productLabel || `${acc.branchNumber} ${acc.accountNumber}`;
      onProgress({
        step: 'fetching-account',
        message: `מוריד תנועות מחשבון ${accountId} (${productLabel})`,
        account: accountId,
      });

      const resp = await page.evaluate(async (acctId, from, to) => {
        const url = `/ServerServices/current-account/transactions`
          + `?numItemsPerPage=500&sortCode=1&retrievalEndDate=${to}&retrievalStartDate=${from}&accountId=${acctId}&lang=he`;
        const xsrf = document.cookie.split('; ').find(c => c.startsWith('XSRF-TOKEN='))?.split('=')[1] || '';
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json;charset=UTF-8',
            accept: 'application/json, text/plain, */*',
            'x-xsrf-token': decodeURIComponent(xsrf),
          },
          body: '[]',
        });
        return { status: r.status, text: await r.text() };
      }, accountId, fromStr, toStr);

      if (resp.status >= 400) {
        onProgress({ step: 'account-error', message: `שגיאה בחשבון ${accountId}: HTTP ${resp.status}`, account: accountId });
        continue;
      }

      let body = null;
      if (resp.text) {
        try { body = JSON.parse(resp.text); }
        catch {
          onProgress({ step: 'account-error', message: `תגובה לא תקינה מחשבון ${accountId}`, account: accountId });
          continue;
        }
      }

      const txnsRaw = body?.transactions ?? [];
      const balance = body?.retrievalTransactionData?.currentBalance
        ?? txnsRaw[0]?.currentBalance
        ?? null;

      const formatDate = (d) => d && String(d).length === 8
        ? `${String(d).slice(0,4)}-${String(d).slice(4,6)}-${String(d).slice(6,8)}`
        : null;

      const transactions = txnsRaw.map(t => {
        const isCredit = t.eventActivityTypeCode === 1;
        const signedAmount = isCredit ? Math.abs(t.eventAmount) : -Math.abs(t.eventAmount);
        const ben = t.beneficiaryDetailsData || {};
        return {
          // expandedEventDate is the bank's stable per-transaction id
          // (date + sequence within day). Previous composite (date-ref-cat)
          // collided for paired transfer+fee rows and for זה"ב transfers
          // that all share ref=0/22222 — dedup dropped real transactions.
          transactionID: String(t.expandedEventDate ?? `${t.eventDate}-${t.referenceNumber}-${t.referenceCatenatedNumber ?? 0}`),
          date: formatDate(t.eventDate),
          effectiveDate: formatDate(t.valueDate),
          description: t.activityDescription || '',
          extendedDescription: t.activityDescriptionIncludeValueDate || null,
          amount: signedAmount,
          runningBalance: t.currentBalance,
          beneficiaryName: ben.beneficiaryName || ben.partyHeadline || null,
          beneficiaryBankCode: ben.bankNumber != null ? String(ben.bankNumber) : null,
          beneficiaryBranch: ben.branchNumber != null ? String(ben.branchNumber) : null,
          beneficiaryAccountNumber: ben.accountNumber != null ? String(ben.accountNumber) : null,
          referenceNumber: String(t.referenceNumber || ''),
        };
      });

      results.push({
        account: {
          accountIndex: acc.accountNumber,
          maskedNumber: `${acc.branchNumber}-${acc.accountNumber}`,
          corporateName: productLabel,
          balance,
          iban: null,
          branchId: acc.branchNumber != null ? String(acc.branchNumber) : null,
          branchName: null,
        },
        transactions: { history: transactions, pending: [] },
        additionalTransactionsFlag: false,
      });

      onProgress({
        step: 'account-done',
        message: `${acc.branchNumber}-${acc.accountNumber}: ${transactions.length} תנועות`,
        account: accountId,
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
  id: 'poalim',
  nameHe: 'בנק הפועלים',
};
