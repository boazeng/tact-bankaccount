const fmtMoney = (n) => {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : '';
  return sign + '₪' + Math.abs(n).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/* ───────── index page ───────── */
async function renderIndex() {
  const container = document.getElementById('banks-container');
  const summary = document.getElementById('bank-summary');
  if (!container) return;

  // Remember which banks were expanded so a re-render (e.g. after a toggle)
  // doesn't collapse them.
  const openBankIds = summary
    ? Array.from(summary.querySelectorAll('.bank-summary-item.open'))
        .map(el => el.dataset.bankItem)
    : [];

  try {
    const res = await fetch('/api/banks');
    const { banks } = await res.json();

    if (!banks.length) {
      if (summary) summary.innerHTML = '';
      container.innerHTML = `<div class="empty"><h3>אין בנקים מוגדרים עדיין</h3><p>הרץ סנכרון ראשון כדי להתחיל</p></div>`;
      return;
    }

    if (summary) summary.innerHTML = banks.map(renderBankSummaryRow).join('');
    container.innerHTML = banks.map(renderBankBlock).join('');

    // Restore expanded state
    if (summary) {
      for (const id of openBankIds) {
        summary.querySelector(`[data-bank-item="${CSS.escape(id)}"]`)?.classList.add('open');
      }
    }

    const wireSync = (root) => root.querySelectorAll('[data-sync-bank]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const bankId = btn.dataset.syncBank;
        const select = root.querySelector(`[data-days-for="${CSS.escape(bankId)}"]`);
        const days = Number(select?.value) || 30;
        startSync(bankId, btn.dataset.bankName, days);
      });
    });
    if (summary) wireSync(summary);
    wireSync(container);

    // Persist days choice per bank
    if (summary) summary.querySelectorAll('.days-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        localStorage.setItem(`sync-days:${sel.dataset.daysFor}`, sel.value);
      });
    });

    // Expand / collapse each bank summary
    if (summary) summary.querySelectorAll('[data-toggle-bank]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.bank-summary-item');
        item?.classList.toggle('open');
      });
    });

    // Active-toggle handler — re-renders to update counts + cards. The
    // expanded-state restore above keeps the table visible.
    if (summary) summary.querySelectorAll('[data-toggle-account]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const id = cb.dataset.toggleAccount;
        const row = cb.closest('tr');
        const scrollY = window.scrollY;
        cb.disabled = true;
        try {
          await setAccountActive(id, cb.checked);
          row?.classList.toggle('inactive', !cb.checked);
          await renderIndex();
          window.scrollTo({ top: scrollY });
        } catch (e) {
          cb.checked = !cb.checked;
          alert('שגיאה בעדכון: ' + e.message);
        } finally { cb.disabled = false; }
      });
    });
  } catch (e) {
    container.innerHTML = `<div class="empty"><h3>שגיאת טעינה</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderBankSummaryRow(bank) {
  const activeAccounts = bank.accounts.filter(a => a.is_active);
  const inactiveCount = bank.accounts.length - activeAccounts.length;

  // Group active accounts by branch — each branch gets its own meta line.
  const branchGroups = new Map();
  for (const a of activeAccounts) {
    const key = a.branch_id || '?';
    if (!branchGroups.has(key)) {
      branchGroups.set(key, { branch_id: key, branch_name: a.branch_name || null, count: 0, txnTotal: 0, lastSync: null });
    }
    const g = branchGroups.get(key);
    g.count++;
    g.txnTotal += a.txn_count || 0;
    if (a.last_sync_at && (!g.lastSync || a.last_sync_at > g.lastSync)) g.lastSync = a.last_sync_at;
    if (!g.branch_name && a.branch_name) g.branch_name = a.branch_name;
  }
  const branchLines = Array.from(branchGroups.values())
    .sort((a, b) => String(a.branch_id).localeCompare(String(b.branch_id)))
    .map(g => {
      const sync = g.lastSync
        ? `<span class="sync-time">${fmtDateTime(g.lastSync)}</span>`
        : `<span class="never">מעולם לא</span>`;
      const name = g.branch_name ? ` — ${escapeHtml(g.branch_name)}` : '';
      return `<div class="bsr-branch-line">
        <span class="branch-id">סניף ${escapeHtml(g.branch_id)}</span>${name}
        <span class="sep">·</span>${g.count} חשבונות
        <span class="sep">·</span>${g.txnTotal} תנועות
        <span class="sep">·</span>עודכן: ${sync}
      </div>`;
    }).join('');

  const emptyLine = !branchLines
    ? `<div class="bsr-branch-line">אין חשבונות פעילים</div>`
    : '';
  const inactiveLine = inactiveCount > 0
    ? `<div class="bsr-branch-line dim">${inactiveCount} חשבונות לא פעילים (לא יסונכרנו)</div>`
    : '';

  const tableRows = bank.accounts.map(a => `
    <tr class="${a.is_active ? '' : 'inactive'}" data-account-row="${a.id}">
      <td class="et-name">${escapeHtml(a.corporate_name || '—')}</td>
      <td class="et-num">${escapeHtml(a.masked_number)}</td>
      <td class="et-branch">${escapeHtml(a.branch_id || '—')}${a.branch_name ? ' — ' + escapeHtml(a.branch_name) : ''}</td>
      <td class="et-toggle">
        <label class="toggle" title="${a.is_active ? 'פעיל' : 'לא פעיל'}">
          <input type="checkbox" data-toggle-account="${a.id}" ${a.is_active ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </td>
    </tr>
  `).join('');

  const savedDays = Number(localStorage.getItem(`sync-days:${bank.id}`)) || 30;
  const dayOptions = [7, 14, 30, 60, 90, 180, 365];
  const optionsHtml = dayOptions.map(d =>
    `<option value="${d}" ${d === savedDays ? 'selected' : ''}>${d === 365 ? 'שנה' : d + ' ימים'}</option>`,
  ).join('');

  return `
    <div class="bank-summary-item" data-bank-item="${escapeHtml(bank.id)}">
      <div class="bank-summary-row">
        <button class="expand-btn" data-toggle-bank="${escapeHtml(bank.id)}" aria-label="הרחב">
          <span class="chev">▼</span>
        </button>
        <div class="bsr-info">
          <div class="bsr-head">
            <a href="#bank-${escapeHtml(bank.id)}" class="bsr-name">${escapeHtml(bank.name_he)}</a>
            <span class="pill">${escapeHtml(bank.id)}</span>
          </div>
          <div class="bsr-actions">
            <button class="btn btn-pri btn-sm" data-sync-bank="${escapeHtml(bank.id)}" data-bank-name="${escapeHtml(bank.name_he)}">
              ↓ סנכרון
            </button>
            <select class="days-select" data-days-for="${escapeHtml(bank.id)}" aria-label="טווח ימים">
              ${optionsHtml}
            </select>
          </div>
          <div class="bsr-meta">
            ${emptyLine}${branchLines}${inactiveLine}
          </div>
        </div>
      </div>
      <div class="bank-expand">
        ${bank.accounts.length ? `
          <table class="expand-table">
            <thead>
              <tr>
                <th>שם החשבון</th>
                <th>מספר חשבון</th>
                <th>סניף</th>
                <th style="text-align:center;">פעיל</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        ` : '<p style="color: var(--color-text-light); font-size: 0.9rem; padding: 12px 0;">אין חשבונות עדיין. לחץ סנכרון כדי לטעון.</p>'}
      </div>
    </div>
  `;
}

async function setAccountActive(accountId, isActive) {
  const r = await fetch(`/api/accounts/${accountId}/active`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ active: isActive }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
}

function renderBankBlock(bank) {
  const activeAccounts = bank.accounts.filter(a => a.is_active);
  const accountsHtml = activeAccounts.length
    ? `<div class="accounts">${activeAccounts.map(renderAccountCard).join('')}</div>`
    : (bank.accounts.length
      ? `<div class="empty"><h3>אין חשבונות פעילים</h3><p>הפעל חשבונות בטבלה למעלה כדי שיוצגו כאן</p></div>`
      : `<div class="empty"><h3>אין חשבונות מסונכרנים עדיין</h3><p>לחץ "סנכרון" כדי להוריד חשבונות ותנועות</p></div>`);

  return `
    <section class="bank-block" id="bank-${escapeHtml(bank.id)}">
      <div class="bank-head">
        <div class="left">
          <h2 class="name">${escapeHtml(bank.name_he)}</h2>
          <span class="pill">${escapeHtml(bank.id)}</span>
          <span class="meta">${activeAccounts.length} חשבונות · ${activeAccounts.reduce((s, a) => s + (a.txn_count || 0), 0)} תנועות סך הכל</span>
        </div>
      </div>
      ${accountsHtml}
    </section>
  `;
}

function renderAccountCard(a) {
  const balCls = a.last_balance < 0 ? 'neg' : a.last_balance > 0 ? 'pos' : 'zero';
  return `
    <article class="account-card">
      <div>
        <div class="corp">${escapeHtml(a.corporate_name || '—')}</div>
        <div class="num">${escapeHtml(a.masked_number)}</div>
      </div>
      <div class="balance ${balCls}">
        <span>${fmtMoney(a.last_balance)}</span>
      </div>
      <div class="stats">
        <div class="stat">
          <div class="lbl">סנכרון אחרון</div>
          <div class="val ${a.last_sync_at ? '' : 'dim'}">${a.last_sync_at ? fmtDate(a.last_sync_at) : 'מעולם לא'}</div>
        </div>
        <div class="stat">
          <div class="lbl">תנועות במאגר</div>
          <div class="val">${a.txn_count || 0}</div>
        </div>
      </div>
      <div class="actions">
        <a class="btn btn-ghost btn-sm" href="/account.html?id=${a.id}">צפייה בתנועות →</a>
      </div>
    </article>
  `;
}

/* ───────── sync (SSE) ───────── */
const _origTitle = document.title;

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

    // Browser notification (if user granted permission earlier)
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

// Cached once per page load — which bank ids have a credit-card scraper
// implemented (currently discount, poalim, leumi). Lets startSync/syncAllBanks
// auto-trigger a card sync right after that bank's account sync, so the
// user never has to visit credit-cards.html separately for a routine sync.
let _cardSupportedBanksPromise = null;
function getCardSupportedBanks() {
  if (!_cardSupportedBanksPromise) {
    _cardSupportedBanksPromise = fetch('/api/credit-cards/supported-banks')
      .then(r => r.json())
      .then(d => d.bankIds || [])
      .catch(() => []);
  }
  return _cardSupportedBanksPromise;
}

/**
 * Runs one bank's credit-card sync (same SSE endpoint credit-cards.js uses)
 * into the SAME log panel as the checking-account sync that just finished,
 * so "sync this bank" reads as one continuous operation instead of two
 * separate ones the user has to remember to run.
 */
async function syncCardsForBank(bankId, bankName, addLine) {
  addLine(`── כרטיסי אשראי: ${bankName} ──`);
  try {
    const res = await fetch(`/api/credit-cards/${bankId}/sync`, { method: 'POST' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

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
          addLine('🔐 הבנק שלח SMS (כרטיסי אשראי) — ממתין לקוד…');
          try {
            const code = await promptSmsCode(data.message);
            const r = await fetch(`/api/credit-cards/sync/${data.syncId}/sms-code`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code }),
            });
            if (!r.ok) {
              const e = await r.json().catch(() => ({}));
              addLine('שגיאה בשליחת קוד: ' + (e.error || r.status), 'error');
            } else {
              addLine('קוד SMS נשלח, ממתין לאישור הבנק…', 'success');
            }
          } catch {
            addLine('הקוד בוטל — סנכרון כרטיסים ייכשל', 'error');
          }
        } else if (event === 'card-saved') {
          const staleNote = data.staleRemoved > 0 ? ` (${data.staleRemoved} תנועות ישנות הוסרו)` : '';
          addLine(`✓ ${data.account} · כרטיס ${data.cardLast4}: ${data.newSaved} תנועות חדשות${staleNote}`, 'success');
        } else if (event === 'done') {
          addLine(`כרטיסי אשראי ${bankName}: ${data.totalCards} כרטיסים, ${data.totalNewTxns} תנועות חדשות`, 'success');
        } else if (event === 'error') {
          addLine(`שגיאה בכרטיסי אשראי (${bankName}): ${data.message}`, 'error');
        }
      }
    }
  } catch (e) {
    addLine(`שגיאה בכרטיסי אשראי (${bankName}): ${e.message}`, 'error');
  }
}

async function startSync(bankId, bankName, days = 30) {
  const panel = document.getElementById('sync-panel');
  const log = document.getElementById('sync-log');
  const title = document.getElementById('sync-title');
  const summary = document.getElementById('sync-summary');

  panel.classList.remove('done', 'error');
  panel.classList.add('open');
  log.innerHTML = '';
  summary.style.display = 'none';
  title.textContent = `סנכרון ${bankName} (${days} ימים)`;
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
  let currentSyncId = null;
  const accountsSaved = [];
  let bankSyncOk = false;

  try {
    const res = await fetch(`/api/banks/${bankId}/sync?days=${days}`, { method: 'POST' });
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

        if (event === 'sync-started') {
          currentSyncId = data.syncId;
        } else if (event === 'progress') {
          addLine(data.message || data.step);
        } else if (event === 'sms-required') {
          addLine('🔐 הבנק שלח SMS — ממתין לקוד…');
          try {
            const code = await promptSmsCode(data.message);
            const r = await fetch(`/api/sync/${data.syncId}/sms-code`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code }),
            });
            if (!r.ok) {
              const e = await r.json().catch(() => ({}));
              addLine('שגיאה בשליחת קוד: ' + (e.error || r.status), 'error');
            } else {
              addLine('קוד SMS נשלח, ממתין לאישור הבנק…', 'success');
            }
          } catch (e) {
            addLine('הקוד בוטל — סנכרון ייכשל', 'error');
          }
        } else if (event === 'account-saved') {
          accountsSaved.push(data);
          const dupNote = data.dedupSkipped > 0 ? ` (${data.dedupSkipped} כפילויות דולגו)` : '';
          addLine(`✓ ${data.corporateName} (${data.maskedNumber}): נשמרו ${data.newSaved} תנועות חדשות${dupNote}`, 'success');
        } else if (event === 'balance-check') {
          const dates = data.mismatches.map(m => fmtDate(m.date)).join(', ');
          addLine(`⚠ ${data.corporateName} (${data.maskedNumber}): פער ביתרה בתאריכים ${dates} — כנראה תנועה חסרה/כפולה שירדה מהבנק (לא קשור לפריוריטי)`, 'error');
        } else if (event === 'done') {
          panel.classList.add('done');
          document.getElementById('sum-new').textContent = data.totalNewSaved;
          document.getElementById('sum-dup').textContent = data.totalDedupSkipped;
          document.getElementById('sum-accounts').textContent = data.accountsCount;
          summary.style.display = 'grid';
          addLine(`סיום: ${data.totalFetched} תנועות, ${data.totalNewSaved} חדשות נשמרו`, 'success');
          bankSyncOk = true;
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

  if (bankSyncOk) {
    const cardBanks = await getCardSupportedBanks();
    if (cardBanks.includes(bankId)) {
      await syncCardsForBank(bankId, bankName, addLine);
    }
    setTimeout(() => renderIndex(), 800);
  }
}

async function syncAllBanks() {
  const res = await fetch('/api/banks');
  const { banks } = await res.json();
  if (!banks.length) return;

  const panel = document.getElementById('sync-panel');
  const logEl = document.getElementById('sync-log');
  const title = document.getElementById('sync-title');
  const summaryEl = document.getElementById('sync-summary');

  panel.classList.remove('done', 'error');
  panel.classList.add('open');
  logEl.innerHTML = '';
  summaryEl.style.display = 'none';
  title.textContent = `סנכרון כל החשבונות (${banks.length} בנקים)`;
  document.getElementById('sync-close').onclick = () => panel.classList.remove('open');

  const addLine = (text, cls = '') => {
    const div = document.createElement('div');
    div.className = 'line ' + cls;
    div.textContent = '› ' + text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  };

  let totalNew = 0, totalDup = 0, totalAccounts = 0;
  const cardBanks = await getCardSupportedBanks();

  for (const bank of banks) {
    const days = Number(localStorage.getItem(`sync-days:${bank.id}`)) || 30;
    addLine(`── ${bank.name_he} (${days} ימים) ──`);
    let bankOk = false;

    try {
      const syncRes = await fetch(`/api/banks/${bank.id}/sync?days=${days}`, { method: 'POST' });
      if (!syncRes.ok || !syncRes.body) throw new Error(`HTTP ${syncRes.status}`);
      const reader = syncRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

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
              const r = await fetch(`/api/sync/${data.syncId}/sms-code`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ code }),
              });
              if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                addLine('שגיאה בשליחת קוד: ' + (e.error || r.status), 'error');
              } else {
                addLine('קוד SMS נשלח, ממתין לאישור הבנק…', 'success');
              }
            } catch {
              addLine('הקוד בוטל', 'error');
            }
          } else if (event === 'account-saved') {
            const dupNote = data.dedupSkipped > 0 ? ` (${data.dedupSkipped} כפילויות דולגו)` : '';
            addLine(`✓ ${data.corporateName} (${data.maskedNumber}): ${data.newSaved} תנועות חדשות${dupNote}`, 'success');
          } else if (event === 'balance-check') {
            const dates = data.mismatches.map(m => fmtDate(m.date)).join(', ');
            addLine(`⚠ ${data.corporateName} (${data.maskedNumber}): פער ביתרה בתאריכים ${dates} — כנראה תנועה חסרה/כפולה שירדה מהבנק (לא קשור לפריוריטי)`, 'error');
          } else if (event === 'done') {
            totalNew += data.totalNewSaved || 0;
            totalDup += data.totalDedupSkipped || 0;
            totalAccounts += data.accountsCount || 0;
            bankOk = true;
          } else if (event === 'error') {
            addLine(`שגיאה: ${data.message}`, 'error');
            panel.classList.add('error');
          }
        }
      }
    } catch (e) {
      addLine(`שגיאה ב-${bank.name_he}: ${e.message}`, 'error');
      panel.classList.add('error');
    }

    if (bankOk && cardBanks.includes(bank.id)) {
      await syncCardsForBank(bank.id, bank.name_he, addLine);
    }
  }

  if (!panel.classList.contains('error')) panel.classList.add('done');
  document.getElementById('sum-new').textContent = totalNew;
  document.getElementById('sum-dup').textContent = totalDup;
  document.getElementById('sum-accounts').textContent = totalAccounts;
  summaryEl.style.display = 'grid';
  addLine(`סיום: ${totalNew} תנועות חדשות ב-${totalAccounts} חשבונות`, 'success');
  setTimeout(() => renderIndex(), 800);
}

async function pushAllToPriority() {
  const panel = document.getElementById('sync-panel');
  const logEl = document.getElementById('sync-log');
  const title = document.getElementById('sync-title');
  const summaryEl = document.getElementById('sync-summary');

  panel.classList.remove('done', 'error');
  panel.classList.add('open');
  logEl.innerHTML = '';
  summaryEl.style.display = 'none';
  title.textContent = 'קליטת תנועות לפריוריטי';
  document.getElementById('sync-close').onclick = () => panel.classList.remove('open');

  const addLine = (text, cls = '') => {
    const div = document.createElement('div');
    div.className = 'line ' + cls;
    div.textContent = '› ' + text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  };

  // Step 1: auto-match accounts to Priority cashnames
  addLine('מזהה קופות אוטומטית מפריוריטי…');
  try {
    const mr = await fetch('/api/priority/auto-match-cashnames', { method: 'POST' });
    const matchData = await mr.json();
    if (!mr.ok) throw new Error(matchData.error || mr.status);
    addLine(`✓ זוהו ${matchData.matched} חשבונות מתוך ${matchData.matched + matchData.unmatched} (${matchData.cashBanksCount} קופות בפריוריטי)`, 'success');
    if (matchData.unmatched > 0) {
      const unmatched = matchData.results.filter(r => !r.matched);
      unmatched.forEach(r => addLine(`  ⚠ לא זוהה: ${r.corporateName || r.maskedNumber}`, 'warn'));
    }
  } catch (e) {
    addLine(`✗ שגיאה בזיהוי קופות: ${e.message}`, 'error');
    panel.classList.add('error');
    return;
  }

  // Step 2: reload accounts after match update
  const res = await fetch('/api/banks');
  const { banks } = await res.json();
  const withCashname = banks.flatMap(b => b.accounts.filter(a => a.is_active && a.priority_cashname));

  if (!withCashname.length) {
    addLine('לא נמצאו חשבונות תואמים — בדוק שמספרי הסניף והחשבון קיימים בפריוריטי', 'error');
    panel.classList.add('error');
    return;
  }

  // Step 3: push per account
  addLine(`── קולט ${withCashname.length} חשבונות לפריוריטי ──`);
  let totalPushed = 0, totalMatched = 0, totalFailed = 0, totalErrors = 0;

  for (const acc of withCashname) {
    const label = `${acc.corporate_name || acc.masked_number} [${acc.priority_cashname}]`;
    try {
      const r = await fetch(`/api/accounts/${acc.id}/push-to-priority`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) {
        addLine(`✗ ${label}: ${data.error || r.status}`, 'error');
        totalErrors++;
        continue;
      }
      totalMatched += data.matched || 0;
      totalPushed += data.pushed || 0;
      totalFailed += data.failed || 0;
      if (data.pushed === 0 && data.failed === 0) {
        addLine(`✓ ${label}: כל ${data.matched} תנועות כבר בפריוריטי`, 'success');
      } else if (data.failed === 0) {
        addLine(`✓ ${label}: ${data.pushed} נקלטו (${data.matched} כבר היו)`, 'success');
      } else {
        addLine(`⚠ ${label}: ${data.pushed} נקלטו · ${data.failed} נכשלו`, 'warn');
      }
    } catch (e) {
      addLine(`✗ ${label}: ${e.message}`, 'error');
      totalErrors++;
    }
  }

  // Step 4: credit-card pages for cards that have a Priority cashname
  // configured. push-all-to-priority already diffs each page against what
  // Priority actually has (see pushCardPageToPriority) and only pushes
  // missing lines, or skips entirely if a page already covers that month —
  // so "only if needed" is already the endpoint's own behavior, not
  // something this loop has to decide.
  addLine('── בודק כרטיסי אשראי (רק מה שחסר) ──');
  try {
    const cr = await fetch('/api/credit-cards/push-all-to-priority', { method: 'POST' });
    const cardData = await cr.json();
    if (!cr.ok) throw new Error(cardData.error || cr.status);
    if (!cardData.byCard.length) {
      addLine('אין כרטיסי אשראי עם קופה מוגדרת', 'success');
    } else {
      for (const c of cardData.byCard) {
        if (c.error) {
          addLine(`✗ כרטיס ${c.cardLast4}: ${c.error}`, 'error');
          totalErrors++;
          continue;
        }
        const results = c.results || [];
        const failedPages = results.filter(r => !r.ok);
        const newPages = results.filter(r => r.ok && !r.alreadyExisted);
        const alreadyPages = results.filter(r => r.alreadyExisted);
        if (!results.length) {
          addLine(`✓ כרטיס ${c.cardLast4}: אין דפים חדשים`, 'success');
        } else if (failedPages.length) {
          addLine(`⚠ כרטיס ${c.cardLast4}: ${newPages.length} דפים נקלטו, ${failedPages.length} נכשלו`, 'warn');
          totalFailed += failedPages.length;
        } else {
          const existedNote = alreadyPages.length ? `, ${alreadyPages.length} כבר היו מכוסים` : '';
          addLine(`✓ כרטיס ${c.cardLast4}: ${newPages.length} דפים נקלטו${existedNote}`, 'success');
        }
      }
    }
  } catch (e) {
    addLine(`✗ שגיאה בקליטת כרטיסי אשראי: ${e.message}`, 'error');
    totalErrors++;
  }

  if (!totalErrors && !totalFailed) panel.classList.add('done');
  document.getElementById('sum-new').textContent = totalPushed;
  document.getElementById('sum-dup').textContent = totalMatched;
  document.getElementById('sum-accounts').textContent = withCashname.length;
  summaryEl.style.display = 'grid';
  document.getElementById('sum-new').closest('.m').querySelector('.lbl').textContent = 'נקלטו עכשיו';
  document.getElementById('sum-dup').closest('.m').querySelector('.lbl').textContent = 'כבר בפריוריטי';
  addLine(
    totalErrors
      ? `סיום עם ${totalErrors} שגיאות`
      : totalPushed === 0 && totalFailed === 0
        ? `✓ כל התנועות קיימות בפריוריטי`
        : totalFailed === 0
          ? `✓ נקלטו ${totalPushed} תנועות (${totalMatched} כבר היו)`
          : `סיום — ${totalPushed} נקלטו, ${totalFailed} נכשלו`,
    totalErrors || totalFailed ? 'error' : 'success',
  );
}

/* ───────── account page ───────── */
async function renderAccountPage() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return;

  renderUserChip();

  try {
    const [txnRes, cashBanksRes] = await Promise.all([
      fetch(`/api/accounts/${id}/transactions?limit=500`),
      fetch('/api/priority/cash-banks').catch(() => null),
    ]);
    if (!txnRes.ok) throw new Error(`HTTP ${txnRes.status}`);
    const { account, transactions } = await txnRes.json();
    const cashBanks = (cashBanksRes?.ok ? (await cashBanksRes.json().catch(() => ({}))).banks : null) || [];

    // Auto-discover cashname if not set yet
    if (!account.priority_cashname && cashBanks.length) {
      try {
        const matchRes = await fetch('/api/priority/auto-match-cashnames', { method: 'POST' });
        if (matchRes.ok) {
          const matchData = await matchRes.json();
          const hit = matchData.results?.find(r => r.accountId === account.id && r.matched);
          if (hit) account.priority_cashname = hit.cashname;
        }
      } catch {}
    }

    document.title = `TACT · ${account.corporate_name || account.masked_number}`;

    const balCls = account.last_balance < 0 ? 'neg' : '';
    document.getElementById('account-hero').innerHTML = `
      <div class="bank-pill">${escapeHtml(account.bank_name_he)}</div>
      <h1>${escapeHtml(account.corporate_name || '—')}</h1>
      <div class="num">${escapeHtml(account.masked_number)} ${account.iban ? '· ' + escapeHtml(account.iban) : ''}</div>
      <div class="meta-grid">
        <div class="meta-item">
          <div class="lbl">יתרה</div>
          <div class="val ${balCls}">${fmtMoney(account.last_balance)}</div>
        </div>
        <div class="meta-item">
          <div class="lbl">תנועות במאגר</div>
          <div class="val">${account.txn_count}</div>
        </div>
        <div class="meta-item">
          <div class="lbl">סנכרון אחרון</div>
          <div class="val dim">${account.last_sync_at ? fmtDateTime(account.last_sync_at) : 'מעולם לא'}</div>
        </div>
      </div>
    `;

    const container = document.getElementById('txn-container');
    if (!transactions.length) {
      container.innerHTML = `<div class="empty"><h3>אין תנועות במאגר עדיין</h3><p>חזור למסך הראשי ולחץ סנכרון</p></div>`;
      return;
    }

    const checkedCount = transactions.filter(t => t.in_priority != null).length;
    const matchedCount = transactions.filter(t => t.in_priority === 1).length;
    const lastChecked = transactions
      .map(t => t.priority_checked_at).filter(Boolean)
      .sort().reverse()[0];

    // Balance integrity check — balance-aware chronological reconstruction.
    // Within a day, sort heuristics (ref, id) can't disambiguate paired
    // transfer+fee rows or shared-ref groups. Instead we chain transactions
    // by balance: given a known previous balance B, the next transaction is
    // the one whose `running_balance - amount == B`. This always yields the
    // bank's true order when all transactions are present.
    const greedyChain = (txns, fromBalance) => {
      const remaining = [...txns];
      const chain = [];
      let cur = fromBalance;
      while (true) {
        const idx = remaining.findIndex(t =>
          t.running_balance != null && t.amount != null &&
          Math.abs(Number(t.running_balance) - (cur + Number(t.amount))) < 0.01
        );
        if (idx === -1) break;
        const next = remaining.splice(idx, 1)[0];
        chain.push(next);
        cur = Number(next.running_balance);
      }
      for (const r of remaining) chain.push(r); // leftover → mismatches
      return chain;
    };
    const reconstructDay = (dayTxns, startBalance) => {
      if (dayTxns.length <= 1) return [...dayTxns];
      if (startBalance != null) return greedyChain(dayTxns, startBalance);
      // No anchor — try each txn as the day's first; pick chain that hooks the most
      let best = null;
      for (const anchor of dayTxns) {
        if (anchor.running_balance == null || anchor.amount == null) continue;
        const others = dayTxns.filter(t => t !== anchor);
        const startBal = Number(anchor.running_balance) - Number(anchor.amount);
        const chain = [anchor, ...greedyChain(others, Number(anchor.running_balance))];
        const chained = chain.findIndex(t => t._unchained_marker) + 1 || chain.length;
        if (!best || chained > best._chainedCount) {
          best = chain;
          best._chainedCount = chained;
          best._startBal = startBal;
        }
      }
      return best || [...dayTxns];
    };

    const byDate = new Map();
    for (const t of transactions) {
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date).push(t);
    }
    let prevBalance = null;
    for (const date of [...byDate.keys()].sort()) {
      const ordered = reconstructDay(byDate.get(date), prevBalance);
      for (let i = 0; i < ordered.length; i++) {
        const cur = ordered[i];
        if (cur.running_balance == null || cur.amount == null) { cur._balance_check = 'unknown'; continue; }
        const refBalance = i === 0 ? prevBalance : (ordered[i - 1].running_balance);
        if (i === 0 && prevBalance == null) { cur._balance_check = 'baseline'; continue; }
        const expected = Number(refBalance) + Number(cur.amount);
        const diff = Number(cur.running_balance) - expected;
        cur._balance_check = Math.abs(diff) < 0.01 ? 'ok' : 'mismatch';
        cur._balance_diff = diff;
      }
      if (ordered.length) prevBalance = ordered[ordered.length - 1].running_balance;
    }
    const balanceOk = transactions.filter(t => t._balance_check === 'ok').length;
    const balanceMismatch = transactions.filter(t => t._balance_check === 'mismatch').length;

    const cashnameOptions = cashBanks.map(cb =>
      `<option value="${escapeHtml(cb.CASHNAME)}"
         ${account.priority_cashname === cb.CASHNAME ? 'selected' : ''}>
        ${escapeHtml(cb.CASHNAME)}${cb.CASHDES ? ' — ' + escapeHtml(cb.CASHDES) : ''}
       </option>`
    ).join('');

    const cashnameControl = account.priority_cashname
      ? `<code class="cashname-tag">${escapeHtml(account.priority_cashname)}</code>`
      : (cashBanks.length
          ? `<select id="cashname-select" class="cashname-select">
               <option value="">בחר קופה...</option>
               ${cashnameOptions}
             </select>
             <button class="btn btn-ghost btn-sm" id="save-cashname-btn">שמור</button>`
          : `<input id="cashname-select" type="text" class="cashname-input"
                 placeholder="שם קופה בפריוריטי" value="">
             <button class="btn btn-ghost btn-sm" id="save-cashname-btn">שמור</button>`);

    container.innerHTML = `
      <div class="priority-check-bar">
        <button class="btn btn-pri btn-sm" id="check-priority-btn">↻ בדוק מול פריוריטי</button>
        <div class="status">
          סטטוס: <span class="num">${checkedCount}</span> מתוך <span class="num">${transactions.length}</span> נבדקו
          ${checkedCount > 0 ? `· <span class="num green">${matchedCount}</span> בפריוריטי · <span class="num red">${checkedCount - matchedCount}</span> חסרות` : ''}
        </div>
        <div class="spacer"></div>
        <div class="status">
          תקינות יתרה: <span class="num green">${balanceOk}</span> תואמות
          ${balanceMismatch > 0 ? ` · <span class="num red">${balanceMismatch}</span> סטיות` : ''}
        </div>
        ${lastChecked ? `<div class="last">בדיקה אחרונה: ${fmtDateTime(lastChecked)}</div>` : ''}
      </div>
      <div class="priority-push-bar">
        <span class="cashname-label">קופה בפריוריטי:</span>
        ${cashnameControl}
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" id="preview-priority-btn"
          ${!account.priority_cashname ? 'disabled' : ''}>
          👁 תצוגה מקדימה
        </button>
        <button class="btn btn-ghost btn-sm" id="force-push-date-btn"
          ${!account.priority_cashname ? 'disabled' : ''}
          title="קלוט תנועות לפי תאריך ספציפי — עוקף בדיקת matching">
          ↑ קלוט תאריך
        </button>
        <button class="btn btn-push btn-sm" id="push-priority-btn"
          ${!account.priority_cashname ? 'disabled title="לחץ קלוט בדף הראשי לזיהוי אוטומטי"' : ''}>
          ↑ קלוט בפריוריטי
        </button>
        <button class="btn btn-ghost btn-sm" id="reconcile-priority-btn"
          ${!account.priority_cashname ? 'disabled' : ''}
          title="עוגן לפי יתרת פתיחה של הדף האחרון בפריוריטי, ואז קליטה יום-יום עם אימות יתרה — עוצר בכשל ראשון">
          🔗 התאמה מלאה
        </button>
      </div>
      <div id="priority-push-result"></div>
      <div class="txn-table-wrap">
        <table class="txn-table">
          <thead>
            <tr>
              <th style="width: 110px">תאריך</th>
              <th>תיאור</th>
              <th>מוטב</th>
              <th>אסמכתא</th>
              <th style="width: 130px; text-align: left;">סכום</th>
              <th style="width: 130px; text-align: left;">יתרה</th>
              <th style="width: 60px; text-align: center;" title="בדיקת יתרה: ✓ = יתרה תואמת לחישוב מהתנועה הקודמת">בדיקה</th>
              <th style="width: 80px; text-align: center;">פריוריטי</th>
              <th style="width: 40px;"></th>
            </tr>
          </thead>
          <tbody>
            ${transactions.map(renderTxnRow).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('check-priority-btn').addEventListener('click', runPriorityCheck);
    document.getElementById('preview-priority-btn').addEventListener('click', () => runPriorityPreview(id));
    document.getElementById('force-push-date-btn').addEventListener('click', () => runForcePushDate(id));
    document.getElementById('push-priority-btn').addEventListener('click', () => runPriorityPush(id));
    document.getElementById('reconcile-priority-btn').addEventListener('click', () => runReconcilePriority(id));
    document.getElementById('save-cashname-btn')?.addEventListener('click', () => savePriorityCashname(id));
    document.querySelector('.txn-table')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-del-txn');
      if (!btn) return;
      const txnId = btn.dataset.id;
      if (!confirm('למחוק תנועה זו לצמיתות?')) return;
      const r = await fetch(`/api/transactions/${txnId}`, { method: 'DELETE' });
      if (!r.ok) { alert('שגיאה במחיקה'); return; }
      btn.closest('tr').remove();
    });
  } catch (e) {
    document.getElementById('txn-container').innerHTML =
      `<div class="empty"><h3>שגיאת טעינה</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderTxnRow(t) {
  const amtCls = t.amount < 0 ? 'neg' : 'pos';
  const pending = t.status === 'pending' ? '<span class="badge-pending">ממתין</span>' : '';
  const extLine = t.extended_description ? `<div class="ext">${escapeHtml(t.extended_description)}</div>` : '';
  let priorityHtml;
  if (t.in_priority === 1) {
    priorityHtml = `<span class="priority-box yes" title="נמצא בפריוריטי (דף ${escapeHtml(t.priority_bankpage || '?')})">✓</span>`;
  } else if (t.in_priority === 0) {
    priorityHtml = `<span class="priority-box no" title="לא נמצא בפריוריטי"></span>`;
  } else {
    priorityHtml = `<span class="priority-box" title="לא נבדק עדיין"></span>`;
  }
  let balanceHtml;
  if (t._balance_check === 'ok') {
    balanceHtml = `<span class="balance-box yes" title="יתרה תואמת חישוב">✓</span>`;
  } else if (t._balance_check === 'mismatch') {
    const diff = t._balance_diff != null ? t._balance_diff.toFixed(2) : '?';
    balanceHtml = `<span class="balance-box no" title="סטייה: ₪${diff}">✗</span>`;
  } else if (t._balance_check === 'baseline') {
    balanceHtml = `<span class="balance-box baseline" title="התנועה הראשונה — יתרת בסיס">●</span>`;
  } else {
    balanceHtml = `<span class="balance-box" title="חסרים נתונים לחישוב"></span>`;
  }
  return `
    <tr data-txn-id="${t.id}">
      <td class="date">${fmtDate(t.date)}</td>
      <td class="desc">${pending}<span class="main">${escapeHtml(t.description || '—')}</span>${extLine}</td>
      <td class="ben">${escapeHtml(t.beneficiary_name || '')}</td>
      <td class="ref">${escapeHtml(t.reference_number || '')}</td>
      <td class="num ${amtCls}">${fmtMoney(t.amount)}</td>
      <td class="num">${fmtMoney(t.running_balance)}</td>
      <td style="text-align:center;">${balanceHtml}</td>
      <td style="text-align:center;">${priorityHtml}</td>
      <td style="text-align:center;"><button class="btn-del-txn" data-id="${t.id}" title="מחק תנועה">🗑</button></td>
    </tr>
  `;
}

async function runPriorityCheck() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return;
  const btn = document.getElementById('check-priority-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ בודק…';
  try {
    const r = await fetch(`/api/accounts/${id}/check-priority`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) {
      alert('שגיאה בבדיקה מול פריוריטי: ' + (data.error || r.status));
      return;
    }
    const fenceStr = data.fenceDate ? ` · יתרה תואמת עד ${fmtDate(data.fenceDate)}` : '';
    btn.textContent = `✓ ${data.matched}/${data.checked} בפריוריטי${fenceStr}`;
    if (data.balanceDiscrepancy) {
      const bd = data.balanceDiscrepancy;
      const resultEl = document.getElementById('priority-push-result');
      if (resultEl) {
        resultEl.innerHTML = `<div class="push-result-card" style="border-color:var(--color-neg)">
          ⚠ <strong>פער יתרה ב-${fmtDate(bd.date)}</strong>:
          בנק ${fmtMoney(bd.ourBalance)} · פריוריטי ${fmtMoney(bd.priorityBalance)} · הפרש ${fmtMoney(bd.diff)}
          <br><small>ייתכן שתנועות נקלטו בטעות כ"נמצאו בפריוריטי" — השתמשי ב"↑ קלוט תאריך" לתיקון</small>
        </div>`;
      }
    }
    await renderAccountPage();
  } catch (e) {
    alert('שגיאה: ' + e.message);
    btn.textContent = originalText;
  } finally {
    btn.disabled = false;
  }
}

async function savePriorityCashname(id) {
  const select = document.getElementById('cashname-select');
  const cashname = (select.value || '').trim();
  const btn = document.getElementById('save-cashname-btn');
  const pushBtn = document.getElementById('push-priority-btn');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const r = await fetch(`/api/accounts/${id}/priority-cashname`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cashname }),
    });
    const data = await r.json();
    if (!r.ok) {
      alert('שגיאה בשמירת קופה: ' + (data.error || r.status));
      return;
    }
    btn.textContent = '✓ נשמר';
    if (pushBtn) pushBtn.disabled = !cashname;
    const previewBtn = document.getElementById('preview-priority-btn');
    if (previewBtn) previewBtn.disabled = !cashname;
    setTimeout(() => { btn.textContent = 'שמור'; btn.disabled = false; }, 2000);
  } catch (e) {
    alert('שגיאה: ' + e.message);
    btn.textContent = 'שמור';
    btn.disabled = false;
  }
}

async function runForcePushDate(id) {
  const date = prompt('הכנס תאריך לקליטה (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  if (!confirm(`קלוט לפריוריטי את כל תנועות ${fmtDate(date)}?\n(עוקף בדיקת matching — ישלח ישירות)`)) return;

  const btn = document.getElementById('force-push-date-btn');
  const resultEl = document.getElementById('priority-push-result');
  btn.disabled = true;
  btn.textContent = '⏳ קולט...';
  resultEl.innerHTML = '';
  try {
    const r = await fetch(`/api/accounts/${id}/force-push-date?date=${date}`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) {
      resultEl.innerHTML = `<div class="push-result-card" style="color:var(--color-neg)">✗ שגיאה: ${escapeHtml(data.error || String(r.status))}</div>`;
      return;
    }
    const bc = data.balanceCheck;
    let balHtml = '';
    if (bc && !bc.error) {
      const icon = bc.match ? '✓' : '✗';
      const cls  = bc.match ? 'color:var(--color-pos)' : 'color:var(--color-neg)';
      balHtml = `<br><span style="${cls}">${icon} יתרת פריוריטי ${fmtMoney(bc.priorityBalance)} · יתרת בנק ${fmtMoney(bc.ourBalance)}${bc.match ? ' — תואם' : ` · סטייה ${fmtMoney(bc.diff)}`}</span>`;
    } else if (bc?.error) {
      balHtml = `<br><span style="color:var(--color-warn)">⚠ אימות יתרה: ${escapeHtml(bc.error)}</span>`;
    }
    resultEl.innerHTML = `<div class="push-result-card ${data.failed === 0 ? 'push-all-ok' : ''}">
      ${data.pushed > 0 ? `✓ נקלטו ${data.pushed} מתוך ${data.total} תנועות מ-${fmtDate(date)}` : data.message || 'אין תנועות לשליחה'}
      ${data.failed > 0 ? `<br>✗ ${data.failed} נכשלו: ${escapeHtml(JSON.stringify(data.failedDetails))}` : ''}
      ${balHtml}
    </div>`;
    if (data.pushed > 0) await renderAccountPage();
  } catch (e) {
    resultEl.innerHTML = `<div class="push-result-card" style="color:var(--color-neg)">✗ ${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '↑ קלוט תאריך';
  }
}

