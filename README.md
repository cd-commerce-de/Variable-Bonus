# CD Commerce — Variable Bonus Dashboard

Upload the monthly Sellerboard export, and the dashboard maps every SKU to
its brand/stage/product (from the TOC), pulls Green/Gold targets from your
Variable Bonus Calculator workbook, and computes Tier + Bonus € per track —
with a **Monthly** and **Quarterly** view, mirroring the calculator's own
"All Tracks" layout. No database — data lives as JSON files in this
(private) GitHub repo, and a small Vercel deployment provides login +
serves that data.

## Launch Manager: Germany vs. Pan-EU split

Real, not approximated: each F3M-stage ASIN is joined against an
ASIN → marketplace lookup built from Sellerboard's **Products** export
(the one with a `Marketplace` column — the "Group by Parent" sales export
doesn't have one):
```bash
python3 scripts/build_marketplace_mapping.py path/to/products_export.csv
cp mapping/marketplace_mapping.json public/marketplace_mapping.json
```

**Known data-quality caveat, not a bug:** that field mostly records where
each ASIN's *cost settings* live (Germany, almost always — this is a
Products/cost-catalog export, not a per-order sales log), not which
marketplace each individual sale happened on. In practice this currently
resolves ~100% of ASINs to Germany, so Pan-EU actuals may read close to
€0 even in months with real Pan-EU sales. The dashboard says this
explicitly in the Launch Manager section rather than presenting the
split as more reliable than it is. If Sellerboard offers a true
per-marketplace sales export, re-point `build_marketplace_mapping.py` at
that instead — the rest of the pipeline doesn't need to change.

A handful of ASINs (~10 out of ~3,100) appear under more than one
marketplace in the source file (cross-listed catalog entries); Germany
wins when present. F3M ASINs with no marketplace entry at all are excluded
from the DE/Pan-EU split (but still counted in "Combined") and listed in
a data-quality banner on the page.

## Targets — how they get in

Targets are **not entered manually in the dashboard.** There are two layers:

**1. Real per-month targets (preferred, used automatically when present).**
Sourced directly from the workbook's actual monthly Good/Better/Best
columns — no dividing, no estimating:
- `BM Scorecard 3` → Launch Manager (`LM (F3M)` = Germany, `Expansion (F3M)`
  = Pan-EU) and Brand Manager (each brand's `PY1` / `Y1` / `Discontinued`
  sections), both Revenue and Profit Margin.
- `Leadership Scorecard 3`, row 13 onward → R&D, one row per named product.
  Revenue only — no margin *target* exists for R&D in the source yet.
  Actual margin is still computed and shown (net profit ÷ revenue), and
  the margin gate is treated as an automatic pass when there's no target
  to grade it against (same rule the R&D and Brand Manager gates both use
  for any missing target, not a special case).

**Mapping note:** the source sheets use a 3-tier Good/Better/Best scale;
the dashboard's bonus logic (and Config's rates) only has two tiers. The
dashboard maps **Better → Green target, Best → Gold target** (Good is
extracted but not currently used for tiering). This was an inference, not
an explicit instruction — if that's wrong, it's a one-line change in
`applyTargetsAndTiers()` in `app.js`.

Extract a month with:
```bash
python3 scripts/extract_monthly_targets.py path/to/calculator.xlsx --month 2026-08 \
  --out mapping/targets_monthly/2026-08.json
cp mapping/targets_monthly/2026-08.json public/targets_monthly/2026-08.json
```
Commit and push. The dashboard picks up `targets_monthly/<month>.json`
automatically for any month that has one — including **previously saved**
months, since targets are re-applied fresh on every load rather than
trusted from what was baked in when the month was saved.

**2. Quarterly ÷ 3 fallback**, unchanged from before, used only for
whatever a real monthly extract doesn't cover (a brand/stage/product with
no real monthly figure, or a month with no `targets_monthly/` file at
all). Any target using this fallback shows a small **(est.)** marker next
to it in the dashboard, so it's never ambiguous which numbers are real.
Sourced from the workbook's `📋 All Tracks` tab (Q3 quarter-total columns)
and `⚙️ Config` tab (rates/weights):
```bash
python3 scripts/extract_targets.py path/to/calculator.xlsx --quarter Q3
cp mapping/targets.json public/targets.json
```

