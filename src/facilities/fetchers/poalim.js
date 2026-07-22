// Poalim deposits/loans/guarantees fetch — reuses the checking-account
// scraper's already-authenticated page/session (see src/scrapers/poalim.js),
// same pattern as fetchPoalimCardsForAccount. All three endpoints are
// account-scoped (same accountId format as the transactions endpoint:
// "{bank}-{branch}-{account}").
const ymdToIso = (s) => (s && String(s).length === 8)
  ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}`
  : null;
// ISO-with-dashes ("2026-07-21") already comes through as-is from the loans
// endpoint — only the YYYYMMDD-formatted fields (deposits/guarantees) need conversion.
const isoOrYmd = (s) => (s && /^\d{8}$/.test(String(s))) ? ymdToIso(s) : (s || null);

async function xsrfHeaders(page) {
  return page.evaluate(() => {
    const xsrf = document.cookie.split('; ').find(c => c.startsWith('XSRF-TOKEN='))?.split('=')[1] || '';
    return {
      'content-type': 'application/json;charset=UTF-8',
      accept: 'application/json, text/plain, */*',
      'x-xsrf-token': decodeURIComponent(xsrf),
    };
  });
}

export async function fetchPoalimFacilitiesForAccount(page, accountId) {
  const headers = await xsrfHeaders(page);

  const [depositsResp, loansResp, guaranteesResp] = await Promise.all([
    page.evaluate(async (acctId, h) => {
      const r = await fetch(`/ServerServices/deposits-and-savings/deposits?accountId=${acctId}&view=details&lang=he`,
        { credentials: 'include', headers: h });
      return { status: r.status, body: r.status === 200 ? await r.json() : null };
    }, accountId, headers),
    page.evaluate(async (acctId, h) => {
      const r = await fetch(`/bnhp-api/loan-channel/business-customer-order/v1/computed-loans-and-discounts?accountId=${acctId}&_lang=he-IL`, {
        method: 'POST', credentials: 'include', headers: h,
        body: JSON.stringify({ startupScreenMode: 1, additionalDetailsDisplaySwitch: true }),
      });
      return { status: r.status, body: (r.status === 200 || r.status === 201) ? await r.json() : null };
    }, accountId, headers),
    page.evaluate(async (acctId, h) => {
      const url = `/ServerServices/credit-and-mortgage/v3/businessLoans/guarantee?accountId=${acctId}`
        + `&creditCurrencyCode=-1&dataDetailingLevelCode=1&interestTypeCode=-1&linkageMethodCode=-1`
        + `&unitedCreditTypeCode=-1&creditSystemSubCategory=1&creditLimitCode=0&offset=0&limit=250&lang=he`;
      const r = await fetch(url, { credentials: 'include', headers: h });
      return { status: r.status, body: r.status === 200 ? await r.json() : null };
    }, accountId, headers),
  ]);

  const deposits = [];
  const depositGroups = depositsResp.status === 200 ? (depositsResp.body?.list ?? []) : [];
  for (const group of depositGroups) {
    for (const item of group.data ?? []) {
      deposits.push({
        category: 'deposit',
        externalId: item.depositSerialId,
        label: item.shortProductName || item.productFreeText || null,
        principalAmount: item.principalAmount ?? null,
        currentAmount: item.revaluedTotalAmount ?? item.finalRepaymentAmount ?? null,
        interestRate: item.nominalInterest ?? item.adjustedInterest ?? null,
        interestDesc: item.variableInterestDescription || item.interestBaseDescription || null,
        startDate: isoOrYmd(item.agreementOpeningDate),
        endDate: isoOrYmd(item.endExitDate),
        nextPaymentDate: isoOrYmd(item.paymentDate),
        nextPaymentAmount: null,
        counterparty: null,
        raw: item,
      });
    }
  }

  const loans = [];
  for (const item of (loansResp.status === 200 || loansResp.status === 201) ? (loansResp.body?.data?.loansList ?? []) : []) {
    loans.push({
      category: 'loan',
      externalId: item.loanSN,
      label: item.creditTypeDescription || null,
      principalAmount: item.principalAmount ?? null,
      currentAmount: item.loanBalanceAmount ?? item.totalDebt ?? null,
      interestRate: null,
      interestDesc: item.interestTypeDescription || null,
      startDate: isoOrYmd(item.valueDate),
      endDate: isoOrYmd(item.loanEndDate),
      nextPaymentDate: isoOrYmd(item.nextPaymentDate),
      nextPaymentAmount: item.nextPaymentAmount ?? null,
      counterparty: null,
      raw: item,
    });
  }

  const guarantees = [];
  for (const item of guaranteesResp.status === 200 ? (guaranteesResp.body?.guarantees ?? []) : []) {
    guarantees.push({
      category: 'guarantee',
      externalId: item.creditSerialNumber,
      label: item.creditTypeDescription || null,
      principalAmount: item.originalLoanPrincipalAmount ?? null,
      currentAmount: item.debtAmount ?? item.loanBalanceAmount ?? null,
      interestRate: null,
      interestDesc: item.interestTypeDescription || null,
      startDate: isoOrYmd(item.valueDate),
      endDate: isoOrYmd(item.loanEndDate),
      nextPaymentDate: null,
      nextPaymentAmount: null,
      counterparty: item.creditBeneficiaryName || null,
      raw: item,
    });
  }

  return { deposits, loans, guarantees };
}
