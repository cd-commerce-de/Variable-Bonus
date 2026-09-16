// Shared helpers for api/sellerboard-sync.js. Kept separate from that
// file so the parsing/aggregation logic can be unit-tested on its own.
//
// Wrapped in an IIFE deliberately: this file is loaded TWO ways --
// required as a Node module (api/sellerboard-sync.js, which gets its own
// isolated module scope automatically) AND loaded as a plain <script> in
// the browser (public/vendor/sellerboard-shared.js, a byte-for-byte copy
// of this file), where it shares the SAME global scope as app.js. This
// was a real bug, found live: several names here (STAGE_LABELS,
// BM_GROUPS, cleanNumber, normBrand, and others) are also declared at
// the top level of app.js -- with no wrapper, loading both scripts on
// the same page threw "Identifier 'STAGE_LABELS' has already been
// declared", a SyntaxError that broke the ENTIRE app.js parse (not just
// a runtime warning), taking down every function in it -- including
// tryLogin, hence the passcode screen doing nothing at all when clicked.
// Node's `require()` never caught this because each required module
// already has its own isolated scope; the collision only exists in a
// real browser loading both as sibling <script> tags, which is exactly
// what none of the earlier Node-based tests exercised. The IIFE ensures
// nothing inside leaks into the global scope except the one intended
// export.
(function () {

function parseSemicolonCSV(text) {
  const clean = text.replace(/^\uFEFF/, ''); // strip BOM if present
  const lines = clean.split(/\r\n|\n/).filter(l => l.length);
  const parseLine = (line) => {
    const fields = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ';' && !inQ) { fields.push(cur); cur = ''; continue; }
      cur += c;
    }
    fields.push(cur);
    return fields;
  };
  const header = parseLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseLine(line);
    const obj = {};
    header.forEach((h, i) => obj[h] = vals[i]);
    return obj;
  });
}

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

// Sellerboard's "by product" daily export uses DD/MM/YYYY.
function parseSbDate(d) {
  const parts = String(d || '').split('/');
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts.map(Number);
  if (!dd || !mm || !yyyy) return null;
  return { year: yyyy, month: mm };
}

// Germany/Launch = Amazon.de + Amazon.co.uk, combined into one bucket.
// Every OTHER Amazon.* marketplace found in the file counts as Pan-EU,
// each kept separate by marketplace name for its own Pan-EU TOC lookup.
const GERMANY_MARKETPLACES = new Set(['Amazon.de', 'Amazon.co.uk']);

// The live automatic report is a ROLLING 30-day window, not aligned to
// calendar months -- on any given day it can span the tail end of one
// month and the start of the next. detectMonthsInRows finds every
// distinct "YYYY-MM" actually present so the caller can process each one
// (rather than assuming "the current month" and silently dropping
// whatever rows belong to the other month).
function detectMonthsInRows(rows) {
  const months = new Set();
  for (const r of rows) {
    const d = parseSbDate(r.Date);
    if (d) months.add(`${d.year}-${String(d.month).padStart(2, '0')}`);
  }
  return Array.from(months).sort();
}

// Aggregates the raw daily rows to {asin, marketplace} -> {sales, units,
// net_profit}, filtered to one target month. Sellerboard's "by product"
// format has no single combined Sales/Units column -- the real total is
// SalesOrganic + SalesPPC (see the note inside the function for why
// SalesSponsoredProducts/SalesSponsoredDisplay must NOT also be added).
function aggregateByAsinMarketplace(rows, targetYear, targetMonth) {
  const byKey = {};
  let matchedRows = 0;
  for (const r of rows) {
    const d = parseSbDate(r.Date);
    if (!d || d.year !== targetYear || d.month !== targetMonth) continue;
    matchedRows++;
    const asin = (r.ASIN || '').trim();
    const mp = r.Marketplace;
    if (!asin || !mp) continue;
    // IMPORTANT: SalesPPC is the PARENT category, not a fourth sibling to
    // SalesOrganic/SalesSponsoredProducts/SalesSponsoredDisplay -- it
    // already equals SalesSponsoredProducts + SalesSponsoredDisplay
    // (confirmed directly: across 91,802 real rows, the only ones where
    // SalesPPC != SalesSponsoredProducts are exactly the ones where
    // SalesSponsoredDisplay is non-zero, i.e. PPC = SP + SD every time).
    // Summing all four double-counts every Sponsored Products/Display
    // sale. The correct total is Organic + PPC only. This was a real bug
    // that shipped in an earlier version of this file -- verified the
    // fix by reconciling a real month's total against an independent
    // Sellerboard report (Group by ASIN) that reports the combined
    // figure directly: matched within 0.007% after the fix, versus being
    // ~16% too high before it.
    const sales = cleanNumber(r.SalesOrganic) + cleanNumber(r.SalesPPC);
    const units = cleanNumber(r.UnitsOrganic) + cleanNumber(r.UnitsPPC);
    const netProfit = cleanNumber(r.NetProfit);
    const key = `${asin}||${mp}`;
    if (!byKey[key]) byKey[key] = { asin, marketplace: mp, product: r.Name || '', sales: 0, units: 0, net_profit: 0 };
    byKey[key].sales += sales;
    byKey[key].units += units;
    byKey[key].net_profit += netProfit;
  }
  return { entries: Object.values(byKey), matchedRows, totalRows: rows.length };
}