async function runPriorityPreview(id) {
  const btn = document.getElementById('preview-priority-btn');
  const resultEl = document.getElementById('priority-push-result');
  btn.disabled = true;
  btn.textContent = '⏳ טוען...';
  resultEl.innerHTML = '';

  try {
    const r = await fetch(`/api/accounts/${id}/push-to-priority?preview=true`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) {
      resultEl.innerHTML = `<div class="push-result-card" style="color:var(--color-neg)">✗ שגיאה: ${escapeHtml(data.error || String(r.status))}</div>`;
      return;
    }

    if (data.missing === 0) {
      resultEl.innerHTML = `<div class="push-result-card push-all-ok">
        ✓ כל ${data.matched} התנועות כבר קיימות בפריוריטי — אין מה לקלוט
        ${renderSkippedOldNote(data)}
      </div>`;
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    const rows = (data.preview || []).map(line => {
      const amount = line.CREDIT > 0 ? line.CREDIT : -line.DEBIT;
      const amtCls = amount >= 0 ? 'pos' : 'neg';
      return `<tr>
        <td class="date">${fmtDate((line.CURDATE || '').slice(0, 10))}</td>
        <td class="desc">${escapeHtml(line.DETAILS)}</td>
        <td class="ref">${escapeHtml(line.REFERENCE || '')}</td>
        <td class="num ${amtCls}">${fmtMoney(amount)}</td>
      </tr>`;
    }).join('');

    const moreNote = data.previewTotal > (data.preview || []).length
      ? `<div class="push-more-note">ועוד ${data.previewTotal - data.preview.length} תנועות נוספות...</div>`
      : '';

    resultEl.innerHTML = `<div class="push-result-card">
      <div class="push-result-header">
        <div class="push-stat"><span class="num green">${data.matched}</span> כבר בפריוריטי</div>
        <div class="push-stat"><span class="num red">${data.missing}</span> ממתינות לקליטה</div>
        <div class="push-stat">קופה: <code>${escapeHtml(data.cashName)}</code></div>
        ${data.fenceDate ? `<div class="push-stat">✓ יתרה תואמת עד <strong>${fmtDate(data.fenceDate)}</strong></div>` : ''}
        ${data.bankBalance != null ? `<div class="push-stat">יתרת בנק: <span class="num">${fmtMoney(data.bankBalance)}</span></div>` : ''}
      </div>
      <div class="push-preview-label">תנועות שיישלחו לפריוריטי (${data.previewTotal}):</div>
      <div class="txn-table-wrap push-preview-table">
        <table class="txn-table">
          <thead><tr>
            <th style="width:110px">תאריך</th><th>תיאור</th>
            <th style="width:110px">אסמכתא</th><th style="width:120px;text-align:left;">סכום</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${moreNote}
      ${renderSkippedOldNote(data)}
      <div class="push-dry-run-note">👁 תצוגה מקדימה בלבד — לחץ "קלוט בפריוריטי" לשליחה</div>
    </div>`;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    resultEl.innerHTML = `<div class="push-result-card" style="color:var(--color-neg)">✗ שגיאה: ${escapeHtml(e.message)}</div>`;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } finally {
    btn.disabled = false;
    btn.textContent = '👁 תצוגה מקדימה';
  }
}

async function runPriorityPush(id) {
  const btn = document.getElementById('push-priority-btn');
  const resultEl = document.getElementById('priority-push-result');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ קולט...';
  resultEl.innerHTML = '';

  try {
    const r = await fetch(`/api/accounts/${id}/push-to-priority`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) {
      alert('שגיאה: ' + (data.error || r.status));
      return;
    }

    const previewRows = (data.preview || []).map(line => {
      const amount = line.CREDIT > 0 ? line.CREDIT : -line.DEBIT;
      const amtCls = amount >= 0 ? 'pos' : 'neg';
      return `
        <tr>
          <td class="date">${fmtDate((line.CURDATE || '').slice(0, 10))}</td>
          <td class="desc">${escapeHtml(line.DETAILS)}</td>
          <td class="ref">${escapeHtml(line.REFERENCE || '')}</td>
          <td class="num ${amtCls}">${fmtMoney(amount)}</td>
        </tr>`;
    }).join('');

    const moreNote = data.previewTotal > (data.preview || []).length
      ? `<div class="push-more-note">ועוד ${data.previewTotal - data.preview.length} תנועות נוספות...</div>`
      : '';

    const failedList = (data.failedDetails || []).map(f =>
      `<div class="push-fail-item">• תנועה ${f.id}: ${escapeHtml(f.error)}</div>`
    ).join('');

    if (data.pushed === 0 && data.failed === 0) {
      resultEl.innerHTML = `<div class="push-result-card push-all-ok">
           ✓ כל ${data.matched} התנועות כבר קיימות בפריוריטי — אין מה לקלוט
           ${renderSkippedOldNote(data)}
         </div>`;
    } else {
      resultEl.innerHTML = `<div class="push-result-card">
           <div class="push-result-header">
             <div class="push-stat"><span class="num green">${data.matched}</span> כבר בפריוריטי</div>
             <div class="push-stat"><span class="num green">${data.pushed}</span> נקלטו עכשיו</div>
             ${data.failed > 0
               ? `<div class="push-stat"><span class="num red">${data.failed}</span> נכשלו</div>`
               : ''}
             <div class="push-stat">קופה: <code>${escapeHtml(data.cashName)}</code></div>
             ${data.bankBalance != null
               ? `<div class="push-stat">יתרת בנק: <span class="num">${fmtMoney(data.bankBalance)}</span></div>`
               : ''}
           </div>
           ${data.previewTotal > 0 ? `
           <div class="push-preview-label">תנועות שנקלטו (${data.previewTotal}):</div>
           <div class="txn-table-wrap push-preview-table">
             <table class="txn-table">
               <thead>
                 <tr>
                   <th style="width:110px">תאריך</th>
                   <th>תיאור</th>
                   <th style="width:110px">אסמכתא</th>
                   <th style="width:120px;text-align:left;">סכום</th>
                 </tr>
               </thead>
               <tbody>${previewRows}</tbody>
             </table>
           </div>
           ${moreNote}` : ''}
           ${failedList ? `<div class="push-preview-label">שגיאות:</div><div class="push-fail-list">${failedList}</div>` : ''}
           ${renderSkippedOldNote(data)}
         </div>`;
    }

    btn.textContent = origText;
  } catch (e) {
    alert('שגיאה: ' + e.message);
    btn.textContent = origText;
  } finally {
    btn.disabled = false;
  }
}

function renderSkippedOldNote(data) {
  if (!data.skippedOld?.length) return '';
  const items = data.skippedOld.map(t =>
    `<div class="push-fail-item">• ${fmtDate(t.date)} · ${fmtMoney(t.amount)} (תנועה ${t.id})</div>`
  ).join('');
  return `<div class="push-result-card" style="border-color:var(--color-warn); margin-top:8px;">
    ⚠ <strong>${data.skippedOld.length} תנועות ישנות לא נשלחו</strong> — מתאריך לפני ${fmtDate(data.minPushDate)}
    (הדף האחרון שכבר נטען לפריוריטי). כנראה נקלטו ידנית בפריוריטי עם אסמכתא שונה.
    יש לבדוק ידנית ולא לקלוט אוטומטית:
    <div class="push-fail-list">${items}</div>
  </div>`;
}

function renderReconcileAnchor(anchor) {
  if (!anchor) return '';
  if (anchor.skipped) {
    return `<div class="push-stat">⚠ אין דף קודם בפריוריטי לקופה זו — מתחילים מהתנועה המקומית הראשונה</div>`;
  }
  return `<div class="push-stat">✓ עוגן תואם ב-${fmtDate(anchor.lastLoadedDate)}
    (יתרת פתיחה ${fmtMoney(anchor.priorityOpenBalance)} = יתרתנו ב-${fmtDate(anchor.ourBalanceDate)}: ${fmtMoney(anchor.ourBalance)})</div>`;
}

function renderReconcileAnchorFailure(data) {
  const stageText = {
    'anchor-field-missing': `לא נמצא שדה "יתרת פתיחה" מזוהה בדף האחרון (${fmtDate(data.lastLoadedDate)}) בפריוריטי`,
    'anchor-no-local-data': `אין אצלנו אף תנועה עם יתרה לפני ${fmtDate(data.lastLoadedDate)} — אי אפשר לאמת עוגן`,
    'anchor-mismatch': `יתרת הפתיחה בפריוריטי ל-${fmtDate(data.lastLoadedDate)} (${fmtMoney(data.priorityOpenBalance)}) לא תואמת ליתרתנו ב-${fmtDate(data.ourBalanceDate)} (${fmtMoney(data.ourBalance)}) — הפרש ${fmtMoney(data.diff)}`,
  };
  const detail = stageText[data.stage] || data.stage;
  return `<div class="push-result-card" style="border-color:var(--color-neg)">
    ✗ <strong>העוגן לא אומת — לא נקלט דבר</strong><br>${escapeHtml(detail)}
    ${data.availableFields ? `<br><small>שדות זמינים: ${escapeHtml(data.availableFields.join(', '))}</small>` : ''}
  </div>`;
}

function renderReconcileDayRow(r) {
  const bc = r.balanceCheck;
  let balHtml = '<span class="balance-box"></span>';
  if (bc?.error) {
    balHtml = `<span class="balance-box" title="${escapeHtml(bc.error)}">⚠</span>`;
  } else if (bc && bc.match) {
    balHtml = `<span class="balance-box yes" title="יתרה תואמת">✓</span>`;
  } else if (bc && bc.match === false) {
    balHtml = `<span class="balance-box no" title="סטייה: ₪${bc.diff.toFixed(2)}">✗</span>`;
  }
  return `<tr>
    <td class="date">${fmtDate(r.date)}</td>
    <td class="num">${r.total}</td>
    <td class="num">${r.pushed ?? '—'}</td>
    <td class="num">${r.failed > 0 ? `<span class="num red">${r.failed}</span>` : '0'}</td>
    <td style="text-align:center;">${balHtml}</td>
  </tr>`;
}

async function runReconcilePriority(id) {
  if (!confirm('להריץ התאמה מלאה מול פריוריטי?\nיאמת עוגן לפי יתרת פתיחה של הדף האחרון, ואז יקלוט ימים חדשים אחד-אחד עם אימות יתרה — ויעצור בכשל ראשון.')) return;

  const btn = document.getElementById('reconcile-priority-btn');
  const resultEl = document.getElementById('priority-push-result');
  btn.disabled = true;
  btn.textContent = '⏳ מתאים...';
  resultEl.innerHTML = '';

  try {
    const r = await fetch(`/api/accounts/${id}/reconcile-priority`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) {
      resultEl.innerHTML = `<div class="push-result-card" style="color:var(--color-neg)">✗ שגיאה: ${escapeHtml(data.error || String(r.status))}</div>`;
      return;
    }

    if (data.stage) {
      resultEl.innerHTML = renderReconcileAnchorFailure(data);
      return;
    }

    if (!data.results?.length) {
      resultEl.innerHTML = `<div class="push-result-card push-all-ok">
        ${renderReconcileAnchor(data.anchor)}
        ${escapeHtml(data.message || 'אין ימים חדשים לקליטה')}
      </div>`;
      return;
    }

    const rows = data.results.map(renderReconcileDayRow).join('');
    const stopNote = data.stoppedAt
      ? `<div class="push-result-card" style="border-color:var(--color-neg); margin-top:8px;">
          ⚠ נעצר ב-${fmtDate(data.stoppedAt)} (${data.stoppedReason === 'push-failed' ? 'כשל בקליטה' : data.stoppedReason === 'balance-mismatch' ? 'אי-התאמת יתרה' : 'לא ניתן לאמת יתרה'})
          — ימים מאוחרים יותר לא נקלטו. יש לתקן ולהריץ שוב.
        </div>`
      : '';

    resultEl.innerHTML = `<div class="push-result-card ${data.ok ? 'push-all-ok' : ''}">
      ${renderReconcileAnchor(data.anchor)}
      <div class="push-preview-label">ימים שנקלטו (${data.results.length}):</div>
      <div class="txn-table-wrap push-preview-table">
        <table class="txn-table">
          <thead><tr>
            <th style="width:110px">תאריך</th><th>תנועות</th><th>נקלטו</th><th>נכשלו</th>
            <th style="width:60px;text-align:center;">יתרה</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
    ${stopNote}`;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await renderAccountPage();
  } catch (e) {
    resultEl.innerHTML = `<div class="push-result-card" style="color:var(--color-neg)">✗ ${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔗 התאמה מלאה';
  }
}

/* ───────── auth: user chip in header ───────── */
async function renderUserChip() {
  const target = document.getElementById('user-chip');
  if (!target) return null;
  try {
    const res = await fetch('/auth/me');
    const me = await res.json();
    if (!me?.email) {
      target.innerHTML = `<a href="/login" class="btn btn-ghost btn-sm">התחברות</a>`;
      return null;
    }
    const initial = (me.name || me.email).charAt(0).toUpperCase();
    const adminLink = me.role === 'admin'
      ? `<a href="/users.html">משתמשים</a><span class="sep">·</span><a href="/bank-credentials.html">סיסמאות</a><span class="sep">·</span>`
      : '';
    target.innerHTML = `
      <div class="user-chip">
        <span class="avatar">${escapeHtml(initial)}</span>
        <span>${escapeHtml(me.name || me.email.split('@')[0])}</span>
        <span class="role-tag">${escapeHtml(me.role)}</span>
        ${adminLink}<a href="/logout">יציאה</a>
      </div>
    `;
    return me;
  } catch {
    return null;
  }
}

/* ───────── users page (admin) ───────── */
async function renderUsersPage() {
  await renderUserChip();
  const tbody = document.getElementById('users-tbody');
  let allApps = [];
  let currentAppId = '';

  const renderAccess = (apps) => {
    if (!apps || !apps.length) return '<span class="access-pill none">— ללא גישה</span>';
    const global = apps.find(a => a.app_id === '*');
    if (global) return `<span class="access-pill global"><span>★ כל האפליקציות</span><span class="role">${escapeHtml(global.role)}</span></span>`;
    return apps.map(a => {
      const appName = (allApps.find(x => x.id === a.app_id) || {}).name_he || a.app_id;
      return `<span class="access-pill app"><span>${escapeHtml(appName)}</span><span class="role">${escapeHtml(a.role)}</span></span>`;
    }).join('');
  };

  const reload = async () => {
    try {
      const res = await fetch('/auth/users');
      if (!res.ok) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px; color: var(--color-accent);">אין הרשאה לצפות במשתמשים</td></tr>`;
        return;
      }
      const { users, apps, currentAppId: appId } = await res.json();
      allApps = apps;
      currentAppId = appId;
      if (!users.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px; color: var(--color-text-light);">אין משתמשים</td></tr>`;
        return;
      }
      tbody.innerHTML = users.map(u => `
        <tr>
          <td><div class="email">${escapeHtml(u.email)}</div></td>
          <td><div class="name">${escapeHtml(u.name || '—')}</div></td>
          <td><div class="access-cell">${renderAccess(u.apps)}</div></td>
          <td>${u.active ? '<span class="status-active">● פעיל</span>' : '<span class="status-inactive">○ לא פעיל</span>'}</td>
          <td style="color: var(--color-text-light); font-size: 0.85rem;">${u.last_login_at ? fmtDateTime(u.last_login_at) : 'מעולם לא'}</td>
          <td class="actions">
            <button class="icon-btn" data-edit='${escapeHtml(JSON.stringify(u))}' title="ערוך">✎</button>
            <button class="icon-btn del" data-del="${escapeHtml(u.email)}" title="מחק">✕</button>
          </td>
        </tr>
      `).join('');
      tbody.querySelectorAll('[data-edit]').forEach(b => {
        b.addEventListener('click', () => openModal(JSON.parse(b.dataset.edit)));
      });
      tbody.querySelectorAll('[data-del]').forEach(b => {
        b.addEventListener('click', async () => {
          if (!confirm(`למחוק את ${b.dataset.del}?`)) return;
          const r = await fetch('/auth/users/delete', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: b.dataset.del }),
          });
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            alert('שגיאה: ' + (e.error || r.status));
          } else { reload(); }
        });
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px; color: var(--color-accent);">שגיאה: ${escapeHtml(e.message)}</td></tr>`;
    }
  };

  const modal = document.getElementById('modal-bg');
  const fEmail = document.getElementById('f-email');
  const fName = document.getElementById('f-name');
  const fActive = document.getElementById('f-active');
  const fGlobalRole = document.getElementById('f-global-role');
  const rGlobal = document.getElementById('r-global');
  const rSpecific = document.getElementById('r-specific');
  const dGlobal = document.getElementById('d-global');
  const dSpecific = document.getElementById('d-specific');
  const appsList = document.getElementById('apps-list');
  const errEl = document.getElementById('modal-err');
  const titleEl = document.getElementById('modal-title');

  const updateAccessVisibility = () => {
    dGlobal.style.display = rGlobal.checked ? 'block' : 'none';
    dSpecific.style.display = rSpecific.checked ? 'block' : 'none';
    appsList.querySelectorAll('select').forEach(s => {
      const cb = s.closest('.app-row').querySelector('input[type="checkbox"]');
      s.disabled = !cb.checked;
    });
  };
  rGlobal.addEventListener('change', updateAccessVisibility);
  rSpecific.addEventListener('change', updateAccessVisibility);

  const buildAppsList = (selected = {}) => {
    appsList.innerHTML = allApps.map(app => {
      const sel = selected[app.id];
      const checked = sel ? 'checked' : '';
      const role = sel?.role || 'user';
      const isCurrent = app.id === currentAppId ? ' <span style="color:var(--color-accent); font-size:0.72rem; font-weight:600;">(נוכחי)</span>' : '';
      return `
        <div class="app-row">
          <input type="checkbox" data-app="${escapeHtml(app.id)}" ${checked}>
          <div class="app-name">${escapeHtml(app.name_he)}${isCurrent}</div>
          <select data-role-for="${escapeHtml(app.id)}">
            <option value="user" ${role==='user'?'selected':''}>user</option>
            <option value="approver" ${role==='approver'?'selected':''}>approver</option>
            <option value="admin" ${role==='admin'?'selected':''}>admin</option>
          </select>
        </div>
      `;
    }).join('');
    appsList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', updateAccessVisibility);
    });
  };

  function openModal(existing) {
    errEl.textContent = '';
    buildAppsList({});
    if (existing) {
      titleEl.textContent = 'עריכת משתמש';
      fEmail.value = existing.email; fEmail.disabled = true;
      fName.value = existing.name || '';
      fActive.checked = !!existing.active;
      const apps = existing.apps || [];
      const global = apps.find(a => a.app_id === '*');
      if (global) {
        rGlobal.checked = true;
        fGlobalRole.value = global.role;
      } else {
        rSpecific.checked = true;
        const map = Object.fromEntries(apps.map(a => [a.app_id, a]));
        buildAppsList(map);
      }
    } else {
      titleEl.textContent = 'הוספת משתמש';
      fEmail.value = ''; fEmail.disabled = false;
      fName.value = ''; fActive.checked = true;
      rSpecific.checked = true;
      fGlobalRole.value = 'user';
      const presetCurrent = {};
      presetCurrent[currentAppId] = { role: 'user' };
      buildAppsList(presetCurrent);
    }
    updateAccessVisibility();
    modal.classList.add('open');
    setTimeout(() => fEmail.focus(), 50);
  }
  const closeModal = () => modal.classList.remove('open');

  document.getElementById('add-user-btn').addEventListener('click', () => openModal(null));
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  document.getElementById('save-btn').addEventListener('click', async () => {
    errEl.textContent = '';
    const access = rGlobal.checked
      ? { kind: 'global', role: fGlobalRole.value }
      : {
          kind: 'specific',
          apps: Array.from(appsList.querySelectorAll('input[type="checkbox"]:checked')).map(cb => ({
            id: cb.dataset.app,
            role: appsList.querySelector(`select[data-role-for="${cb.dataset.app}"]`).value,
          })),
        };
    if (access.kind === 'specific' && access.apps.length === 0) {
      errEl.textContent = 'יש לבחור לפחות אפליקציה אחת'; return;
    }
    const body = {
      email: fEmail.value.trim(),
      name: fName.value.trim(),
      active: fActive.checked,
      access,
    };
    if (!body.email.includes('@')) { errEl.textContent = 'אימייל לא תקין'; return; }
    const r = await fetch('/auth/users', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      errEl.textContent = e.error || `HTTP ${r.status}`;
      return;
    }
    closeModal();
    reload();
  });

  reload();
}

