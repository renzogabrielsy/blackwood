# 2026-09-17 — RC Movement footer misread (labelling) + SYNC L-052: silently dropped waste days

> Continues `2026-09-16-ops-ledger-refinements-round-5.md`. Two branches → `main`: `fix/rc-movement-block-footer` (merged `5713854`) and `fix/sync-waste-frontier` (this commit). Fly **v30** deployed (from the working tree; redeployed after the merge so `BUILD_SHA` matches `main`).

## 1. TL;DR
- Renzo read the RC FED modal's block footer (`FED 69,013`) against a column summing 54,941 and concluded the loss formula was wrong. **It was not** (AUGUST 2026 yield divides by its own 709,627 kg, tied three ways); the footer printed the block's LIFETIME total under a one-campaign column with no label, plus a stray minus on LOSS. Fixed on BOTH grids: `THIS CAMP <kg>` on top (from `view_ops_ledger_campaign_block.campaign_fed_kg`, one read shared by both grids), then `all campaigns` over LIFE / LOSS / ₱/KG / ACTUAL; loss prints positive.
- Five producing days had no waste row. **Ivy reported all five**; the sync dropped them because `extractIvy` inherited MC's runs watermark and skipped silently. Waste now has its own frontier + a loud gap audit (`waste_row_missing` / `waste_row_disagrees`). While wiring it: L-051's `downtime_notes` had never reached a stored run (`toApplyResult` fixed-key object) — fixed.

## 2. Shipped
- **App** — `app/(app)/inventory/rc-movement/{actions,rc-movement-matrix,rc-movement-grid-v2}.tsx`, `scripts/verify-rc-movement-grid.ts` (10 → 12), CONTEXT files.
- **Worker** — `workers/sync/src/reports/production/{index,extractIvy,classify,apply}.ts`, NEW `wasteGap.ts`, `src/lib/db.ts` (`productionWasteFrontier`), `src/workflows/normalizeReport.ts` (`downtime_notes`), NEW test `production-waste-frontier.test.ts` (+31 → 1,043), parity 12/12 (79 expected deviations, baseline re-measured), `specs/production.md` §3a, `PORTING_DECISIONS.md`, `LEARNING_LEDGER.md` L-052, `CLAUDE.md`. App-side finding vocabulary: `app/(app)/sync/types.ts`, `lib/sync/{cases-fold,findings}.ts`, `scripts/verify-findings.ts` (90 → 96).
- NEW `workers/sync/scripts/backfill-waste-frontier-gap.ts` — dry-run by default.

## 3. THE BACKFILL — APPLIED 2026-09-17 (Renzo: "yes go and apply backfill")
Ran `npx tsx scripts/backfill-waste-frontier-gap.ts --apply` from `workers/sync` — `inserted 5, replaced 1`, exactly the dry run: INSERT JULY 07-24 (5,746.5 kg) · 07-30 (4,318.5) · 07-31 (1,199.5) · 08-01 (590.5, "PCG") · AUGUST 08-04 (4,185.5); REPLACE AUGUST 08-01 590.5 → 993.5 kg ("ZAMBAONGA"; the stored row is JULY's carryover). Writes go through `write_ingestion_audit` / `fn_apply_production_upstream` only. Verified after apply: JULY waste **106,506.5 kg (17.15% of produced)**, AUGUST **78,954.5 kg (14.27%)**, zero producing days without a waste row in either campaign, AUGUST 08-01 now reads `50/520/… ZAMBAONGA`.

## 4. Learnings
- A watermark that is right for one writer must never be inherited by another source (L-043/L-044 one level up). A silent `continue` on a date filter is a data-loss primitive.
- A finding that is "built and read at both ends" can still never fire if the normaliser drops its key — check stored runs, not the code.
- Footer labels under a per-campaign column must say which clock they are on; 78 of 523 blocks span campaigns.

## 5. Next
Renzo: check `/operations` JULY/AUGUST waste columns on production (next sync run should raise no `waste_row_missing`). Open items unchanged from round 5 (group PC-cost coverage rule, dead `totalFedKg`, unused `view_ops_ledger_day_blocks_used`, `/dev/ops-ledger` drafts, Escape double-close).
