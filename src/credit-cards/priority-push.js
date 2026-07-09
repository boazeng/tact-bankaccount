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

/**
 * Checks Priority itself for an existing page on this exact CASHNAME+date —
 * not just our own local card_priority_pushes tracking, which can drift out
 * of sync with reality (e.g. a page pushed through some other route, or a
 * page manually deleted in Priority after our local table already recorded
 * it). Returns { BPYEAR, CASH, BPNUM } if one exists, or null.
 */
export async function findExistingCardPage(cashName, curdate) {
  // Range comparison, not eq — matches the proven pattern already used
  // against this same Priority instance in src/priority/check.js.
  const params = new URLSearchParams({
    '$filter': `CASHNAME eq '${cashName}' and CURDATE ge ${curdate}T00:00:00Z and CURDATE le ${curdate}T23:59:59Z`,
    '$select': 'BPYEAR,CASH,BPNUM',
    '$top': '1',
  });
  const r = await fetch(`${PRIORITY_URL}/BANKPAGES?${params}`, { headers: getHeaders });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`BANKPAGES existence check failed: HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  if (!data.value?.length) return null;
  const { BPYEAR, CASH, BPNUM } = data.value[0];
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
 * Pushes one card's billing-cycle page (from getPriorityPreviewForCard) to
 * Priority: checks Priority itself for an existing page on this CASHNAME+date
 * first (see findExistingCardPage — this is the real duplicate guard, not
 * just our local tracking table), and only creates a new BANKPAGES record
 * and posts lines if none exists yet. Returns
 * { bpyear, cash, bpnum, pushed, failed, alreadyExisted }.
 * Caller is responsible for recording the result (recordPagePushed) — this
 * function only talks to Priority, it doesn't touch our own DB.
 */
export async function pushCardPageToPriority(cashName, page) {
  const existing = await findExistingCardPage(cashName, page.curdate);
  if (existing) {
    return { bpyear: existing.BPYEAR, cash: existing.CASH, bpnum: existing.BPNUM, pushed: [], failed: [], alreadyExisted: true };
  }

  const bankPage = await createCardBankPage(cashName, page.curdate);
  const url = `${PRIORITY_URL}/${bankPageNavPath(bankPage)}`;

  const pushed = [];
  const failed = [];
  for (const line of page.lines) {
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

  return { bpyear: bankPage.BPYEAR, cash: bankPage.CASH, bpnum: bankPage.BPNUM, pushed, failed, alreadyExisted: false };
}

export function priorityConfigured() {
  return !!(PRIORITY_URL && PRIORITY_USERNAME && PRIORITY_PASSWORD);
}
