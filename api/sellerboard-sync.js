// POST /api/sellerboard-sync?month=YYYY-MM (month optional for a manual
// file upload -- if omitted, EVERY distinct month found in the uploaded
// data is processed. Ignored for the automatic/live path, which ONLY
// ever processes the current calendar month regardless -- see below)
//
// Updates R&D, Brand Manager, AND Launch Manager for the target month(s)
// from a Sellerboard "by product" report -- not just Launch Manager.
// Same effect as manually uploading the main monthly export (for R&D/
// Brand Manager) plus a Germany file plus one Pan-EU file per
// marketplace (for Launch Manager), all from a single source. Can create
// a month from scratch if it doesn't exist yet -- it no longer requires
// a manual main upload first.
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
// forward untouched). It REPLACES -- never adds to -- any Germany total
// already saved for the month (an earlier manual upload or previous sync),
// since keeping an older total next to the sync's would count the same
// revenue twice. Pan-EU is replaced only when the sync actually produced
// Pan-EU data (it depends on the Pan-EU TOC tab); otherwise an existing
// Pan-EU total is left as-is and reported in `kept_contributions`. Whatever
// was replaced is returned in `replaced_contributions` so the dashboard
// says so rather than overwriting silently.
//
// ============================================================
// WHY THE AUTOMATIC/LIVE PATH IS RESTRICTED TO THE CURRENT MONTH ONLY
// ============================================================
// The live Sellerboard report is a ROLLING 30-day window, not aligned to
// calendar months. A 30-day window can never fully contain a 31-day
// month, and as days roll off the window, a CLOSED month's early days
// eventually fall out of every later day's snapshot entirely. Concretely
// (verified with real dates): a sync on Sept 1st sees 29 of August's 31
// days; by Sept 10th, only 20; by Sept 20th, only 10; by Sept 30th, 0.
// If the automatic path were allowed to re-save a CLOSED month like
// this, that month's figures would get WORSE every single day, not
// better -- the opposite of converging on a stable answer, and a real
// risk to bonus figures already paid out or reported on.
//
// The current, still-IN-PROGRESS month has the opposite property: since
// it isn't over yet, every one of its days that exists at all is still
// within the 30-day window (a window can't be shorter than "since day 1
// of a month that started fewer than 30 days ago"). So the current
// month's synced figures can only ever gain days and grow MORE complete
// as the month goes on -- never lose them. That's what makes it safe to
// automate: syncGuardCurrentMonthOnly below enforces that the automatic/
// live path NEVER writes to any month other than whichever one is
// current on the server's clock at the moment it runs, discarding any
// other month's rows that happen to also be present in the same report.
//
// A CLOSED month always needs a real, accurate export uploaded manually
// (the Upload tab's file option, which has no such restriction and can
// process or backfill any month, closed or not) -- there's no way around
// that from the rolling report alone; it would require permanently
// caching every individual day's own figures somewhere and re-summing
// across cached days, a genuinely different and much larger design than
// re-running this aggregation on whatever the latest snapshot contains.
// ============================================================
//
// Two ways to trigger a sync:
//  - Automatically, via Vercel Cron on a schedule (vercel.json) -- Vercel
//    sends `Authorization: Bearer $CRON_SECRET` automatically when
//    CRON_SECRET is set as an env var (Vercel's own documented
//    convention). Always restricted to the current month only (see
//    above) -- the ?month= query param is ignored on this path.
//  - Manually, via the Upload tab's "Upload a report file" option, from
//    an authenticated browser session. Not restricted -- processes every
//    month found in the uploaded file (or one specific month via
//    ?month=), since a person deliberately choosing which real file to
//    upload is exactly the judgment call that makes it safe to touch a
//    closed month.
const { isValidSession } = require('./_auth');
const {
  parseSemicolonCSV, aggregateByAsinMarketplace, sumEntriesByAsin, splitIntoF3MContributions,
  sumContributions, computeRdAndBrandManager, detectMonthsInRows,
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

function currentServerMonth() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function ghFetchRaw(path) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`;
  return fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' } });
}
async function ghFetchJson(path) {
  // GitHub's Contents API only inlines `content` for files under 1 MB --
  // above that it's omitted entirely (this repo's toc_mapping.json is
  // ~1.16 MB, so this isn't a hypothetical edge case, it's the normal
  // case for that specific file). Falling back to the response's own
  // download_url (always present, works without a separate auth header --
  // GitHub signs a short-lived token into the URL itself for a private
  // repo) fetches the real content directly instead. This whole function
  // used to have no error handling at all: a large file's missing
  // `content` field would throw trying to base64-decode `undefined`,
  // uncaught, all the way up through the unguarded Promise.all() that
  // calls this -- which crashes the entire serverless function with
  // Vercel's own generic 500 page (no JSON body for the frontend to show
  // a real message from, just a bare "HTTP 500"). Every failure path
  // here now throws a real Error with a specific message instead, and
  // the caller wraps the whole handler in try/catch so nothing can
  // produce a bare, unexplained 500 again.
  const r = await ghFetchRaw(path);
  if (r.status === 404) return null; // genuinely doesn't exist yet -- a normal, expected case (e.g. no Pan-EU TOC entries saved yet), not an error
  if (!r.ok) throw new Error(`GitHub API returned HTTP ${r.status} fetching ${path} (check GITHUB_TOKEN has read access to this repo)`);
  const file = await r.json();
  let text;
  if (file.content) {
    text = Buffer.from(file.content, 'base64').toString('utf-8');
  } else if (file.download_url) {
    const rawRes = await fetch(file.download_url);
    if (!rawRes.ok) throw new Error(`Couldn't fetch the raw content of ${path} (large file, HTTP ${rawRes.status} from download_url)`);
    text = await rawRes.text();
  } else {
    throw new Error(`GitHub API response for ${path} had neither inline content nor a download_url -- unexpected response shape`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} from the repo isn't valid JSON: ${err.message}`);
  }
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

