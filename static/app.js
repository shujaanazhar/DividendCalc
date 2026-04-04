'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let activePeriod = 'all';
let activeTax    = 'filer';

// ── Helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getApiKey() {
  return localStorage.getItem('psx_api_key') || '';
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': getApiKey(),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    // Key was revoked or wrong — force re-auth
    localStorage.removeItem('psx_api_key');
    location.reload();
    return { ok: false, status: 401, data: {} };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── Key gate ───────────────────────────────────────────────────────────────
async function initGate() {
  const stored = getApiKey();
  if (stored) {
    // Verify stored key is still valid
    const { ok, data } = await apiFetch('/api/portfolio');
    if (ok) { allHoldings = data; showApp(); renderPortfolio(data); renderHistory(data); return; }
    localStorage.removeItem('psx_api_key');
  }
  showGate();
}

function showGate() {
  $('key-gate').style.display = 'flex';
  document.body.classList.add('gate-visible');
  setTimeout(() => $('gate-key-input').focus(), 60);
}

function showApp() {
  $('key-gate').style.display = 'none';
  document.body.classList.remove('gate-visible');
}

async function submitGate() {
  const key = $('gate-key-input').value.trim();
  if (!key) return;
  $('gate-submit').disabled = true;
  $('gate-error').style.display = 'none';

  // Test the key
  const res = await fetch('/api/portfolio', {
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
  });

  $('gate-submit').disabled = false;
  if (res.ok) {
    localStorage.setItem('psx_api_key', key);
    showApp();
    loadPortfolio();
  } else {
    $('gate-error').style.display = 'block';
    $('gate-key-input').select();
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────
function initNav() {
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      switchView(link.dataset.view);
    });
  });
}

