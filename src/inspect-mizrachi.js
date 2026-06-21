import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/bank.env' });

const userId = process.env.MIZRACHI_USER_ID;
const password = process.env.MIZRACHI_PASSWORD;
const homeUrl = process.env.MIZRACHI_URL || 'https://www.mizrahi-tefahot.co.il/';

if (!userId || !password) {
  console.error('Missing MIZRACHI_USER_ID / MIZRACHI_PASSWORD in bank.env');
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
  if (!/mizrahi|mizrachi|tefahot/i.test(host)) return;
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

console.log(`Step 1: Navigating to ${homeUrl}`);
await page.goto(homeUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
await new Promise(r => setTimeout(r, 2_500));
await page.screenshot({ path: path.join(outDir, 'mizrachi_01_home.png'), fullPage: false });

console.log('\nStep 2: Scanning for login links on homepage…');
const loginLinks = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('a, button'))
    .filter(el => {
      const t = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.title || '')).trim();
      return /כניסה|התחברות|עסקי|biz|business|login/i.test(t);
    })
    .slice(0, 15)
    .map(el => ({
      tag: el.tagName,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      aria: el.getAttribute('aria-label'),
      href: el.tagName === 'A' ? el.href : null,
    }));
});
console.log('Login-related candidates:');
loginLinks.forEach((l, i) => console.log(`  ${i}: [${l.tag}] "${l.text}" ${l.href ? '→ ' + l.href : ''}`));

console.log('\n=== Manual step ===');
console.log(`User ID:  ${userId}`);
console.log(`Password: ${password.replace(/./g, '*')} (${password.length} chars)`);
console.log('Please navigate to the BUSINESS login, enter credentials, handle SMS, and reach transactions.');
console.log('Browser stays open until you close it or 10 minutes elapse.');

const browserClosed = new Promise(resolve => browser.on('disconnected', resolve));
await Promise.race([
  new Promise(r => setTimeout(r, 10 * 60 * 1000)),
  browserClosed,
]);

try {
  await page.screenshot({ path: path.join(outDir, 'mizrachi_99_final.png'), fullPage: true });
  console.log(`\nFinal URL: ${page.url()}`);
} catch {
  console.log('\n(browser was closed)');
}

try { await browser.close(); } catch {}

const uniqueUrls = [...new Set(apiCalls.map(c => c.method + ' ' + c.url.split('?')[0]))];
console.log(`\n=== ${apiCalls.length} total API calls, ${uniqueUrls.length} unique endpoints ===`);
uniqueUrls.forEach(u => console.log(`  ${u}`));

fs.writeFileSync(path.join(outDir, 'mizrachi_api_calls.json'), JSON.stringify(apiCalls, null, 2), 'utf8');
console.log(`\nAll calls saved to: output/mizrachi_api_calls.json`);
