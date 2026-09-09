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

// NOTE: STAGE_LABELS['M4-12'] intentionally stays "Y1 (F4-12)" -- this
// exact string is also used as an OBJECT KEY into targets.json and the
// monthly targets files (generated from the calculator workbook's own
// section header text, which literally says "F4-12"). Changing this
// value would silently break every lookup into those files. The visible
// typo fix (showing "M4-12" to the user, since that's the TOC's actual
// stage code) is applied separately, only at render time, via
// displayStageLabel() below -- never as a key.
const STAGE_LABELS = { 'PY1': 'PY1', 'M4-12': 'Y1 (F4-12)', 'Discontinued': 'Discontinued', 'F3M': 'F3M', 'Quality Issue': 'Quality Issue (unassigned)' };
function displayStageLabel(label) { return label === 'Y1 (F4-12)' ? 'Y1 (M4-12)' : label; }

// ---------- Stage computation, embedded (no manual TOC updates needed) ----------
// A SKU's stage is a function of (launch date, the month being attributed),
// NOT a fixed label -- it moves forward every month on its own:
//   months 1-3 since launch  -> F3M
//   months 4-12 since launch -> M4-12 ("Y1 (M4-12)")
//   month 13+ since launch   -> PY1
// Discontinued / Quality Issue are manual overrides (there's no calendar
// rule for them) -- once their start date is reached, they take over from
// whatever the calendar would otherwise say, for that month and onward.
function monthIndex(dateStr) { // "2026-08" or "2026-08-15" -> single comparable integer
  const [y, m] = dateStr.split('-').map(Number);
  return y * 12 + (m - 1);
}
function computeStageForMonth(info, targetMonth) {
  if (!info.launch_date) return info.toc_stage_snapshot || null; // no launch date on file -- fall back to whatever the TOC last recorded
  const targetIdx = monthIndex(targetMonth);
  if (info.quality_issue_start_date && monthIndex(info.quality_issue_start_date) <= targetIdx) return 'Quality Issue';
  if (info.discontinued_start_date && monthIndex(info.discontinued_start_date) <= targetIdx) return 'Discontinued';
  const monthsSinceLaunch = targetIdx - monthIndex(info.launch_date);
  if (monthsSinceLaunch < 0) return null; // hasn't launched yet as of this month
  if (monthsSinceLaunch < 3) return 'F3M';
  if (monthsSinceLaunch < 12) return 'M4-12';
  return 'PY1';
}

function normBrand(b) { return (b || '').trim().toLowerCase(); } // TOC brand names sometimes differ in case/styling from the calculator's (e.g. "NASSWERK" vs "Nasswerk")

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
const MONTH_NAMES_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function formatMonthLabel(month) { // "2026-08" -> "August 2026"
  const [y, m] = month.split('-');
  return `${MONTH_NAMES_FULL[parseInt(m, 10) - 1]} ${y}`;
}
const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatMonthCompact(month) { // "2026-01" -> "Jan '26"
  const [y, m] = month.split('-');
  return `${MONTH_NAMES_SHORT[parseInt(m, 10) - 1]} '${y.slice(2)}`;
}

function quarterKeyOf(month) { // "2026-08" -> "2026-Q3"
  return `${month.slice(0, 4)}-${quarterOf(month)}`;
}
function quarterLabel(quarterKey) { // "2026-Q3" -> "Q3 2026"
  const [year, q] = quarterKey.split('-');
  return `${q} ${year}`;
}
function monthsInQuarterKey(quarterKey) { // "2026-Q3" -> ["2026-07","2026-08","2026-09"]
  const [year, q] = quarterKey.split('-');
  const startMonth = { Q1: 1, Q2: 4, Q3: 7, Q4: 10 }[q];
  return [0, 1, 2].map(i => `${year}-${String(startMonth + i).padStart(2, '0')}`);
}

// ---------- Auth (local convenience gate only — see note above) ----------
function unlockDashboard() {
  // Both must happen together: hiding the overlay alone leaves the real
  // content sitting there, blurred but still scrollable/interactive
  // underneath if this isn't also cleared -- that was the actual bug.
  document.getElementById('authGate').style.display = 'none';
  document.getElementById('appContent').classList.remove('locked');
  document.body.classList.remove('auth-locked');
}
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
    if (res.ok) { unlockDashboard(); return; }
    if (res.status === 401) { errEl.textContent = 'Incorrect passcode.'; return; }
    // any other status (e.g. 500 not configured) -> fall through to local check
  } catch (e) { /* API not deployed (e.g. local static preview) -> fall through */ }

  // Fallback for local testing only -- NOT secure, see file header note.
  const hash = await sha256(val);
  if (hash === PASSCODE_HASH && PASSCODE_HASH !== 'REPLACE_WITH_SHA256_HASH') {
    sessionStorage.setItem('cdc_authed', '1');
    unlockDashboard();
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
    if (res.ok) { unlockDashboard(); return; }
    if (res.status === 401) return; // definitively logged out server-side
  } catch (e) { /* API not deployed -- fall through to local-only check */ }

  // Fallback for local testing only -- NOT secure, see file header note.
  if (sessionStorage.getItem('cdc_authed') === '1') {
    unlockDashboard();
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
let UK_ASINS = new Set(); // ASINs also listed on Amazon.co.uk -- per confirmed policy, their revenue always counts as Germany, never Pan-EU, even when it comes from a "Pan-EU" upload
async function boot() {
  [MAPPING, TARGETS] = await Promise.all([
    fetch('toc_mapping.json').then(r => r.json()),
    fetch('targets.json').then(r => r.json()),
  ]);
  try {
    const mm = await fetch('marketplace_mapping.json').then(r => r.ok ? r.json() : null);
    if (mm && mm.ambiguous_asins) {
      UK_ASINS = new Set(mm.ambiguous_asins.filter(a => (a.marketplaces_seen || []).includes('Amazon.co.uk')).map(a => a.asin));
    }
  } catch (e) { /* optional -- if this file isn't present, UK redirection simply doesn't apply */ }
  try {
    mergeManualAdditionsIntoMapping(await loadManualAdditions());
  } catch (e) { /* none saved yet, or API unavailable -- fine, nothing to merge */ }
  try {
    const full = await loadPanEuFull();
    PAN_EU_TOC = full.entries;
    PAN_EU_PENDING = full.pending;
    await refreshPanEuMarketplaceDropdown();
  } catch (e) { /* none saved yet, or API unavailable -- fine, empty for now */ }
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
  const sortedMonths = Array.from(months).sort().reverse();
  sortedMonths.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = formatMonthLabel(m);
    sel.appendChild(opt);
  });

  // Quarter dropdown: every quarter any known month falls into
  const qSel = document.getElementById('quarterSelect');
  qSel.innerHTML = '';
  const quarters = Array.from(new Set(sortedMonths.map(quarterKeyOf))).sort().reverse();
  quarters.forEach(qk => {
    const opt = document.createElement('option');
    opt.value = qk; opt.textContent = quarterLabel(qk);
    qSel.appendChild(opt);
  });

  if (sel.options.length) { sel.value = sel.options[0].value; await onMonthChange(); }
}

