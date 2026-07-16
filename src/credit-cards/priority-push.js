// Independent implementation of the Priority BANKPAGES/BANKLINES push, kept
// separate from src/priority/push.js on purpose (see plan: src/credit-cards/
// shares no code with the rest of the app). The one structural difference:
// bank pages get one page per DAY (BPNUMA = YYMMDD), but credit-card pages
// are pushed once per MONTH, so BPNUMA here is a simple running counter per
// CASHNAME instead — "דף רץ" per the user's explicit instruction.

const PRIORITY_URL = (process.env.PRIORITY_URL_REAL || '').replace(/\/$/, '');
const PRIORITY_USERNAME = process.env.PRIORITY_USERNAME || '';
const PRIORITY_PASSWORD = process.env.PRIORITY_PASSWORD || '';

const authHeader = 'Basic ' + Buffer.from(`${PRIORITY_USERNAME}:${PRIORITY_PASSWORD}`).toString('base64');
const getHeaders = {
  authorization: authHeader,
  accept: 'application/json',
  'odata-version': '4.0',
};
const postHeaders = {
  ...getHeaders,
  'content-type': 'application/json',
};

/**
 * Finds the highest existing BPNUMA (running page number) for this
 * CASHNAME+year in Priority and returns the next integer, or 1 if none
 * exist yet. Priority itself is the source of truth for "what's next" —
 * we don't track this counter locally.
 */
async function nextRunningPageNumber(cashName, year) {
  const params = new URLSearchParams({
    '$filter': `CASHNAME eq '${cashName}' and BPYEAR eq '${year}'`,
    '$select': 'BPNUMA',
    '$orderby': 'BPNUMA desc',
    '$top': '1',
  });
  const r = await fetch(`${PRIORITY_URL}/BANKPAGES?${params}`, { headers: getHeaders });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`BANKPAGES lookup failed: HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  const highest = data.value?.[0]?.BPNUMA;
  const n = highest != null ? parseInt(highest, 10) : 0;
  return (Number.isFinite(n) ? n : 0) + 1;
}

// Collapses internal whitespace runs and trims — a CASHNAME that looks
// identical on screen can still fail an OData `eq` filter over a trailing
// space, a double space, or other invisible whitespace difference picked up
// wherever the value was originally typed into Priority. Comparing
// normalized text client-side instead of filtering by CASHNAME server-side
// is what actually makes the match reliable.
function normalizeCashName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * All BANKPAGES rows for a given date, across every CASHNAME — deliberately
 * NOT filtered by CASHNAME server-side (see normalizeCashName). Callers
 * match the CASHNAME they care about themselves.
 */
async function fetchBankPagesForDate(curdate) {
  const params = new URLSearchParams({
    '$filter': `CURDATE ge ${curdate}T00:00:00Z and CURDATE le ${curdate}T23:59:59Z`,
    '$select': 'CASHNAME,BPYEAR,CASH,BPNUM',
    '$top': '200',
  });
  const r = await fetch(`${PRIORITY_URL}/BANKPAGES?${params}`, { headers: getHeaders });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`BANKPAGES lookup failed: HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.value || [];
}

/**
 * Checks Priority itself for an existing page on this exact CASHNAME+date —
 * not just our own local card_priority_pushes tracking, which can drift out
 * of sync with reality (e.g. a page pushed through some other route, or a
 * page manually deleted in Priority after our local table already recorded
 * it). Returns { BPYEAR, CASH, BPNUM } if one exists, or null.
 */
export async function findExistingCardPage(cashName, curdate) {
  const rows = await fetchBankPagesForDate(curdate);
  const target = normalizeCashName(cashName);
  const match = rows.find(row => normalizeCashName(row.CASHNAME) === target);
  if (!match) return null;
  const { BPYEAR, CASH, BPNUM } = match;
  return { BPYEAR, CASH, BPNUM };
}

/**
 * Creates a new BANKPAGES record for this card's billing-cycle page.
 * Returns { BPYEAR, CASH, BPNUM }. Callers must check findExistingCardPage()
 * first — this always creates a new page, it never looks for an existing one.
 */
