// Inspect: pull the full Poalim transactions response for סוקולוב 610-118686
// in the date range that has known balance mismatches, so we can find:
//   1. Why small fees (~₪2.55) are missing
//   2. What the ~₪400K missing transaction on 05/05 is
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/bank.env' });

const userId = process.env.POALIM_USER_ID;
const password = process.env.POALIM_PASSWORD;
const loginUrl = process.env.POALIM_URL;

const ACCOUNT_ID = '12-610-118686';
const FROM = '20260427';
const TO = '20260528';

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--start-maximized'],
});
const [page] = await browser.pages();

console.log('Logging in to Poalim (browser visible — enter SMS if prompted)…');
await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
await page.waitForSelector('#user-code', { timeout: 30_000 });
await page.evaluate((uid, pwd) => {
  const setVal = (el, v) => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    native.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setVal(document.querySelector('#user-code'), uid);
  setVal(document.querySelector('#password'), pwd);
}, userId, password);
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button[type="submit"]'))
    .find(b => /כניסה/.test(b.textContent || ''))?.click();
});

console.log('Waiting for dashboard (up to 3 minutes — enter SMS in the bank page if prompted)…');
await page.waitForFunction(
  () => location.href.includes('/ng-portals/biz/he/'),
  { timeout: 180_000 },
);
await new Promise(r => setTimeout(r, 5_000));
console.log('Logged in. Fetching סוקולוב transactions…');

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
}, ACCOUNT_ID, FROM, TO);

console.log(`Status: ${resp.status}, body length: ${resp.text.length}`);
fs.writeFileSync(path.join(outDir, 'poalim_sokolov_raw.json'), resp.text, 'utf8');

if (resp.status === 200) {
  const body = JSON.parse(resp.text);
  console.log('\nTop-level keys:', Object.keys(body).join(', '));
  const txns = body.transactions || [];
  console.log(`\ntransactions[] count: ${txns.length}`);
  if (txns.length) console.log('Transaction keys:', Object.keys(txns[0]).join(', '));

  // Look at all amounts to find missing ones
  console.log('\nAll transactions (date | amount | desc | activityTypeCode | type):');
  txns.sort((a, b) => a.eventDate - b.eventDate).forEach(t => {
    console.log(`  ${t.eventDate} | amt=${t.eventAmount} (type=${t.eventActivityTypeCode}) | tt=${t.transactionType} | ref=${t.referenceNumber}/${t.referenceCatenatedNumber} | ${t.activityDescription}`);
  });

  // Check for other arrays
  for (const k of Object.keys(body)) {
    if (Array.isArray(body[k]) && k !== 'transactions') {
      console.log(`\nAdditional array: ${k} (${body[k].length} items)`);
      if (body[k].length) console.log('  Sample:', JSON.stringify(body[k][0]).slice(0, 300));
    }
  }
}

await browser.close();
console.log('\nFull response saved to: output/poalim_sokolov_raw.json');
