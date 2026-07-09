import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

// No credentials read from env — you log in manually in the visible browser
// window this script opens. We only capture network traffic in the background.
const loginUrl = process.env.DISCOUNT_URL || 'https://start.telebank.co.il/login/#/LOGIN_PAGE_SME';

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

const apiCalls = [];
page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  if (!/telebank|discount|bankdiscount|cal-online|max|isracard/i.test(host)) return;
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
      bodyPreview: body.slice(0, 2000),
      bodyLength: body.length,
    });
  } catch {}
});

console.log('Step 1: Navigating to login page…');
await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
await page.bringToFront();

console.log('\n=== Manual step ===');
console.log('Browser is open for 5 minutes. Please:');
console.log('  1. Log in manually.');
console.log('  2. Navigate to the credit card charges screen ("כרטיסי אשראי" / "חיובי כרטיס").');
console.log('  3. Open one card\'s detailed charge list.');
console.log('  4. Use the MONTH SELECTOR on that screen to pick the PREVIOUS month\'s');
console.log('     charges (not the current/default one) and let it load.');
console.log('I will capture all relevant API calls in the background — no need to tell me anything.');

await new Promise(r => setTimeout(r, 300_000));

try {
  await page.screenshot({ path: path.join(outDir, 'discount_cards_99_final.png'), fullPage: true });
} catch {}
console.log(`\nFinal URL: ${page.url()}`);

await browser.close();

const cardRelated = apiCalls.filter(c =>
  /card|כרטיס|cal-online|creditcard|billing|charge/i.test(c.url) ||
  /card|כרטיס|creditcard|charge/i.test(c.bodyPreview || ''),
);
console.log(`\n=== ${apiCalls.length} total API calls, ${cardRelated.length} likely card-related ===`);
for (const c of cardRelated.slice(0, 30)) {
  console.log(`\n${c.method} ${c.status} ${c.url}`);
  if (c.reqBody) console.log(`  REQ: ${c.reqBody}`);
  console.log(`  RES (${c.bodyLength}b): ${c.bodyPreview.slice(0, 500)}`);
}

fs.writeFileSync(path.join(outDir, 'discount_cards_api_calls.json'), JSON.stringify(apiCalls, null, 2), 'utf8');
console.log(`\nAll API calls saved to: output/discount_cards_api_calls.json`);
