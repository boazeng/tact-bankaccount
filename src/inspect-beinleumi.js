// Interactive exploration for בנק הבינלאומי (FIBI, fibi.co.il/business).
//
// Opens a REAL, VISIBLE browser window and lets the human log in by hand —
// this script never touches a username or password. It only listens to
// network traffic on fibi.co.il hosts and logs it, plus takes periodic
// screenshots, so the login/dashboard flow can be reconstructed afterward
// without ever seeing the credentials.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const HOME_URL = process.env.BEINLEUMI_URL || 'https://www.fibi.co.il/business/';
const outDir = path.resolve('output');
const profileDir = path.resolve('output/beinleumi-profile');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

const logPath = path.join(outDir, 'beinleumi_log.txt');
const apiPath = path.join(outDir, 'beinleumi_api_calls.jsonl');
const shotPath = path.join(outDir, 'beinleumi_live.png');

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
};

fs.writeFileSync(logPath, '');
fs.writeFileSync(apiPath, '');

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: profileDir,
  defaultViewport: null,
  args: ['--start-maximized'],
});
const [page] = await browser.pages();

page.on('response', async (res) => {
  try {
    const url = res.url();
    const host = new URL(url).hostname;
    if (!/fibi/i.test(host)) return;
    const req = res.request();
    const ct = res.headers()['content-type'] || '';
    const rt = req.resourceType();
    if (!ct.includes('json') && rt !== 'xhr' && rt !== 'fetch') return;
    const body = await res.text();
    fs.appendFileSync(apiPath, JSON.stringify({
      t: new Date().toISOString(),
      method: req.method(),
      url,
      status: res.status(),
      reqBody: req.postData() ? req.postData().slice(0, 500) : null,
      bodyPreview: body.slice(0, 2000),
      bodyLength: body.length,
    }) + '\n');
  } catch {}
});

log(`Navigating to ${HOME_URL}`);
await page.goto(HOME_URL, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(e => log(`goto warning: ${e.message}`));
await page.screenshot({ path: shotPath }).catch(() => {});
log('Ready — please log in by hand in the opened browser window.');

const TOTAL_MS = 20 * 60 * 1000;
const INTERVAL_MS = 3_000;
const start = Date.now();
let lastUrl = null;
while (Date.now() - start < TOTAL_MS) {
  await new Promise(r => setTimeout(r, INTERVAL_MS));
  try {
    const url = page.url();
    if (url !== lastUrl) {
      log(`URL changed -> ${url}`);
      lastUrl = url;
    }
    await page.screenshot({ path: shotPath });
  } catch (e) {
    log(`poll warning: ${e.message}`);
  }
}

log('Timeout reached — closing browser.');
await browser.close();