async function createCardBankPage(cashName, curdate) {
  const year = curdate.slice(0, 4);
  const bpnuma = await nextRunningPageNumber(cashName, year);

  const r = await fetch(`${PRIORITY_URL}/BANKPAGES`, {
    method: 'POST',
    headers: postHeaders,
    body: JSON.stringify({
      CASHNAME: cashName,
      CURDATE: `${curdate}T00:00:00Z`,
      BPYEAR: year,
      BPNUMA: String(bpnuma),
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`BANKPAGES create failed: HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  return { BPYEAR: data.BPYEAR, CASH: data.CASH, BPNUM: data.BPNUM };
}

function bankPageNavPath(bp) {
  return `BANKPAGES(BPYEAR='${bp.BPYEAR}',CASH=${bp.CASH},BPNUM=${bp.BPNUM})/BANKLINES_SUBFORM`;
}

function buildCardLinePayload(line) {
  return {
    CURDATE: `${line.curdate}T00:00:00Z`,
    BTCODE: line.btcode,
    DETAILS: line.details.slice(0, 24),
    TRANSDESC: line.details.slice(0, 80),
    CREDIT: line.credit || 0,
    DEBIT: line.debit || 0,
  };
}

/**
 * Fetches the bank-lines Priority already has for this CASHNAME+date, so a
 * retry can tell which of our expected lines are genuinely missing instead
 * of trusting our own local "pushed" bookkeeping (which drifted from reality
 * — see the push/check split below). Same normalized client-side CASHNAME
 * match as findExistingCardPage, for the same reason.
 */
export async function fetchExistingCardLines(cashName, curdate) {
  const params = new URLSearchParams({
    '$filter': `CURDATE ge ${curdate}T00:00:00Z and CURDATE le ${curdate}T23:59:59Z`,
    '$select': 'CASHNAME,DETAILS,CREDIT,DEBIT',
    '$top': '500',
  });
  const r = await fetch(`${PRIORITY_URL}/BANKLINESA?${params}`, { headers: getHeaders });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`BANKLINESA lookup failed: HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  const target = normalizeCashName(cashName);
  return (data.value || []).filter(l => normalizeCashName(l.CASHNAME) === target);
}

/**
 * Matches our expected lines (details text + amount) against what Priority
 * actually has, consuming each existing line at most once so two lines with
 * the same merchant+amount on one page can't both match a single Priority
 * row. Returns the subset of `lines` that are NOT yet in Priority.
 */
export function diffMissingLines(lines, existingLines) {
  const pool = existingLines.map(l => ({
    details: (l.DETAILS || '').trim(),
    credit: Number(l.CREDIT || 0),
    debit: Number(l.DEBIT || 0),
    used: false,
  }));
  const missing = [];
  for (const line of lines) {
    const details = line.details.slice(0, 24);
    const credit = line.credit || 0;
    const debit = line.debit || 0;
    const idx = pool.findIndex(p => !p.used && p.details === details
      && Math.abs(p.credit - credit) < 0.01 && Math.abs(p.debit - debit) < 0.01);
    if (idx === -1) missing.push(line);
    else pool[idx].used = true;
  }
  return missing;
}

/**
 * Live status of one card page against Priority itself — this is what the
 * UI should show as "נקלט"/"טרם נקלט", NOT our local card_priority_pushes
 * table, which only records that a push was attempted and can't tell
 * whether every line actually landed (see pushCardPageToPriority).
 * When nothing matches but Priority DOES have other pages on that date, the
 * other CASHNAMEs found are returned too — a page that looks captured to
 * the eye but a different-looking CASHNAME in Priority is exactly the kind
 * of mismatch normalizeCashName can't fix silently, so surface it instead.
 * Returns { status: 'missing'|'partial'|'complete', missingCount, otherCashnamesOnDate? }.
 */
export async function checkCardPageStatus(cashName, page) {
  const rows = await fetchBankPagesForDate(page.curdate);
  const target = normalizeCashName(cashName);
  const existing = rows.find(row => normalizeCashName(row.CASHNAME) === target);
  if (!existing) {
    const otherCashnamesOnDate = [...new Set(rows.map(r => r.CASHNAME).filter(Boolean))];
    return { status: 'missing', missingCount: page.lines.length, otherCashnamesOnDate };
  }
  const existingLines = await fetchExistingCardLines(cashName, page.curdate);
  const missing = diffMissingLines(page.lines, existingLines);
  return { status: missing.length === 0 ? 'complete' : 'partial', missingCount: missing.length };
}

/**
 * Pushes one card's billing-cycle page (from getPriorityPreviewForCard) to
 * Priority. Checks Priority itself for an existing page on this
 * CASHNAME+date first (see findExistingCardPage — the real duplicate guard,
 * not just our local tracking table). If the page already exists, diffs our
 * expected lines against what's actually there and pushes only what's
 * missing — a page that was left partial by a previous failed attempt gets
 * topped up instead of being silently treated as done.
 * Returns { bpyear, cash, bpnum, pushed, failed, alreadyExisted, hadExistingPage }.
 * Caller is responsible for recording the result (recordPagePushed) — this
 * function only talks to Priority, it doesn't touch our own DB.
 */
export async function pushCardPageToPriority(cashName, page) {
  const existing = await findExistingCardPage(cashName, page.curdate);
  let bankPage = existing;
  let linesToPush = page.lines;

  if (existing) {
    const existingLines = await fetchExistingCardLines(cashName, page.curdate);
    linesToPush = diffMissingLines(page.lines, existingLines);
    if (linesToPush.length === 0) {
      return {
        bpyear: existing.BPYEAR, cash: existing.CASH, bpnum: existing.BPNUM,
        pushed: [], failed: [], alreadyExisted: true, hadExistingPage: true,
      };
    }
  } else {
    bankPage = await createCardBankPage(cashName, page.curdate);
  }

  const url = `${PRIORITY_URL}/${bankPageNavPath(bankPage)}`;

  const pushed = [];
  const failed = [];
  for (const line of linesToPush) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: postHeaders,
        body: JSON.stringify(buildCardLinePayload(line)),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        let msg = text.slice(0, 400);
        try {
          const parsed = JSON.parse(text);
          msg = parsed?.error?.message || parsed?.FORM?.InterfaceErrors?.text || msg;
        } catch {}
        failed.push({ details: line.details, error: `HTTP ${r.status}: ${msg.slice(0, 200)}` });
      } else {
        pushed.push(line.details);
      }
    } catch (e) {
      failed.push({ details: line.details, error: e.message });
    }
  }

  return {
    bpyear: bankPage.BPYEAR, cash: bankPage.CASH, bpnum: bankPage.BPNUM,
    pushed, failed, alreadyExisted: false, hadExistingPage: !!existing,
  };
}

export function priorityConfigured() {
  return !!(PRIORITY_URL && PRIORITY_USERNAME && PRIORITY_PASSWORD);
}