// Lists every Launch Manager contribution (Germany or Pan-EU) already
// saved for a month, including a pre-contribution-tracking total that only
// exists as actual_germany/actual_pan_eu with no matching entry, so a sync
// can report exactly what it is replacing.
//
// WHY A SYNC REPLACES THESE INSTEAD OF ADDING TO THEM: an earlier version
// deliberately KEPT any existing manual Germany/Pan-EU total (as a
// "__legacy__" contribution, plus any per-file contributions) and added the
// sync's own figure next to it, summing both. That was wrong once the sync
// became the single source for Launch Manager: the report already contains
// Germany (DE+UK) and every Pan-EU marketplace, i.e. exactly the scope the
// old manual uploads covered, so a month that had been filled by a manual
// upload and was then synced counted the same revenue twice. Found live:
// July showed ~EUR 500K for Germany against a correct ~EUR 253K (the same
// report, two different Sellerboard exports, agree on 253,233), because the
// earlier manual total (~246.7K) was still being added on top. The manual
// upload screens no longer exist, so nothing legitimate is left to
// preserve -- the sync is authoritative for these two buckets.
function existingLaunchContributions(lm, country) {
  const out = [];
  const contribs = lm[`${country}_contributions`] || {};
  const keys = Object.keys(contribs);
  for (const k of keys) {
    if (k.startsWith('sellerboard-sync::')) continue; // our own previous run -- expected, not a "replacement"
    out.push({ country, key: k, sales: contribs[k].sales || 0 });
  }
  const legacy = lm[`actual_${country}`];
  if (!keys.length && lm[`${country}_source`] === 'dedicated_upload' && legacy && legacy.sales) {
    out.push({ country, key: '(earlier manual upload, total only)', sales: legacy.sales });
  }
  return out;
}

function emptyTotals() { return { sales: 0, units: 0, net_profit: 0, sku_count: 0 }; }

