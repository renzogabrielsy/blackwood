# Production — Daily Tab

## Purpose
Excel-parity view for daily production output, downtime, and waste. ONE unified inline-editable ledger grid replacing the former 3-grid horizontal layout. Each visual row represents a `production_runs` entry; downtime and waste columns span the same row (shown only on the "primary" grade row per shift).

## Files
| File | Role |
|------|------|
| `actions.ts` | Server actions: `fetchAvailablePeriods`, `fetchDailyTabData`, `saveBulkDailyLedger`. Exports row types and `LedgerRowPayload`. `fetchAvailablePeriods` is consumed by the **module-level** `ProductionPeriodProvider`, not just this tab. |
| `daily-view.tsx` | Thin wrapper — passes `{shifts, runs, downtime, waste}` + `dataYear`/`dataBatch` (grid remount key) to `<DailyLedgerGrid>`. **No longer passes period-picker props** (the picker lives in the production layout now). No DeliverySheetFooter. |
| `daily-ledger-grid.tsx` | The single unified inline-editable ledger (~2100 lines). All production/downtime/waste columns in one wide table. Toolbar keeps only the shift/run count + Save/Discard — the Year+Batch picker was moved to the module-level layout. |

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
| Production | CUSTOMER / GRADE / TTL KG / REM (inline 200px) |
| Downtime | DT HRS / DT MIN / DT TTL (computed) / PROD HRS (computed) / DT REASON |
| Waste | PROD LOSS (computed) / TTL WASTE (computed) / RS1A / RS1B / BF / RS2/3 / RS5 / TRML1 / TRML2 / GRIT |

Total visible columns: 23. Table `minWidth: 1604px` — horizontal scroll on `overflow-x-auto` container.

**Removed columns (still in DB schema, always set to null on save):**
- `sacks_bags` (production.BAGS) — UI removed 2026-05-28
- `production_waste.remarks` (waste.REM) — UI removed 2026-05-28

**Row actions:** Right-click any row for the context menu — Insert Above/Below, Duplicate Row, Add Grade Row (primary only), Delete/Restore Row. The previous inline + / × icon column was removed.

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
| TTL KG | 6 | All non-deleted, non-new rows with a ttl_kg value |
| DT TTL | 10 | Primary rows only |
| PROD HRS | 11 | Primary rows only |
| TTL WASTE | 14 | Primary rows only |

- Pill click cycles SUM ↔ AVG per-column; state is local to `DailyLedgerGrid`.
- AVG = sum / count of non-null values (not total row count).
- Empty placeholder (`—`) when count = 0.
- Frozen-pane cells in the footer carry both `sticky bottom-0` + `left-Xpx` at `z-50` (corner intersection). Non-frozen footer cells carry `sticky bottom-0 z-40`. Matches the header's z-index stacking.
- Helper component: `FooterAggCell` (defined inline, before `DailyLedgerGrid`).
- Aggregate memo: `footerAgg` (React.useMemo, depends on `rows`).

## Key Behaviors
- **Sort order:** Default ASC (oldest at top). DATE header is clickable to toggle ASC ↔ DESC. Sort applies in-memory to the loaded rows — no re-fetch. Shift grouping is preserved (primary row always first within a shift group). ChevronUp (ASC, muted) / ChevronDown (DESC, primary color) icon indicates direction.
- **Period filter (MODULE-LEVEL as of 2026-05-29):** The Year + Batch picker is NO LONGER in this grid's toolbar — it was promoted to a universal, shared control in the production layout (`components/period-picker.tsx` + `production-period-context.tsx`). All 3 tabs read the same period. The Daily tab consumes `{ year, batch }` from `useProductionPeriod()`, refetches when active+stale, and filters `production_shifts` by `production_batch` (year derived from `transaction_date`). See `production/CONTEXT.md` → "Universal Period Control". The grid receives only its already-filtered data; `daily-view` passes `dataYear`/`dataBatch` solely as the grid remount `key`.
- **Grade filter (footer):** A `<Select>` pill in the GRADE footer cell (col 5) filters the TTL KG aggregate in the footer. Default "ALL". Shows only grades present in the current loaded rows. DT TTL / PROD HRS / TTL WASTE aggregates are NOT affected by the grade filter (they are per-shift / per-primary-row metrics).
- **Footer decimal precision:** DT TTL and PROD HRS show 2 decimal places (e.g., `8.83`). TTL KG shows 0 decimals. TTL WASTE shows 2 decimals.
- **Date cell UX:** Each primary row's DATE cell is a `DatePickerCell` (defined inside `daily-ledger-grid.tsx`) — always-visible calendar icon + formatted date (`MMM d`, e.g. "May 23"). Clicking anywhere in the cell opens the native browser date picker via `input.showPicker()`. Hover shows a blue border + tinted background to signal interactivity. Secondary rows show `↑` arrow (date inherited from the shift, not editable).
- **Inline editing:** Click to select, double-click or type-over to edit. F2 enters edit mode. Escape reverts. Enter/Tab commits and moves.
- **Dirty tracking:** `_state: 'existing' | 'new' | 'modified' | 'deleted'`. Modified primary rows show amber left border. New rows show blue left border. Deleted rows have strikethrough.
- **Save/Discard:** Single Save button for the whole grid. Calls `saveBulkDailyLedger` with all dirty rows grouped by shift.
- **Paste:** Ctrl+V at active cell expands grid and fills from TSV clipboard.
- **Computed columns:** DT TTL, PROD HRS, TTL WASTE, PROD LOSS are computed client-side — displayed as read-only muted cells.
- **Section color coding:** Blue = Identity, Green = Production, Amber = Downtime, Red = Waste — subtle background tints on header cells.
- **Grade typeahead:** 3X50, 6X50, 8X50, 2X6 (free-form `<Input list="grade-suggestions">`)
- **Shift typeahead:** M, E, N (free-form `<Input list="shift-suggestions">`)
- **Customer typeahead:** CEBU, KURARAY (free-form `<Input list="customer-suggestions">`)
- **Run remarks:** Inline 200px text cell with `truncate` + `Tooltip` for full text on hover. Click to enter edit mode (plain `<Input>`).
- **Right-click row menu:** ContextMenu pattern — Insert Above/Below, Duplicate, Add Grade Row (primary-only), Delete/Restore.
- **All headers:** center-aligned (`text-center`). Body numeric cells remain right-aligned.
- **Empty state:** `animate-fade-up` message "Awaiting Production Manager sync..."
- **Error toasts:** `errorToast()` from `lib/toast.ts` — HARD RULE

## Hooks Used
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
- `@/components/ui/tooltip` — Tooltip on truncated inline remarks
- `@/lib/toast` — `errorToast()` for all error toasts (HARD RULE)
- `@/types/supabase` — `Tables<>`, `TablesInsert<>`, `TablesUpdate<>` for all type inference
