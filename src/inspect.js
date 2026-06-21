import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: 'C:/Users/User/Aiprojects/env/bank.env' });

const username = process.env.USER_NAME;
const password = process.env.USER_PASSWARD ?? process.env.USER_PASSWORD;
const url = process.env.URL ?? 'https://www.leumi.co.il/he';

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();

console.log(`Navigating to: ${url}`);
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });

console.log('Looking for login fields…');
await page.waitForSelector('input[placeholder="שם משתמש"]', { timeout: 30_000 });
await page.type('input[placeholder="שם משתמש"]', username, { delay: 30 });
await page.type('input[placeholder="סיסמה"]', password, { delay: 30 });

const buttons = await page.$$eval('button', els =>
  els.map(b => ({
    text: (b.textContent || '').trim().slice(0, 40),
    type: b.getAttribute('type'),
    ariaLabel: b.getAttribute('aria-label'),
    classes: b.className,
    disabled: b.disabled,
  })),
);
console.log('Buttons on page:');
console.log(JSON.stringify(buttons, null, 2));

console.log('Submitting login (find button containing "כניסה")…');
const clicked = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const target = btns.find(b => (b.textContent || '').includes('כניסה') && !b.disabled);
  if (target) {
    target.click();
    return true;
  }
  return false;
});
console.log(`Clicked: ${clicked}`);

console.log('Waiting 25s for post-login UI to settle…');
await new Promise(r => setTimeout(r, 25_000));

const url1 = page.url();
const title = await page.title();
console.log(`URL after login: ${url1}`);
console.log(`Title: ${title}`);

const shot1 = path.join(outDir, 'post_login.png');
await page.screenshot({ path: shot1, fullPage: true });
console.log(`Screenshot: ${shot1}`);

const html1 = path.join(outDir, 'post_login.html');
fs.writeFileSync(html1, await page.content(), 'utf8');
console.log(`HTML: ${html1}`);

const links = await page.$$eval('a', els =>
  els.slice(0, 30).map(a => ({ title: a.getAttribute('title'), text: (a.textContent || '').trim().slice(0, 60), href: a.href })),
);
console.log('First links on page:');
console.log(JSON.stringify(links, null, 2));

console.log('\nLeaving browser open for 60s so you can inspect…');
await new Promise(r => setTimeout(r, 60_000));
await browser.close();
