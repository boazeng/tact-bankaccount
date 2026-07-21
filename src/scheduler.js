// Daily unattended run: syncs every bank (+ credit cards where supported),
// then pushes whatever's new to Priority. Runs on a cron schedule inside
// this same server process — no separate script, no manual trigger needed.
//
// Banks that hit an SMS/2FA prompt can't be completed unattended (no human
// to type the code), so onSmsRequired always rejects immediately here —
// that bank/card is skipped and logged, the run continues with the rest.
// This mirrors what the "סנכרן בנקים" + "קלוט לפריוריטי" dashboard buttons
// do (see public/app.js), just without a browser attached.
import cron from 'node-cron';
import { listBanks } from './scrapers/index.js';
import { runBankSync } from './sync-service.js';
import { runCardBankSync, cardScraperRegistry, pushAllCardsToPriority } from './credit-cards/routes.js';
import { autoMatchCashnames, pushAccountToPriority } from './priority-service.js';
import { listBanksWithAccounts } from './db.js';
import { pushBalancesToFlow, pushSyncStatusToFlow } from './flow-push.js';

const DAILY_SYNC_DAYS_BACK = 7;
const ACTOR = 'daily-scheduler';

const rejectSmsRequired = () => Promise.reject(new Error('נדרש קוד SMS — לא ניתן להשלים אוטומטית, מדולג'));

export async function runDailyJob() {
  const startedAt = new Date();
  const log = [];
  const note = (line) => { console.log(`[daily-job] ${line}`); log.push(line); };

  note(`מתחילה ריצה יומית אוטומטית — ${startedAt.toISOString()}`);

  let totalNewTxns = 0;
  let bankErrors = 0;

  for (const bank of listBanks()) {
    try {
      const result = await runBankSync(bank.id, {
        daysBack: DAILY_SYNC_DAYS_BACK,
        actor: ACTOR,
        onSmsRequired: rejectSmsRequired,
      });
      totalNewTxns += result.totalNewSaved;
      note(`✓ ${result.bankName}: ${result.totalNewSaved} תנועות חדשות (${result.accountsCount} חשבונות)`);
    } catch (e) {
      bankErrors++;
      note(`✗ ${bank.nameHe}: ${e.message}`);
      continue; // don't attempt this bank's cards if the checking-account sync itself failed
    }

    if (cardScraperRegistry[bank.id]) {
      try {
        const cardResult = await runCardBankSync(bank.id, { actor: ACTOR, onSmsRequired: rejectSmsRequired });
        totalNewTxns += cardResult.totalNewTxns;
        note(`✓ כרטיסי אשראי ${bank.nameHe}: ${cardResult.totalNewTxns} תנועות חדשות (${cardResult.totalCards} כרטיסים)`);
      } catch (e) {
        bankErrors++;
        note(`✗ כרטיסי אשראי ${bank.nameHe}: ${e.message}`);
      }
    }
  }

  try {
    await pushBalancesToFlow();
  } catch (e) {
    note(`✗ דחיפת יתרות ל-Flow נכשלה: ${e.message}`);
  }

  note('── קליטה לפריוריטי ──');
  let totalPushed = 0, totalFailed = 0, priorityErrors = 0;

  try {
    const matchResult = await autoMatchCashnames();
    note(`זוהו ${matchResult.matched} חשבונות מתוך ${matchResult.matched + matchResult.unmatched}`);
  } catch (e) {
    priorityErrors++;
    note(`✗ שגיאה בזיהוי קופות: ${e.message}`);
  }

  const banks = listBanksWithAccounts();
  const withCashname = banks.flatMap(b => b.accounts.filter(a => a.is_active && a.priority_cashname));
  for (const acc of withCashname) {
    const label = acc.corporate_name || acc.masked_number;
    try {
      const r = await pushAccountToPriority(acc.id, { preview: false });
      totalPushed += r.pushed || 0;
      totalFailed += r.failed || 0;
      if (r.pushed || r.failed) {
        note(`✓ ${label}: ${r.pushed} נקלטו, ${r.failed} נכשלו (${r.matched} כבר היו)`);
      }
    } catch (e) {
      priorityErrors++;
      note(`✗ ${label}: ${e.message}`);
    }
  }

  try {
    const cardPush = await pushAllCardsToPriority();
    for (const c of cardPush.byCard) {
      if (c.error) {
        priorityErrors++;
        note(`✗ כרטיס ${c.cardLast4}: ${c.error}`);
        continue;
      }
      const results = c.results || [];
      const failedPages = results.filter(r => !r.ok);
      const newPages = results.filter(r => r.ok && !r.alreadyExisted);
      if (failedPages.length) priorityErrors++;
      if (newPages.length || failedPages.length) {
        note(`✓ כרטיס ${c.cardLast4}: ${newPages.length} דפים נקלטו, ${failedPages.length} נכשלו`);
      }
    }
  } catch (e) {
    priorityErrors++;
    note(`✗ שגיאה בקליטת כרטיסי אשראי: ${e.message}`);
  }

  const finishedAt = new Date();
  const ok = bankErrors === 0 && priorityErrors === 0;
  note(`סיום — ${ok ? 'הצליח' : `${bankErrors + priorityErrors} שגיאות`} (${((finishedAt - startedAt) / 1000).toFixed(0)}ש')`);

  const summary = {
    ok,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalNewTxns,
    totalPushed,
    totalFailed,
    bankErrors,
    priorityErrors,
    log,
  };
  await pushSyncStatusToFlow(summary);
  return summary;
}

let running = false;

export function startDailyScheduler() {
  cron.schedule('0 7 * * *', async () => {
    if (running) {
      console.warn('[daily-job] previous run still in progress — skipping this trigger');
      return;
    }
    running = true;
    try {
      await runDailyJob();
    } catch (e) {
      console.error('[daily-job] unhandled failure:', e);
    } finally {
      running = false;
    }
  }, { timezone: 'Asia/Jerusalem' });
  console.log('[daily-job] scheduled for 07:00 Asia/Jerusalem daily');
}
