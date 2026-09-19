# 2026-09-19 — Blocking PRICE LENS shipped (first of three highlight lenses)

> Continues `2026-09-18-ops-excel-export-and-rc-movement-print.md`.

## 1. TL;DR
- Renzo: see the blocking grid "ratio'd in highlights based on price filter, supplier and age …
  if market is 40.23, 41 and up is above market. Let's work on a UI for price first so we can
  reuse it."
- Designed from an interactive mock he approved, then built data layer → UI in one worktree and
  merged to `main` (`3778e19`). Migration `20260919025729_blocking_price_lens` is APPLIED.
- **Next concrete action:** Renzo tries Highlight on the live Blocking page; then build the
  **Supplier** and **Age** lenses on the same frame (§6).

## 2. What shipped
**Data (`supabase/migrations/20260919025729_blocking_price_lens.sql`)**
- `fn_blocking_market_bases(p_trailing_days)` — `this_month` (default) · `last_month` ·
  `last_3_months` · `trailing_days`. Month bases SELECT from `view_analytics_rcin_monthly`;
  only the trailing window reads `deliveries`, same `market` + `cost_basis > 0` predicate.
- `fn_blocking_price_lens(p_market_php_kg, p_edge_offsets int[])` → jsonb: `R = floor(market)+1`,
  bands cut at integer offsets from R (default `[-1,0]`, max 6), per-band blocks/kg/shares,
  per-block `band_index`, `unpriced`, `total`. Human `{ok:false}` refusals.
- `fn_blocking_price_lens_probe` — `service_role`-only bridge for the verify script.
- Actions `fetchBlockingMarketBases` / `fetchBlockingPriceLens` in `blocking/actions.ts`:
  `canViewPrices()` FIRST, refusal `prices_hidden` with no DB call.
- `scripts/verify-blocking-price-lens.ts` — 49 assertions.

**UI (`app/(app)/inventory/blocking/lens/`)** — `types.ts` (classifier-function seam) ·
`registry.ts` (`BLOCKING_LENSES`) · `lens-panel.tsx` (docked frame) · `price-lens-panel.tsx` ·
`price-lens-settings.ts` · `use-lens-settings.ts`; wiring in `blocking-grid.tsx` (Highlight
button, exclusivity, prop chain) and `blocking-route-view.tsx` (`?lens=price`); ramp classes in
`app/globals.css`; fixture `/dev/table-playground/pricelens`; `scripts/verify-blocking-lens-ui.ts`
— 68 assertions.

## 3. Renzo's rulings
1. Market defaults to this month's deliveries; every basis is configurable.
2. Three bands by default, more configurable.
3. Production never sees the Price lens.

## 4. Critical learnings
1. **An inlined CTE is re-executed once per reference.** The grid CTE ran 4×; `AS MATERIALIZED`
   took the lens 85 → 4.8 ms. Measured under a 5 s timeout before any proof.
2. **`'NaN'::numeric > 0` and `'Infinity'::numeric > 0` are TRUE** — guard them explicitly.
3. **A typed signature can make a refusal unreachable**: `int[]` rounds 1.5 → 2 before the body
   runs, so integrality is enforced in the server action.
4. **Band membership is price.** No price-free half exists, so the gate is a refusal, not nulling.
5. **`useTableSettings()` is RC IN's document** (global provider, typed). Per-module settings go
   through `getUserModuleSettings` / `saveUserModuleSettings`, one module key per lens.
6. **`preview_start` serves the MAIN checkout.** A worktree agent must run its own
   `next dev -p <port>` from the worktree or its new routes 404.
7. Tint (alpha over the cell + inset ring) rather than replace the background, or the
   lab-highlight text drops below AA.

## 5. Current state
Live numbers 2026-09-19: market ₱39.8568 → R 40 · below 61 blocks / 3,999,138 kg / 38.2% ·
at 7 / 446,572 / 4.3% · above 100 / 6,024,189 / 57.5% · unpriced 0 (so the unpriced branch has
no live coverage yet — proven by invariants and the fixture only).
**Not verified:** the real page under a signed-in session; the phone-landscape header.

## 6. Open / next
- **Supplier lens:** tint by supplier share (the data already exists —
  `view_blocking_block_suppliers`, ALL/SOME rule is a column). Decide: one supplier at a time
  (today's search) vs top-N suppliers as bands with a yard-share ratio bar.
- **Age lens:** needs a per-block age in SQL — reuse `view_analytics_aging_watchlist.age_days`
  (kg-weighted mean delivery date; there is no FIFO), bands e.g. ≤60 / 60–120 / 120–365 / >365 d,
  configurable the same way. No ₱, so safe for Production — the Highlight button then renders
  for them with Price absent (`canShow` is already built that way).
- Carried over, unchanged: the 09-17 wrap §4–5 (AUGUST 12,314 kg drop, EOQ bases, group PC-cost
  rule), and the 09-18 Checks-tab `SUM`-of-nothing reading.

## 7. Git state
`main` @ `3778e19` (+ this docs commit) = `origin/main`. Branch kept: `feat/blocking-price-lens`.
Worktrees under `.claude/worktrees/` from this and the previous session hold merged branches
and can be removed. Fly worker unchanged (**v31**).
