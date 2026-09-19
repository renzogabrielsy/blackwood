# 2026-09-19 — Blocking AGE LENS shipped (second lens on the Highlight frame)

> Continues `2026-09-19-blocking-price-lens.md` (same day).

## 1. TL;DR
- Renzo: "do age first." Built data layer → UI in one worktree, branch `feat/blocking-age-lens`,
  merged to `main`. Migration `20260919133042_blocking_age_lens` is APPLIED.
- Highlight now has **Price | Age** tabs. Age has no ₱, so **every role gets the Highlight
  button**; Production sees Age alone.
- **Next concrete action:** Renzo tries both lenses live; then the **Supplier lens** (§6).

## 2. What shipped
**Data** — `view_batch_age_days` · `fn_blocking_age_lens(p_edge_days)` · `fn_blocking_age_lens_probe`
(`service_role` bridge) · `fetchBlockingAgeLens` in `blocking/actions.ts` (auth check, NO price
gate) · types in `blocking/types.ts` · `scripts/verify-blocking-age-lens.ts` (49).
**UI** — `lens/age-lens-settings.ts`, `lens/age-lens-panel.tsx`; shared pieces extracted from the
Price panel: `lens/lens-ramp.ts`, `lens-shared.ts`, `lens-band-rows.tsx`, `lens-ratio-bar.tsx`,
`lens-customize.tsx`, `lens-refusal-banner.tsx`; `registry.ts` = `[PRICE_LENS, AGE_LENS]`;
`.lens-age-0…6` in `app/globals.css`; fixture `/dev/table-playground/agelens`;
`scripts/verify-blocking-lens-ui.ts` 68 → 114.

## 3. Critical learnings
1. **Coverage that holds today by luck is not a rule.** All 168 grid blocks are on the Analytics
   watchlist right now, but it floors at a tonne; reading age from it would have reported a
   fed-down block as "no deliveries". Extract the expression, prove equality every run.
2. **Don't re-point a live ₱-bearing view to share an expression** — `CREATE OR REPLACE VIEW`
   resets `reloptions` (third time this month). Prove drift impossible instead.
3. **Measure before repeating a sibling's claim:** `AS MATERIALIZED` was an 18× win on the price
   lens and a no-op here (PG 12+ materialises multiply-referenced CTEs anyway).
4. **The MCP type generator drops `graphql_public`**; use the CLI for `types/supabase.ts`.
5. **A second ramp is a semantic decision**, not decoration: on a page where emerald→rose means
   cheap→dear, an old block must not be red.
6. **Membership as "cut lines passed"** makes band assignment total — a negative age cannot fall
   out of every band.

## 4. Current state (live, as of 2026-09-19)
Yard 168 blocks / 10,469,899 kg, weighted age **396.7 d**, oldest **B-7B 1,176 d**, undated 0.
≤60 d: 22 blocks / 1,275,018 kg / 12.2% · 60–120: 15 / 984,057 / 9.4% · 120–365: 76 /
4,627,611 / 44.2% · >365: 55 / 3,583,213 / 34.2% (avg 837 d).
**Not verified:** the real page signed-in (fixture only); the undated and unpriced branches have
no live rows today.

## 5. Open decisions (Renzo)
Supplier lens shape: **top suppliers as bands with a yard-share ratio bar** (recommended, matches
Price/Age) vs one supplier at a time (today's search, which stays either way).

## 6. Next
Supplier lens on the same frame: data exists (`view_blocking_block_suppliers`; the ALL/SOME rule is
a column). A block can hold several suppliers, so decide the tint rule — dominant supplier by kg
share with a "mixed" marker, vs kg-apportioned shares in the ratio bar (the bar can apportion; a
cell can only show one colour). Needs a categorical ramp (`ramp: 'category'`), not a sequential one.
No ₱ → every role. Carried over unchanged: 09-17 wrap §4–5, 09-18 Checks-tab reading.

## 7. Git state
`main` = `origin/main` after the `feat/blocking-age-lens` merge. Branches kept. Several merged
worktrees under `.claude/worktrees/` can be removed. Fly worker unchanged (**v31**).
