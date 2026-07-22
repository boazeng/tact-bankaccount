import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

// No credentials read from env — you log in manually (incl. SMS 2FA) in the
// visible browser window this script opens. We only capture network traffic
// in the background. Manual login (not the automated fill-and-submit flow
// used by the sync scraper) is used deliberately: automated Mizrachi logins
// have tripped SiteMinder bot detection before (see get428Index issues).
const protectedUrl = process.env.MIZRACHI_URL || 'https://mto.mizrahi-tefahot.co.il/OnlineApp/index.html';

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
  if (!/mizrahi|mizrachi|tefahot/i.test(host)) return;
  const ct = res.headers()['content-type'] || '';
  const rt = req.resourceType();
  const isLegacyPage = /legacy|Loan|P060|P513/i.test(url);
  if (!ct.includes('json') && rt !== 'xhr' && rt !== 'fetch' && !isLegacyPage) return;
  try {
    const body = await res.text();
    apiCalls.push({
      ts: Date.now(),
      method: req.method(),
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      status: res.status(),
      resourceType: rt,
      contentType: ct,
      reqBody: req.postData() || null,
      body,
      bodyLength: body.length,
    });
  } catch {}
});

console.log(`Step 1: Navigating to: ${protectedUrl}`);
await page.goto(protectedUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
console.log(`URL: ${page.url()}`);

console.log('\n=== Manual step ===');
console.log('Browser is open for 12 minutes. Please:');
console.log('  1. Log in manually (incl. SMS 2FA if prompted).');
console.log('  2. Click into the "פקדונות" (deposits) screen via the menu, let it fully load.');
console.log('  3. Click into the "הלוואות" (loans) screen via the menu, let it fully load.');
console.log('  4. Click into the "ערבויות" (guarantees) screen via the menu, let it fully load.');
console.log('     (If a category doesn\'t exist for this business, skip it.)');
console.log('  5. If any screen shows a list, open ONE item\'s detail view too.');
console.log('I will capture all relevant API calls in the background.');
console.log('Close the browser window when done, or just wait for the timeout.');

const browserClosed = new Promise(resolve => browser.on('disconnected', resolve));
await Promise.race([
  new Promise(r => setTimeout(r, 12 * 60 * 1000)),
  browserClosed,
]);

try {
  await page.screenshot({ path: path.join(outDir, 'mizrachi_deposits_loans_99_final.png'), fullPage: true });
  console.log(`\nFinal URL: ${page.url()}`);
} catch {
  console.log('\n(browser was closed before final screenshot)');
}

try { await browser.close(); } catch {}

console.log(`\n=== ${apiCalls.length} API calls captured ===`);
const uniqueUrls = [...new Set(apiCalls.map(c => c.method + ' ' + c.url.split('?')[0]))];
console.log(`Unique endpoints (${uniqueUrls.length}):`);
uniqueUrls.forEach(u => console.log(`  ${u}`));

fs.writeFileSync(path.join(outDir, 'mizrachi_deposits_loans_api_calls.json'), JSON.stringify(apiCalls, null, 2), 'utf8');
console.log(`\nAll calls saved to: output/mizrachi_deposits_loans_api_calls.json`);
