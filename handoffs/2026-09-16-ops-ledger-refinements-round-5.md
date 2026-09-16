# 2026-09-16 (2) — `/operations` fifth round: FED-day sidebar + projected lab profile, quarters by date, aligned footers, print

> Continues `2026-09-16-ops-ledger-refinements-round-4.md`. Branch `feat/ops-ledger-refine-5` → `main`.

## 1. TL;DR
Seven asks shipped. New data: a per-day PROJECTED lab profile of what was fed (kg-weighted over the blocks fed, reproducing the Blocking grid's delivery-weighted means exactly), midpoint-rule quarter keys on the campaign list, and per-campaign arrival/resiko totals for the aligned footer. New UI: FED-cell sidebar, quarter-grouped picker defaulting to the latest quarter, aligned tinted footers, leaner Production modal, tiled result bars, printable Fed Price / Actual Fed Price sheets (single campaign, all-separately, or pick-one from the group modal).

## 2. Shipped
- **Data** — `20260916030358_ops_ledger_day_fed_blend_quarters_arrival.sql` (NEW `view_ops_ledger_day_fed_blend`; `view_ops_ledger_day_block` + seven lab stats; span view + `midpoint_date`/`quarter_key`/`quarter_label`; kpis + `blocks_delivered_kg`/`blocks_total_fed_kg`/`blocks_resiko_kg`/`blocks_closed_resiko_loss_pct`; probes +3), `20260916031811_…` (verify split for the pre-existing group PC-cost coverage divergence). `lib/operations/types.ts` / `queries.ts` (picker now reads the span view — includes production-only campaigns the RC Movement picker omits). 87 assertions.
- **UI** — NEW `ops-fed-day-sheet.tsx`, `ops-print-sheet.tsx`; `components/shared/print/{print-card.ts,group-print.tsx}` (moved from analytics; re-exports left). Changed: `ops-ledger-table.tsx`, `ops-group-picker.tsx`, `ops-lens.ts` (`latestQuarterKeys`), `page.tsx` (default = latest quarter), `ops-blocks-table.tsx` (tfoot, tints, print variant), `ops-production-table.tsx`, `ops-kpi-modal.tsx` (result tiles, `actions` slot), `ops-kpi-strip.tsx`, `ops-format.ts`, `operations-view.tsx`.
- Docs: operations `CONTEXT.md`, analytics `CONTEXT.md`, plan §3.10, `CLAUDE.md`, TIMELINE.

## 3. Learnings
- `batches.quality_stats` is NOT a lab profile (3 keys, `bd` ≈ 0 everywhere); the Blocking grid's delivery-weighted means are, and they must be reproduced (the grid has no rows for closed blocks).
- Quarter membership = the quarter of the span MIDPOINT, in SQL; no date arithmetic in TS.
- Tailwind v4 positions dialogs with the individual `translate` property; `transform: none` does not reset it, and Lightning CSS refolds `translate` resets into `transform`. Portal the print stage to `<body>` instead.
- The verify wall-clock budget is round-trip dominated (buffers identical run to run); it is now 10 s + a 12×-median load-independent guard.
- Pre-existing divergence: group PC cost (delivered) computes under partial fed-price coverage while the campaign figure blanks. Open decision (aligning blanks an EOQ cell).

## 4. Not verified
Live figures with a session (fixture-verified only). The projected profile against real JULY 2026 days and the printed sheet from production are worth one look.

## 5. Open / next
- Decide the group PC-cost coverage rule (blank vs compute).
- Remove `OpsCampaignOption.totalFedKg` (dead) from types/adapter.
- Drop unused `view_ops_ledger_day_blocks_used`; static column-count/spine-width assertion; delete `/dev/ops-ledger` drafts; Escape double-close in the RC Fed modal.
