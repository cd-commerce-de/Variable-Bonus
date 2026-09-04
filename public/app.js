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

let MAPPING = null;     // ASIN -> {brand, stage, product_code, ...}
let TARGETS = null;     // quarterly targets + rates/weights, from the calculator workbook (fallback: quarterly ÷ 3)
let MONTHLY_TARGETS = {}; // month ("2026-08") -> real Good/Better/Best targets, when extracted for that month
let CURRENT = null;   // currently rendered computed result
let VIEW = 'monthly'; // 'monthly' | 'quarterly'
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
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}
function fmtInt(n) {
  if (n === null || n === undefined) return '—';
  return Math.round(n).toLocaleString('de-DE');
}

// ---------- Load mapping + targets + month list on boot ----------
async function boot() {
  [MAPPING, TARGETS] = await Promise.all([
    fetch('toc_mapping.json').then(r => r.json()),
    fetch('targets.json').then(r => r.json()),
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
  months.add('2026-08');
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
    await renderCurrentView();
  }
}

function setView(v) {
  VIEW = v;
  document.getElementById('viewMonthlyBtn').classList.toggle('active', v === 'monthly');
  document.getElementById('viewQuarterlyBtn').classList.toggle('active', v === 'quarterly');
  renderCurrentView();
}
function setTab(t) {
  document.getElementById('tabUpload').style.display = t === 'upload' ? 'block' : 'none';
  document.getElementById('tabDashboard').style.display = t === 'dashboard' ? 'block' : 'none';
  document.getElementById('tabUploadBtn').classList.toggle('active', t === 'upload');
  document.getElementById('tabDashboardBtn').classList.toggle('active', t === 'dashboard');
}

async function renderCurrentView() {
  if (!CURRENT) return;
  if (VIEW === 'monthly') {
    render(CURRENT, 'monthly');
  } else {
    // Quarterly: sum every saved month within the same quarter as CURRENT.month
    const qMonths = monthsInQuarter(CURRENT.month);
    const parts = await Promise.all(qMonths.map(loadMonth));
    const present = qMonths.filter((m, i) => parts[i]);
    const merged = await mergeMonths(parts.filter(Boolean));
    merged.month = CURRENT.month;
    merged._quarterMonthsPresent = present;
    merged._quarterMonthsExpected = qMonths;
    render(merged, 'quarterly');
  }
}

async function mergeMonths(list) {
  const addBucket = (a, b) => ({ sales: (a?.sales || 0) + (b?.sales || 0), units: (a?.units || 0) + (b?.units || 0), net_profit: (a?.net_profit || 0) + (b?.net_profit || 0), sku_count: Math.max(a?.sku_count || 0, b?.sku_count || 0) });
  if (!list.length) return await computeFromRows([], null);
  let out = JSON.parse(JSON.stringify(list[0]));
  for (let i = 1; i < list.length; i++) {
    const d = list[i];
    out.rd_team.by_product = mergeProductMaps(out.rd_team.by_product, d.rd_team.by_product);
    out.launch_manager.actual_combined = addBucket(out.launch_manager.actual_combined, d.launch_manager.actual_combined);
    out.quality_issue_unassigned = addBucket(out.quality_issue_unassigned, d.quality_issue_unassigned);
    for (const brand of Object.keys(d.brand_manager)) {
      if (!out.brand_manager[brand]) out.brand_manager[brand] = JSON.parse(JSON.stringify(d.brand_manager[brand]));
      else {
        for (const stage of Object.keys(d.brand_manager[brand].stages)) {
          out.brand_manager[brand].stages[stage] = addBucket(out.brand_manager[brand].stages[stage], d.brand_manager[brand].stages[stage]);
        }
        out.brand_manager[brand].combined_actual = addBucket(out.brand_manager[brand].combined_actual, d.brand_manager[brand].combined_actual);
      }
    }
    out.meta.total_rows_processed += d.meta.total_rows_processed;
    out.meta.mapped_rows += d.meta.mapped_rows;
    out.meta.unmapped_rows += d.meta.unmapped_rows;
    out.meta.unmapped_asins = Array.from(new Set([...out.meta.unmapped_asins, ...d.meta.unmapped_asins]));
  }
  return applyTargetsAndTiers(out, true);
}
function mergeProductMaps(a, b) {
  const out = JSON.parse(JSON.stringify(a || {}));
  for (const [code, v] of Object.entries(b || {})) {
    if (!out[code]) out[code] = JSON.parse(JSON.stringify(v));
    else { out[code].sales += v.sales; out[code].units += v.units; out[code].net_profit += v.net_profit; }
  }
  return out;
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
        const monthVal = document.getElementById('monthPicker').value || guessMonthFromFilename(file.name);
        if (!monthVal) throw new Error('Pick the month this export covers (top right of the upload box) before parsing.');
        const computed = await computeFromRows(results.data, monthVal);
        statusEl.innerHTML = `<div class="banner info">Parsed ${results.data.length.toLocaleString()} rows for <b>${monthVal}</b>. Check the Dashboard tab to review, then come back here and click "Save to history" if it looks right.</div>`;
        CURRENT = computed;
        renderCurrentView();
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
  byAsin.forEach(rec => {
    bump(stageTotals, rec.stage, rec);
    bump(brandStage, `${rec.brand}||${rec.stage}`, rec);
    const rdCode = matchRdCode(rec.product_code);
    if (rdCode) bump(byProduct, rdCode, rec);
  });

  const launchPool = stageTotals['F3M'] || empty();
  const qualityIssue = stageTotals['Quality Issue'] || empty();

  const brandsSeen = new Set(byAsin.map(r => normBrand(r.brand)));
  const brandDisplay = {}; // normalized -> original display name from TOC
  byAsin.forEach(r => { brandDisplay[normBrand(r.brand)] = r.brand; });
  // Union with calculator's brand list so brands with zero August actuals still show up
  Object.keys(TARGETS.brand_manager).forEach(b => brandsSeen.add(normBrand(b)));

  const brandManager = {};
  brandsSeen.forEach(nb => {
    const displayName = Object.keys(TARGETS.brand_manager).find(b => normBrand(b) === nb) || brandDisplay[nb] || nb;
    const stages = {};
    const combined = empty();
    ['PY1', 'M4-12', 'Discontinued'].forEach(stageKey => {
      const tocBrandName = brandDisplay[nb] || displayName;
      const d = brandStage[`${tocBrandName}||${stageKey}`] || empty();
      stages[STAGE_LABELS[stageKey]] = d;
      combined.sales += d.sales; combined.units += d.units; combined.net_profit += d.net_profit; combined.sku_count += d.sku_count;
    });
    brandManager[displayName] = { stages, combined_actual: combined };
  });

  const result = {
    month,
    rd_team: { label: 'R&D Team — Y1 products (per product)', by_product: byProduct },
    launch_manager: { label: 'Launch Manager — F3M', actual_combined: launchPool },
    brand_manager: brandManager,
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
    const tier = tierOf(actual.sales, green, gold, null, null, null, t ? t.gate : null);
    const bonus = bonusOf(tier, actual.sales, green, gold, rates.rd_team.green, rates.rd_team.gold);
    rdRows[code] = { label, actual, green_target: green, gold_target: gold, tier, bonus_eur: bonus, target_source: source };
  });
  data.rd_team.rows = rdRows;
  data.rd_team.total_bonus = Object.values(rdRows).reduce((s, r) => s + r.bonus_eur, 0);

  // Launch Manager (actual is combined-only; show DE/PanEU targets, and an
  // approximate combined tier against the summed DE+PanEU target)
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
  const cGreen = deT.green + euT.green;
  const cGold = deT.gold + euT.gold;
  const approxTier = tierOf(data.launch_manager.actual_combined.sales, cGreen, cGold, null, null, null, null);
  // Bonus rate: Config sets Germany (70% weight) and PAN EU (30% weight)
  // rates SEPARATELY (0.0035/0.007 and 0.0015/0.003) -- these already have
  // the weight baked in, and by construction sum back to the base
  // R&D/Marketplace rate (0.005/0.01). Since actuals can't be split by
  // country yet, the mathematically correct blended rate for an
  // approximate COMBINED bonus is the sum of the two weighted rates --
  // exactly equivalent to applying each country's own rate to its own
  // actual, in the case where actual splits the same 70/30 as target.
  const blendedGreenRate = rates.launch_mgr_germany.green + rates.launch_mgr_pan_eu.green;
  const blendedGoldRate = rates.launch_mgr_germany.gold + rates.launch_mgr_pan_eu.gold;
  const approxBonus = bonusOf(approxTier, data.launch_manager.actual_combined.sales, cGreen, cGold, blendedGreenRate, blendedGoldRate);
  data.launch_manager.germany_target = { green: deT.green, gold: deT.gold, source: deT.source };
  data.launch_manager.pan_eu_target = { green: euT.green, gold: euT.gold, source: euT.source };
  data.launch_manager.approx_combined_target = { green: cGreen, gold: cGold };
  data.launch_manager.approx_tier = approxTier;
  data.launch_manager.approx_bonus_eur = approxBonus;

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
      stageDetail[stageLabel] = { actual, green_target: green, gold_target: gold, tier, bonus_eur: bonus, target_source: source };
    }
    v.stage_detail = stageDetail;
    v.total_bonus = brandBonus;
  }
  data._targets_meta = { quarter: TARGETS.source_quarter, is_quarterly_view: isQuarterly, used_real_monthly: !!mt };
  return data;
}

