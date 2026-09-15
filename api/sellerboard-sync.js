// GET/POST /api/sellerboard-sync?month=YYYY-MM (month optional, defaults
// to the current server month)
//
// Pulls the Sellerboard "by product" daily export (SELLERBOARD_REPORT_URL,
// a stable report link from Sellerboard's automatic-upload/report-link
// feature) and updates R&D, Brand Manager, AND Launch Manager for the
// target month from that ONE report -- not just Launch Manager. Same
// effect as manually uploading the main monthly export (for R&D/Brand
// Manager) plus a Germany file plus one Pan-EU file per marketplace (for
// Launch Manager), all from a single source. Can create a month from
// scratch if it doesn't exist yet -- it no longer requires a manual main
// upload first.
//
// Germany/Launch = Amazon.de + Amazon.co.uk combined, looked up against
// the main TOC. Every other Amazon.* marketplace present in the report
// counts as Pan-EU, each looked up against ITS OWN entry in the Pan-EU
// TOC (never the main TOC, never another marketplace's entry for the
// same ASIN) -- identical rule to the manual Pan-EU upload flow. R&D and
// Brand Manager are computed from the SAME report, summed across every
// marketplace (they don't care which marketplace a sale happened on),
// using the exact same grouping logic as a manual main-file upload (see
// computeRdAndBrandManager in _sellerboard.js, ported line-for-line from
// computeFromRows in app.js) -- just fed a different raw source format.
//
// Deliberately does NOT touch: Marketplace (manually entered, carried
// forward untouched), or any Germany/Pan-EU contribution from a
// DIFFERENT source (e.g. a manually-uploaded Pan-EU file for a
// marketplace this report doesn't cover) -- those keep adding
// independently, same contribution-based rule as everywhere else in this
// app (see "Multiple files combine, not overwrite").
//
// Callable two ways:
//  - By Vercel Cron on a schedule (see vercel.json) -- Vercel sends
//    `Authorization: Bearer $CRON_SECRET` automatically when CRON_SECRET
//    is set as an env var; this is Vercel's own documented convention.
//  - By the "Force Update Now" button in the dashboard, from an
//    authenticated browser session (checked via the same session cookie
//    as every other endpoint).
// Only ONE of these needs to succeed for the request to be authorized.
const { isValidSession } = require('./_auth');
const {
  parseSemicolonCSV, aggregateByAsinMarketplace, sumEntriesByAsin, splitIntoF3MContributions,
  sumContributions, computeRdAndBrandManager,
} = require('./_sellerboard');

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const TOKEN = process.env.GITHUB_TOKEN;
const REPORT_URL = process.env.SELLERBOARD_REPORT_URL;
const CRON_SECRET = process.env.CRON_SECRET;

function isAuthorizedCron(req) {
  if (!CRON_SECRET) return false;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${CRON_SECRET}`;
}

async function ghFetchRaw(path) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`;
  return fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' } });
}
async function ghFetchJson(path) {
  const r = await ghFetchRaw(path);
  if (!r.ok) return null;
  const file = await r.json();
  return JSON.parse(Buffer.from(file.content, 'base64').toString('utf-8'));
}
async function ghSaveJson(path, obj, commitMessage) {
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' };
  let sha;
  const existing = await fetch(`${apiUrl}?ref=${BRANCH}`, { headers });
  if (existing.ok) sha = (await existing.json()).sha;
  const contentB64 = Buffer.from(JSON.stringify(obj, null, 1)).toString('base64');
  const commitRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: commitMessage, content: contentB64, branch: BRANCH, ...(sha ? { sha } : {}) }),
  });
  if (!commitRes.ok) throw new Error(`GitHub commit failed for ${path}: ${await commitRes.text()}`);
}

// Mirrors app.js's own migrateLegacyIfNeeded -- a month whose Germany or
// Pan-EU total was set before per-file contribution tracking existed (no
// matching contributions entry) must have that total preserved as a
// legacy contribution before this sync recomputes totals, or it would be
// silently wiped to zero (this was a real bug, fixed once already for
// the manual-upload path -- the sync path needs the identical guard).
function migrateLegacyIfNeeded(launchManager, key) {
  const contributions = launchManager[`${key}_contributions`];
  const hasContributions = contributions && Object.keys(contributions).length;
  const legacyActual = launchManager[`actual_${key}`];
  const wasRealUpload = launchManager[`${key}_source`] === 'dedicated_upload';
  if (!hasContributions && wasRealUpload && legacyActual && legacyActual.sales) {
    launchManager[`${key}_contributions`] = launchManager[`${key}_contributions`] || {};
    launchManager[`${key}_contributions`]['__legacy__'] = {
      sales: legacyActual.sales, units: legacyActual.units, net_profit: legacyActual.net_profit,
      asins: launchManager[`${key}_asins`] || [],
    };
  }
}