// Re-groups the (asin, marketplace) entries above into one row per ASIN,
// summed across every marketplace -- this is what feeds R&D and Brand
// Manager, which don't care which marketplace a sale happened on, only
// the combined total (unlike Launch Manager, which needs the split).
// Reuses the exact same entries the marketplace-level aggregation already
// produced rather than re-scanning the raw rows a second time.
function sumEntriesByAsin(entries) {
  const byAsin = {};
  for (const e of entries) {
    if (!byAsin[e.asin]) byAsin[e.asin] = { asin: e.asin, product: e.product || '', sales: 0, units: 0, net_profit: 0 };
    byAsin[e.asin].sales += e.sales;
    byAsin[e.asin].units += e.units;
    byAsin[e.asin].net_profit += e.net_profit;
    if (!byAsin[e.asin].product && e.product) byAsin[e.asin].product = e.product;
  }
  return Object.values(byAsin);
}

// Splits a raw report into one aggregation per calendar month actually
// present -- the live report is a rolling 30-day window, not aligned to
// month boundaries, so a single upload can genuinely span parts of two
// months. Returns { monthBreakdown: { "YYYY-MM": {entries, matchedRows,
// totalRows} }, totalRows }, ready to send to the sync endpoint, which
// then processes and saves each month using ONLY that month's own rows.
function aggregateByMonthAndMarketplace(rows) {
  const months = detectMonthsInRows(rows);
  const monthBreakdown = {};
  for (const month of months) {
    const [year, monthNum] = month.split('-').map(Number);
    const { entries, matchedRows } = aggregateByAsinMarketplace(rows, year, monthNum);
    monthBreakdown[month] = { entries, matchedRows, totalRows: rows.length };
  }
  return { monthBreakdown, totalRows: rows.length, monthsFound: months };
}

function monthIndex(dateStr) {
  const [y, m] = String(dateStr).split('-').map(Number);
  return y * 12 + (m - 1);
}

// Same stage rule as the dashboard's own computeStageForMonth (app.js) --
// month-granularity only, no day-level proration (see README for why).
function computeStageForMonth(info, targetMonth) {
  if (!info) return null;
  if (info.discontinued_start_date && targetMonth >= info.discontinued_start_date.slice(0, 7)) return 'Discontinued';
  if (info.quality_issue_start_date && targetMonth >= info.quality_issue_start_date.slice(0, 7)) return 'Quality Issue';
  if (!info.launch_date) return info.toc_stage_snapshot || null;
  const monthsSince = monthIndex(targetMonth) - monthIndex(info.launch_date);
  if (monthsSince < 0) return null;
  if (monthsSince < 3) return 'F3M';
  if (monthsSince < 12) return 'M4-12';
  return 'PY1';
}