/* ───────── bank credentials page (admin) ───────── */
async function renderBankCredentialsPage() {
  await renderUserChip();
  const container = document.getElementById('creds-container');
  const warning = document.getElementById('vault-warning-container');

  const reload = async () => {
    try {
      const r = await fetch('/api/bank-credentials');
      if (!r.ok) {
        container.innerHTML = `<div class="empty"><h3>אין הרשאה</h3><p>רק admin רשאי לראות את הדף הזה</p></div>`;
        return;
      }
      const { vault_configured, banks } = await r.json();
      if (!vault_configured) {
        warning.innerHTML = `<div class="vault-warning">⚠️ <b>BANK_VAULT_KEY לא מוגדר ב-env.</b> בלי המפתח אי אפשר להצפין/לפענח. הוסף ל-.env על השרת:<br><code style="font-family:var(--font-family-en); background:rgba(0,0,0,0.05); padding:2px 6px; border-radius:4px;">BANK_VAULT_KEY=$(openssl rand -hex 32)</code></div>`;
      } else {
        warning.innerHTML = '';
      }

      container.innerHTML = banks.map(b => `
        <div class="bank-section">
          <div class="bank-section-header">
            <span class="bank-name">${escapeHtml(b.name_he)}</span>
            ${b.credentials.length === 0 ? `<span class="no-creds">⚠ אין פרטי כניסה</span>` : ''}
            <button class="btn btn-pri btn-sm" data-add-bank="${escapeHtml(b.id)}" data-bank-name="${escapeHtml(b.name_he)}" ${!vault_configured ? 'disabled' : ''}>+ הוסף</button>
          </div>
          ${b.credentials.map(c => `
            <div class="cred-row">
              <div class="cred-info">
                <span class="cred-label">${escapeHtml(c.label)}</span>
                <span class="status-set">✓ הוגדר</span>
                ${c.updated_by ? `<span class="meta">עודכן ע"י ${escapeHtml(c.updated_by)} · ${fmtDateTime(c.updated_at)}</span>` : ''}
              </div>
              <div class="cred-actions">
                <button class="btn btn-ghost btn-sm" data-edit-cred="${c.id}" data-bank-id="${escapeHtml(b.id)}" data-bank-name="${escapeHtml(b.name_he)}" data-cred-label="${escapeHtml(c.label)}" ${!vault_configured ? 'disabled' : ''}>ערוך</button>
                <button class="btn btn-danger btn-sm" data-del-cred="${c.id}" data-bank-id="${escapeHtml(b.id)}" data-cred-label="${escapeHtml(c.label)}">מחק</button>
              </div>
            </div>
          `).join('')}
        </div>
      `).join('');

      container.querySelectorAll('[data-add-bank]').forEach(btn => {
        btn.addEventListener('click', () => openCredsModal({ mode: 'add', bankId: btn.dataset.addBank, bankName: btn.dataset.bankName }));
      });
      container.querySelectorAll('[data-edit-cred]').forEach(btn => {
        btn.addEventListener('click', () => openCredsModal({
          mode: 'edit',
          bankId: btn.dataset.bankId,
          bankName: btn.dataset.bankName,
          credId: btn.dataset.editCred,
          currentLabel: btn.dataset.credLabel,
        }));
      });
      container.querySelectorAll('[data-del-cred]').forEach(btn => {
        btn.addEventListener('click', () => deleteCred(btn.dataset.bankId, btn.dataset.delCred, btn.dataset.credLabel));
      });
    } catch (e) {
      container.innerHTML = `<div class="empty"><h3>שגיאת טעינה</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  };

  const modal = document.getElementById('modal-bg');
  const fLabel = document.getElementById('f-label');
  const fUser = document.getElementById('f-username');
  const fPass = document.getElementById('f-password');
  const fUrl = document.getElementById('f-loginurl');
  const errEl = document.getElementById('modal-err');
  const hintEl = document.getElementById('modal-hint');
  const titleEl = document.getElementById('modal-title');
  let modalState = null; // { mode, bankId, credId? }

  function openCredsModal({ mode, bankId, bankName, credId, currentLabel }) {
    modalState = { mode, bankId, credId };
    if (mode === 'add') {
      titleEl.textContent = `הוספת פרטי כניסה — ${bankName}`;
      hintEl.textContent = 'שם משתמש וסיסמה חובה. ניתן להוסיף מספר סטים לאותו בנק.';
      fLabel.value = '';
      fLabel.placeholder = 'ראשי';
    } else {
      titleEl.textContent = `עריכת פרטי כניסה — ${bankName} (${currentLabel})`;
      hintEl.textContent = 'שדה ריק = הערך הקיים נשמר ללא שינוי.';
      fLabel.value = '';
      fLabel.placeholder = currentLabel || 'ראשי';
    }
    fUser.value = ''; fPass.value = ''; fUrl.value = '';
    fUser.placeholder = mode === 'add' ? '' : 'ללא שינוי';
    fPass.placeholder = mode === 'add' ? '' : 'ללא שינוי';
    fUrl.placeholder  = mode === 'add' ? '' : 'ללא שינוי';
    errEl.textContent = '';
    modal.classList.add('open');
    setTimeout(() => fLabel.focus(), 50);
  }
  const closeModal = () => { modal.classList.remove('open'); modalState = null; };

  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  document.getElementById('save-btn').addEventListener('click', async () => {
    if (!modalState) return;
    errEl.textContent = '';
    const { mode, bankId, credId } = modalState;
    const body = {
      label:    fLabel.value.trim() || null,
      username: fUser.value.trim()  || null,
      password: fPass.value.trim()  || null,
      loginUrl: fUrl.value.trim()   || null,
    };

    let r;
    if (mode === 'add') {
      r = await fetch(`/api/bank-credentials/${bankId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      if (!body.label && !body.username && !body.password && !body.loginUrl) {
        errEl.textContent = 'יש למלא לפחות שדה אחד לשינוי';
        return;
      }
      r = await fetch(`/api/bank-credentials/${bankId}/${credId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      errEl.textContent = e.error || `HTTP ${r.status}`;
      return;
    }
    closeModal();
    reload();
  });

  async function deleteCred(bankId, credId, label) {
    if (!confirm(`למחוק את פרטי הכניסה "${label}"?\nפעולה זו בלתי הפיכה.`)) return;
    const r = await fetch(`/api/bank-credentials/${bankId}/${credId}`, { method: 'DELETE' });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      alert(e.error || `שגיאה HTTP ${r.status}`);
      return;
    }
    reload();
  }

  reload();
}

/* ───────── boot ───────── */
if (document.getElementById('banks-container')) {
  renderUserChip();
  renderIndex();
}
if (document.getElementById('account-hero')) renderUserChip();