async function onQuarterChange() {
  await renderQuarterlyTab();
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

// ---------- Manually-added ASINs (Unmapped ASINs tab) ----------
// Reuses the exact same save/load infrastructure as a real month, under a
// pseudo-month key that can never collide with a real "YYYY-MM" month --
// no new API surface needed. Merged into the live MAPPING at boot and
// again immediately after each save, so additions are usable right away
// without a page reload or a new toc_mapping.json.
const MANUAL_ASIN_KEY = '_manual_asin_additions';
async function loadManualAdditions() {
  const saved = await loadMonth(MANUAL_ASIN_KEY);
  return (saved && saved.additions) ? saved.additions : {};
}
function mergeManualAdditionsIntoMapping(additions) {
  for (const [asin, info] of Object.entries(additions)) {
    MAPPING[asin] = { ...(MAPPING[asin] || {}), ...info };
  }
}
async function saveManualAddition(asin, info) {
  const existing = await loadManualAdditions();
  existing[asin] = info;
  await saveMonthData({ month: MANUAL_ASIN_KEY, additions: existing });
  mergeManualAdditionsIntoMapping({ [asin]: info });
  return existing;
}

// ---------- Pan-EU-specific product database (Pan-EU TOC tab) ----------
// The SAME ASIN can be sold in multiple Pan-EU marketplaces, each with
// its OWN launch date (e.g. launched in France in March, only expanded
// to Italy in June) -- so this is keyed by (ASIN, Marketplace), not just
// ASIN. Structure: PAN_EU_TOC[asin][marketplace] = { launch_date }.
// Used ONLY when processing a Pan-EU upload, and only for the ONE
// marketplace that upload is declared as; Germany uploads keep using the
// main MAPPING as always, untouched by any of this. Same reused
// pseudo-month persistence trick as the manual ASIN additions above.
//
// PAN_EU_PENDING[marketplace] = [asin, ...] -- ASINs seen in an uploaded
// Pan-EU file for that marketplace that AREN'T in PAN_EU_TOC yet. Comes
// from the upload itself, not typed in from memory -- surfaced in the
// Pan-EU TOC tab so adding a Launch Date is a quick fill-in, the same
// pattern as the Unmapped ASINs tab.
let PAN_EU_TOC = {};
let PAN_EU_PENDING = {};
const PAN_EU_TOC_KEY = '_pan_eu_toc';
async function loadPanEuFull() {
  const saved = await loadMonth(PAN_EU_TOC_KEY);
  return { entries: (saved && saved.entries) ? saved.entries : {}, pending: (saved && saved.pending) ? saved.pending : {} };
}
async function loadPanEuToc() {
  return (await loadPanEuFull()).entries;
}
async function savePanEuTocEntry(asin, marketplace, info) {
  const full = await loadPanEuFull();
  full.entries[asin] = full.entries[asin] || {};
  full.entries[asin][marketplace] = info;
  // Resolved -- no longer pending for this marketplace.
  if (full.pending[marketplace]) full.pending[marketplace] = full.pending[marketplace].filter(a => a !== asin);
  await saveMonthData({ month: PAN_EU_TOC_KEY, entries: full.entries, pending: full.pending });
  PAN_EU_TOC = full.entries;
  PAN_EU_PENDING = full.pending;
  return full.entries;
}
async function addPanEuPendingAsins(marketplace, asins) {
  if (!asins.length) return;
  const full = await loadPanEuFull();
  const already = new Set(full.pending[marketplace] || []);
  asins.forEach(a => { if (!(full.entries[a] && full.entries[a][marketplace])) already.add(a); }); // never re-add one that's already a real entry
  full.pending[marketplace] = Array.from(already);
  await saveMonthData({ month: PAN_EU_TOC_KEY, entries: full.entries, pending: full.pending });
  PAN_EU_TOC = full.entries;
  PAN_EU_PENDING = full.pending;
}
async function dismissPanEuPendingAsin(marketplace, asin) {
  const full = await loadPanEuFull();
  if (full.pending[marketplace]) full.pending[marketplace] = full.pending[marketplace].filter(a => a !== asin);
  await saveMonthData({ month: PAN_EU_TOC_KEY, entries: full.entries, pending: full.pending });
  PAN_EU_PENDING = full.pending;
}
function panEuTocMarketplaces() {
  const set = new Set();
  Object.values(PAN_EU_TOC).forEach(byMarketplace => Object.keys(byMarketplace).forEach(m => set.add(m)));
  Object.keys(PAN_EU_PENDING).forEach(m => set.add(m)); // a marketplace might only exist via pending ASINs so far, no confirmed entries yet
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
async function refreshPanEuMarketplaceDropdown() {
  const marketplaces = panEuTocMarketplaces();
  const sel = document.getElementById('panEuMarketplaceSelect');
  const prevValue = sel.value;
  sel.innerHTML = marketplaces.length
    ? marketplaces.map(m => `<option value="${m}">${m}</option>`).join('')
    : `<option value="">Add marketplaces in the Pan-EU TOC tab first…</option>`;
  if (marketplaces.includes(prevValue)) sel.value = prevValue;

  const datalist = document.getElementById('peMarketplaceList');
  datalist.innerHTML = marketplaces.map(m => `<option value="${m}">`).join('');
}

// ---------- Marketplace: fully manual, but scoped strictly to CURRENT.month ----------
// Populates the 6 input fields from data.marketplace whenever a month is
// loaded/switched -- this is the actual fix: previously nothing ever
// touched these inputs on month-switch, so whatever was typed just sat in
// the DOM regardless of which month was selected, making it look like the
// value "carried over" when really nothing was scoped to a month at all.
function populateMarketplaceInputs(data) {
  const mp = data.marketplace || {};
  const setVal = (id, v) => { document.getElementById(id).value = (v == null ? '' : v); };
  setVal('mpActual', mp.actual_sales);
  setVal('mpGreen', mp.green_target);
  setVal('mpGold', mp.gold_target);
  setVal('mpActualMargin', mp.actual_margin_pct == null ? null : mp.actual_margin_pct * 100);
  setVal('mpGreenMargin', mp.green_margin_pct == null ? null : mp.green_margin_pct * 100);
  setVal('mpGoldMargin', mp.gold_margin_pct == null ? null : mp.gold_margin_pct * 100);
  const tier = mp.tier || '-';
  document.getElementById('mpTier').innerHTML = tierTag(tier);
  document.getElementById('mpBonus').textContent = fmtEUR(mp.bonus_eur || 0);
  document.getElementById('mpBonus').className = `num ${tierCellClass(tier)}`;
  const teamSize = TARGETS.rates.marketplace.team_size || 1;
  document.getElementById('mpTotalBonus').textContent = fmtEUR(mp.bonus_eur || 0);
  const perPersonRow = document.getElementById('mpPerPersonRow');
  perPersonRow.querySelector('td:first-child').textContent = `÷ ${teamSize} team member${teamSize === 1 ? '' : 's'}`;
  perPersonRow.querySelector('td.num').textContent = fmtEUR((mp.bonus_eur || 0) / teamSize);
}

let _mpSaveTimer = null;
function onMarketplaceInputChange() {
  if (!CURRENT) return;
  const val = (id) => { const v = document.getElementById(id).value; return v === '' ? null : parseFloat(v); };
  const actualSales = val('mpActual');
  const greenTarget = val('mpGreen');
  const goldTarget = val('mpGold');
  // Margin inputs are typed as plain percentages (e.g. 24 for 24%) -- stored as fractions internally, same convention as every other track.
  const actualMarginPct = val('mpActualMargin');
  const greenMarginPct = val('mpGreenMargin');
  const goldMarginPct = val('mpGoldMargin');
  const actualMargin = actualMarginPct == null ? null : actualMarginPct / 100;
  const greenMargin = greenMarginPct == null ? null : greenMarginPct / 100;
  const goldMargin = goldMarginPct == null ? null : goldMarginPct / 100;

  const tier = tierOf(actualSales, greenTarget, goldTarget, actualMargin, greenMargin, goldMargin, null);
  const rates = TARGETS.rates;
  const bonus = bonusOf(tier, actualSales, greenTarget, goldTarget, rates.marketplace.green, rates.marketplace.gold);

  CURRENT.marketplace = {
    label: 'Marketplace — manually entered', entered: true,
    actual_sales: actualSales, green_target: greenTarget, gold_target: goldTarget,
    actual_margin_pct: actualMargin, green_margin_pct: greenMargin, gold_margin_pct: goldMargin,
    tier, bonus_eur: bonus,
  };
  populateMarketplaceInputs(CURRENT); // refresh Tier/Bonus display without re-fetching the whole month

  // Debounced auto-save -- scoped to CURRENT.month specifically, so this
  // can never bleed into any other month's saved data.
  clearTimeout(_mpSaveTimer);
  _mpSaveTimer = setTimeout(async () => {
    if (CURRENT) await saveMonthData(CURRENT);
  }, 800);
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
    populateMarketplaceInputs(CURRENT);
  }
  renderMasterlist();
}

function referenceMonthForMasterlist() {
  return document.getElementById('monthSelect').value || document.getElementById('monthPicker').value || null;
}

function renderMasterlist() {
  const month = referenceMonthForMasterlist();
  document.getElementById('masterlistMonthLabel').textContent = month ? formatMonthLabel(month) : 'the selected month';
  const filterEl = document.getElementById('masterlistFilter');
  const filter = (filterEl.value || '').trim().toLowerCase();
  const bodyEl = document.getElementById('masterlistBody');
  const footerEl = document.getElementById('masterlistFooter');

  if (!MAPPING || !month) { bodyEl.innerHTML = ''; footerEl.textContent = ''; return; }
  if (filter.length < 2) {
    bodyEl.innerHTML = '';
    footerEl.textContent = `${Object.keys(MAPPING).length.toLocaleString('en-US')} ASINs on file. Type at least 2 characters above to search.`;
    return;
  }

  const CAP = 200;
  const matches = [];
  for (const [asin, info] of Object.entries(MAPPING)) {
    const hay = `${asin} ${info.product || ''} ${info.brand || ''}`.toLowerCase();
    if (hay.includes(filter)) matches.push([asin, info]);
    if (matches.length > CAP) break;
  }

  bodyEl.innerHTML = matches.slice(0, CAP).map(([asin, info]) => {
    const stage = computeStageForMonth(info, month);
    const stageDisplay = stage ? (STAGE_LABELS[stage] || stage) : '<span style="color:var(--line-400);">not yet launched</span>';
    return `<tr>
      <td class="name">${asin}</td>
      <td class="name">${info.brand || '—'}</td>
      <td class="name" title="${info.product || ''}">${info.product || '—'}</td>
      <td class="num">${info.launch_date || '—'}</td>
      <td>${stageDisplay}</td>
    </tr>`;
  }).join('');

  footerEl.textContent = matches.length > CAP
    ? `Showing first ${CAP} matches of ${matches.length}+ — refine your search to see more specific results.`
    : matches.length === 0
      ? (looksLikeAsin(filter)
          ? `No match for "${filterEl.value.trim()}". This looks like an ASIN, so the most likely reason is it isn't in the TOC mapping yet — add it to the TOC's "ASIN Report" tab (with a Launch Date) and rebuild the mapping.`
          : `No match for "${filterEl.value.trim()}".`)
      : `${matches.length} match${matches.length === 1 ? '' : 'es'}.`;
}

function setTab(t) {
  document.getElementById('tabUpload').style.display = t === 'upload' ? 'block' : 'none';
  document.getElementById('tabMonthly').style.display = t === 'monthly' ? 'block' : 'none';
  document.getElementById('tabQuarterly').style.display = t === 'quarterly' ? 'block' : 'none';
  document.getElementById('tabImpact').style.display = t === 'impact' ? 'block' : 'none';
  document.getElementById('tabStage').style.display = t === 'stage' ? 'block' : 'none';
  document.getElementById('tabFramework').style.display = t === 'framework' ? 'block' : 'none';
  document.getElementById('tabUnmapped').style.display = t === 'unmapped' ? 'block' : 'none';
  document.getElementById('tabPanEuToc').style.display = t === 'paneutoc' ? 'block' : 'none';
  document.getElementById('tabUploadBtn').classList.toggle('active', t === 'upload');
  document.getElementById('tabMonthlyBtn').classList.toggle('active', t === 'monthly');
  document.getElementById('tabQuarterlyBtn').classList.toggle('active', t === 'quarterly');
  document.getElementById('tabImpactBtn').classList.toggle('active', t === 'impact');
  document.getElementById('tabStageBtn').classList.toggle('active', t === 'stage');
  document.getElementById('tabFrameworkBtn').classList.toggle('active', t === 'framework');
  document.getElementById('tabUnmappedBtn').classList.toggle('active', t === 'unmapped');
  document.getElementById('tabPanEuTocBtn').classList.toggle('active', t === 'paneutoc');
  document.getElementById('monthSelect').style.display = t === 'quarterly' ? 'none' : '';
  document.getElementById('quarterSelect').style.display = t === 'quarterly' ? '' : 'none';
  document.getElementById('periodBadge').style.display = t === 'quarterly' ? 'none' : '';
  if (t === 'quarterly') renderQuarterlyTab();
  if (t === 'stage') renderStageHistory();
  if (t === 'framework') renderBonusFramework();
  if (t === 'unmapped') renderUnmappedAsinsTab();
  if (t === 'paneutoc') renderPanEuTocTab();
}

// ---------- Bonus Framework tab: how data is extracted + how bonus is
// calculated per track. Rates are pulled live from TARGETS.rates so this
// stays accurate if Config changes -- never hardcoded numbers. ----------
function pct(rate) { return (rate * 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%'; }
function renderBonusFramework() {
  const r = TARGETS.rates;
  const w = TARGETS.stage_weights;

  document.getElementById('fwBrandManager').innerHTML = `
    <div class="section-head">
      <h2>1. Brand Manager — Revenue Overflow Bonus</h2>
    </div>
    <p style="margin:0 0 12px; font-size:13.5px; color:var(--line-700);">
      <b>How the data is extracted:</b> every SKU's Brand comes from the TOC.
      Only the 9 official Brand Manager brands count (grouped BM1-4 by
      supervisor) — other brands the company sells are tracked but
      excluded from this bonus. Each brand's revenue is split into three
      stages by <b>computed</b> stage (Launch Date-based, not a fixed TOC
      column — see the Stage History tab): PY1, Y1 (M4-12), and
      Discontinued. F3M-stage revenue is NOT included here — that belongs
      to Launch Manager below.
    </p>
    <p style="margin:0 0 12px; font-size:13.5px; color:var(--line-700);">
      <b>Formula:</b> for each stage — Bonus = (Actual Revenue − Target) ×
      Rate, where Rate is the <i>effective</i> rate for that stage (base
      rate × the stage's weight). Green pays at the Green target once
      revenue clears it; Gold pays at the (higher) Gold rate once revenue
      clears the Gold target instead — they don't stack.
    </p>
    <table style="width:auto; margin-bottom:14px;">
      <thead><tr><th>Stage</th><th>Weight</th><th>Green rate (effective)</th><th>Gold rate (effective)</th></tr></thead>
      <tbody>
        <tr><td class="name">PY1</td><td class="num">${pct(w['PY1'].weight)}</td><td class="num tint-green">${pct(w['PY1'].eff_green)}</td><td class="num tint-gold">${pct(w['PY1'].eff_gold)}</td></tr>
        <tr><td class="name">Y1 (M4-12)</td><td class="num">${pct(w['Y1 (F4-12)'].weight)}</td><td class="num tint-green">${pct(w['Y1 (F4-12)'].eff_green)}</td><td class="num tint-gold">${pct(w['Y1 (F4-12)'].eff_gold)}</td></tr>
        <tr><td class="name">Discontinued</td><td class="num">${pct(w['Discontinued'].weight)}</td><td class="num tint-green">${pct(w['Discontinued'].eff_green)}</td><td class="num tint-gold">${pct(w['Discontinued'].eff_gold)}</td></tr>
      </tbody>
    </table>
    <div class="banner warn">
      <span>⚠</span>
      <span><b>Quality gate — both conditions required, not either/or:</b> (1) Actual revenue must clear the stage's Green or Gold target, <b>AND</b> (2) actual profit margin % must meet or exceed that stage's target margin. If the margin gate fails, no bonus is paid for that stage no matter how far revenue overflowed.</span>
    </div>
  `;

  document.getElementById('fwLaunchManager').innerHTML = `
    <div class="section-head">
      <h2>2. Launch Manager — F3M Revenue Overflow Bonus</h2>
    </div>
    <p style="margin:0 0 12px; font-size:13.5px; color:var(--line-700);">
      <b>How the data is extracted:</b> Germany and Pan-EU actuals each
      come from their own dedicated upload (Upload tab) — real per-country
      numbers, not a computed split. Only F3M-stage products count (months
      1-3 since Launch Date, computed live). "Combined" is the full F3M
      pool from the main export, shown for reference only — it isn't used
      in either country's bonus calculation.
    </p>
    <p style="margin:0 0 12px; font-size:13.5px; color:var(--line-700);">
      <b>Formula:</b> Bonus = (Actual F3M Revenue − Target) × Rate, applied
      separately per country using that country's own rate.
    </p>
    <table style="width:auto; margin-bottom:14px;">
      <thead><tr><th>Market</th><th>Green rate</th><th>Gold rate</th></tr></thead>
      <tbody>
        <tr><td class="name">Germany</td><td class="num tint-green">${pct(r.launch_mgr_germany.green)}</td><td class="num tint-gold">${pct(r.launch_mgr_germany.gold)}</td></tr>
        <tr><td class="name">Pan-EU</td><td class="num tint-green">${pct(r.launch_mgr_pan_eu.green)}</td><td class="num tint-gold">${pct(r.launch_mgr_pan_eu.gold)}</td></tr>
      </tbody>
    </table>
    <div class="banner warn">
      <span>⚠</span>
      <span><b>Quality gate:</b> actual profit margin % for the F3M period must meet or exceed that country's target margin. Revenue overflow alone doesn't pay a bonus if the margin gate fails.</span>
    </div>
  `;

  document.getElementById('fwRnD').innerHTML = `
    <div class="section-head">
      <h2>3. R&amp;D Team — Y1 Revenue Overflow Bonus (Team Pool)</h2>
    </div>
    <p style="margin:0 0 12px; font-size:13.5px; color:var(--line-700);">
      <b>How the data is extracted:</b> every SKU's TOC Product Code is
      matched (exact, then prefix) against the calculator's named target
      rows — e.g. <code>SLP120</code>/<code>SLP400</code> both roll up
      under <code>SLP</code>. Only <b>F3M + M4-12</b> stage revenue counts
      (Year 1, computed live from Launch Date) — once a product's ASINs
      graduate to PY1, that revenue is Brand Manager's from then on, not
      R&amp;D's. A single product code can have a mix (an older variant
      already PY1 alongside a newer one still M4-12) — only the still-Y1
      portion counts.
    </p>
    <p style="margin:0 0 12px; font-size:13.5px; color:var(--line-700);">
      <b>Formula:</b> Team Pool Bonus = Σ (Actual Y1 Revenue − Target) ×
      Rate, summed across every matched product, then divided evenly
      across the team (${r.rd_team.team_size} member${r.rd_team.team_size === 1 ? '' : 's'}, from Config).
    </p>
    <table style="width:auto; margin-bottom:14px;">
      <thead><tr><th>Green rate</th><th>Gold rate</th></tr></thead>
      <tbody><tr><td class="num tint-green">${pct(r.rd_team.green)}</td><td class="num tint-gold">${pct(r.rd_team.gold)}</td></tr></tbody>
    </table>
    <div class="banner warn">
      <span>⚠</span>
      <span><b>Two quality gates, both required:</b> (1) actual profit margin % must meet or exceed the target margin, <b>AND</b> (2) zero confirmed product quality issues during the Y1 period. Either gate failing means no bonus, regardless of revenue.</span>
    </div>
  `;

  document.getElementById('fwMarketplace').innerHTML = `
    <div class="section-head">
      <h2>4. Marketplace Team — eBay, Otto &amp; Kaufland Revenue Overflow Bonus</h2>
    </div>
    <p style="margin:0 0 12px; font-size:13.5px; color:var(--line-700);">
      <b>How the data is extracted:</b> fully manual — actual and target
      revenue are typed in directly (Monthly tab), since Sellerboard's
      export doesn't cover these marketplaces.
    </p>
    <p style="margin:0 0 12px; font-size:13.5px; color:var(--line-700);">
      <b>Formula:</b> Team Pool Bonus = (Actual Revenue −
      Target) × Rate, divided across the team (${r.marketplace.team_size}
      member${r.marketplace.team_size === 1 ? '' : 's'}, from Config).
    </p>
    <table style="width:auto; margin-bottom:14px;">
      <thead><tr><th>Green rate</th><th>Gold rate</th></tr></thead>
      <tbody><tr><td class="num tint-green">${pct(r.marketplace.green)}</td><td class="num tint-gold">${pct(r.marketplace.gold)}</td></tr></tbody>
    </table>
    <div class="banner warn">
      <span>⚠</span>
      <span><b>Quality gate:</b> actual profit margin % must meet or exceed the target margin for the period, same shape as every other track.</span>
    </div>
  `;
}

// ---------- Unmapped ASINs tab: aggregate across every saved month, let
// the user fill in Brand + Launch Date (+ optional Product Code) right
// here, and it's usable immediately -- no new toc_mapping.json needed. ----------
async function renderUnmappedAsinsTab() {
  const bodyEl = document.getElementById('unmappedAsinsBody');
  const footerEl = document.getElementById('unmappedAsinsFooter');
  bodyEl.innerHTML = '';
  footerEl.textContent = 'Scanning every saved month…';

  const months = Array.from(document.getElementById('monthSelect').options).map(o => o.value);
  const seen = {}; // asin -> product (first one found)
  const collect = (meta) => {
    if (!meta) return;
    // Newer format: {asin, product} pairs -- has a real product name.
    if (meta.unmapped_details) {
      meta.unmapped_details.forEach(u => { if (u.asin && !(u.asin in seen)) seen[u.asin] = u.product; });
    }
    // Older saves (from before unmapped_details existed) only have bare
    // ASIN strings -- still worth surfacing, just with no product name to show.
    if (meta.unmapped_asins) {
      meta.unmapped_asins.forEach(asin => { if (asin && !(asin in seen)) seen[asin] = ''; });
    }
  };
  for (const m of months) {
    const d = await loadMonth(m);
    if (d) collect(d.meta);
  }
  // Also fold in whatever's currently loaded in-session, even if not saved yet.
  if (CURRENT) collect(CURRENT.meta);

  // Drop anything that's already mapped now (a manual addition from
  // earlier in this session, or an updated toc_mapping.json) -- it's
  // resolved, even if some already-saved month's stale meta still lists it.
  const stillUnmapped = Object.entries(seen).filter(([asin]) => !MAPPING[asin]);

  if (!stillUnmapped.length) {
    footerEl.textContent = months.length ? 'No unmapped ASINs found across any saved month. Everything checks out.' : 'No saved months to scan yet.';
    return;
  }

  bodyEl.innerHTML = stillUnmapped.map(([asin, product]) => `
    <tr id="ua-row-${asin}">
      <td class="name">${asin}</td>
      <td class="name" title="${product || ''}">${product || '—'}</td>
      <td><input class="target-input" style="width:130px; text-align:left;" id="ua-brand-${asin}" type="text" placeholder="Brand"></td>
      <td><input class="target-input" style="width:100px; text-align:left;" id="ua-code-${asin}" type="text" placeholder="optional"></td>
      <td><input class="target-input" style="width:130px;" id="ua-launch-${asin}" type="date"></td>
      <td><button class="btn primary" style="padding:6px 12px; font-size:12px;" onclick="saveUnmappedAsinRow('${asin}')">Save</button></td>
    </tr>`).join('');
  footerEl.textContent = `${stillUnmapped.length} unmapped ASIN(s) found across ${months.length} saved month(s).`;
}

async function saveUnmappedAsinRow(asin) {
  const brand = document.getElementById(`ua-brand-${asin}`).value.trim();
  const productCode = document.getElementById(`ua-code-${asin}`).value.trim();
  const launchDate = document.getElementById(`ua-launch-${asin}`).value;
  const row = document.getElementById(`ua-row-${asin}`);
  if (!brand || !launchDate) {
    const existingMsg = row.querySelector('.ua-error');
    if (existingMsg) existingMsg.remove();
    row.insertAdjacentHTML('beforeend', `<td class="ua-error" style="color:var(--bad); font-size:11.5px;">Brand and Launch Date are both required.</td>`);
    return;
  }
  const product = row.querySelector('td:nth-child(2)').getAttribute('title') || '';
  const info = { brand, product, product_code: productCode || null, launch_date: launchDate, discontinued_start_date: null, quality_issue_start_date: null, toc_stage_snapshot: null };
  await saveManualAddition(asin, info);
  row.style.opacity = '0.5';
  row.querySelector('td:last-child').innerHTML = '<span class="tier-tag green">Saved ✓</span>';
  renderMasterlist(); // if the Upload tab's masterlist is open, reflect the new ASIN there too
}

// ---------- Pan-EU TOC tab: a separate ASIN -> Marketplace -> launch_date
// database (the same ASIN can have a different entry per marketplace),
// used ONLY when processing a Pan-EU upload for the ONE marketplace that
// upload is declared as (Germany keeps using the main TOC). See
// PAN_EU_TOC / loadPanEuToc / savePanEuTocEntry. ----------
async function addPanEuTocEntry() {
  const asin = document.getElementById('peAddAsin').value.trim();
  const marketplace = document.getElementById('peAddMarketplace').value.trim();
  const launchDate = document.getElementById('peAddLaunchDate').value;
  const statusEl = document.getElementById('peAddStatus');
  if (!/^B0[A-Z0-9]{8}$/i.test(asin)) { statusEl.textContent = 'Enter a valid ASIN (B0 + 8 characters).'; statusEl.style.color = 'var(--bad)'; return; }
  if (!marketplace) { statusEl.textContent = 'Marketplace is required (e.g. France, Italy).'; statusEl.style.color = 'var(--bad)'; return; }
  if (!launchDate) { statusEl.textContent = 'Pan-EU Launch Date is required.'; statusEl.style.color = 'var(--bad)'; return; }
  await savePanEuTocEntry(asin.toUpperCase(), marketplace, { launch_date: launchDate });
  document.getElementById('peAddAsin').value = '';
  document.getElementById('peAddMarketplace').value = '';
  document.getElementById('peAddLaunchDate').value = '';
  statusEl.textContent = `Saved ${asin.toUpperCase()} for ${marketplace}.`;
  statusEl.style.color = 'var(--line-500)';
  await renderPanEuTocTab();
  await refreshPanEuMarketplaceDropdown();
}
async function deletePanEuTocEntry(asin, marketplace) {
  const full = await loadPanEuFull();
  if (full.entries[asin]) {
    delete full.entries[asin][marketplace];
    if (Object.keys(full.entries[asin]).length === 0) delete full.entries[asin];
  }
  await saveMonthData({ month: PAN_EU_TOC_KEY, entries: full.entries, pending: full.pending });
  PAN_EU_TOC = full.entries;
  PAN_EU_PENDING = full.pending;
  await renderPanEuTocTab();
  await refreshPanEuMarketplaceDropdown();
}
async function renderPanEuTocTab() {
  const full = await loadPanEuFull();
  PAN_EU_TOC = full.entries;
  PAN_EU_PENDING = full.pending;

  // ---- Pending: found in an upload, not typed in -- quick fill-in ----
  const pendingRows = [];
  for (const [marketplace, asins] of Object.entries(PAN_EU_PENDING)) {
    asins.forEach(asin => pendingRows.push([asin, marketplace]));
  }
  const pendingSection = document.getElementById('panEuPendingSection');
  const pendingBody = document.getElementById('panEuPendingBody');
  if (pendingRows.length) {
    pendingSection.style.display = 'block';
    pendingBody.innerHTML = pendingRows.map(([asin, marketplace]) => `
      <tr id="pe-pending-row-${asin}-${marketplace}">
        <td class="name">${asin}</td>
        <td class="name">${marketplace}</td>
        <td><input type="date" class="target-input" id="pe-pending-date-${asin}-${marketplace}" style="width:150px;"></td>
        <td style="white-space:nowrap;">
          <button class="btn primary" style="padding:4px 10px; font-size:11.5px;" onclick="savePendingPanEuAsin('${asin}', '${marketplace}')">Save</button>
          <button class="btn ghost" style="padding:4px 10px; font-size:11.5px;" onclick="dismissPanEuPendingAsin('${marketplace}', '${asin}').then(renderPanEuTocTab)">Dismiss</button>
        </td>
      </tr>`).join('');
  } else {
    pendingSection.style.display = 'none';
  }

  // ---- Confirmed entries ----
  const filter = (document.getElementById('panEuTocFilter').value || '').trim().toLowerCase();
  const bodyEl = document.getElementById('panEuTocBody');
  const footerEl = document.getElementById('panEuTocFooter');
  const rows = []; // flatten to one row per (asin, marketplace) pair
  for (const [asin, byMarketplace] of Object.entries(PAN_EU_TOC)) {
    for (const [marketplace, info] of Object.entries(byMarketplace)) {
      rows.push([asin, marketplace, info]);
    }
  }
  const entries = rows.filter(([asin, marketplace]) => {
    if (!filter) return true;
    return asin.toLowerCase().includes(filter) || marketplace.toLowerCase().includes(filter);
  }).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  bodyEl.innerHTML = entries.map(([asin, marketplace, info]) => `
    <tr>
      <td class="name">${asin}</td>
      <td class="name">${marketplace}</td>
      <td class="num">${info.launch_date || '—'}</td>
      <td><button class="btn ghost" style="padding:4px 10px; font-size:11.5px;" onclick="deletePanEuTocEntry('${asin}', '${marketplace}')">Remove</button></td>
    </tr>`).join('');
  const total = rows.length;
  footerEl.textContent = filter
    ? `${entries.length} of ${total} entries match "${filter}".`
    : `${total} (ASIN, Marketplace) entr${total === 1 ? 'y' : 'ies'} in the Pan-EU TOC.`;
}
async function savePendingPanEuAsin(asin, marketplace) {
  const launchDate = document.getElementById(`pe-pending-date-${asin}-${marketplace}`).value;
  const row = document.getElementById(`pe-pending-row-${asin}-${marketplace}`);
  if (!launchDate) {
    const existingMsg = row.querySelector('.pe-pending-error');
    if (existingMsg) existingMsg.remove();
    row.insertAdjacentHTML('beforeend', `<td class="pe-pending-error" style="color:var(--bad); font-size:11.5px;">Launch Date required.</td>`);
    return;
  }
  await savePanEuTocEntry(asin, marketplace, { launch_date: launchDate }); // this also removes it from pending automatically
  await renderPanEuTocTab();
  await refreshPanEuMarketplaceDropdown();
}

// ---------- Stage History: audit view, month-by-month, computed live ----------
const STAGE_HISTORY_START = '2026-01';
const STAGE_HISTORY_END = '2027-12';
function stageHistoryMonths() {
  const months = [];
  let [y, m] = STAGE_HISTORY_START.split('-').map(Number);
  const [endY, endM] = STAGE_HISTORY_END.split('-').map(Number);
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return months;
}
function stageBadge(stage) {
  if (!stage) return '';
  const map = { 'F3M': ['f3m', 'F3M'], 'M4-12': ['m412', 'Y1'], 'PY1': ['py1', 'PY1'], 'Discontinued': ['disc', 'DISC'], 'Quality Issue': ['qi', 'QI'] };
  const [cls, label] = map[stage] || ['disc', stage];
  return `<span class="stage-badge ${cls}">${label}</span>`;
}
let _stageMonthDropdownBuilt = false;
function ensureMonthFilterOptions() {
  if (_stageMonthDropdownBuilt) return;
  const sel = document.getElementById('monthFilterSelect');
  stageHistoryMonths().forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = formatMonthCompact(m);
    sel.appendChild(opt);
  });
  _stageMonthDropdownBuilt = true;
}
let _stageBrandDropdownBuilt = false;
function ensureBrandFilterOptions() {
  if (_stageBrandDropdownBuilt || !MAPPING) return;
  const sel = document.getElementById('brandFilterSelect');
  const brands = Array.from(new Set(Object.values(MAPPING).map(v => v.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  brands.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b; opt.textContent = b;
    sel.appendChild(opt);
  });
  _stageBrandDropdownBuilt = true;
}

function renderStageHistory() {
  renderStageHistoryInner().catch(err => console.error('Stage History render error:', err));
}
async function renderStageHistoryInner() {
  ensureMonthFilterOptions();
  ensureBrandFilterOptions();
  const months = stageHistoryMonths();
  const filterEl = document.getElementById('stageHistoryFilter');
  const filter = (filterEl.value || '').trim().toLowerCase();
  const stageFilter = document.getElementById('stageFilterSelect').value;
  const monthFilter = document.getElementById('monthFilterSelect').value;
  const brandFilter = document.getElementById('brandFilterSelect').value;
  const bodyEl = document.getElementById('stageHistoryBody');
  const footerEl = document.getElementById('stageHistoryFooter');
  const headerRow = document.getElementById('stageHistoryHeaderRow');
  const tableEl = document.getElementById('stageHistoryTable');

  if (!MAPPING) { bodyEl.innerHTML = ''; footerEl.textContent = ''; return; }

  // ---- Reverse-lookup mode: a specific stage AND month picked -> list every matching ASIN ----
  if (stageFilter && monthFilter) {
    const showCountry = stageFilter === 'F3M'; // Germany/Pan-EU only means anything for F3M-stage products
    tableEl.className = 'stage-history-table list-mode';
    headerRow.innerHTML = '<th>ASIN</th><th>Product</th><th>Brand</th><th>Launch Date</th><th>Stage</th>' + (showCountry ? '<th>Country</th>' : '');

    let germanyAsins = new Set(), panEuAsins = new Set(), countryDataAvailable = false;
    if (showCountry) {
      const monthData = await loadMonth(monthFilter);
      if (monthData && monthData.launch_manager) {
        if (monthData.launch_manager.germany_source === 'dedicated_upload') { germanyAsins = new Set(monthData.launch_manager.germany_asins || []); countryDataAvailable = true; }
        if (monthData.launch_manager.pan_eu_source === 'dedicated_upload') { panEuAsins = new Set(monthData.launch_manager.pan_eu_asins || []); countryDataAvailable = true; }
      }
    }
    function countryCell(asin) {
      if (!countryDataAvailable) return '<span class="tier-tag pending">no upload yet</span>';
      const inDe = germanyAsins.has(asin), inEu = panEuAsins.has(asin);
      if (inDe && inEu) return '<span class="tier-tag pending" title="Present in both uploaded files -- worth checking for a duplicate">⚠ both</span>';
      if (inDe) return '<span class="stage-badge f3m">Germany</span>';
      if (inEu) return '<span class="stage-badge py1">Pan-EU</span>';
      return '<span class="tier-tag pending">not in either upload</span>';
    }

    const CAP = 300;
    const matches = [];
    for (const [asin, info] of Object.entries(MAPPING)) {
      if (brandFilter && info.brand !== brandFilter) continue;
      if (filter) {
        const hay = `${asin} ${info.product || ''} ${info.brand || ''}`.toLowerCase();
        if (!hay.includes(filter)) continue;
      }
      const stage = computeStageForMonth(info, monthFilter);
      if (stage === stageFilter) matches.push([asin, info, stage]);
    }
    bodyEl.innerHTML = matches.slice(0, CAP).map(([asin, info, stage]) => `
      <tr>
        <td class="name">${asin}</td>
        <td class="name" title="${info.product || ''}">${info.product || '—'}</td>
        <td class="name">${info.brand || '—'}</td>
        <td class="num">${info.launch_date || '—'}</td>
        <td>${stageBadge(stage)}</td>
        ${showCountry ? `<td>${countryCell(asin)}</td>` : ''}
      </tr>`).join('');
    const stageLabel = displayStageLabel(STAGE_LABELS[stageFilter] || stageFilter);
    const qualifiers = [brandFilter ? `brand "${brandFilter}"` : null, filter ? 'matching your search' : null].filter(Boolean).join(' and ');
    let footerMsg = matches.length > CAP
      ? `Showing first ${CAP} of ${matches.length}+ ASINs that were ${stageLabel} in ${formatMonthLabel(monthFilter)}${qualifiers ? ` (${qualifiers})` : ''}.`
      : `${matches.length} ASIN${matches.length === 1 ? '' : 's'} ${matches.length === 1 ? 'was' : 'were'} ${stageLabel} in ${formatMonthLabel(monthFilter)}${qualifiers ? ` (${qualifiers})` : ''}.`;
    if (showCountry && !countryDataAvailable) footerMsg += ` No Germany/Pan-EU file has been uploaded for ${formatMonthLabel(monthFilter)} yet, so the Country column can't be filled in.`;
    footerEl.textContent = footerMsg;
    return;
  }

  // ---- Matrix mode: pick a product, see its stage across every month ----
  tableEl.className = 'stage-history-table matrix-mode';
  headerRow.innerHTML = '<th>Product</th><th>Brand</th><th>Launch Date</th>' + months.map(m => `<th title="${formatMonthLabel(m)}">${formatMonthCompact(m)}</th>`).join('');

  if (stageFilter && !monthFilter) {
    bodyEl.innerHTML = '';
    footerEl.textContent = `Pick a month too — a stage alone isn't enough to look up matching ASINs (the same product can be a different stage in different months).`;
    return;
  }
  if (filter.length < 2 && !brandFilter) {
    bodyEl.innerHTML = '';
    footerEl.textContent = `${Object.keys(MAPPING).length.toLocaleString('en-US')} ASINs on file. Type at least 2 characters above to search, pick a brand, or pick a stage + month to look up matching ASINs directly.`;
    return;
  }

  const CAP = 100; // wide table (24 month columns) -- keep row count tighter than the plain masterlist
  const matches = [];
  for (const [asin, info] of Object.entries(MAPPING)) {
    if (brandFilter && info.brand !== brandFilter) continue;
    if (filter) {
      const hay = `${asin} ${info.product || ''} ${info.brand || ''}`.toLowerCase();
      if (!hay.includes(filter)) continue;
    }
    matches.push([asin, info]);
    if (matches.length > CAP) break;
  }

  bodyEl.innerHTML = matches.slice(0, CAP).map(([asin, info]) => {
    const cells = months.map(m => `<td>${stageBadge(computeStageForMonth(info, m))}</td>`).join('');
    return `<tr>
      <td class="name" title="${info.product || asin}">${info.product || asin}</td>
      <td class="name">${info.brand || '—'}</td>
      <td class="num">${info.launch_date || '—'}</td>
      ${cells}
    </tr>`;
  }).join('');

  footerEl.textContent = matches.length > CAP
    ? `Showing first ${CAP} matches of ${matches.length}+ — refine your search to see more specific results.`
    : matches.length === 0
      ? (looksLikeAsin(filter)
          ? `No match for "${filterEl.value.trim()}". This looks like an ASIN, so the most likely reason is it isn't in the TOC mapping yet — add it to the TOC's "ASIN Report" tab (with a Launch Date) and rebuild the mapping.`
          : `No match for "${filterEl.value.trim()}".`)
      : `${matches.length} match${matches.length === 1 ? '' : 'es'}.`;
}
function looksLikeAsin(text) {
  return /^b0[a-z0-9]{8}$/i.test(text.trim());
}

// ---------- Quarterly tab: sum of each month's ALREADY-COMPUTED bonus ----------
// Deliberately NOT a target-vs-actual comparison at the quarter level --
// just adds up whatever bonus each month already earned, per row.
async function renderQuarterlyTab() {
  const qSel = document.getElementById('quarterSelect');
  if (!qSel.value) return;
  const quarterKey = qSel.value;
  const months = monthsInQuarterKey(quarterKey);
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
      `<b>Partial quarter.</b> ${present.length} of 3 months have data (${present.map(formatMonthLabel).join(', ') || 'none'}). Totals below only include months that have been uploaded and saved.`;
  } else {
    note.style.display = 'none';
  }

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabels = months.map(m => MONTH_NAMES[parseInt(m.slice(5, 7), 10) - 1]);
  ['qRdM1Header', 'qRdM2Header', 'qRdM3Header', 'qLmM1Header', 'qLmM2Header', 'qLmM3Header', 'qBmM1Header', 'qBmM2Header', 'qBmM3Header', 'qMpM1Header', 'qMpM2Header', 'qMpM3Header'].forEach((id, i) => {
    document.getElementById(id).textContent = monthLabels[i % 3];
  });

  const sum3 = (vals) => {
    const known = vals.filter(v => v != null);
    if (!known.length) return null;
    return known.reduce((s, v) => s + v, 0);
  };
  // A cell showing a specific row's bonus for one month is tinted by that
  // row's tier THAT month (not the quarter total) -- subtotal/group/total
  // rows aren't tied to a single tier, so they're never tinted this way.
  const bonusCell = (v, tier) => `<td class="num ${v != null ? tierCellClass(tier) : ''}">${v != null ? fmtEUR(v) : '—'}</td>`;

  // ---- R&D ----
  const rdCodes = new Set();
  monthData.forEach(d => { if (d) Object.keys(d.rd_team.rows).forEach(c => rdCodes.add(c)); });
  let rdHtml = '';
  let rdTotals = [0, 0, 0];
  let rdGrandTotal = 0;
  Array.from(rdCodes).sort().forEach(code => {
    const label = (monthData.find(d => d && d.rd_team.rows[code]) || {}).rd_team?.rows[code]?.label || code;
    const perMonth = monthData.map(d => d && d.rd_team.rows[code] ? d.rd_team.rows[code].bonus_eur : null);
    const tiers = monthData.map(d => d && d.rd_team.rows[code] ? d.rd_team.rows[code].tier : null);
    const total = sum3(perMonth);
    perMonth.forEach((v, i) => { if (v != null) rdTotals[i] += v; });
    if (total != null) rdGrandTotal += total;
    rdHtml += `<tr><td class="name" title="${label}">${label}</td>${perMonth.map((v, i) => bonusCell(v, tiers[i])).join('')}<td class="num">${fmtEUR(total)}</td></tr>`;
  });
  document.getElementById('qRdBody').innerHTML = rdHtml;
  document.getElementById('qRdTotalRow').innerHTML = `<td>Pool bonus total</td>${rdTotals.map(v => `<td class="num">${fmtEUR(v)}</td>`).join('')}<td class="num">${fmtEUR(rdGrandTotal)}</td>`;
  const teamSize = TARGETS.rates.rd_team.team_size || 1;
  document.getElementById('qRdPerPersonRow').innerHTML = `<td>÷ ${teamSize} team members</td>${rdTotals.map(v => `<td class="num">${fmtEUR(v / teamSize)}</td>`).join('')}<td class="num">${fmtEUR(rdGrandTotal / teamSize)}</td>`;

  // ---- Launch Manager ----
  const launchRows = [
    { label: 'Germany', get: d => d.launch_manager.germany.bonus_eur, tier: d => d.launch_manager.germany.tier },
    { label: 'Pan-EU', get: d => d.launch_manager.pan_eu.bonus_eur, tier: d => d.launch_manager.pan_eu.tier },
  ];
  let lmHtml = '';
  let lmTotals = [0, 0, 0];
  let lmGrandTotal = 0;
  launchRows.forEach(({ label, get, tier }) => {
    const perMonth = monthData.map(d => d ? get(d) : null);
    const tiers = monthData.map(d => d ? tier(d) : null);
    const total = sum3(perMonth);
    perMonth.forEach((v, i) => { if (v != null) lmTotals[i] += v; });
    if (total != null) lmGrandTotal += total;
    lmHtml += `<tr><td class="name">${label}</td>${perMonth.map((v, i) => bonusCell(v, tiers[i])).join('')}<td class="num">${fmtEUR(total)}</td></tr>`;
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
      bmHtml += `<tr class="brand-row"><td class="name sub-brand" title="${brandName}">${brandName}</td>${brandPerMonth.map(v => `<td class="num">${v != null ? fmtEUR(v) : '—'}</td>`).join('')}<td class="num">${fmtEUR(brandTotal)}</td></tr>`;

      const stageLabels = ['PY1', 'Y1 (F4-12)', 'Discontinued']; // internal keys -- match targets.json's own key scheme, NOT the display label
      stageLabels.forEach(stageLabel => {
        const stagePerMonth = monthData.map(d => {
          if (!d) return null;
          const key = Object.keys(d.brand_manager).find(k => normBrand(k) === normBrand(brandName));
          const sd = key ? d.brand_manager[key].stage_detail[stageLabel] : null;
          return sd ? sd.bonus_eur : null;
        });
        const stageTiers = monthData.map(d => {
          if (!d) return null;
          const key = Object.keys(d.brand_manager).find(k => normBrand(k) === normBrand(brandName));
          const sd = key ? d.brand_manager[key].stage_detail[stageLabel] : null;
          return sd ? sd.tier : null;
        });
        const stageTotal = sum3(stagePerMonth);
        bmHtml += `<tr class="stage-row"><td class="name sub">${displayStageLabel(stageLabel)}</td>${stagePerMonth.map((v, i) => bonusCell(v, stageTiers[i])).join('')}<td class="num">${fmtEUR(stageTotal)}</td></tr>`;
      });
    }
  }
  document.getElementById('qBmBody').innerHTML = bmHtml;
  document.getElementById('qBmTotalRow').innerHTML = `<td>Total, all brands</td>${bmGrandTotals.map(v => `<td class="num">${fmtEUR(v)}</td>`).join('')}<td class="num">${fmtEUR(bmGrandTotal)}</td>`;

  // ---- Marketplace Team (fully manual, one row -- same pattern as R&D's pool + per-person row) ----
  const mpPerMonth = monthData.map(d => (d && d.marketplace && d.marketplace.entered) ? d.marketplace.bonus_eur : null);
  const mpTiers = monthData.map(d => (d && d.marketplace && d.marketplace.entered) ? d.marketplace.tier : null);
  const mpTotal = sum3(mpPerMonth);
  const mpTotals = [0, 0, 0];
  mpPerMonth.forEach((v, i) => { if (v != null) mpTotals[i] = v; });
  document.getElementById('qMpBody').innerHTML = `<tr><td class="name">eBay, Otto &amp; Kaufland</td>${mpPerMonth.map((v, i) => bonusCell(v, mpTiers[i])).join('')}<td class="num">${fmtEUR(mpTotal)}</td></tr>`;
  document.getElementById('qMpTotalRow').innerHTML = `<td>Pool bonus total</td>${mpTotals.map(v => `<td class="num">${fmtEUR(v)}</td>`).join('')}<td class="num">${fmtEUR(mpTotal || 0)}</td>`;
  const mpTeamSize = TARGETS.rates.marketplace.team_size || 1;
  document.getElementById('qMpPerPersonRow').innerHTML = `<td>÷ ${mpTeamSize} team member${mpTeamSize === 1 ? '' : 's'}</td>${mpTotals.map(v => `<td class="num">${fmtEUR(v / mpTeamSize)}</td>`).join('')}<td class="num">${fmtEUR((mpTotal || 0) / mpTeamSize)}</td>`;
}

function wireDropZone(zoneId, inputId, handler) {
  const zone = document.getElementById(zoneId);
  ['dragenter', 'dragover'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', e => { if (e.dataTransfer.files.length) handler(e.dataTransfer.files); });
  document.getElementById(inputId).addEventListener('change', e => { if (e.target.files.length) handler(e.target.files); });
}

// Main export drop zone (single file, drives R&D + Brand Manager + the F3M combined total)
const dropZone = document.getElementById('dropZone');
['dragenter', 'dragover'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', e => { if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });
document.getElementById('fileInput').addEventListener('change', e => { if (e.target.files.length) handleFile(e.target.files[0]); });

// Launch Manager: two dedicated per-country F3M drop zones (multi-file, no subtraction)
wireDropZone('germanyDropZone', 'germanyFileInput', (files) => handleCountryFiles(files, 'germany'));
wireDropZone('panEuDropZone', 'panEuFileInput', (files) => handleCountryFiles(files, 'pan_eu'));

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
        populateMarketplaceInputs(CURRENT);
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

// ---------- Launch Manager: two dedicated per-country F3M uploads.
// No subtraction, no residual math, no marketplace-mapping guess -- each
// country's actual comes directly from its own export. Works whether the
// target month is the one currently loaded in-session, or an already-saved
// month from before (in which case it's loaded, updated, and re-saved
// immediately -- same "bulk" pattern used elsewhere in this file).
function parseCountryF3MFile(file, month, country, marketplace) {
  // country: 'germany' | 'pan_eu' -- decides which product database to
  // look up stage from. Germany uses the main TOC (MAPPING) as always.
  // Pan-EU uses the SEPARATE Pan-EU TOC (PAN_EU_TOC), keyed by
  // (ASIN, marketplace) -- the SAME ASIN can have a different launch date
  // per marketplace (launched in Germany first, expanded to France in
  // March, Italy in June, etc.), so this looks up ONLY the entry for the
  // ONE marketplace this specific file is declared as, never any other
  // marketplace's entry for that same ASIN.
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true, delimiter: ';', encoding: 'utf-8', skipEmptyLines: true,
      complete: (results) => {
        const children = results.data.filter(r => (r.SKU || '').trim() !== '');
        let sales = 0, units = 0, net_profit = 0, matched = 0, skippedNonF3M = 0, skippedUnmapped = 0;
        const matchedAsins = [];
        const skippedUnmappedAsins = []; // which ASINs specifically (not just a count) -- for Pan-EU, feeds the "pending" list in the Pan-EU TOC tab, so adding a Launch Date is a quick fill-in instead of typing ASINs from memory
        // Separately track any ASIN also listed on Amazon.co.uk -- per
        // confirmed policy, UK revenue always counts as Germany, even
        // when it arrives in a "Pan-EU" file. Kept as its own bucket so
        // the caller can redirect it without touching the rest. Only
        // relevant for Pan-EU uploads (Germany uploads never redirect).
        let ukRedirectSales = 0, ukRedirectUnits = 0, ukRedirectNetProfit = 0;
        const ukRedirectAsins = [];
        children.forEach(r => {
          const asin = (r.ASIN || '').trim();
          const info = country === 'pan_eu' ? (PAN_EU_TOC[asin] && PAN_EU_TOC[asin][marketplace]) : MAPPING[asin];
          if (!info) { skippedUnmapped++; if (asin) skippedUnmappedAsins.push(asin); return; }
          const stage = computeStageForMonth(info, month);
          if (stage !== 'F3M') { skippedNonF3M++; return; }
          if (country === 'pan_eu' && UK_ASINS.has(asin)) {
            ukRedirectSales += cleanNumber(r.Sales); ukRedirectUnits += cleanNumber(r.Units); ukRedirectNetProfit += cleanNumber(r['Net profit']);
            ukRedirectAsins.push(asin);
          } else {
            sales += cleanNumber(r.Sales); units += cleanNumber(r.Units); net_profit += cleanNumber(r['Net profit']);
            matchedAsins.push(asin);
          }
          matched++;
        });
        resolve({
          sales, units, net_profit, sku_count: matchedAsins.length, matched, skippedNonF3M, skippedUnmapped, matchedAsins, skippedUnmappedAsins,
          ukRedirect: { sales: ukRedirectSales, units: ukRedirectUnits, net_profit: ukRedirectNetProfit, asins: ukRedirectAsins },
        });
      },
      error: (err) => reject(err),
    });
  });
}

