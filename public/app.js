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

// TOC brand names sometimes differ in case/styling from the calculator's
// brand names (e.g. "NASSWERK" vs "Nasswerk"). Normalize for matching.
function normBrand(b) { return (b || '').trim().toLowerCase(); }

// The Brand Manager bonus track covers exactly these 9 brands, grouped
// under 4 supervisors -- confirmed against the calculator's All Tracks
// tab section banners (rows 26-58: "BM1 (Ilwyn)", "BM2 (Jico)", etc.).
// Supervisor names are kept here for reference but not shown in the UI
// (group labels display as just "BM1", "BM2", etc.).
// Any OTHER brand in the TOC/sales data (the company sells more brands
// than these 9) is NOT part of this bonus program and must not be
// silently folded in as if it were.
const BM_GROUPS = {
  'BM1': ['Tarpofix', 'Darwin', 'Planenfux'],   // Ilwyn
  'BM2': ['Heimfleiss', 'Mattenheld'],           // Jico
  'BM3': ['PD'],                                 // Camille
  'BM4': ['Nasswerk', 'PoolLöwe', 'TeichHeld'],  // Michael
};
const OFFICIAL_BM_BRANDS = Object.values(BM_GROUPS).flat();
function officialBrandGroup(brandName) {
  const nb = normBrand(brandName);
  for (const [group, brands] of Object.entries(BM_GROUPS)) {
    if (brands.some(b => normBrand(b) === nb)) return group;
  }
  return null;
}

let MAPPING = null;     // ASIN -> {brand, stage, product_code, ...}
let TARGETS = null;     // quarterly targets + rates/weights, from the calculator workbook (fallback: quarterly ÷ 3)
let MONTHLY_TARGETS = {}; // month ("2026-08") -> real Good/Better/Best targets, when extracted for that month
let MARKETPLACE_MAP = null; // ASIN -> "DE" | "Pan-EU", from Sellerboard's Products export (see scripts/build_marketplace_mapping.py)
let CURRENT = null;   // currently rendered computed result
const LOCAL_HISTORY_KEY = 'cdc_bonus_history_v2';

function quarterOf(month) { // "2026-08" -> "Q3"
  const m = parseInt(month.slice(5, 7), 10);
  return 'Q' + (Math.floor((m - 1) / 3) + 1);
}
function monthsInQuarter(month) {
  const year = month.slice(0, 4);
  const q = quarterOf(month);
  const startMonth = { Q1: 1, Q2: 4, Q3: 7, Q4: 10 }[q];
  return [0, 1, 2].map(i => `${year}-${String(startMonth + i).padStart(2, '0')}`);
}

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
  fetch('/api/logout', { method: 'POST' }).catch(() => {}).finally(() => location.reload());
}
async function checkSession() {
  // Preferred: ask the server whether the real (HttpOnly cookie) session
  // is still valid -- this is what makes "stay logged in across a
  // refresh" actually work, since the server-side login flow never
  // touches sessionStorage.
  try {
    const res = await fetch('/api/session');
    if (res.ok) { document.getElementById('authGate').style.display = 'none'; return; }
    if (res.status === 401) return; // definitively logged out server-side
  } catch (e) { /* API not deployed -- fall through to local-only check */ }

  // Fallback for local testing only -- NOT secure, see file header note.
  if (sessionStorage.getItem('cdc_authed') === '1') {
    document.getElementById('authGate').style.display = 'none';
  }
}
checkSession();

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
  return '€' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  if (n === null || n === undefined) return '—';
  return Math.round(n).toLocaleString('en-US');
}
function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  return (n * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}

// ---------- Load mapping + targets + month list on boot ----------
async function boot() {
  [MAPPING, TARGETS, MARKETPLACE_MAP] = await Promise.all([
    fetch('toc_mapping.json').then(r => r.json()),
    fetch('targets.json').then(r => r.json()),
    fetch('marketplace_mapping.json').then(r => r.ok ? r.json() : { mapping: {} }).then(d => d.mapping),
  ]);
  await refreshMonthList();
}
async function loadMonthlyTargets(month) {
  if (MONTHLY_TARGETS[month] !== undefined) return MONTHLY_TARGETS[month]; // cached (incl. cached "null" = none available)
  try {
    const r = await fetch(`targets_monthly/${month}.json`);
    MONTHLY_TARGETS[month] = r.ok ? await r.json() : null;
  } catch (e) { MONTHLY_TARGETS[month] = null; }
  return MONTHLY_TARGETS[month];
}
function updateTargetsNote(month, usedReal) {
  document.getElementById('targetsNote').textContent = usedReal
    ? `Targets for ${month}: real Good/Better/Best from BM Scorecard 3 & Leadership Scorecard 3 (Better = Green, Best = Gold).`
    : `Targets for ${month}: no real monthly extract yet — using ${TARGETS.source_quarter} quarterly target ÷ 3 (interim).`;
}
async function refreshMonthList() {
  const sel = document.getElementById('monthSelect');
  sel.innerHTML = '';
  const months = new Set();
  months.add('2026-08'); months.add('2026-07');
  const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
  Object.keys(local).forEach(m => months.add(m));
  try {
    const list = await fetch('/api/data?list=1').then(r => r.ok ? r.json() : null);
    if (list && list.months) list.months.forEach(m => months.add(m));
  } catch (e) {}
  Array.from(months).sort().reverse().forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    sel.appendChild(opt);
  });
  if (sel.options.length) { sel.value = sel.options[0].value; await onMonthChange(); }
}

async function loadMonth(month) {
  // Server (shared, GitHub-backed) is the source of truth whenever the API
  // is deployed and working -- everyone sees the same data from here.
  try {
    const r = await fetch(`/api/data?month=${month}`);
    if (r.ok) return await r.json();
  } catch (e) { /* API not deployed/reachable -- fall through */ }

  // Fallback 1: this browser's own local save (only relevant if the API
  // was unavailable when "Save to history" was clicked -- single-browser
  // only, never seen by anyone else).
  const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
  if (local[month]) return local[month];

  // Fallback 2: the static seed file bundled with the site (shared by
  // everyone, but only updates when the whole site is redeployed).
  try {
    const r = await fetch(`data/${month}.json`);
    if (r.ok) return await r.json();
  } catch (e) {}

  return null;
}

