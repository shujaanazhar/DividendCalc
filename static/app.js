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
    const { ok } = await apiFetch('/api/portfolio');
    if (ok) { showApp(); return; }
    localStorage.removeItem('psx_api_key');
  }
  showGate();
}

function showGate() {
  $('key-gate').style.display = 'flex';
  document.querySelector('.sidebar').style.display = 'none';
  document.querySelector('.main').style.display = 'none';
  setTimeout(() => $('gate-key-input').focus(), 60);
}

function showApp() {
  $('key-gate').style.display = 'none';
  document.querySelector('.sidebar').style.display = '';
  document.querySelector('.main').style.display = '';
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
  document.querySelectorAll('.nav-item').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const view = link.dataset.view;

      document.querySelectorAll('.nav-item').forEach(l => l.classList.remove('active'));
      link.classList.add('active');

      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(`view-${view}`).classList.add('active');
    });
  });
}

// ── Portfolio ──────────────────────────────────────────────────────────────
async function loadPortfolio() {
  const { ok, data } = await apiFetch('/api/portfolio');
  if (ok) renderPortfolio(data);
}

function renderPortfolio(portfolio) {
  const emptyEl = $('portfolio-empty');
  const gridEl  = $('portfolio-grid');

  if (!portfolio.length) {
    emptyEl.style.display = 'flex';
    gridEl.style.display  = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  gridEl.style.display  = 'grid';
  gridEl.innerHTML = '';

  portfolio.forEach(h => {
    const card = document.createElement('div');
    card.className = 'holding-card';
    card.innerHTML = `
      <div class="holding-card-top">
        <span class="symbol-pill">${h.symbol}</span>
        <button class="btn btn-danger" title="Remove holding">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div>
        <div class="holding-card-shares">${h.shares.toLocaleString()}<span>shares</span></div>
      </div>
      <div class="holding-card-date">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
        Bought ${h.purchase_date}
      </div>
    `;
    card.querySelector('.btn-danger').addEventListener('click', () => deleteHolding(h.id));
    gridEl.appendChild(card);
  });
}

async function deleteHolding(id) {
  if (!confirm('Remove this holding from your portfolio?')) return;
  const { ok } = await apiFetch(`/api/portfolio/${id}`, { method: 'DELETE' });
  if (ok) {
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
    const card = document.createElement('div');
    card.className = 'result-card';

    let bodyHtml = '';
    if (!h.events.length) {
      bodyHtml = `<div class="result-card-empty">No cash dividends in this period.</div>`;
    } else {
      const rows = h.events.map(ev => `
        <tr>
          <td>${ev.ex_date}</td>
          <td>${ev.period}</td>
          <td><span class="pct-badge">${ev.cash_pct}%</span></td>
          <td><span class="details-text">${ev.details}</span></td>
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
                <th>Period</th>
                <th>Cash %</th>
                <th>Details</th>
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

  initNav();
  initPeriodPills();
  initGate();

  // Modal triggers
  $('open-add-btn').addEventListener('click', openModal);
  $('empty-add-btn').addEventListener('click', openModal);
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

  // Calc button
  $('calc-btn').addEventListener('click', calculate);
});
