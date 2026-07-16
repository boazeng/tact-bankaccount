// Mizrahi-Tefahot Business scraper (mto.mizrahi-tefahot.co.il, Sky OnlineApp).
//
// Flow:
//   1. Navigate to the protected OnlineApp URL — SiteMinder auto-redirects to
//      the login form on www.mizrahi-tefahot.co.il.
//   2. Fill #userNumberDesktopHeb + #passwordDesktopHeb, click "כניסה".
//   3. If SMS 2FA appears → call onSmsRequired() and fill the OTP.
//   4. Wait for redirect back to mto.* and dashboard to load.
//   5. Refetch /SkyBL/logon → list of user's accounts (in body.user.Accounts).
//   6. For each account: changeAccount(index) → get428Index (transactions).
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Mizrachi's get428Index (transactions) endpoint sits behind Radware Bot
// Manager, which was bouncing every request with a SiteMinder re-auth
// (errorcode=198) regardless of the mouse/scroll simulation in
// humanizeInteraction() below — plain headless Chromium exposes
// navigator.webdriver and other tells that behavioral scoring alone doesn't
// fix. Stealth patches those headless fingerprints at the browser level.
puppeteer.use(StealthPlugin());

const PROTECTED_URL = 'https://mto.mizrahi-tefahot.co.il/OnlineApp/index.html';

// Mizrachi expects DD/MM/YYYY (not YYYYMMDD like other banks).
const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Finds the smallest (fewest descendant elements) exact text match among
// common clickable-ish tags and clicks it — mirrors the text-matching
// pattern already used for the login/SMS buttons above, but prefers the
// most specific match so we don't click a large container whose combined
// text happens to include the target string.
async function clickByExactText(frame, text) {
  return frame.evaluate((searchText) => {
    const candidates = Array.from(document.querySelectorAll('a, button, li, span, div, td'));
    let best = null;
    for (const el of candidates) {
      if ((el.textContent || '').trim() !== searchText) continue;
      if (!best || el.querySelectorAll('*').length < best.querySelectorAll('*').length) best = el;
    }
    if (!best) return false;
    best.click();
    return true;
  }, text);
}

// Maps daysBack to the closest quick-range button visible in the p428New
// transactions iframe ("7/30 ימים אחרונים", "3 חודשים אחרונים", "שנה אחורה").
// No support yet for the custom "בין תאריכים" range beyond a year back.
function pickPeriodButtonText(daysBack) {
  if (daysBack <= 7) return '7 ימים אחרונים';
  if (daysBack <= 30) return '30 ימים אחרונים';
  if (daysBack <= 90) return '3 חודשים אחרונים';
  return 'שנה אחורה';
}

// The p428New iframe loads its own transaction data in the background —
// independent of, and unaffected by, the SiteMinder block that hits every
// request WE try to fire (manual fetch, fetch-from-iframe-context, click-
// triggered — all bounced identically). Poll its visible text for the
// "loading finished" marker instead of intercepting any network call.
async function waitForFrameLoaded(frame, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await frame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (/טעינה הסתיימה/.test(text)) return text;
    await sleep(intervalMs);
  }
  return null;
}

