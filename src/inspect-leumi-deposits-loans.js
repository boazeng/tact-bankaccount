import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

// No credentials read from env — you log in manually in the visible browser
// window this script opens. We only capture network traffic in the background.
const loginUrl = process.env.LEUMI_URL || process.env.URL || 'https://hb2.bankleumi.co.il/';

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });

console.log(`Login URL: ${loginUrl}`);

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--start-maximized', '--new-window'],
});
const [page] = await browser.pages();
await page.bringToFront();

const navigations = [];
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) navigations.push({ t: Date.now(), url: frame.url() });
});

const apiCalls = [];
page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  if (!/bankleumi|leumi/i.test(host)) return;

  const headers = res.headers();
  const ct = headers['content-type'] || '';
  const rt = req.resourceType();
  const isJsonLike = ct.includes('json') || url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/');
  if (!isJsonLike && rt !== 'xhr' && rt !== 'fetch') return;
  try {
    const body = await res.text();
    apiCalls.push({
      ts: Date.now(),
      method: req.method(),
      url: url.replace(/^https?:\/\/[^/]+/, host === 'hb2.bankleumi.co.il' ? '' : `[${host}]`),
      status: res.status(),
      reqBody: req.postData() || null,
      body,
      bodyLength: body.length,
    });
  } catch {}
});

console.log('Step 1: Navigating to login page…');
await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
await page.bringToFront();

const loginMarkerIdx = { value: -1 };

console.log('\n=== Manual step ===');
console.log('Browser is open for 12 minutes. Please:');
console.log('  1. Log in manually.');
console.log('  2. Click into the "פקדונות" (deposits) screen via the menu, let it fully load.');
console.log('  3. Click into the "הלוואות" (loans) screen via the menu, let it fully load.');
console.log('  4. Click into the "ערבויות" (guarantees) screen via the menu, let it fully load.');
console.log('     (If a category doesn\'t exist for this business, skip it.)');
console.log('  5. If any screen shows a list, open ONE item\'s detail view too.');
console.log('I will capture all relevant API calls + navigations in the background.');
console.log('Close the browser window when done, or just wait for the timeout.');

loginMarkerIdx.value = apiCalls.length;

const browserClosed = new Promise(resolve => browser.on('disconnected', resolve));
await Promise.race([
  new Promise(r => setTimeout(r, 12 * 60 * 1000)),
  browserClosed,
]);

try {
  await page.screenshot({ path: path.join(outDir, 'leumi_deposits_loans_99_final.png'), fullPage: true });
  console.log(`\nFinal URL: ${page.url()}`);
} catch {
  console.log('\n(browser was closed before final screenshot)');
}

try { await browser.close(); } catch {}

console.log(`\n=== ${navigations.length} top-level navigations ===`);
navigations.forEach(n => console.log(`  ${n.url}`));

console.log(`\n=== ${apiCalls.length} API calls captured ===`);
const uniqueUrls = [...new Set(apiCalls.map(c => c.method + ' ' + c.url.split('?')[0]))];
console.log(`Unique endpoints (${uniqueUrls.length}):`);
uniqueUrls.forEach(u => console.log(`  ${u}`));

fs.writeFileSync(path.join(outDir, 'leumi_navigations.json'), JSON.stringify(navigations, null, 2), 'utf8');
fs.writeFileSync(path.join(outDir, 'leumi_deposits_loans_api_calls.json'), JSON.stringify(apiCalls, null, 2), 'utf8');
console.log(`\nSaved: leumi_navigations.json, leumi_deposits_loans_api_calls.json`);
