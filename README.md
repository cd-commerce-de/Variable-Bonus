# CD Commerce — Variable Bonus Dashboard

Upload the monthly Sellerboard export, and the dashboard maps every SKU to
its brand/stage/product (from the TOC), pulls Green/Gold targets from your
Variable Bonus Calculator workbook, and computes Tier + Bonus € per track —
with a **Monthly** and **Quarterly** view, mirroring the calculator's own
"All Tracks" layout. No database — data lives as JSON files in this
(private) GitHub repo, and a small Vercel deployment provides login +
serves that data.

## ⚠️ Deploying a code update? `data/` is NOT included in this package

**As of this version, update zips no longer contain `data/` or
`public/data/` at all.** Those folders hold your *real, live* saved
months — every month anyone has uploaded and saved through the dashboard.
Earlier versions of this package included seed/example files there, and
dragging a full package into the repo silently overwrote real saved
months with those stale seed files (this actually happened — see the
"Multi-user sharing" section below). Going forward: safe to drag in
everything a code update package contains, because `data/` simply isn't
there to overwrite anything. If you ever *do* see a `data/` folder in a
package from here on, that means it was intentional and worth asking
about before overwriting.

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

### Country uploads filter rows by ASIN, not SKU (real bug, found and fixed)

**Symptom reported**: uploading a Pan-EU file (Spain) using a newer
Sellerboard export format ("Group by ASIN" rather than the original
"Group by Parent") showed no F3M data at all.

**Cause, confirmed against the actual uploaded file**: `parseCountryF3MFile`
was filtering to "real product rows" by checking for a non-empty SKU
column — correct for the original "Group by Parent" format, where blank
SKU meant a parent/summary row to skip. But the newer "Group by ASIN"
format reports at the ASIN level directly and leaves SKU blank on every
single row — checked the real uploaded file directly: all 9 rows had a
real ASIN and real sales data, but a completely blank SKU column. The
old filter was silently excluding all 9 rows before they ever reached
the TOC lookup step.

**Fix**: this filter now checks ASIN instead of SKU — which is also more
correct in general, since every lookup this function does (`MAPPING`,
`PAN_EU_TOC`) is keyed by ASIN anyway, never SKU.

Verified directly against the real Spain file, not a synthetic one:
registered 3 of its real ASINs in the Pan-EU TOC with a Spain launch
date that makes them F3M by August 2026, uploaded the actual file, and
confirmed it correctly contributed €7,710.99 to Pan-EU's F3M total — the
other 6 real ASINs from the same file correctly appeared in the Pending
section (see "Pending ASINs" above), ready for a Launch Date. This
fix is scoped to the country-specific uploads (Germany/Pan-EU) only —
the main file's own row-filtering is unaffected.

### Multiple files for the same country+month: combine, not overwrite

**Real bug, found and fixed**: if you have to export a separate report
per marketplace (e.g. France, Italy, Spain each as their own file, all
rolling up into "Pan-EU"), uploading a second file for the same
country+month used to silently **overwrite** the first — the second
upload's numbers replaced the first's entirely, with no warning. Multiple
distinct files for the same country+month now correctly **add together**.

Fixed via per-file contribution tracking, keyed by filename
(`pan_eu_contributions` / `germany_contributions` on the saved month) —
the country's total is always recomputed fresh by summing every tracked
file's own contribution, never overwritten by "whichever file was
uploaded last." This also handles the natural follow-up case correctly:
**re-uploading the exact same filename** (e.g. a corrected version of a
file you already uploaded) **replaces only that file's own contribution**
instead of double-counting it — new distinct filenames add, matching
filenames replace. The UK-marketplace redirect (see below) follows the
same per-file rule, so re-uploading a Pan-EU file that had UK ASINs
doesn't duplicate its Germany redirect either.

Verified directly, not just reasoned about: uploaded a France file
(€5,000) then an Italy file (€3,000) for the same month — correctly
combined to €8,000 across 2 files. Then re-uploaded a corrected version
of the France file under the identical filename (now €6,000) — correctly
came out to €9,000 total (the corrected France + the original Italy),
not €14,000, confirming the replace-on-same-filename rule actually works
and doesn't silently double-count.

**Follow-up regression from this same fix, found and fixed**: uploading
*only* Pan-EU (Germany untouched) was wiping Germany's data to zero for
any month whose Germany total had been set before per-file contribution
tracking existed (no matching entry in `germany_contributions`) — the
code recomputed Germany's total from its (empty) contributions
unconditionally on every upload, regardless of which country was
actually being uploaded. Fixed by migrating any such "legacy" total into
the contributions system (as a `__legacy__` entry) the first time either
country is touched again, before summing — so it's preserved rather than
clobbered. Verified directly: simulated a month with Germany set the old
way (€12,000, no contributions entry), uploaded only a Pan-EU file, and
confirmed Germany's €12,000 survived completely untouched while Pan-EU
picked up the new €3,000. Confirmed symmetric the other direction too
(Pan-EU survives a Germany-only upload) with the same test in reverse.

