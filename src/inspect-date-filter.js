import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/bank.env' });

const username = process.env.USER_NAME;
const password = process.env.USER_PASSWARD ?? process.env.USER_PASSWORD;
const loginUrl = process.env.URL;

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();

const apiCalls = [];
page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  if (!url.includes('hb2.bankleumi.co.il/v1/')) return;
  try {
    apiCalls.push({
      method: req.method(),
      url: url.replace('https://hb2.bankleumi.co.il', ''),
      status: res.status(),
      reqBody: req.postData() || null,
      reqHeaders: req.headers(),
      bodyPreview: (await res.text()).slice(0, 800),
    });
  } catch {}
});

console.log('Login…');
await page.goto(loginUrl, { waitUntil: 'networkidle2' });
await page.waitForSelector('input[placeholder="שם משתמש"]');
await page.type('input[placeholder="שם משתמש"]', username, { delay: 30 });
await page.type('input[placeholder="סיסמה"]', password, { delay: 30 });
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').includes('כניסה') && !b.disabled)?.click();
});

await page.waitForFunction(() => location.href.includes('/digitalfront/'), { timeout: 60_000 });
console.log('Going to transactions page…');
await page.goto(
  'https://hb2.bankleumi.co.il/staticcontent/digitalfront/he/nis-accounts/nis-transactions/?accountIndex=1',
  { waitUntil: 'networkidle2', timeout: 60_000 },
);
await new Promise(r => setTimeout(r, 6_000));

const beforeFilter = apiCalls.length;

console.log('\nInspecting form inputs on page…');
const inputs = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('input')).map(el => ({
    name: el.name,
    id: el.id,
    type: el.type,
    placeholder: el.placeholder,
    ariaLabel: el.getAttribute('aria-label'),
    value: el.value,
    classes: el.className.slice(0, 80),
  }));
});
console.log(JSON.stringify(inputs, null, 2));

console.log('\nClicking "מתאריך" button to open from-date picker…');
const opened = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'מתאריך');
  if (btn) { btn.click(); return true; }
  return false;
});
console.log('Opened:', opened);
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: path.join(outDir, 'date_picker_open.png'), fullPage: true });
console.log('Saved date_picker_open.png');

console.log('\nLeaving browser open for 120s — manually set "מתאריך" to 30 days ago and click "סינון". I will capture the API call.');
await new Promise(r => setTimeout(r, 120_000));
await browser.close();

console.log('\n=== API calls AFTER initial page load (filter interaction) ===');
apiCalls.slice(beforeFilter).forEach(c => {
  console.log(`\n${c.method} ${c.status} ${c.url}`);
  if (c.reqBody) console.log(`  REQ BODY: ${c.reqBody}`);
  console.log(`  RES: ${c.bodyPreview.slice(0, 300)}`);
});

fs.writeFileSync(path.join(outDir, 'api_calls_with_filter.json'), JSON.stringify(apiCalls, null, 2), 'utf8');
console.log('\nFull log saved to api_calls_with_filter.json');
