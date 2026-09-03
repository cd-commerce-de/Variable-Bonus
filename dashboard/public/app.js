/* CD Commerce — Variable Bonus Dashboard
 *
 * IMPORTANT SECURITY NOTE (read before deploying):
 * The passcode check below runs entirely in the browser. Anyone can view
 * the page source and read PASSCODE_HASH, then brute-force or simply
 * look up the matching passcode offline. This gate exists ONLY so the
 * dashboard isn't wide open during local testing.
 *
 * The real access control for a deployed dashboard is the server-side
 * gate in /api/login.js + /api/data.js, which checks a secret stored as
 * a server environment variable (never shipped to the browser) and only
 * then serves data from the private GitHub repo. See README.md.
 */

const PASSCODE_HASH = "REPLACE_WITH_SHA256_HASH"; // set via scripts/hash_passcode.py — see README

const STAGE_LABELS = { 'PY1': 'PY1', 'M4-12': 'Y1 (F4-12)', 'Discontinued': 'Discontinued', 'F3M': 'F3M', 'Quality Issue': 'Quality Issue (unassigned)' };

let MAPPING = null;
let CURRENT = null; // currently rendered computed result
const LOCAL_HISTORY_KEY = 'cdc_bonus_history_v1';

// ---------- Auth (local convenience gate only — see note above) ----------
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function tryLogin() {
  const val = document.getElementById('passcodeInput').value;
  const errEl = document.getElementById('authError');
  errEl.textContent = '';

  // Preferred path: real server-side check (see api/login.js). The
  // secret this compares against never reaches the browser.
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: val }),
    });
    if (res.ok) { document.getElementById('authGate').style.display = 'none'; return; }
    if (res.status === 401) { errEl.textContent = 'Incorrect passcode.'; return; }
    // any other status (e.g. 500 not configured) -> fall through to local check
  } catch (e) { /* API not deployed (e.g. local static preview) -> fall through */ }

  // Fallback for local testing only -- NOT secure, see file header note.
  const hash = await sha256(val);
  if (hash === PASSCODE_HASH && PASSCODE_HASH !== 'REPLACE_WITH_SHA256_HASH') {
    sessionStorage.setItem('cdc_authed', '1');
    document.getElementById('authGate').style.display = 'none';
  } else {
    errEl.textContent = 'Incorrect passcode.';
  }
}
function logout() {
  sessionStorage.removeItem('cdc_authed');
  location.reload();
}
(function checkSession() {
  if (sessionStorage.getItem('cdc_authed') === '1') {
    document.getElementById('authGate').style.display = 'none';
  }
})();

// ---------- Number parsing (mirrors scripts/process_month.py) ----------
function cleanNumber(x) {
  if (x === null || x === undefined) return 0;
  x = String(x).trim().replace(/\u00a0/g, '').replace(/ /g, '');
  if (x === '' || x === '-') return 0;
  if (x.includes(',') && (x.match(/,/g) || []).length === 1) {
    x = x.replace(/\./g, '').replace(',', '.');
  } else {
    x = x.replace(/,/g, '');
  }
  const n = parseFloat(x);
  return isNaN(n) ? 0 : n;
}
function fmtEUR(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}
function fmtInt(n) {
  if (n === null || n === undefined) return '—';
  return Math.round(n).toLocaleString('de-DE');
}

// ---------- Load mapping + month list on boot ----------
async function boot() {
  MAPPING = await fetch('toc_mapping.json').then(r => r.json());
  await refreshMonthList();
}
async function refreshMonthList() {
  const sel = document.getElementById('monthSelect');
  sel.innerHTML = '';
  const months = new Set();

  // Known seeded month (shipped with this build)
  months.add('2026-08');

  // Locally saved months (client-only persistence fallback)
  const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
  Object.keys(local).forEach(m => months.add(m));

  // Server-persisted months, if the API is deployed
  try {
    const list = await fetch('/api/data?list=1').then(r => r.ok ? r.json() : null);
    if (list && list.months) list.months.forEach(m => months.add(m));
  } catch (e) { /* API not deployed — fine, local/seed months still work */ }

  Array.from(months).sort().reverse().forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    sel.appendChild(opt);
  });
  if (sel.options.length) { sel.value = sel.options[0].value; onMonthChange(); }
}

