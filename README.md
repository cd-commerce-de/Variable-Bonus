# CD Commerce — Variable Bonus Dashboard

Upload the monthly Sellerboard export, and the dashboard maps every SKU to
its brand/stage/product (from the TOC), pulls Green/Gold targets from your
Variable Bonus Calculator workbook, and computes Tier + Bonus € per track —
with a **Monthly** and **Quarterly** view, mirroring the calculator's own
"All Tracks" layout. No database — data lives as JSON files in this
(private) GitHub repo, and a small Vercel deployment provides login +
serves that data.

## Targets — how they get in

Targets are **not entered manually in the dashboard.** There are two layers:

**1. Real per-month targets (preferred, used automatically when present).**
Sourced directly from the workbook's actual monthly Good/Better/Best
columns — no dividing, no estimating:
- `BM Scorecard 3` → Launch Manager (`LM (F3M)` = Germany, `Expansion (F3M)`
  = Pan-EU) and Brand Manager (each brand's `PY1` / `Y1` / `Discontinued`
  sections), both Revenue and Profit Margin.
- `Leadership Scorecard 3`, row 13 onward → R&D, one row per named product.
  Revenue only — margin is intentionally left blank, per instruction (no
  margin target exists for R&D in the source).

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

## Views

- **Monthly** — the selected month's actuals vs. that month's real target
  where one has been extracted, else quarterly ÷ 3 (marked "(est.)").
- **Quarterly** — sums actuals from every month *already saved* within the
  same quarter as the selected month, against the **full** quarterly
  target (real monthly targets aren't summed into a quarter view yet — a
  future improvement, not implemented). If not all 3 months of the
  quarter have been uploaded, a banner says so explicitly rather than
  pretending the quarter is complete.

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
  in the 9 above is excluded from every Brand Manager total — its revenue
  is shown separately in an "Other brands" panel so it's never silently
  folded into a bonus number it isn't part of.
- **Launch Manager** — Germany and Pan-EU targets are both shown, but
  **actuals are combined-only** (the Sellerboard export has no marketplace
  column), so only an approximate combined tier and bonus can be computed.
  The bonus uses Config's Germany rate (70% weight: 0.0035 green / 0.007
  gold) plus PAN EU rate (30% weight: 0.0015 green / 0.003 gold) — these
  two sum back to the base rate (0.005/0.01) by construction, so summing
  them is the mathematically correct blended rate for a combined-actual
  approximation. A warning banner says so on the page itself.
- **Marketplace** — still fully manual (actual and target), per the
  original spec.
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
2. Open the dashboard, pick the month, drop in the CSV.
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
public/toc_mapping.json       ASIN → brand/stage/product code (regenerate via build_mapping.py)
public/targets.json           Q3 targets + rates/weights (regenerate via extract_targets.py)
public/targets_monthly/*.json real per-month Good/Better/Best targets (regenerate via extract_monthly_targets.py)
public/data/2026-08.json      seeded August data (real Aug 2026 numbers, computed against Q3÷3 targets)
api/login.js, session.js,     real server-side passcode check + persistent session
  logout.js, _auth.js           (survives a page refresh; "Lock" actually clears it)
api/data.js, save-month.js    read/write month JSON in the private GitHub repo
scripts/build_mapping.py      TOC .xlsx -> mapping/toc_mapping.json
scripts/extract_targets.py    calculator .xlsx -> mapping/targets.json (quarterly rates/weights + ÷3 fallback)
scripts/extract_monthly_targets.py  calculator .xlsx -> mapping/targets_monthly/<month>.json (real Good/Better/Best)
scripts/process_month.py      early CLI reference for the actuals-only aggregation (no targets/tiering yet — app.js is the source of truth)
scripts/hash_passcode.py      generates the LOCAL-TESTING-ONLY passcode hash for app.js
```
