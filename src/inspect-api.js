import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/bank.env' });

const username = process.env.USER_NAME;
const password = process.env.USER_PASSWARD ?? process.env.USER_PASSWORD;
const loginUrl = process.env.URL;

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();

const apiCalls = [];

page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  const ct = res.headers()['content-type'] || '';
  if (!ct.includes('json')) return;
  if (url.includes('/sw.js') || url.includes('translation')) return;
  try {
    const text = await res.text();
    apiCalls.push({
      method: req.method(),
      url,
      status: res.status(),
      reqBody: req.postData() || null,
      bodyPreview: text.slice(0, 2000),
      bodyLength: text.length,
    });
  } catch {}
});

console.log('Login…');
await page.goto(loginUrl, { waitUntil: 'networkidle2' });
await page.waitForSelector('input[placeholder="שם משתמש"]');
await page.type('input[placeholder="שם משתמש"]', username, { delay: 30 });
await page.type('input[placeholder="סיסמה"]', password, { delay: 30 });
await page.evaluate(() => {
  const t = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('כניסה') && !b.disabled);
  t?.click();
});

console.log('Waiting for dashboard…');
await page.waitForFunction(
  () => location.href.includes('/digitalfront/'),
  { timeout: 45_000 },
);
await new Promise(r => setTimeout(r, 5_000));

apiCalls.length = 0;
console.log('Navigating to transactions page…');
await page.goto('https://hb2.bankleumi.co.il/staticcontent/digitalfront/he/nis-accounts/nis-transactions/?accountIndex=1', {
  waitUntil: 'networkidle2',
  timeout: 60_000,
});
await new Promise(r => setTimeout(r, 8_000));

const shot = path.join(outDir, 'transactions_page.png');
await page.screenshot({ path: shot, fullPage: true });
console.log(`Screenshot: ${shot}`);

const txnRelated = apiCalls.filter(c =>
  /trx|transaction|movement|nis|account|history|tnu/i.test(c.url),
);

console.log(`\nTotal JSON responses: ${apiCalls.length}`);
console.log(`Transaction-related: ${txnRelated.length}`);

const apiFile = path.join(outDir, 'api_calls.json');
fs.writeFileSync(apiFile, JSON.stringify(apiCalls, null, 2), 'utf8');
console.log(`All API calls: ${apiFile}`);

console.log('\n=== Transaction-related calls ===');
for (const c of txnRelated) {
  console.log(`\n${c.method} ${c.status} ${c.url}`);
  if (c.reqBody) console.log(`  REQ: ${c.reqBody.slice(0, 300)}`);
  console.log(`  RES (${c.bodyLength}b): ${c.bodyPreview.slice(0, 400)}`);
}

console.log('\nLeaving browser open for 30s…');
await new Promise(r => setTimeout(r, 30_000));
await browser.close();
