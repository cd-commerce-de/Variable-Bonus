// Shared helpers for api/sellerboard-sync.js. Kept separate from that
// file so the parsing/aggregation logic can be unit-tested on its own.

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
    if (!byKey[key]) byKey[key] = { asin, marketplace: mp, sales: 0, units: 0, net_profit: 0 };
    byKey[key].sales += sales;
    byKey[key].units += units;
    byKey[key].net_profit += netProfit;
  }
  return { entries: Object.values(byKey), matchedRows, totalRows: rows.length };
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

const SellerboardShared = {
  parseSemicolonCSV, cleanNumber, parseSbDate, GERMANY_MARKETPLACES,
  aggregateByAsinMarketplace, computeStageForMonth, splitIntoF3MContributions,
  sumContributions,
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
