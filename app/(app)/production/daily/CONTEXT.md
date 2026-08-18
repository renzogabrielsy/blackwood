# Production — Daily Tab

## Purpose
Excel-parity view for daily production output, downtime, and waste. ONE unified inline-editable ledger grid replacing the former 3-grid horizontal layout. Each visual row represents a `production_runs` entry; downtime and waste columns span the same row (shown only on the "primary" grade row per shift).

## Files
| File | Role |
|------|------|
| `actions.ts` | Server actions: `fetchAvailablePeriods`, `fetchDailyTabData`, `saveBulkDailyLedger`. Exports row types and `LedgerRowPayload`. `fetchAvailablePeriods` is consumed by the **module-level** `ProductionPeriodProvider`, not just this tab. **Human-edit latch (2026-08-03):** every shift upsert, run insert/update, downtime upsert and waste upsert also passes `human_edited_at` via the local `claim()` helper, so the row is marked as yours and the sync will not overwrite it. The DB trigger `fn_stamp_human_edit` is the actual guarantee (it also fills `human_edited_by` from `auth.uid()`); hand a row back with `releaseProductionRows` in `app/(app)/production/actions.ts`. See the module CONTEXT → "Human-edit latch". |
| `daily-grid-v2.tsx` | **READ-ONLY Blackwood Table rendering of the same ledger** (`?grid=v2`, 2026-08-18). Built beside `daily-ledger-grid.tsx`, which is unchanged. It IMPORTS `buildGridRows` and `deriveDailyMetrics` rather than restating them, so the two sides cannot disagree about which run is PRIMARY or what DT TTL / PROD HRS / PROD LOSS / TTL WASTE are. Same 23 columns, same widths (Σ 1604px), same 8-column pinned block. **Two row families** — `run-primary` occupies all 23 columns; `run-secondary` returns `null` from `occupies()` for every downtime/waste column (the secondary row HAS NO CELL there, which is what the live grid's muted block means) and renders the `↑` carry mark on DATE/BATCH/SHIFT as `addressable: false`. The four computed lanes are `addressable: false` + `selectable: true` — they render, they sweep into a rectangle, the caret steps over them. Read-only STRUCTURALLY: no spec declares `parse` or `editable`, so `columnAcceptsEdit` is false everywhere. Keeps the DATE sort toggle and the SHIFT/CUSTOMER/GRADE filters (pure view state) through `renderHeaderSlot`. See the module CONTEXT → "The `?grid=v2` side-by-side". |
| `daily-view.tsx` | Thin wrapper — passes `{shifts, runs, downtime, waste}` + `dataYear`/`dataBatch` (grid remount key) to `<DailyLedgerGrid>`. **No longer passes period-picker props** (the picker lives in the production layout now). No DeliverySheetFooter. |
| `daily-ledger-grid.tsx` | The single unified inline-editable ledger (~2200 lines). All production/downtime/waste columns in one wide table. Toolbar keeps only the shift/run count + Save/Discard — the Year+Batch picker was moved to the module-level layout. SHIFT/CUSTOMER/GRADE headers carry single-select filter menus (`ColumnFilterMenu`). **Now exports `buildGridRows()` + the `GridRow` type** for the mobile card view (desktop render unchanged). |
| `ledger-derive.ts` | Pure `deriveDailyMetrics(row: GridRow)` — now shared by THREE surfaces (the live grid's inline compute, the mobile card, and `daily-grid-v2.tsx`) — the DT TTL / PROD HRS / PROD LOSS / TTL WASTE formula (shift default 8h) in ONE place, mirroring the grid's inline compute. Consumed by the mobile card so both surfaces show identical derived values. |
| `daily-cards-mobile.tsx` | **Phone read layer** (`sm:hidden`; the grid is `hidden sm:block`). Archetype C `MobileCardList` — one card per run row from `buildGridRows()`. Headline: `shift-badge · grade · TTL KG · date · batch · customer · [DT/Waste badge]`. Tap → detail sheet SECTION-grouped into Identity / Production / Downtime / Waste (downtime/waste shown only on the shift's primary run; secondary rows show a note). Read-only — no editing/keyboard/paste. |

**Deleted (2026-05-28 rebuild):** `production-runs-grid.tsx`, `downtime-grid.tsx`, `waste-grid.tsx` — replaced by `daily-ledger-grid.tsx`.

## Schema (post 2026-05-28 parent-child restructure)

**Parent table:** `production_shifts` — `id`, `transaction_date`, `production_batch`, `shift`. Natural key: `(transaction_date, production_batch, shift)`.

**Child tables (all joined via `shift_id` FK):**
- `production_runs` — `shift_id`, `customer`, `grade`, `ttl_kg`, `sacks_bags`, `remarks`. Natural key: `(shift_id, customer, grade)`. N:1 with shifts.
- `production_downtime` — `shift_id`, `shift_hrs`, `dt_hrs`, `dt_mins`, `dt_reason`. Exactly 1 per shift (UNIQUE shift_id).
- `production_waste` — `shift_id`, 8 waste stream kg columns (rs1a/rs1b/bf/rs23/rs5/trml1/trml2/grit), `remarks`. Exactly 1 per shift.

`dt_ttl_hrs`, `productive_hrs`, `total_waste_kg`, `prod_loss_pct` are all computed client-side in the grid (not stored). The `view_production_daily` view also computes them server-side for reference.

## Column Order (unified ledger)

| Section | Columns |
|---|---|
| Identity (from shift) | `#` / DATE / BATCH / SHIFT |
| Production | CUSTOMER / GRADE / TTL KG / REM (200px, message-icon → Popover textarea) |
| Downtime | DT HRS / DT MIN / DT TTL (computed) / PROD HRS (computed) / DT REASON (120px, message-icon → Popover textarea) |
| Waste | PROD LOSS (computed) / TTL WASTE (computed) / RS1A / RS1B / BF / RS2/3 / RS5 / TRML1 / TRML2 / GRIT |

Total visible columns: 23. Table `minWidth: 1604px` — horizontal scroll on `overflow-x-auto` container.

**Removed columns (still in DB schema, always set to null on save):**
- `sacks_bags` (production.BAGS) — UI removed 2026-05-28
- `production_waste.remarks` (waste.REM) — UI removed 2026-05-28

**Row actions:** Right-click any row for the context menu — Insert Above/Below, Duplicate Row, Add Grade Row (primary only), Delete/Restore Row. The previous inline + / × icon column was removed. **(Phase 4 consolidation)** The menu now runs on the shared `useGridContextMenu` hook + declarative `GridContextMenu` component (`GridMenuItem<number>[]` keyed on `rowIdx`; see `components/shared/grid/CONTEXT.md`): Insert Above/Below use `disabled` on non-primary (secondary) rows; Add Grade Row uses `hidden` unless the row is primary AND not new; Delete (destructive) / Restore (muted) are two items gated by `hidden` on the row's deleted state. The hook is configured with a fixed menu height (164, the primary-row height); secondary-row menus are shorter (120) but the difference only nudges the bottom-edge flip threshold.

## Multi-grade-per-shift rendering

A shift can have multiple `production_runs` (different grades). Downtime + Waste are 1:1 with shift:

- One ledger row per `production_runs` entry (grade)
- The **primary row** (first by customer+grade sort) carries the downtime and waste columns — they're live/editable
- **Secondary rows** for the same shift show downtime/waste cells as muted gray (`bg-muted/30`) with no content
- Editing any downtime/waste field routes to `updateShiftData()` which always writes to the primary row of the shift group
- Identity cells (DATE/BATCH/SHIFT) on secondary rows show `↑` arrow instead of the value — visually grouped

The `+` button in the delete column of a primary row inserts a new secondary grade row for the same shift.

## Save semantics (`saveBulkDailyLedger`)

1. Groups rows by `(date, batch, shift)` key
2. Upserts each `production_shifts` by natural key to get/create `shift_id` (ON CONFLICT DO UPDATE)
3. Per run: UPDATE existing (by run_id) OR UPSERT by `(shift_id, customer, grade)` for new rows
4. Per shift (from primary row): UPSERT `production_downtime` by `shift_id` if shift_hrs is set
5. Per shift (from primary row): UPSERT `production_waste` by `shift_id` if any waste column is non-null
6. Handles run deletes by run_id
7. Returns `{ ok, insertedShifts, upsertedRuns, upsertedDowntime, upsertedWaste, deletedRuns }`

## Data Fetch (`fetchDailyTabData`)

Queries `production_shifts` for the target month → IN batch-fetches `production_runs`, `production_downtime`, `production_waste` by shift_ids. Returns `{ shifts, runs, downtime, waste, year, month }`. Client-side join in `buildGridRows()` inside `daily-ledger-grid.tsx`.

## Totals Footer

A sticky `<TableFooter>` row is pinned at the bottom of the scroll container (inside `max-h-[70vh]`). Four columns display live aggregates with a SUM/AVG toggle pill (Σ / x̄):

| Column | Index | Eligible rows |
|--------|-------|---------------|
| TTL KG | 6 | All non-deleted, non-new rows with a ttl_kg value that pass the active SHIFT/CUSTOMER/GRADE filters |
| DT TTL | 10 | Primary rows only (within the active-filter visible set) |
| PROD HRS | 11 | Primary rows only (within the active-filter visible set) |
| TTL WASTE | 14 | Primary rows only (within the active-filter visible set) |

All four aggregates respect the active column-header filters (see "Column header filters" under Key Behaviors). The GRADE column header is the single filter control — there is no longer a `<Select>` pill in the footer GRADE cell (it is now a plain sticky spacer).

- Pill click cycles SUM ↔ AVG per-column; state is local to `DailyLedgerGrid`.
- AVG = sum / count of non-null values (not total row count).
- Empty placeholder (`—`) when count = 0.
- **Compact display + full-value tooltip:** Values render condensed via `formatCompact()` (defined near `formatKg`) so they fit the cell — `≥1e6` → `M` (e.g. `1.2M`, `2M`), `≥1e3` → k-notation (1 decimal under 10k like `1.5k`, whole above like `13k`/`600k`), else `Math.round` (no decimals); handles negatives/0. On hover, a `<Tooltip>` (wrapping the value span inside `FooterAggCell`) shows the FULL value via `formatKg(value, decimals)` prefixed with the mode (e.g. `Sum: 600,000`, `Avg: 8.83`). Footer already sits inside `<TooltipProvider>`.
- Frozen-pane cells in the footer carry both `sticky bottom-0` + `left-Xpx` at `z-50` (corner intersection). Non-frozen footer cells carry `sticky bottom-0 z-40`. Matches the header's z-index stacking.
- Helper component: `FooterAggCell` (defined inline, before `DailyLedgerGrid`).
- Aggregate memo: `footerAgg` (React.useMemo, deps `[rows, shiftFilter, customerFilter, gradeFilter]`).

## Key Behaviors
- **Sort order:** DATE is the ONLY sortable column. Default ASC (oldest at top); the DATE header is clickable to toggle ASC ↔ DESC (ChevronUp = ASC muted / ChevronDown = DESC primary color). Sort applies in-memory to the loaded rows — no re-fetch. Shift grouping is preserved (primary row always first within a shift group). **SHIFT sub-order is a permanent secondary sort: within any given date, shift rows always render M → E → N regardless of the DATE asc/desc toggle.** Implemented via module-level `SHIFT_RANK` (`{M:0,E:1,N:2}`) + `shiftRank()` (unknown shifts → 99, sort last). Applied in BOTH ordering sites: `buildGridRows` (comparator: date per `sortDir`, then `shiftRank` asc) and the `dateSortDir` effect (sorts `groupOrder` by date portion per direction, then `shiftRank` of the key's shift segment). SHIFT/CUSTOMER/GRADE headers are **NOT** sortable — they carry filter controls instead (see below).
- **Period filter (MODULE-LEVEL as of 2026-05-29):** The Year + Batch picker is NO LONGER in this grid's toolbar — it was promoted to a universal, shared control in the production layout (`components/period-picker.tsx` + `production-period-context.tsx`). All 3 tabs read the same period. The Daily tab consumes `{ year, batch }` from `useProductionPeriod()`, refetches when active+stale, and filters `production_shifts` by `production_batch` (year derived from `transaction_date`). See `production/CONTEXT.md` → "Universal Period Control". The grid receives only its already-filtered data; `daily-view` passes `dataYear`/`dataBatch` solely as the grid remount `key`.
- **Column header filters (SHIFT / CUSTOMER / GRADE):** Each of these three headers carries a compact, single-select filter — a `ListFilter` (lucide) icon-button (`ColumnFilterMenu`, defined inline before `DailyLedgerGrid`) that opens a `DropdownMenu` listing "All" + each distinct value as `DropdownMenuRadioItem`s (glass: `bg-popover/95 backdrop-blur-lg`). The icon tints `text-primary` when that column's filter is active (≠ 'ALL'), muted otherwise; the header label stays visible beside it and the header remains compact (`h-7`). The trigger stops propagation on mousedown/pointerdown so it never starts a cell drag. State: `shiftFilter` / `customerFilter` / `gradeFilter` (each `useState('ALL')`). Distinct-value memos over current rows (excluding deleted + trailing new): `distinctShifts` (sorted by `shiftRank` → M,E,N), `distinctCustomers` (alpha), `distinctGrades` (alpha).
  - **Row hiding is index-preserving:** a data row is hidden (via the `hidden` attribute + `hidden` Tailwind class → `display:none`) when it fails any active filter (`isRowHidden`). The `rows` array and all indices are untouched, so cell selection / paste / context-menu keying stays aligned. The trailing `_state==='new'` row is ALWAYS visible.
  - **Footer scoping:** `footerAgg` now computes ALL four aggregates (TTL KG, DT TTL, PROD HRS, TTL WASTE) over the rows currently visible under the active filters (still excluding deleted/new; DT TTL / PROD HRS / TTL WASTE remain primary-row metrics). Memo deps: `[rows, shiftFilter, customerFilter, gradeFilter]`.
  - **Grade control moved to header:** the former `<Select>` pill in the GRADE footer cell was removed — the GRADE **header** filter is now the single control for `gradeFilter`; the footer GRADE cell is a plain sticky spacer.
  - **Known limitation (downtime/waste on hidden primary):** SHIFT filtering hides whole shift groups cleanly (downtime/waste ride along on the primary row). But CUSTOMER/GRADE are per-run: if a filter hides a shift's PRIMARY row (the one that owns the downtime/waste cells) while leaving a secondary run row visible, that shift's downtime/waste is not shown (secondary rows never render those cells). This is acceptable for a focus filter — downtime is NOT re-homed onto a surviving secondary row.
  - Filters are not auto-reset when their matching rows all disappear after edits — the grid simply shows only the trailing new row.
- **Footer decimal precision:** DT TTL and PROD HRS show 2 decimal places (e.g., `8.83`). TTL KG shows 0 decimals. TTL WASTE shows 2 decimals.
- **Date cell UX:** Each primary row's DATE cell is the shared `DatePickerCell` (imported from `@/components/shared/grid`) — always-visible calendar icon + formatted date (`MMM d`, e.g. "May 23"). Clicking anywhere in the cell opens the native browser date picker via `input.showPicker()`. Hover shows a blue border + tinted background to signal interactivity. Secondary rows show `↑` arrow (date inherited from the shift, not editable). (The former local copy of `DatePickerCell` was deleted in the Phase 2 Blackwood Table migration.)
- **Inline editing (shared Blackwood Table primitives):** Click to select, double-click or type-over to edit. F2 enters edit mode. Escape reverts. Enter/Tab commits and moves. Keyboard nav + the edit session are now driven by `useGridKeyboardNav` (coordinate resolver via `createCoordinateNavResolver({ rowCount, columnMap: COL_MAP })`) + `useGridEditSession` — see `components/shared/grid/CONTEXT.md`. **Row-dependent editability is preserved at the `startEditing` guard** (secondary rows reject downtime/waste cols 8-22): the coordinate resolver gates editability by column only, so the grid's own `startEditing` remains the authoritative per-cell check. `revertChanges` is kept custom (NOT the session's) to preserve the `_state: 'modified' → 'existing'` rollback. `Home`/`End` are intercepted before the shared handler (Home → col 1, End → last col), and `handleSmartPaste` stays local because it must run `recomputeShiftPrimary` + maintain the trailing empty row (the generic `useGridPaste` cannot express that).
- **Focus never scrolls (2026-08-04):** `HTMLElement.focus()` scrolls its target into view with block AND inline `"center"` through every scrolling ancestor, and `"center"` always computes a target — so it fires even when nothing moved, re-centring the row and dragging the page. All three `gridRef.current?.focus()` sites (single-cell click, the custom `revertChanges`, the Tab/Enter commit) now pass **`{ preventScroll: true }`**. Focus still moves; only the scroll is refused. **CLOSED 2026-08-05:** the 18 remaining sites (17 shadcn `<Input autoFocus>` cell editors + the `NoteCell` popover `<Textarea autoFocus>`) now pass **`ref={focusNoScroll}`** (`lib/utils.ts`) instead of `autoFocus`. React's `autoFocus` prop is unfixable from the outside — react-dom's `commitMount` is a bare `domElement.focus()` with no options — so the prop must simply not be used on a cell editor. The ref callback lands in the same commit/layout phase and, like react-dom, calls no `select()`/`setSelectionRange()`, so caret behaviour is byte-identical. Same idiom as `components/shared/grid/EditInput.tsx`. See "Focus must never scroll" in `components/shared/grid/CONTEXT.md`.
- **Row rules were INVISIBLE until 2026-08-05 — `border-collapse: separate` paints CELL borders only.** This table is `borderCollapse: 'separate'` (load-bearing: under `collapse` a border belongs to the TABLE rather than the cell, so the 8 sticky frozen columns lose their edges), and in the separated-borders model the CSS spec ignores a border declared on `<tr>`/`<tbody>`/`<col>` outright. So the body row's `border-b border-border/30`, the two header rows' `border-b border-foreground/10` and `/20`, and the footer's `border-t-2 border-foreground/20` were **all inert** — the ledger drew vertical column lines and no horizontal ones. Each is now applied to the row's CELLS via a child variant (`[&>*]:border-b [&>*]:border-b-border/30`, etc.), preserving every original weight. **Never re-add a `<tr>`-level border, and never flip to `collapse`.** The colour is side-specific so tailwind-merge cannot restyle the cells' own `border-r`; row heights are unchanged (preflight makes cells `border-box`, so the 1px rule draws inside the explicit 28px/32px height). The `border-l-2` dirty/new marker on the `<tr>` is inert for the same reason and is **deliberately still open** — it needs to move onto the FIRST cell only, since a `[&>*]:` variant would draw it on every cell.
- **Escape-after-Delete audit (2026-08-04) — no gap, nothing changed:** a **single-cell** Delete/Backspace goes through `useGridKeyboardNav`'s `edit.start(active, '')`, which snapshots the pre-edit value before blanking, so Escape reverts it (through this grid's custom `revertChanges`, which also rolls `_state` back to `'existing'`). A **range** Delete runs `useCellDelete` (writes `''` per cell, no snapshot) and the shared hook then drops the selection — not undoable, and deliberately left that way: this grid has **no per-cell stored value** to revert to. Rows are mutated in place with a `_state` flag, are re-ordered by `recomputeShiftPrimary`, and can be inserted/duplicated/deleted, so mapping a live row index back to its `initialShifts`/`initialRuns`/`initialDowntime`/`initialWaste` baseline is not expressible without a new row-identity index. **Discard** (which rebuilds every row from that baseline) is this grid's undo, at the granularity it actually has.
- **Dirty tracking:** `_state: 'existing' | 'new' | 'modified' | 'deleted'`. Modified primary rows show amber left border. New rows show blue left border. Deleted rows have strikethrough.
- **Save/Discard:** Single Save button for the whole grid. Calls `saveBulkDailyLedger` with all dirty rows grouped by shift.
- **Paste:** Ctrl+V at active cell expands grid and fills from TSV clipboard.
- **Computed columns:** DT TTL, PROD HRS, TTL WASTE, PROD LOSS are computed client-side — displayed as read-only muted cells.
- **Section color coding:** Blue = Identity, Green = Production, Amber = Downtime, Red = Waste — subtle background tints on header cells.
- **Grade typeahead:** 3X50, 6X50, 8X50, 2X6 (free-form `<Input list="grade-suggestions">`)
- **Shift typeahead:** M, E, N (free-form `<Input list="shift-suggestions">`)
- **Customer typeahead:** CEBU, KURARAY (free-form `<Input list="customer-suggestions">`)
- **Run remarks (col 7) & DT REASON (col 12) — message-icon pattern:** Both free-text cells display ONLY a centered, clickable `MessageSquare` icon (`NoteCell`, defined inline before `DailyLedgerGrid`). The icon is tinted (`text-primary`) when the field has content and faint (`text-muted-foreground/30`) when empty. Clicking the icon opens a Radix `<Popover>` (`bg-popover/95 backdrop-blur-lg`, `w-72`) with an editable `<Textarea>` (autoFocus, 4 rows, font-mono). This replaced the old `truncate` + `Tooltip` span and fixes the DT REASON overflow (display mode no longer renders raw text). Edits route through `updateRow('run_remarks')` / `updateShiftData('dt_reason')` — backend field names unchanged. The inline `<Input>` (GridCell `children`) is retained as the F2 / double-click / type-over / paste-in-edit path. **Why the icon button stops propagation (onMouseDown + onPointerDown):** the parent GridCell display `<div>` calls `preventDefault()` + starts drag-selection on mousedown, which previously swallowed the click and blocked editing — stopping propagation on the button lets the click reach the Popover trigger cleanly. PopoverContent only mounts when open (no per-row portal cost, no animation on cells).
- **Right-click row menu:** ContextMenu pattern — Insert Above/Below, Duplicate, Add Grade Row (primary-only), Delete/Restore.
- **All headers:** center-aligned (`text-center`). Body numeric cells remain right-aligned.
- **Empty state:** `animate-fade-up` message "Awaiting Production Manager sync..."
- **Error toasts:** `errorToast()` from `lib/toast.ts` — HARD RULE

## Hooks Used
- `useGridKeyboardNav` + `createCoordinateNavResolver` — shared Blackwood Table keyboard state machine (Esc/Enter/Tab/F2/Delete/printable + nav). `enableEnterAnchor: false` (plain Enter drops straight down). Range wired via the `range` slot.
- `useGridEditSession` — shared `isEditing` flag + pre-edit snapshot (revert kept custom for `_state` rollback)
- `useCellSelection` — range selection with drag, Shift+Arrow, Ctrl+A
- `useClipboardCopy` — Ctrl+C copies selected range as TSV
- `useCellDelete` — Delete/Backspace clears selected cells
- `useCellAggregation` — SUM of selected numeric cells
- `useStatusBar` — pushes selection stats to FloatingStatusBar

## Server Action Contract

```ts
// Fetch available periods (called once on mount to populate pickers)
fetchAvailablePeriods()
  => Promise<{ data?: { years: number[]; batchesByYear: Record<number, string[]> }; error?: string }>

// Fetch: returns 4 arrays for client-side join, filtered by year + batch
// year=null → all years; batch=null → all batches
fetchDailyTabData(year?: number | null, batch?: string | null)
  => Promise<{ data?: { shifts, runs, downtime, waste, year, batch }; error?: string }>

// Save: atomic upsert of shifts → runs → downtime → waste
saveBulkDailyLedger(rows: LedgerRowPayload[])
  => Promise<{ ok: true, insertedShifts, upsertedRuns, upsertedDowntime, upsertedWaste, deletedRuns }
            | { ok: false, error: string }>
```

## Dependencies
- `@/components/providers/status-bar-context` — `useStatusBar()` for selection aggregates
- `@/lib/hooks/use-cell-selection` — range selection
- `@/lib/hooks/use-clipboard-copy` — Ctrl+C
- `@/lib/hooks/use-cell-delete` — Delete/Backspace on selection
- `@/lib/hooks/use-cell-aggregation` — SUM in status bar
- `@/lib/paste-utils` — `parseExcelDate`, `trimCellValue`
- `@/components/shared/grid/GridCell` — unified cell display/edit component
- `@/components/shared/grid` — shared `DatePickerCell` (replaced the former local copy)
- `@/lib/hooks/use-grid-keyboard-nav` — shared keyboard state machine + `createCoordinateNavResolver` (see `components/shared/grid/CONTEXT.md`)
- `@/lib/hooks/use-grid-edit-session` — shared inline-edit session (isEditing + pre-edit snapshot)
- `@/components/ui/tooltip` — Tooltip on footer compact-value cells (full value on hover)
- `@/components/ui/popover` — `NoteCell` Popover for REM / DT REASON editing
- `@/components/ui/dropdown-menu` — `ColumnFilterMenu` single-select filter on SHIFT / CUSTOMER / GRADE headers
- `@/components/ui/textarea` — `NoteCell` editable text field
- `@/lib/toast` — `errorToast()` for all error toasts (HARD RULE)
- `@/types/supabase` — `Tables<>`, `TablesInsert<>`, `TablesUpdate<>` for all type inference

## See Also
- `components/shared/grid/CONTEXT.md` — the shared "Blackwood Table" primitives (`GridCell`, `DatePickerCell`, `SelectCell`, `useGridKeyboardNav`, `useGridEditSession`, `useGridPaste`) this grid now consumes. The canonical reference wiring is `app/(app)/inventory/rc-in/bulk-delivery-input.tsx`.
