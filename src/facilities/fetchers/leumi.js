// Leumi loans fetch — reuses the checking-account scraper's already-
// authenticated page/session (see src/scrapers/leumi.js), same pattern as
// the Poalim credit-card fetch reusing its own session. Leumi has no
// deposits/guarantees product for this business (confirmed live), so this
// only ever returns loans.
const ymdToIso = (s) => (s && String(s).length === 8)
  ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}`
  : null;

export async function fetchLeumiLoansForAccount(page, accountIndex, tplHeaders) {
  const resp = await page.evaluate(async (idx, headers) => {
    const r = await fetch(
      `/v1/corp/ui-corp-loans/loans/digitalfront/accounts/${idx}/loans`,
      { credentials: 'include', headers },
    );
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  }, accountIndex, tplHeaders ?? {});

  if (resp.status !== 200 || !resp.body) return [];

  const loans = [];
  for (const byCurrency of resp.body.loansByCurrency ?? []) {
    for (const item of byCurrency.loansItems ?? []) {
      loans.push({
        category: 'loan',
        externalId: item.loanNumber,
        label: item.loanTypeDesc || null,
        principalAmount: item.orgCurrencyLoanAmount ?? null,
        currentAmount: item.orgCurrencyEstimatedLoanBalance ?? item.orgCurrencyLoanBalance ?? null,
        interestRate: item.interestRate ?? null,
        interestDesc: null,
        startDate: ymdToIso(item.bookingDate) ?? ymdToIso(item.effectiveDate),
        endDate: ymdToIso(item.loanEndDate),
        nextPaymentDate: ymdToIso(item.nextRepaymemtDate),
        nextPaymentAmount: item.nextRepaymemtAmount ?? null,
        counterparty: null,
        raw: item,
      });
    }
  }
  return loans;
}
