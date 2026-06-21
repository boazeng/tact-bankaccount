import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/bank.env' });

const userId = process.env.DISCOUNT_USER_ID ?? process.env.USER_ID;
const password = process.env.DISCOUNT_PASSWORD ?? process.env.USER_PASSWORD;
const loginUrl = process.env.DISCOUNT_URL ?? process.env.URL_LOGIN;

if (!userId || !password || !loginUrl) {
  console.error('Missing Discount credentials in bank.env');
  process.exit(1);
}

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });

console.log(`Login URL: ${loginUrl}`);

const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();

const apiCalls = [];
page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  const host = new URL(url).hostname;
  if (!/telebank|discount|bankdiscount/i.test(host)) return;
  const ct = res.headers()['content-type'] || '';
  const isJsonLike = ct.includes('json') || url.includes('/api/');
  if (!isJsonLike && req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
  try {
    const body = await res.text();
    apiCalls.push({
      method: req.method(),
      url: url.replace(/^https?:\/\/[^/]+/, host === 'start.telebank.co.il' ? '' : `[${host}]`),
      status: res.status(),
      reqBody: req.postData() ? req.postData().slice(0, 400) : null,
      reqHeaders: req.headers(),
      bodyPreview: body.slice(0, 1500),
      bodyLength: body.length,
    });
  } catch {}
});

console.log('Step 1: Navigating to login page (LOGIN_PAGE_SME for business)…');
await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise(r => setTimeout(r, 3_000));
await page.screenshot({ path: path.join(outDir, 'discount_01_login.png'), fullPage: false });

const formStructure = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
    name: el.name, id: el.id, type: el.type,
    placeholder: el.placeholder, aria: el.getAttribute('aria-label'),
  }));
  const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).map(el => ({
    tag: el.tagName, text: (el.textContent || el.value || '').trim().slice(0, 40),
    aria: el.getAttribute('aria-label'), type: el.getAttribute('type'),
  }));
  const title = (document.querySelector('h1, h2, h3')?.textContent || '').trim();
  return { title, inputs, buttons };
});
console.log(`Form title: "${formStructure.title}"`);
console.log(`Inputs (${formStructure.inputs.length}):`, JSON.stringify(formStructure.inputs, null, 2));
console.log(`Buttons:`, JSON.stringify(formStructure.buttons, null, 2));

if (formStructure.inputs.length > 3) {
  console.warn('⚠ More than 3 inputs — may be on personal form (3 fields) instead of SME (2 fields).');
}

console.log('\nStep 2: Filling credentials…');
await page.evaluate((uid, pwd) => {
  const inputs = Array.from(document.querySelectorAll('input'));
  const setVal = (input, val) => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    native.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const idInput = inputs.find(i => /זהות|id|userid/i.test((i.placeholder || '') + (i.getAttribute('aria-label') || '') + i.name + i.id));
  const pwdInput = inputs.find(i => i.type === 'password' || /סיסמה|password/i.test((i.placeholder || '') + (i.getAttribute('aria-label') || '') + i.name + i.id));
  if (idInput) setVal(idInput, uid);
  if (pwdInput) setVal(pwdInput, pwd);
}, userId, password);
await new Promise(r => setTimeout(r, 1_000));

console.log('Step 3: Clicking "כניסה" button…');
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
    .find(b => /כניסה/.test((b.textContent || b.value || '')) && !b.disabled);
  btn?.click();
});

console.log('Step 4: Waiting for navigation after login (up to 30s)…');
try {
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 });
} catch {
  console.log('  (no full navigation — likely SPA route change)');
}
await new Promise(r => setTimeout(r, 4_000));
await page.screenshot({ path: path.join(outDir, 'discount_02_after_login.png'), fullPage: false });
console.log(`URL after login: ${page.url()}`);

console.log('\nStep 5: Browser open for 2 minutes. Please navigate manually to:');
console.log('  - The accounts list / dashboard');
console.log('  - One account\'s transactions page');
console.log('I will capture all API calls.');

await new Promise(r => setTimeout(r, 120_000));

await page.screenshot({ path: path.join(outDir, 'discount_99_final.png'), fullPage: true });
console.log(`\nFinal URL: ${page.url()}`);

await browser.close();

const txnRelated = apiCalls.filter(c =>
  /trans|movement|account|debit|credit|history|balance|tnu|portfolio/i.test(c.url),
);
console.log(`\n=== ${apiCalls.length} total API calls, ${txnRelated.length} likely transaction-related ===`);
for (const c of txnRelated.slice(0, 20)) {
  console.log(`\n${c.method} ${c.status} ${c.url}`);
  if (c.reqBody) console.log(`  REQ: ${c.reqBody}`);
  console.log(`  RES (${c.bodyLength}b): ${c.bodyPreview.slice(0, 350)}`);
}

fs.writeFileSync(path.join(outDir, 'discount_api_calls.json'), JSON.stringify(apiCalls, null, 2), 'utf8');
console.log(`\nAll API calls saved to: output/discount_api_calls.json`);
