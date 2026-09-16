# 2026-09-16 — `/operations` fourth round: viewport modals, PRODUCTION family, RC FED → RC Movement matrix

> Continues `2026-09-15-ops-ledger-refinements-round-3.md`. Branch `feat/ops-ledger-refine-4` → `main`. No data-layer change.

## 1. TL;DR
Three UI asks shipped: modals size to content + viewport (12-column blocks table fits at 1920 wide, no clipping); Produced/Yield/Loss/Waste Loss hover-highlight as a family and open one PRODUCTION modal; RC FED opens the real RC Movement matrix for that campaign in a modal, lazy-loaded and fed by the RC Movement page's own server action.

## 2. Shipped
- NEW `app/(app)/operations/ops-modal-size.ts` (one definition of modal geometry), `ops-production-table.tsx`, `ops-rc-movement-modal.tsx` (second host of `RcMovementMatrix`; `next/dynamic` ssr:false; `fetchRcMovementMatrix` on open, cached per campaign; group row → campaign tabs).
- `ops-kpi-modal.tsx` (viewport sizing, pinned chrome, scrolling table), `ops-blocks-table.tsx` (re-measured widths), `ops-kpi-strip.tsx` (family hover, click builds details lazily).
- Docs: operations `CONTEXT.md`, rc-movement `CONTEXT.md` ("Consumers outside this route"), plan §3.9, TIMELINE.

## 3. Learnings
- **`backdrop-filter` makes a dialog the containing block for `position: fixed` descendants.** The matrix's non-portalled `BlockingDetailPanel` rendered inside the dialog box until the RC Fed dialog dropped the glass and every transform/filter/animation. KPI modals keep the glass (no fixed descendants).
- **`DialogContent`'s `duration-200` + default `transition-property: all` animates width** once widths vary per modal — `transition-none` on the content; entrance animation unaffected.
- The v2 RC Movement grid cannot be embedded (it writes `?campaign=` via `router.replace`); the Classic matrix can, because it owns no route state.
- Bundle: `/operations` first-load 972.2 → 980.1 kB; matrix chunks (~125 kB) load on first RC Fed click only.

## 4. Not verified
Live figures with a session (fixture-verified only). Escape with the block drawer open inside the RC Fed modal closes both (Radix dismiss + panel handler) — known, unfixed, needs a change to the shared panel.

## 5. Next
Renzo reviews on production (RC Fed modal on JULY 2026 especially). Open items unchanged: drop unused `view_ops_ledger_day_blocks_used`; static column-count/spine-width assertion; delete `/dev/ops-ledger` drafts; the Escape double-close.
