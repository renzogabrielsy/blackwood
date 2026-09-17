# 2026-09-17 (2) — `/operations` sixth round (ratios toggle, lean block footer, Actual ₱ toggle, page print) + the Excel report mock-up

> Continues `2026-09-17-rc-movement-footer-and-waste-frontier-L052.md`. Branch `feat/ops-ledger-refine-6` → `main`. No database change.

## 1. TL;DR
Four page items shipped. The Excel report was formulated, mocked up locally with live data and formulas, hand-edited by Renzo, and his format was detected and captured for the future automated builder. Two data findings surfaced (below).

## 2. Shipped
- NEW `app/(app)/inventory/rc-movement/actual-price-toggle.tsx`, `app/(app)/operations/ops-page-print.tsx`.
- `ops-lens.ts` / `page.tsx` / `operations-view.tsx` (`?ratios=`, Ratios toggle, Print button), `ops-ledger-table.tsx` (`showRatios`, derived un-freeze breakpoint), `ops-kpi-strip.tsx` (`opsKpiPrintTable()`), `ops-rc-movement-modal.tsx` (local Actual ₱ switch).
- `rc-movement-matrix.tsx` (3-line footer, `W_BLOCK` 116, optional `showActualPrice`), `rc-movement-grid-v2.tsx` (same footer, `TOTALS_H` 46, `?actual=`), `rc-movement-route-view.tsx`, `scripts/verify-rc-movement-grid.ts` (14 assertions).
- Docs: operations + rc-movement `CONTEXT.md`, plan §3.11, NEW `.agents/plans/ops-ledger-excel-plan.md` (formulation §1–8, **format rules §9**).

## 3. The Excel mock-up (NOT in the repo — local scratch)
`Blackwood Operations - Q3 2026 (mock-up).xlsx`, built by a Python/openpyxl script from live Q3 2026 data. 1,075 formulas, 0 errors, 39/39 checks equal to the DB. Renzo's hand edits to JULY + RC table 1 were detected, propagated and folded into the generator. The REAL builder is still to be built (plan §6–7: `exceljs` added to root deps, route handler `app/(app)/operations/export/route.ts`, four passes).

## 4. Findings needing Renzo
1. **Basis mismatch on the EOQ strip:** RESIKO COST (`uplift_php_kg`) is whole-block; ACTUAL FED PRICE shown is campaign-attributed. Fed Price + Resiko Cost ≠ Actual by ~₱0.07. Pick one basis for both.
2. **AUGUST 2026 fed total dropped 709,627 → 697,313 kg on 2026-09-17 with no audit trail** — `rc_out` has no audit trigger. Follow-up task chip raised ("Investigate untraced 12,314 kg drop…").
3. Excel open questions: RC footer links black or green; adopt his EOQ Summary edits as format (subtitle removed, Arial 11 bold, zoom 130, checks row hidden); the five decisions in plan §8.

## 5. Not verified
Live figures with a session (fixture-verified only). Printed output from production on real paper.

## 6. Next
Renzo answers §4; then build the Excel export (plan X1–X4). Standing open items: group PC-cost coverage rule, dead `OpsCampaignOption.totalFedKg`, unused `view_ops_ledger_day_blocks_used`, `/dev/ops-ledger` drafts, Escape double-close in the RC Fed modal.
