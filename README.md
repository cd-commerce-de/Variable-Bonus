# CD Commerce — Variable Bonus Dashboard

Upload the monthly Sellerboard export, and the dashboard maps every SKU to
its brand/stage/product (from the TOC), pulls Green/Gold targets from your
Variable Bonus Calculator workbook, and computes Tier + Bonus € per track —
with a **Monthly** and **Quarterly** view, mirroring the calculator's own
"All Tracks" layout. No database — data lives as JSON files in this
(private) GitHub repo, and a small Vercel deployment provides login +
serves that data.

## Launch Manager: two independent uploads, no computed subtraction

Germany and Pan-EU each come from their **own dedicated F3M export**,
uploaded separately (Upload tab):
- **"Launch Manager — Germany (F3M)"** — same columns as the main export,
  filtered to Germany only.
- **"Launch Manager — Pan-EU (F3M)"** — same columns, filtered to Pan-EU
  marketplaces only.

Each upload sets that country's actual **directly** — no subtraction, no
residual math, no ASIN->marketplace guessing. Upload either one, both, or
neither; they're completely independent. Neither is derived from the main
export at all (the main export still drives R&D and Brand Manager, and
its F3M total is still shown as "Combined" for reference, but Combined is
never split or computed from — it's just the full F3M pool from all
marketplaces together).

**Filenames need the same date-range pattern as the main export** (e.g.
`01_08_2026-31_08_2026…`) so the month can be detected — same convention
as every other upload in this dashboard. Both file inputs accept multiple
files at once, so several months can be done in one go. Each upload:
- Works against the **currently-loaded month in this session** if it
  matches, or **loads and updates an already-saved month** otherwise (no
  need to re-upload the main file just to add Launch Manager data) —
  saves immediately either way.
- **Survives a main-file re-upload.** If the main export for a month is
  re-uploaded later (e.g. to fix an incomplete/filtered export), any
  already-uploaded Germany/Pan-EU data for that month is carried forward,
  not reset to "awaiting upload" — they're tracked as genuinely separate
  uploads (`germany_source` / `pan_eu_source` = `'dedicated_upload'` vs.
  `'pending'` on the saved data).
- Before either file is uploaded for a month, the Monthly tab shows
  "awaiting dedicated upload" for that country rather than a guessed
  number or a silent zero.

Verified directly: uploaded synthetic Germany (€32,000.00) and Pan-EU
(€5,500.00) files against a real August month — each country showed
exactly its own file's total, Combined stayed completely unrelated
(unchanged throughout), and re-uploading the main file afterward correctly
preserved both country uploads instead of resetting them to pending.

**If a country upload comes back with 0 matched products**, the status
message says exactly why instead of leaving it a silent €0.00:
- The file had zero child rows at all (every SKU was blank) — usually
  means a parent-only export, or the wrong file.
- Or: N row(s) were in the file, but none matched — broken down into how
  many ASINs aren't in the TOC mapping at all vs. how many ARE in the TOC
  but weren't computed as F3M for that specific month (a different stage,
  or not launched yet). Verified directly with both cases against real
  data before shipping.

The earlier ASIN→marketplace mapping approach (`build_marketplace_mapping.py`,
subtraction-based Pan-EU override) has been fully retired in favor of this
— it was always going to be approximate at best, since that export's
Marketplace field records where an ASIN's cost settings live, not which
marketplace each sale happened on.

## Stage is computed live, not read from a fixed TOC column

This is the core fix: a SKU's stage (F3M / Y1 "M4-12" / PY1) is a **function
of (Launch Date, the month being attributed)**, computed fresh every time —
not a static label that goes stale as months pass. The same ASIN
correctly reports a different stage in different months, with zero manual
TOC editing required as existing products age:

- Months 1-3 since launch → **F3M**
- Months 4-12 since launch → **M4-12** ("Y1 (F4-12)")
- Month 13+ since launch → **PY1**
- **Discontinued** / **Quality Issue** are manual overrides (there's no
  calendar rule for these) — once their start date (still set in the TOC)
  is reached, they take over from whatever the calendar would otherwise
  say, for that month and every month after.

Verified directly: a real ASIN launched 2026-05-07 computes F3M for
June/July 2026 and automatically flips to M4-12 for August 2026 — no TOC
change involved.

Implemented in `computeStageForMonth()` in `app.js`. The TOC's own `Stage`
column is still extracted (as `toc_stage_snapshot`) but only used as a
fallback for the rare ASIN with no Launch Date on file — everything else
uses the live calculation.

**Bonus totals will shift slightly** compared to earlier versions of this
dashboard that read the TOC's static Stage column directly — that's
expected and correct, not a regression: some ASINs were sitting in a
stage the TOC hadn't gotten around to updating.

### ASIN Masterlist (Upload tab)