**A third bug, found while confirming a real workflow change (a combined
Germany+UK export uploaded through the Germany zone, not Pan-EU)**:
`parseCountryF3MFile` always splits UK-listed ASINs into their own bucket
regardless of which zone the file lands in — correct when the file came
in through Pan-EU (that bucket then gets redirected into Germany), but
the code that puts that bucket back only ran for `country === 'pan_eu'`.
Uploading a combined DE+UK file *into the Germany zone itself* was
silently dropping the UK-listed ASINs' revenue — split out, then never
added back anywhere, since there was nothing to "redirect" it to (it was
already the destination). Fixed: for a Germany upload, the split-out UK
bucket is merged straight back into that file's own contribution instead
of being treated as a redirect candidate. Verified directly: a 3-ASIN
file (€4,000 Germany-only + €3,000 + €2,000 UK-listed = €9,000) uploaded
into the Germany zone now correctly totals €9,000 (previously came back
as €4,000, silently missing both UK-listed ASINs) — and confirmed the
original Pan-EU-upload redirect behavior is completely unaffected by
this fix, re-tested with the identical file uploaded into the Pan-EU zone
instead (€4,000 Pan-EU / €5,000 correctly redirected to Germany, exactly
as before).

- **Survives a main-file re-upload.** If the main export for a month is
  re-uploaded later (e.g. to fix an incomplete/filtered export), any
  already-uploaded Germany/Pan-EU data for that month is carried forward,
  not reset to "awaiting upload" — they're tracked as genuinely separate
  uploads (`germany_source` / `pan_eu_source` = `'dedicated_upload'` vs.
  `'pending'` on the saved data).
- Before either file is uploaded for a month, the Monthly tab shows
  "awaiting dedicated upload" for that country rather than a guessed
  number or a silent zero.

### UK marketplace policy: always Germany, never Pan-EU

**Permanent rule, confirmed directly**: any ASIN also listed on
Amazon.co.uk has its revenue counted as Germany, even when it arrives in
a Pan-EU upload. A handful of ASINs are dual-listed on both Amazon.de and
Amazon.co.uk (found via the Products export's Marketplace field, from
earlier in this project — `mapping/marketplace_mapping.json`'s
`ambiguous_asins`, filtered to those that include `"Amazon.co.uk"`) —
`UK_ASINS` in `app.js`, loaded once at boot.

When a Pan-EU file is processed, any matched F3M ASIN in that set is
**redirected**: its revenue is added to Germany's actual (on top of
whatever Germany already has that month, not overwriting it) instead of
counting toward Pan-EU, and it moves into `germany_asins` instead of
`pan_eu_asins` — so Stage History's Country column reflects the redirect
too. The upload status message says explicitly how many ASINs were
redirected and for how much, rather than silently changing the number.

Verified directly: uploaded a synthetic Pan-EU file with 2 known
UK-listed ASINs (€7,000 combined) and 1 genuine Pan-EU ASIN (€2,000)
against a real August month — Germany correctly received exactly
€7,000.00, Pan-EU correctly kept only €2,000.00, and both ASIN lists
(`germany_asins`/`pan_eu_asins`) came out correctly split.

**This only applies going forward** — any month already saved before this
fix was deployed still has the old (incorrect) attribution baked in.
Re-upload that month's Pan-EU file once this version is live to apply the
redirect retroactively to already-saved data.

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

### Pan-EU TOC tab: a completely separate product database, keyed by (ASIN, Marketplace)

A product can launch in Germany first and only expand into Pan-EU
marketplaces months later — its F3M window for the **Pan-EU bonus**
should be based on its own Pan-EU launch date, not the main TOC's German
one. **The same ASIN is also often sold in multiple Pan-EU marketplaces**
(France, Italy, Spain, ...), each potentially with its own launch date —
so this is keyed by `(ASIN, Marketplace)`, not just ASIN:
`PAN_EU_TOC[asin][marketplace] = { launch_date }`. Persisted the same
reused-pseudo-month way as the manual ASIN additions above (key
`_pan_eu_toc`).

**Uploading now requires picking which marketplace the file is for** — a
dropdown above the Pan-EU drop zone (Upload tab), populated from every
marketplace already registered in the Pan-EU TOC tab. Stage is looked up
for that ONE marketplace's entry only — never any other marketplace's
entry for the same ASIN, and never the main TOC. An ASIN not registered
for that specific marketplace is excluded and flagged, not silently
guessed from a different marketplace's date or the main TOC's German
date. **Germany uploads are completely unaffected** — they keep using the
main TOC exactly as before, regardless of what's in the Pan-EU TOC.

