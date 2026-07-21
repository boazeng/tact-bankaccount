// Diagnostic/reference for FIBI's transactions API: reuses the persisted
// login profile from inspect-beinleumi.js and drives the real click path
// (top nav "ניהול חשבון" → "תנועות בחשבון") needed to make the app acquire
// its scoped bearer token for bff-balancetransactions — a raw goto() to the
// deep-link route 401s. Saves the full transactions/list response body for
// inspection. See src/scrapers/beinleumi.js for the productionized version.
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';

const profileDir = path.resolve('output/beinleumi-profile');

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: profileDir,
  defaultViewport: null,
  args: ['--start-maximized'],
});
const [page] = await browser.pages();

const outDir2 = path.resolve('output');
page.on('response', async (res) => {
  const url = res.url();
  const req = res.request();
  if (/fibi/i.test(url) && (url.includes('/api/') || url.includes('bff-'))) {
    console.log(res.status(), req.method(), url.split('?')[0]);
    if (url.includes('transactions/list')) {
      try {
        const body = await res.text();
        fs.writeFileSync(path.join(outDir2, 'beinleumi_full_transactionsList2.json'), body);
        console.log('  saved full body, length:', body.length);
      } catch (e) { console.log('  save error:', e.message); }
    }
    if (url.includes('/accountType') || url.includes('/balances/')) {
      try {
        const body = await res.text();
        fs.writeFileSync(path.join(outDir2, `beinleumi_full_${url.split('/').pop().split('?')[0]}.json`), body);
      } catch {}
    }
  }
});

await page.goto('https://online.fibi.co.il/appsng/Resources/PortalNG/shell/', {
  waitUntil: 'networkidle2', timeout: 60_000,
});
await new Promise(r => setTimeout(r, 6000));
console.log('Landed on:', page.url());

// Click the top-nav "ניהול חשבון" item to open its dropdown, then look for
// a "תנועות בחשבון" entry INSIDE that dropdown (should route to the modern
// Angular module, unlike the legacy quick-links panel entry).
const topNavClicked = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('*'))
    .find(e => e.children.length === 0 && /^ניהול חשבון$/.test((e.textContent || '').trim()));
  if (el) { el.click(); return true; }
  return false;
});
console.log('Clicked top-nav ניהול חשבון:', topNavClicked);
await new Promise(r => setTimeout(r, 2000));

const submenuMatches = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('*'))
    .filter(e => e.children.length === 0 && /תנועות בחשבון/.test((e.textContent || '').trim()));
  return els.map(e => ({
    text: (e.textContent || '').trim(),
    tag: e.tagName,
    outerHTML: e.outerHTML.slice(0, 200),
  }));
});
console.log('submenu matches:', JSON.stringify(submenuMatches, null, 2));

const clicked = await page.evaluate(() => {
  const candidates = Array.from(document.querySelectorAll('*'))
    .filter(e => e.children.length === 0 && /^תנועות בחשבון$/.test((e.textContent || '').trim()));
  const el = candidates[0];
  if (el) { el.click(); return true; }
  return false;
});
console.log('Clicked (first match) תנועות בחשבון:', clicked);

await new Promise(r => setTimeout(r, 20000));
console.log('Final URL:', page.url());

await browser.close();
