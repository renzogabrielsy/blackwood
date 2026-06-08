# Production — Trucks Tab

## Purpose
Daily truck odometer and fuel readings for fleet tracking, displayed as a **pivoted grid**: one row per DATE, with each truck plate as its own column group.

## Files
| File | Role |
|------|------|
| `actions.ts` | `fetchTrucksTabData(year, month)`, `saveBulkTrucks`. Defines `BulkSavePayload` locally. |
| `trucks-view.tsx` | Scope-label wrapper (shows "Showing: {scope}") — passes `readings` to `TrucksGrid`. Accepts `year: number\|null`, `month: number\|null`. |
| `trucks-grid.tsx` | Pivoted, inline-editable grid for `truck_readings` (one row per date, plate column groups) |

## Pivoted Layout
One row per `reading_date`. Each truck plate is a 4-subcolumn group: **START KM / END KM / TTL KM / FUEL**.

Two-row header:
- **Row 1 (group labels):** `DATE` (rowspan 2, frozen) | `AAV 6111` (colspan 4) | `KCA 378` (colspan 4) | `FORKLIFT` (colspan 4) | …extras
- **Row 2 (subcolumn labels):** START / END / TTL / FUEL — repeated per plate group

Column index map (3 plates → 13 cols): `0=DATE`, then per plate `[startCol=start_km, +1=end_km, +2=ttl_km(computed/null), +3=fuel_liters]`. `colAddr(col)` resolves any column index to `{kind:'date'} | {kind:'ttl',plate} | {kind:'cell',addr:{plate,field}}`.

## Plate Column Set (dynamic but stable)
`derivePlates(data)` = canonical `['AAV 6111', 'KCA 378', 'FORKLIFT']` (fixed order, always shown) UNION any distinct `plate_no` present in the fetched rows (extras appended alphabetically). Keeps columns stable on sparse data; surfaces new trucks automatically.

## Key Behaviors
- **Inline editing (shared Blackwood Table primitives):** keyboard nav + the edit session are driven by `useGridKeyboardNav` + `useGridEditSession` — see `components/shared/grid/CONTEXT.md`. `enableEnterAnchor: false`. Because EVERY truck column is navigable (DATE, the editable metric cells, AND the read-only computed TTL cols), the coordinate `columnMap` passed to `createCoordinateNavResolver` has **no null entries** (a length-`colCount` array of non-null sentinels) so the resolver never skips a column — matching the old `moveActive` (plain `col±1`, no skip). Per-cell editability (DATE = select-only native picker, TTL = read-only) is enforced in the grid's own `startEditing` (the authoritative guard), not the resolver. `revertChanges` is kept custom (NOT the session's) so trucks' intentional behavior is preserved — only the field value rolls back, the row's `modified` state and the cell's `_dirty` flag are **kept**. `Home`/`End` are intercepted before the shared handler (Home → col 0 / DATE, End → last col). `handleSmartPaste` stays local (pivot-aware: maps flat col indices to `colAddr`, marks `_dirty`, maintains the trailing row). **Known minor divergence:** the shared coordinate resolver clamps Tab at the grid's first/last cell to `from.col`, whereas the old `moveActive` wrapped around within the clamped row (last-cell forward-Tab → col 0; first-cell Shift+Tab → last col). Interior Tab/arrow/Enter behavior is identical; only the two absolute corner cells differ. The reference wiring is `app/(app)/inventory/rc-in/bulk-delivery-input.tsx`.
- **Frozen DATE column:** `sticky left:0 z-30 bg-background`, right-edge separator shadow (`shadow-[2px_0_4px_rgba(0,0,0,0.12)]`), `group-hover:bg-muted/50` for uniform row hover. Header DATE cell is `sticky z-40` with `rowSpan={2}`. Uses the shared `DatePickerCell` (imported from `@/components/shared/grid`; always-on native picker, "MMM d" display). (The former local copy of `DatePickerCell` was deleted in the Phase 2 Blackwood Table migration.)
- **Computed TTL KM:** `end_km − start_km`, read-only tinted cell (`bg-muted/40`, `font-semibold`, `text-foreground/70`). Still drag-selectable for SUM/AVG aggregation, never written (GENERATED in DB).
- **Numeric formatting:** `formatNum()` — thousand separators, 0 decimals unless the value is fractional (then 2).
- **Editing model:** trailing empty DATE row at the bottom; typing/pasting into it materializes the row. Dirty-tracking is **per plate-cell** (`PlateCell._dirty`) plus per-row `_state`. Discard resets to `buildGridRows(initialData)`.
- **Cell selection + aggregation:** `useCellSelection` / `useCellAggregation` / `useStatusBar` — drag-select numeric cells (incl. computed TTL) → FloatingStatusBar shows SUM/AVG. DATE column (col 0) is non-selectable.
- **Smart paste:** Excel range paste maps left-to-right across the flat column indices (DATE + plate subcols); TTL columns are skipped.
- **Empty state:** `animate-fade-up` "Awaiting Production Manager sync..." message.
- **Error toasts:** `errorToast()` from `lib/toast.ts`.

## Save Logic (pivot → rows)
Walk every dirty/new grid row; for each `(reading_date, plate)` cell:
- **Existing** (`cell._id` present): push an **update** keyed by id — only if the cell was touched (`_dirty`).
- **New** (no id) **with any non-empty value**: push an **insert** for that `(reading_date, plate_no)`.
- `ttl_km` is never written (GENERATED). Empty new cells are skipped.

Calls `saveBulkTrucks({ inserts, updates, deletes: [] })` — the pivot never deletes whole readings (no per-cell delete column). Server validation (`end_km ≥ start_km`, `fuel ≥ 0`) and audit logging are unchanged from the original flat-grid action.

## Hooks Used
- `useGridKeyboardNav` + `createCoordinateNavResolver`, `useGridEditSession` — shared Blackwood Table keyboard/edit primitives (see `components/shared/grid/CONTEXT.md`)
- `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useStatusBar`

## Server Action Contract
```ts
saveBulkTrucks(payload: BulkSavePayload<TablesInsert<'truck_readings'>, TablesUpdate<'truck_readings'>>)
  => Promise<{ ok: true, insertedCount, updatedCount, deletedCount } | { ok: false, error: string }>
```

## Data Fetch
`fetchTrucksTabData(year?: number | null, month?: number | null)` — filters `truck_readings` (DESC by date, ASC by plate) by `reading_date`. Driven by the **module-level shared period** (see `production/CONTEXT.md` → "Universal Period Control"):
- `year=null` → all readings (no date filter)
- `year=<num>, month=null` → all readings in that calendar year
- `year=<num>, month=<n>` → that month of that year (`month` is 0-indexed)

The `trucks-lazy-tab` derives `month = batchToMonth(batch)` from the shared batch before calling (unrecognized/null batch → null month → whole year). `undefined` args fall back to the current month for backwards compatibility. Returns `{ readings, year, month }`. The grid pivots them client-side via `buildGridRows`.

## Removed
- **Monthly summary card** (`view_trucks_monthly`) — deleted from the grid/view and no longer fetched in `actions.ts`. The DB view still exists (harmless) but is unused by the UI.
