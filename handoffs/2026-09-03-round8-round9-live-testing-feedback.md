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