async function onMonthChange() {
  const month = document.getElementById('monthSelect').value;
  const data = await loadMonth(month);
  if (data) {
    // Always re-apply the LATEST targets on load (not whatever was baked
    // in when this month was saved) -- so adding a real monthly-target
    // extract later automatically upgrades a previously-saved month too.
    CURRENT = applyTargetsAndTiers(data, false, await loadMonthlyTargets(month));
    render(CURRENT, 'monthly');
    if (document.getElementById('tabQuarterly').style.display !== 'none') await renderQuarterlyTab();
  }
}

function setTab(t) {
  document.getElementById('tabUpload').style.display = t === 'upload' ? 'block' : 'none';
  document.getElementById('tabMonthly').style.display = t === 'monthly' ? 'block' : 'none';
  document.getElementById('tabQuarterly').style.display = t === 'quarterly' ? 'block' : 'none';
  document.getElementById('tabImpact').style.display = t === 'impact' ? 'block' : 'none';
  document.getElementById('tabUploadBtn').classList.toggle('active', t === 'upload');
  document.getElementById('tabMonthlyBtn').classList.toggle('active', t === 'monthly');
  document.getElementById('tabQuarterlyBtn').classList.toggle('active', t === 'quarterly');
  document.getElementById('tabImpactBtn').classList.toggle('active', t === 'impact');
  if (t === 'quarterly') renderQuarterlyTab();
}

// ---------- Quarterly tab: sum of each month's ALREADY-COMPUTED bonus ----------
// Deliberately NOT a target-vs-actual comparison at the quarter level --
// just adds up whatever bonus each month already earned, per row.
async function renderQuarterlyTab() {
  if (!CURRENT) return;
  const months = monthsInQuarter(CURRENT.month);
  const monthData = await Promise.all(months.map(async m => {
    const d = await loadMonth(m);
    if (!d) return null;
    return applyTargetsAndTiers(d, false, await loadMonthlyTargets(m));
  }));
  const present = months.filter((m, i) => monthData[i]);

  const note = document.getElementById('quarterlyNote');
  if (present.length < months.length) {
    note.style.display = 'flex';
    note.querySelector('span:last-child').innerHTML =
      `<b>Partial quarter.</b> ${present.length} of 3 months have data (${present.join(', ') || 'none'}). Totals below only include months that have been uploaded and saved.`;
  } else {
    note.style.display = 'none';
  }

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabels = months.map(m => MONTH_NAMES[parseInt(m.slice(5, 7), 10) - 1]);
  ['qRdM1Header', 'qRdM2Header', 'qRdM3Header', 'qLmM1Header', 'qLmM2Header', 'qLmM3Header', 'qBmM1Header', 'qBmM2Header', 'qBmM3Header'].forEach((id, i) => {
    document.getElementById(id).textContent = monthLabels[i % 3];
  });

  const sum3 = (vals) => {
    const known = vals.filter(v => v != null);
    if (!known.length) return null;
    return known.reduce((s, v) => s + v, 0);
  };

  // ---- R&D ----
  const rdCodes = new Set();
  monthData.forEach(d => { if (d) Object.keys(d.rd_team.rows).forEach(c => rdCodes.add(c)); });
  let rdHtml = '';
  let rdTotals = [0, 0, 0];
  let rdGrandTotal = 0;
  Array.from(rdCodes).sort().forEach(code => {
    const label = (monthData.find(d => d && d.rd_team.rows[code]) || {}).rd_team?.rows[code]?.label || code;
    const perMonth = monthData.map(d => d && d.rd_team.rows[code] ? d.rd_team.rows[code].bonus_eur : null);
    const total = sum3(perMonth);
    perMonth.forEach((v, i) => { if (v != null) rdTotals[i] += v; });
    if (total != null) rdGrandTotal += total;
    rdHtml += `<tr><td class="name">${label}</td>${perMonth.map(v => `<td class="num">${v != null ? fmtEUR(v) : '—'}</td>`).join('')}<td class="num">${fmtEUR(total)}</td></tr>`;
  });
  document.getElementById('qRdBody').innerHTML = rdHtml;
  document.getElementById('qRdTotalRow').innerHTML = `<td>Total</td>${rdTotals.map(v => `<td class="num">${fmtEUR(v)}</td>`).join('')}<td class="num">${fmtEUR(rdGrandTotal)}</td>`;

  // ---- Launch Manager ----
  const launchRows = [
    { label: 'Germany', get: d => d.launch_manager.germany.bonus_eur },
    { label: 'Pan-EU', get: d => d.launch_manager.pan_eu.bonus_eur },
  ];
  let lmHtml = '';
  let lmTotals = [0, 0, 0];
  let lmGrandTotal = 0;
  launchRows.forEach(({ label, get }) => {
    const perMonth = monthData.map(d => d ? get(d) : null);
    const total = sum3(perMonth);
    perMonth.forEach((v, i) => { if (v != null) lmTotals[i] += v; });
    if (total != null) lmGrandTotal += total;
    lmHtml += `<tr><td class="name">${label}</td>${perMonth.map(v => `<td class="num">${v != null ? fmtEUR(v) : '—'}</td>`).join('')}<td class="num">${fmtEUR(total)}</td></tr>`;
  });
  document.getElementById('qLaunchBody').innerHTML = lmHtml;
  document.getElementById('qLaunchTotalRow').innerHTML = `<td>Total</td>${lmTotals.map(v => `<td class="num">${fmtEUR(v)}</td>`).join('')}<td class="num">${fmtEUR(lmGrandTotal)}</td>`;

  // ---- Brand Manager (same BM1-4 grouping as Monthly) ----
  let bmHtml = '';
  let bmGrandTotals = [0, 0, 0];
  let bmGrandTotal = 0;
  for (const [group, brands] of Object.entries(BM_GROUPS)) {
    const groupPerMonth = monthData.map(d => {
      if (!d) return null;
      let s = 0, any = false;
      for (const b of brands) {
        const key = Object.keys(d.brand_manager).find(k => normBrand(k) === normBrand(b));
        if (key) { s += d.brand_manager[key].total_bonus || 0; any = true; }
      }
      return any ? s : null;
    });
    const groupTotal = sum3(groupPerMonth);
    groupPerMonth.forEach((v, i) => { if (v != null) bmGrandTotals[i] += v; });
    if (groupTotal != null) bmGrandTotal += groupTotal;
    bmHtml += `<tr class="bm-group-row"><td>${group}</td>${groupPerMonth.map(v => `<td class="num">${v != null ? fmtEUR(v) : '—'}</td>`).join('')}<td class="num">${fmtEUR(groupTotal)}</td></tr>`;

    for (const brandName of brands) {
      const brandPerMonth = monthData.map(d => {
        if (!d) return null;
        const key = Object.keys(d.brand_manager).find(k => normBrand(k) === normBrand(brandName));
        return key ? d.brand_manager[key].total_bonus : null;
      });
      const brandTotal = sum3(brandPerMonth);
      bmHtml += `<tr class="brand-row"><td class="name sub-brand">${brandName}</td>${brandPerMonth.map(v => `<td class="num">${v != null ? fmtEUR(v) : '—'}</td>`).join('')}<td class="num">${fmtEUR(brandTotal)}</td></tr>`;

      const stageLabels = ['PY1', 'Y1 (F4-12)', 'Discontinued'];
      stageLabels.forEach(stageLabel => {
        const stagePerMonth = monthData.map(d => {
          if (!d) return null;
          const key = Object.keys(d.brand_manager).find(k => normBrand(k) === normBrand(brandName));
          const sd = key ? d.brand_manager[key].stage_detail[stageLabel] : null;
          return sd ? sd.bonus_eur : null;
        });
        const stageTotal = sum3(stagePerMonth);
        bmHtml += `<tr class="stage-row"><td class="name sub">${stageLabel}</td>${stagePerMonth.map(v => `<td class="num">${v != null ? fmtEUR(v) : '—'}</td>`).join('')}<td class="num">${fmtEUR(stageTotal)}</td></tr>`;
      });
    }
  }
  document.getElementById('qBmBody').innerHTML = bmHtml;
  document.getElementById('qBmTotalRow').innerHTML = `<td>Total, all brands</td>${bmGrandTotals.map(v => `<td class="num">${fmtEUR(v)}</td>`).join('')}<td class="num">${fmtEUR(bmGrandTotal)}</td>`;
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
    header: true, delimiter: ';', encoding: 'utf-8', skipEmptyLines: true,
    complete: async (results) => {
      try {
        // Auto-detect the month from the filename first -- this is the
        // reliable signal (it's the actual date range Sellerboard exported).
        // The month picker is only a manual override for the rare file
        // whose name doesn't match the expected pattern; it must NOT
        // silently override a fresh detection with a stale leftover value
        // from a previous upload.
        const detected = guessMonthFromFilename(file.name);
        const monthVal = detected || document.getElementById('monthPicker').value;
        if (!monthVal) throw new Error("Couldn't detect the month from this filename, and no month is set in the picker. Set the month manually (top right of the upload box) and try again.");
        document.getElementById('monthPicker').value = monthVal; // reflect what's actually being used
        const computed = await computeFromRows(results.data, monthVal);
        const howDetected = detected ? `auto-detected from the filename` : `from the month picker (couldn't detect it from the filename)`;
        statusEl.innerHTML = `<div class="banner info">Parsed ${results.data.length.toLocaleString('en-US')} rows for <b>${monthVal}</b> (${howDetected}). Check the Monthly tab to review, then come back here and click "Save to history" if it looks right.</div>`;
        CURRENT = computed;
        render(CURRENT, 'monthly');
        if (document.getElementById('tabQuarterly').style.display !== 'none') await renderQuarterlyTab();
      } catch (err) {
        statusEl.innerHTML = `<div class="banner error"><b>Couldn't process this file.</b> ${err.message}</div>`;
        console.error(err);
      }
    },
    error: (err) => { statusEl.innerHTML = `<div class="banner error"><b>Couldn't read this file.</b> ${err.message}</div>`; }
  });
}
function guessMonthFromFilename(name) {
  const m = name.match(/(\d{2})_(\d{2})_(\d{4})-\d{2}_\d{2}_\d{4}/);
  if (m) return `${m[3]}-${m[2]}`;
  return null;
}

