import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

// No credentials read from env — you log in manually in the visible browser
// window this script opens. We only capture network traffic in the background.
const homeUrl = process.env.POALIM_URL || 'https://biz2.bankhapoalim.co.il/ng-portals/auth/he/biz-login/authenticate';

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
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  if (!/poalim|hapoalim|isracard|cal-online|max/i.test(host)) return;
  const ct = res.headers()['content-type'] || '';
  const rt = req.resourceType();
  if (!ct.includes('json') && rt !== 'xhr' && rt !== 'fetch') return;
  try {
    const body = await res.text();
    apiCalls.push({
      method: req.method(),
      url,
      status: res.status(),
      reqBody: req.postData() ? req.postData().slice(0, 400) : null,
      bodyPreview: body.slice(0, 2000),
      bodyLength: body.length,
    });
  } catch {}
});

console.log(`Step 1: Navigating to business login: ${homeUrl}`);
await page.goto(homeUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
console.log(`URL: ${page.url()}`);

console.log('\n=== Manual step ===');
console.log('Please log in manually in the open browser (incl. SMS 2FA if prompted),');
console.log('then navigate to the credit card charges screen ("כרטיסי אשראי" / "חיובי כרטיס")');
console.log('and open one card\'s detailed charge list.');
console.log('Browser stays open for 10 minutes; I capture all API calls in the background.');

const browserClosed = new Promise(resolve => browser.on('disconnected', resolve));
await Promise.race([
  new Promise(r => setTimeout(r, 10 * 60 * 1000)),
  browserClosed,
]);

try {
  await page.screenshot({ path: path.join(outDir, 'poalim_cards_99_final.png'), fullPage: true });
  console.log(`\nFinal URL: ${page.url()}`);
} catch {
  console.log('\n(browser was closed before final screenshot)');
}

try { await browser.close(); } catch {}

const cardRelated = apiCalls.filter(c =>
  /card|כרטיס|creditcard|billing|charge|isracard|cal-online/i.test(c.url) ||
  /card|כרטיס|creditcard|charge/i.test(c.bodyPreview || ''),
);
console.log(`\n=== ${apiCalls.length} total API calls, ${cardRelated.length} likely card-related ===`);
const uniqueUrls = [...new Set(cardRelated.map(c => c.method + ' ' + c.url.split('?')[0]))];
console.log(`\nUnique card-related endpoints (${uniqueUrls.length}):`);
uniqueUrls.forEach(u => console.log(`  ${u}`));

for (const c of cardRelated.slice(0, 30)) {
  console.log(`\n${c.method} ${c.status} ${c.url}`);
  if (c.reqBody) console.log(`  REQ: ${c.reqBody}`);
  console.log(`  RES (${c.bodyLength}b): ${c.bodyPreview.slice(0, 500)}`);
}

fs.writeFileSync(path.join(outDir, 'poalim_cards_api_calls.json'), JSON.stringify(apiCalls, null, 2), 'utf8');
console.log(`\nAll calls saved to: output/poalim_cards_api_calls.json`);
