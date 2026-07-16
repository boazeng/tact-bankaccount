import puppeteer from 'puppeteer';

const ACCOUNTS_URL_FRAG = '/userAccounts/bsUserAccountsData';
const TXN_URL_FRAG = '/lastTransactions/transactions/';
const ENTRIES_PAGE = 'https://start.telebank.co.il/apollo/business2/#/OSH_LENTRIES_ALTAMIRA';

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const ymdToIso = (s) => (s && s.length === 8) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : (s || null);
const parseYmd = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));

// Discount's transactions endpoint caps how many rows it returns per request and
// signals truncation via AdditionalTransactions='True' instead of paginating —
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

async function fetchDiscountBatch(page, accNum, from, to, tplHeaders, includeInfo) {
  return page.evaluate(async (accNum, from, to, tplHeaders, includeInfo) => {
    const headers = { ...tplHeaders, accountnumber: accNum };
    const txnPromise = fetch(
      `/Titan/gatewayAPI/lastTransactions/transactions/${accNum}/ByDate?FromDate=${from}&ToDate=${to}&IsTransactionDetails=True&IsFutureTransactionFlag=True&IsEventNames=True&IsCategoryDescCode=True`,
      { credentials: 'include', headers },
    );
    const infoPromise = includeInfo
      ? fetch(`/Titan/gatewayAPI/accountDetails/infoAndBalance/${accNum}`, { credentials: 'include', headers })
      : null;
    const [txnRes, infoRes] = await Promise.all([txnPromise, infoPromise]);
    return {
      txn: txnRes.ok ? await txnRes.json() : null,
      txnStatus: txnRes.status,
      info: infoRes && infoRes.ok ? await infoRes.json() : null,
      infoStatus: infoRes ? infoRes.status : null,
    };
  }, accNum, from, to, tplHeaders, includeInfo);
}

async function fetchAllOperations(page, accNum, fromStr, toStr, tplHeaders, onProgress, topResp) {
  const resp = topResp ?? await fetchDiscountBatch(page, accNum, fromStr, toStr, tplHeaders, false);
  if (resp.txnStatus !== 200 || !resp.txn) return { status: resp.txnStatus, operations: [], flagged: false };
  const operations = resp.txn?.CurrentAccountLastTransactions?.OperationEntry ?? [];
  const flagged = resp.txn?.CurrentAccountLastTransactions?.AdditionalTransactions === 'True';
  const spanDays = Math.round((parseYmd(toStr) - parseYmd(fromStr)) / 86_400_000) + 1;
  if (!flagged || spanDays <= MIN_WINDOW_DAYS) {
    return { status: 200, operations, flagged };
  }
  const { leftTo, rightFrom } = splitRange(fromStr, toStr);
  onProgress({ step: 'pagination-split', message: `יותר תנועות מהצפוי בטווח ${fromStr}–${toStr} — מפצל לשתי בקשות` });
  const left = await fetchAllOperations(page, accNum, fromStr, leftTo, tplHeaders, onProgress);
  const right = await fetchAllOperations(page, accNum, rightFrom, toStr, tplHeaders, onProgress);
  return { status: 200, operations: [...left.operations, ...right.operations], flagged: left.flagged || right.flagged };
}