// Product-code matching: TOC codes like SLP120/SLP400 should both roll up
// under the calculator's "SLP" R&D target row. Try exact match first, then
// "target code is a prefix of the TOC code".
function matchRdCode(tocCode) {
  if (!tocCode) return null;
  if (TARGETS.rd_team[tocCode]) return tocCode;
  for (const targetCode of Object.keys(TARGETS.rd_team)) {
    if (tocCode.startsWith(targetCode)) return targetCode;
  }
  return null;
}

async function computeFromRows(rows, month) {
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
    rec.brand = info.brand; rec.stage = info.stage; rec.status = info.status; rec.product_code = info.product_code;
    byAsin.push(rec);
  });

  const empty = () => ({ sales: 0, units: 0, net_profit: 0, sku_count: 0 });
  const bump = (obj, key, rec) => {
    if (!obj[key]) obj[key] = empty();
    obj[key].sales += rec.sales; obj[key].units += rec.units;
    obj[key].net_profit += rec.net_profit; obj[key].sku_count += 1;
  };

  const stageTotals = {};
  const brandStage = {};
  const byProduct = {}; // R&D: keyed by matched target product code
  const launchByCountry = { DE: empty(), 'Pan-EU': empty() };
  const launchUnmappedMarketplace = []; // F3M-stage ASINs with no marketplace mapping -- kept visible, not silently dropped
  byAsin.forEach(rec => {
    bump(stageTotals, rec.stage, rec);
    bump(brandStage, `${rec.brand}||${rec.stage}`, rec);
    const rdCode = matchRdCode(rec.product_code);
    if (rdCode) bump(byProduct, rdCode, rec);
    if (rec.stage === 'F3M') {
      const country = MARKETPLACE_MAP ? MARKETPLACE_MAP[rec.asin] : null;
      if (country === 'DE' || country === 'Pan-EU') bump(launchByCountry, country, rec);
      else launchUnmappedMarketplace.push(rec.asin);
    }
  });

  const launchPool = stageTotals['F3M'] || empty();
  const qualityIssue = stageTotals['Quality Issue'] || empty();

  const brandsSeen = new Set(byAsin.map(r => normBrand(r.brand)));
  const brandDisplay = {}; // normalized -> original display name from TOC
  byAsin.forEach(r => { brandDisplay[normBrand(r.brand)] = r.brand; });
  // Union with the calculator's brand list so brands with zero August
  // actuals still show up (e.g. Darwin, TeichHeld some months).
  Object.keys(TARGETS.brand_manager).forEach(b => brandsSeen.add(normBrand(b)));

  const brandManager = {};
  const otherBrandsSeen = {}; // brands present in data but NOT in the official BM roster -- kept visible, never silently dropped
  brandsSeen.forEach(nb => {
    const displayName = OFFICIAL_BM_BRANDS.find(b => normBrand(b) === nb) || brandDisplay[nb] || nb;
    if (!officialBrandGroup(displayName)) {
      if (brandDisplay[nb]) { // only track brands that actually appear in THIS month's data, not phantom TARGETS entries
        const total = empty();
        // Only PY1/Y1/Discontinued here -- F3M and Quality Issue revenue
        // for this brand (if any) is already counted in the global
        // Launch Manager / Quality Issue buckets above, regardless of
        // brand, so including them here would double-count.
        ['PY1', 'M4-12', 'Discontinued'].forEach(stageKey => {
          const d = brandStage[`${brandDisplay[nb]}||${stageKey}`];
          if (d) { total.sales += d.sales; total.units += d.units; total.net_profit += d.net_profit; total.sku_count += d.sku_count; }
        });
        if (total.sku_count > 0) otherBrandsSeen[displayName] = total;
      }
      return; // not part of the Brand Manager bonus program
    }
    const stages = {};
    const combined = empty();
    ['PY1', 'M4-12', 'Discontinued'].forEach(stageKey => {
      const tocBrandName = brandDisplay[nb] || displayName;
      const d = brandStage[`${tocBrandName}||${stageKey}`] || empty();
      stages[STAGE_LABELS[stageKey]] = d;
      combined.sales += d.sales; combined.units += d.units; combined.net_profit += d.net_profit; combined.sku_count += d.sku_count;
    });
    brandManager[displayName] = { stages, combined_actual: combined, bm_group: officialBrandGroup(displayName) };
  });

  const result = {
    month,
    rd_team: { label: 'R&D Team — Y1 products (per product)', by_product: byProduct },
    launch_manager: {
      label: 'Launch Manager — F3M',
      actual_combined: launchPool,
      actual_germany: launchByCountry.DE,
      actual_pan_eu: launchByCountry['Pan-EU'],
      unmapped_marketplace_asins: Array.from(new Set(launchUnmappedMarketplace)).sort(),
    },
    brand_manager: brandManager,
    other_brands_unassigned: otherBrandsSeen, // brands with real revenue that AREN'T part of the Brand Manager bonus program (e.g. Van De Boos, MESSEREI, Arganoel Zauber) -- kept visible, not silently dropped
    marketplace: { label: 'Marketplace — manually entered' },
    quality_issue_unassigned: qualityIssue,
    meta: {
      total_rows_processed: children.length,
      mapped_rows: byAsin.length,
      unmapped_rows: unmapped.length,
      unmapped_asins: Array.from(new Set(unmapped.map(u => u.asin))).filter(Boolean).sort(),
    },
  };
  return applyTargetsAndTiers(result, false, await loadMonthlyTargets(month));
}

