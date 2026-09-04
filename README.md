# CD Commerce — Variable Bonus Dashboard

Upload the monthly Sellerboard export, and the dashboard maps every SKU to
its brand/stage/product (from the TOC), pulls Green/Gold targets from your
Variable Bonus Calculator workbook, and computes Tier + Bonus € per track —
with a **Monthly** and **Quarterly** view, mirroring the calculator's own
"All Tracks" layout. No database — data lives as JSON files in this
(private) GitHub repo, and a small Vercel deployment provides login +
serves that data.

## Targets — how they get in

Targets are **not entered manually in the dashboard**. They're extracted
once from the calculator workbook's `📋 All Tracks` tab (Q3 quarter-total
columns) and `⚙️ Config` tab (rates/weights), via:

```bash
python3 scripts/extract_targets.py path/to/calculator.xlsx --quarter Q3
cp mapping/targets.json public/targets.json
```

**Interim approach, exactly as requested:** monthly target = quarterly
target ÷ 3, evenly. This is a simplification — the calculator's own
Actuals are sourced weekly and aren't evenly distributed across a quarter,
so a real month's target is probably not exactly 1/3 of the quarter. When
real monthly targets exist (e.g. via the calculator's own monthly-broken-out
`All Tracks` columns), re-point `extract_targets.py` at those columns
instead of dividing — the rest of the dashboard doesn't need to change.

Re-run `extract_targets.py` (and re-copy to `public/`) each time Finance
updates targets or rates in the workbook.

## Views

- **Monthly** — the selected month's actuals vs. that month's target
  (quarterly ÷ 3).
- **Quarterly** — sums actuals from every month *already saved* within the
  same quarter as the selected month, against the **full** quarterly
  target. If not all 3 months of the quarter have been uploaded yet, a
  banner says so explicitly rather than pretending the quarter is complete.

## What's computed automatically, and how

- **R&D Team** — per product (matched by TOC Product Code, e.g. `SLP`
  rolls up `SLP120` + `SLP400`), against that product's calculator target.
  Tier: GOLD if Actual ≥ Gold target, GREEN if ≥ Green target, MISS
  otherwise — same logic as the workbook. Bonus pool total is shown, plus
  ÷ team size (from Config).
- **Brand Manager** — per brand, per stage (PY1 / Y1 (F4-12) /
  Discontinued), each tiered and bonused independently using that stage's
  *effective* weighted rate from Config (e.g. PY1 = 60% × base rate), then
  summed to a per-brand and grand total.
- **Launch Manager** — Germany and Pan-EU targets are both shown, but
  **actuals are combined-only** (the Sellerboard export has no marketplace
  column), so only an approximate combined tier can be computed. A warning
  banner says so on the page itself.
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
public/data/2026-08.json      seeded August data (real Aug 2026 numbers, computed against Q3÷3 targets)
api/login.js, _auth.js        real server-side passcode check + session verification
api/data.js, save-month.js    read/write month JSON in the private GitHub repo
scripts/build_mapping.py      TOC .xlsx -> mapping/toc_mapping.json
scripts/extract_targets.py    calculator .xlsx -> mapping/targets.json (Q3 targets, rates, weights)
scripts/process_month.py      early CLI reference for the actuals-only aggregation (no targets/tiering yet — app.js is the source of truth)
scripts/hash_passcode.py      generates the LOCAL-TESTING-ONLY passcode hash for app.js
```
