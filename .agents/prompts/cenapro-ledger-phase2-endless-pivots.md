# PROMPT — Cenapro Ledger Phase 2: Endless W6/W7 Daily Pivots

## Before anything else
1. Read `TIMELINE.md`, `CLAUDE.md`, then
   `.agents/prompts/cenapro-ledger-endless-sheet-spec.md` (esp. the "W6/W7
   endless-pivot mechanics" section — locked).
2. Read `app/(app)/cenapro/CONTEXT.md` (Production section, esp. the Daily Block)
   and `components/shared/grid/CONTEXT.md`.
3. Read the Phase-1 deliverables (the axis framework, `page.tsx` view×scope
   branching, `production-endless-sheet.tsx`, `use-ledger-window.ts`,
   `fetchLedgerPage`) and `production-daily-block.tsx` (esp. `buildDateGroups`,
   `SOURCE_SETS`, the day-block/footer/frozen-identity rendering). Phase 1 MUST be
   merged and working — verify before planning.
4. **Enter plan mode, present the plan, get approval, then execute.** Delegate to
   senior-frontend-engineer (opus). Verify on disk after.

## Goal
Make the Daily W6 and Daily W7 views work in ENDLESS scope with the same
cursor-guided, infinite, dropdown-anchored paradigm as the ledger — but paginated
by whole prod-days (they are pivots, not flat rows). Focus-scope W6/W7 stays the
existing month-scoped daily block, unchanged.

## Build (per the spec's endless-pivot mechanics)
1. **Day-windowed keyset server action.** Add `fetchDailyPivotWindow` (or extend
   `fetchLedgerPage` with a `granularity:'day'` mode) that paginates by
   `prod_date`: given an anchor (period → the period's first prod_date, or
   "latest") or a `prod_date` cursor + direction, return ALL events whose
   `prod_date` falls in the next N COMPLETE days (never a partial day). Filter by
   `SOURCE_SETS[plantView]` server-side or return raw + filter client-side (state
   which; excluding FLEC/DVO per the existing rule). Order `prod_date ASC` then a
   deterministic tiebreak. Return the events + `hasOlder/hasNewer` at day
   granularity.
2. **Day-window pager hook.** A `useDailyPivotWindow` (or generalize
   `useLedgerWindow`) that accumulates loaded day-windows, exposes the flattened
   events, `fetchOlder/newer`, `hasOlder/newer`, `reset(anchor)`, AND owns the
   `firstItemIndex` prepend anchor — but the ANCHOR UNIT IS THE DAY-BLOCK, not the
   row. Decrement `firstItemIndex` by the number of prepended DAY-BLOCKS.
3. **Endless pivot renderer.** `production-endless-pivots.tsx`: pivot each loaded
   window with `buildDateGroups(events, plantView)` (reuse verbatim), producing
   day-block groups; render each day-block as ONE `TableVirtuoso` item (its
   internal rows/rowSpans render inside the item). Preserve the daily-block visual
   system (2-tier header, frozen 5-col identity, group dividers, box outline,
   per-day footer). NO cross-scroll grand total (per-day footers only). Scroll
   anchor via `firstItemIndex` over day-blocks; open at bottom for "latest",
   at the period's first day for a period anchor. Month separators between day-
   blocks where `prod_date` crosses a month.
   - Virtuoso caveat: a day-block is a variable-height item — rely on virtuoso's
     dynamic measurement; keep `firstItemIndex` accounting in DAY-BLOCK units.
4. **Wire into `page.tsx`.** `scope=endless` + `view=daily-w6|daily-w7` now
   server-prefetches the first day-window and renders the endless pivot (replacing
   the Phase-1 fallback). Focus + W6/W7 unchanged (existing daily block).
5. **Read-only this phase.** Editing of endless pivots is Phase 3 (the daily block
   is already editable in focus; do not wire endless editing yet — but leave clean
   seams, mirroring how the ledger endless renderer left seams for its editing).

## Verify yourself (real dev server, auth-gated — same guidance as Phase 1)
- `env -u ANTHROPIC_API_KEY npm run build` passes.
- endless + W6: opens at the newest prod-day; scroll up loads older COMPLETE days
  with no viewport jump; each day's totals/subtotals are correct (never computed
  from a half-loaded day — spot-check a boundary day against focus mode's number
  for the same day); dropdown jumps to the selected month's first day; scroll
  crosses month boundaries. Same for W7.
- Network: the first request after a jump is day-anchored (no earliest-history
  fetch). No request pulls a partial day.
- focus + W6/W7 unchanged; ledger (both scopes) unchanged.
- Screenshots: endless+W6 at newest, an anchored old month, a month boundary.

## Bookkeeping (same changeset)
Update `app/(app)/cenapro/CONTEXT.md` (endless pivots, the day-window action +
hook, per-day-only rollup) + `TIMELINE.md`. No commit/push.

## Report back
What was built; files changed; how day-windowing + the day-block firstItemIndex
anchor work; build result; verification (or pending + why); anything for Phase 3
(editing everywhere).