// ---------- Rendering ----------
function sourceTag(source) {
  return source === 'estimated' ? ' <span title="No real monthly target extracted yet — using quarterly target ÷ 3" style="color:var(--line-400); font-weight:400; font-size:11px;">(est.)</span>' : '';
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
  const periodLabel = viewLabel === 'quarterly'
    ? `${quarterOf(data.month)} (quarterly)`
    : `${data.month} (monthly)`;
  document.getElementById('periodBadge').textContent = periodLabel;
  updateTargetsNote(data.month, !!(data._targets_meta && data._targets_meta.used_real_monthly));

  if (viewLabel === 'quarterly') {
    const present = data._quarterMonthsPresent || [];
    const expected = data._quarterMonthsExpected || [];
    const note = document.getElementById('quarterlyNote');
    if (present.length < expected.length) {
      note.style.display = 'flex';
      note.querySelector('span:last-child').innerHTML =
        `<b>Partial quarter.</b> ${present.length} of 3 months uploaded (${present.join(', ') || 'none'}). ` +
        `Actuals below are the sum of what's uploaded so far; targets are the full quarter target.`;
    } else {
      note.style.display = 'none';
    }
  } else {
    document.getElementById('quarterlyNote').style.display = 'none';
  }

  // Data quality
  document.getElementById('dqSummary').textContent =
    `Data quality — ${data.meta.mapped_rows.toLocaleString()} SKUs mapped, ${data.meta.unmapped_rows} unmapped`;
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
        <td class="num">${fmtEUR(r.green_target)}${sourceTag(r.target_source)}</td>
        <td class="num">${fmtEUR(r.gold_target)}</td>
        <td>${tierTag(r.tier)}</td>
        <td class="num">${fmtEUR(r.bonus_eur)}</td>
      </tr>
    `).join('');
    document.getElementById('rdTotalBonus').textContent = fmtEUR(data.rd_team.total_bonus);
    document.getElementById('rdTeamSize').textContent = TARGETS.rates.rd_team.team_size;
    document.getElementById('rdPerPerson').textContent = fmtEUR(data.rd_team.total_bonus / TARGETS.rates.rd_team.team_size);
  } catch (err) { console.error('R&D section error:', err); document.getElementById('rdBody').innerHTML = `<tr><td colspan="6" class="name">Couldn't render this section: ${err.message}</td></tr>`; }

  // ---- Launch Manager ----
  let lm;
  try {
    lm = data.launch_manager;
    document.getElementById('launchBody').innerHTML = `
      <tr><td class="name">Germany</td><td class="num">—</td><td class="num">${fmtEUR(lm.germany_target.green)}</td><td class="num">${fmtEUR(lm.germany_target.gold)}</td><td><span class="tier-tag pending">split pending</span></td><td class="num">—</td></tr>
      <tr><td class="name">PAN EU</td><td class="num">—</td><td class="num">${fmtEUR(lm.pan_eu_target.green)}</td><td class="num">${fmtEUR(lm.pan_eu_target.gold)}</td><td><span class="tier-tag pending">split pending</span></td><td class="num">—</td></tr>
      <tr style="background:var(--ember-subtle);"><td class="name">Combined (approx.)</td><td class="num">${fmtEUR(lm.actual_combined.sales)}</td><td class="num">${fmtEUR(lm.approx_combined_target.green)}</td><td class="num">${fmtEUR(lm.approx_combined_target.gold)}</td><td>${tierTag(lm.approx_tier)}</td><td class="num">${fmtEUR(lm.approx_bonus_eur)}</td></tr>
    `;
    document.getElementById('launchNoteBonus').textContent =
      `Bonus uses the blended rate (Germany + PAN EU Config rates, which already sum to the base rate) applied to the combined overflow — an approximation until actuals can be split by country.`;
  } catch (err) { console.error('Launch section error:', err); document.getElementById('launchBody').innerHTML = `<tr><td colspan="6" class="name">Couldn't render this section: ${err.message}</td></tr>`; }

  // ---- Brand Manager ----
  let bmRows = [];
  let bmTotalBonus = 0;
  try {
    bmRows = Object.entries(data.brand_manager).sort((a, b) => b[1].combined_actual.sales - a[1].combined_actual.sales);
    let bmHtml = '';
    bmRows.forEach(([brand, v]) => {
      bmTotalBonus += v.total_bonus || 0;
      bmHtml += `<tr class="brand-row"><td class="name">${brand}</td><td class="num">${fmtEUR(v.combined_actual.sales)}</td><td colspan="3"></td><td class="num">${fmtEUR(v.total_bonus)}</td></tr>`;
      for (const [stageLabel, sd] of Object.entries(v.stage_detail)) {
        bmHtml += `
          <tr class="stage-row">
            <td class="name sub">${stageLabel}</td>
            <td class="num">${fmtEUR(sd.actual.sales)}</td>
            <td class="num">${fmtEUR(sd.green_target)}${sourceTag(sd.target_source)}</td>
            <td class="num">${fmtEUR(sd.gold_target)}</td>
            <td>${tierTag(sd.tier)}</td>
            <td class="num">${fmtEUR(sd.bonus_eur)}</td>
          </tr>`;
      }
    });
    document.getElementById('bmBody').innerHTML = bmHtml;
    document.getElementById('bmTotalBonus').textContent = fmtEUR(bmTotalBonus);
  } catch (err) { console.error('Brand Manager section error:', err); document.getElementById('bmBody').innerHTML = `<tr><td colspan="6" class="name">Couldn't render this section: ${err.message}</td></tr>`; }

  // ---- Stats strip ----
  try {
    document.getElementById('statStrip').innerHTML = `
      <div class="stat"><div class="label">R&D bonus pool</div><div class="value num">${fmtEUR(data.rd_team.total_bonus)}</div><div class="sub">÷ ${TARGETS.rates.rd_team.team_size} team members</div></div>
      <div class="stat"><div class="label">Launch Mgr bonus (approx.)</div><div class="value num">${fmtEUR(lm ? lm.approx_bonus_eur : null)}</div><div class="sub"><span class="pill pending">country split pending</span></div></div>
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