**Multiple marketplace files combine, never override** — contributions
are tracked per `(marketplace, filename)`, so France's file and Italy's
file both add into the Pan-EU total independently, even if the SAME ASIN
appears in both (each marketplace's own launch date decides whether that
ASIN counts as F3M for that marketplace specifically). Re-uploading the
identical marketplace + filename (a correction) replaces only that one
contribution, never duplicates it — same rule as the original
multi-file-combining fix earlier in this document, extended to be
marketplace-aware so two marketplaces' files named identically can never
collide with each other.

Verified directly with the exact scenario this was built for, not just
reasoned about: the same real ASIN, registered with a France launch date
that makes it F3M by August 2026 and a separate Italy launch date that
makes it PY1 by the same month. Uploaded a France file — correctly
counted (€4,000). Uploaded an Italy file for the identical ASIN —
correctly excluded (€0, flagged as not-F3M for Italy specifically),
confirmed Pan-EU's total stayed exactly €4,000 (France only), not €0 and
not €7,000. Then re-uploaded a corrected France file under the identical
marketplace + filename — correctly replaced the total to reflect only
the new number, not duplicated. Also confirmed the marketplace dropdown
correctly populates from real TOC entries.

Also caught and fixed a real bug while first building this tab's add/
delete buttons: both were missing an `await` before their re-render
call, so the underlying data updated correctly but the visible table
briefly lagged a step behind (an add could show one entry short, a
delete could still show the just-removed row). Fixed by awaiting the
re-render properly in both places; re-verified add and delete each land
on the DOM immediately, matching the data every time.

### Pending ASINs come from your uploads, not typed from memory

Any ASIN found in a Pan-EU upload that isn't yet registered for that
specific marketplace is automatically surfaced in the Pan-EU TOC tab's
"Pending" section — no need to know or type ASINs by hand. Each pending
row shows the ASIN and marketplace it came from, with just a Launch Date
field to fill in and a Save button; saving moves it straight into the
confirmed list below (and out of pending). A Dismiss button is also
available if an ASIN genuinely doesn't need tracking.

Persisted the same way as the confirmed entries (same `_pan_eu_toc`
pseudo-month, now storing both `entries` and `pending`), so the list
survives across sessions rather than needing to be re-uploaded to see it
again.

Verified directly: uploaded a real Pan-EU file (France) with 2 ASINs not
yet in the Pan-EU TOC — both correctly appeared in the Pending section
with the right marketplace. Filled in a Launch Date for one and saved —
it correctly moved into the confirmed entries list, and only the other
ASIN remained pending. Dismissed that second one — confirmed it was
removed from pending without accidentally creating a confirmed entry for
it (dismissing and saving are genuinely different actions with different
outcomes).

### Pan-EU TOC entries are also visible in Stage History

Both Stage History modes (matrix and reverse-lookup) draw from
`buildStageHistoryEntries()`, which combines the main TOC *and* every
Pan-EU TOC entry into one list — not just the main TOC. A new **Source**
column tags each row: `Main TOC` for a regular entry, or `Pan-EU:
<Marketplace>` (e.g. `Pan-EU: Spain`) for a Pan-EU TOC entry, using that
marketplace's own Launch Date for its own stage computation across every
month — never the main TOC's date, and never another marketplace's date
for the same ASIN.

This means the **same ASIN can appear as multiple separate rows** — one
for the main TOC (if it has an entry there) plus one per Pan-EU
marketplace it's registered for — each showing its own Launch Date and
its own independently-computed stage per month. Brand and Product are
borrowed from the main TOC for display only when the ASIN happens to
exist there too (a Pan-EU-only ASIN with no main TOC entry just shows
without them) — never its Launch Date, which always comes from that
row's own source.

Verified directly: registered a real ASIN's Pan-EU TOC entry for Spain,
searched for it in matrix mode, and got exactly 2 rows — the main TOC
entry and the Pan-EU: Spain entry, each with a different Launch Date and
its own month-by-month stage progression. Same ASIN, in reverse-lookup
mode (Stage=F3M, a month where only the Spain entry qualifies) — correctly
surfaced just the Pan-EU: Spain row, tagged accordingly.

**The Stage dropdown's F3M option is split into two, in reverse-lookup
mode**: "F3M (Launch)" matches only main-TOC entries (no Pan-EU tag) —
this is the original F3M, just relabeled for clarity now that a second
kind exists. "F3M (PanEU)" matches only Pan-EU TOC entries (any
marketplace) that are F3M per their own Launch Date. The two are
mutually exclusive — an ASIN registered in the Pan-EU TOC never appears
under "F3M (Launch)" even if its main-TOC entry also happens to be F3M
that month, and vice versa. Every other stage filter (Y1/PY1/
Discontinued/Quality Issue) is unchanged and still matches either source,
since only F3M was asked to be split this way.