// Processes ONE month's worth of already-filtered entries: Launch
// Manager split, R&D + Brand Manager computation, merge into that
// month's saved data, and commit. Pulled out as its own function so the
// handler below can call it once per month found in a multi-month
// upload, rather than duplicating this whole block in a loop inline.
async function syncOneMonth(month, entries, matchedRows, totalRows, mainToc, targets, panEuToc) {
  const split = splitIntoF3MContributions(entries, month, mainToc, panEuToc);

  const monthlyEntries = sumEntriesByAsin(entries);
  const rdBm = computeRdAndBrandManager(monthlyEntries, month, mainToc, targets.rd_team || {}, Object.keys(targets.brand_manager || {}));

  const existingMonth = await ghFetchJson(`data/${month}.json`);
  const data = existingMonth ? JSON.parse(JSON.stringify(existingMonth)) : {
    month,
    launch_manager: { label: 'Launch Manager — F3M', germany_source: 'pending', pan_eu_source: 'pending', actual_germany: emptyTotals(), actual_pan_eu: emptyTotals() },
    marketplace: { label: 'Marketplace — manually entered', entered: false, actual_sales: null, green_target: null, gold_target: null, actual_margin_pct: null, green_margin_pct: null, gold_margin_pct: null, tier: '-', bonus_eur: 0 },
  };
  data.month = month;
  data.launch_manager = data.launch_manager || {};
  const lm = data.launch_manager;

  // Germany: the sync computes it completely (DE+UK against the main TOC,
  // the same scope the manual Germany upload had), so anything saved from
  // an earlier upload is replaced -- keeping it would count the revenue
  // twice.
  const replacedContributions = existingLaunchContributions(lm, 'germany');
  lm.germany_contributions = {
    'sellerboard-sync::germany': { sales: split.germany.sales, units: split.germany.units, net_profit: split.germany.net_profit, asins: split.germany.asins },
  };

  // Pan-EU: only replaced when the sync actually produced Pan-EU data.
  // Pan-EU stage comes from the Pan-EU TOC tab (per ASIN + marketplace),
  // which a sync can't create -- until entries exist there, every Pan-EU
  // ASIN in the report is "unmapped" and the sync's Pan-EU is empty. In
  // that case replacing would silently wipe a real earlier total to zero
  // (found on July's saved data: a 63,089 total-only Pan-EU figure with
  // nothing to recompute it from), so it is left untouched and flagged.
  const keptContributions = [];
  const newPanEu = {};
  for (const [mp, v] of Object.entries(split.panEu)) {
    newPanEu[`sellerboard-sync::${mp}`] = { sales: v.sales, units: v.units, net_profit: v.net_profit, asins: v.asins };
  }
  if (Object.keys(newPanEu).length) {
    replacedContributions.push(...existingLaunchContributions(lm, 'pan_eu'));
    lm.pan_eu_contributions = newPanEu;
  } else {
    keptContributions.push(...existingLaunchContributions(lm, 'pan_eu'));
    // drop only our own stale sync entries; leave everything else exactly as it was
    const keep = {};
    for (const [k, v] of Object.entries(lm.pan_eu_contributions || {})) if (!k.startsWith('sellerboard-sync::')) keep[k] = v;
    lm.pan_eu_contributions = keep;
  }

  const germanySum = sumContributions(lm.germany_contributions);
  lm.actual_germany = germanySum.totals;
  lm.germany_asins = germanySum.asins;
  if (Object.keys(lm.germany_contributions).length) lm.germany_source = 'dedicated_upload';

  const panEuSum = sumContributions(lm.pan_eu_contributions);
  lm.actual_pan_eu = panEuSum.totals;
  lm.pan_eu_asins = panEuSum.asins;
  if (Object.keys(lm.pan_eu_contributions).length) lm.pan_eu_source = 'dedicated_upload';

  lm.actual_combined = rdBm.launch_manager_combined;

  data.rd_team = rdBm.rd_team;
  data.brand_manager = rdBm.brand_manager;
  data.other_brands_unassigned = rdBm.other_brands_unassigned;
  data.quality_issue_unassigned = rdBm.quality_issue_unassigned;
  data.meta = rdBm.meta;

  data.marketplace = data.marketplace || { label: 'Marketplace — manually entered', entered: false, actual_sales: null, green_target: null, gold_target: null, actual_margin_pct: null, green_margin_pct: null, gold_margin_pct: null, tier: '-', bonus_eur: 0 };

  data._sellerboard_sync = {
    last_synced_at: new Date().toISOString(),
    report_rows_total: totalRows,
    report_rows_matched_month: matchedRows,
    unmapped_germany_asins: split.skippedUnmapped.germany.length,
    unmapped_pan_eu_by_marketplace: Object.fromEntries(Object.entries(split.skippedUnmapped.byMarketplace).map(([mp, a]) => [mp, a.length])),
    replaced_contributions: replacedContributions,
    kept_contributions: keptContributions,
  };

  await ghSaveJson(`data/${month}.json`, data, `Sellerboard sync: update R&D, Brand Manager, and Launch Manager for ${month}`);

  return {
    month,
    was_new_month: !existingMonth,
    germany: { sales: germanySum.totals.sales, asin_count: germanySum.asins.length },
    pan_eu: { sales: panEuSum.totals.sales, asin_count: panEuSum.asins.length, by_marketplace: Object.fromEntries(Object.entries(split.panEu).map(([mp, v]) => [mp, { sales: v.sales, asin_count: v.asins.length }])) },
    rd_products_found: Object.keys(rdBm.rd_team.by_product).length,
    brand_manager_brands_found: Object.keys(rdBm.brand_manager).length,
    report_rows_matched_month: matchedRows,
    mapped_asins: rdBm.meta.mapped_asins,
    unmapped_asins: rdBm.meta.unmapped_asins.length,
    unmapped_germany_asins: split.skippedUnmapped.germany.length,
    unmapped_pan_eu_by_marketplace: Object.fromEntries(Object.entries(split.skippedUnmapped.byMarketplace).map(([mp, a]) => [mp, a.length])),
    replaced_contributions: replacedContributions,
    kept_contributions: keptContributions,
  };
}

