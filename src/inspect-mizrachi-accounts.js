// Focused inspector — capture full API bodies while the user switches between
// Mizrachi accounts in the UI, so we can identify the account-list and
// account-switch endpoints.
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/bank.env' });

const userId = process.env.MIZRACHI_USER_ID;
const password = process.env.MIZRACHI_PASSWORD;
const PROTECTED_URL = 'https://mto.mizrahi-tefahot.co.il/OnlineApp/index.html';

if (!userId || !password) {
  console.error('Missing MIZRACHI_USER_ID / MIZRACHI_PASSWORD in bank.env');
  process.exit(1);
}

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: false, defaultViewport: null, args: ['--start-maximized'],
});
const [page] = await browser.pages();

const calls = [];
page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  if (!/mizrahi|mizrachi|tefahot/i.test(new URL(url).hostname)) return;
  const rt = req.resourceType();
  const ct = res.headers()['content-type'] || '';
  if (!ct.includes('json') && rt !== 'xhr' && rt !== 'fetch') return;
  try {
    const text = await res.text();
    calls.push({
      ts: Date.now(),
      method: req.method(),
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      status: res.status(),
      reqBody: req.postData() || null,
      body: text,           // FULL body, not truncated
    });
  } catch {}
});

console.log(`Step 1: Login to Mizrachi…`);
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
  btn?.click();
});

console.log('Waiting for dashboard…');
await page.waitForFunction(
  () => location.hostname.includes('mto.mizrahi-tefahot.co.il') && location.pathname.includes('/OnlineApp/'),
  { timeout: 60_000 },
).catch(() => {});

const loginEnd = Date.now();
console.log('\n=== Manual step ===');
console.log('Now in the open browser:');
console.log('  1. Find the account switcher (usually at top of page)');
console.log('  2. Click it to open the list of accounts');
console.log('  3. Pick a DIFFERENT account from the current one');
console.log('  4. Wait for it to load');
console.log('  5. Close the browser (X) when done');
console.log('I will capture every API call and show you what changed.');

const closed = new Promise(resolve => browser.on('disconnected', resolve));
await Promise.race([closed, new Promise(r => setTimeout(r, 10 * 60 * 1000))]);

try { await browser.close(); } catch {}

console.log(`\nTotal calls: ${calls.length}`);
console.log('Calls AFTER login (post-dashboard, likely related to account switching):');
const afterLogin = calls.filter(c => c.ts > loginEnd);
console.log(`  ${afterLogin.length} calls after login\n`);

// Group by endpoint
const byUrl = {};
for (const c of afterLogin) {
  const key = c.method + ' ' + c.url.split('?')[0];
  (byUrl[key] = byUrl[key] || []).push(c);
}
const sortedKeys = Object.keys(byUrl).sort((a, b) => byUrl[b].length - byUrl[a].length);
console.log('Unique endpoints (most-called first):');
for (const k of sortedKeys) {
  console.log(`  [${byUrl[k].length}×] ${k}`);
}

fs.writeFileSync(path.join(outDir, 'mizrachi_accounts_calls.json'),
  JSON.stringify({ loginEndTs: loginEnd, calls }, null, 2), 'utf8');
console.log(`\nFull dump: output/mizrachi_accounts_calls.json`);