function sumContributions(contributions) {
  const out = { sales: 0, units: 0, net_profit: 0, sku_count: 0 };
  const allAsins = new Set();
  for (const c of Object.values(contributions || {})) {
    out.sales += c.sales; out.units += c.units; out.net_profit += c.net_profit;
    (c.asins || []).forEach(a => allAsins.add(a));
  }
  out.sku_count = allAsins.size;
  return { totals: out, asins: Array.from(allAsins) };
}

async function applyCountryUpload(file, country, marketplace) {
  // country: 'germany' | 'pan_eu'. marketplace: required for 'pan_eu' --
  // which specific marketplace this file represents (e.g. "France").
  const month = guessMonthFromFilename(file.name);
  if (!month) return { file: file.name, ok: false, msg: `Couldn't detect a month from this filename.` };
  if (country === 'pan_eu' && !marketplace) return { file: file.name, ok: false, msg: `Pick which marketplace this file is for (dropdown above the drop zone) before uploading.` };

  let data = (CURRENT && CURRENT.month === month) ? CURRENT : await loadMonth(month);
  if (!data) return { file: file.name, ok: false, msg: `No data for ${month} yet -- upload and save its main export first (Track: R&D/Brand Manager still need that file).` };

  let totals;
  try { totals = await parseCountryF3MFile(file, month, country, marketplace); }
  catch (err) { return { file: file.name, ok: false, msg: `Couldn't read this file: ${err.message}` }; }

  if (country === 'pan_eu' && totals.skippedUnmappedAsins.length) {
    await addPanEuPendingAsins(marketplace, totals.skippedUnmappedAsins); // surfaced in the Pan-EU TOC tab -- fill in a Launch Date there, not typed from memory
  }

  data = JSON.parse(JSON.stringify(data));
  const key = country === 'germany' ? 'germany' : 'pan_eu';

  // Per-file contribution tracking, keyed by (marketplace, filename) for
  // Pan-EU -- the SAME ASIN can appear in multiple marketplace files, and
  // multiple DISTINCT marketplace files ADD together (e.g. France + Italy
  // both rolling up into "Pan-EU"); re-uploading the SAME marketplace +
  // filename (a correction) REPLACES only that one file's own prior
  // contribution instead of double-counting it. Keying by marketplace too
  // (not just filename) means two marketplaces' files named identically
  // still can't collide with each other.
  //
  // parseCountryF3MFile always splits out UK-listed ASINs into their own
  // bucket, regardless of which zone the file was uploaded into -- for a
  // Germany upload that's wrong to leave split: UK revenue uploaded
  // THROUGH THE GERMANY ZONE is already exactly where it belongs, so it
  // gets merged straight back into this file's own contribution rather
  // than being treated as something to "redirect" (that only makes sense
  // starting from a Pan-EU upload). This was a real bug: uploading a
  // combined Germany+UK file into the Germany zone was silently dropping
  // the UK-listed ASINs' revenue entirely, since the only code that put
  // the split-out bucket back only ran for country === 'pan_eu'.
  let ownSales = totals.sales, ownUnits = totals.units, ownNetProfit = totals.net_profit;
  let ownAsins = totals.matchedAsins;
  if (country === 'germany' && totals.ukRedirect.asins.length) {
    ownSales += totals.ukRedirect.sales; ownUnits += totals.ukRedirect.units; ownNetProfit += totals.ukRedirect.net_profit;
    ownAsins = [...ownAsins, ...totals.ukRedirect.asins];
  }
  const contributionKey = country === 'pan_eu' ? `${marketplace}::${file.name}` : file.name;
  data.launch_manager[`${key}_contributions`] = data.launch_manager[`${key}_contributions`] || {};
  data.launch_manager[`${key}_contributions`][contributionKey] = {
    sales: ownSales, units: ownUnits, net_profit: ownNetProfit, asins: ownAsins, marketplace: country === 'pan_eu' ? marketplace : undefined,
  };

  let redirectMsg = '';
  if (country === 'pan_eu') {
    // UK-redirect is tracked as this SAME file's own entry in Germany's
    // contributions (keyed off this marketplace+filename too) -- so it
    // follows the exact same add-once/replace-on-reupload rule, never duplicating.
    data.launch_manager.germany_contributions = data.launch_manager.germany_contributions || {};
    const redirectKey = `${contributionKey}::uk_redirect`;
    if (totals.ukRedirect.asins.length) {
      data.launch_manager.germany_contributions[redirectKey] = {
        sales: totals.ukRedirect.sales, units: totals.ukRedirect.units, net_profit: totals.ukRedirect.net_profit, asins: totals.ukRedirect.asins,
      };
      redirectMsg = ` ${totals.ukRedirect.asins.length} ASIN(s) also listed on Amazon.co.uk were redirected to Germany instead (€${totals.ukRedirect.sales.toFixed(2)}), per policy — UK sales always count as Germany, never Pan-EU.`;
    } else {
      delete data.launch_manager.germany_contributions[redirectKey]; // this file has no UK ASINs (or none anymore, if re-uploaded) -- don't leave a stale redirect behind
    }
  }

  // Migrate any pre-existing "legacy" actual (set before per-file
  // contribution tracking existed) into the contributions system before
  // summing -- otherwise a month whose Germany (or Pan-EU) total was set
  // the OLD way, with no matching contributions entry, would get wiped
  // to zero here just because a DIFFERENT country's file was uploaded.
  // This was a real bug: uploading only Pan-EU was recomputing Germany's
  // total from (empty) contributions and overwriting real data with zero.
  function migrateLegacyIfNeeded(countryKey) {
    const contributions = data.launch_manager[`${countryKey}_contributions`];
    const hasContributions = contributions && Object.keys(contributions).length;
    const legacyActual = data.launch_manager[`actual_${countryKey}`];
    const wasRealUpload = data.launch_manager[`${countryKey}_source`] === 'dedicated_upload';
    if (!hasContributions && wasRealUpload && legacyActual && legacyActual.sales) {
      data.launch_manager[`${countryKey}_contributions`] = data.launch_manager[`${countryKey}_contributions`] || {};
      data.launch_manager[`${countryKey}_contributions`]['__legacy__'] = {
        sales: legacyActual.sales, units: legacyActual.units, net_profit: legacyActual.net_profit,
        asins: data.launch_manager[`${countryKey}_asins`] || [],
      };
    }
  }
  migrateLegacyIfNeeded('germany');
  migrateLegacyIfNeeded('pan_eu');

  // Recompute both countries' totals fresh from ALL tracked
  // contributions -- never from just this one file -- so multiple
  // distinct uploads correctly combine.
  const panEuSum = sumContributions(data.launch_manager.pan_eu_contributions);
  data.launch_manager.actual_pan_eu = panEuSum.totals;
  data.launch_manager.pan_eu_asins = panEuSum.asins;
  if (Object.keys(data.launch_manager.pan_eu_contributions || {}).length) data.launch_manager.pan_eu_source = 'dedicated_upload';

  const germanySum = sumContributions(data.launch_manager.germany_contributions);
  data.launch_manager.actual_germany = germanySum.totals;
  data.launch_manager.germany_asins = germanySum.asins;
  if (Object.keys(data.launch_manager.germany_contributions || {}).length) data.launch_manager.germany_source = 'dedicated_upload';

  data = applyTargetsAndTiers(data, false, await loadMonthlyTargets(month));

  const saveResult = await saveMonthData(data);
  if (CURRENT && CURRENT.month === month) { CURRENT = data; render(CURRENT, 'monthly'); populateMarketplaceInputs(CURRENT); if (document.getElementById('tabQuarterly').style.display !== 'none') await renderQuarterlyTab(); }

  const countryLabel = country === 'germany' ? 'Germany' : `Pan-EU`;
  const newTotal = country === 'germany' ? germanySum.totals.sales : panEuSum.totals.sales;
  const fileCount = Object.keys(data.launch_manager[`${key}_contributions`]).length;
  const marketplaceNote = country === 'pan_eu' ? ` (${marketplace})` : '';
  let msg = `${formatMonthLabel(month)}: this${marketplaceNote} file contributed €${ownSales.toFixed(2)} from ${ownAsins.length} F3M product(s). ${countryLabel} total is now €${newTotal.toFixed(2)} across ${fileCount} file(s).${redirectMsg} Saved ${saveResult.shared ? 'to the shared repo' : 'locally only (API unavailable)'}.`;
  if (country === 'pan_eu' && totals.skippedUnmappedAsins.length) {
    msg += ` ${totals.skippedUnmappedAsins.length} ASIN(s) not yet in the Pan-EU TOC for "${marketplace}" — added to the pending list in the Pan-EU TOC tab, just needs a Launch Date.`;
  }
  // If the result is suspiciously zero, say exactly why instead of leaving it a mystery.
  if (totals.matched === 0) {
    const totalRows = totals.matched + totals.skippedNonF3M + totals.skippedUnmapped;
    if (totalRows === 0) {
      msg += ` ⚠ The file itself had zero child rows (every row's SKU column was empty) — this looks like it might be a parent-only export, or the wrong file.`;
    } else {
      const tocName = country === 'pan_eu' ? `the Pan-EU TOC for marketplace "${marketplace}"` : 'the main TOC mapping';
      msg += ` ⚠ ${totalRows} row(s) were in the file, but none matched: ${totals.skippedUnmapped} ASIN(s) aren't in ${tocName} at all, ${totals.skippedNonF3M} ASIN(s) ARE in it but weren't computed as F3M for ${formatMonthLabel(month)} (they may be a different stage, or not launched yet).`;
    }
  }
  return { file: file.name, ok: true, msg };
}

