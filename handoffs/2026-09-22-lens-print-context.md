# 2026-09-22 — Lens print context: market page, supplier price-vs-volume, per-warehouse price pages

> Continues `2026-09-22-supplier-lens-and-print-fixes.md` (+ its addenda §7 yard map, §8 ₱/KG column + palette).

## 1. TL;DR
- Renzo: price print — a page break per warehouse, weighted lab stats in the subtotals, a supplier
  column; page 1 of price and supplier prints were "barren" — add the year's delivery prices (the
  market), default the lens to the current quarter, and a per-supplier price-direction / volume
  table with the price-to-volume graph.
- All three shipped on `feat/lens-print-context` → `main`. Migrations `20260922093000` +
  `20260922094500` APPLIED via MCP (no stored credential).
- **Next concrete action:** Renzo prints the Price and Supplier lenses live and reads page 1.

## 2. What shipped
**Data:** additive keys on `fn_blocking_price_lens` (per-block warehouse/dominance;
`warehouse_subtotals[]`; weighted lab stats + coverage on bands/total) · `this_quarter` basis ·
`fn_blocking_market_context` · `fn_blocking_supplier_market` · two split probes ·
`fetchBlockingMarketContext`, `fetchBlockingSupplierMarket` (both `canViewPrices()`-first refusals).
**UI/print:** `lens/{lens-market-model,lens-market-print,lens-print-chart,lens-supplier-market-print}`,
`lens-summary-{model,print}` (per-warehouse pages for price only, subtotal + supplier column),
`price-lens-settings.ts` (default `this_quarter`, "This quarter's deliveries"), fixtures +
`lens-fixture-lab.ts`; lens-ui 228.

## 3. Live numbers (2026-09-22)
this_quarter ₱39.1816 (== last_3_months until 1 Oct). Market 12m: ₱44.92 (Oct-25) → ₱39.88 (Sep-26);
Q4-25 45.34 · Q1-26 47.79 · Q2-26 43.30 · Q3-26 39.18; YTD 44.58; trailing 12m 44.80.
Ornales 5.62M kg ₱44.92 ↓11.7% corr 0.26 prem +0.50 · Paquibot 4.03M ₱45.54 ↓10.1% corr 0.60 prem +0.83 ·
Tag-at 1.51M ₱44.40 ↓12.4% corr 0.74 prem −0.38.

## 4. Critical learnings
1. **A combined verify probe can time out on view CONCURRENCY, not on any one query** — 14
   interleaved `security_invoker` view executions in one `jsonb_build_object` hit 20 s; one statement
   per probe call runs in ~3 s.
2. **Each lab stat needs its own coverage weight** — MC and the other six differ by 770 t of blocks
   that read 0. A shared "lab kg" would be wrong in every group.
3. **A fixture must carry every basis the select offers** — flipping the default to a basis no rig
   mocked made all three rigs silently blank (live was fine).
4. **Print charts are hand-drawn SVG**: `ResponsiveContainer` sizes a frame late under `printCard`
   and prints an empty box; theme tokens go dark on paper; recharts would enter the Blocking bundle.
5. **A raw control byte in source reads as nothing in a diff** — escape it and assert none exist.
6. An area chart's padded domain can go negative — floor it, don't zero-base it.
7. A stopped agent's worktree is resumable by a finishing agent reading the diff — but the finishing
   brief must list the original scope, or "complete" cannot be judged.

## 5. Open / unverified
- Nothing on the real signed-in page; three rigs with adapter ports only. Live SQL covered by the
  95 + 90 data assertions.
- Open decision from §8 of the previous handoff: spread supplier-map luminance for mono printers?
- Carried over: 09-17 wrap §4–5, 09-18 Checks reading; migration name/version skew on two files.

## 6. Git state
`main` = `origin/main` after the merge. Branch kept. Merged worktrees under `.claude/worktrees/`
can be removed. Fly worker unchanged (**v31**).
