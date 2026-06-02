---
name: cenapro-production-ledger
description: Perf profile of the Cenapro Production ledger grid (/cenapro/production) — why it's slow and the diagnosed fix options
metadata:
  type: project
---

# Cenapro Production Ledger — Performance Profile (diagnosed 2026-06-02, DIAGNOSE mode)

`app/(app)/cenapro/production/production-ledger-grid.tsx` (~1457 lines) renders the full
`public.cenapro_production_events` VIEW (~752 rows, Dec 2025 → May 2026) in ONE component with:
- **No virtualization** — `rows.map` at ~:1184 renders all 753 rows × 14 cells = ~10,500 interactive cells. 8/row are `SelectCell` (Radix DropdownMenu), 2 are `DatePickerCell` (native `<input type=date>`), 3 `GridCell`. ~45k–60k DOM nodes.
- **No memoized Row/cell** — `activeCell`/`isEditing`/`cellSelection.range` threaded into every cell via inline `selProps()` (:931), `commonCellProps` (:940, new object every render), `interactiveCellClass()` (:954). One keystroke (`updateRow`→`setRows` :591) or one drag-hover (`handleCellMouseEnter`→`setFocus`) re-renders ALL 753 rows.
- `cellSelection` (from `useCellSelection`) is a fresh object each render → handler `useCallback`s (:554,:569,:579) re-create every render.
- `production-view.tsx` keys the grid by an all-ids fingerprint (:28) → **full unmount/remount** of the 10,500-cell tree on every save.

**Why** the ICTC `daily-ledger-grid.tsx` it was modeled on is fine: SAME architecture (no virt, no memoized row) but implicitly **period-scoped** (one month of shifts = tens of rows). Cenapro copied the rendering but fed it 6 months un-scoped. Root cause = row count, amplified by missing memoization.

**How to apply** (fix ranking, if asked to implement later):
1. **Period/batch-month picker FIRST** — cheapest, matches existing ICTC/RC-OUT/Blocking period-scoping pattern; ~752→~30-120 rows makes existing rendering fast. Scope `initialRows`→`rows` by `batch_year`/month before `buildGridRows` (:466); fold period into the `production-view` key.
2. **Memoized `<Row>` + `useMemo` on `commonCellProps`** alongside — kills per-keystroke/per-drag re-render storm. Pass primitive selection booleans, not the whole `cellSelection`.
3. **Virtualization** as an "All periods" escape hatch only. Reference impl: RC IN `delivery-master-table.tsx:1077-1082` + padding-row `<tr>` technique :1597-1677. Gotchas: selection across unmounted rows (copy reads `rows[]` so OK, but highlight/mouseenter only fire for mounted rows — rely on RAF auto-scroll), must `scrollToIndex` on keyboard `moveActive`, Radix dropdown portals close if trigger row unmounts mid-open, keep `table-fixed`+`colgroup` via padding rows.

Note: header filters use `hidden`+`display:none` (:1196) — rows stay mounted, so **filtering does NOT reduce DOM weight or re-render cost**. Only virtualization/period-scoping do.