async function onMonthChange() {
  const month = document.getElementById('monthSelect').value;
  const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
  let data = local[month];
  if (!data) {
    try { data = await fetch(`/api/data?month=${month}`).then(r => r.ok ? r.json() : null); } catch (e) {}
  }
  if (!data) {
    try { data = await fetch(`data/${month}.json`).then(r => r.ok ? r.json() : null); } catch (e) {}
  }
  if (data) render(data);
}

// ---------- CSV upload + client-side computation ----------
const dropZone = document.getElementById('dropZone');
['dragenter', 'dragover'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', e => { if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });
document.getElementById('fileInput').addEventListener('change', e => { if (e.target.files.length) handleFile(e.target.files[0]); });

function handleFile(file) {
  const statusEl = document.getElementById('uploadStatus');
  statusEl.innerHTML = `<div class="banner info">Parsing ${file.name}…</div>`;
  Papa.parse(file, {
    header: true,
    delimiter: ';',
    encoding: 'utf-8',
    skipEmptyLines: true,
    complete: (results) => {
      try {
        const monthVal = document.getElementById('monthPicker').value || guessMonthFromFilename(file.name);
        const computed = computeFromRows(results.data, monthVal);
        statusEl.innerHTML = `<div class="banner info">Parsed ${results.data.length.toLocaleString()} rows for <b>${monthVal || 'this month'}</b>. Review below, then "Save to history" if it looks right.</div>`;
        render(computed);
      } catch (err) {
        statusEl.innerHTML = `<div class="banner error"><b>Couldn't process this file.</b> ${err.message}</div>`;
        console.error(err);
      }
    },
    error: (err) => {
      statusEl.innerHTML = `<div class="banner error"><b>Couldn't read this file.</b> ${err.message}</div>`;
    }
  });
}
function guessMonthFromFilename(name) {
  const m = name.match(/(\d{2})_(\d{2})_(\d{4})-\d{2}_\d{2}_\d{4}/);
  if (m) return `${m[3]}-${m[2]}`;
  return null;
}

function computeFromRows(rows, month) {
  const children = rows.filter(r => (r.SKU || '').trim() !== '');
  const byAsin = [];
  const unmapped = [];

  children.forEach(r => {
    const asin = (r.ASIN || '').trim();
    const info = MAPPING[asin];
    const rec = {
      asin, sku: (r.SKU || '').trim(), product: r.Product,
      units: cleanNumber(r.Units), sales: cleanNumber(r.Sales),
      net_profit: cleanNumber(r['Net profit']), margin_pct: cleanNumber(r.Margin),
      refunds: cleanNumber(r.Refunds),
    };
    if (!info) { unmapped.push(rec); return; }
    rec.brand = info.brand; rec.stage = info.stage; rec.status = info.status;
    byAsin.push(rec);
  });

  const stageTotals = {};
  const brandStage = {};
  function bump(obj, key, rec) {
    if (!obj[key]) obj[key] = { sales: 0, units: 0, net_profit: 0, sku_count: 0 };
    obj[key].sales += rec.sales; obj[key].units += rec.units;
    obj[key].net_profit += rec.net_profit; obj[key].sku_count += 1;
  }
  byAsin.forEach(rec => {
    bump(stageTotals, rec.stage, rec);
    bump(brandStage, `${rec.brand}||${rec.stage}`, rec);
  });

  const empty = () => ({ sales: 0, units: 0, net_profit: 0, sku_count: 0 });
  const rdPool = stageTotals['M4-12'] || empty();
  const launchPool = stageTotals['F3M'] || empty();
  const qualityIssue = stageTotals['Quality Issue'] || empty();

  const brands = Array.from(new Set(byAsin.map(r => r.brand))).sort();
  const brandManager = {};
  brands.forEach(b => {
    const stages = {};
    const combined = empty();
    ['PY1', 'M4-12', 'Discontinued'].forEach(stageKey => {
      const d = brandStage[`${b}||${stageKey}`] || empty();
      stages[STAGE_LABELS[stageKey]] = d;
      combined.sales += d.sales; combined.units += d.units;
      combined.net_profit += d.net_profit; combined.sku_count += d.sku_count;
    });
    brandManager[b] = { stages, combined };
  });

  return {
    month,
    rd_team: { label: 'R&D Team — Y1 products (pooled)', actual: rdPool, target: null, tier: 'AWAITING TARGET', bonus_eur: null },
    launch_manager: { label: 'Launch Manager — F3M', actual_combined: launchPool, actual_de: null, actual_pan_eu: null, target: null, tier: 'AWAITING TARGET + MARKETPLACE SPLIT', bonus_eur: null },
    brand_manager: Object.fromEntries(Object.entries(brandManager).map(([b, v]) => [b, { stages: v.stages, combined_actual: v.combined, target: null, tier: 'AWAITING TARGET', bonus_eur: null }])),
    marketplace: { label: 'Marketplace — manually entered', actual: null, target: null, tier: null, bonus_eur: null },
    quality_issue_unassigned: qualityIssue,
    meta: {
      total_rows_processed: children.length,
      mapped_rows: byAsin.length,
      unmapped_rows: unmapped.length,
      unmapped_asins: Array.from(new Set(unmapped.map(u => u.asin))).filter(Boolean).sort(),
    },
  };
}

// ---------- Rendering ----------
function tierTag(tier) {
  if (!tier) return '<span class="tier-tag pending">—</span>';
  if (tier.includes('GOLD')) return '<span class="tier-tag gold">🥇 GOLD</span>';
  if (tier.includes('GREEN')) return '<span class="tier-tag green">🟢 GREEN</span>';
  if (tier.includes('AWAITING')) return '<span class="tier-tag pending">awaiting target</span>';
  return '<span class="tier-tag miss">❌ MISS</span>';
}

function render(data) {
  CURRENT = data;

  // Data quality
  const dq = document.getElementById('dataQualitySection');
  const unmappedRev = 0; // revenue for unmapped rows isn't retained post-aggregation by design (see README)
  document.getElementById('dqSummary').textContent =
    `Data quality — ${data.meta.mapped_rows.toLocaleString()} SKUs mapped, ${data.meta.unmapped_rows} unmapped`;
  document.getElementById('dqBody').innerHTML = data.meta.unmapped_rows
    ? `<p>${data.meta.unmapped_rows} ASIN(s) in this export aren't in the TOC mapping yet, so their revenue is <b>excluded</b> from every track below rather than silently misassigned. Add them to the TOC "ASIN Report" tab and re-upload to include them.</p>
       <div>${data.meta.unmapped_asins.map(a => `<span class="asin-chip">${a}</span>`).join('')}</div>`
    : `<p>Every SKU in this export matched the TOC mapping.</p>`;
  dq.style.display = 'block';

  // Stats strip
  const bmTotalSales = Object.values(data.brand_manager).reduce((s, v) => s + v.combined_actual.sales, 0);
  document.getElementById('statStrip').innerHTML = `
    <div class="stat"><div class="label">R&D pool (Y1) actual</div><div class="value num">${fmtEUR(data.rd_team.actual.sales)}</div><div class="sub">${data.rd_team.actual.sku_count} SKUs</div></div>
    <div class="stat"><div class="label">Launch Mgr (F3M) actual</div><div class="value num">${fmtEUR(data.launch_manager.actual_combined.sales)}</div><div class="sub"><span class="pill pending">split pending</span></div></div>
    <div class="stat"><div class="label">Brand Manager total actual</div><div class="value num">${fmtEUR(bmTotalSales)}</div><div class="sub">${Object.keys(data.brand_manager).length} brands</div></div>
    <div class="stat"><div class="label">Quality Issue (unassigned)</div><div class="value num">${fmtEUR(data.quality_issue_unassigned.sales)}</div><div class="sub">${data.quality_issue_unassigned.sku_count} SKUs — no track owns this stage yet</div></div>
  `;
  document.getElementById('statsSection').style.display = 'block';

  // R&D
  document.getElementById('rdBody').innerHTML = `
    <tr><td class="name">Actual Revenue (€)</td><td class="num">${fmtEUR(data.rd_team.actual.sales)}</td>
        <td><input class="target-input" data-track="rd" data-field="green"></td>
        <td><input class="target-input" data-track="rd" data-field="gold"></td>
        <td>${tierTag(data.rd_team.tier)}</td></tr>
    <tr><td class="name">Units</td><td class="num">${fmtInt(data.rd_team.actual.units)}</td><td></td><td></td><td></td></tr>
    <tr><td class="name">Net Profit (€)</td><td class="num">${fmtEUR(data.rd_team.actual.net_profit)}</td><td></td><td></td><td></td></tr>
  `;
  document.getElementById('rdSection').style.display = 'block';

  // Launch Manager
  document.getElementById('launchBody').innerHTML = `
    <tr><td class="name">Actual Revenue (€)</td><td class="num">${fmtEUR(data.launch_manager.actual_combined.sales)}</td></tr>
    <tr><td class="name">Units</td><td class="num">${fmtInt(data.launch_manager.actual_combined.units)}</td></tr>
    <tr><td class="name">Net Profit (€)</td><td class="num">${fmtEUR(data.launch_manager.actual_combined.net_profit)}</td></tr>
  `;
  document.getElementById('launchSection').style.display = 'block';

  // Brand Manager
  const bmRows = Object.entries(data.brand_manager).sort((a, b) => b[1].combined_actual.sales - a[1].combined_actual.sales);
  document.getElementById('bmBody').innerHTML = bmRows.map(([brand, v]) => `
    <tr>
      <td class="name">${brand}</td>
      <td class="num">${fmtEUR(v.stages['PY1']?.sales || 0)}</td>
      <td class="num">${fmtEUR(v.stages['Y1 (F4-12)']?.sales || 0)}</td>
      <td class="num">${fmtEUR(v.stages['Discontinued']?.sales || 0)}</td>
      <td class="num">${fmtEUR(v.combined_actual.sales)}</td>
      <td><input class="target-input" data-track="bm" data-brand="${brand}" data-field="green"></td>
      <td><input class="target-input" data-track="bm" data-brand="${brand}" data-field="gold"></td>
      <td>${tierTag(v.tier)}</td>
    </tr>
  `).join('');
  document.getElementById('bmTotal').textContent = fmtEUR(bmTotalSales);
  document.getElementById('bmSection').style.display = 'block';

  // Marketplace manual
  document.getElementById('mpSection').style.display = 'block';

  // Chart
  document.getElementById('chartSection').style.display = 'block';
  const ctx = document.getElementById('brandChart');
  if (window._brandChart) window._brandChart.destroy();
  window._brandChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: bmRows.map(([b]) => b),
      datasets: [{ label: 'Actual revenue (€)', data: bmRows.map(([, v]) => v.combined_actual.sales), backgroundColor: '#D97757', borderRadius: 6 }]
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });

  document.getElementById('monthPicker').value = (data.month || '').length === 7 ? data.month : '';
}

// ---------- Save month (server if deployed, else localStorage) ----------
async function saveMonth() {
  if (!CURRENT) return;
  const statusEl = document.getElementById('saveStatus');
  try {
    const res = await fetch('/api/save-month', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CURRENT),
    });
    if (res.ok) {
      statusEl.textContent = `Saved "${CURRENT.month}" to the repo.`;
      await refreshMonthList();
      return;
    }
    throw new Error('API not available');
  } catch (e) {
    const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
    local[CURRENT.month] = CURRENT;
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(local));
    statusEl.textContent = `Saved "${CURRENT.month}" locally in this browser only (API not deployed — see README to persist to GitHub for everyone).`;
    await refreshMonthList();
  }
}

boot();
