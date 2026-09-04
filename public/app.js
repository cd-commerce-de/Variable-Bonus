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

let MAPPING = null;   // ASIN -> {brand, stage, product_code, ...}
let TARGETS = null;   // quarterly targets + rates, from the calculator workbook
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

// ---------- Load mapping + targets + month list on boot ----------
async function boot() {
  [MAPPING, TARGETS] = await Promise.all([
    fetch('toc_mapping.json').then(r => r.json()),
    fetch('targets.json').then(r => r.json()),
  ]);
  document.getElementById('targetsNote').textContent =
    `Targets sourced from the Variable Bonus Calculator, ${TARGETS.source_quarter} quarter, monthly = quarterly ÷ 3 (interim).`;
  await refreshMonthList();
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
  const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
  let data = local[month];
  if (!data) { try { data = await fetch(`/api/data?month=${month}`).then(r => r.ok ? r.json() : null); } catch (e) {} }
  if (!data) { try { data = await fetch(`data/${month}.json`).then(r => r.ok ? r.json() : null); } catch (e) {} }
  return data;
}

async function onMonthChange() {
  const month = document.getElementById('monthSelect').value;
  const data = await loadMonth(month);
  if (data) { CURRENT = data; await renderCurrentView(); }
}

function setView(v) {
  VIEW = v;
  document.getElementById('viewMonthlyBtn').classList.toggle('active', v === 'monthly');
  document.getElementById('viewQuarterlyBtn').classList.toggle('active', v === 'quarterly');
  renderCurrentView();
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
    const merged = mergeMonths(parts.filter(Boolean));
    merged.month = CURRENT.month;
    merged._quarterMonthsPresent = present;
    merged._quarterMonthsExpected = qMonths;
    render(merged, 'quarterly');
  }
}

