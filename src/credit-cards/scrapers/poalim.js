import puppeteer from 'puppeteer';

// Independent copy of the login flow from src/scrapers/poalim.js — kept
// separate on purpose (see discount.js: the credit-cards feature shares zero
// code with the checking-account scrapers).
const DASHBOARD_URL_FRAG = '/ng-portals/biz/he/';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ymdToIso = (s) => (s && String(s).length === 8)
  ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}`
  : null;

export async function scrapePoalimCards({ credentials, showBrowser = false, onProgress = () => {}, onSmsRequired }) {
  const { userId, password, loginUrl } = credentials;
  if (!userId || !password || !loginUrl) {
    throw new Error('scrapePoalimCards: missing userId/password/loginUrl');
  }
  if (typeof onSmsRequired !== 'function') {
    throw new Error('scrapePoalimCards: onSmsRequired callback is required (Poalim uses SMS 2FA)');
  }

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
      const maskedNumber = `${acc.branchNumber}-${acc.accountNumber}`;
      const corporateName = acc.productLabel || maskedNumber;

      onProgress({ step: 'checking-account', message: `בודק כרטיסי אשראי לחשבון ${maskedNumber}`, account: maskedNumber });

      // No statementDate -> the bank's own default: the last CLOSED billing
      // cycle (mirrors the "always pull the last closed cycle" rule used for
      // Discount — the still-open current cycle's amounts/dates aren't final).
      const totalsResp = await page.evaluate(async (acctId) => {
        const r = await fetch(`/ServerServices/cards/transactions-totals?accountId=${acctId}&transactionsType=previous&lang=he`, {
          credentials: 'include',
          headers: { accept: 'application/json, text/plain, */*' },
        });
        // A 200/204 with an empty body (observed live for some accounts)
        // makes r.json() throw "Unexpected end of JSON input" — read as text
        // first and treat empty/unparseable as no data instead of failing.
        const text = await r.text();
        let body = null;
        if (text) { try { body = JSON.parse(text); } catch {} }
        return { status: r.status, body };
      }, accountId);

      const cards = totalsResp.body?.cards ?? [];
      if (totalsResp.status !== 200 || cards.length === 0) {
        onProgress({ step: 'account-skip', message: `אין כרטיס אשראי בחשבון ${maskedNumber}`, account: maskedNumber });
        continue;
      }

      for (const card of cards) {
        const ident = card.cardIdentification;
        const cycleTotal = card.cardBookedBalances?.nationalTransactionsTotal?.[0];
        if (!ident || !cycleTotal) continue;

        const statementDate = cycleTotal.statementDate;
        // debitDate is the actual day the bank debits the account for this
        // cycle — far more reliable than any per-transaction date, same
        // reasoning as DateOfPastDebit in the Discount scraper.
        const cycleBillingDate = ymdToIso(cycleTotal.debitDate);

        const txnResp = await page.evaluate(async (params) => {
          const qs = new URLSearchParams(params).toString();
          const r = await fetch(`/ServerServices/cards/transactions?${qs}`, {
            credentials: 'include',
            headers: { accept: 'application/json, text/plain, */*' },
          });
          // Same defensive parse as the totals call above — an empty body
          // must not throw and abort the whole sync over one card.
          const text = await r.text();
          let body = null;
          if (text) { try { body = JSON.parse(text); } catch {} }
          return { status: r.status, body };
        }, {
          accountId,
          cardSuffix: ident.cardSuffix,
          cardIssuingSPCode: String(ident.cardIssuingSPCode),
          cardIdServiceProvider: ident.cardIdServiceProvider,
          transactionsType: 'previous',
          totalInd: '1',
          statementDate: String(statementDate),
          eventCurrencyDescription: 'null',
          debitEventOrigin: '1',
          offset: '0',
          limit: '50',
          cardIdHapoalim: ident.cardIdHapoalim,
          lang: 'he',
        });

        if (txnResp.status !== 200 || !txnResp.body?.card) {
          onProgress({ step: 'card-error', message: `שגיאה בשליפת תנועות כרטיס ${ident.cardSuffix}`, account: maskedNumber });
          continue;
        }

        // nationalTransactions = ILS charges; internationalTransactions
        // (foreign-currency charges) uses the same nested shape but has
        // never been observed live — best-effort only, flagged below if hit.
        const nationalGroups = txnResp.body.card.nationalTransactions ?? [];
        const internationalGroups = txnResp.body.card.internationalTransactions ?? [];
        if (internationalGroups.length) {
          onProgress({ step: 'card-warning', message: `כרטיס ${ident.cardSuffix}: נמצאו תנועות מט"ח — טרם נבדק מבנה זה, ייתכן פירוט חלקי`, account: maskedNumber });
        }

        const rawDetails = [
          ...nationalGroups.flatMap(g => (g.transactionsDetails ?? []).map(d => ({ ...d, __intl: false }))),
          ...internationalGroups.flatMap(g => (g.transactionsDetails ?? []).map(d => ({ ...d, __intl: true }))),
        ];

        if (rawDetails.length >= 50) {
          onProgress({ step: 'card-warning', message: `כרטיס ${ident.cardSuffix}: ${rawDetails.length} תנועות בעמוד אחד — ייתכן שיש עוד (pagination טרם ממומש)`, account: maskedNumber });
        }

        const transactions = rawDetails.map(t => ({
          // transactionIndexNumber is the bank's own stable per-transaction id.
          transactionID: `${ident.cardSuffix}-${t.transactionIndexNumber}`,
          purchaseDate: ymdToIso(t.eventDate),
          billingDate: cycleBillingDate || ymdToIso(t.debitDate) || null,
          merchantName: (t.merchantDetails?.merchantName || '').trim() || null,
          // Bank convention: positive = charge, negative = refund/credit.
          // Flipped to match this app's convention (negative = expense),
          // same as the Discount scraper.
          amount: -Number(t.currencyAmount?.amount ?? 0),
          currency: t.__intl ? (t.eventCurrencyDescription || 'ILS') : 'ILS',
          originalAmount: null,
          installmentCurrent: t.paymentNumber || null,
          installmentTotal: t.paymentsNumber || null,
          status: 'posted',
          raw: t,
        }));

        results.push({
          account: { maskedNumber, corporateName },
          card: {
            cardLast4: ident.cardSuffix,
            label: ident.cardVendorProductName || null,
          },
          transactions,
        });

        onProgress({ step: 'card-done', message: `כרטיס ${ident.cardSuffix}: ${transactions.length} תנועות`, account: maskedNumber, count: transactions.length });
      }
    }

    onProgress({ step: 'done', message: `סיום: ${results.length} כרטיסים`, total: results.length });
    return { cards: results };
  } finally {
    await browser.close();
  }
}

export const bankInfo = {
  id: 'poalim',
  nameHe: 'בנק הפועלים',
};