module.exports = async (req, res) => {
  try {
    return await handleSync(req, res);
  } catch (err) {
    // Final safety net: whatever this is, it wasn't caught by any of the
    // more specific try/catches below, which means it would otherwise
    // crash the whole serverless function with Vercel's own generic 500
    // page -- no JSON body, so the frontend has nothing to show but a
    // bare "HTTP 500". This is exactly the failure mode that prompted
    // this whole rewrite (found live: toc_mapping.json is ~1.16 MB,
    // over GitHub's Contents API's 1 MB inline-content limit, and the
    // unguarded JSON.parse/base64-decode of the resulting undefined
    // content threw uncaught, all the way up through an unguarded
    // Promise.all -- see ghFetchJson above for the actual fix to that
    // specific cause; this wrapper is the general-purpose backstop so
    // no OTHER unanticipated throw can ever produce that same
    // undiagnosable symptom again).
    console.error('sellerboard-sync unhandled error:', err);
    return res.status(500).json({ error: `Unexpected server error: ${err.message}. Check Vercel's function logs for the full stack trace.` });
  }
};

async function handleSync(req, res) {
  const isCron = isAuthorizedCron(req);
  const isManual = isValidSession(req);
  if (!isCron && !isManual) return res.status(401).json({ error: 'Not authenticated' });
  if (!OWNER || !REPO || !TOKEN) return res.status(500).json({ error: 'Server not configured: set GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN.' });

  // A manual browser upload always takes priority over a live URL fetch
  // if somehow both are present in one request (shouldn't normally
  // happen, but a manual session token calling this endpoint is always
  // the more deliberate, more trusted action of the two).
  const monthBreakdown = (isManual && req.body && req.body.reportMeta && req.body.reportMeta.monthBreakdown) || null;

  let monthsToProcess, getMonthData;

  if (monthBreakdown) {
    // ---- Manual upload path: full freedom, any month(s), closed or not ----
    if (!Object.keys(monthBreakdown).length) {
      return res.status(400).json({ error: 'No report data received -- use the "Upload a report file" option in the Upload tab.' });
    }
    const restrictToMonth = (req.query && req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : null;
    monthsToProcess = restrictToMonth ? [restrictToMonth] : Object.keys(monthBreakdown).sort();
    getMonthData = (month) => monthBreakdown[month] || null;
  } else {
    // ---- Automatic/live path: current month ONLY, no exceptions ----
    // See the block comment at the top of this file for why. ?month= is
    // deliberately ignored here -- there is no legitimate way to ask this
    // path for anything other than whatever month is current right now.
    if (!REPORT_URL) return res.status(500).json({ error: 'Server not configured: set SELLERBOARD_REPORT_URL, or use the manual file upload instead.' });
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
    const onlyMonth = currentServerMonth();
    const [year, monthNum] = onlyMonth.split('-').map(Number);
    const { entries, matchedRows } = aggregateByAsinMarketplace(rows, year, monthNum);
    monthsToProcess = [onlyMonth];
    getMonthData = () => ({ entries, matchedRows, totalRows: rows.length });
  }

  let mainToc, targets, panEuTocFile;
  try {
    [mainToc, targets, panEuTocFile] = await Promise.all([
      ghFetchJson('public/toc_mapping.json'),
      ghFetchJson('public/targets.json'),
      ghFetchJson('data/_pan_eu_toc.json'),
    ]);
  } catch (err) {
    return res.status(502).json({ error: `Couldn't load required data from the repo: ${err.message}` });
  }
  if (!mainToc) return res.status(502).json({ error: 'Could not load the main TOC (public/toc_mapping.json) from the repo.' });
  if (!targets) return res.status(502).json({ error: 'Could not load targets (public/targets.json) from the repo -- needed to match R&D product codes and know which brands to include even at zero.' });
  const panEuToc = (panEuTocFile && panEuTocFile.entries) ? panEuTocFile.entries : {};

  const results = [];
  for (const month of monthsToProcess) {
    const monthData = getMonthData(month);
    if (!monthData) continue; // restrictToMonth asked for a month not actually present in this file
    try {
      const result = await syncOneMonth(month, monthData.entries, monthData.matchedRows, monthData.totalRows, mainToc, targets, panEuToc);
      results.push({ ok: true, ...result });
    } catch (err) {
      results.push({ ok: false, month, error: err.message });
    }
  }

  res.status(200).json({ ok: results.every(r => r.ok), source: monthBreakdown ? 'manual_upload' : 'automatic_current_month', months: results });
}