// Splits the aggregated (asin, marketplace) entries into a Germany
// bucket (DE+UK combined, looked up against the MAIN toc) and one
// Pan-EU bucket per non-DE/UK marketplace (each looked up against ITS
// OWN entry in the Pan-EU TOC -- never the main toc, never another
// marketplace's entry for the same ASIN). Only F3M-stage revenue counts,
// same rule as every other Launch Manager path in this app.
function splitIntoF3MContributions(entries, targetMonth, mainToc, panEuToc) {
  const germany = { sales: 0, units: 0, net_profit: 0, asins: new Set() };
  const byMarketplace = {}; // marketplace -> {sales, units, net_profit, asins:Set}
  const skippedUnmapped = { germany: [], byMarketplace: {} };

  for (const e of entries) {
    if (GERMANY_MARKETPLACES.has(e.marketplace)) {
      const info = mainToc[e.asin];
      if (!info) { skippedUnmapped.germany.push(e.asin); continue; }
      if (computeStageForMonth(info, targetMonth) !== 'F3M') continue;
      germany.sales += e.sales; germany.units += e.units; germany.net_profit += e.net_profit;
      germany.asins.add(e.asin);
    } else {
      const mp = e.marketplace;
      const info = panEuToc[e.asin] && panEuToc[e.asin][mp];
      if (!info) {
        skippedUnmapped.byMarketplace[mp] = skippedUnmapped.byMarketplace[mp] || [];
        skippedUnmapped.byMarketplace[mp].push(e.asin);
        continue;
      }
      if (computeStageForMonth(info, targetMonth) !== 'F3M') continue;
      byMarketplace[mp] = byMarketplace[mp] || { sales: 0, units: 0, net_profit: 0, asins: new Set() };
      byMarketplace[mp].sales += e.sales; byMarketplace[mp].units += e.units; byMarketplace[mp].net_profit += e.net_profit;
      byMarketplace[mp].asins.add(e.asin);
    }
  }

  const toPlain = (b) => ({ sales: b.sales, units: b.units, net_profit: b.net_profit, asins: Array.from(b.asins) });
  const panEu = {};
  for (const [mp, b] of Object.entries(byMarketplace)) panEu[mp] = toPlain(b);
  return { germany: toPlain(germany), panEu, skippedUnmapped };
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

// ---------- R&D / Brand Manager computation, ported from computeFromRows
// in public/app.js -- kept in exact lockstep with that function's logic
// (same grouping rules, same stage exclusions, same "other brands" and
// "unmapped" handling) so a Sellerboard-sync-computed month and a
// manually-uploaded month are computed identically, just from a
// different raw source format. Only the INPUT differs: computeFromRows
// reads one row per ASIN from a monthly aggregate file; this reads
// already-summed {asin, product, sales, units, net_profit} entries
// (see sumEntriesByAsin above) derived from the daily per-marketplace
// report. Deliberately does NOT apply targets/tiers -- exactly like a
// manually-saved month, that happens fresh on every load
// (applyTargetsAndTiers in app.js), not baked in at save time. ----------
const BM_GROUPS = {
  'BM1': ['Tarpofix', 'Darwin', 'Planenfux'],
  'BM2': ['Heimfleiss', 'Mattenheld'],
  'BM3': ['PD'],
  'BM4': ['Nasswerk', 'PoolLöwe', 'TeichHeld'],
};
const OFFICIAL_BM_BRANDS = Object.values(BM_GROUPS).flat();
const STAGE_LABELS = { 'PY1': 'PY1', 'M4-12': 'Y1 (F4-12)', 'Discontinued': 'Discontinued', 'F3M': 'F3M', 'Quality Issue': 'Quality Issue (unassigned)' };

function normBrand(b) { return (b || '').trim().toLowerCase(); }
function officialBrandGroup(brandName) {
  const nb = normBrand(brandName);
  for (const [group, brands] of Object.entries(BM_GROUPS)) {
    if (brands.some(b => normBrand(b) === nb)) return group;
  }
  return null;
}
function matchRdCode(tocCode, rdTeamTargets) {
  if (!tocCode) return null;
  if (rdTeamTargets[tocCode]) return tocCode;
  for (const targetCode of Object.keys(rdTeamTargets)) {
    if (tocCode.startsWith(targetCode)) return targetCode;
  }
  return null;
}

function computeRdAndBrandManager(monthlyAsinEntries, month, mainToc, rdTeamTargets, brandManagerTargetBrands) {
  const byAsin = [];
  const unmapped = [];

  monthlyAsinEntries.forEach(rec0 => {
    const asin = rec0.asin;
    const info = mainToc[asin];
    const rec = { asin, product: rec0.product, units: rec0.units, sales: rec0.sales, net_profit: rec0.net_profit };
    if (!info) { unmapped.push(rec); return; }
    const stage = computeStageForMonth(info, month);
    if (!stage) { rec.reason = 'future_launch_or_unknown'; unmapped.push(rec); return; }
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
  const byProduct = {}; // R&D: Y1 ONLY (F3M + M4-12), never PY1/Discontinued/Quality Issue
  byAsin.forEach(rec => {
    bump(stageTotals, rec.stage, rec);
    bump(brandStage, `${rec.brand}||${rec.stage}`, rec);
    const rdCode = matchRdCode(rec.product_code, rdTeamTargets);
    if (rdCode && (rec.stage === 'F3M' || rec.stage === 'M4-12')) bump(byProduct, rdCode, rec);
  });

  const launchPoolCombined = stageTotals['F3M'] || empty();
  const qualityIssue = stageTotals['Quality Issue'] || empty();

  const brandsSeen = new Set(byAsin.map(r => normBrand(r.brand)));
  const brandDisplay = {};
  byAsin.forEach(r => { brandDisplay[normBrand(r.brand)] = r.brand; });
  brandManagerTargetBrands.forEach(b => brandsSeen.add(normBrand(b)));

  const brandManager = {};
  const otherBrandsSeen = {};
  brandsSeen.forEach(nb => {
    const displayName = OFFICIAL_BM_BRANDS.find(b => normBrand(b) === nb) || brandDisplay[nb] || nb;
    if (!officialBrandGroup(displayName)) {
      if (brandDisplay[nb]) {
        const total = empty();
        ['PY1', 'M4-12', 'Discontinued'].forEach(stageKey => {
          const d = brandStage[`${brandDisplay[nb]}||${stageKey}`];
          if (d) { total.sales += d.sales; total.units += d.units; total.net_profit += d.net_profit; total.sku_count += d.sku_count; }
        });
        if (total.sku_count > 0) otherBrandsSeen[displayName] = total;
      }
      return;
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

  return {
    rd_team: { label: 'R&D Team — Y1 products (per product)', by_product: byProduct },
    launch_manager_combined: launchPoolCombined,
    brand_manager: brandManager,
    other_brands_unassigned: otherBrandsSeen,
    quality_issue_unassigned: qualityIssue,
    meta: {
      total_asins_processed: monthlyAsinEntries.length,
      mapped_asins: byAsin.length,
      // mapped_rows: renderInner() in app.js reads this exact field name
      // for every saved month regardless of how it was produced -- kept
      // as an explicit second field (not a rename) since mapped_asins is
      // also read directly by the sync endpoint's own response payload,
      // a different context than the saved month data renderInner reads.
      mapped_rows: byAsin.length,
      unmapped_rows: unmapped.filter(u => u.reason !== 'future_launch_or_unknown').length,
      unmapped_asins: Array.from(new Set(unmapped.filter(u => u.reason !== 'future_launch_or_unknown').map(u => u.asin))).filter(Boolean).sort(),
      unmapped_details: Object.values(Object.fromEntries(
        unmapped.filter(u => u.reason !== 'future_launch_or_unknown' && u.asin).map(u => [u.asin, { asin: u.asin, product: u.product || '' }])
      )),
      future_launch_rows: unmapped.filter(u => u.reason === 'future_launch_or_unknown').length,
      future_launch_asins: Array.from(new Set(unmapped.filter(u => u.reason === 'future_launch_or_unknown').map(u => u.asin))).filter(Boolean).sort(),
    },
  };
}

const SellerboardShared = {
  parseSemicolonCSV, cleanNumber, parseSbDate, GERMANY_MARKETPLACES,
  aggregateByAsinMarketplace, sumEntriesByAsin, computeStageForMonth, splitIntoF3MContributions,
  sumContributions, computeRdAndBrandManager, BM_GROUPS, OFFICIAL_BM_BRANDS, STAGE_LABELS,
  normBrand, officialBrandGroup, matchRdCode, detectMonthsInRows, aggregateByMonthAndMarketplace,
};
// Universal export: Node (api/sellerboard-sync.js requires this file
// directly) and browser (public/vendor/sellerboard-shared.js is a
// byte-for-byte copy of this same file, loaded via <script> so the
// Upload tab's file-based sync path can aggregate a report client-side
// before sending it -- the raw reports run 60+ MB, well over Vercel's
// serverless body-size limit, so sending pre-aggregated {asin,
// marketplace, sales, units, net_profit} entries instead of raw CSV text
// is not an optimization, it's required for this to work at all.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SellerboardShared;
} else {
  window.SellerboardShared = SellerboardShared;
}

})();
