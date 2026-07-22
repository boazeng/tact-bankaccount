// Independent copy of the login flow from src/scrapers/beinleumi.js — kept
// separate on purpose (see discount.js/poalim.js: credit-cards shares zero
// code with the checking-account scrapers).
//
// FIBI's credit-card charge breakdown ("כרטיסי אשראי" > "פירוט חיובים") is
// NOT part of the modern Angular bff-* API used for checking transactions —
// it's the legacy WebSphere Portal ("wps/myportal") system, rendered as
// plain server-side HTML inside an iframe, with zero XHR/fetch calls (a raw
// page.goto() confirmed this: navigating there fires no json/xhr traffic at
// all). The summary table lists one row per (card, billing month) with a
// hidden `<a href="javascript:submitLinkForm(pageId, cardId, date, mode)">`
// per row — rather than clicking through the UI (fragile: month rows must
// be expanded first, and the click navigates through a transient WebSphere
// portal-token redirect frame that detaches almost immediately), we extract
// every (cardId, date) pair directly from the summary HTML and call
// `submitLinkForm` ourselves for each one, polling for the resulting stable
// frame afterward.
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// DD/MM/YYYY -> YYYY-MM-DD
const ddmmyyyyToIso = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

async function loginToFibi(page, loginUrl, userId, password, onProgress) {
  onProgress({ step: 'login', message: 'מתחבר לבנק…' });
  await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60_000 });

  await page.evaluate(() => {
    const btn = document.querySelector('#cookie_box_close');
    if (btn) btn.click();
  });
  await sleep(500);

  onProgress({ step: 'login-open-modal', message: 'פותח את חלונית ההתחברות…' });
  await page.waitForSelector('a.login-trigger', { timeout: 20_000 });
  await page.evaluate(() => {
    const el = document.querySelector('a.login-trigger');
    if (el) el.click();
  });

  let loginFrame = null;
  const frameWaitStart = Date.now();
  while (!loginFrame && Date.now() - frameWaitStart < 20_000) {
    loginFrame = page.frames().find(f => /MatafLoginServlet/.test(f.url()));
    if (!loginFrame) await sleep(500);
  }
  if (!loginFrame) throw new Error('scrapeBeinleumiCards: login form iframe not found');

  onProgress({ step: 'login-form-found', message: 'טופס ההתחברות נמצא, ממלא פרטים…' });
  await loginFrame.waitForSelector('#username', { timeout: 20_000 });
  await loginFrame.type('#username', userId, { delay: 30 });
  await loginFrame.type('#password', password, { delay: 30 });

  onProgress({ step: 'login-submit', message: 'לוחץ כניסה, ממתין לאישור…' });
  await loginFrame.waitForFunction(() => {
    const btn = document.querySelector('#continueBtn');
    return btn && !btn.disabled;
  }, { timeout: 10_000 }).catch(() => {});
  await loginFrame.evaluate(() => {
    const btn = document.querySelector('#continueBtn');
    if (!btn) throw new Error('Login button not found');
    if (btn.disabled) throw new Error('scrapeBeinleumiCards: כפתור הכניסה עדיין מנוטרל אחרי מילוי הפרטים');
    btn.click();
  });

  try {
    await page.waitForFunction(() => location.href.includes('online.fibi.co.il'), { timeout: 60_000 });
  } catch {
    throw new Error('scrapeBeinleumiCards: לא הופנה ל-online.fibi.co.il תוך 60 שניות אחרי לחיצת כניסה — יתכן פרטי התחברות שגויים או חסימת בוט');
  }
  onProgress({ step: 'init-session', message: 'טוען את מסך הבית…' });
  await sleep(6_000);
}

// Same "before/after" trick as the checking-account scraper's nav: a quick-
// links shortcut with the same text exists before the top-nav dropdown is
// opened, so diff to find the freshly-revealed real nav item.
async function clickFreshMatch(page, text) {
  const before = await page.evaluate((text) =>
    Array.from(document.querySelectorAll('*'))
      .filter(e => e.children.length === 0 && (e.textContent || '').trim() === text)
      .map(e => e.outerHTML), text);

  return page.evaluate((text, before) => {
    const els = Array.from(document.querySelectorAll('*'))
      .filter(e => e.children.length === 0 && (e.textContent || '').trim() === text);
    const fresh = els.find(e => !before.includes(e.outerHTML));
    const target = fresh || els[els.length - 1];
    if (target) { target.click(); return true; }
    return false;
  }, text, before);
}

