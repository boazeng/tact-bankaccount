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
        <div class="card-txns" style="display:none; padding: 12px 16px;"></div>
      </div>
    `).join('');

    container.querySelectorAll('.card-item').forEach(item => {
      item.querySelector('.bank-summary-row').addEventListener('click', () => toggleCard(item));
    });
  } catch (e) {
    container.innerHTML = `<p class="empty" style="padding: 32px; color:var(--color-neg);">שגיאה בטעינת כרטיסים: ${escapeHtml(e.message)}</p>`;
  }
}

async function toggleCard(item) {
  const txnsEl = item.querySelector('.card-txns');
  const isOpen = txnsEl.style.display !== 'none';
  if (isOpen) { txnsEl.style.display = 'none'; return; }

  txnsEl.style.display = 'block';
  if (txnsEl.dataset.loaded) return;

  const cardId = item.dataset.cardId;
  txnsEl.innerHTML = 'טוען תנועות…';
  try {
    const res = await fetch(`/api/credit-cards/${cardId}/transactions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { transactions } = await res.json();

    if (!transactions.length) {
      txnsEl.innerHTML = `<p class="empty">אין תנועות.</p>`;
    } else {
      const rows = transactions.map(t => `
        <tr>
          <td>${escapeHtml(t.purchase_date)}</td>
          <td>${escapeHtml(t.merchant_name || '—')}</td>
          <td>${t.installment_current ? `${t.installment_current}/${t.installment_total}` : '—'}</td>
          <td style="color: ${t.amount < 0 ? 'var(--color-neg)' : 'var(--color-pos)'}">${fmtMoney(t.amount)}</td>
        </tr>
      `).join('');
      txnsEl.innerHTML = `
        <div class="txn-table-wrap">
          <table class="txn-table">
            <thead><tr><th>תאריך רכישה</th><th>בית עסק</th><th>תשלומים</th><th>סכום</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px;" id="priority-preview-btn-${cardId}">📄 תצוגת פריוריטי</button>
        <div class="priority-preview" id="priority-preview-${cardId}" style="display:none; margin-top:12px;"></div>`;
      document.getElementById(`priority-preview-btn-${cardId}`).addEventListener('click', () => togglePriorityPreview(cardId));
    }
    txnsEl.dataset.loaded = '1';
  } catch (e) {
    txnsEl.innerHTML = `<p class="empty" style="color:var(--color-neg);">שגיאה: ${escapeHtml(e.message)}</p>`;
  }
}

async function togglePriorityPreview(cardId) {
  const el = document.getElementById(`priority-preview-${cardId}`);
  const isOpen = el.style.display !== 'none';
  if (isOpen) { el.style.display = 'none'; return; }

  el.style.display = 'block';
  if (el.dataset.loaded) return;

  el.innerHTML = 'טוען תצוגת פריוריטי…';
  try {
    const res = await fetch(`/api/credit-cards/${cardId}/priority-preview`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { pages } = await res.json();

    if (!pages.length) {
      el.innerHTML = `<p class="empty">אין נתונים.</p>`;
    } else {
      el.innerHTML = pages.map(page => {
        const rows = page.lines.map(l => `
          <tr${l.details === 'תשלום בפועל בבנק' ? ' style="font-weight:700; border-top:2px solid var(--color-border);"' : ''}>
            <td>${escapeHtml(l.curdate)}</td>
            <td>${escapeHtml(l.btcode)}</td>
            <td>${escapeHtml(l.details)}</td>
            <td>${l.debit ? fmtMoney(-l.debit) : ''}</td>
            <td>${l.credit ? fmtMoney(l.credit) : ''}</td>
          </tr>
        `).join('');
        return `
          <div style="margin-bottom:16px;">
            <div style="font-weight:700; margin-bottom:6px;">דף בנק ליום ${escapeHtml(page.curdate)}</div>
            <div class="txn-table-wrap">
              <table class="txn-table">
                <thead><tr><th>תאריך ערך</th><th>קוד פעולה</th><th>פרטים</th><th>חובה</th><th>זכות</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>`;
      }).join('');
    }
    el.dataset.loaded = '1';
  } catch (e) {
    el.innerHTML = `<p class="empty" style="color:var(--color-neg);">שגיאה: ${escapeHtml(e.message)}</p>`;
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
          addLine(`✓ ${data.account} · כרטיס ${data.cardLast4}: נשמרו ${data.newSaved} תנועות חדשות (מתוך ${data.fetched})`, 'success');
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

renderUserChip();
loadCards();