// ---------- Tiering (mirrors the calculator's IF/AND GOLD/GREEN/MISS logic) ----------
function tierOf(actualRev, greenRev, goldRev, actualMargin, greenMargin, goldMargin, gate) {
  if (greenRev == null || goldRev == null) return 'AWAITING TARGET';
  if (!actualRev || greenRev === 0 || goldRev === 0) return '-';
  const gateOk = gate == null || gate === '✅ PASS';
  const marginOk = (target) => target == null || actualMargin == null || actualMargin >= target;
  if (actualRev >= goldRev && marginOk(goldMargin) && gateOk) return '🥇 GOLD';
  if (actualRev >= greenRev && marginOk(greenMargin) && gateOk) return '🟢 GREEN';
  return '❌ MISS';
}
function bonusOf(tier, actualRev, greenRev, goldRev, greenRate, goldRate) {
  if (tier === '🥇 GOLD') return Math.max(0, actualRev - goldRev) * goldRate;
  if (tier === '🟢 GREEN') return Math.max(0, actualRev - greenRev) * greenRate;
  return 0;
}

// Attach target/tier/bonus fields onto a computed result.
// - Monthly view (isQuarterly=false): uses real Good/Better/Best targets
//   for `data.month` when available (monthlyTargets param; Better=Green,
//   Best=Gold), falling back to quarterly-target/3 per row where a real
//   monthly figure doesn't exist yet.
// - Quarterly view (isQuarterly=true): uses the full quarterly target
//   (real monthly targets aren't summed into a quarter here yet).
function applyTargetsAndTiers(data, isQuarterly, monthlyTargets) {
  const rates = TARGETS.rates;
  const mt = (!isQuarterly && monthlyTargets) ? monthlyTargets : null;

  // R&D
  const rdRows = {};
  const allCodes = new Set([
    ...Object.keys(TARGETS.rd_team),
    ...(mt ? Object.keys(mt.rd_team || {}) : []),
    ...Object.keys(data.rd_team.by_product || {}),
  ]);
  allCodes.forEach(code => {
    const t = TARGETS.rd_team[code];
    const m = mt ? mt.rd_team[code] : null;
    const actual = (data.rd_team.by_product || {})[code] || { sales: 0, units: 0, net_profit: 0, sku_count: 0 };
    let green, gold, label, source;
    if (m && m.revenue && m.revenue.better != null && m.revenue.best != null) {
      green = m.revenue.better; gold = m.revenue.best; label = m.label; source = 'real';
    } else {
      green = t ? (isQuarterly ? t.quarter_green_rev : t.monthly_green_rev) : null;
      gold = t ? (isQuarterly ? t.quarter_gold_rev : t.monthly_gold_rev) : null;
      label = t ? t.label : (m ? m.label : code); source = 'estimated';
    }
    // No margin target exists for R&D yet (neither in the Excel nor the
    // monthly extract) -- per instruction, the margin gate is assumed to
    // PASS when there's no target to compare against (tierOf already
    // treats a null margin target this way). Actual margin is still
    // computed and shown, so the number isn't hidden just because there's
    // nothing to grade it against yet.
    const actualMargin = actual.sales ? actual.net_profit / actual.sales : null;
    const tier = tierOf(actual.sales, green, gold, actualMargin, null, null, t ? t.gate : null);
    const bonus = bonusOf(tier, actual.sales, green, gold, rates.rd_team.green, rates.rd_team.gold);
    rdRows[code] = {
      label, actual, green_target: green, gold_target: gold, tier, bonus_eur: bonus, target_source: source,
      actual_margin_pct: actualMargin, green_margin_pct: null, gold_margin_pct: null,
    };
  });
  data.rd_team.rows = rdRows;
  data.rd_team.total_bonus = Object.values(rdRows).reduce((s, r) => s + r.bonus_eur, 0);

  // Launch Manager -- now computed PER COUNTRY using real actuals (joined
  // by ASIN against Sellerboard's Products export, see
  // scripts/build_marketplace_mapping.py), not an approximation.
  const lt = TARGETS.launch_manager;
  const mLm = mt ? mt.launch_manager : null;
  function launchTarget(quarterlyObj, monthlyObj) {
    if (monthlyObj && monthlyObj.revenue && monthlyObj.revenue.better != null && monthlyObj.revenue.best != null) {
      return {
        green: monthlyObj.revenue.better, gold: monthlyObj.revenue.best,
        green_margin: monthlyObj.profit_margin ? monthlyObj.profit_margin.better : null,
        gold_margin: monthlyObj.profit_margin ? monthlyObj.profit_margin.best : null,
        source: 'real',
      };
    }
    return {
      green: isQuarterly ? quarterlyObj.quarter_green_rev : quarterlyObj.monthly_green_rev,
      gold: isQuarterly ? quarterlyObj.quarter_gold_rev : quarterlyObj.monthly_gold_rev,
      green_margin: quarterlyObj.green_margin_pct, gold_margin: quarterlyObj.gold_margin_pct,
      source: 'estimated',
    };
  }
  const deT = launchTarget(lt.germany, mLm ? mLm.germany : null);
  const euT = launchTarget(lt.pan_eu, mLm ? mLm.pan_eu : null);

  function countryResult(actualBucket, t, rateGreen, rateGold) {
    const actualMargin = actualBucket.sales ? actualBucket.net_profit / actualBucket.sales : null;
    const tier = tierOf(actualBucket.sales, t.green, t.gold, actualMargin, t.green_margin, t.gold_margin, null);
    const bonus = bonusOf(tier, actualBucket.sales, t.green, t.gold, rateGreen, rateGold);
    return { actual: actualBucket, target: t, actual_margin_pct: actualMargin, tier, bonus_eur: bonus };
  }
  const germanyResult = countryResult(data.launch_manager.actual_germany, deT, rates.launch_mgr_germany.green, rates.launch_mgr_germany.gold);
  const panEuResult = countryResult(data.launch_manager.actual_pan_eu, euT, rates.launch_mgr_pan_eu.green, rates.launch_mgr_pan_eu.gold);

  data.launch_manager.germany = germanyResult;
  data.launch_manager.pan_eu = panEuResult;
  data.launch_manager.germany_target = { green: deT.green, gold: deT.gold, green_margin: deT.green_margin, gold_margin: deT.gold_margin, source: deT.source };
  data.launch_manager.pan_eu_target = { green: euT.green, gold: euT.gold, green_margin: euT.green_margin, gold_margin: euT.gold_margin, source: euT.source };
  data.launch_manager.combined_bonus_eur = germanyResult.bonus_eur + panEuResult.bonus_eur;

  // Brand Manager (per stage, weighted rates)
  for (const [brand, v] of Object.entries(data.brand_manager)) {
    const bt = TARGETS.brand_manager[brand] || TARGETS.brand_manager[Object.keys(TARGETS.brand_manager).find(k => normBrand(k) === normBrand(brand))];
    const mBrandKey = mt ? Object.keys(mt.brand_manager || {}).find(k => normBrand(k) === normBrand(brand)) : null;
    const mBrand = mBrandKey ? mt.brand_manager[mBrandKey] : null;
    let brandBonus = 0;
    const stageDetail = {};
    for (const [stageLabel, actual] of Object.entries(v.stages)) {
      const st = bt ? bt[stageLabel] : null;
      const mSt = mBrand ? mBrand[stageLabel] : null;
      const weight = TARGETS.stage_weights[stageLabel];
      let green, gold, greenMargin, goldMargin, source;
      if (mSt && mSt.revenue && mSt.revenue.better != null && mSt.revenue.best != null) {
        green = mSt.revenue.better; gold = mSt.revenue.best;
        greenMargin = mSt.profit_margin ? mSt.profit_margin.better : null;
        goldMargin = mSt.profit_margin ? mSt.profit_margin.best : null;
        source = 'real';
      } else {
        green = st ? (isQuarterly ? st.quarter_green_rev : st.monthly_green_rev) : null;
        gold = st ? (isQuarterly ? st.quarter_gold_rev : st.monthly_gold_rev) : null;
        greenMargin = st ? st.green_margin_pct : null;
        goldMargin = st ? st.gold_margin_pct : null;
        source = 'estimated';
      }
      const actualMargin = actual.sales ? actual.net_profit / actual.sales : null;
      const tier = tierOf(actual.sales, green, gold, actualMargin, greenMargin, goldMargin, st ? st.gate : null);
      const effGreen = weight ? weight.eff_green : rates.brand_manager.green;
      const effGold = weight ? weight.eff_gold : rates.brand_manager.gold;
      const bonus = bonusOf(tier, actual.sales, green, gold, effGreen, effGold);
      brandBonus += bonus;
      stageDetail[stageLabel] = {
        actual, green_target: green, gold_target: gold, tier, bonus_eur: bonus, target_source: source,
        actual_margin_pct: actualMargin, green_margin_pct: greenMargin, gold_margin_pct: goldMargin,
      };
    }
    v.stage_detail = stageDetail;
    v.total_bonus = brandBonus;
    v.bm_group = v.bm_group || officialBrandGroup(brand);
  }
  // BM-group subtotals (BM1/Ilwyn, BM2/Jico, BM3/Camille, BM4/Michael) --
  // matches the calculator's own "BM# — BRAND BONUS" subtotal rows exactly.
  const bmGroupTotals = {};
  for (const [group, brands] of Object.entries(BM_GROUPS)) {
    let groupBonus = 0;
    let groupSales = 0;
    for (const b of brands) {
      const key = Object.keys(data.brand_manager).find(k => normBrand(k) === normBrand(b));
      if (key) { groupBonus += data.brand_manager[key].total_bonus || 0; groupSales += data.brand_manager[key].combined_actual.sales || 0; }
    }
    bmGroupTotals[group] = { brands, total_bonus: groupBonus, total_sales: groupSales };
  }
  data.bm_groups = bmGroupTotals;
  data.bm_grand_total_bonus = Object.values(bmGroupTotals).reduce((s, g) => s + g.total_bonus, 0);
  data._targets_meta = { quarter: TARGETS.source_quarter, is_quarterly_view: isQuarterly, used_real_monthly: !!mt };
  return data;
}

