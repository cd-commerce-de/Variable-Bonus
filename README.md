# CD Commerce — Variable Bonus Dashboard

Upload the monthly Sellerboard export, and the dashboard maps every SKU to
its brand/stage (from the TOC) and computes actuals per bonus track. No
database — data lives as JSON files in this (private) GitHub repo, and a
small Vercel deployment provides login + serves that data.

## What's real right now, and what's blocked

**Computed automatically, today:**
- **R&D Team** — pooled Actual Revenue/Units/Net Profit for every SKU at
  stage `M4-12` (= "Y1 (F4-12)"), across all brands.
- **Brand Manager** — same metrics per brand, blended across `PY1`,
  `M4-12`, and `Discontinued` stages.
- Data-quality reporting: any ASIN in the Sellerboard export that isn't in
  the TOC mapping is called out by ASIN, not silently dropped or
  misassigned.

**Blocked, and why:**
- **Tier (GREEN/GOLD/MISS) and €-bonus, for every track.** These require
  Green/Gold revenue targets, which exist in the Variable Bonus
  Calculator's Leadership Scorecard tabs, not in the Sellerboard export or
  the TOC. The dashboard has target input fields wired up and ready — as
  soon as target figures are available (manually entered, or exported from
  that workbook), tier and bonus calculate immediately.
- **Launch Manager's Germany vs. Pan-EU split.** The "Group by Parent"
  export blends all marketplaces into one row per SKU. Export per
  marketplace from Sellerboard (or ask them to add a Marketplace column)
  to unlock this.
- **Marketplace track.** Per the original spec this is manually entered,
  not derived — there's a manual-entry row for it in the dashboard.

## How it works

```
TOC (.xlsx)  ──build_mapping.py──▶  mapping/toc_mapping.json  (ASIN → brand, stage)
                                            │
Sellerboard export (.csv) ─── uploaded in-browser ───▶ app.js computes actuals
                                            │
                                    render on screen
                                            │
                                   "Save to history" ──▶ POST /api/save-month
                                                              │
                                                    commits data/YYYY-MM.json
                                                    to this private GitHub repo
```

The CSV is parsed and computed **entirely in the browser** (via PapaParse)
— nothing is sent anywhere until you click "Save to history." That keeps
the raw Sellerboard export off any server. Only the aggregated result
(brand/stage totals, no line-item cost data) gets committed to the repo.

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

## Updating the TOC mapping

Whenever brands/stages change in the TOC workbook:
```bash
python3 scripts/build_mapping.py
```
Commit the regenerated `mapping/toc_mapping.json` (also copy it to
`public/toc_mapping.json` — the dashboard reads it from there).

## Files

```
public/index.html, app.js     the dashboard itself (static, client-side compute)
public/toc_mapping.json       ASIN → brand/stage/product (regenerate via script below)
public/data/2026-08.json      seeded August data
api/login.js, _auth.js        real server-side passcode check + session verification
api/data.js, save-month.js    read/write month JSON in the private GitHub repo
scripts/build_mapping.py      TOC .xlsx -> mapping/toc_mapping.json
scripts/process_month.py      CLI equivalent of the in-browser computation (for scripted/batch use)
scripts/hash_passcode.py      generates the LOCAL-TESTING-ONLY passcode hash for app.js
```
