// Pushes current bank balances to the Flow app's cashflow board.
// Shared by the interactive sync route and the daily scheduler — both
// call this right after a bank finishes syncing.
import { getAccountBalances } from './db.js';

const FLOW_BALANCE_MAPPING = [
  { bankId: 'poalim',   match: 'חניה',   flowKey: 'חניה_פועלים' },
  { bankId: 'poalim',   match: 'אנרגיה', flowKey: 'אנרגיה_פועלים' },
  { bankId: 'discount', match: null,      flowKey: 'אחזקה_דיסקונט' },
  { bankId: 'mizrachi', match: null,      flowKey: 'אחזקה_מזרחי' },
];

export async function pushBalancesToFlow() {
  const flowUrl = process.env.FLOW_API_URL;
  const flowKey = process.env.FLOW_API_KEY;
  if (!flowUrl || !flowKey) return;

  const accounts = getAccountBalances();
  const payload = {};
  for (const rule of FLOW_BALANCE_MAPPING) {
    const acc = accounts.find(a =>
      a.bank_id === rule.bankId &&
      (!rule.match || (a.corporate_name || '').includes(rule.match))
    );
    if (acc != null) payload[rule.flowKey] = acc.last_balance;
  }
  if (Object.keys(payload).length === 0) return;

  const res = await fetch(`${flowUrl}/api/bank-balances-push`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${flowKey}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`flow responded ${res.status}`);
  console.log('[flow-push] balances pushed:', payload);
}

/**
 * Reports the outcome of an automated run (daily scheduler) to Flow so it's
 * visible somewhere other than this app's own container logs. Best-effort:
 * never throws — a notification failure shouldn't make the run itself
 * look failed. Needs the small sync-status-push endpoint on Flow's backend.
 */
export async function pushSyncStatusToFlow(status) {
  const flowUrl = process.env.FLOW_API_URL;
  const flowKey = process.env.FLOW_API_KEY;
  if (!flowUrl || !flowKey) return;
  try {
    const res = await fetch(`${flowUrl}/api/sync-status-push`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${flowKey}` },
      body: JSON.stringify(status),
    });
    if (!res.ok) throw new Error(`flow responded ${res.status}`);
  } catch (e) {
    console.error('[flow-push] sync-status push failed:', e.message);
  }
}
