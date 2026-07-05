// Diagnostic — the scraper's raw fetch() to get428Index is being bounced by
// Radware Bot Manager (see mizrachi.js comments). This script logs in, then
// lets you manually click through the real UI to view one account's
// transactions, while recording:
//   1. every DOM element you click (so we know the real navigation path)
//   2. every API call after login, full request + response (so we can see
//      what a UI-triggered get428Index call looks like vs. our failing one)
// Run it, log in is automatic, then in the open browser navigate to the
// transactions screen for any one account and let it load. Close the
// browser when you see the transaction list on screen.
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
      reqHeaders: req.headers(),
      reqBody: req.postData() || null,
      resHeaders: res.headers(),
      body: text,
    });
  } catch {}
});

const clickLog = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('[CLICK]')) clickLog.push({ ts: Date.now(), detail: text.slice(8) });
});

async function installClickLogger(p) {
  await p.evaluateOnNewDocument(() => {
    document.addEventListener('click', (e) => {
      const describe = (el) => {
        if (!el || el.nodeType !== 1) return '';
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
          : '';
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
      };
      const chain = [];
      let node = e.target;
      for (let i = 0; i < 4 && node; i++) {
        chain.push(describe(node));
        node = node.parentElement;
      }
      console.log('[CLICK]' + chain.join(' < '));
    }, true);
  });
}
await installClickLogger(page);

console.log('Step 1: Login to Mizrachi…');
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

console.log('If SMS is requested, enter the code in the open browser window yourself.');
console.log('Waiting for dashboard…');
await page.waitForFunction(
  () => location.hostname.includes('mto.mizrahi-tefahot.co.il') && location.pathname.includes('/OnlineApp/'),
  { timeout: 120_000 },
).catch(() => {});

const loginEnd = Date.now();
console.log('\n=== Manual step ===');
console.log('In the open browser, navigate to view TRANSACTIONS for any one account');
console.log('(exactly like you normally would). Wait for the transaction list to render.');
console.log('Then close the browser window (X) to finish.');
console.log('I will record every click and every API call.');

const closed = new Promise(resolve => browser.on('disconnected', resolve));
await Promise.race([closed, new Promise(r => setTimeout(r, 10 * 60 * 1000))]);

try { await browser.close(); } catch {}

const afterLogin = calls.filter(c => c.ts > loginEnd);
console.log(`\nTotal API calls after login: ${afterLogin.length}`);
console.log(`Total clicks recorded: ${clickLog.length}`);

console.log('\n--- Click sequence (in order) ---');
clickLog.forEach((c, i) => console.log(`  ${i + 1}. ${c.detail}`));

const txnCalls = afterLogin.filter(c => /get428Index|SkyOSH/i.test(c.url));
console.log(`\n--- Transaction-related API calls: ${txnCalls.length} ---`);
for (const c of txnCalls) {
  console.log(`\n[${c.method} ${c.url}] status=${c.status}`);
  console.log('reqHeaders:', JSON.stringify(c.reqHeaders, null, 2));
  console.log('reqBody:', c.reqBody);
  console.log('bodyLength:', c.body.length, 'bodyPreview:', c.body.slice(0, 300));
}

fs.writeFileSync(
  path.join(outDir, 'mizrachi_ui_transactions.json'),
  JSON.stringify({ loginEndTs: loginEnd, clickLog, calls }, null, 2),
  'utf8',
);
console.log(`\nFull dump: output/mizrachi_ui_transactions.json`);
