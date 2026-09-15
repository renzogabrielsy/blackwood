# 2026-09-15 (2) — `/operations` second refinement round: waste ÷ produced, day ratios, split resiko, units left

> Continues `2026-09-15-ops-ledger-refinements.md`. Branch `feat/ops-ledger-refine-2` → `main`.

## 1. TL;DR
Renzo confirmed the page ("looking good!") and asked four things. All shipped. The important ruling: **waste loss % is waste ÷ PRODUCED kg** (was ÷ fed). JULY 2026 now 15.24 %, Q3 14.62 %.

## 2. Shipped
- **Data** — `supabase/migrations/20260915032016_ops_ledger_day_ratios_waste_over_produced.sql`: `view_ops_ledger_day` + `waste_pct`/`yield_pct`/`loss_pct` (day-level fractions, indicative); `view_ops_ledger_campaign_kpis.waste_loss_pct` re-defined over produced; `fn_ops_ledger_group_kpis` DROP+CREATE (`produced_kg_waste_reported`); probes extended; both views re-ALTERed `security_invoker`. `lib/operations/types.ts` / `queries.ts` map the new fields. `scripts/verify-ops-ledger.ts` → 75 assertions.
- **UI** — `ops-kpi-strip.tsx` (11 columns, `UnitValue` in every cell, 159 px tall), `ops-ledger-table.tsx` (DRIFT → WASTE · WASTE % · YIELD % · LOSS %; spine 916 px; un-freeze at <1024 px), `ops-format.ts`, `ops-day-detail.tsx`, `ops-lens.ts`. `components/shared/unit-value.tsx` (moved from analytics; analytics file re-exports).
- Docs: operations `CONTEXT.md`, analytics `CONTEXT.md`, plan §3.7, `CLAUDE.md`, TIMELINE.

## 3. Learnings
- A migration generator that emits raw apostrophes inside `comment on … is '…'` produces an on-disk file that is invalid SQL while the applied text was escaped — the md5(file) = md5(schema_migrations.statements) check is what caught it. Keep doing that check.
- The verify script's 5,000 ms per-campaign budget is wall-clock and round-trip dominated (server-side 280–580 ms); it tripped twice under concurrent load from elsewhere. Not a SQL regression; budget left as is.
- `UnitValue` is a platform component now — use it for any unit-bearing cell, never re-implement the glyph.

## 4. Not verified
Live figures with a session on production (fixture-verified only, as before). `/analytics` after the `UnitValue` move is proven by tsc + build, not rendered.

## 5. Open / next
- Add a static assertion pinning the EOQ column count and the spine width (the `verify-rc-movement-grid.ts` idiom).
- Blocks-fed footer still has no per-block campaign total (needs a view column).
- Delete or archive `/dev/ops-ledger` drafts once Renzo is done comparing.
