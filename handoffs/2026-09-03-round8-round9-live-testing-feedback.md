# 2026-09-03 (session 3) — Renzo's live-testing feedback: batches year split, round 8 cleanup, RC Inventory Price, v2 sort/filter, year-overlay charts

> Continues `2026-09-03-blend-proposal-history-shipped.md`. Everything here is Renzo's feedback
> while testing the live app; all shipped to `main`. No `workers/sync/**` changes — no Fly deploy.

## TL;DR for the next session
1. All of Renzo's items are live. Nothing is pending build. Watch for his next round of feedback
   on: the year-overlay charts (R9), the v2 deliveries grid's sort/filter, and the merged
   campaign table (now 11 rows).
2. Two things left on purpose for later: the campaign table's five removed production rows
   (Output/day, Downtime, Power, Power intensity, Bags) still exist in the data layer and the
   `MetricKey` registry — restore is a registry flip; and the Proposals list on phones is a
   horizontally-scrolling table (a card layout was offered).

## Shipped, in order (all on `main`)
- **Batches → Year + Batches dropdowns** (`bcab034` / merge `c924231`): `lib/analytics/campaign-selection.ts`
  + `verify-campaign-selection.ts` (11). `?bhide=` contract unchanged; both lists are projections of
  the one hidden set; a toggle writes a diff, never a rewrite.
- **RC Inventory Price = Blocking** (`818fe3b`, migration `20260903013948`, APPLIED): the analytics
  "stock avg cost" was valuing 1,216,313 kg of CLOSED-batch residue at ₱28.63 alongside the open
  yard, reading ₱36.26 where Blocking reads ₱37.14. `view_analytics_inventory_eom` now values OPEN
  piles only (the aging view's own `closed` CTE, reused verbatim) — current row equals Blocking
  **digit for digit** (37.139967505327993986, 10,527,344.00 kg / 170 blocks); 30 of 75 months
  moved, max Δ ₱+1.1158 (2026-01); old figure preserved as `all_positive_avg_unit_cost_php_kg`
  + `closed_residue_*`. Row renamed **RC Inventory Price**, key unchanged.
- **Round 8** (`416f087` + `25d9e88`, merge `570bcc1`): v2 deliveries grid switched on the
  universal `enableSort`/`enableFilter` (it was `scope="endless"` defaulting both OFF; asserted
  no pager props exist); **header widths re-measured to pay the 57 px sort/filter chrome**
  (`verify-rc-in-grid.ts` 37, pins every width against `HeaderCell.tsx`'s markup — the third
  instance of the "header owes chrome" bug); campaign + suppliers prose removed (`~`/`—` legend
  moved into the row dictionaries); five production rows dropped from the campaign table (11 remain,
  `Print 11`, reorder key bumped, retired `?metric=` links resolve to the section top).
- **Round 9 — year-overlay charts** (`ef2c0e7` + `228cc93`, merged): every M/Q/campaign expand
  plots ONE LINE PER YEAR on a fixed axis (Jan–Dec / Q1–Q4 / JANUARY–DECEMBER); Y mode keeps the
  long chart. `lib/analytics/year-overlay.ts` (pure placement; a custom campaign name lands
  immediately after its start month's slot, from `first_reported_date`/`first_fed_date` already
  on the wire) + `verify-year-overlay.ts` (24). Style popover (`year-style-menu.tsx`,
  `use-year-styles.ts`, localStorage `bw.analytics.yearstyle.v1`): color + stroke per year,
  palette validated with the dataviz checker, dash-distinct so print stays mono-readable.
  Companion pairs, the price overlay and the avg line are held back when ≥2 years overlay (a
  sentence says how to get them back). **A year's line BRIDGES another year's custom slot**
  (explicit per-point flag, never `connectNulls`); a missing month still breaks.

## Process lesson recorded in memory
Two agents ran concurrently in ONE working directory; a `git checkout -b` moved the tree and the
backend commit landed on the frontend agent's branch. Recovered by merging that one branch and
deleting the empty stray. Rule now in `~/.claude/.../memory/parallel_agents_worktree.md`:
parallel agents get `isolation: "worktree"`.

## Verification caveat (still)
Google OAuth blocks the sandbox; every UI item was verified on fixtures. Renzo tests live.

## Gates (green on every merge)
tsc · lint 146/16 · build · verify-table-core 84 · verify-rc-in-grid 37 · verify-campaign-selection 11 ·
verify-year-overlay 24 · e2e 57 · verify-worker-view-grants 4/0 · verify-trigger-grants 0.

## Addendum (later the same day) — SYNC INCIDENT L-048: RC OUT stuck at Aug 28
Renzo flagged run `f1e9f342` ("latest data Aug 28" while every source is at Sept 2). Diagnosis,
measured: only `rc_out` (max 2026-08-28) and `truck_readings` (2026-08-27) lagged; deliveries,
production, electricity, flecon were at Sept 1–2. **Root cause (rc_out):** MC's new September
PROPOSED workbook names its day tabs `Aug. 29` / `Sep. 1` / `SEP. 2` — a PERIOD after the month —
and `SHEET_NAME_RE` (`/^([A-Za-z]+)\s+(\d{1,2})\s*$/`) rejected all three, so `extractProposed`
returned 0 rows with 3 soft warnings, classify/apply wrote 0, and the run STILL labeled the email
processed + advanced the watermark and reported `succeeded` with no finding. PROPOSED is the SOLE
rc_out writer (gsheet's rc_out mode is skipped under the R4b cutover), so nothing backfilled.
It began 2026-09-01 (that day's workbook had a single literal `Sheet1` tab). RC MOVEMENT says the
waiting feedings are Aug 29 12,314 / Sep 1 41,867 / Sep 2 28,656 kg = 82,837; Blocking's 79,165-kg
4-block gap is the same thing from the other side. **Trucks is a SOURCE gap, not a bug:** MC's
Sept 1 truck section lists AAV 6111 / KCA 378 with departure/arrival/km/litres blank since Aug 28.
The deliveries "report never arrived" on `f1e9f342` was a FALSE ALARM: the 01:41 UTC scheduled run
had already processed + labeled that email and the 03:13 manual run then could not find it.

**Fix shipped** (`a136daa`, merge `6b046e6`; Fly **v24 = build 6b046e6**, deployed 03:51 UTC):
tolerant tab tokenizer via `lib/months.ts::monthNumberFromToken` (`Aug. 29`, `SEP. 2`, `Sept 1`),
new `sourceTabs.ts` finding — 0 of N tabs parsed = HIGH and the email is NOT labeled and the
watermark NOT advanced (`source_unconsumable`), some-of-N = attention; `report_not_received`
consults `ingestion_watermarks` (`alreadyProcessedToday`); Python oracle regex in lockstep, parity
12/12 clean; +37 worker tests (885), verify-findings 58. Ledger **L-048**. Real-file proof: the
September workbook now yields 10 rows / 82,837 kg; the two August workbooks replay identically.

**Open at handoff:** the `260902` email is already in `Blackwood-Processed`, so the worker will
not re-fetch it. Either (a) wait — tomorrow's cumulative PROPOSED email carries Aug 29 / Sep 1 /
Sep 2 tabs and the gap closes on the next scheduled run; or (b) remove the label from thread
`1875272603932533822` and click Run Sync now. Renzo decides; the label was NOT touched.
Standing: gsheet rc_out `changed 12 / flagged 1` re-fires every run (unexamined); MC's blank truck
km since Aug 28 (chase sender).