export async function scrapeDiscount({ credentials, daysBack = 30, showBrowser = false, onProgress = () => {} }) {
  const { userId, password, loginUrl } = credentials;
  if (!userId || !password || !loginUrl) {
    throw new Error('scrapeDiscount: missing userId/password/loginUrl');
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
      if (req.url().includes(TXN_URL_FRAG) && !txnRequestHeaders) {
        txnRequestHeaders = req.headers();
      }
    });
    page.on('response', async (res) => {
      if (res.status() !== 200) return;
      try {
        const url = res.url();
        if (url.includes(ACCOUNTS_URL_FRAG)) {
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
    onProgress({ step: 'init-session', message: 'טוען עמוד תנועות לאתחול הסשן…' });

    if (!page.url().includes('OSH_LENTRIES_ALTAMIRA')) {
      await page.evaluate((url) => { location.href = url; }, ENTRIES_PAGE);
    }

    const headerWaitStart = Date.now();
    while ((!txnRequestHeaders || !accountsResponse) && Date.now() - headerWaitStart < 30_000) {
      await new Promise(r => setTimeout(r, 500));
    }

    if (!accountsResponse) throw new Error('Failed to capture accounts list from Discount');
    if (!txnRequestHeaders) throw new Error('Failed to capture transactions request headers from Discount');

    const userAccounts = accountsResponse.UserAccountsData?.UserAccounts ?? [];
    const userCompanies = accountsResponse.UserAccountsData?.UserCompanies ?? [];
    const companiesById = Object.fromEntries(
      userCompanies.map(c => [c.CompanyIdentityNumber, c.CompanyName]),
    );

    onProgress({
      step: 'accounts-found',
      message: `נמצאו ${userAccounts.length} חשבונות (${userCompanies.length} חברות)`,
      count: userAccounts.length,
    });

    const templateHeaders = { ...txnRequestHeaders };
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

      onProgress({
        step: 'fetching-account',
        message: `מוריד תנועות מחשבון ${maskedNumber} (${companyName})`,
        account: maskedNumber,
      });

      const resp = await fetchDiscountBatch(page, accountNumber, fromStr, toStr, templateHeaders, true);

      if (resp.txnStatus !== 200) {
        onProgress({
          step: 'account-error',
          message: `שגיאה בחשבון ${maskedNumber}: HTTP ${resp.txnStatus}`,
          account: maskedNumber,
        });
        continue;
      }

      const accInfo = resp.info?.AccountInfoAndBalance ?? {};
      const { operations, flagged } = await fetchAllOperations(page, accountNumber, fromStr, toStr, templateHeaders, onProgress, resp);
      if (flagged) {
        onProgress({
          step: 'pagination-incomplete',
          message: `⚠ ${maskedNumber}: ייתכן שעדיין חסרות תנועות — יום בודד חורג ממגבלת הבנק`,
          account: maskedNumber,
        });
      }

      const transactions = operations.map(op => ({
        // Discount uses the same Urn for a transfer AND its associated fee
        // (two ledger entries, one operation). Add OperationNumber to make the
        // key unique per ledger entry — otherwise dedup drops the fees.
        transactionID: `${op.Urn}-${op.OperationNumber}`,
        date: ymdToIso(op.OperationDate),
        effectiveDate: ymdToIso(op.ValueDate),
        description: op.OperationDescriptionToDisplay || op.OperationDescription || '',
        extendedDescription: [op.OperationDescription2, op.OperationDescription3].filter(Boolean).join(' ').trim() || null,
        amount: op.OperationAmount,
        runningBalance: op.BalanceAfterOperation,
        beneficiaryName: null,
        beneficiaryBankCode: op.OperationBank || null,
        beneficiaryBranch: op.OperationBranch || null,
        beneficiaryAccountNumber: null,
        referenceNumber: op.OperationNumber != null ? String(op.OperationNumber) : null,
      }));

      results.push({
        account: {
          accountIndex: parseInt(accountNumber, 10),
          maskedNumber,
          corporateName: (accInfo.AccountName || companyName).trim(),
          balance: accInfo.AccountBalance,
          iban: null,
          branchId: accInfo.HandlingBranchID ? String(accInfo.HandlingBranchID).replace(/^0+/, '') || accInfo.HandlingBranchID : branchId,
          branchName: accInfo.HandlingBranchName ?? null,
        },
        transactions: { history: transactions, pending: [] },
        additionalTransactionsFlag: flagged,
      });

      onProgress({
        step: 'account-done',
        message: `${maskedNumber}: ${transactions.length} תנועות`,
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
  id: 'discount',
  nameHe: 'בנק דיסקונט',
};
