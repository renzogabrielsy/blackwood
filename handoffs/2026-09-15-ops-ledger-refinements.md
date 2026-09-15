# 2026-09-15 — `/operations` refinement round (Renzo's seven asks) + campaign waste totals

> Continues `2026-09-14-ops-ledger-incident-recovery-operations-page.md`. Branch `feat/ops-ledger-refine` → `main`.

## 1. TL;DR
Renzo looked at `/operations` on production and asked for seven things; all seven shipped. One needed data first (the EOQ "Waste Loss" column), so the campaign KPI view and the group RPC gained the eight waste streams + total + `waste_loss_pct`. Replacing the view reset its `security_invoker` flag AGAIN (second time in two days) — repaired, and the verify script now guards it from the catalog.

## 2. What shipped
**Data** — `supabase/migrations/20260915021820_ops_ledger_campaign_waste.sql` (view columns appended, group RPC DROP+CREATE with grants re-applied, both verify probes extended with waste folds), `20260915021924_…_security_invoker_restore.sql`. `lib/operations/types.ts` / `queries.ts` map `waste`, `wasteKg`, `wasteShiftCount`, `wasteLossPct` (+ group `campaignsWasteReported`, `fedKgWasteReported`). `scripts/verify-ops-ledger.ts` → 72 assertions.

**UI** — `app/(app)/operations/ops-ledger-table.tsx` (NEW, replaces `ops-ledger-split.tsx`: one table, frozen spine columns, `border-separate` gridlines, rows keyed `campaign:date`), `ops-kpi-modal.tsx` (NEW: formula + inputs + result per KPI, payload numbers only), `ops-color.ts` (NEW palette), `ops-kpi-strip.tsx` (nine columns, cells are buttons), `ops-lens.ts` (Production lens, default), `operations-view.tsx`. Docs: operations `CONTEXT.md`, plan §3.5/§3.6, `CLAUDE.md`.

## 3. Learnings
- **`CREATE OR REPLACE VIEW` keeps grants, resets `reloptions`.** Re-ALTER `security_invoker` in the same migration; check `pg_options_to_table(reloptions)`, never the grant table. Now in memory and in the verify script.
- **Changeover dates are two rows.** A day belongs to a campaign, so any key/identity is `campaign:date`. The stray-row bug was React duplicate keys.
- **`border-collapse` makes sticky cell backgrounds transparent** — frozen panes need `border-separate; border-spacing: 0` with per-cell borders (RC Movement carries the same note).
- Interpretation recorded: "Waste Loss" = the eight recorded waste streams (TRML/RS/BF/GRITS) as kg and as a fraction of fed kg; resiko lives inside the Actual Fed Price cell. The modal shows the formula so Renzo can correct the reading if he meant something else.

## 4. Not verified
Live figures on production — the browser check ran on a synthetic three-campaign fixture (correct wiring, changeover dates, one scroller, price-denied layout), not on real numbers with a session.

## 5. Next concrete action
Renzo checks `/operations` on production (Production lens default, click a few EOQ cells, "view as Production"). Open decision: Blocks-fed footer still has no per-block campaign total (needs a view column). Then decide whether to delete the `/dev/ops-ledger` drafts.