The quarterly-target extraction also supplies the **rates and stage
weights** (`⚙️ Config`) used for every bonus € calculation regardless of
which target source is in play — re-run it whenever Finance changes those,
even if you're not touching targets.

## Tabs

- **Monthly** — full target-vs-actual detail for the selected month (picked
  from a dropdown showing "August 2026", not "2026-08"): stats, R&D,
  Launch Manager, Brand Manager, Marketplace, revenue chart, targets,
  tiers, margins.
- **Quarterly** — has its own dropdown ("Q3 2026", etc., built from every
  quarter any known month falls into) instead of the month picker, since
  it operates on a whole quarter at once. Deliberately NOT a
  target-vs-actual comparison at the quarter level — it just adds up each
  month's *already-computed* bonus €, per product/market/brand/stage,
  across the quarter's 3 months. Same row structure as Monthly (same R&D
  products, same BM1-4 grouping), columns are just Month 1 | Month 2 |
  Month 3 | Total, and each month's bonus cell is tinted by *that row's
  own tier that month* (a subtotal/group/total row is never tinted this
  way, since it isn't tied to one tier). R&D also shows the ÷ team-size
  per-person row here, same as Monthly. A month with no saved data shows
  "—" for that column (not €0 — the two mean different things), and a
  banner says explicitly how many of the 3 months actually have data if
  the quarter isn't complete yet.
- **Upload data** — the CSV drop zone, data-quality panel, and Save button.
- **Impact Analysis** — one row per role (R&D Team, Launch Manager) and per
  official Brand Manager brand, showing two figures side by side: **Growth
  % vs Target** (actual revenue vs. the Gold target — Gold because the
  Variable Bonus Framework itself frames Gold as "the minimum expectation"
  targets are set against) and **Bonus % of Revenue** (bonus paid ÷ actual
  revenue). The point is to make it easy to spot whether payouts are
  proportionate to overperformance — a big bonus % next to a small growth
  % (or vice versa) is worth a second look. Reflects the Monthly tab's
  currently selected month. Marketplace isn't included: its actual/target
  are manual inputs that aren't currently saved with the rest of the
  month's data, so there's nothing to compute from yet.

## Table styling

- **Sticky column headers** — each table's header row stays pinned to the
  top of the viewport while you scroll through it, so you're never
  guessing which column is which partway down a long list. This needed
  two fixes, not just `position:sticky`: (1) `overflow:hidden` on the
  table wrapper had to go, since sticky can't work inside a clipped
  ancestor — corners are now rounded via a `.table-scroll` wrapper div
  instead, so the rounding trade-off from earlier is gone too; (2)
  `border-collapse:collapse` silently breaks `position:sticky` on
  `<th>`/`<td>` in Safari and inconsistently elsewhere — switched to
  `border-collapse:separate; border-spacing:0`.
- **No wrapping anywhere, including the first column** — every table cell
  is `white-space:nowrap`, product/brand names included, so nothing ever
  breaks onto a second line. To make that fit without a table blowing out
  the page width, header/body/badge font sizes and cell padding were all
  tightened, and the page's max width was widened (1180px → 1440px) to
  give the now-9-column tables more room. `.table-scroll` (horizontal
  scroll per table) still exists as a fallback for genuinely narrow
  windows, but on a normal desktop width the tables should fit without
  needing it.
- **Target/bonus coloring, matching the Excel** — Green target cells (both
  revenue and margin) get a subtle green tint, Gold target cells get a
  subtle amber tint. The Bonus (€) cell itself is tinted the same way
  based on which tier was actually hit (green if GREEN, gold if GOLD, no
  tint on a MISS).
- **Total rows are solid, not subtle** — the R&D pool bonus total, Launch
  Manager's combined row, and the Brand Manager grand total all get a
  solid ember fill so they read as a hard stop/summary line rather than
  blending in with the itemized rows above them. BM group (BM1-4)
  subtotal rows keep their existing solid dark styling for the same
  reason.

## What's computed automatically, and how

- **R&D Team** — per product (matched by TOC Product Code, e.g. `SLP`
  rolls up `SLP120` + `SLP400`), against that product's calculator target.
  Tier: GOLD if Actual ≥ Gold target, GREEN if ≥ Green target, MISS
  otherwise — same logic as the workbook. Bonus pool total is shown, plus
  ÷ team size (from Config).
- **Brand Manager** — restricted to exactly the 9 brands the calculator's
  `📋 All Tracks` tab defines for this track, grouped under their 4
  supervisors (confirmed against the tab's own section banners):
  - **BM1 (Ilwyn)**: Tarpofix, Darwin, Planenfux
  - **BM2 (Jico)**: Heimfleiss, Mattenheld
  - **BM3 (Camille)**: PD
  - **BM4 (Michael)**: Nasswerk, PoolLöwe, TeichHeld

  Each brand's PY1 / Y1 (F4-12) / Discontinued stage is tiered and bonused
  independently using that stage's *effective* weighted rate from Config
  (e.g. PY1 = 60% × base rate), summing to a per-brand total, a per-group
  (BM1-4) subtotal, and a grand total — matching the calculator's own
  "BM# — BRAND BONUS" subtotal rows.

  **The company sells other brands too** (the TOC lists ~17), and those
  show up in the Sellerboard export like anything else. Any brand *not*
  in the 9 above is excluded from every Brand Manager total — it's simply
  not counted toward any bonus figure (a separate on-page panel showing
  those brands was tried and removed; the exclusion logic itself is
  unchanged).
- **Launch Manager** — Germany and Pan-EU are computed **separately, each
  with its own real actual, tier, and bonus** (each country's own Config
  rate — 0.0035/0.007 for Germany, 0.0015/0.003 for Pan-EU — applied to
  its own overflow, no blending needed anymore). See "Launch Manager:
  Germany vs. Pan-EU split" above for how the split works and its caveat.
  A "Combined" row sums both for reference.
- **Marketplace** — still fully manual (actual and target), per the
  original spec.
- **Every track's table shows Actual Margin % and Target Margin %
  explicitly**, not just as an invisible pass/fail baked into the tier —
  these numbers drive the quality gate (per the Variable Bonus Framework:
  no bonus is paid if margin is below target, regardless of revenue), so
  they're shown, not just used silently.
- ASINs not in the TOC mapping are excluded from every track (never
  silently misassigned) and listed by ASIN in the Data Quality panel.

## How it works

```
Calculator (.xlsx)  ──extract_targets.py──▶  mapping/targets.json  (Q3 Green/Gold targets, rates, weights)
TOC (.xlsx)         ──build_mapping.py────▶  mapping/toc_mapping.json  (ASIN → brand, stage, product code)
                                                       │
Sellerboard export (.csv) ─── uploaded in-browser ───▶ app.js: joins actuals to mapping, applies targets, tiers, bonus €
                                                       │
                                               render on screen (Monthly / Quarterly toggle)
                                                       │
                                              "Save to history" ──▶ POST /api/save-month
                                                                        │
                                                              commits data/YYYY-MM.json
                                                              to this private GitHub repo
```

The CSV is parsed and computed **entirely in the browser** (via PapaParse)
— nothing is sent anywhere until you click "Save to history." Only the
aggregated result (brand/stage/product totals, no line-item cost data)
gets committed to the repo.

## Security model — read this before deploying

The dashboard's actual access control is two environment variables set in
Vercel, never in this repo:

- `DASHBOARD_PASSCODE` — the shared passcode staff enter to unlock the
  dashboard. Checked server-side in `api/login.js` with a constant-time
  comparison, then a signed, `HttpOnly`, `Secure` session cookie is issued
  (`api/_auth.js` verifies it on every data request). The passcode itself
  is never sent to the browser in any form.
- `GITHUB_TOKEN` — a **fine-grained** GitHub Personal Access Token, scoped
  to *only this repo*, with Contents: Read (for `api/data.js`) and Write
  (for `api/save-month.js`) permissions and nothing else. Create it under
  GitHub → Settings → Developer settings → Fine-grained tokens.

`public/app.js` also contains a `PASSCODE_HASH` constant — **that one is
NOT secure** (anyone can read it from page source and reverse it offline).
It's a convenience fallback so you can test the UI locally before the
Vercel functions exist. Once deployed, `api/login.js` is what actually
gates access; the client-side hash never fires as long as the API
responds.

**For named individual accounts instead of one shared passcode** (e.g. "only
these 5 GitHub usernames"), swap `api/login.js` for GitHub OAuth restricted
to your org's membership — more setup, but gives per-person audit logs.
Ask me if you want this built out.

## Multi-user sharing — what's actually shared, and what isn't

- **"Save to history" with the API deployed correctly** → shared. It commits
  to the repo's `data/` folder, and everyone's dashboard reads from that
  same place (`api/data.js`) the next time they load or select that month.
  Not real-time — someone with the page already open needs to reload or
  re-select the month to see a save someone else just made.
- **Uploading and just looking, without clicking "Save"** → private to that
  browser tab. Nothing is sent anywhere.
- **If the API isn't deployed/working when "Save" is clicked** → the save
  falls back to that one browser's local storage only. No one else sees
  it, and the status message says so explicitly rather than implying
  success. Once the API is fixed, re-open the month and click Save again
  to actually share it.
- The dashboard always checks the shared server first, so once the API is
  working, everyone sees the same numbers by default — a browser's local
  fallback copy is only ever used when the server can't be reached.

## Deploying

1. Push this folder to a **private** GitHub repository.
2. In Vercel, "Add New Project" → import that repo. Vercel auto-detects
   the `api/*.js` functions and `public/` as the static site.
3. In Vercel → Project → Settings → Environment Variables, set:
   - `DASHBOARD_PASSCODE` — pick a strong shared passcode
   - `COOKIE_SECRET` — any long random string (`openssl rand -hex 32`)
   - `GITHUB_OWNER` — your GitHub username or org
   - `GITHUB_REPO` — this repo's name
   - `GITHUB_BRANCH` — usually `main`
   - `GITHUB_TOKEN` — the fine-grained PAT described above
4. Redeploy. Share the Vercel URL + passcode only with authorized staff.

## Monthly workflow

1. Export Sellerboard's "Dashboard Products — Group by Parent" report for
   the month, all marketplaces (or per-marketplace, once you want the
   Launch Manager split).
2. Open the dashboard's Upload tab and drop in the CSV — **the month is
   detected automatically from the filename** (Sellerboard's own date
   range, e.g. `01_07_2026-31_07_2026` → July 2026). The date field next
   to the file picker is only a manual fallback for the rare file whose
   name doesn't match that pattern; it does not need to be touched for a
   normal upload, and a stale leftover value in it never overrides a
   fresh detection.
3. Review the numbers and the data-quality panel (unmapped ASINs).
4. Click "Save to history" — commits `data/YYYY-MM.json` to the repo so
   everyone sees it and it's there next month for trend comparisons.

## Updating targets or the TOC mapping

Whenever Finance updates rates/targets in the calculator, or brands/stages
change in the TOC:
```bash
python3 scripts/extract_targets.py path/to/calculator.xlsx --quarter Q3
python3 scripts/build_mapping.py
cp mapping/targets.json public/targets.json
cp mapping/toc_mapping.json public/toc_mapping.json
```
Commit and push — the dashboard picks up the new files on next load.

## Files

```
public/index.html, app.js     the dashboard itself (static, client-side compute + tiering)
public/favicon.ico, assets/*  CD Commerce icon mark (icon only, no wordmark) -- favicon + header/login branding
public/toc_mapping.json       ASIN → brand/stage/product code (regenerate via build_mapping.py)
public/targets.json           Q3 targets + rates/weights (regenerate via extract_targets.py)
public/marketplace_mapping.json  ASIN -> DE/Pan-EU (regenerate via build_marketplace_mapping.py)
public/targets_monthly/*.json real per-month Good/Better/Best targets (regenerate via extract_monthly_targets.py)
public/data/2026-08.json      seeded August data (real Aug 2026 numbers, computed against Q3÷3 targets)
api/login.js, session.js,     real server-side passcode check + persistent session
  logout.js, _auth.js           (survives a page refresh; "Lock" actually clears it)
api/data.js, save-month.js    read/write month JSON in the private GitHub repo
scripts/build_mapping.py      TOC .xlsx -> mapping/toc_mapping.json
scripts/build_marketplace_mapping.py  Products .csv -> mapping/marketplace_mapping.json (ASIN -> DE/Pan-EU, for Launch Manager)
scripts/extract_targets.py    calculator .xlsx -> mapping/targets.json (quarterly rates/weights + ÷3 fallback)
scripts/extract_monthly_targets.py  calculator .xlsx -> mapping/targets_monthly/<month>.json (real Good/Better/Best)
scripts/process_month.py      early CLI reference for the actuals-only aggregation (no targets/tiering yet — app.js is the source of truth)
scripts/hash_passcode.py      generates the LOCAL-TESTING-ONLY passcode hash for app.js
```