async function handleCountryFiles(fileList, country) {
  const statusElId = country === 'germany' ? 'germanyUploadStatus' : 'panEuUploadStatus';
  const statusEl = document.getElementById(statusElId);
  const files = Array.from(fileList);
  if (!files.length) return;
  const marketplace = country === 'pan_eu' ? document.getElementById('panEuMarketplaceSelect').value : undefined;
  if (country === 'pan_eu' && !marketplace) {
    statusEl.innerHTML = `<div class="banner error">Pick which marketplace these file(s) are for (dropdown above) before uploading — add marketplaces in the Pan-EU TOC tab first if the list is empty.</div>`;
    return;
  }
  statusEl.innerHTML = `<div class="banner info">Processing ${files.length} file(s)…</div>`;
  const log = [];
  for (const file of files) {
    log.push(await applyCountryUpload(file, country, marketplace));
  }
  await refreshMonthList();
  statusEl.innerHTML = log.map(l => `<div class="banner ${l.ok ? 'info' : 'error'}" style="margin-top:6px;"><b>${l.file}:</b> ${l.msg}</div>`).join('');
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
    const stage = computeStageForMonth(info, month);
    if (!stage) { rec.reason = 'future_launch_or_unknown'; unmapped.push(rec); return; } // launch date is after this month, or genuinely undetermined -- don't silently lose this revenue
    rec.brand = info.brand; rec.stage = stage; rec.status = info.status; rec.product_code = info.product_code;
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
  const byProduct = {}; // R&D: keyed by matched target product code -- Y1 ONLY (F3M + M4-12), never PY1/Discontinued/Quality Issue, since R&D's bonus is specifically "Y1 revenue overflow" per the framework, not lifetime revenue. A product code can have a mix of ASINs at different stages (e.g. an older variant already PY1 alongside a newer variant still M4-12) -- only the still-Y1 ones count here.
  byAsin.forEach(rec => {
    bump(stageTotals, rec.stage, rec);
    bump(brandStage, `${rec.brand}||${rec.stage}`, rec);
    const rdCode = matchRdCode(rec.product_code);
    if (rdCode && (rec.stage === 'F3M' || rec.stage === 'M4-12')) bump(byProduct, rdCode, rec);
  });

  // Launch Manager's Germany/Pan-EU actuals do NOT come from this file at
  // all -- they come from two dedicated per-country F3M uploads (see
  // applyCountryUpload/handleCountryFiles), since that's real per-country
  // data instead of a guess. This total is the combined F3M pool from
  // whichever export this is, kept for reference/the "Combined" row only.
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

  // If Germany/Pan-EU F3M data or Marketplace figures were already
  // entered separately for this month, carry them forward rather than
  // resetting just because the main file was re-uploaded (e.g. to fix an
  // incomplete export) -- those are independently maintained.
  let priorGermany = null, priorPanEu = null, priorGermanySource = 'pending', priorPanEuSource = 'pending';
  let priorMarketplace = null;
  try {
    const prior = await loadMonth(month);
    if (prior && prior.launch_manager) {
      if (prior.launch_manager.germany_source === 'dedicated_upload') { priorGermany = prior.launch_manager.actual_germany; priorGermanySource = 'dedicated_upload'; }
      if (prior.launch_manager.pan_eu_source === 'dedicated_upload') { priorPanEu = prior.launch_manager.actual_pan_eu; priorPanEuSource = 'dedicated_upload'; }
    }
    if (prior && prior.marketplace && prior.marketplace.entered) { priorMarketplace = prior.marketplace; }
  } catch (e) { /* no prior save, or API unavailable -- fine, start from pending */ }

  const result = {
    month,
    rd_team: { label: 'R&D Team — Y1 products (per product)', by_product: byProduct },
    launch_manager: {
      label: 'Launch Manager — F3M',
      actual_combined: launchPool,
      actual_germany: priorGermany || empty(),
      actual_pan_eu: priorPanEu || empty(),
      germany_source: priorGermanySource, // 'pending' | 'dedicated_upload'
      pan_eu_source: priorPanEuSource,
    },
    brand_manager: brandManager,
    other_brands_unassigned: otherBrandsSeen, // brands with real revenue that AREN'T part of the Brand Manager bonus program (e.g. Van De Boos, MESSEREI, Arganoel Zauber) -- kept visible, not silently dropped
    marketplace: priorMarketplace || {
      label: 'Marketplace — manually entered', entered: false,
      actual_sales: null, green_target: null, gold_target: null,
      actual_margin_pct: null, green_margin_pct: null, gold_margin_pct: null,
      tier: '-', bonus_eur: 0,
    },
    quality_issue_unassigned: qualityIssue,
    meta: {
      total_rows_processed: children.length,
      mapped_rows: byAsin.length,
      unmapped_rows: unmapped.filter(u => u.reason !== 'future_launch_or_unknown').length,
      unmapped_asins: Array.from(new Set(unmapped.filter(u => u.reason !== 'future_launch_or_unknown').map(u => u.asin))).filter(Boolean).sort(),
      // {asin, product} pairs, not just bare ASINs -- needed so the Unmapped ASINs tab can show a useful product name without re-uploading the original file. Deduplicated by ASIN.
      unmapped_details: Object.values(Object.fromEntries(
        unmapped.filter(u => u.reason !== 'future_launch_or_unknown' && u.asin).map(u => [u.asin, { asin: u.asin, product: u.product || '' }])
      )),
      future_launch_rows: unmapped.filter(u => u.reason === 'future_launch_or_unknown').length,
      future_launch_asins: Array.from(new Set(unmapped.filter(u => u.reason === 'future_launch_or_unknown').map(u => u.asin))).filter(Boolean).sort(),
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

  // Launch Manager -- Germany and Pan-EU actuals come from two dedicated
  // per-country F3M uploads (see applyCountryUpload/handleCountryFiles),
  // not from this file or any marketplace-guessing mapping. Whatever is
  // currently in data.launch_manager.actual_germany/actual_pan_eu (real
  // uploaded numbers, or the "pending" empty default) is tiered here.
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
  document.getElementById('periodBadge').textContent = formatMonthLabel(data.month);
  updateTargetsNote(data.month, !!(data._targets_meta && data._targets_meta.used_real_monthly));

  // Data quality
  const futureCount = data.meta.future_launch_rows || 0;
  document.getElementById('dqSummary').textContent =
    `Data quality — ${data.meta.mapped_rows.toLocaleString('en-US')} SKUs mapped, ${data.meta.unmapped_rows} unmapped${futureCount ? `, ${futureCount} pre-launch` : ''}`;
  let dqHtml = '';
  if (data.meta.unmapped_rows) {
    dqHtml += `<p>${data.meta.unmapped_rows} ASIN(s) in this export aren't in the TOC mapping at all, so their revenue is <b>excluded</b> from every track below rather than silently misassigned. Add them to the TOC "ASIN Report" tab and re-upload to include them.</p>
       <div>${data.meta.unmapped_asins.map(a => `<span class="asin-chip">${a}</span>`).join('')}</div>`;
  }
  if (futureCount) {
    dqHtml += `<p style="margin-top:${data.meta.unmapped_rows ? '14px' : '0'};">${futureCount} ASIN(s) are in the TOC but their Launch Date is after ${formatMonthLabel(data.month)} (or has no computable stage) — excluded from every track for this month rather than guessed at.</p>
       <div>${(data.meta.future_launch_asins || []).map(a => `<span class="asin-chip">${a}</span>`).join('')}</div>`;
  }
  if (!dqHtml) dqHtml = `<p>Every SKU in this export matched the TOC mapping and has a computable stage for this month.</p>`;
  document.getElementById('dqBody').innerHTML = dqHtml;
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
    const pendingRow = (label) => `<tr><td class="name">${label}</td><td colspan="8"><span class="tier-tag pending">awaiting dedicated upload</span></td></tr>`;
    document.getElementById('launchBody').innerHTML = `
      ${lm.germany_source === 'dedicated_upload' ? `
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
      </tr>` : pendingRow('Germany')}
      ${lm.pan_eu_source === 'dedicated_upload' ? `
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
      </tr>` : pendingRow('PAN EU')}
      <tr class="total-row-solid">
        <td class="name">Combined (F3M, all marketplaces)</td>
        <td class="num">${fmtEUR(lm.actual_combined.sales)}</td>
        <td class="num">${fmtEUR((lm.germany_target?.green || 0) + (lm.pan_eu_target?.green || 0))}</td>
        <td class="num">${fmtEUR((lm.germany_target?.gold || 0) + (lm.pan_eu_target?.gold || 0))}</td>
        <td class="num">—</td><td class="num">—</td><td class="num">—</td>
        <td>—</td>
        <td class="num">${fmtEUR(lm.combined_bonus_eur || 0)}</td>
      </tr>
    `;
    const bothPending = lm.germany_source !== 'dedicated_upload' && lm.pan_eu_source !== 'dedicated_upload';
    document.getElementById('launchCaveatBanner').style.display = bothPending ? 'flex' : 'none';
    document.getElementById('launchNoteBonus').textContent = bothPending ? '' :
      `Germany and Pan-EU each come from their own dedicated export (Upload tab) — no subtraction or guessing involved. "Combined" is the full F3M pool from the main export, shown for reference only.`;
    document.getElementById('launchMarketplaceDq').style.display = 'none';
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
              <td class="name sub">${displayStageLabel(stageLabel)}</td>
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
async function saveMonthData(data) {
  try {
    const res = await fetch('/api/save-month', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    if (res.ok) {
      const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
      if (local[data.month]) { delete local[data.month]; localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(local)); }
      return { ok: true, shared: true };
    }
    throw new Error('API not available');
  } catch (e) {
    const local = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '{}');
    local[data.month] = data;
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(local));
    return { ok: true, shared: false };
  }
}

async function saveMonth() {
  if (!CURRENT) return;
  const statusEl = document.getElementById('saveStatus');
  const result = await saveMonthData(CURRENT);
  statusEl.textContent = result.shared
    ? `Saved "${CURRENT.month}" to the repo — visible to everyone.`
    : `Saved "${CURRENT.month}" locally in THIS BROWSER ONLY — other people will not see this until the API is deployed (see README).`;
  await refreshMonthList();
}

boot();
