import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/bank.env' });

const username = process.env.USER_NAME;
const password = process.env.USER_PASSWARD ?? process.env.USER_PASSWORD;
const loginUrl = process.env.URL;

if (!username || !password || !loginUrl) {
  console.error('Missing USER_NAME / USER_PASSWARD / URL in bank.env');
  process.exit(1);
}

const args = process.argv.slice(2);
const showBrowser = args.includes('--show');
const daysArg = args.find(a => /^\d+$/.test(a));
const daysBack = Number(daysArg ?? 30);

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const today = new Date();
const fromDate = new Date();
fromDate.setDate(today.getDate() - daysBack);
const fromStr = ymd(fromDate);
const toStr = ymd(today);

console.log(`Scraping ${daysBack} days back: ${fromStr} → ${toStr}`);

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const browser = await puppeteer.launch({
  headless: !showBrowser,
  defaultViewport: { width: 1400, height: 900 },
});

const ACCOUNTS_URL_FRAG = '/available-accounts/ils';
const TXN_DEFAULT_FRAG = '/transactions/default';

const captured = {
  accounts: null,
  txnRequestHeaders: null,
};

try {
  const page = await browser.newPage();

  page.on('request', (req) => {
    if (req.url().includes(TXN_DEFAULT_FRAG) && !captured.txnRequestHeaders) {
      captured.txnRequestHeaders = req.headers();
    }
  });

  page.on('response', async (res) => {
    if (res.status() !== 200) return;
    try {
      if (res.url().includes(ACCOUNTS_URL_FRAG)) {
        captured.accounts = await res.json();
      }
    } catch {}
  });

  console.log('Logging in to Leumi Business…');
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
  console.log('Logged in. Loading transactions page to initialize SPA session…');
  await page.goto(
    'https://hb2.bankleumi.co.il/staticcontent/digitalfront/he/nis-accounts/nis-transactions/?accountIndex=1',
    { waitUntil: 'networkidle2', timeout: 60_000 },
  );
  await new Promise(r => setTimeout(r, 5_000));

  if (!captured.accounts) throw new Error('Failed to capture accounts list');
  if (!captured.txnRequestHeaders) throw new Error('Failed to capture SPA request headers');

  const accounts = captured.accounts.accountsItems ?? [];
  console.log(`\nFound ${accounts.length} account(s):`);
  for (const a of accounts) {
    console.log(`  [${a.accountIndex}] ${a.maskedClientNumber}  ${a.corporateName.trim()}  balance: ₪${a.balanceIncludingToday}`);
  }

  const templateHeaders = { ...captured.txnRequestHeaders };
  for (const h of ['cookie', 'host', ':authority', ':method', ':path', ':scheme']) delete templateHeaders[h];

  const results = [];
  for (const acc of accounts) {
    console.log(`\nFetching ${acc.maskedClientNumber} (${fromStr}→${toStr})…`);
    const resp = await page.evaluate(async (idx, from, to, tplHeaders) => {
      const headers = { ...tplHeaders };
      if (headers['x-message-id']) headers['x-message-id'] = crypto.randomUUID();
      if (headers['x-transaction-id']) headers['x-transaction-id'] = crypto.randomUUID();
      const r = await fetch(
        `/v1/corp/ui-corp-transactions/transactionsbydates/digitalfront/accounts/${idx}/transactions/bydates?periodType=1&fromDate=${from}&toDate=${to}`,
        { credentials: 'include', headers },
      );
      return { status: r.status, body: r.ok ? await r.json() : await r.text() };
    }, acc.accountIndex, fromStr, toStr, templateHeaders);

    if (resp.status !== 200) {
      console.error(`  HTTP ${resp.status}: ${String(resp.body).slice(0, 200)}`);
      continue;
    }

    const body = resp.body;
    const history = body.historyILSTrxItems ?? [];
    const pending = body.todayILSTrxItems ?? body.pendingILSTrxItems ?? [];
    console.log(`  ✓ ${history.length} history + ${pending.length} pending`);
    if (body.additionalTransactionsFlag) {
      console.warn(`  ⚠ additionalTransactionsFlag=true — there may be more transactions beyond this batch`);
    }

    results.push({
      account: {
        accountIndex: acc.accountIndex,
        maskedNumber: acc.maskedClientNumber,
        corporateName: acc.corporateName.trim(),
        balance: acc.balanceIncludingToday,
        iban: body.iban,
      },
      history,
      pending,
      raw: body,
    });
  }

  const meta = { scrapedAt: new Date().toISOString(), fromDate: fromStr, toDate: toStr, daysBack };
  const jsonPath = path.join(outDir, `leumi_${stamp}_${daysBack}d.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, accounts: results }, null, 2), 'utf8');

  const headers = ['account', 'corporateName', 'date', 'effectiveDate', 'description', 'extendedDescription',
                   'amount', 'runningBalance', 'beneficiaryName', 'beneficiaryAccount', 'referenceNumber', 'status'];
  const esc = (v) => v == null ? '' : String(v).replace(/[\r\n,"]/g, ' ').trim();
  const csvRows = [headers.join(',')];
  let total = 0;
  for (const r of results) {
    for (const [status, txns] of [['completed', r.history], ['pending', r.pending]]) {
      for (const t of txns) {
        csvRows.push([
          r.account.maskedNumber, r.account.corporateName,
          (t.date || '').slice(0, 10), (t.effectiveDate || '').slice(0, 10),
          t.description, t.extendedDescription,
          t.amount, t.runningBalance,
          t.beneficiaryName,
          [t.beneficiaryBankCode, t.beneficiaryBranch, t.beneficiaryAccountNumber].filter(Boolean).join('-'),
          t.referenceNumber, status,
        ].map(esc).join(','));
        total++;
      }
    }
  }
  const csvPath = path.join(outDir, `leumi_${stamp}_${daysBack}d.csv`);
  fs.writeFileSync(csvPath, '﻿' + csvRows.join('\n'), 'utf8');

  console.log(`\nDone. ${results.length} account(s), ${total} transaction(s) over last ${daysBack} days.`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV : ${csvPath}`);
} finally {
  await browser.close();
}
