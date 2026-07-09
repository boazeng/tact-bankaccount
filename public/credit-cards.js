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

async function loadPriorityPages(cardId) {
  const el = document.querySelector(`.card-item[data-card-id="${cardId}"] .priority-pages`);
  if (!el) return;
  el.innerHTML = 'טוען תצוגת פריוריטי…';
  try {
    const res = await fetch(`/api/credit-cards/${cardId}/priority-preview`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { pages } = await res.json();

    if (!pages.length) {
      el.innerHTML = `<p class="empty">אין תנועות.</p>`;
    } else {
      el.innerHTML = pages.map(page => {
        const rows = page.lines.map(l => `
          <tr${l.details === 'תשלום בפועל בבנק' ? ' style="font-weight:700; border-top:2px solid var(--color-border);"' : ''}>
            <td>${escapeHtml(l.curdate)}</td>
            <td>${escapeHtml(l.valueDate)}</td>
            <td>${escapeHtml(l.btcode)}</td>
            <td>${escapeHtml(l.details)}</td>
            <td>${l.debit ? fmtMoney(-l.debit) : ''}</td>
            <td>${l.credit ? fmtMoney(l.credit) : ''}</td>
          </tr>
        `).join('');
        const pushedBadge = page.pushed
          ? '<span style="color:var(--color-pos); font-weight:700;">✓ נקלט בפריוריטי</span>'
          : '<span style="color:var(--color-text-light);">טרם נקלט</span>';
        return `
          <div style="margin-bottom:16px;">
            <div style="font-weight:700; margin-bottom:6px; display:flex; gap:10px; align-items:center;">
              <span>דף בנק ליום ${escapeHtml(page.curdate)}</span>
              ${pushedBadge}
            </div>
            <div class="txn-table-wrap">
              <table class="txn-table">
                <thead><tr><th>תאריך</th><th>תאריך ערך</th><th>קוד פעולה</th><th>פרטים</th><th>חובה</th><th>זכות</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>`;
      }).join('');
    }
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
      status.textContent = `שגיאה בקליטה: ${failed[0].error}`;
      status.style.color = 'var(--color-neg)';
    } else {
      const existed = data.results.filter(r => r.alreadyExisted).length;
      const created = data.results.length - existed;
      const parts = [];
      if (created) parts.push(`${created} דפים חדשים נקלטו`);
      if (existed) parts.push(`${existed} כבר היו קיימים בפריוריטי (לא נוצרו כפולים)`);
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
document.getElementById('push-all-priority-btn').addEventListener('click', pushAllCardsToPriority);

renderUserChip();
loadCards();
