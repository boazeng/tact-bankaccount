import puppeteer from 'puppeteer';

// Independent copy of the login flow from src/scrapers/discount.js — kept
// separate on purpose so the credit-cards feature has zero shared code with
// the checking-account scraper (see plan: isolated src/credit-cards/ module).
const ACCOUNTS_URL_FRAG = '/userAccounts/bsUserAccountsData';
const CARD_LIST_FRAG = '/creditCards/cardList/';
const CARDS_PAGE = 'https://start.telebank.co.il/apollo/business2/#/CARD_DEBIT_TRANSACTION';

const ymdToIso = (s) => (s && s.length === 8) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : (s || null);

export async function scrapeDiscountCards({ credentials, showBrowser = false, onProgress = () => {} }) {
  const { userId, password, loginUrl } = credentials;
  if (!userId || !password || !loginUrl) {
    throw new Error('scrapeDiscountCards: missing userId/password/loginUrl');
  }

  onProgress({ step: 'launch', message: 'מפעיל דפדפן…' });
  const browser = await puppeteer.launch({
    headless: !showBrowser,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    let cardRequestHeaders = null;
    let accountsResponse = null;

    page.on('request', (req) => {
      if (req.url().includes(CARD_LIST_FRAG) && !cardRequestHeaders) {
        cardRequestHeaders = req.headers();
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
    await page.waitForSelector('input#tzId', { timeout: 30_000 });

    await page.evaluate((uid, pwd) => {
      const setVal = (input, val) => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        native.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const idInput = document.querySelector('#tzId');
      const pwdInput = document.querySelector('#tzPassword');
      if (idInput) setVal(idInput, uid);
      if (pwdInput) setVal(pwdInput, pwd);
    }, userId, password);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /כניסה/.test(b.textContent || '') && !b.disabled);
      if (!btn) throw new Error('Login button not found');
      btn.click();
    });

    await page.waitForFunction(() => location.href.includes('/apollo/business'), { timeout: 60_000 });
    onProgress({ step: 'init-session', message: 'טוען עמוד כרטיסי אשראי לאתחול הסשן…' });
    await page.evaluate((url) => { location.href = url; }, CARDS_PAGE);

    const headerWaitStart = Date.now();
    while ((!cardRequestHeaders || !accountsResponse) && Date.now() - headerWaitStart < 30_000) {
      await new Promise(r => setTimeout(r, 500));
    }

    if (!accountsResponse) throw new Error('Failed to capture accounts list from Discount');
    if (!cardRequestHeaders) throw new Error('Failed to capture credit-card request headers from Discount');

    const userAccounts = accountsResponse.UserAccountsData?.UserAccounts ?? [];
    const userCompanies = accountsResponse.UserAccountsData?.UserCompanies ?? [];
    const companiesById = Object.fromEntries(
      userCompanies.map(c => [c.CompanyIdentityNumber, c.CompanyName]),
    );

    onProgress({ step: 'accounts-found', message: `נמצאו ${userAccounts.length} חשבונות`, count: userAccounts.length });

    const templateHeaders = { ...cardRequestHeaders };
    for (const h of ['cookie', 'host', ':authority', ':method', ':path', ':scheme', 'content-length']) {
      delete templateHeaders[h];
    }

    const results = [];
    for (const acc of userAccounts) {
      const info = acc.NewAccountInfo ?? {};
      const accountNumber = info.AccountID;
      if (!accountNumber) continue;

      const companyName = companiesById[info.CompanyIdentityNumber] ?? '—';
      const branchId = (info.BranchID ?? '').replace(/^0+/, '') || info.BranchID;
      const accountShort = accountNumber.replace(/^0+/, '');
      const maskedNumber = `${branchId}-${accountShort}`;

      onProgress({ step: 'checking-account', message: `בודק כרטיסי אשראי לחשבון ${maskedNumber} (${companyName})`, account: maskedNumber });

      const cardListResp = await page.evaluate(async (accNum, tplHeaders) => {
        const r = await fetch(`/Titan/gatewayAPI/creditCards/cardList/${accNum}`, { credentials: 'include', headers: tplHeaders });
        return { status: r.status, body: await r.json().catch(() => null) };
      }, accountNumber, templateHeaders);

      const cards = cardListResp.body?.CardList?.CardsBlock?.CardEntry ?? [];
      if (cardListResp.status !== 200 || cardListResp.body?.Error || cards.length === 0) {
        onProgress({
          step: 'account-skip',
          message: `אין כרטיס נגיש בחשבון ${maskedNumber}${cardListResp.body?.Error ? ': ' + cardListResp.body.Error.MsgText : ''}`,
          account: maskedNumber,
        });
        continue;
      }

      for (const card of cards) {
        const cardParams = {
          CardNumber: card.CardNumber,
          CardTypeCode: card.CardTypeCode,
          CardValidityDate: card.CardValidityDate,
        };

        const txnResp = await page.evaluate(async (accNum, params, tplHeaders) => {
          const qs = new URLSearchParams(params).toString();
          const r = await fetch(
            `/Titan/gatewayAPI/creditCards/cardCurrentDebitTransactions/${accNum}/C?${qs}`,
            { credentials: 'include', headers: tplHeaders },
          );
          return { status: r.status, body: await r.json().catch(() => null) };
        }, accountNumber, cardParams, templateHeaders);

        const entries = txnResp.body?.CardCurrentDebitTransactions?.CardDebitsTransactionsBlock?.CardDebitsTransactionEntry ?? [];

        const transactions = entries.map(e => ({
          // OrderNumerator disambiguates genuinely identical charges (same
          // date/time/merchant/amount) that the bank lists as separate lines —
          // observed in practice, not hypothetical (see plan verification notes).
          transactionID: [e.PurchaseDate, e.PurchaseTime, card.CardNumber, e.MerchantName, e.PurchaseAmount, e.OrderNumerator].filter(v => v != null).join('|'),
          purchaseDate: ymdToIso(e.PurchaseDate),
          billingDate: ymdToIso(e.DebitDate) || null,
          merchantName: (e.MerchantName || '').trim() || null,
          amount: -Math.abs(Number(e.DebitAmount ?? e.PurchaseAmount ?? 0)),
          currency: e.DebitCurrencyCode || e.PurchaseCurrencyCode || 'ILS',
          originalAmount: (e.PurchaseCurrencyCode && e.PurchaseCurrencyCode !== (e.DebitCurrencyCode || e.PurchaseCurrencyCode))
            ? Number(e.PurchaseAmount) : null,
          installmentCurrent: e.InstallmentNumber ? Number(e.InstallmentNumber) : null,
          installmentTotal: e.TotalNumberOfInstallments ? Number(e.TotalNumberOfInstallments) : null,
          status: 'posted',
          raw: e,
        }));

        results.push({
          account: { maskedNumber, corporateName: companyName },
          card: {
            cardLast4: card.CardNumber,
            label: `${card.CardTypeDescription || ''} ${card.CardHolderFirstName || ''}`.trim() || null,
          },
          transactions,
        });

        onProgress({ step: 'card-done', message: `כרטיס ${card.CardNumber}: ${transactions.length} תנועות`, account: maskedNumber, count: transactions.length });
      }
    }

    onProgress({ step: 'done', message: `סיום: ${results.length} כרטיסים`, total: results.length });
    return { cards: results };
  } finally {
    await browser.close();
  }
}

export const bankInfo = {
  id: 'discount',
  nameHe: 'בנק דיסקונט',
};