async function navigateToCardsSummary(page, onProgress) {
  onProgress({ step: 'navigate', message: 'עובר למסך כרטיסי אשראי…' });
  const openedNav = await clickFreshMatch(page, 'כרטיסי אשראי');
  if (!openedNav) throw new Error('scrapeBeinleumiCards: "כרטיסי אשראי" nav item not found');
  await sleep(1_500);

  const clicked = await clickFreshMatch(page, 'פירוט חיובים');
  if (!clicked) throw new Error('scrapeBeinleumiCards: "פירוט חיובים" nav item not found');
  await sleep(8_000);
}

// The summary/detail portlet lives in a wps/myportal iframe that gets
// replaced (through a transient portal-token redirect frame) every time we
// call submitLinkForm — poll fresh rather than holding a frame reference.
async function findStablePortletFrame(page, { timeoutMs = 20_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const candidates = page.frames().filter(f => /wps\/myportal/.test(f.url()) && !f.isDetached());
    for (const frame of candidates) {
      try {
        const hasContent = await frame.evaluate(() => (document.body?.innerText || '').trim().length > 20);
        if (hasContent) return frame;
      } catch { /* detached mid-check — try the next candidate */ }
    }
    await sleep(1_000);
  }
  return null;
}

// Extracts every (cardId, dateParam, cardLabel) triple from the summary
// page's hidden per-row links: <a href="javascript:submitLinkForm(pageId,
// cardId, 'DD.MM.YYYY', mode)">cardLast4 - cardVendor</a>. Deduped since
// each row renders the link twice (icon + text).
async function extractCardMonthLinks(frame) {
  return frame.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="submitLinkForm"]'));
    const seen = new Set();
    const out = [];
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = /submitLinkForm\('\s*([^']*)','([^']*)','([^']*)','([^']*)'\)/.exec(href);
      if (!m) continue;
      const [, pageId, cardId, dateParam, mode] = m;
      const key = `${cardId}|${dateParam}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pageId, cardId, dateParam, mode, label: (a.textContent || '').trim() });
    }
    return out;
  });
}

function parseCardLabel(label) {
  // "6068             ישראכרט" or "6068 - ישראכרט"
  const m = /(\d{4})\D+(.*)/.exec(label || '');
  return { last4: m ? m[1] : null, vendor: m ? m[2].trim() : null };
}

async function scrapeMonthDetail(frame, cardLast4) {
  return frame.evaluate((cardLast4) => {
    const tables = Array.from(document.querySelectorAll('table[id^="hiuvumTbl"]'));
    const results = [];
    for (const table of tables) {
      // The billing-date/currency header sits in the preceding row's
      // TitleNIs_* block — walk up to the enclosing section to find it.
      const section = table.closest('tr')?.closest('table')?.closest('td')?.closest('tr')?.parentElement;
      const headerEl = section?.querySelector('[class*="TitleNIs_"] .strong[dir="ltr"]');
      const isForeign = /מטבע חוץ|מט"ח/.test(section?.textContent || '');
      const billingDateText = headerEl ? headerEl.textContent.trim() : null;

      const rows = Array.from(table.querySelectorAll('tbody tr')).filter(tr => tr.querySelectorAll('td').length >= 4);
      for (const tr of rows) {
        const cells = tr.querySelectorAll('td');
        results.push({
          cardLast4,
          date: cells[0]?.textContent.trim() || null,
          merchant: cells[1]?.textContent.trim() || null,
          txnAmount: cells[2]?.textContent.trim() || null,
          billAmount: cells[3]?.textContent.trim() || null,
          detail: cells[4]?.textContent.trim() || null,
          billingDateText,
          isForeign,
        });
      }
    }
    return results;
  }, cardLast4);
}

const parseAmount = (s) => {
  const n = Number(String(s || '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

export async function scrapeBeinleumiCards({ credentials, showBrowser = false, onProgress = () => {} }) {
  const { userId, password, loginUrl } = credentials;
  if (!userId || !password) {
    throw new Error('scrapeBeinleumiCards: missing userId/password');
  }
  const HOME_URL = loginUrl || 'https://www.fibi.co.il/business/';

  onProgress({ step: 'launch', message: 'מפעיל דפדפן…' });
  const browser = await puppeteer.launch({
    headless: !showBrowser,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    await loginToFibi(page, HOME_URL, userId, password, onProgress);

    // Legacy endpoint, cookie-auth only (no bearer token needed) — same one
    // the checking-account scraper uses to discover the account list.
    const userData = await page.evaluate(async () => {
      const r = await fetch(`/MatafAngularRestApiService/rest/utils/userData?uid=${crypto.randomUUID()}`, { credentials: 'include' });
      return r.ok ? r.json() : null;
    }).catch(() => null);
    const acc = userData?.accounts?.[0];
    const maskedNumber = acc ? `${acc.branch}-${acc.account}` : null;
    const corporateName = (acc?.name || '').trim() || maskedNumber;

    await navigateToCardsSummary(page, onProgress);

    const summaryFrame = await findStablePortletFrame(page);
    if (!summaryFrame) throw new Error('scrapeBeinleumiCards: charges summary frame not found/stable');

    const links = await extractCardMonthLinks(summaryFrame);
    onProgress({ step: 'months-found', message: `נמצאו ${links.length} חודשי חיוב`, count: links.length });
    if (links.length === 0) {
      onProgress({ step: 'done', message: 'סיום: 0 כרטיסים', total: 0 });
      return { cards: [] };
    }

    // Group raw month rows by card so each card becomes one entry with all
    // its transactions, matching poalim.js/discount.js's per-card grouping.
    const byCard = new Map();

    for (const link of links) {
      const { last4, vendor } = parseCardLabel(link.label);
      onProgress({ step: 'fetching-month', message: `טוען חיוב ${vendor || ''} ${last4 || ''} — ${link.dateParam}`, account: last4 });

      const ok = await summaryFrame.evaluate((pageId, cardId, dateParam, mode) => {
        if (typeof window.submitLinkForm !== 'function') return false;
        window.submitLinkForm(pageId, cardId, dateParam, mode);
        return true;
      }, link.pageId, link.cardId, link.dateParam, link.mode).catch(() => false);
      if (!ok) {
        onProgress({ step: 'month-error', message: `לא הצלחתי לטעון חיוב ${link.dateParam}`, account: last4 });
        continue;
      }

      const detailFrame = await findStablePortletFrame(page);
      if (!detailFrame) {
        onProgress({ step: 'month-error', message: `מסגרת הפירוט לא נטענה עבור ${link.dateParam}`, account: last4 });
        continue;
      }

      const rows = await scrapeMonthDetail(detailFrame, last4);
      const foreignRows = rows.filter(r => r.isForeign);
      if (foreignRows.length) {
        onProgress({ step: 'card-warning', message: `כרטיס ${last4}: נמצאו תנועות מט"ח — טרם נבדק מבנה זה, ייתכן פירוט חלקי`, account: last4 });
      }

      if (!byCard.has(last4)) byCard.set(last4, { vendor, rows: [] });
      byCard.get(last4).rows.push(...rows);
    }

    const results = [];
    for (const [last4, { vendor, rows }] of byCard) {
      const seenKeys = new Map();
      const transactions = rows.map((r) => {
        const purchaseDate = ddmmyyyyToIso(r.date);
        const billingDate = ddmmyyyyToIso(r.billingDateText) || purchaseDate;
        const merchantName = r.merchant || null;
        // FIBI lists charges as plain positive amounts on this statement
        // view (no separate credit/debit split observed) — flipped to this
        // app's convention (negative = expense), matching discount.js/poalim.js.
        const amount = -parseAmount(r.billAmount);
        const originalAmount = r.txnAmount && r.txnAmount !== r.billAmount ? parseAmount(r.txnAmount) : null;

        const baseKey = `${last4}-${purchaseDate}-${merchantName}-${amount}`;
        const occurrence = (seenKeys.get(baseKey) ?? 0) + 1;
        seenKeys.set(baseKey, occurrence);

        return {
          transactionID: `${baseKey}-${occurrence}`,
          purchaseDate,
          billingDate,
          merchantName,
          amount,
          currency: r.isForeign ? 'USD' : 'ILS',
          originalAmount,
          installmentCurrent: null,
          installmentTotal: null,
          status: 'posted',
          raw: r,
        };
      });

      results.push({
        account: { maskedNumber, corporateName },
        card: { cardLast4: last4, label: vendor },
        transactions,
      });

      onProgress({ step: 'card-done', message: `כרטיס ${last4}: ${transactions.length} תנועות`, account: last4, count: transactions.length });
    }

    onProgress({ step: 'done', message: `סיום: ${results.length} כרטיסים`, total: results.length });
    return { cards: results };
  } finally {
    await browser.close();
  }
}

export const bankInfo = {
  id: 'beinleumi',
  nameHe: 'הבינלאומי',
};