// Parses the rendered transaction list out of the iframe's plain visible
// text (no DOM structure available to us — only innerText). Each row is
// "DD/MM/YY <description> <amount>[ <balance>]"; balance is only present on
// the last row of a same-day group (the bank shows one closing balance per
// day, not per transaction), so runningBalance is null on the others — a
// real reduction in precision vs the JSON API, but still real data.
function parseMizrachiTransactionText(rawText, maskedNumber) {
  let text = rawText || '';
  const startMarker = 'תנועות אחרונות';
  const startIdx = text.indexOf(startMarker);
  if (startIdx !== -1) text = text.slice(startIdx + startMarker.length);
  for (const marker of ['יתרה קודמת נכון', '(י)-פעולה']) {
    const idx = text.indexOf(marker);
    if (idx !== -1) text = text.slice(0, idx);
  }

  const numPattern = '[\\u200e\\u200f]?-?[\\d,]+\\.\\d{2}';
  const rowRe = new RegExp(`^([\\s\\S]+?)\\s+(${numPattern})(?:\\s+(${numPattern}))?$`);
  const clean = (s) => Number(s.replace(/[‎‏]/g, '').replace(/,/g, ''));

  const parts = text.split(/(?=\d{2}\/\d{2}\/\d{2}(?!\d))/);
  const seenKeys = new Map();
  const rows = [];
  for (const part of parts) {
    const dateMatch = part.match(/^(\d{2})\/(\d{2})\/(\d{2})\s+([\s\S]+)$/);
    if (!dateMatch) continue;
    const [, dd, mm, yy, rest] = dateMatch;
    const rowMatch = rest.trim().match(rowRe);
    if (!rowMatch) continue;
    const [, descRaw, amountRaw, balanceRaw] = rowMatch;
    const amount = clean(amountRaw);
    if (!Number.isFinite(amount)) continue;
    const isoDate = `20${yy}-${mm}-${dd}`;
    const description = descRaw.trim();
    // Synthetic dedup key: same date+description+amount can legitimately
    // repeat in one day (e.g. two identical fees) — count occurrences so
    // each gets a distinct transactionID instead of colliding.
    const dupKey = `${isoDate}|${description}|${amount}`;
    const occurrence = (seenKeys.get(dupKey) || 0) + 1;
    seenKeys.set(dupKey, occurrence);
    rows.push({
      transactionID: `${maskedNumber}|${isoDate}|${description}|${amount}|${occurrence}`,
      date: isoDate,
      effectiveDate: isoDate,
      description,
      extendedDescription: null,
      amount,
      runningBalance: balanceRaw ? clean(balanceRaw) : null,
      beneficiaryName: null,
      beneficiaryBankCode: null,
      beneficiaryBranch: null,
      beneficiaryAccountNumber: null,
      referenceNumber: null,
    });
  }
  return rows;
}

// The bank's transactions endpoint (get428Index) is gated by Radware Bot
// Manager — raw fetch() calls fired right after login get bounced back
// through SiteMinder re-auth (errorcode=198) because there's no human
// mouse/scroll signal for its behavioral check to score. This simulates
// that signal before hitting protected endpoints. Best-effort: swallow
// any failure, since this is a heuristic, not a correctness requirement.
async function humanizeInteraction(page) {
  try {
    const viewport = page.viewport() || { width: 1400, height: 900 };
    for (let i = 0; i < 3; i++) {
      const x = Math.min(80 + Math.random() * (viewport.width - 160), viewport.width - 10);
      const y = Math.min(120 + Math.random() * (viewport.height - 240), viewport.height - 10);
      await page.mouse.move(x, y, { steps: 15 + Math.floor(Math.random() * 10) });
      await sleep(150 + Math.random() * 250);
    }
    await page.evaluate(() => window.scrollBy(0, 250));
    await sleep(200 + Math.random() * 200);
    await page.evaluate(() => window.scrollBy(0, -250));
    await sleep(150 + Math.random() * 200);
  } catch {}
}

