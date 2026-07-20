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
const client = await page.createCDPSession();
await page.bringToFront();

const apiCalls = [];
const storageSnapshots = [];

// Poll storage on a timer instead of reacting to a single network event —
// the earlier attempt raced an SPA route change and got "execution context
// destroyed" every time. Polling every 3s tolerates that: a failed attempt
// just gets skipped, the next tick tries again.
const pollTimer = setInterval(async () => {
  try {
    const snap = await page.evaluate(() => ({
      cookie: document.cookie,
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      href: location.href,
    }));
    storageSnapshots.push({ t: Date.now(), ...snap });
  } catch {}
}, 3000);

// All cookies via CDP (catches HttpOnly ones document.cookie can't see).
const cdpCookieSnapshots = [];
const cdpCookieTimer = setInterval(async () => {
  try {
    const { cookies } = await client.send('Network.getAllCookies');
    cdpCookieSnapshots.push({ t: Date.now(), cookies });
  } catch {}
}, 5000);

page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  if (!/bankleumi|leumi|cal-online|max|isracard/i.test(host)) return;
  const ct = res.headers()['content-type'] || '';
  const rt = req.resourceType();
  const isJsonLike = ct.includes('json') || url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/') || url.includes('Broker.svc');
  if (!isJsonLike && rt !== 'xhr' && rt !== 'fetch') return;
  try {
    const body = await res.text();
    const isCardRelated = /card|כרטיס|Broker\.svc/i.test(url) || /card|כרטיס/i.test(body);
    apiCalls.push({
      method: req.method(),
      url: url.replace(/^https?:\/\/[^/]+/, host === 'hb2.bankleumi.co.il' ? '' : `[${host}]`),
      status: res.status(),
      reqHeaders: req.headers(),
      resHeaders: res.headers(),
      reqBody: req.postData() ? (isCardRelated ? req.postData() : req.postData().slice(0, 400)) : null,
      bodyPreview: isCardRelated ? body : body.slice(0, 2000),
      bodyLength: body.length,
    });
  } catch {}
});

console.log('Step 1: Navigating to login page…');
await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
await page.bringToFront();

console.log('\n=== Manual step ===');
console.log('Browser is open for 10 minutes. Please:');
console.log('  1. Log in manually.');
console.log('  2. Navigate to the credit card charges screen ("כרטיסי אשראי" / "חיובי כרטיס").');
console.log('  3. Open one card\'s detailed charge list.');
console.log('  4. Use the MONTH SELECTOR on that screen to pick the PREVIOUS (closed) month\'s');
console.log('     charges (not the current/default one) and let it load.');
console.log('I will capture all relevant API calls + storage/cookies in the background.');

const browserClosed = new Promise(resolve => browser.on('disconnected', resolve));
await Promise.race([
  new Promise(r => setTimeout(r, 10 * 60 * 1000)),
  browserClosed,
]);

clearInterval(pollTimer);
clearInterval(cdpCookieTimer);

try {
  await page.screenshot({ path: path.join(outDir, 'leumi_cards_99_final.png'), fullPage: true });
  console.log(`\nFinal URL: ${page.url()}`);
} catch {
  console.log('\n(browser was closed before final screenshot)');
}

try { await browser.close(); } catch {}

fs.writeFileSync(path.join(outDir, 'leumi_storage_snapshots.json'), JSON.stringify(storageSnapshots, null, 2), 'utf8');
fs.writeFileSync(path.join(outDir, 'leumi_cdp_cookies.json'), JSON.stringify(cdpCookieSnapshots, null, 2), 'utf8');

const cardRelated = apiCalls.filter(c =>
  /card|כרטיס|creditcard|billing|charge|isracard|cal-online|Broker\.svc/i.test(c.url) ||
  /card|כרטיס|creditcard|charge/i.test(c.bodyPreview || ''),
);
console.log(`\n=== ${apiCalls.length} total API calls, ${cardRelated.length} likely card-related ===`);
console.log(`Storage snapshots: ${storageSnapshots.length}, cookie snapshots: ${cdpCookieSnapshots.length}`);

// Try to auto-locate the SessionID string used in Broker.svc calls inside
// whatever we captured (cookies, storage, or response bodies/headers).
const sessionIds = [...new Set(
  cardRelated.map(c => (c.reqBody || '').match(/"SessionID":"([^"]+)"/)?.[1]).filter(Boolean),
)];
console.log(`\nObserved SessionID value(s): ${sessionIds.join(', ')}`);
for (const sid of sessionIds) {
  const inStorage = storageSnapshots.some(s => JSON.stringify(s).includes(sid));
  const inCookies = cdpCookieSnapshots.some(s => JSON.stringify(s).includes(sid));
  const inHeaders = apiCalls.some(c => JSON.stringify(c.reqHeaders).includes(sid) || JSON.stringify(c.resHeaders).includes(sid));
  console.log(`  ${sid}: inStorage=${inStorage} inCookies=${inCookies} inHeaders=${inHeaders}`);
}

fs.writeFileSync(path.join(outDir, 'leumi_cards_api_calls_v3.json'), JSON.stringify(apiCalls, null, 2), 'utf8');
console.log(`\nAll calls saved to: output/leumi_cards_api_calls_v3.json`);