function emptyTotals() { return { sales: 0, units: 0, net_profit: 0, sku_count: 0 }; }

module.exports = async (req, res) => {
  const authorized = isAuthorizedCron(req) || isValidSession(req);
  if (!authorized) return res.status(401).json({ error: 'Not authenticated' });
  if (!OWNER || !REPO || !TOKEN) return res.status(500).json({ error: 'Server not configured: set GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN.' });

  // A client-aggregated report (req.body.aggregatedEntries, from the
  // "Upload a report file" option in the Upload tab) takes priority over
  // fetching SELLERBOARD_REPORT_URL when both are present -- lets this
  // run today, before the live link is configured, and lets a past month
  // be backfilled from a file even after automation is live (the live
  // URL only ever returns the current month's data). Pre-aggregated,
  // not raw CSV text: real reports run 60+ MB, well over Vercel's
  // serverless body-size limit, so the browser parses and aggregates the
  // file (using the exact same code as this file, see
  // public/vendor/sellerboard-shared.js) before sending only the much
  // smaller {asin, marketplace, sales, units, net_profit} result here.
  const uploadedEntries = req.body && Array.isArray(req.body.aggregatedEntries) ? req.body.aggregatedEntries : null;
  if (!uploadedEntries && !REPORT_URL) {
    return res.status(500).json({ error: 'Server not configured: set SELLERBOARD_REPORT_URL, or upload a report file directly instead.' });
  }

  const now = new Date();
  const month = (req.query && req.query.month && /^\d{4}-\d{2}$/.test(req.query.month))
    ? req.query.month
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const [targetYear, targetMonthNum] = month.split('-').map(Number);

  let entries, matchedRows, totalRows;
  if (uploadedEntries) {
    entries = uploadedEntries;
    matchedRows = (req.body.reportMeta && req.body.reportMeta.matchedRows) || entries.length;
    totalRows = (req.body.reportMeta && req.body.reportMeta.totalRows) || entries.length;
  } else {
    let reportText;
    try {
      const reportRes = await fetch(REPORT_URL);
      if (!reportRes.ok) return res.status(502).json({ error: `Sellerboard report fetch failed: HTTP ${reportRes.status}` });
      reportText = await reportRes.text();
    } catch (err) {
      return res.status(502).json({ error: `Couldn't reach the Sellerboard report URL: ${err.message}` });
    }
    let rows;
    try {
      rows = parseSemicolonCSV(reportText);
    } catch (err) {
      return res.status(502).json({ error: `Couldn't parse the Sellerboard report: ${err.message}` });
    }
    ({ entries, matchedRows, totalRows } = aggregateByAsinMarketplace(rows, targetYear, targetMonthNum));
  }

  const [mainToc, targets, panEuTocFile, existingMonth] = await Promise.all([
    ghFetchJson('public/toc_mapping.json'),
    ghFetchJson('public/targets.json'),
    ghFetchJson('data/_pan_eu_toc.json'),
    ghFetchJson(`data/${month}.json`),
  ]);
  if (!mainToc) return res.status(502).json({ error: 'Could not load the main TOC (public/toc_mapping.json) from the repo.' });
  if (!targets) return res.status(502).json({ error: 'Could not load targets (public/targets.json) from the repo -- needed to match R&D product codes and know which brands to include even at zero.' });
  const panEuToc = (panEuTocFile && panEuTocFile.entries) ? panEuTocFile.entries : {};

  // ---- Launch Manager: Germany (DE+UK) / Pan-EU (per marketplace) ----
  const split = splitIntoF3MContributions(entries, month, mainToc, panEuToc);

  // ---- R&D + Brand Manager: summed across every marketplace ----
  const monthlyEntries = sumEntriesByAsin(entries);
  const rdBm = computeRdAndBrandManager(monthlyEntries, month, mainToc, targets.rd_team || {}, Object.keys(targets.brand_manager || {}));

  // Start from the existing month if there is one (preserves anything
  // sync doesn't touch: Marketplace manual entries, any independently
  // manually-uploaded Germany/Pan-EU contributions from a source this
  // report doesn't cover); otherwise start fresh -- this sync no longer
  // requires a manual main-file upload to have happened first.
  const data = existingMonth ? JSON.parse(JSON.stringify(existingMonth)) : {
    month,
    launch_manager: { label: 'Launch Manager — F3M', germany_source: 'pending', pan_eu_source: 'pending', actual_germany: emptyTotals(), actual_pan_eu: emptyTotals() },
    marketplace: { label: 'Marketplace — manually entered', entered: false, actual_sales: null, green_target: null, gold_target: null, actual_margin_pct: null, green_margin_pct: null, gold_margin_pct: null, tier: '-', bonus_eur: 0 },
  };
  data.month = month;
  data.launch_manager = data.launch_manager || {};
  const lm = data.launch_manager;

  migrateLegacyIfNeeded(lm, 'germany');
  migrateLegacyIfNeeded(lm, 'pan_eu');

  lm.germany_contributions = lm.germany_contributions || {};
  lm.germany_contributions['sellerboard-sync::germany'] = { sales: split.germany.sales, units: split.germany.units, net_profit: split.germany.net_profit, asins: split.germany.asins };

  lm.pan_eu_contributions = lm.pan_eu_contributions || {};
  // Clear out any previous sync-sourced Pan-EU marketplace entries first
  // -- a marketplace with zero F3M ASINs this run must not keep a stale
  // contribution from a prior run under the same key.
  Object.keys(lm.pan_eu_contributions).forEach(k => { if (k.startsWith('sellerboard-sync::')) delete lm.pan_eu_contributions[k]; });
  for (const [mp, v] of Object.entries(split.panEu)) {
    lm.pan_eu_contributions[`sellerboard-sync::${mp}`] = { sales: v.sales, units: v.units, net_profit: v.net_profit, asins: v.asins };
  }

  const germanySum = sumContributions(lm.germany_contributions);
  lm.actual_germany = germanySum.totals;
  lm.germany_asins = germanySum.asins;
  if (Object.keys(lm.germany_contributions).length) lm.germany_source = 'dedicated_upload';

  const panEuSum = sumContributions(lm.pan_eu_contributions);
  lm.actual_pan_eu = panEuSum.totals;
  lm.pan_eu_asins = panEuSum.asins;
  if (Object.keys(lm.pan_eu_contributions).length) lm.pan_eu_source = 'dedicated_upload';

  // "Combined" reference row -- the whole F3M pool from this report,
  // before any per-country split, same as computeFromRows produces from
  // a manual main-file upload.
  lm.actual_combined = rdBm.launch_manager_combined;

  // R&D + Brand Manager sections: this sync IS the source of truth for
  // these now, same as a manual main-file upload would be -- replaced
  // wholesale each run, not merged/accumulated (re-running the sync for
  // the same month should give the same answer, not a growing one).
  data.rd_team = rdBm.rd_team;
  data.brand_manager = rdBm.brand_manager;
  data.other_brands_unassigned = rdBm.other_brands_unassigned;
  data.quality_issue_unassigned = rdBm.quality_issue_unassigned;
  data.meta = rdBm.meta;

  // Marketplace (fully manual) is never touched by this sync -- carried
  // forward exactly as-is, same rule computeFromRows already follows for
  // a manual main-file re-upload.
  data.marketplace = data.marketplace || { label: 'Marketplace — manually entered', entered: false, actual_sales: null, green_target: null, gold_target: null, actual_margin_pct: null, green_margin_pct: null, gold_margin_pct: null, tier: '-', bonus_eur: 0 };

  data._sellerboard_sync = {
    last_synced_at: new Date().toISOString(),
    report_rows_total: totalRows,
    report_rows_matched_month: matchedRows,
    unmapped_germany_asins: split.skippedUnmapped.germany.length,
    unmapped_pan_eu_by_marketplace: Object.fromEntries(Object.entries(split.skippedUnmapped.byMarketplace).map(([mp, a]) => [mp, a.length])),
  };

  try {
    await ghSaveJson(`data/${month}.json`, data, `Sellerboard sync: update R&D, Brand Manager, and Launch Manager for ${month}`);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  res.status(200).json({
    ok: true,
    month,
    was_new_month: !existingMonth,
    germany: { sales: germanySum.totals.sales, asin_count: germanySum.asins.length },
    pan_eu: { sales: panEuSum.totals.sales, asin_count: panEuSum.asins.length, by_marketplace: Object.fromEntries(Object.entries(split.panEu).map(([mp, v]) => [mp, { sales: v.sales, asin_count: v.asins.length }])) },
    rd_products_found: Object.keys(rdBm.rd_team.by_product).length,
    brand_manager_brands_found: Object.keys(rdBm.brand_manager).length,
    report_rows_total: totalRows,
    report_rows_matched_month: matchedRows,
    mapped_asins: rdBm.meta.mapped_asins,
    unmapped_asins: rdBm.meta.unmapped_asins.length,
    unmapped_germany_asins: split.skippedUnmapped.germany.length,
    unmapped_pan_eu_by_marketplace: Object.fromEntries(Object.entries(split.skippedUnmapped.byMarketplace).map(([mp, a]) => [mp, a.length])),
  });
};
