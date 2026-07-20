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

const setCookieHits = [];
const apiCalls = [];

page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  if (!/bankleumi|leumi/i.test(host)) return;

  // Check EVERY response (not just json/xhr) for a Set-Cookie carrying
  // cochavSessionId — the earlier capture only looked at xhr/fetch/json
  // responses and found nothing, meaning it's most likely set on the actual
  // document/navigation response instead.
  const headers = res.headers();
  const setCookie = headers['set-cookie'] || '';
  if (/cochavSessionId/i.test(setCookie)) {
    setCookieHits.push({ url, status: res.status(), setCookie, resourceType: req.resourceType() });
  }

  const ct = headers['content-type'] || '';
  const rt = req.resourceType();
  const isJsonLike = ct.includes('json') || url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/') || url.includes('Broker.svc');
  const isDoc = rt === 'document';
  if (!isJsonLike && !isDoc && rt !== 'xhr' && rt !== 'fetch') return;
  try {
    const body = isDoc ? '' : await res.text();
    const isCardRelated = /card|כרטיס|Broker\.svc/i.test(url) || /card|כרטיס/i.test(body);
    apiCalls.push({
      method: req.method(),
      url: url.replace(/^https?:\/\/[^/]+/, host === 'hb2.bankleumi.co.il' ? '' : `[${host}]`),
      status: res.status(),
      resourceType: rt,
      resHeaders: headers,
      reqBody: req.postData() ? (isCardRelated ? req.postData() : req.postData().slice(0, 400)) : null,
      bodyPreview: isDoc ? '(document, body not captured)' : (isCardRelated ? body : body.slice(0, 2000)),
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
console.log('  2. Navigate to the credit card charges screen ("כרטיסי אשראי" / "חיובי כרטיס") by');
console.log('     CLICKING THE MENU LINK (not typing a URL) — I need to see the real URL it lands on.');
console.log('  3. Open one card\'s detailed charge list.');
console.log('  4. Use the MONTH SELECTOR on that screen to pick the PREVIOUS (closed) month\'s');
console.log('     charges (not the current/default one) and let it load.');
console.log('I will capture all relevant API calls + navigations + cookies in the background.');

const browserClosed = new Promise(resolve => browser.on('disconnected', resolve));
await Promise.race([
  new Promise(r => setTimeout(r, 10 * 60 * 1000)),
  browserClosed,
]);

try {
  await page.screenshot({ path: path.join(outDir, 'leumi_cards_99_final.png'), fullPage: true });
  console.log(`\nFinal URL: ${page.url()}`);
} catch {
  console.log('\n(browser was closed before final screenshot)');
}

try { await browser.close(); } catch {}

console.log(`\n=== ${navigations.length} top-level navigations ===`);
navigations.forEach(n => console.log(`  ${n.url}`));

console.log(`\n=== ${setCookieHits.length} response(s) that set cochavSessionId ===`);
setCookieHits.forEach(h => console.log(`  [${h.resourceType}] ${h.status} ${h.url}\n    Set-Cookie: ${h.setCookie}`));

fs.writeFileSync(path.join(outDir, 'leumi_navigations.json'), JSON.stringify(navigations, null, 2), 'utf8');
fs.writeFileSync(path.join(outDir, 'leumi_set_cookie_hits.json'), JSON.stringify(setCookieHits, null, 2), 'utf8');
fs.writeFileSync(path.join(outDir, 'leumi_cards_api_calls_v4.json'), JSON.stringify(apiCalls, null, 2), 'utf8');
console.log(`\nSaved: leumi_navigations.json, leumi_set_cookie_hits.json, leumi_cards_api_calls_v4.json`);