Verified directly: registered a real ASIN in the Pan-EU TOC (Spain,
F3M-eligible for August) while a *different* real ASIN was independently
F3M per the main TOC for the same month. Filtered to "F3M (Launch)" —
got the main-TOC ASIN, correctly excluding the Pan-EU one. Filtered to
"F3M (PanEU)" instead — got exactly the Pan-EU ASIN (tagged "Pan-EU:
Spain"), correctly excluding the main-TOC one.

## Unmapped ASINs tab

Aggregates every ASIN not in the TOC, across **every saved month** (not
just the currently-viewed one) — via each month's `meta.unmapped_details`
(now `{asin, product}` pairs, not just bare ASIN strings, so this tab has
a real product name to show without needing the original file
re-uploaded). For each one: enter Brand and Launch Date (required —
Launch Date is what makes stage computation possible at all) and
optionally a Product Code (only matters if it should count toward an R&D
target). Click Save and it's merged into the live `MAPPING` immediately —
usable in Stage History, the Masterlist, everywhere — with zero need to
regenerate `toc_mapping.json` or reload the page.

**Persistence reuses the exact same save infrastructure as a real
month** — no new API endpoint needed. Additions are stored under a
pseudo-month key (`_manual_asin_additions`) that can never collide with a
real `YYYY-MM` month, via the same `saveMonthData()`/`loadMonth()`
functions everything else already uses. Loaded and merged into `MAPPING`
once at boot, and again immediately after each save.

**Important limitation, stated directly rather than glossed over**: this
fixes the ASIN going forward. An **already-saved** month's numbers don't
change until that month's main export is re-uploaded — computing R&D/
Brand Manager/stage attribution requires the original raw rows, which
aren't kept around after a month is saved (only the aggregated result
is). The tab's own banner says this explicitly.

Verified directly against real July data (not synthetic): scanned and
found 23 real unmapped ASINs, filled in Brand + Launch Date for one
(`B08WBQ184L`, a real Tarpofix accessory), confirmed the save persisted
the exact right product name (German umlaut and all — `"PH2
Planenknöpfe Kunststoff"`), and confirmed a rescan correctly dropped it
from the list (22 remaining) since it's now resolved. Caught and fixed
one thing along the way: my own hand-rolled test-harness CSV parser (used
earlier for quick tests throughout this project) was mangling this
particular row — re-verified with the *real* PapaParse library to
confirm the actual app code was never affected, just my test tooling.

**Backward-compatibility bug, found and fixed**: months saved *before*
`unmapped_details` existed only have the older `unmapped_asins` field
(bare ASIN strings, no product name) — the tab originally only looked for
`unmapped_details` and found nothing in those older saves, silently
reporting "No unmapped ASINs found" even though real ones existed.
Fixed with a fallback: falls back to `unmapped_asins` when
`unmapped_details` isn't present (shown with no product name, since the
older format never captured one). Verified directly against the real
seed data (saved in the older format) — correctly finds all 23 real
unmapped ASINs instead of reporting zero.

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

