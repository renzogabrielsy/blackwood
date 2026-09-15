# 2026-09-15 (3) — `/operations` third round: shift child rows, BLOCKS USED modals, inline units

> Continues `2026-09-15-ops-ledger-refinements-round-2.md`. Branch `feat/ops-ledger-refine-3` → `main`.

## 1. TL;DR
Renzo's five asks shipped: units inline with column titles everywhere; no date line in the EOQ campaign cell; a day expands into one child row per shift in the parent's columns (nothing else); the FED PRICE and ACTUAL FED PRICE modals are his workbook's BLOCKS USED tables (7 and 12 columns) with counts; all modal definition prose removed.

## 2. Shipped
- **Data** — `20260915073755_ops_ledger_campaign_blocks_and_shift_grades.sql`: `view_ops_ledger_shift` + `waste_pct`, `grade_kg`; NEW `view_ops_ledger_campaign_block` (per-campaign fed kg per block + block life + BLOCK/ACTUAL/RESIKO price, ₱-gated); NEW `fn_ops_ledger_group_blocks(text[])`; probes +4 keys (80 assertions). `20260915074246` fixed the new view's COMMENT. `lib/operations/types.ts` (`OpsCampaignBlock`, `OpsGroupBlock`, `OpsShift.gradeKg/wastePct`; `blocksUsed` removed), `queries.ts`.
- **UI** — `ops-blocks-table.tsx` (NEW), `ops-kpi-strip.tsx`, `ops-kpi-modal.tsx`, `ops-ledger-table.tsx`, `operations-view.tsx`; `ops-day-detail.tsx` DELETED. Spine 922 px with ₱ / 820 without.
- Docs: operations `CONTEXT.md`, plan §3.8, `CLAUDE.md`, TIMELINE.

## 3. Learnings
- `view_ops_ledger_day_blocks_used` still exists in the DB but nothing reads it now — candidate for a later drop (not done; dropping is a separate decision).
- A set-valued posture assertion (the exact list of money-named columns) caught a wrong COMMENT a count would have passed.
- The verify script's per-campaign 5,000 ms budget is wall-clock; it tripped once on a 1-day campaign (6.8 s, was 0.6 s minutes earlier) — network, not SQL. Budget untouched; if it keeps tripping, measure server-side before touching it.

## 4. Not verified
Live figures with a session (fixture-verified only). The blocks-used tables against real JULY 2026 blocks are worth one look.

## 5. Next
Renzo reviews on production. Open: drop `view_ops_ledger_day_blocks_used` (unused); static assertion pinning the strip column count / spine width; delete `/dev/ops-ledger` drafts.
