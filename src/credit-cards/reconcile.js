import { getAccountByMaskedNumber, getTransactionsForEffectiveDate } from '../db.js';

// The fixed text each bank actually puts in the CHECKING ACCOUNT's own
// transaction description for a credit-card debit — confirmed live by the
// user reading her own real bank statements, not guessed. Discount's format
// embeds the card's own last4 (e.g. "חיוב לכרטיס ויזה 4222 5940 /4547"), so a
// cardLast4 check is added there to disambiguate multiple cards debited the
// same account on the same day; Leumi/Poalim don't expose that in the text,
// so any debit matching the fixed phrase that day is the candidate.
const CARD_DEBIT_DESCRIPTION = {
  discount: (description, cardLast4) => description.includes('חיוב לכרטיס') && (!cardLast4 || description.includes(cardLast4)),
  leumi: (description) => description.includes('לאומי ויזה'),
  poalim: (description) => description.includes('אמריקן אקספרס'),
};

/**
 * Finds the real checking-account debit transaction for a credit-card
 * billing cycle on one specific date — the independent anchor a card page's
 * closing line must match. This exists because of a real incident: a page's
 * "תשלום בפועל בבנק" line used to be computed purely by summing our own
 * card_transactions rows, so a bug on that side (a duplicate, a transaction
 * assigned to the wrong billing_date) silently reproduced itself in the
 * total too — nothing independently confirmed it against what the bank
 * itself actually debited. See [[credit_cards_billing_date_split]].
 *
 * Returns { status, amount }: status is 'matched' (exactly one real debit
 * found — amount is its absolute value), 'ambiguous' (more than one
 * candidate that day, can't tell which is ours), or 'not-found' (no
 * matching debit — e.g. the checking account for this bank/date hasn't been
 * synced, or account_masked_number doesn't line up).
 */
export function findRealBankDebit({ bankId, accountMaskedNumber, cardLast4, date }) {
  if (!accountMaskedNumber || !date) return { status: 'not-found', amount: null };

  const account = getAccountByMaskedNumber(bankId, accountMaskedNumber);
  if (!account) return { status: 'not-found', amount: null };

  const matcher = CARD_DEBIT_DESCRIPTION[bankId];
  const debits = getTransactionsForEffectiveDate(account.id, date).filter(t => Number(t.amount) < 0);
  const candidates = matcher
    ? debits.filter(t => matcher(t.description || '', cardLast4))
    : debits;

  if (candidates.length === 1) return { status: 'matched', amount: Math.abs(Number(candidates[0].amount)) };
  if (candidates.length === 0) return { status: 'not-found', amount: null };
  return { status: 'ambiguous', amount: null };
}