function switchView(view) {
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(l => {
    l.classList.toggle('active', l.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
}

// ── Portfolio & History ────────────────────────────────────────────────────
let allHoldings = [];

async function loadPortfolio() {
  const { ok, data } = await apiFetch('/api/portfolio');
  if (ok) { allHoldings = data; renderPortfolio(data); renderHistory(data); }
}

function groupBySymbol(portfolio) {
  const grouped = {};
  portfolio.forEach(h => {
    if (!grouped[h.symbol]) grouped[h.symbol] = { symbol: h.symbol, totalShares: 0, lots: [] };
    grouped[h.symbol].totalShares += h.shares;
    grouped[h.symbol].lots.push(h);
  });
  return Object.values(grouped).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function renderPortfolio(portfolio) {
  const emptyEl = $('portfolio-empty');
  const wrapEl  = $('portfolio-table-wrap');
  const bodyEl  = $('portfolio-body');

  if (!portfolio.length) {
    emptyEl.style.display = 'flex';
    wrapEl.style.display  = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  wrapEl.style.display  = '';
  bodyEl.innerHTML = '';

  groupBySymbol(portfolio).forEach(g => {
    const tr = document.createElement('tr');
    tr.className = 'portfolio-row';
    tr.innerHTML = `
      <td>
        <span class="symbol-pill symbol-pill-link" data-symbol="${g.symbol}">${g.symbol}</span>
      </td>
      <td class="shares-cell">${g.totalShares.toLocaleString()}</td>
      <td class="lots-cell">${g.lots.length} lot${g.lots.length > 1 ? 's' : ''}</td>
      <td>
        <button class="btn btn-danger" title="Remove all lots for ${g.symbol}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </td>
    `;
    // Click symbol → go to history filtered by that symbol
    tr.querySelector('.symbol-pill-link').addEventListener('click', () => {
      filterHistoryBySymbol(g.symbol);
    });
    // Delete all lots for this symbol
    tr.querySelector('.btn-danger').addEventListener('click', async () => {
      const ok = await confirmDialog(
        `Delete ${g.symbol}?`,
        `This will permanently remove all ${g.lots.length} lot${g.lots.length > 1 ? 's' : ''} of ${g.symbol} (${g.totalShares.toLocaleString()} shares total). This cannot be undone.`
      );
      if (!ok) return;
      for (const lot of g.lots) {
        await apiFetch(`/api/portfolio/${lot.id}`, { method: 'DELETE' });
      }
      loadPortfolio();
      $('results').style.display = 'none';
    });
    bodyEl.appendChild(tr);
  });
}

function renderHistory(portfolio, filterSymbol = '') {
  const emptyEl   = $('history-empty');
  const wrapEl    = $('history-table-wrap');
  const bodyEl    = $('history-body');
  const filterBar = $('history-filter-bar');
  const filterActive = $('history-filter-active');
  const filterChip   = $('history-filter-chip');
  const filterSelect = $('history-symbol-filter');

  // Populate filter dropdown with unique symbols
  const symbols = [...new Set(portfolio.map(h => h.symbol))].sort();
  filterSelect.innerHTML = '<option value="">All symbols</option>';
  symbols.forEach(sym => {
    const opt = document.createElement('option');
    opt.value = sym; opt.textContent = sym;
    if (sym === filterSymbol) opt.selected = true;
    filterSelect.appendChild(opt);
  });

  const filtered = filterSymbol
    ? portfolio.filter(h => h.symbol === filterSymbol)
    : portfolio;

  // Show/hide filter bar
  if (portfolio.length) filterBar.style.display = '';
  filterActive.style.display = filterSymbol ? 'flex' : 'none';
  if (filterSymbol) filterChip.textContent = filterSymbol;

  if (!filtered.length) {
    emptyEl.style.display = 'flex';
    wrapEl.style.display  = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  wrapEl.style.display  = '';
  bodyEl.innerHTML = '';

  [...filtered].sort((a, b) => a.purchase_date.localeCompare(b.purchase_date)).forEach(h => {
    bodyEl.appendChild(makeHistoryRow(h));
  });
}

function makeHistoryRow(h) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${h.purchase_date}</td>
    <td><span class="symbol-pill">${h.symbol}</span></td>
    <td>${h.shares.toLocaleString()}</td>
    <td>
      <button class="btn-icon btn-edit" title="Edit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
    </td>
    <td>
      <button class="btn btn-danger" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </td>
  `;
  tr.querySelector('.btn-edit').addEventListener('click', () => startEditRow(tr, h));
  tr.querySelector('.btn-danger').addEventListener('click', () => deleteHolding(h.id));
  return tr;
}

function startEditRow(tr, h) {
  tr.innerHTML = `
    <td><input class="inline-input" type="date" value="${h.purchase_date}" /></td>
    <td><input class="inline-input" type="text" value="${h.symbol}" maxlength="8" style="width:80px;text-transform:uppercase;" /></td>
    <td><input class="inline-input" type="number" value="${h.shares}" min="1" style="width:90px;" /></td>
    <td>
      <button class="btn btn-primary btn-inline-save" title="Save">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
      </button>
    </td>
    <td>
      <button class="btn btn-danger btn-inline-cancel" title="Cancel">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </td>
  `;
  const symInput = tr.querySelector('input[type="text"]');
  symInput.addEventListener('input', e => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
  });
  tr.querySelector('.btn-inline-cancel').addEventListener('click', () => {
    tr.replaceWith(makeHistoryRow(h));
  });
  tr.querySelector('.btn-inline-save').addEventListener('click', () => saveEditRow(tr, h));
}

async function saveEditRow(tr, h) {
  const dateVal   = tr.querySelector('input[type="date"]').value;
  const symbolVal = tr.querySelector('input[type="text"]').value.trim().toUpperCase();
  const sharesVal = parseInt(tr.querySelector('input[type="number"]').value);

  if (!dateVal || !symbolVal || !sharesVal || sharesVal <= 0) {
    tr.querySelectorAll('.inline-input').forEach(el => {
      el.classList.toggle('invalid', !el.value || (el.type === 'number' && parseInt(el.value) <= 0));
    });
    return;
  }

  const saveBtn = tr.querySelector('.btn-inline-save');
  saveBtn.disabled = true;

  const { ok, data } = await apiFetch(`/api/portfolio/${h.id}`, {
    method: 'PUT',
    body: JSON.stringify({ symbol: symbolVal, shares: sharesVal, purchase_date: dateVal }),
  });

  saveBtn.disabled = false;

  if (!ok) {
    const detail = data.detail;
    const msg = Array.isArray(detail)
      ? detail.map(e => e.msg.replace('Value error, ', '')).join(' · ')
      : (detail || 'Failed to save.');
    alert(msg);
    return;
  }

  // Update allHoldings in place
  const idx = allHoldings.findIndex(x => x.id === h.id);
  if (idx !== -1) allHoldings[idx] = data;

  tr.replaceWith(makeHistoryRow(data));
  renderPortfolio(allHoldings);
}

function filterHistoryBySymbol(symbol) {
  switchView('history');
  renderHistory(allHoldings, symbol);
}

async function deleteHolding(id) {
  const holding = allHoldings.find(h => h.id === id);
  const ok = await confirmDialog(
    'Delete this holding?',
    holding
      ? `Remove ${holding.shares.toLocaleString()} shares of ${holding.symbol} purchased on ${holding.purchase_date}? This cannot be undone.`
      : 'Remove this holding? This cannot be undone.'
  );
  if (!ok) return;
  const { ok: deleted } = await apiFetch(`/api/portfolio/${id}`, { method: 'DELETE' });
  if (deleted) {
    loadPortfolio();
    $('results').style.display = 'none';
  }
}

// ── Modal ──────────────────────────────────────────────────────────────────
function openModal() {
  $('holdings-rows').innerHTML = '';
  $('modal-error').style.display = 'none';
  addRow();  // start with one empty row
  $('modal-backdrop').classList.add('open');
}

function closeModal() {
  $('modal-backdrop').classList.remove('open');
}

function addRow(symbol = '', shares = '', date = '') {
  const today = new Date().toISOString().slice(0, 10);
  const row = document.createElement('div');
  row.className = 'holding-row';
  row.innerHTML = `
    <input type="text"   class="row-symbol" placeholder="HBL"  value="${symbol}" autocomplete="off" spellcheck="false" />
    <input type="number" class="row-shares" placeholder="1000" value="${shares}" min="1" />
    <input type="date"   class="row-date"   value="${date || today}" />
    <button class="btn-remove-row" title="Remove">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  `;
  row.querySelector('.btn-remove-row').addEventListener('click', () => {
    row.remove();
    // Always keep at least one row
    if ($('holdings-rows').children.length === 0) addRow();
  });
  // uppercase symbol as you type
  row.querySelector('.row-symbol').addEventListener('input', e => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
  });
  $('holdings-rows').appendChild(row);
  row.querySelector('.row-symbol').focus();
}

async function submitHoldings() {
  $('modal-error').style.display = 'none';

  const rows = [...$('holdings-rows').querySelectorAll('.holding-row')];
  const holdings = [];
  let valid = true;

  rows.forEach(row => {
    const symbolEl = row.querySelector('.row-symbol');
    const sharesEl = row.querySelector('.row-shares');
    const dateEl   = row.querySelector('.row-date');

    symbolEl.classList.remove('invalid');
    sharesEl.classList.remove('invalid');
    dateEl.classList.remove('invalid');

    const symbol = symbolEl.value.trim().toUpperCase();
    const shares = parseInt(sharesEl.value);
    const date   = dateEl.value;

    if (!symbol)           { symbolEl.classList.add('invalid'); valid = false; }
    if (!shares || shares <= 0) { sharesEl.classList.add('invalid'); valid = false; }
    if (!date)             { dateEl.classList.add('invalid');   valid = false; }

    if (symbol && shares > 0 && date) {
      holdings.push({ symbol, shares, purchase_date: date });
    }
  });

  if (!valid) return showModalErr('Please fix the highlighted fields.');
  if (!holdings.length) return showModalErr('Add at least one holding.');

  $('modal-submit').disabled = true;
  $('modal-submit').textContent = `Saving ${holdings.length}…`;

  const { ok, data } = await apiFetch('/api/portfolio/bulk', {
    method: 'POST',
    body: JSON.stringify(holdings),
  });

  $('modal-submit').disabled = false;
  $('modal-submit').textContent = 'Save All';

  if (!ok) {
    const detail = data.detail;
    const msg = Array.isArray(detail)
      ? detail.map(e => e.msg.replace('Value error, ', '')).join(' · ')
      : (detail || 'Failed to save holdings.');
    return showModalErr(msg);
  }

  closeModal();
  loadPortfolio();
}

function showModalErr(msg) {
  const el = $('modal-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Period & tax selectors ─────────────────────────────────────────────────
function initPeriodPills() {
  document.querySelectorAll('[data-period]').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('[data-period]').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activePeriod = pill.dataset.period;
      $('opt-year').style.display   = activePeriod === 'year'   ? 'block' : 'none';
      $('opt-custom').style.display = activePeriod === 'custom' ? 'block' : 'none';
    });
  });

  document.querySelectorAll('[data-tax]').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('[data-tax]').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeTax = pill.dataset.tax;
    });
  });
}

// ── Calculate ──────────────────────────────────────────────────────────────
async function calculate() {
  $('calc-error').style.display = 'none';
  $('results').style.display    = 'none';
  $('calc-loading').style.display = '';
  $('calc-btn').disabled = true;

  const body = { period: activePeriod, tax_status: activeTax };
  if (activePeriod === 'year')   body.year      = parseInt($('year-field').value);
  if (activePeriod === 'custom') {
    body.from_date = $('from-date').value;
    body.to_date   = $('to-date').value;
  }

  const { ok, data } = await apiFetch('/api/calculate', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  $('calc-loading').style.display = 'none';
  $('calc-btn').disabled = false;

  if (!ok) {
    $('calc-error-msg').textContent = data.detail || 'Calculation failed.';
    $('calc-error').style.display = 'flex';
    return;
  }

  renderResults(data);
}

function renderResults(data) {
  $('results-label').textContent    = data.label;
  $('grand-net').textContent        = fmt(data.grand_net);
  $('grand-gross').textContent      = 'PKR ' + fmt(data.grand_gross);
  $('grand-tax').textContent        = '− PKR ' + fmt(data.grand_tax);
  $('tax-rate-label').textContent   = data.tax_rate_pct;

  const container = $('holdings-results');
  container.innerHTML = '';

  data.holdings.forEach(h => {
    if (!h.events.length) return;  // skip holdings with no dividends in this period

    const card = document.createElement('div');
    card.className = 'result-card';

    let bodyHtml = '';
    {
      const rows = h.events.map(ev => `
        <tr>
          <td>${ev.ex_date}</td>
          <td>${ev.payment_date || ev.ex_date}</td>
          <td>${ev.period}</td>
          <td><span class="pct-badge">${ev.cash_pct}%</span></td>
          <td class="col-right">PKR ${fmt(ev.gross)}</td>
          <td class="col-right col-tax">− PKR ${fmt(ev.tax)}</td>
          <td class="col-right col-net">PKR ${fmt(ev.net)}</td>
        </tr>
      `).join('');

      bodyHtml = `
        <div class="div-table-wrap">
          <table class="div-table">
            <thead>
              <tr>
                <th>Ex-Date</th>
                <th>Est. Payment</th>
                <th>Period</th>
                <th>Cash %</th>
                <th class="col-right">Gross</th>
                <th class="col-right">WHT</th>
                <th class="col-right">Net</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="result-card-header">
        <div class="result-card-left">
          <span class="symbol-pill">${h.symbol}</span>
          <div class="result-card-meta">${h.shares.toLocaleString()} shares &bull; bought ${h.purchase_date}</div>
        </div>
        <div class="result-card-totals">
          <div class="result-card-net">PKR ${fmt(h.net)}</div>
          <div class="result-card-gross">Gross: PKR ${fmt(h.gross)}</div>
        </div>
      </div>
      ${bodyHtml}
    `;

    container.appendChild(card);
  });

  $('results').style.display = 'block';
}

// ── Confirm dialog ─────────────────────────────────────────────────────────
function confirmDialog(title, msg) {
  return new Promise(resolve => {
    $('confirm-title').textContent = title;
    $('confirm-msg').textContent   = msg;
    $('confirm-backdrop').classList.add('open');
    $('confirm-ok').focus();

    function finish(result) {
      $('confirm-backdrop').classList.remove('open');
      off();
      resolve(result);
    }

    function off() {
      $('confirm-ok').removeEventListener('click', onOk);
      $('confirm-cancel').removeEventListener('click', onCancel);
      $('confirm-close').removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
    }

    const onOk     = () => finish(true);
    const onCancel = () => finish(false);
    const onKey    = e => { if (e.key === 'Escape') finish(false); };

    $('confirm-ok').addEventListener('click', onOk);
    $('confirm-cancel').addEventListener('click', onCancel);
    $('confirm-close').addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

// ── Theme ──────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('psx_theme') || 'dark';
  applyTheme(saved);

  $('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  $('mobile-theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('psx_theme', theme);
  const isDark = theme === 'dark';
  $('theme-icon-dark').style.display        = isDark ? '' : 'none';
  $('theme-icon-light').style.display       = isDark ? 'none' : '';
  $('theme-label').textContent              = isDark ? 'Light Mode' : 'Dark Mode';
  $('mobile-theme-icon-dark').style.display  = isDark ? '' : 'none';
  $('mobile-theme-icon-light').style.display = isDark ? 'none' : '';
}

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Default date inputs
  const today = new Date().toISOString().slice(0, 10);
  $('to-date').value    = today;
  $('from-date').value  = today.slice(0, 4) + '-01-01';
  $('year-field').value = new Date().getFullYear();

  // Gate
  $('gate-submit').addEventListener('click', submitGate);
  $('gate-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitGate(); });

  initTheme();
  initNav();
  initPeriodPills();
  initGate();

  // Modal triggers
  $('open-add-btn').addEventListener('click', openModal);
  $('empty-add-btn').addEventListener('click', openModal);
  $('history-add-btn').addEventListener('click', openModal);
  $('modal-close').addEventListener('click', closeModal);
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-submit').addEventListener('click', submitHoldings);
  $('add-row-btn').addEventListener('click', () => addRow());
  $('modal-backdrop').addEventListener('click', e => {
    if (e.target === $('modal-backdrop')) closeModal();
  });

  // Escape closes modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  // History filter
  $('history-symbol-filter').addEventListener('change', e => {
    renderHistory(allHoldings, e.target.value);
  });
  $('history-filter-clear').addEventListener('click', () => {
    renderHistory(allHoldings, '');
  });

  // Calc button
  $('calc-btn').addEventListener('click', calculate);
});