// ---------- Rendering ----------
function sourceTag(source) {
  return source === 'estimated' ? ' <span title="No real monthly target extracted yet — using quarterly target ÷ 3" style="color:var(--line-400); font-weight:400; font-size:9px;">(est.)</span>' : '';
}
function tierCellClass(tier) {
  if (tier === '🥇 GOLD') return 'tint-gold';
  if (tier === '🟢 GREEN') return 'tint-green';
  return '';
}
function tierTag(tier) {
  if (!tier) return '<span class="tier-tag pending">—</span>';
  if (tier === '🥇 GOLD') return '<span class="tier-tag gold">🥇 GOLD</span>';
  if (tier === '🟢 GREEN') return '<span class="tier-tag green">🟢 GREEN</span>';
  if (tier === 'AWAITING TARGET') return '<span class="tier-tag pending">awaiting target</span>';
  if (tier === '-') return '<span class="tier-tag pending">—</span>';
  return '<span class="tier-tag miss">❌ MISS</span>';
}

function render(data, viewLabel) {
  try {
    renderInner(data, viewLabel);
  } catch (err) {
    console.error('Render error:', err);
    const statusEl = document.getElementById('uploadStatus');
    statusEl.innerHTML = `<div class="banner error"><b>The dashboard hit an error while rendering this data.</b> ${err.message}. The data itself parsed fine — this is a display bug. Please share this message so it can be fixed.</div>` + statusEl.innerHTML;
  }
}

