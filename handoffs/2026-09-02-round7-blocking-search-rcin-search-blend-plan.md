# 2026-09-02 (session 2) — Round 7 shipped, Blocking supplier search, RC IN v2 search bar, and the BLEND PROPOSAL HISTORY plan (not built)

> Continues `2026-09-02-analytics-rounds-6-and-7-spec.md`. Four items this session, three shipped
> to `main` (Vercel live), one planned. No `workers/sync/**` changes — no Fly deploy needed.

## TL;DR for the next session
1. Renzo has a plan to approve: **`.agents/plans/blend-proposal-history-plan.md`** — saved,
   versioned blend proposals inside the Blocking page. §5 lists the four decisions he should
   confirm (`fed` status, the ×1.30 constant, no hard delete, audience). Build order in §6:
   backend → history UI → modify/compare UI. Nothing in the DB has changed for it.
2. Everything else is live. `main` @ `ebe0083`.

## Shipped (in order)
- **Analytics ROUND 7** (`c5a1074`, merge `f6e9049`): RC IN/OUT total rows removed; **Purchase
  volume then Usage** (calendar-month MAIN-only fed, `view_analytics_cost_monthly.fed_kg`)
  adjacent; Net flow expand shows the two all-destination in/out lines; the two aging rows
  dropped; the campaign panel + production table **merged into one 16-row campaign table**
  (`lib/analytics/campaign-matrix.ts` + `app/(app)/analytics/campaign-room.tsx`; `batch-cost-panel.tsx`,
  `production-room.tsx`, `lib/analytics/production-batch.ts` deleted); nav = RC Inventory ·
  Campaigns · Suppliers. Plan doc §13. Decisions: `fed_kg` read from the cost view (the ₱ rows
  are ratios over those kilos), `producedKg`/`yieldPct` from the production view (NULL not 0);
  retired deep links `?metric=rc_in_total|rc_out` alias to `net_flow`; reorder key changed to
  `metrics:campaigns`.
- **Blocking supplier search** (`2ebf67f` + `e28cb50`, merge `10a2125`): new view
  **`view_blocking_block_suppliers`** (migration `20260902145145`, APPLIED; 202 rows / 170 blocks
  / 17 suppliers; Σkg = `total_in` on 170/170; identity = `canonical_supplier(split_part(supplier,' - ',1))`;
  `supplier_count_in_block = 1` is THE all-vs-some rule; no ₱), `fetchBlockingSupplierMap()`,
  cmdk combobox in the sticky header (own row on phones — the header strip is `overflow-x:auto`,
  which clips dropdowns), `?supplier=` URL state, `.spotlight-supplier-all` (emerald) /
  `.spotlight-supplier-some` (orange), everything else `spotlight-dimmed`; supplier and status
  spotlights are mutually exclusive. **Found in passing, NOT fixed:** the pre-existing
  `.spotlight-stored/-in-use/-sundrying/-sundried` glow rings never render on occupied cells
  (declared before `.blocking-cell-occupied` at equal specificity) — only the dimming shows.
  Recorded in blocking CONTEXT.md.
- **RC IN v2 search bar** (`f3a719e`, merge `ebe0083`): `rc-in/components/delivery-search.tsx`,
  same placeholder / 300 ms debounce / `?search=` server contract as the live table; status line
  "Found N results for X in All Years"; × and Esc clear (Esc on the input only, so the sheet's
  Esc = revert cell still works); drafts stay off under a search. Live table byte-identical.

## Answered for Renzo (August "missing" cells on the campaign table)
Both `₱ per produced kg` cells for AUGUST 2026 are NULL by the coverage rule, not a bug:
20 blocks fed, **3 still open** (SEPT-25-BLK4, JULY-26-BLK5, JULY-26-BLK13) and **1 closed with
zero delivery rows — `AUG-26-FEED2`, fed 18,650 kg** whose delivery sits under the raw label
batch `FEEDING # 2` (the L-042 known-not-fixed cleanup). 107,842 of 697,313 fed kg have no
traceable price. Re-pointing that one delivery lights the block-price cell; the TRUE cell waits
for the three piles to close. FEBRUARY's TRUE dash = 1 pile open (24/25).

## Verification caveat that applied to every UI item
The app redirects to `/login` (Google OAuth) so no agent drove the live pages with real data.
Each control was verified in Chromium against a throwaway fixture under `app/dev/table-playground/`
(deleted before commit; only `page.tsx` + `playground-grid.tsx` remain there). **Renzo should
click through all three on the live site**: `/analytics` (Purchase→Usage, Net flow expand, merged
table), `/inventory/blocking` (type ORNALES — expect ~76 blocks lit), `/inventory?grid=v2`
(search box in the strip).

## Standing items (unchanged, Renzo to rule)
L-042 `FEEDING # 2` → `AUG-26-FEED2` re-point (now also blocks an August ₱ cell) · March 2026
mis-keyed meter reading · MC's August reason-only zero-hour downtime · `open_value_php` · Aug-12
"FEED" remark panel click · graveyard deletion · the status-spotlight ring CSS order bug above.

## Gates (all green on every merge)
tsc · lint 146/16 baseline · build · verify-table-core 84 · verify-rc-in-grid 33 · e2e 57 ·
verify-worker-view-grants 4 views / 0 · verify-trigger-grants 0.
