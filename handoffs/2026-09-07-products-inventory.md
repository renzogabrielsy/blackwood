# 2026-09-07 — PRODUCTS INVENTORY (finished-goods flec stock) shipped, + per-user analytics prefs

> Continues `2026-09-03-round8-round9-live-testing-feedback.md`. Renzo tests on the live site.
> Vercel: `main` @ `96417b0`. Fly worker: **v25 = build 96417b0** (the `products` report is live).

## TL;DR for the next session
1. **`/inventory/products` is live** (Option A of three drafts: canvas
   https://claude.ai/code/artifact/c607f494-e462-4d30-bdc8-d49e9d138c36). Renzo has not yet
   clicked through it. Expect feedback on: the flec-first header, the big grade tabs, the
   Blackwood-Table ledger (sort/filter on), the once-per-grade source-defect notes.
2. Known follow-ups he was offered: (a) the ledger footer sums LOADED rows, not the filtered
   view — following the filter needs an `onViewChange` seam on `BlackwoodTable` (platform
   change, not made); (b) the Proposals list on phones is a horizontally scrolling table.

## Shipped this session (all on `main`)
- **Analytics prefs remembered per user** (`ed9beb5` / merge `997c6f1`): `lib/analytics/prefs.ts`
  + `use-analytics-prefs.ts`; localStorage instantly + `user_table_settings (module='analytics')`
  debounced 500 ms; year styles, expand hidden years (page-wide), overlay/avg toggles, Compare
  mode, per-working-day, Definitions, row order; URL still wins when it speaks; Reset in the
  Style menu. **Found + fixed underneath:** `user_table_settings` had NO grant to `authenticated`
  (policies only), so every RC IN settings save had failed 42501 since creation — migration
  `20260903065818` grants SELECT/INSERT/UPDATE (no DELETE, no anon/service_role).
- **PRODUCTS INVENTORY** (`28901ef` data + `385c53a` page, merge `96417b0`):
  - Source: Renzo's Sheet `1s2YqAuBbZBZRfw5XH_ZhbA9dYDO0raxDDuFbcHfmEog` (one tab per grade;
    XLSX export, no auth). Tabs today: 8X50, 6X50, 2X6, Kuraray 3x50, 4X8.
  - Schema (migrations `20260907060924/062522/063310`, APPLIED): `product_grades` (canonical
    `code`, `sheet_name`, `aliases`, `thresholds`, `opening_as_of`, `content_fingerprint`),
    `product_grade_openings`, `product_movements` (`row_hash` = replace-by-grade idempotency key,
    EXCLUDES the grade code so a rename does not rewrite the ledger; `sheet_running` kept for
    cross-check). Views `view_product_stage_balance` / `view_product_onhand` / `view_product_ledger`
    (running balances via `SUM() OVER`, never in TS) / `view_product_portfolio`. RPCs
    `service_role` only. **NO ₱ anywhere.** PROVEN: SQL balance per stage == every tab's own
    header count (12/12 pairs, 0 gaps); `vans_ready` == the sheet's FINAL/44 to the digit.
  - Worker report `products` (parallel writer; watermark `products`; committed workbook fixture;
    32 tests; no Python oracle — recorded in PORTING_DECISIONS). **Rename rule, decided by
    content not name:** unknown tab → fingerprint match (opening + first 10 rows) with the old
    tab absent = RENAME; else ≥80% `row_hash` overlap with an absent grade = RENAME (attention);
    else NEW grade auto-created (`product_grade_added`); absent tab = `product_sheet_missing`;
    ambiguous = `product_grade_ambiguous`; unreadable tab = the L-048 `source_tabs_unreadable`
    constructor (high at 0-of-N, source unconsumed). Sheet id = committed default with
    `PRODUCTS_SHEET_ID` env override. First live run: 808 movements / 5 grades; re-runs 0/0.
  - Two SOURCE defects flagged, not repaired (columns on the views; the page states each once
    per grade): the Sheet's own running cells disagree with its own deltas on 448/808 rows (the
    header totals agree with the deltas, so the running cells are the wrong side); four 2X6 rows
    dated 2025-07-29 (year typo). Kuraray needs date carry-forward (blank DATE + TYPE = continuation).
  - Page: `?grade=` deep link; portfolio line; sync chips (privileged only) for the four
    product findings; big tabs; hero = shippable flecs, vans secondary, tons subtext; stage strip;
    thresholds/opening/last movement/synced; ledger on the Blackwood Table (`enableSort`/
    `enableFilter`, running lanes not sortable, widths measured + pinned by
    `scripts/verify-products-grid.ts` 25). Navbar registered.

## Gates (green on every merge)
tsc · lint 146/16 · build · verify-table-core 84 · verify-products-grid 25 · verify-analytics-prefs 15 ·
verify-findings 65 · e2e 57 · worker tests 917 · parity 12/12 · container build · worker-view grants 4/0.

## Standing items (Renzo to rule)
Sept 2 PROPOSED email still labeled processed (L-048; closes on the next cumulative email) ·
MC's blank truck km since Aug 28 · gsheet rc_out `changed 12 / flagged 1` re-fires every run ·
March 2026 meter reading · Aug reason-only downtime · graveyard deletion · status-spotlight ring
CSS order · empty `FEEDING # n` batches.
