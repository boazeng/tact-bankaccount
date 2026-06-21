import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/bank.env' });

const userId = process.env.POALIM_USER_ID;
const password = process.env.POALIM_PASSWORD;
const homeUrl = process.env.POALIM_URL || 'https://www.bankhapoalim.biz/he';

if (!userId || !password) {
  console.error('Missing POALIM_USER_ID / POALIM_PASSWORD in bank.env');
  process.exit(1);
}

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--start-maximized'],
});
const [page] = await browser.pages();

const apiCalls = [];
page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  const host = new URL(url).hostname;
  if (!/poalim|hapoalim/i.test(host)) return;
  const ct = res.headers()['content-type'] || '';
  const rt = req.resourceType();
  if (!ct.includes('json') && rt !== 'xhr' && rt !== 'fetch') return;
  try {
    const body = await res.text();
    apiCalls.push({
      method: req.method(),
      url: url.replace(/^https?:\/\/[^/]+/, host === new URL(homeUrl).hostname ? '' : `[${host}]`),
      status: res.status(),
      reqBody: req.postData() ? req.postData().slice(0, 400) : null,
      reqHeaders: req.headers(),
      bodyPreview: body.slice(0, 1500),
      bodyLength: body.length,
    });
  } catch {}
});

console.log(`Step 1: Navigating directly to business login: ${homeUrl}`);
await page.goto(homeUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise(r => setTimeout(r, 3_000));
await page.screenshot({ path: path.join(outDir, 'poalim_02_login_form.png'), fullPage: false });
console.log(`URL: ${page.url()}`);

console.log('\nStep 3: Inspecting login form on resulting page…');
const formInfo = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
    name: el.name, id: el.id, type: el.type,
    placeholder: el.placeholder, aria: el.getAttribute('aria-label'),
    visible: el.offsetWidth > 0 && el.offsetHeight > 0,
  })).filter(i => i.visible);
  const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).map(el => ({
    tag: el.tagName,
    text: (el.textContent || el.value || '').trim().slice(0, 50),
    aria: el.getAttribute('aria-label'),
    type: el.getAttribute('type'),
    visible: el.offsetWidth > 0 && el.offsetHeight > 0,
  })).filter(b => b.visible);
  const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id }));
  return { inputs, buttons, iframes };
});
console.log('Inputs:', JSON.stringify(formInfo.inputs, null, 2));
console.log('Buttons:', JSON.stringify(formInfo.buttons, null, 2));
if (formInfo.iframes.length) console.log('Iframes:', JSON.stringify(formInfo.iframes, null, 2));

console.log('\n=== Manual step ===');
console.log(`Please log in manually in the open browser:`);
console.log(`  User ID:  ${userId}`);
console.log(`  Password: ${password.replace(/./g, '*')} (${password.length} chars)`);
console.log(`  Then handle SMS 2FA + navigate to the transactions page for one account.`);
console.log('Browser stays open for 5 minutes; I capture all API calls.');

// Wait until either timeout (10 min) or user closes the browser
const browserClosed = new Promise(resolve => browser.on('disconnected', resolve));
await Promise.race([
  new Promise(r => setTimeout(r, 10 * 60 * 1000)),
  browserClosed,
]);

try {
  await page.screenshot({ path: path.join(outDir, 'poalim_99_final.png'), fullPage: true });
  console.log(`\nFinal URL: ${page.url()}`);
} catch {
  console.log('\n(browser was closed before final screenshot)');
}

try { await browser.close(); } catch {}

const interesting = apiCalls.filter(c =>
  /trans|movement|account|balance|portfolio|customer|osh/i.test(c.url),
);
console.log(`\n=== ${apiCalls.length} total API calls, ${interesting.length} interesting ===`);
const uniqueUrls = [...new Set(apiCalls.map(c => c.method + ' ' + c.url.split('?')[0]))];
console.log(`\nUnique endpoints (${uniqueUrls.length}):`);
uniqueUrls.forEach(u => console.log(`  ${u}`));

fs.writeFileSync(path.join(outDir, 'poalim_api_calls.json'), JSON.stringify(apiCalls, null, 2), 'utf8');
console.log(`\nAll calls saved to: output/poalim_api_calls.json`);
