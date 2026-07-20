// Self-contained script for the credit-cards page — intentionally has zero
// shared code with app.js (see plan: src/credit-cards/ is fully isolated).

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtMoney = (n) => {
  const v = Number(n ?? 0);
  return (v < 0 ? '-' : '') + '₪' + Math.abs(v).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const BANK_NAMES = { discount: 'בנק דיסקונט', poalim: 'בנק הפועלים', leumi: 'בנק לאומי', mizrachi: 'בנק מזרחי טפחות' };

async function renderUserChip() {
  const target = document.getElementById('user-chip');
  if (!target) return;
  try {
    const res = await fetch('/auth/me');
    const me = await res.json();
    if (!me?.email) {
      target.innerHTML = `<a href="/login" class="btn btn-ghost btn-sm">התחברות</a>`;
      return;
    }
    const initial = (me.name || me.email).charAt(0).toUpperCase();
    target.innerHTML = `
      <div class="user-chip">
        <span class="avatar">${escapeHtml(initial)}</span>
        <span>${escapeHtml(me.name || me.email.split('@')[0])}</span>
        <span class="role-tag">${escapeHtml(me.role)}</span>
        <a href="/logout">יציאה</a>
      </div>
    `;
  } catch {}
}

async function loadCards() {
  const container = document.getElementById('cards-container');
  try {
    const res = await fetch('/api/credit-cards');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { cards } = await res.json();

    if (!cards.length) {
      container.innerHTML = `<p class="empty" style="padding: 32px;">אין עדיין כרטיסי אשראי מסונכרנים.</p>`;
      return;
    }

    container.innerHTML = cards.map(c => `
      <div class="bank-summary-item card-item" data-card-id="${c.id}">
        <div class="bank-summary-row" style="cursor:pointer;">
          <div>
            <b>${escapeHtml(BANK_NAMES[c.bank_id] || c.bank_id)}</b>
            · כרטיס •••• ${escapeHtml(c.card_last4)}
            ${c.label ? `· ${escapeHtml(c.label)}` : ''}
          </div>
          <div style="color:var(--color-text-light); font-size:.9rem;">
            ${c.account_masked_number ? escapeHtml(c.account_masked_number) + ' · ' : ''}
            ${c.txn_count} תנועות
            ${c.last_txn_date ? '· עד ' + escapeHtml(c.last_txn_date) : ''}
          </div>
        </div>
        <div class="card-txns" style="display:none; padding: 12px 16px;">
          <div class="cashname-row" style="display:flex; gap:8px; align-items:center; margin-bottom:12px;">
            <label style="font-size:.9rem; color:var(--color-text-light);">קופה בפריוריטי (CASHNAME):</label>
            <input type="text" class="cashname-input" data-card-id="${c.id}" value="${escapeHtml(c.priority_cashname || '')}" placeholder="לדוגמה: כרטיס-4222" style="max-width:180px;">
            <button class="btn btn-ghost btn-sm cashname-save-btn" data-card-id="${c.id}">שמור</button>
            <button class="btn btn-push btn-sm push-priority-btn" data-card-id="${c.id}" ${c.priority_cashname ? '' : 'disabled title="יש להגדיר קופה קודם"'}>↑ קלוט לפריוריטי</button>
            <span class="cashname-status" data-card-id="${c.id}"></span>
          </div>
          <div class="priority-pages"></div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.card-item').forEach(item => {
      item.querySelector('.bank-summary-row').addEventListener('click', () => toggleCard(item));
    });
    container.querySelectorAll('.cashname-save-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); saveCashname(btn.dataset.cardId); });
    });
    container.querySelectorAll('.push-priority-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); pushCardToPriority(btn.dataset.cardId); });
    });
    container.querySelectorAll('.cashname-input').forEach(input => {
      input.addEventListener('click', (e) => e.stopPropagation());
    });
  } catch (e) {
    container.innerHTML = `<p class="empty" style="padding: 32px; color:var(--color-neg);">שגיאה בטעינת כרטיסים: ${escapeHtml(e.message)}</p>`;
  }
}

async function toggleCard(item) {
  const wrap = item.querySelector('.card-txns');
  const isOpen = wrap.style.display !== 'none';
  if (isOpen) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'block';
  const cardId = item.dataset.cardId;
  await loadPriorityPages(cardId);
}

const PAGE_STATUS_BADGE = {
  complete: '<span style="color:var(--color-pos); font-weight:700;">✓ נקלט בפריוריטי</span>',
  partial: (page) => `<span style="color:#c77700; font-weight:700;">⚠ נקלט חלקית — ${page.missingCount} שורות חסרות</span>`,
  missing: '<span style="color:var(--color-text-light);">טרם נקלט</span>',
  'exists-other-date': (page) => `<span style="color:var(--color-pos); font-weight:700;">✓ קיים דף אחר החודש (${escapeHtml(page.existingPageDate || '?')}) — לא יידחף דף כפול</span>`,
  unknown: (page) => `<span style="color:var(--color-neg);">שגיאה בבדיקת סטטוס${page.statusError ? ': ' + escapeHtml(page.statusError) : ''}</span>`,
};

function pageStatusBadge(page) {
  const entry = PAGE_STATUS_BADGE[page.priorityStatus];
  if (typeof entry === 'function') return entry(page);
  return entry || '<span style="color:var(--color-text-light);">יש להגדיר קופה כדי לבדוק סטטוס</span>';
}

/**
 * Independent check of this page's closing line against the REAL debit in
 * the checking account (see src/credit-cards/reconcile.js) — separate from
 * priorityStatus, which only compares our own lines against what Priority
 * already has. A page can look "complete" in Priority and still be wrong if
 * the amount itself never matched what actually left the bank (the exact
 * failure mode from a real duplicate-transaction incident), so this must be
 * shown even when priorityStatus looks fine.
 */
function reconcileBadge(page) {
  const r = page.reconcile;
  if (!r) return '';
  if (r.matched === true) {
    return `<span style="color:var(--color-pos);">✓ תואם לעו"ש (${fmtMoney(r.computedSum)})</span>`;
  }
  if (r.matched === false) {
    return `<span style="color:var(--color-neg); font-weight:700;">✗ אי-התאמה מול העו"ש — שלנו: ${fmtMoney(r.computedSum)}, בבנק: ${fmtMoney(r.anchorAmount)} — לא ייקלט</span>`;
  }
  const reason = r.status === 'ambiguous' ? 'כמה תנועות מתאימות בעו"ש באותו יום' : 'לא נמצאה תנועה מתאימה בעו"ש';
  return `<span style="color:var(--color-text-light);">⚠ לא אומת מול העו"ש (${escapeHtml(reason)})</span>`;
}

/**
 * Each card page stands alone (its own detail lines + closing "תשלום בפועל
 * בבנק" line that nets it to zero) — a page is a closed, one-time snapshot
 * of a bank statement, not something to keep re-litigating. Only the
 * newest page (the current billing cycle to work on) auto-expands; every
 * older page collapses to a one-line summary regardless of its status —
 * an old page that's still partial (e.g. from before a capture bug was
 * fixed) is not this screen's problem to keep surfacing on every visit, it
 * gets topped up quietly by "קלוט לפריוריטי" like any other page. Any row
 * can still be clicked to expand/collapse manually for a spot check.
 */
async function loadPriorityPages(cardId) {
  const el = document.querySelector(`.card-item[data-card-id="${cardId}"] .priority-pages`);
  if (!el) return;
  el.innerHTML = 'טוען תצוגת פריוריטי…';
  try {
    const res = await fetch(`/api/credit-cards/${cardId}/priority-preview`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { card, pages } = await res.json();

    if (!pages.length) {
      el.innerHTML = `<p class="empty">אין תנועות.</p>`;
      return;
    }

    const latestIdx = pages.length - 1;
    const latestPage = pages[latestIdx];

    const banner = latestPage.priorityStatus === 'complete'
      ? `<p style="color:var(--color-pos); font-weight:700; margin-bottom:12px;">✓ הדף האחרון (${escapeHtml(latestPage.curdate)}) נקלט במלואו בפריוריטי</p>`
      : '';

    const rowsHtml = pages.map((page, idx) => {
      const isActive = idx === latestIdx;
      // `matched` is set per-line by the live check whenever a page header
      // was found in Priority (undefined when the whole page reads
      // 'missing' — nothing to compare a line against). Marking every row
      // individually, instead of a separate missing-lines summary, is what
      // actually lets a real gap be told apart from a text-match false
      // positive at a glance — you see it right next to the line itself.
      const hasLineStatus = page.lines.some(l => l.matched !== undefined);
      const txnRows = page.lines.map(l => `
        <tr${l.details === 'תשלום בפועל בבנק' ? ' style="font-weight:700; border-top:2px solid var(--color-border);"' : ''}${l.matched === false ? ' style="background:rgba(199,119,0,.1);"' : ''}>
          <td>${escapeHtml(l.curdate)}</td>
          <td>${escapeHtml(l.valueDate)}</td>
          <td>${escapeHtml(l.btcode)}</td>
          <td>${escapeHtml(l.details)}</td>
          <td>${l.debit ? fmtMoney(-l.debit) : ''}</td>
          <td>${l.credit ? fmtMoney(l.credit) : ''}</td>
          ${hasLineStatus ? `<td>${l.matched === false ? '<span style="color:#c77700;">✗ חסר</span>' : l.matched === true ? '<span style="color:var(--color-pos);">✓</span>' : ''}</td>` : ''}
        </tr>
      `).join('');
      // Shown only when the status check found NO page under this card's
      // CASHNAME on this date, but Priority does have page(s) under some
      // other CASHNAME(s) that day — a strong hint the configured CASHNAME
      // doesn't exactly match what's actually in Priority.
      const cashnameHint = page.priorityStatus === 'missing' && page.otherCashnamesOnDate?.length
        ? `<div style="font-size:.85rem; color:#c77700; margin-top:4px;">
            יש בפריוריטי דף/דפים בתאריך הזה תחת קופה אחרת: ${page.otherCashnamesOnDate.map(c => `"${escapeHtml(c)}"`).join(', ')}
            — ודאי שהקופה שהוגדרה כאן ("${escapeHtml(card?.priority_cashname || '')}") תואמת בדיוק.
          </div>`
        : '';
      return `
        <div class="priority-page-row" data-page-idx="${idx}" style="margin-bottom:10px; ${isActive ? 'border-right:3px solid var(--color-accent, #4a7dff); padding-right:10px;' : ''}">
          <div class="page-summary-row" style="cursor:pointer; font-weight:700; margin-bottom:4px; display:flex; gap:10px; align-items:center;">
            <span>${isActive ? '▶' : '▸'}</span>
            <span>דף בנק ליום ${escapeHtml(page.curdate)}</span>
            ${pageStatusBadge(page)}
            ${reconcileBadge(page)}
          </div>
          <div class="page-detail" style="display:${isActive ? 'block' : 'none'}; padding-inline-start:20px;">
            ${cashnameHint}
            <div class="txn-table-wrap">
              <table class="txn-table">
                <thead><tr><th>תאריך</th><th>תאריך ערך</th><th>קוד פעולה</th><th>פרטים</th><th>חובה</th><th>זכות</th>${hasLineStatus ? '<th>בפריוריטי</th>' : ''}</tr></thead>
                <tbody>${txnRows}</tbody>
              </table>
            </div>
          </div>
        </div>`;
    }).join('');

    el.innerHTML = banner + rowsHtml;
    el.querySelectorAll('.page-summary-row').forEach(row => {
      row.addEventListener('click', () => {
        const detail = row.nextElementSibling;
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
      });
    });
  } catch (e) {
    el.innerHTML = `<p class="empty" style="color:var(--color-neg);">שגיאה: ${escapeHtml(e.message)}</p>`;
  }
}

async function saveCashname(cardId) {
  const input = document.querySelector(`.cashname-input[data-card-id="${cardId}"]`);
  const status = document.querySelector(`.cashname-status[data-card-id="${cardId}"]`);
  const cashname = input.value.trim();
  if (!cashname) { status.textContent = 'יש למלא קופה'; status.style.color = 'var(--color-neg)'; return; }
  try {
    const res = await fetch(`/api/credit-cards/${cardId}/cashname`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cashname }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
    status.textContent = '✓ נשמר';
    status.style.color = 'var(--color-pos)';
    document.querySelector(`.push-priority-btn[data-card-id="${cardId}"]`)?.removeAttribute('disabled');
  } catch (e) {
    status.textContent = 'שגיאה: ' + e.message;
    status.style.color = 'var(--color-neg)';
  }
}

async function pushCardToPriority(cardId) {
  const btn = document.querySelector(`.push-priority-btn[data-card-id="${cardId}"]`);
  const status = document.querySelector(`.cashname-status[data-card-id="${cardId}"]`);
  btn.disabled = true;
  status.textContent = 'קולט לפריוריטי…';
  status.style.color = 'var(--color-text-light)';
  try {
    const res = await fetch(`/api/credit-cards/${cardId}/push-to-priority`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const failed = data.results.filter(r => !r.ok);
    if (data.results.length === 0) {
      status.textContent = 'אין דפים חדשים לקליטה';
      status.style.color = 'var(--color-text-light)';
    } else if (failed.length) {
      // A partial push failure (some lines of a page rejected) carries no
      // top-level `.error` — the real message is nested one level down, in
      // failed[0].failed[0].error (per-line detail from pushCardPageToPriority).
      // Only the future-dated-page guard and an unexpected throw set a
      // top-level `.error` directly.
      const firstIssue = failed[0];
      const lineError = firstIssue.failed?.[0]?.error;
      const moreLines = firstIssue.failed?.length > 1 ? ` (ועוד ${firstIssue.failed.length - 1} שורות נכשלו)` : '';
      status.textContent = `שגיאה בקליטה (${firstIssue.curdate}): ${firstIssue.error || lineError || 'שגיאה לא ידועה'}${moreLines}`;
      status.style.color = 'var(--color-neg)';
    } else {
      const existed = data.results.filter(r => r.alreadyExisted).length;
      const filled = data.results.filter(r => r.hadExistingPage && !r.alreadyExisted).length;
      const created = data.results.length - existed - filled;
      const parts = [];
      if (created) parts.push(`${created} דפים חדשים נקלטו`);
      if (filled) parts.push(`${filled} דפים חלקיים הושלמו`);
      if (existed) parts.push(`${existed} כבר היו מלאים בפריוריטי (לא נוצרו כפולים)`);
      status.textContent = '✓ ' + parts.join(', ');
      status.style.color = 'var(--color-pos)';
    }
    await loadPriorityPages(cardId);
  } catch (e) {
    status.textContent = 'שגיאה: ' + e.message;
    status.style.color = 'var(--color-neg)';
  } finally {
    btn.disabled = false;
  }
}

async function pushAllCardsToPriority() {
  const btn = document.getElementById('push-all-priority-btn');
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'קולט…';
  try {
    const res = await fetch('/api/credit-cards/push-all-to-priority', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const totalPushed = data.byCard.reduce((sum, c) => sum + (c.results?.filter(r => r.ok).length || 0), 0);
    const totalFailed = data.byCard.reduce((sum, c) => sum + (c.results?.filter(r => !r.ok).length || 0), 0);
    alert(`נקלטו ${totalPushed} דפים${totalFailed ? `, ${totalFailed} נכשלו` : ''}`);
    loadCards();
  } catch (e) {
    alert('שגיאה: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

/* ───────── sync (SSE) ───────── */
const _origTitle = document.title;

// Self-contained copy of app.js's promptSmsCode (see file header note on
// isolation) — reuses the same shared #sms-modal CSS classes from style.css.
function promptSmsCode(message) {
  return new Promise((resolve, reject) => {
    let modal = document.getElementById('sms-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'sms-modal';
      modal.className = 'modal-bg sms-modal-bg';
      modal.innerHTML = `
        <div class="modal">
          <div class="sms-icon">🔐</div>
          <h3>נדרש קוד SMS</h3>
          <p class="msg" id="sms-modal-msg"></p>
          <input id="sms-modal-input" class="sms-input" type="text" inputmode="numeric"
                 autocomplete="one-time-code" maxlength="10" placeholder="••••••">
          <div class="err" id="sms-modal-err"></div>
          <div class="modal-actions">
            <button class="btn btn-ghost" id="sms-modal-cancel">ביטול</button>
            <button class="btn btn-pri" id="sms-modal-submit">אישור</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    const input = modal.querySelector('#sms-modal-input');
    const errEl = modal.querySelector('#sms-modal-err');
    modal.querySelector('#sms-modal-msg').textContent = message || 'הזן את הקוד שקיבלת ב-SMS מהבנק';
    input.value = ''; errEl.textContent = '';
    modal.classList.add('open');
    document.title = '🔐 קוד SMS נדרש — ' + _origTitle;

    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('🔐 קוד SMS נדרש', { body: 'הזן את הקוד שקיבלת בנייד באתר TACT', tag: 'sms' }); } catch {}
    }

    setTimeout(() => input.focus(), 50);

    const close = () => {
      modal.classList.remove('open'); cleanup();
      document.title = _origTitle;
    };
    const submit = () => {
      const code = input.value.trim();
      if (!code) { errEl.textContent = 'הזן קוד'; return; }
      close(); resolve(code);
    };
    const cancel = () => { close(); reject(new Error('cancelled')); };
    const onKey = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') cancel(); };
    const cleanup = () => {
      modal.querySelector('#sms-modal-submit').removeEventListener('click', submit);
      modal.querySelector('#sms-modal-cancel').removeEventListener('click', cancel);
      input.removeEventListener('keydown', onKey);
    };
    modal.querySelector('#sms-modal-submit').addEventListener('click', submit);
    modal.querySelector('#sms-modal-cancel').addEventListener('click', cancel);
    input.addEventListener('keydown', onKey);

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  });
}

async function syncCards(bankId) {
  const panel = document.getElementById('sync-panel');
  const log = document.getElementById('sync-log');
  const title = document.getElementById('sync-title');

  panel.classList.remove('done', 'error');
  panel.classList.add('open');
  log.innerHTML = '';
  title.textContent = `סנכרון כרטיסי אשראי — ${BANK_NAMES[bankId] || bankId}`;
  document.getElementById('sync-close').onclick = () => panel.classList.remove('open');

  const addLine = (text, cls = '') => {
    const div = document.createElement('div');
    div.className = 'line ' + cls;
    div.textContent = '› ' + text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  };

  addLine('פותח חיבור…');
  let buf = '';
  try {
    const res = await fetch(`/api/credit-cards/${bankId}/sync`, { method: 'POST' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const eventLine = block.split('\n').find(l => l.startsWith('event:'));
        const dataLine = block.split('\n').find(l => l.startsWith('data:'));
        if (!eventLine || !dataLine) continue;
        const event = eventLine.slice(6).trim();
        const data = JSON.parse(dataLine.slice(5).trim());

        if (event === 'progress') {
          addLine(data.message || data.step);
        } else if (event === 'sms-required') {
          addLine('🔐 הבנק שלח SMS — ממתין לקוד…');
          try {
            const code = await promptSmsCode(data.message);
            const r = await fetch(`/api/credit-cards/sync/${data.syncId}/sms-code`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code }),
            });
            if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `HTTP ${r.status}`); }
            addLine('קוד SMS נשלח, ממתין לאישור הבנק…', 'success');
          } catch (e) {
            addLine('בוטל/נכשל שליחת קוד SMS: ' + e.message, 'error');
          }
        } else if (event === 'card-saved') {
          const staleNote = data.staleRemoved > 0 ? ` (${data.staleRemoved} תנועות ישנות הוסרו)` : '';
          addLine(`✓ ${data.account} · כרטיס ${data.cardLast4}: נשמרו ${data.newSaved} תנועות חדשות (מתוך ${data.fetched})${staleNote}`, 'success');
        } else if (event === 'done') {
          panel.classList.add('done');
          addLine(`סיום: ${data.totalCards} כרטיסים, ${data.totalNewTxns} תנועות חדשות`, 'success');
          setTimeout(loadCards, 800);
        } else if (event === 'error') {
          panel.classList.add('error');
          addLine('שגיאה: ' + data.message, 'error');
        }
      }
    }
  } catch (e) {
    panel.classList.add('error');
    addLine('שגיאה: ' + e.message, 'error');
  }
}

document.getElementById('sync-discount-btn').addEventListener('click', () => syncCards('discount'));
document.getElementById('sync-poalim-btn').addEventListener('click', () => syncCards('poalim'));
document.getElementById('sync-leumi-btn').addEventListener('click', () => syncCards('leumi'));
document.getElementById('push-all-priority-btn').addEventListener('click', pushAllCardsToPriority);

renderUserChip();
loadCards();
