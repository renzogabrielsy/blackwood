# Production — Daily Tab

## Purpose
Excel-parity view for daily production output, downtime, and waste. Three **side-by-side inline-editable grids** arranged horizontally with `overflow-x-auto` to match the MASTER PROD sheet layout.

## Files
| File | Role |
|------|------|
| `actions.ts` | Server actions: `fetchDailyTabData`, `saveBulkProductionRuns`, `saveBulkDowntime`, `saveBulkWaste`. Exports `BulkSavePayload<TInsert, TUpdate>` generic used by all 3 tab action files. |
| `daily-view.tsx` | Parent layout — period indicator + 3 grids side-by-side in a horizontal flex container with `overflow-x-auto` |
| `production-runs-grid.tsx` | Inline-editable grid for `production_runs` (~620px wide) |
| `downtime-grid.tsx` | Inline-editable grid for `production_downtime` (~700px wide, includes computed DT TTL and PROD HRS columns) |
| `waste-grid.tsx` | Inline-editable grid for `production_waste` (~1200px wide, 8 waste stream pairs) |

## Column Order (Production Runs)
`#` / DATE / BATCH / GRADE (Select) / SHIFT (Select) / TTL KG / BAGS / REM / [delete]

**Schema note (2026-05-27):** `production_runs.customer` column added during MASTER backfill (default `'CEBU'`). The grid does NOT yet expose this column — new rows save with `customer='CEBU'` via DB default. Follow-up: add customer Select dropdown (CEBU/KURARAY/...) to the grid when non-CEBU production resumes. Natural key is `(date, production_batch, customer, grade, shift)`.

## Column Order (Downtime)
`#` / DATE / BATCH / SHIFT (Select) / SH HRS / DT HRS / DT MIN / DT TTL (computed) / PROD HRS (computed) / DT REASON / [delete]

## Column Order (Waste)
`#` / DATE / BATCH / SHIFT (Select) / RS1A / SKS / RS1B / SKS / BF / SKS / RS2/3 / SKS / RS5 / SKS / TML1 / SKS / TML2 / SKS / GRIT / TTL WASTE (computed) / REMARKS / [delete]

## Horizontal Layout
```
[ PRODUCTION OUTPUT (~620px) ] | [ DOWNTIME (~700px) ] | [ WASTE SUMMARY (~1200px) ]
```
- `overflow-x-auto` on outer wrapper — scrolls all 3 grids as one horizontal band
- Each grid has an independent vertical scroll (`max-h-[50vh]`) and its own Save/Discard buttons
- No shared state between grids (each manages its own dirty/save cycle)

## Key Behaviors
- **Inline editing:** Click to select, double-click or type-over to edit. F2 enters edit mode. Escape reverts. Enter/Tab commits and moves.
- **Dirty tracking:** `_state: 'existing' | 'new' | 'modified' | 'deleted'`. Modified rows show amber left border. Deleted rows shown strikethrough, restorable via RotateCcw button.
- **Save/Discard:** Each grid has its own Save and Discard buttons. Save calls `saveBulkProductionRuns/Downtime/Waste` with `{ inserts, updates, deletes }`.
- **Paste:** Ctrl+V at active cell expands grid and fills from TSV clipboard.
- **Computed columns:** DT TTL, PROD HRS (Downtime) and TTL WASTE (Waste) are computed client-side — displayed as read-only muted cells.
- **Grade enum:** 3X50, 6X50, 8X50, 2X6 (Select dropdown)
- **Shift enum:** M, E, N (Select dropdown in all 3 grids)
- **Validation:** Server-side via `saveBulk*` — grade/shift checks, ttl_kg > 0, dt_mins < 60, dt_ttl ≤ shift_hrs
- **Empty state:** `animate-fade-up` message "Awaiting Production Manager sync..."
- **Error toasts:** `errorToast()` from `lib/toast.ts` — HARD RULE

## Hooks Used
- `useCellSelection` — range selection with drag, Shift+Arrow, Ctrl+A
- `useClipboardCopy` — Ctrl+C copies selected range as TSV
- `useCellDelete` — Delete/Backspace clears selected cells
- `useCellAggregation` — SUM/AVG of selected numeric cells
- `useStatusBar` — pushes selection stats to FloatingStatusBar

## Server Action Contract
```ts
saveBulkProductionRuns(payload: BulkSavePayload<TablesInsert<'production_runs'>, TablesUpdate<'production_runs'>>)
  => Promise<{ ok: true, insertedCount, updatedCount, deletedCount } | { ok: false, error: string }>

saveBulkDowntime(payload: BulkSavePayload<TablesInsert<'production_downtime'>, TablesUpdate<'production_downtime'>>)
  => Promise<{ ok: true, insertedCount, updatedCount, deletedCount } | { ok: false, error: string }>

saveBulkWaste(payload: BulkSavePayload<TablesInsert<'production_waste'>, TablesUpdate<'production_waste'>>)
  => Promise<{ ok: true, insertedCount, updatedCount, deletedCount } | { ok: false, error: string }>
```

## Data Fetch
`fetchDailyTabData(year?, month?)` — defaults to current year/month. Queries 3 tables in parallel. Return shape unchanged.