**Brand filter dropdown** (populated from every distinct brand actually
in the TOC — 17 currently) narrows both modes: in reverse-lookup, it
combines with Stage + Month as an AND filter (e.g. "which Tarpofix ASINs
were PY1 in August"); in matrix mode, picking a brand alone is now enough
to see results — the 2-character search requirement only applies when no
brand is selected, since a brand alone is already a reasonably narrow
filter. Verified directly: Stage=PY1 + Month=Aug 2026 + Brand=Tarpofix
returned 170 real ASINs, confirmed every single one actually has Brand =
Tarpofix (not a partial-match false positive); brand-only in matrix mode
correctly showed real Tarpofix products across all 24 months without
needing to type anything in the search box first.

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

### Bonus Framework tab

A reference page explaining, per track, exactly how the bonus is
calculated — not computed from uploaded data, this is the *rules*
themselves. For each of the 4 tracks (Brand Manager, Launch Manager,
R&D, Marketplace): how the data is extracted/matched, the formula, a
rate table (Green/Gold), and the quality gate(s). **Rates are pulled
live from `TARGETS.rates` and `TARGETS.stage_weights`, never
hardcoded** — if Finance updates Config and `extract_targets.py` is
re-run, this page automatically reflects the new numbers without any
text needing to be edited. Verified directly: PY1's displayed effective
rates (0.9% green / 1.8% gold) were checked against the actual
precomputed `eff_green`/`eff_gold` fields in `targets.json` — matched
exactly, since the tab reads those same precomputed fields rather than
recalculating them independently (guarantees this page can never quietly
disagree with what the Monthly tab actually calculates).

This surfaced a related bug while building it: the display label "Y1
(F4-12)" was shown everywhere in the UI, but that exact string is also
the literal **object key** `targets.json` uses internally (inherited from
the calculator workbook's own section header). An earlier fix that
changed the label's value directly broke that lookup silently. Fixed
properly this time — the internal key stays `"Y1 (F4-12)"` (matching
external files), and a separate `displayStageLabel()` helper converts it
to "Y1 (M4-12)" only at the point of rendering visible text, never for
object-key lookups. Verified directly: Brand Manager's total bonus for
August (€2,447.52) matches the known-correct value exactly after this
fix, confirming the targets.json lookup wasn't broken.

## Targets — how they get in

Targets are **not entered manually in the dashboard.** There are two layers:

**1. Real per-month targets (preferred, used automatically when present).**
Sourced directly from the source scorecards' actual monthly Good/Better/Best
columns — no dividing, no estimating. **The source is now two separate
files**, not one combined workbook — extraction reads:
- **BM Scorecard**, sheet `Brands` → Launch Manager (`LM (F3M)` = Germany,
  `Expansion (F3M)` = Pan-EU) and Brand Manager (each brand's `PY1` / `Y1` /
  `Discontinued` sections), both Revenue and Profit Margin.
- **Leadership Scorecard**, sheet `Leadership`, row 13 onward → R&D, one
  row per named product. Revenue only — no margin *target* exists for R&D
  in the source. Actual margin is still computed and shown (net profit ÷
  revenue), and the margin gate is treated as an automatic pass when
  there's no target to grade it against.

**A month's target block is identified by the date columns that follow
it, not by its own leading date label** — the block's own label cell is
unreliable (found to read the *previous* month in the actual source
files), but the weekly section immediately after each Good/Better/Best
triple is always the real, unambiguous month it belongs to.
`extract_monthly_targets_v2.py`'s `find_month_columns()` scans forward
from each triple for the first real date rather than trusting the
adjacent label.

**A month is only extracted if it has real data.** Both scorecards are
live trackers that show 0/blank for any month not yet reached — a month
gated out this way is correctly left with no `targets_monthly/<month>.json`
file at all, so it falls through to the quarterly-estimate layer below
instead of being overwritten with zeros.

**Real bug, found and fixed**: Launch Manager's previously-extracted
July/August targets were stale — sourced from an older version of the BM
Scorecard before its figures were revised. Brand Manager and R&D's
extracted figures were unaffected (verified they already matched the
newer file exactly), so this was isolated to Launch Manager specifically.
Rewrote the extraction as `extract_monthly_targets_v2.py` to read the
current two-separate-files format directly (the previous script assumed
one combined workbook named `BM Scorecard 3` / `Leadership Scorecard 3`,
which no longer matches what's actually provided) — see that script's
docstring; `extract_monthly_targets.py` is kept only for reference.

Verified directly against three real user-provided figures spanning all
three tracks, not just re-running the old logic and assuming it's right:
Germany May 2026 revenue (€205,282 / €216,086), Pan-EU May 2026 revenue
(€27,859 / €29,325), and R&D's Solar cover (SLP) May 2026 revenue
(€69,974 / €73,656) — all three matched exactly against what the script
extracted. Then confirmed the fix actually reaches real bonus
calculations: loaded a real August Sellerboard export and confirmed
Launch Manager Germany's tier/bonus computation now uses the corrected
target (€158,497 / €166,839) instead of the old stale one
(€181,289 / €190,831).

**Mapping note:** the source sheets use a 3-tier Good/Better/Best scale;
the dashboard's bonus logic (and Config's rates) only has two tiers. The
dashboard maps **Better → Green target, Best → Gold target** (Good is
extracted but not currently used for tiering). This was an inference, not
an explicit instruction — if that's wrong, it's a one-line change in
`applyTargetsAndTiers()` in `app.js`.

Extract all months with real data in one pass:
```bash
python3 scripts/extract_monthly_targets_v2.py \
  --bm path/to/BM_Scorecard.xlsx \
  --leadership path/to/Leadership_Scorecard.xlsx \
  --out-dir mapping/targets_monthly
cp mapping/targets_monthly/*.json public/targets_monthly/
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
  products, same BM1-4 grouping, Marketplace's single row), columns are
  just Month 1 | Month 2 | Month 3 | Total, and each month's bonus cell
  is tinted by *that row's own tier that month* (a subtotal/group/total
  row is never tinted this way, since it isn't tied to one tier). R&D and
  Marketplace both show the ÷ team-size per-person row here, same as
  Monthly. A month with no saved data (or, for Marketplace, no manual
  entry that month) shows "—" for that column (not €0 — the two mean
  different things), and a banner says explicitly how many of the 3
  months actually have data if the quarter isn't complete yet. Verified
  directly: entered Marketplace data for July only, left August/September
  blank, and confirmed the Quarterly tab correctly showed July's real
  bonus, "—" for the other two months, and a total that only counted the
  one real entry.
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

## Auth gate actually blocks content now

**Real bug, found and fixed**: the passcode overlay showed correctly, but
the dashboard content behind it was fully visible and scrollable the
whole time — a `.locked` CSS class existed (blur + `pointer-events:none`)
but was never actually applied anywhere in the JavaScript, so it did
nothing. Fixed properly:
- Wrapped all real content in `<div id="appContent">`, with `class="locked"`
  hardcoded directly in the raw HTML (not added by JS after the fact) —
  this matters: if the lock were only applied after an async session
  check resolves, there'd be a brief window where unlocked content could
  render before JS finishes. Failing closed by default means there's no
  such window.
- Added `body.auth-locked{overflow:hidden}` too, since blur +
  pointer-events on a child doesn't necessarily stop the page itself from
  scrolling if `<body>`/`<html>` is the actual scroll container.
- A single `unlockDashboard()` function removes both the overlay and both
  lock classes together, called from every path that previously only
  hid the overlay (successful login, valid existing session) — 4 call
  sites consolidated into one.

Verified directly, not just reasoned about: checked the raw HTML *before
any JavaScript runs* and confirmed both lock classes are already present;
simulated a 401 (no valid session) and confirmed the content stays locked
rather than assuming a successful path; then simulated a successful
unlock and confirmed both classes are correctly removed.

### Month list was stale until a manual refresh (real bug, found and fixed)

**Symptom reported**: on first opening the dashboard, only July and
August showed up in the month picker — every other saved month was
missing until the page was manually refreshed.

**Cause**: `boot()` runs immediately on page load, *before* the passcode
is even entered, and one of its first steps (`refreshMonthList()`) asks
the server for the real list of saved months (`/api/data?list=1`). That
endpoint requires a valid session — which doesn't exist yet at that exact
moment, since the person hasn't logged in — so the request always failed
with 401 on that very first attempt, silently falling back to just 2
hardcoded seed months (`2026-07`, `2026-08`) plus whatever happened to be
in this browser's local cache. **Successfully logging in afterward never
re-triggered that fetch** — so the incomplete list just sat there. A
manual page refresh "fixed" it only because by then a session cookie
already existed from having logged in moments earlier, so the *next*
`boot()` succeeded on its first try.

**Fix**: `unlockDashboard()` — the one function every successful
login/session-check path already calls — now also re-fetches the month
list once unlocked, using `await bootPromise` first to guarantee it runs
after the initial `MAPPING`/`TARGETS` load (avoiding a race with
undefined state if login happens to resolve unusually fast).

Verified directly by reproducing the actual bug first, not just applying
a fix blind: simulated no valid session at page load (matching the real
failure condition) and confirmed only the 2 hardcoded months appeared —
same broken behavior reported. Then simulated a successful login and
confirmed all 8 real months appeared immediately afterward, with no page
reload involved at any point in the test.

### Pan-EU upload could get stuck at "Processing 1 file(s)…" (real bug, found and fixed)

**Root cause, found by reproducing the exact trigger, not guessed at**:
the Pan-EU TOC and Unmapped-ASINs features store their own data under
special "pseudo-month" keys (`_pan_eu_toc`, `_manual_asin_additions`) in
the *same* local-storage blob and the *same* GitHub `data/` folder used
for real months — because they reuse the month save/load functions for
convenience (see "Unmapped ASINs tab" and "Pan-EU TOC tab" above).
`refreshMonthList()` was treating every key it found there as if it were
a real month, with no filtering. Because of how strings sort, `_pan_eu_toc`
sorts ahead of any real `YYYY-MM` month — so once that pseudo-key existed
(e.g. after adding a Pan-EU TOC entry that fell back to local storage),
it got auto-selected as "the current month" the next time the list
refreshed, and the code crashed trying to treat that data blob as if it
were a month's full computed structure (`Cannot read properties of
undefined (reading 'by_product')`). Since this crash happened inside
`refreshMonthList()`, called *after* the file's own upload had already
finished successfully, it skipped the line that would update the status
message — leaving "Processing 1 file(s)…" on screen forever even though
the upload itself had completed.

Fixed in three places, each independently useful:
1. **The real fix**: `refreshMonthList()` now filters both the
   local-storage keys and the server's file listing to only genuine
   `YYYY-MM` names before treating anything as a selectable month.
2. **Same filter applied server-side** in `/api/data?list=1` — this bug
   would otherwise have hit *every* user of the shared deployment once
   Pan-EU TOC data reached the shared GitHub repo, not just whoever
   triggered it locally first.
3. **Defensive hardening, regardless of root cause**: wrapped
   `parseCountryF3MFile`'s Papa.parse callback in try/catch (an
   exception thrown inside that async callback does NOT automatically
   reject the surrounding Promise — it would otherwise hang forever,
   silently, which is its own way of producing this exact symptom);
   added a 20-second timeout to every fetch call to our own API
   (`fetchWithTimeout`), so a hung serverless function falls through to
   the existing local-storage fallback instead of waiting indefinitely;
   and wrapped both the per-file loop and the post-loop
   `refreshMonthList()` call in `handleCountryFiles` so any unexpected
   failure anywhere in the chain always ends in a visible error message
   rather than a silently stuck status line.

Verified directly by reproducing the exact trigger condition, not just
applying a fix and hoping: added a real Pan-EU TOC entry (creating the
`_pan_eu_toc` local-storage key), confirmed it genuinely existed
alongside a real saved month, then uploaded a Spain Pan-EU file and
confirmed it completed cleanly with a correct status message — the
dropdown correctly excluded the bogus `_pan_eu_toc` "month" and correctly
selected the real `2026-08` instead.

## Tab order

Reordered by importance, with Upload data moved to last (an
administrative action, not a primary viewing destination): **Monthly,
Quarterly, Impact Analysis, Bonus Framework, Stage History, Unmapped
ASINs, Upload data.**

## No external CDN dependencies

PapaParse and Chart.js are **bundled locally** (`public/vendor/`) rather
than loaded from a CDN. Previously both loaded from `cdnjs.cloudflare.com`
— reported symptom: "Chart is not defined" below the Marketplace section,
meaning the CDN script failed to load for that specific user's network
(browser/firewall/ad-blocker — cdnjs itself was reachable from other
environments, so this wasn't a global outage, just not universally
reachable). Rather than guess at the exact network cause, removed the
dependency entirely: `npm install papaparse chart.js`, copied
`chart.umd.min.js` and `papaparse.min.js` straight from each package's
own `dist/` into `public/vendor/`, and pointed `index.html`'s two
`<script>` tags at the local files instead. Verified both files execute
correctly and expose their real API (`Papa.parse`, `Chart`) after this
change, not just that they're syntactically valid.

## Mobile

Added a real breakpoint (`@media max-width: 720px`, with a second one at
420px for very narrow phones) rather than relying on the viewport meta
tag alone (which was already present but did nothing without actual
responsive rules):
- Header stacks vertically instead of forcing the month/quarter dropdown,
  period badge, and Lock button into one cramped row.
- The 5-tab nav becomes horizontally scrollable instead of wrapping or
  overflowing the screen.
- Upload zones stack their text and file input vertically instead of
  side-by-side.
- Stat cards drop from a wide grid to 2-then-1 columns as the screen
  narrows.
- Stage History / Masterlist filter rows (search box + dropdowns) go
  full-width and stack, instead of squeezing into one line.
- The login card's fixed 340px width is now capped relative to the
  viewport so it doesn't overflow on the narrowest phones.
- Tables were already wrapped in a horizontally-scrollable `.table-scroll`
  container (from the earlier sticky-header work) — that already handles
  the genuinely wide tables (9 columns for Monthly tracks, 24 months for
  Stage History) reasonably on mobile; this pass didn't need to change
  that part.

**Honest limitation:** I could not get a real rendered screenshot at a
mobile viewport width to visually confirm this — the headless browser
tooling available to me needs to download a Chromium binary from a CDN
that's blocked in this environment (confirmed: attempted install, got a
403). What's here is verified structurally (selectors correctly match the
real HTML elements, confirmed by reading the actual markup rather than
assuming) and is standard, well-tested responsive CSS, but a real
phone/browser check on your end is worth doing before considering this
fully confirmed.

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

- **R&D Team** — per product, matched by TOC **Product Code** against the
  calculator's named target rows (`GWK`, `DSD`, `TSE`, `TSF`, `KMS`, `FES`,
  `FRM02`, `WHS`, `SLP`, `VZW`, `AKS`, `WGH25`, `KMK`, `SUP`). Matching is
  exact-or-prefix (`matchRdCode()` in `app.js`): a TOC code matches a
  target row if it equals that row's code, or starts with it — e.g.
  `SLP120` and `SLP400` both roll up under the calculator's single `SLP`
  row, `WGH25` and any `WGH25xx` variant roll up under `WGH25`. This
  mirrors the calculator's own target structure (14 named rows,
  deliberately coarser than the TOC's per-variant product codes).

  **Critically: only F3M + M4-12 stage revenue counts toward R&D, never
  PY1 or Discontinued** — R&D's bonus is specifically "Y1 revenue
  overflow" per the framework (Year 1 = F3M + M4-12 together, the first
  12 months), not lifetime revenue. A single product code can have a MIX
  of ASINs at different stages (an older variant already graduated to
  PY1 alongside a newer variant still in M4-12) — only the still-Y1 ones
  are counted; a graduated variant's ongoing revenue is Brand Manager's
  concern from then on, not R&D's. **This was a real bug, found and
  fixed**: the stage filter was missing entirely, so ALL revenue for a
  matched product code was counted regardless of stage. Verified against
  real August data: `VZW` and `WHS` are 100% PY1-stage as of August 2026
  (every ASIN under those codes has graduated) — before the fix, their
  full August revenue (€62,896.05 and €13,639.47 respectively) was being
  wrongly counted toward R&D's Y1 pool; after the fix, both correctly
  show €0 for August.

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

  Each brand's PY1 / Y1 (M4-12) / Discontinued stage is tiered and
  bonused independently using that stage's *effective* weighted rate from
  Config (e.g. PY1 = 60% × base rate), summing to a per-brand total, a
  per-group (BM1-4) subtotal, and a grand total — matching the
  calculator's own "BM# — BRAND BONUS" subtotal rows. (Label fixed:
  previously displayed as "Y1 (F4-12)" everywhere — a typo, since the TOC
  and internal stage key have always been `M4-12`, not `F4-12`. Purely a
  display fix; the underlying calculation was never affected by the
  label.)

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
- **Marketplace** — fully manual, but now genuinely scoped to a single
  month and matches every other track's format. **This was a real bug,
  found and fixed**: the 3 original input fields (Actual/Green/Gold) had
  *zero* JavaScript wiring at all — no save, no read-back, nothing
  clearing them on month switch. Whatever was typed just sat in the DOM
  regardless of which month was selected, which looked exactly like data
  "saving across all months" even though nothing was actually being saved
  anywhere. Rebuilt properly:
  - 6 inputs now (added Actual/Green/Gold **margin** fields, typed as
    plain percentages — e.g. `24` for 24%), matching every other track's
    revenue + margin quality-gate shape.
  - Tier and Bonus (€) compute live via the same `tierOf`/`bonusOf`
    functions every other track uses, plus a pool-bonus-÷-team-size row
    like R&D.
  - **Saved to `data.marketplace` on the currently-viewed month only**,
    debounced (800ms after the last keystroke) via the same
    `saveMonthData()` every other save path uses.
  - Switching months now actually **populates or clears these 6 fields**
    from that month's saved data — the missing piece that caused the bug.
  - Survives a main-file re-upload, same as Germany/Pan-EU (carried
    forward via `entered: true`, not reset just because R&D/Brand
    Manager's source file was reprocessed).

  Verified directly: entered values for July, computed correctly (🟢
  GREEN tier, €50.00 bonus), switched to August — fields came back
  completely empty, not showing July's numbers — then switched back to
  July and got the exact persisted values and tier back.

  **Currency/percent symbols on the input fields themselves**: an
  `<input type="number">` can't contain a "€" or "%" inside its value at
  all (that would make it an invalid number) — so these inputs looked
  bare no matter what, unlike every other track's read-only cells which
  use `fmtEUR()`/`fmtPct()` to format display text. Fixed the only way
  actually possible for a live number input: wrapped each one in a small
  `.input-affix` span that overlays a static "€" (left) or "%" (right)
  next to the box via CSS `::before`/`::after`, with matching padding on
  the input so the typed digits never overlap the symbol. Applied to all
  6 Marketplace fields — 3 currency, 3 percent.
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
- **`/api/data` and `/api/session` explicitly send `Cache-Control:
  no-store`** — a data endpoint that could be cached (by the browser or
  any CDN in front of Vercel) is exactly the kind of bug that looks like
  "it saved fine but a refresh shows the old data," since the save itself
  succeeds while the *read* silently serves a stale copy. Added
  defensively after exactly that symptom was reported; a direct test of
  the save/reload sequencing itself (upload Germany, then immediately
  Pan-EU, then a fresh page load) showed no data-loss bug in the app
  logic, which is what pointed at caching as the more likely explanation.
  If this doesn't fully resolve it, the next diagnostic step is checking
  `data/<month>.json` directly on GitHub after a save, to confirm whether
  the write or the read is the actual problem.
- **A more likely real cause, found and fixed**: every update zip through
  v32 included `data/2026-07.json` and `data/2026-08.json` (regenerated
  seed files). Dragging a full package into the repo — the exact
  instruction given every time — meant those seed files silently
  overwrote whatever real months had been saved since, including any
  dedicated Germany/Pan-EU uploads. This is likely what actually happened
  here, not a caching or save-logic bug. **Fixed by no longer shipping
  `data/` or `public/data/` in update packages at all** — see the warning
  at the top of this file. If real data was lost this way, it's
  recoverable: the original CSVs still exist locally, so the affected
  months just need their uploads (main file, and any Germany/Pan-EU
  files) redone; GitHub's per-file commit history can also restore an
  older version directly without re-uploading.

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