A searchable, live view of every ASIN's Brand, Product, Launch Date, and
computed stage **for whichever month is currently selected**. Doesn't
render all ~2,400 rows by default (search box requires 2+ characters) to
stay fast; results cap at 200 matches with a note if there are more.

### Stage History tab

Two modes, both computed live (never read from the TOC's static Stage
column):

- **Matrix mode** (default) — search a product (2+ characters) and see
  one row with its Launch Date and computed stage for **every month from
  January 2026 through December 2027** (24 columns), color-coded (F3M
  blue, Y1 amber, PY1 green, Discontinued gray, Quality Issue red). This
  is what lets you visually confirm a product's stage actually changes as
  it ages — verified directly: a product launched August 2025 correctly
  shows Y1 for Jan-Jul 2026 and flips to PY1 exactly in August 2026, the
  12-month mark. Capped at 100 matches given the wide table.
- **Reverse-lookup mode** — pick a **Stage** and a **Month** from the two
  dropdowns (both required together — a stage alone isn't a valid lookup,
  since the same product can be a different stage in different months)
  and the table switches to a plain list of every ASIN that was that
  stage in that month, optionally narrowed further by the search box.
  Capped at 300 matches. Verified directly: Stage=F3M + Month=Aug 2026
  correctly returned 20 real ASINs, including a product launched June
  2026 (2 months prior — correctly F3M).

**Searching an ASIN that returns zero matches says why**, not just "0
matches" — if the search text looks like an ASIN (`B0` + 8 characters)
and nothing was found, the message says it's most likely not in the TOC
mapping yet and to add it there. This is genuinely useful: it's the
fastest way to confirm "is this specific ASIN even tracked yet?" Same fix
applied to the Masterlist's search for consistency. Verified directly
against a real unmapped ASIN from an actual export — got the explanatory
message, not a bare zero.

**Reverse-lookup mode adds a "Country" column when Stage = F3M** —
Germany or Pan-EU only means anything for F3M-stage products (that's the
only track with a per-country split), so the column only appears then,
not for PY1/M4-12/Discontinued/Quality Issue. It shows which of the two
dedicated per-country uploads (see "Launch Manager: two independent
uploads" above) an ASIN's revenue actually came from that month — "not in
either upload" if it's genuinely F3M but wasn't in either file yet (a real
signal, not an error), or "no upload yet" for the whole column if neither
file has been uploaded for that month at all. This required capturing the
matched-ASIN list from each country upload (previously only the aggregate
total was kept) — `germany_asins` / `pan_eu_asins` on the saved month's
data. Verified directly: uploaded a synthetic Germany file (2 ASINs) and
Pan-EU file (1 ASIN) against a real June month, filtered Stage History to
F3M, and got exactly "Germany," "Germany," and "Pan-EU" for those three
ASINs — with a fourth real F3M ASIN not in either file correctly showing
"not in either upload" rather than a wrong or blank value.

The date range is a fixed window, not derived from upload history — it
covers Launch Dates already in the TOC comfortably (latest launch on file
is August 2026, needing visibility through August 2027 to see its full
F3M→PY1 progression).

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

Whenever Finance updates rates/targets in the calculator, or the TOC
itself changes (new products, brand reassignment, a corrected Launch
Date, or a newly-set Discontinued/Quality Issue date) — **not** just
because a month has passed, since stage now recalculates on its own:
```bash
python3 scripts/extract_targets.py path/to/calculator.xlsx --quarter Q3
python3 scripts/build_mapping.py path/to/TOC.xlsx
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
public/marketplace_mapping.json  DEPRECATED (see "Launch Manager: two independent uploads" above) -- no longer read by app.js, kept only for reference
public/targets_monthly/*.json real per-month Good/Better/Best targets (regenerate via extract_monthly_targets.py)
public/data/2026-08.json      seeded August data (real Aug 2026 numbers, computed against Q3÷3 targets)
api/login.js, session.js,     real server-side passcode check + persistent session
  logout.js, _auth.js           (survives a page refresh; "Lock" actually clears it)
api/data.js, save-month.js    read/write month JSON in the private GitHub repo
scripts/build_mapping.py      TOC .xlsx -> mapping/toc_mapping.json
scripts/build_marketplace_mapping.py  DEPRECATED -- superseded by the two dedicated Germany/Pan-EU F3M uploads
scripts/extract_targets.py    calculator .xlsx -> mapping/targets.json (quarterly rates/weights + ÷3 fallback)
scripts/extract_monthly_targets.py  calculator .xlsx -> mapping/targets_monthly/<month>.json (real Good/Better/Best)
scripts/process_month.py      early CLI reference for the actuals-only aggregation (no targets/tiering yet — app.js is the source of truth)
scripts/hash_passcode.py      generates the LOCAL-TESTING-ONLY passcode hash for app.js
```