function mergeMonths(list) {
  const addBucket = (a, b) => ({ sales: (a?.sales || 0) + (b?.sales || 0), units: (a?.units || 0) + (b?.units || 0), net_profit: (a?.net_profit || 0) + (b?.net_profit || 0), sku_count: Math.max(a?.sku_count || 0, b?.sku_count || 0) });
  if (!list.length) return computeFromRows([], null);
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
    complete: (results) => {
      try {
        const monthVal = document.getElementById('monthPicker').value || guessMonthFromFilename(file.name);
        if (!monthVal) throw new Error('Pick the month this export covers (top right of the upload box) before parsing.');
        const computed = computeFromRows(results.data, monthVal);
        statusEl.innerHTML = `<div class="banner info">Parsed ${results.data.length.toLocaleString()} rows for <b>${monthVal}</b>. Review below, then "Save to history" if it looks right.</div>`;
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
  return applyTargetsAndTiers(result, false);
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

// Attach target/tier/bonus fields onto a computed result (monthly figures
// use target/3; quarterly (isQuarterly=true) uses the full quarterly target).
function applyTargetsAndTiers(data, isQuarterly) {
  const rates = TARGETS.rates;
  const scale = (t) => isQuarterly ? t.quarter_green_rev : t.monthly_green_rev; // placeholder, real calc below

  // R&D
  const rdRows = {};
  const allCodes = new Set([...Object.keys(TARGETS.rd_team), ...Object.keys(data.rd_team.by_product || {})]);
  allCodes.forEach(code => {
    const t = TARGETS.rd_team[code];
    const actual = (data.rd_team.by_product || {})[code] || { sales: 0, units: 0, net_profit: 0, sku_count: 0 };
    const green = t ? (isQuarterly ? t.quarter_green_rev : t.monthly_green_rev) : null;
    const gold = t ? (isQuarterly ? t.quarter_gold_rev : t.monthly_gold_rev) : null;
    const tier = tierOf(actual.sales, green, gold, null, null, null, t ? t.gate : null);
    const bonus = bonusOf(tier, actual.sales, green, gold, rates.rd_team.green, rates.rd_team.gold);
    rdRows[code] = { label: t ? t.label : code, actual, green_target: green, gold_target: gold, tier, bonus_eur: bonus };
  });
  data.rd_team.rows = rdRows;
  data.rd_team.total_bonus = Object.values(rdRows).reduce((s, r) => s + r.bonus_eur, 0);

  // Launch Manager (actual is combined-only; show DE/PanEU targets, and an
  // approximate combined tier against the summed DE+PanEU target)
  const lt = TARGETS.launch_manager;
  const combinedGreen = (lt.germany.monthly_green_rev ?? 0) + (lt.pan_eu.monthly_green_rev ?? 0);
  const combinedGold = (lt.germany.monthly_gold_rev ?? 0) + (lt.pan_eu.monthly_gold_rev ?? 0);
  const cGreen = isQuarterly ? (lt.germany.quarter_green_rev + lt.pan_eu.quarter_green_rev) : combinedGreen;
  const cGold = isQuarterly ? (lt.germany.quarter_gold_rev + lt.pan_eu.quarter_gold_rev) : combinedGold;
  const approxTier = tierOf(data.launch_manager.actual_combined.sales, cGreen, cGold, null, null, null, null);
  data.launch_manager.germany_target = { green: isQuarterly ? lt.germany.quarter_green_rev : lt.germany.monthly_green_rev, gold: isQuarterly ? lt.germany.quarter_gold_rev : lt.germany.monthly_gold_rev };
  data.launch_manager.pan_eu_target = { green: isQuarterly ? lt.pan_eu.quarter_green_rev : lt.pan_eu.monthly_green_rev, gold: isQuarterly ? lt.pan_eu.quarter_gold_rev : lt.pan_eu.monthly_gold_rev };
  data.launch_manager.approx_combined_target = { green: cGreen, gold: cGold };
  data.launch_manager.approx_tier = approxTier;

  // Brand Manager (per stage, weighted rates)
  for (const [brand, v] of Object.entries(data.brand_manager)) {
    const bt = TARGETS.brand_manager[brand] || TARGETS.brand_manager[Object.keys(TARGETS.brand_manager).find(k => normBrand(k) === normBrand(brand))];
    let brandBonus = 0;
    const stageDetail = {};
    for (const [stageLabel, actual] of Object.entries(v.stages)) {
      const st = bt ? bt[stageLabel] : null;
      const weight = TARGETS.stage_weights[stageLabel];
      const green = st ? (isQuarterly ? st.quarter_green_rev : st.monthly_green_rev) : null;
      const gold = st ? (isQuarterly ? st.quarter_gold_rev : st.monthly_gold_rev) : null;
      const actualMargin = actual.sales ? actual.net_profit / actual.sales : null;
      const tier = tierOf(actual.sales, green, gold, actualMargin, st ? st.green_margin_pct : null, st ? st.gold_margin_pct : null, st ? st.gate : null);
      const effGreen = weight ? weight.eff_green : rates.brand_manager.green;
      const effGold = weight ? weight.eff_gold : rates.brand_manager.gold;
      const bonus = bonusOf(tier, actual.sales, green, gold, effGreen, effGold);
      brandBonus += bonus;
      stageDetail[stageLabel] = { actual, green_target: green, gold_target: gold, tier, bonus_eur: bonus };
    }
    v.stage_detail = stageDetail;
    v.total_bonus = brandBonus;
  }
  data._targets_meta = { quarter: TARGETS.source_quarter, is_quarterly_view: isQuarterly };
  return data;
}

// ---------- Rendering ----------
function tierTag(tier) {
  if (!tier) return '<span class="tier-tag pending">—</span>';
  if (tier === '🥇 GOLD') return '<span class="tier-tag gold">🥇 GOLD</span>';
  if (tier === '🟢 GREEN') return '<span class="tier-tag green">🟢 GREEN</span>';
  if (tier === 'AWAITING TARGET') return '<span class="tier-tag pending">awaiting target</span>';
  if (tier === '-') return '<span class="tier-tag pending">—</span>';
  return '<span class="tier-tag miss">❌ MISS</span>';
}

function render(data, viewLabel) {
  const periodLabel = viewLabel === 'quarterly'
    ? `${quarterOf(data.month)} (quarterly)`
    : `${data.month} (monthly)`;
  document.getElementById('periodBadge').textContent = periodLabel;

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

  // ---- R&D ----
  const rdRows = Object.entries(data.rd_team.rows).sort((a, b) => (b[1].actual.sales) - (a[1].actual.sales));
  document.getElementById('rdBody').innerHTML = rdRows.map(([code, r]) => `
    <tr>
      <td class="name">${r.label}</td>
      <td class="num">${fmtEUR(r.actual.sales)}</td>
      <td class="num">${fmtEUR(r.green_target)}</td>
      <td class="num">${fmtEUR(r.gold_target)}</td>
      <td>${tierTag(r.tier)}</td>
      <td class="num">${fmtEUR(r.bonus_eur)}</td>
    </tr>
  `).join('');
  document.getElementById('rdTotalBonus').textContent = fmtEUR(data.rd_team.total_bonus);
  document.getElementById('rdTeamSize').textContent = TARGETS.rates.rd_team.team_size;
  document.getElementById('rdPerPerson').textContent = fmtEUR(data.rd_team.total_bonus / TARGETS.rates.rd_team.team_size);

  // ---- Launch Manager ----
  const lm = data.launch_manager;
  document.getElementById('launchBody').innerHTML = `
    <tr><td class="name">Germany</td><td class="num">—</td><td class="num">${fmtEUR(lm.germany_target.green)}</td><td class="num">${fmtEUR(lm.germany_target.gold)}</td><td><span class="tier-tag pending">split pending</span></td><td class="num">—</td></tr>
    <tr><td class="name">PAN EU</td><td class="num">—</td><td class="num">${fmtEUR(lm.pan_eu_target.green)}</td><td class="num">${fmtEUR(lm.pan_eu_target.gold)}</td><td><span class="tier-tag pending">split pending</span></td><td class="num">—</td></tr>
    <tr style="background:var(--ember-subtle);"><td class="name">Combined (approx.)</td><td class="num">${fmtEUR(lm.actual_combined.sales)}</td><td class="num">${fmtEUR(lm.approx_combined_target.green)}</td><td class="num">${fmtEUR(lm.approx_combined_target.gold)}</td><td>${tierTag(lm.approx_tier)}</td><td class="num">approx. only</td></tr>
  `;

  // ---- Brand Manager ----
  const bmRows = Object.entries(data.brand_manager).sort((a, b) => b[1].combined_actual.sales - a[1].combined_actual.sales);
  let bmHtml = '';
  let bmTotalBonus = 0;
  bmRows.forEach(([brand, v]) => {
    bmTotalBonus += v.total_bonus || 0;
    bmHtml += `<tr class="brand-row"><td class="name">${brand}</td><td class="num">${fmtEUR(v.combined_actual.sales)}</td><td colspan="3"></td><td class="num">${fmtEUR(v.total_bonus)}</td></tr>`;
    for (const [stageLabel, sd] of Object.entries(v.stage_detail)) {
      bmHtml += `
        <tr class="stage-row">
          <td class="name sub">${stageLabel}</td>
          <td class="num">${fmtEUR(sd.actual.sales)}</td>
          <td class="num">${fmtEUR(sd.green_target)}</td>
          <td class="num">${fmtEUR(sd.gold_target)}</td>
          <td>${tierTag(sd.tier)}</td>
          <td class="num">${fmtEUR(sd.bonus_eur)}</td>
        </tr>`;
    }
  });
  document.getElementById('bmBody').innerHTML = bmHtml;
  document.getElementById('bmTotalBonus').textContent = fmtEUR(bmTotalBonus);

  // ---- Stats strip ----
  document.getElementById('statStrip').innerHTML = `
    <div class="stat"><div class="label">R&D bonus pool</div><div class="value num">${fmtEUR(data.rd_team.total_bonus)}</div><div class="sub">÷ ${TARGETS.rates.rd_team.team_size} team members</div></div>
    <div class="stat"><div class="label">Launch Mgr (F3M) actual</div><div class="value num">${fmtEUR(lm.actual_combined.sales)}</div><div class="sub"><span class="pill pending">country split pending</span></div></div>
    <div class="stat"><div class="label">Brand Manager total bonus</div><div class="value num">${fmtEUR(bmTotalBonus)}</div><div class="sub">${bmRows.length} brands</div></div>
    <div class="stat"><div class="label">Quality Issue (unassigned)</div><div class="value num">${fmtEUR(data.quality_issue_unassigned.sales)}</div><div class="sub">${data.quality_issue_unassigned.sku_count} SKUs — no track owns this stage</div></div>
  `;

  // ---- Chart ----
  const ctx = document.getElementById('brandChart');
  if (window._brandChart) window._brandChart.destroy();
  window._brandChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: bmRows.map(([b]) => b), datasets: [{ label: 'Actual revenue (€)', data: bmRows.map(([, v]) => v.combined_actual.sales), backgroundColor: '#D97757', borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });

  document.getElementById('monthPicker').value = (data.month || '').length === 7 ? data.month : '';
  ['statsSection', 'rdSection', 'launchSection', 'bmSection', 'mpSection', 'chartSection'].forEach(id => document.getElementById(id).style.display = 'block');
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
    if (res.ok) { statusEl.textContent = `Saved "${toSave.month}" to the repo.`; await refreshMonthList(); return; }
    throw new Error('API not available');
  } catch (e) {
    const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
    local[toSave.month] = toSave;
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(local));
    statusEl.textContent = `Saved "${toSave.month}" locally in this browser only (API not deployed — see README to persist to GitHub for everyone).`;
    await refreshMonthList();
  }
}

boot();
