// Drills into one month's itemized charge detail from the legacy credit-card
// summary portlet: click the "+" toggle to reveal the row, then click the
// underlined card-name link inside it (fires the page's own submitLinkForm()
// JS — a real click lets the site's own JS handle the legacy form POST
// instead of us reverse-engineering it).
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';

const profileDir = path.resolve('output/beinleumi-profile');
const outDir = path.resolve('output');

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: profileDir,
  defaultViewport: null,
  args: ['--start-maximized'],
});
const [page] = await browser.pages();

await page.goto('https://online.fibi.co.il/appsng/Resources/PortalNG/shell/#/Online/OnCreditCardsMenu/OnCrCardsDetPayms/AuthCrCardsChrgDetPrev', {
  waitUntil: 'networkidle2', timeout: 60_000,
});
await new Promise(r => setTimeout(r, 8000));

const portletFrame = page.frames().find(f => /wps\/myportal.*OnCrCardsDetPayms/.test(f.url()));
if (!portletFrame) {
  console.log('Portlet frame not found. Frames:', page.frames().map(f => f.url()));
  await browser.close();
  process.exit(1);
}
console.log('Found portlet frame:', portletFrame.url());

const toggled = await portletFrame.evaluate(() => {
  const el = document.querySelector('.ui-icon-plus.Tgl_Class');
  if (el) { el.click(); return true; }
  return false;
});
console.log('Clicked first month toggle:', toggled);
await new Promise(r => setTimeout(r, 1500));

const linkClicked = await portletFrame.evaluate(() => {
  const link = Array.from(document.querySelectorAll('a')).find(a => /submitLinkForm/.test(a.getAttribute('href') || ''));
  if (link) { link.click(); return link.textContent.trim(); }
  return null;
});
console.log('Clicked detail link:', linkClicked);

// The click navigates through a transient WebSphere Portal token-redirect
// frame that detaches almost immediately — poll fresh until a stable
// wps/myportal frame with real content is found, evaluating it right away
// each iteration rather than holding a reference that may go stale.
let saved = false;
for (let attempt = 0; attempt < 10 && !saved; attempt++) {
  await new Promise(r => setTimeout(r, 2000));
  const candidates = page.frames().filter(f => /wps\/myportal/.test(f.url()) && !f.isDetached());
  for (const [i, frame] of candidates.entries()) {
    try {
      const text = await frame.evaluate(() => document.body ? document.body.innerText : '');
      if (text && text.trim().length > 20) {
        fs.writeFileSync(path.join(outDir, `beinleumi_cards7_frame${i}_text.txt`), text);
        console.log(`[attempt ${attempt}] Frame ${i} (${frame.url().slice(0, 80)}...) — ${text.length} chars saved`);
        const html = await frame.evaluate(() => document.body ? document.body.innerHTML : '');
        fs.writeFileSync(path.join(outDir, `beinleumi_cards7_frame${i}_html.html`), html || '');
        saved = true;
      }
    } catch (e) {
      console.log(`[attempt ${attempt}] Frame ${i} error:`, e.message);
    }
  }
}
console.log('Done polling. saved =', saved);
await page.screenshot({ path: path.join(outDir, 'beinleumi_cards7_final.png'), fullPage: true }).catch(() => {});

await browser.close();
