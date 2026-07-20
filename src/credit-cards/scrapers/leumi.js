import puppeteer from 'puppeteer';

// Independent copy of the login flow from src/scrapers/leumi.js — kept
// separate on purpose (see discount.js: the credit-cards feature shares zero
// code with the checking-account scrapers).
//
// Leumi's card data lives behind a legacy ChannelWCF "Broker.svc" endpoint
// (a pre-SPA system, still embedded inside the new digitalfront app under
// /legacy/cards/cards-world) — a completely different API shape from the
// REST endpoints the checking-account scraper uses. Every Broker.svc call
// carries a SessionID that is NOT the ASP.NET session cookie — it's a
// separate value the bank hands the page in the `cochavSessionId` cookie
// once the legacy cards page has loaded (confirmed by capturing a live
// session and finding the exact same value nowhere else but that cookie).
const BROKER_URL = '/ChannelWCF/Broker.svc/ProcessRequest';
const CARDS_WORLD_PAGE = 'https://hb2.bankleumi.co.il/staticcontent/digitalfront/he/legacy/cards/cards-world/';

const ymdIsrael = (isoUtc) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(isoUtc));

// The closed-cycle query wants the first of the billing month, not the exact
// debit day (confirmed live: passing "2026-07-01" returned the cycle that
// actually debited on 2026-07-02 — the API resolves the exact day itself).
const cycleDateParam = (isoUtc) => {
  const [y, m] = ymdIsrael(isoUtc).split('-');
  return `${y}-${m}-01T00:00:00`;
};

// "עסקה בתשלומים תשלום - 1 מ - 2." -> current=1, total=2
const parseInstallments = (dealDescription) => {
  const m = (dealDescription || '').match(/(\d+)\s*מ\s*-?\s*(\d+)/);
  return m ? { current: Number(m[1]), total: Number(m[2]) } : { current: null, total: null };
};

