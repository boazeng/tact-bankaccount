// Quick check: fetch the Ariel Discount account's transactions for a date range
// that should include ₪24 fees, and dump the FULL raw response to see where the
// fee transactions are stored (if not in OperationEntry).
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/bank.env' });

const userId = process.env.DISCOUNT_USER_ID;
const password = process.env.DISCOUNT_PASSWORD;
const loginUrl = process.env.DISCOUNT_URL;

const ACCOUNT = '0213477280';   // Ariel
const FROM = '20260427';
const TO = '20260528';

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();

let txnRequestHeaders = null;
page.on('request', (req) => {
  if (req.url().includes('/transactions/default') && !txnRequestHeaders) {
    txnRequestHeaders = req.headers();
  }
});

console.log('Logging in to Discount…');
await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
await page.waitForSelector('input#tzId', { timeout: 30_000 });
await page.evaluate((uid, pwd) => {
  const setVal = (el, v) => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    native.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setVal(document.querySelector('#tzId'), uid);
  setVal(document.querySelector('#tzPassword'), pwd);
}, userId, password);
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button'))
    .find(b => /כניסה/.test(b.textContent || '') && !b.disabled)?.click();
});
await page.waitForFunction(() => location.href.includes('/apollo/business'), { timeout: 60_000 });
console.log('Logged in, loading transactions page…');
await page.goto('https://start.telebank.co.il/apollo/business2/#/OSH_LENTRIES_ALTAMIRA',
  { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise(r => setTimeout(r, 8_000));

if (!txnRequestHeaders) {
  console.log('Did not capture headers from default endpoint, trying alternative…');
  // Try the bydates endpoint instead
  page.removeAllListeners('request');
}

const tplHeaders = { ...(txnRequestHeaders || {}) };
for (const h of ['cookie', 'host', ':authority', ':method', ':path', ':scheme', 'content-length']) delete tplHeaders[h];

console.log(`\nFetching transactions for account ${ACCOUNT} between ${FROM} and ${TO}…`);
const resp = await page.evaluate(async (accNum, from, to, hdrs) => {
  const headers = { ...hdrs, accountnumber: accNum };
  const r = await fetch(
    `/Titan/gatewayAPI/lastTransactions/transactions/${accNum}/ByDate?FromDate=${from}&ToDate=${to}&IsTransactionDetails=True&IsFutureTransactionFlag=True&IsEventNames=True&IsCategoryDescCode=True`,
    { credentials: 'include', headers },
  );
  return { status: r.status, text: await r.text() };
}, ACCOUNT, FROM, TO, tplHeaders);

console.log(`Status: ${resp.status}`);
console.log(`Body length: ${resp.text.length}`);
fs.writeFileSync(path.join(outDir, 'discount_ariel_raw.json'), resp.text, 'utf8');

const body = JSON.parse(resp.text || '{}');
console.log('\nTop-level keys:', Object.keys(body).join(', '));
const ccla = body.CurrentAccountLastTransactions || {};
console.log('CurrentAccountLastTransactions keys:', Object.keys(ccla).join(', '));

for (const k of Object.keys(ccla)) {
  const v = ccla[k];
  if (Array.isArray(v)) {
    console.log(`  ${k}: array of ${v.length} items`);
    if (v.length) {
      const sampleKeys = Object.keys(v[0]).join(', ');
      console.log(`    Item keys: ${sampleKeys.slice(0, 200)}`);
    }
  } else if (typeof v === 'object' && v !== null) {
    console.log(`  ${k}: object {${Object.keys(v).join(', ')}}`);
  } else {
    console.log(`  ${k}: ${typeof v} = ${String(v).slice(0, 80)}`);
  }
}

await browser.close();
console.log('\nFull response saved to output/discount_ariel_raw.json');
