// Mizrachi deposits + loans fetch — reuses the checking-account scraper's
// already-authenticated session (see src/scrapers/mizrachi.js).
//
// Deposits use a normal SPA JSON endpoint (getAllDepositsAndSavings) — safe
// to call directly via fetch, unlike get428Index (transactions), which sits
// behind Radware bot detection (see the big comment block in
// src/scrapers/mizrachi.js). This endpoint was captured live going through
// the ordinary menu click, with no bot-detection bounce.
//
// Loans have no JSON API at all — the "הלוואות שלי" screen is a legacy
// ASP.NET WebForms page (Online/Loan/P060.aspx) that server-renders the data
// straight into an HTML table (Telerik RadGrid). Fetched in a fresh tab
// (new browser page, same cookies/session) rather than navigating the main
// page, since touching the main page's iframes elsewhere in the sync has
// previously left them detached and broken the rest of that account's sync.

const ymdToIso = (s) => {
  if (!s) return null;
  const str = String(s);
  return /^\d{8}$/.test(str) ? `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}` : null;
};

export async function fetchMizrachiDepositsForAccount(page) {
  const resp = await page.evaluate(async () => {
    const r = await fetch('/Online/api/HS/getAllDepositsAndSavings', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
      body: '{}',
    });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  });
  if (resp.status !== 200 || !resp.body) return [];

  const rows = resp.body.body?.depositAndSavingRowObj ?? [];
  const byLabel = (dyn, label) => dyn.find(d => d.label === label)?.value ?? null;

  return rows.map(item => {
    const dyn = item.dynamicDataStructure ?? [];
    return {
      category: 'deposit',
      externalId: item.id,
      label: item.depositDesc || item.name || null,
      principalAmount: Number(byLabel(dyn, 'SCHUMKEREN')) || null,
      currentAmount: Number(byLabel(dyn, 'YOMISCHUMMESH') ?? byLabel(dyn, 'ZMPSCHUMMESH')) || null,
      interestRate: Number(byLabel(dyn, 'RIBITNOMINALIT')) || null,
      interestDesc: null,
      startDate: ymdToIso(byLabel(dyn, 'TARHAFKADA')),
      endDate: ymdToIso(byLabel(dyn, 'ZMPSOFI')),
      nextPaymentDate: ymdToIso(byLabel(dyn, 'TARMESHICHAKA')),
      nextPaymentAmount: null,
      counterparty: null,
      raw: item,
    };
  });
}

function stripTags(html) {
  return (html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

export function parseMizrachiLoansHtml(html) {
  const gridMatch = html.match(/id="[^"]*grvHalv_ctl00"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
  if (!gridMatch) return [];
  const rowsHtml = gridMatch[1].match(/<tr[^>]*class="rg(?:Row|AltRow)"[\s\S]*?<\/tr>/g) || [];

  const toIso = (raw, twoDigitYear) => {
    const m = (raw || '').match(twoDigitYear ? /(\d{2})\/(\d{2})\/(\d{2})$/ : /(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const [, dd, mm, yy] = m;
    return `${twoDigitYear ? `20${yy}` : yy}-${mm}-${dd}`;
  };
  const num = (s) => {
    const n = parseFloat((s || '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const loans = [];
  for (const rowHtml of rowsHtml) {
    const cells = (rowHtml.match(/<td[\s\S]*?<\/td>/g) || []).map(stripTags);
    if (cells.length < 13) continue;
    loans.push({
      category: 'loan',
      externalId: cells[0],
      label: cells[1] || null,
      principalAmount: num(cells[10]),
      currentAmount: num(cells[11]),
      interestRate: num(cells[9]),
      interestDesc: null,
      startDate: toIso(cells[4], false),
      endDate: toIso(cells[3], true),
      nextPaymentDate: null,
      nextPaymentAmount: null,
      counterparty: null,
      raw: { loanNumber: cells[0], loanType: cells[1], purpose: cells[12] },
    });
  }
  return loans;
}

// Only the ILS loans page (P060) is scraped — the foreign-currency loans
// page (P513) uses the same legacy RadGrid pattern but wasn't captured live
// and this business has none currently, so it's left for whenever that's
// actually needed rather than guessed at.
export async function fetchMizrachiLoansForAccount(browser, onProgress = () => {}) {
  let loanPage = null;
  try {
    loanPage = await browser.newPage();
    await loanPage.goto('https://mto.mizrahi-tefahot.co.il/Online/Loan/P060.aspx', {
      waitUntil: 'networkidle2', timeout: 30_000,
    });
    const html = await loanPage.content();
    return parseMizrachiLoansHtml(html);
  } catch (e) {
    onProgress({ step: 'facilities-error', message: `שגיאה בשליפת הלוואות ממזרחי: ${e.message}` });
    return [];
  } finally {
    if (loanPage) await loanPage.close().catch(() => {});
  }
}