function renderInner(data, viewLabel) {
  document.getElementById('periodBadge').textContent = `${data.month} (monthly)`;
  updateTargetsNote(data.month, !!(data._targets_meta && data._targets_meta.used_real_monthly));

  // Data quality
  document.getElementById('dqSummary').textContent =
    `Data quality — ${data.meta.mapped_rows.toLocaleString('en-US')} SKUs mapped, ${data.meta.unmapped_rows} unmapped`;
  document.getElementById('dqBody').innerHTML = data.meta.unmapped_rows
    ? `<p>${data.meta.unmapped_rows} ASIN(s) in this export aren't in the TOC mapping yet, so their revenue is <b>excluded</b> from every track below rather than silently misassigned. Add them to the TOC "ASIN Report" tab and re-upload to include them.</p>
       <div>${data.meta.unmapped_asins.map(a => `<span class="asin-chip">${a}</span>`).join('')}</div>`
    : `<p>Every SKU in this export matched the TOC mapping.</p>`;
  document.getElementById('dataQualitySection').style.display = 'block';

  // Reveal every section up front — each block below fills in its own
  // content independently, so one section's bug can't blank out the rest.
  ['statsSection', 'rdSection', 'launchSection', 'bmSection', 'mpSection', 'chartSection'].forEach(id => document.getElementById(id).style.display = 'block');

  // ---- R&D ----
  try {
    const rdRows = Object.entries(data.rd_team.rows).sort((a, b) => (b[1].actual.sales) - (a[1].actual.sales));
    document.getElementById('rdBody').innerHTML = rdRows.map(([code, r]) => `
      <tr>
        <td class="name">${r.label}</td>
        <td class="num">${fmtEUR(r.actual.sales)}</td>
        <td class="num tint-green">${fmtEUR(r.green_target)}${sourceTag(r.target_source)}</td>
        <td class="num tint-gold">${fmtEUR(r.gold_target)}</td>
        <td class="num">${fmtPct(r.actual_margin_pct)}</td>
        <td class="num tint-green">${fmtPct(r.green_margin_pct)}</td>
        <td class="num tint-gold">${fmtPct(r.gold_margin_pct)}</td>
        <td>${tierTag(r.tier)}</td>
        <td class="num ${tierCellClass(r.tier)}">${fmtEUR(r.bonus_eur)}</td>
      </tr>
    `).join('');
    document.getElementById('rdTotalBonus').textContent = fmtEUR(data.rd_team.total_bonus);
    document.getElementById('rdTeamSize').textContent = TARGETS.rates.rd_team.team_size;
    document.getElementById('rdPerPerson').textContent = fmtEUR(data.rd_team.total_bonus / TARGETS.rates.rd_team.team_size);
  } catch (err) { console.error('R&D section error:', err); document.getElementById('rdBody').innerHTML = `<tr><td colspan="9" class="name">Couldn't render this section: ${err.message}</td></tr>`; }

  // ---- Launch Manager ----
  let lm;
  try {
    lm = data.launch_manager;
    document.getElementById('launchBody').innerHTML = `
      <tr>
        <td class="name">Germany</td>
        <td class="num">${fmtEUR(lm.germany.actual.sales)}</td>
        <td class="num tint-green">${fmtEUR(lm.germany_target.green)}${sourceTag(lm.germany_target.source)}</td>
        <td class="num tint-gold">${fmtEUR(lm.germany_target.gold)}</td>
        <td class="num">${fmtPct(lm.germany.actual_margin_pct)}</td>
        <td class="num tint-green">${fmtPct(lm.germany_target.green_margin)}</td>
        <td class="num tint-gold">${fmtPct(lm.germany_target.gold_margin)}</td>
        <td>${tierTag(lm.germany.tier)}</td>
        <td class="num ${tierCellClass(lm.germany.tier)}">${fmtEUR(lm.germany.bonus_eur)}</td>
      </tr>
      <tr>
        <td class="name">PAN EU</td>
        <td class="num">${fmtEUR(lm.pan_eu.actual.sales)}</td>
        <td class="num tint-green">${fmtEUR(lm.pan_eu_target.green)}${sourceTag(lm.pan_eu_target.source)}</td>
        <td class="num tint-gold">${fmtEUR(lm.pan_eu_target.gold)}</td>
        <td class="num">${fmtPct(lm.pan_eu.actual_margin_pct)}</td>
        <td class="num tint-green">${fmtPct(lm.pan_eu_target.green_margin)}</td>
        <td class="num tint-gold">${fmtPct(lm.pan_eu_target.gold_margin)}</td>
        <td>${tierTag(lm.pan_eu.tier)}</td>
        <td class="num ${tierCellClass(lm.pan_eu.tier)}">${fmtEUR(lm.pan_eu.bonus_eur)}</td>
      </tr>
      <tr class="total-row-solid">
        <td class="name">Combined</td>
        <td class="num">${fmtEUR(lm.actual_combined.sales)}</td>
        <td class="num">${fmtEUR(lm.germany_target.green + lm.pan_eu_target.green)}</td>
        <td class="num">${fmtEUR(lm.germany_target.gold + lm.pan_eu_target.gold)}</td>
        <td class="num">—</td><td class="num">—</td><td class="num">—</td>
        <td>—</td>
        <td class="num">${fmtEUR(lm.combined_bonus_eur)}</td>
      </tr>
    `;
    document.getElementById('launchNoteBonus').textContent =
      `Germany/Pan-EU split by ASIN, joined against Sellerboard's Products export marketplace field. Caveat: that field records where each ASIN's cost settings live (almost always Germany) — it isn't a true per-order sales channel log, so Pan-EU actuals may read close to €0 even in months with real Pan-EU sales, until a proper per-marketplace sales export is available.`;
    const dq = document.getElementById('launchMarketplaceDq');
    if (lm.unmapped_marketplace_asins && lm.unmapped_marketplace_asins.length) {
      dq.style.display = 'block';
      dq.innerHTML = `<span>⚠</span><span>${lm.unmapped_marketplace_asins.length} F3M ASIN(s) have no marketplace mapping and are excluded from the Germany/Pan-EU split above (still counted in "Combined"): ${lm.unmapped_marketplace_asins.map(a => `<span class="asin-chip">${a}</span>`).join('')}</span>`;
    } else {
      dq.style.display = 'none';
    }
  } catch (err) { console.error('Launch section error:', err); document.getElementById('launchBody').innerHTML = `<tr><td colspan="9" class="name">Couldn't render this section: ${err.message}</td></tr>`; }

  // ---- Brand Manager (grouped by BM1-4 supervisor, per calculator structure) ----
  let bmRows = [];
  let bmTotalBonus = 0;
  try {
    bmTotalBonus = data.bm_grand_total_bonus || 0;
    let bmHtml = '';
    for (const [group, groupData] of Object.entries(data.bm_groups || {})) {
      bmHtml += `<tr class="bm-group-row"><td class="name">${group}</td><td class="num">${fmtEUR(groupData.total_sales)}</td><td colspan="6"></td><td class="num">${fmtEUR(groupData.total_bonus)}</td></tr>`;
      for (const brandName of groupData.brands) {
        const key = Object.keys(data.brand_manager).find(k => normBrand(k) === normBrand(brandName));
        const v = key ? data.brand_manager[key] : null;
        if (!v) continue;
        bmRows.push([key, v]);
        bmHtml += `<tr class="brand-row"><td class="name sub-brand">${key}</td><td class="num">${fmtEUR(v.combined_actual.sales)}</td><td colspan="6"></td><td class="num">${fmtEUR(v.total_bonus)}</td></tr>`;
        for (const [stageLabel, sd] of Object.entries(v.stage_detail)) {
          bmHtml += `
            <tr class="stage-row">
              <td class="name sub">${stageLabel}</td>
              <td class="num">${fmtEUR(sd.actual.sales)}</td>
              <td class="num tint-green">${fmtEUR(sd.green_target)}${sourceTag(sd.target_source)}</td>
              <td class="num tint-gold">${fmtEUR(sd.gold_target)}</td>
              <td class="num">${fmtPct(sd.actual_margin_pct)}</td>
              <td class="num tint-green">${fmtPct(sd.green_margin_pct)}</td>
              <td class="num tint-gold">${fmtPct(sd.gold_margin_pct)}</td>
              <td>${tierTag(sd.tier)}</td>
              <td class="num ${tierCellClass(sd.tier)}">${fmtEUR(sd.bonus_eur)}</td>
            </tr>`;
        }
      }
    }
    document.getElementById('bmBody').innerHTML = bmHtml;
    document.getElementById('bmTotalBonus').textContent = fmtEUR(bmTotalBonus);
  } catch (err) { console.error('Brand Manager section error:', err); document.getElementById('bmBody').innerHTML = `<tr><td colspan="9" class="name">Couldn't render this section: ${err.message}</td></tr>`; }

  // ---- Stats strip ----
  try {
    document.getElementById('statStrip').innerHTML = `
      <div class="stat"><div class="label">R&D bonus pool</div><div class="value num">${fmtEUR(data.rd_team.total_bonus)}</div><div class="sub">÷ ${TARGETS.rates.rd_team.team_size} team members</div></div>
      <div class="stat"><div class="label">Launch Mgr bonus</div><div class="value num">${fmtEUR(lm ? lm.combined_bonus_eur : null)}</div><div class="sub">DE + Pan-EU</div></div>
      <div class="stat"><div class="label">Brand Manager total bonus</div><div class="value num">${fmtEUR(bmTotalBonus)}</div><div class="sub">${bmRows.length} brands</div></div>
      <div class="stat"><div class="label">Quality Issue (unassigned)</div><div class="value num">${fmtEUR(data.quality_issue_unassigned.sales)}</div><div class="sub">${data.quality_issue_unassigned.sku_count} SKUs — no track owns this stage</div></div>
    `;
  } catch (err) { console.error('Stats strip error:', err); }

  // ---- Chart (never let a charting failure affect anything else) ----
  try {
    const ctx = document.getElementById('brandChart');
    if (window._brandChart) window._brandChart.destroy();
    window._brandChart = new Chart(ctx, {
      type: 'bar',
      data: { labels: bmRows.map(([b]) => b), datasets: [{ label: 'Actual revenue (€)', data: bmRows.map(([, v]) => v.combined_actual.sales), backgroundColor: '#D97757', borderRadius: 6 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });
  } catch (err) { console.error('Chart error:', err); document.getElementById('chartSection').innerHTML = `<div class="banner error">Chart couldn't render: ${err.message}</div>`; }

  document.getElementById('monthPicker').value = (data.month || '').length === 7 ? data.month : '';

  try { renderImpactAnalysis(data); } catch (err) { console.error('Impact Analysis error:', err); }
}

// ---------- Impact Analysis: is the bonus framework pulling its weight? ----------
// For every role (R&D, Launch Manager) and every official Brand Manager
// brand: Growth % vs (Gold) Target, and Bonus % of Revenue, side by side.
// Gold is used as "the target" per the Variable Bonus Framework's own
// framing ("GOLD is the minimum expectation... all targets are based on
// GOLD targets").
function growthPct(actual, goldTarget) {
  if (!goldTarget) return null;
  return (actual - goldTarget) / goldTarget;
}
function bonusPctOfRevenue(bonus, actual) {
  if (!actual) return null;
  return bonus / actual;
}
function impactRow(label, actual, goldTarget, bonus) {
  return { label, actual, goldTarget, bonus, growth: growthPct(actual, goldTarget), bonusPct: bonusPctOfRevenue(bonus, actual) };
}
function growthPill(g) {
  if (g == null) return '<span class="growth-pill neutral">—</span>';
  const cls = g >= 0 ? 'positive' : 'negative';
  const sign = g >= 0 ? '+' : '';
  return `<span class="growth-pill ${cls}">${sign}${(g * 100).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</span>`;
}

function renderImpactAnalysis(data) {
  const rows = [];

  // R&D Team (pooled across all products with a real or estimated gold target)
  const rdEntries = Object.values(data.rd_team.rows || {});
  const rdActual = rdEntries.reduce((s, r) => s + r.actual.sales, 0);
  const rdGold = rdEntries.reduce((s, r) => s + (r.gold_target || 0), 0);
  rows.push({ section: 'R&D Team', row: impactRow('R&D Team (pooled)', rdActual, rdGold, data.rd_team.total_bonus) });

  // Launch Manager (combined approx.)
  const lm = data.launch_manager;
  rows.push({ section: 'Launch Manager', row: impactRow('Germany', lm.germany.actual.sales, lm.germany_target.gold, lm.germany.bonus_eur) });
  rows.push({ section: 'Launch Manager', row: impactRow('Pan-EU', lm.pan_eu.actual.sales, lm.pan_eu_target.gold, lm.pan_eu.bonus_eur) });

  // Every official Brand Manager brand, grouped
  for (const [group, groupData] of Object.entries(data.bm_groups || {})) {
    for (const brandName of groupData.brands) {
      const key = Object.keys(data.brand_manager || {}).find(k => normBrand(k) === normBrand(brandName));
      const v = key ? data.brand_manager[key] : null;
      if (!v) continue;
      const goldSum = Object.values(v.stage_detail || {}).reduce((s, sd) => s + (sd.gold_target || 0), 0);
      rows.push({ section: `Brand Manager — ${group}`, row: impactRow(key, v.combined_actual.sales, goldSum, v.total_bonus) });
    }
  }

  let html = '';
  let lastSection = null;
  for (const { section, row } of rows) {
    if (section !== lastSection) {
      html += `<tr class="impact-role-row"><td colspan="6">${section}</td></tr>`;
      lastSection = section;
    }
    html += `
      <tr>
        <td class="name" style="padding-left:24px;">${row.label}</td>
        <td class="num">${fmtEUR(row.actual)}</td>
        <td class="num">${fmtEUR(row.goldTarget)}</td>
        <td>${growthPill(row.growth)}</td>
        <td class="num">${fmtEUR(row.bonus)}</td>
        <td class="num"><span class="bonus-pct-badge">${row.bonusPct != null ? fmtPct(row.bonusPct) : '—'}</span></td>
      </tr>`;
  }
  document.getElementById('impactBody').innerHTML = html;
}

// ---------- Save month (server if deployed, else localStorage) ----------
async function saveMonth() {
  if (!CURRENT) return;
  const statusEl = document.getElementById('saveStatus');
  const toSave = CURRENT; // always save the raw monthly computation, not a merged quarterly view
  try {
    const res = await fetch('/api/save-month', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toSave),
    });
    if (res.ok) {
      statusEl.textContent = `Saved "${toSave.month}" to the repo — visible to everyone.`;
      // Clear any stale local-only copy now that the shared version is current.
      const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
      if (local[toSave.month]) { delete local[toSave.month]; localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(local)); }
      await refreshMonthList();
      return;
    }
    throw new Error('API not available');
  } catch (e) {
    const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
    local[toSave.month] = toSave;
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(local));
    statusEl.textContent = `Saved "${toSave.month}" locally in THIS BROWSER ONLY — other people will not see this until the API is deployed (see README).`;
    await refreshMonthList();
  }
}

boot();