async function callBroker(page, { stateName, moduleName, version, sessionId, extra = {} }) {
  const reqObjFields = {
    ...(stateName ? { StateName: stateName } : {}),
    ModuleName: moduleName,
    SessionHeader: { SessionID: sessionId, FIID: 'Leumi' },
    ...extra,
  };
  const { status, text } = await page.evaluate(async (url, moduleName, version, reqObjFields) => {
    const r = await fetch(`${url}?moduleName=${moduleName}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json; charset=UTF-8', accept: 'application/json' },
      body: JSON.stringify({ moduleName, reqObj: JSON.stringify(reqObjFields), version }),
    });
    return { status: r.status, text: await r.text() };
  }, BROKER_URL, moduleName, version, reqObjFields);

  if (status !== 200) throw new Error(`${moduleName}: HTTP ${status}`);
  const outer = JSON.parse(text);
  if (outer.ProcessRequestResult !== 0) throw new Error(`${moduleName}: ProcessRequestResult=${outer.ProcessRequestResult}`);
  const inner = JSON.parse(outer.jsonResp);
  if (inner.SOStatus && inner.SOStatus.Status !== true) {
    throw new Error(`${moduleName}: ${inner.SOStatus.SOStatusItem || 'SOStatus failed'}`);
  }
  return inner;
}

export async function scrapeLeumiCards({ credentials, showBrowser = false, onProgress = () => {} }) {
  const { username, password, loginUrl } = credentials;
  if (!username || !password || !loginUrl) {
    throw new Error('scrapeLeumiCards: missing username/password/loginUrl');
  }

  onProgress({ step: 'launch', message: 'מפעיל דפדפן…' });
  const browser = await puppeteer.launch({
    headless: !showBrowser,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

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
    onProgress({ step: 'init-session', message: 'טוען עמוד כרטיסי אשראי לאתחול הסשן…' });
    await page.goto(CARDS_WORLD_PAGE, { waitUntil: 'networkidle2', timeout: 60_000 });

    let sessionId = null;
    const sessionWaitStart = Date.now();
    while (!sessionId && Date.now() - sessionWaitStart < 30_000) {
      const cookie = await page.evaluate(() => document.cookie);
      sessionId = cookie.match(/cochavSessionId=([^;]+)/)?.[1] || null;
      if (!sessionId) await new Promise(r => setTimeout(r, 500));
    }
    if (!sessionId) throw new Error('Failed to capture cochavSessionId from Leumi');

    onProgress({ step: 'accounts-check', message: 'בודק אילו חשבונות כוללים כרטיסי אשראי…' });
    const accountsInfo = await callBroker(page, {
      stateName: 'HomePageCorporate',
      moduleName: 'UC_SO_GetAccounts',
      version: 'Digital_V1.0',
      sessionId,
      extra: {
        ComboMethod: 'false',
        RequestedAccountTypes: 'CHECKING,FOREIGNACCOUNT,SECURITIES,PROVIDENTANDSTUDYFUNDS,SAVING,CREDITCARD,OTHERCREDITCARD,CASHCARD,DEBITCARD',
        ExtAccountPermissions: 'General',
        AccountSegments: '',
      },
    });

    const accountsWithCards = (accountsInfo.AccountsItems ?? [])
      .filter(a => (a.ClientProd || '').includes('CREDITCARD'));
    onProgress({ step: 'accounts-found', message: `נמצאו ${accountsWithCards.length} חשבונות עם כרטיסי אשראי`, count: accountsWithCards.length });

    const results = [];
    for (const acc of accountsWithCards) {
      const maskedNumber = acc.MaskedClientNumber || acc.MaskedNumber;
      const corporateName = (acc.CorporateName || '').replace(/&quot;/g, '"').trim();

      onProgress({ step: 'checking-account', message: `בודק כרטיסי אשראי לחשבון ${maskedNumber} (${corporateName})`, account: maskedNumber });

      const cardsInfo = await callBroker(page, {
        stateName: 'CardsWorld',
        moduleName: 'UC_SO_GetCreditCardsInfo',
        version: 'Infra_V2.0',
        sessionId,
        extra: { AccountIndex: acc.AccountIndex },
      });

      const cards = cardsInfo.CreditCardsItems ?? [];
      if (cards.length === 0) {
        onProgress({ step: 'account-skip', message: `אין כרטיס נגיש בחשבון ${maskedNumber}`, account: maskedNumber });
        continue;
      }

      for (const card of cards) {
        if (!card.DatePaymentLastUTC) {
          onProgress({ step: 'card-skip', message: `כרטיס ${card.CardLast4Digits}: אין מחזור חיוב סגור עדיין`, account: maskedNumber });
          continue;
        }
        const cycleBillingDate = ymdIsrael(card.DatePaymentLastUTC);

        const cardActivity = await callBroker(page, {
          stateName: 'CardsWorld',
          moduleName: 'UC_MS_125_CreditCardsInfo',
          version: 'Infra_V2.0',
          sessionId,
          extra: {
            AccountIndexSpecified: true,
            CardIndex: card.CardIndex,
            Operation: 3,
            OperationSpecified: true,
            CardPeriodType: 99,
            CardPeriodTypeSpecified: true,
            CycleDate: cycleDateParam(card.DatePaymentLastUTC),
            AccountIndex: acc.AccountIndex,
          },
        });

        const rawItems = (cardActivity.Activity?.TabNisTransactionItems ?? [])
          .flatMap(tab => tab.NisTransactionItems ?? []);

        const transactions = rawItems.map(t => {
          const { current, total } = parseInstallments(t.DealDescription);
          // NextPaymentAmountDouble is the actual ILS amount debited THIS
          // cycle; AmountDouble is the original transaction value, which only
          // differs for installments (total price) or foreign purchases
          // (original foreign-currency amount) — confirmed live: a 900 ILS
          // installment purchase (1 of 2) carried AmountDouble=900 but
          // NextPaymentAmountDouble=450 (this cycle's actual share).
          const billed = t.NextPaymentAmountDoubleSpecified ? t.NextPaymentAmountDouble : t.AmountDouble;
          const original = t.AmountDouble !== billed ? t.AmountDouble : null;
          return {
            transactionID: `${card.CardLast4Digits}-${(t.CardTransactionId || '').trim()}`,
            purchaseDate: ymdIsrael(t.DateDealUTC),
            billingDate: t.DebitCardDebitPeriodUTC ? ymdIsrael(t.DebitCardDebitPeriodUTC) : cycleBillingDate,
            merchantName: (t.DebitCardFirmName || '').trim() || null,
            // Bank convention: positive = charge, negative = refund/credit.
            // Flipped to match this app's convention (negative = expense),
            // same as the Discount/Poalim scrapers.
            amount: -Number(billed ?? 0),
            currency: 'ILS',
            originalAmount: original,
            installmentCurrent: current,
            installmentTotal: total,
            status: 'posted',
            raw: t,
          };
        });

        results.push({
          account: { maskedNumber, corporateName },
          card: {
            cardLast4: card.CardLast4Digits,
            label: `${card.DisplayName || ''} ${card.CardHolderNameHebrew || ''}`.trim() || null,
          },
          transactions,
        });

        onProgress({ step: 'card-done', message: `כרטיס ${card.CardLast4Digits}: ${transactions.length} תנועות`, account: maskedNumber, count: transactions.length });
      }
    }

    onProgress({ step: 'done', message: `סיום: ${results.length} כרטיסים`, total: results.length });
    return { cards: results };
  } finally {
    await browser.close();
  }
}

export const bankInfo = {
  id: 'leumi',
  nameHe: 'בנק לאומי',
};