export async function scrapeMizrachi({ credentials, daysBack = 30, showBrowser = false, onProgress = () => {}, onSmsRequired }) {
  const { userId, password } = credentials;
  if (!userId || !password) throw new Error('scrapeMizrachi: missing userId/password');

  const today = new Date();
  const fromDate = new Date();
  fromDate.setDate(today.getDate() - daysBack);
  const fromStr = ddmmyyyy(fromDate);
  const toStr = ddmmyyyy(today);

  onProgress({ step: 'launch', message: 'מפעיל דפדפן…' });
  const browser = await puppeteer.launch({
    headless: !showBrowser,
    defaultViewport: showBrowser ? null : { width: 1400, height: 900 },
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      ...(showBrowser ? ['--start-maximized'] : []),
    ],
  });

  try {
    const [page] = showBrowser ? await browser.pages() : [await browser.newPage()];

    // Listen for the SPA's logon call — it carries the full accounts list,
    // which a refetch later won't return.
    let initialLogonBody = null;
    page.on('response', async (res) => {
      if (initialLogonBody) return;
      if (!res.url().includes('/Online/api/SkyBL/logon')) return;
      try { initialLogonBody = await res.text(); } catch {}
    });

    onProgress({ step: 'login', message: 'נכנס למזרחי-טפחות…' });
    await page.goto(PROTECTED_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

    await page.waitForSelector('#userNumberDesktopHeb', { timeout: 30_000 });
    await page.evaluate((uid, pwd) => {
      const setVal = (input, val) => {
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        native.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(document.querySelector('#userNumberDesktopHeb'), uid);
      setVal(document.querySelector('#passwordDesktopHeb'), pwd);
    }, userId, password);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /כניסה/.test(b.textContent || '') && !b.disabled);
      if (!btn) throw new Error('Login button not found');
      btn.click();
    });

    onProgress({ step: 'sms-wait', message: 'ממתין לתגובה מהבנק (SMS או דשבורד)…' });

    const result = await Promise.race([
      page.waitForFunction(
        () => !!document.querySelector('input[autocomplete="one-time-code"], input[type="tel"][maxlength], input[id*="otp" i], input[name*="otp" i]'),
        { timeout: 45_000 },
      ).then(() => 'sms').catch(() => null),
      page.waitForFunction(
        () => location.hostname.includes('mto.mizrahi-tefahot.co.il') && location.pathname.includes('/OnlineApp/'),
        { timeout: 45_000 },
      ).then(() => 'dashboard').catch(() => null),
    ]);

    if (result === 'sms') {
      if (typeof onSmsRequired !== 'function') {
        throw new Error('Mizrachi requested SMS code but no onSmsRequired callback was provided');
      }
      onProgress({ step: 'sms-required', message: 'הבנק שלח SMS — נדרש קוד' });
      const code = await onSmsRequired({ message: 'הזן את הקוד שקיבלת ב-SMS ממזרחי-טפחות' });
      if (!code) throw new Error('No SMS code provided');
      await page.evaluate((c) => {
        const el = document.querySelector('input[autocomplete="one-time-code"], input[type="tel"][maxlength], input[id*="otp" i], input[name*="otp" i]');
        if (!el) throw new Error('SMS input no longer present');
        const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        native.call(el, c);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /כניסה|אישור|המשך/.test(b.textContent || '') && !b.disabled);
        btn?.click();
      }, code);
      onProgress({ step: 'sms-submitted', message: 'נשלח קוד SMS, ממתין להתחברות…' });
      await page.waitForFunction(
        () => location.hostname.includes('mto.mizrahi-tefahot.co.il') && location.pathname.includes('/OnlineApp/'),
        { timeout: 60_000 },
      );
    } else if (!result) {
      throw new Error('Timeout waiting for SMS prompt or dashboard after login');
    }

    onProgress({ step: 'logged-in', message: 'מחובר — שולף רשימת חשבונות' });
    await humanizeInteraction(page);

    // Wait for the SPA's logon call to fire (it's part of the dashboard bootstrap).
    const waitStart = Date.now();
    while (!initialLogonBody && Date.now() - waitStart < 15_000) {
      await sleep(300);
    }
    if (!initialLogonBody) throw new Error('Did not capture /SkyBL/logon response within 15s after login');

    let logonBody = null;
    try { logonBody = JSON.parse(initialLogonBody); } catch {}

    // Look in the obvious places, then fall back to a recursive search.
    let accountsRaw = logonBody?.body?.user?.Accounts
      ?? logonBody?.user?.Accounts
      ?? logonBody?.body?.Accounts
      ?? logonBody?.Accounts;
    if (!Array.isArray(accountsRaw) || !accountsRaw.length) {
      const findAccounts = (obj, depth = 0) => {
        if (!obj || typeof obj !== 'object' || depth > 6) return null;
        if (Array.isArray(obj)) {
          if (obj.length && obj[0]?.SnifAndNumber400) return obj;
          for (const item of obj) {
            const found = findAccounts(item, depth + 1);
            if (found) return found;
          }
          return null;
        }
        for (const k of Object.keys(obj)) {
          const found = findAccounts(obj[k], depth + 1);
          if (found) return found;
        }
        return null;
      };
      accountsRaw = findAccounts(logonBody) ?? [];
    }

    if (!accountsRaw.length) {
      throw new Error('No accounts found in /SkyBL/logon response body');
    }

    onProgress({ step: 'accounts-found', message: `נמצאו ${accountsRaw.length} חשבונות`, count: accountsRaw.length });

    const results = [];
    for (let i = 0; i < accountsRaw.length; i++) {
      const acc = accountsRaw[i];
      const maskedNumber = acc.SnifAndNumber400 || `${acc.BranchForDispaly || acc.Branch}-${acc.Number}`;
      const corporateName = (acc.Name || '').trim();

      onProgress({
        step: 'fetching-account',
        message: `מוריד תנועות מחשבון ${maskedNumber} (${corporateName})`,
        account: maskedNumber,
      });

      // Switch to this account in the session
      const switchResp = await page.evaluate(async (idx) => {
        const r = await fetch('/Online/api/SkyBL/changeAccount', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
          body: JSON.stringify({ selectedAccountIndex: idx }),
        });
        return { status: r.status, text: await r.text() };
      }, i);

      let switchBody = null;
      try { switchBody = JSON.parse(switchResp.text || '{}'); } catch {}
      const balance = switchBody?.body?.YitraAdkanit != null
        ? Number(switchBody.body.YitraAdkanit)
        : (acc.Remain != null ? Number(acc.Remain) : null);

      // changeAccount may take a moment to propagate session state. Also give
      // the bot-manager's behavioral check something to observe before the
      // protected get428Index call (see humanizeInteraction above).
      await sleep(500);
      await humanizeInteraction(page);

      // One-time diagnostic (first account only) for the "get428Index always
      // bounces with errorcode=198" investigation — captures what a real
      // browser would actually be showing/holding right before the blocked
      // call. Visible text goes straight into the progress log (same channel
      // that already successfully shows the blocked-response HTML) instead of
      // a screenshot file — a content filter on the user's network was
      // blocking image delivery entirely, so plain text is the reliable path.
      if (i === 0) {
        try {
          const cookieNames = await page.evaluate(() => document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(Boolean));
          const pageText = await page.evaluate(() => document.body ? document.body.innerText : '');
          onProgress({
            step: 'debug-pre-get428',
            message: `[DEBUG] לפני get428Index: url=${page.url()} cookieNames=${cookieNames.join(',')} — טקסט גלוי בעמוד: ${(pageText || '').trim().slice(0, 2000) || '(העמוד ריק מטקסט)'}`,
            account: maskedNumber,
          });

          // document.body.innerText never reaches into <iframe> content — the
          // URL (…/osh/legacy/root-main-osh-p428New) suggests the real
          // transaction-search UI is a legacy module embedded in an iframe,
          // which would explain why the outer text above was just menu chrome.
          const frames = page.frames().filter(f => f !== page.mainFrame());
          if (!frames.length) {
            onProgress({ step: 'debug-frames', message: `[DEBUG] אין iframes בעמוד`, account: maskedNumber });
          }
          for (const f of frames) {
            let frameText = '';
            try { frameText = await f.evaluate(() => document.body ? document.body.innerText : ''); } catch (fe) { frameText = `(שגיאה: ${fe.message})`; }
            onProgress({
              step: 'debug-frames',
              message: `[DEBUG] iframe url=${f.url()} — טקסט: ${(frameText || '').trim().slice(0, 1500) || '(ריק)'}`,
              account: maskedNumber,
            });
          }
        } catch (e) {
          onProgress({ step: 'debug-pre-get428', message: `[DEBUG] תפיסת אבחון נכשלה: ${e.message}`, account: maskedNumber });
        }
      }

      // Fetch transactions for this account.
      //
      // Primary path: the p428New iframe loads its own transaction data in
      // the background, completely independent of the SiteMinder block that
      // hits every request WE explicitly fire — three different attempts at
      // replicating/triggering that request (manual fetch, fetch-from-
      // iframe-context, a real click on the period button) all got bounced
      // with the identical errorcode=198, while the iframe's silent auto-load
      // works every time. So: wait for it to finish loading on its own, then
      // parse the rendered table text directly — no request of ours involved.
      //
      // Fallback: the old click-then-manual-fetch chain, kept for accounts
      // where the frame/load/parse doesn't pan out, so they degrade to the
      // previous (broken) behavior rather than being silently skipped.
      //
      // Everything below is wrapped in try/catch: the iframe gets replaced
      // by the SPA between accounts, and touching a stale Frame reference
      // throws "Attempted to use detached Frame" — uncaught, that aborted
      // the *entire* remaining sync (all later accounts) instead of just
      // this one, the first time it happened live.
      let p428Frame = null;
      let transactions = null;
      try {
      p428Frame = page.frames().find(f => /p428New/i.test(f.url()));

      if (p428Frame) {
        const loadedText = await waitForFrameLoaded(p428Frame);
        if (loadedText) {
          const parsed = parseMizrachiTransactionText(loadedText, maskedNumber);
          onProgress({
            step: 'debug-text-parse',
            message: `[DEBUG] ${maskedNumber}: פוענחו ${parsed.length} תנועות מהטקסט המוצג ב-iframe`,
            account: maskedNumber,
          });
          if (parsed.length) transactions = parsed;
        } else {
          onProgress({
            step: 'debug-text-parse',
            message: `[DEBUG] ${maskedNumber}: ה-iframe לא סיים לטעון ("טעינה הסתיימה") תוך 30 שניות — fallback לשיטה הישנה`,
            account: maskedNumber,
          });
        }
      }

      if (!transactions) {
        let txnResp = null;
        const periodText = pickPeriodButtonText(daysBack);
        if (p428Frame) {
          const responsePromise = page.waitForResponse(
            r => r.url().includes('/Online/api/SkyOSH/get428Index'),
            { timeout: 20_000 },
          ).catch(() => null);
          const clicked = await clickByExactText(p428Frame, periodText).catch(() => false);
          if (clicked) {
            const response = await responsePromise;
            if (response) {
              const text = await response.text().catch(() => '');
              const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
              txnResp = {
                status: response.status(),
                redirected: response.request().redirectChain().length > 0,
                finalUrl: response.url(),
                contentType: response.headers()['content-type'] || null,
                title: titleMatch ? titleMatch[1] : null,
                text,
              };
            }
          }
        }

        if (!txnResp) {
          txnResp = await (p428Frame || page).evaluate(async (from, to) => {
            const r = await fetch('/Online/api/SkyOSH/get428Index', {
              method: 'POST', credentials: 'include',
              headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
              body: JSON.stringify({
                inToDate: to,
                inFromDate: from,
                inSugTnua: '',
                table: { sortExpression: 'MC02PeulaTaaEZ DESC', sortOrder: 'DESC', startRowIndex: 0, maxRow: 500, actionGuid: '' },
                isFromSearch: false,
              }),
            });
            const text = await r.text();
            const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            return {
              status: r.status,
              redirected: r.redirected,
              finalUrl: r.url,
              contentType: r.headers.get('content-type'),
              title: titleMatch ? titleMatch[1] : null,
              text,
            };
          }, fromStr, toStr);
        }

        if (txnResp.status >= 400) {
          onProgress({ step: 'account-error', message: `שגיאה בחשבון ${maskedNumber}: HTTP ${txnResp.status}`, account: maskedNumber });
          continue;
        }

        let txnBody = null;
        try { txnBody = JSON.parse(txnResp.text || '{}'); } catch {}

        // get428Index should always return JSON. A parse failure means something
        // other than the real API response came back (redirect, challenge page,
        // WAF block, etc.) — surface it as an explicit account-level error
        // instead of silently reporting zero transactions as a fake success.
        if (!txnBody) {
          const body = txnResp.text || '';
          const hasLoginForm = /userNumberDesktopHeb|passwordDesktopHeb/.test(body);
          const hasAppShell = /ng-version|app-root/.test(body);
          onProgress({
            step: 'account-error',
            message: `חשבון ${maskedNumber}: תגובה לא-תקינה מהבנק (לא JSON) — redirected=${txnResp.redirected} finalUrl=${txnResp.finalUrl} contentType=${txnResp.contentType} title="${txnResp.title || ''}" bodyLength=${body.length} hasLoginForm=${hasLoginForm} hasAppShell=${hasAppShell}. לא נמשכו תנועות. גוף התגובה (3000 תווים ראשונים): ${body.slice(0, 3000)}`,
            account: maskedNumber,
          });
          continue;
        }

        const rows = txnBody?.body?.table?.rows ?? [];
        const realRows = rows.filter(r => r.RecTypeSpecified && r.MC02PeulaTaaEZSpecified);

        if (!realRows.length) {
          onProgress({
            step: 'debug-txn-shape',
            message: `[DEBUG] ${maskedNumber}: bodyKeys=${Object.keys(txnBody).join(',')} rows=${rows.length} realRows=0` +
              (rows[0] ? ` firstRowKeys=${Object.keys(rows[0]).join(',')} firstRow=${JSON.stringify(rows[0]).slice(0, 800)}` : ' (rows array itself is empty)'),
            account: maskedNumber,
          });
        }

        const ymdIso = (raw) => raw ? String(raw).slice(0, 10) : null;
        transactions = realRows.map(r => {
          const amountRaw = Number(String(r.MC02SchumEZ || 0).replace(/,/g, ''));
          const isCredit = r.MC02OfiSchumEZ === 1 || r.MC02OfiSchumEZ === '1';
          const signedAmount = isCredit ? Math.abs(amountRaw) : -Math.abs(amountRaw);
          const balanceRaw = r.MC02YitraEZ != null ? Number(String(r.MC02YitraEZ).replace(/,/g, '')) : null;
          const ref = r.MC02AsmEZ || r.MC02AsmahtaMekoritEZ || r.TransactionNumber;
          return {
            transactionID: `${maskedNumber}|${ymdIso(r.MC02PeulaTaaEZ) || ymdIso(r.TaarichEreh) || ''}|${ref || ''}|${r.RowNumber || ''}`,
            date: ymdIso(r.MC02PeulaTaaEZ) || ymdIso(r.TaarichEreh),
            effectiveDate: ymdIso(r.TaarichEreh) || ymdIso(r.MC02PeulaTaaEZ),
            description: r.MC02TnuaTeurEZ || r.Teur || '',
            extendedDescription: r.P428G2Details || null,
            amount: signedAmount,
            runningBalance: balanceRaw,
            beneficiaryName: r.NegdiShem || null,
            beneficiaryBankCode: r.NegdiBank != null ? String(r.NegdiBank) : null,
            beneficiaryBranch: r.NegdiSnif != null ? String(r.NegdiSnif) : null,
            beneficiaryAccountNumber: r.NegdiCheshbon != null ? String(r.NegdiCheshbon) : null,
            referenceNumber: ref != null ? String(ref) : null,
          };
        });
      }
      } catch (e) {
        onProgress({
          step: 'account-error',
          message: `שגיאה בחשבון ${maskedNumber}: ${e.message}`,
          account: maskedNumber,
        });
        continue;
      }

      results.push({
        account: {
          accountIndex: Number(acc.Number) || i,
          maskedNumber,
          corporateName: corporateName || maskedNumber,
          balance,
          iban: null,
          branchId: acc.BranchForDispaly || acc.Branch || null,
          branchName: null,
        },
        transactions: { history: transactions, pending: [] },
        additionalTransactionsFlag: false,
      });

      onProgress({
        step: 'account-done',
        message: `${maskedNumber}: ${transactions.length} תנועות, יתרה ₪${balance ?? '?'}`,
        account: maskedNumber,
        count: transactions.length,
      });
    }

    onProgress({ step: 'done', message: `סיום: ${results.length} חשבונות`, total: results.length });
    return { fromDate: fromStr, toDate: toStr, accounts: results };
  } finally {
    await browser.close();
  }
}

export const bankInfo = {
  id: 'mizrachi',
  nameHe: 'בנק מזרחי-טפחות',
};
