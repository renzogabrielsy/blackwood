# Schema Additions — 2026-02-17

## batches table: `notes` column

Migration: `add_batch_notes_column`
SQL: `ALTER TABLE batches ADD COLUMN IF NOT EXISTS notes text;`
Used by: `blocking/actions.ts` — `fetchBlockingDetail()` reads it, `updateBlockNotes()` writes it.

## view_blocking_grid: `total_in` column added

Migration: `add_total_in_to_blocking_view` (DROP + CREATE OR REPLACE — column addition required drop)
New column: `COALESCE(SUM(d.weight_kg), 0) AS total_in`
Position: After `avg_php_kg`, before `avg_bd_astm`
All existing column names unchanged: `batch_id`, `batch_code`, `block_loc`, `status`, `balance`, `avg_php_kg`, `total_in`, `avg_bd_astm`, `avg_bd_jis`, `avg_ash`, `avg_mc`, `avg_grit`, `avg_vm`, `avg_fc`

## blocking/types.ts changes

- `BlockData`: added `total_in: number`
- `DeliveryHistoryRecord`: `truck_plate: string` → `supplier: string`
- `UsageHistoryRecord`: added `production_batch: string | null` and `avg_price: number | null`
- `BlockingDetailData`: added `notes: string | null` and `avg_cost: number | null`

## blocking/actions.ts changes

- `fetchBlockingGridData()`: maps `total_in` from view row
- `fetchBlockingDetail()`: 3-way parallel query (deliveries + rc_out + batches); deliveries uses `supplier` not `truck_plate`; rc_out uses `production_batch`; batch query gets `notes, avg_cost`; `avg_price` on usage rows = batch's `avg_cost` (role-gated)
- NEW: `updateBlockNotes(batchId, notes)` — updates `batches.notes`, calls `revalidatePath('/inventory')`

## rc-in/actions.ts validation fixes

- `normalizeBlockLoc()` imported from `lib/validation.ts` and applied in `toDeliveryPayload()` (block_loc field) and `upsertBatchesFromRows()` (location_ref field)
- `bulkUpdateDeliveries()`: added full block_loc format + duplicate location validation before the try block (same logic as `submitBulkDeliveries`)
- `updateDelivery()`: validates `data.block_loc` with `validateBlockLoc()` and normalizes before persisting
- `translateDbError()` helper: maps `chk_block_loc_format`, `chk_location_ref_format`, `idx_unique_active_batch_per_location` constraint names to user-friendly strings; applied in all three mutation catch blocks

## lib/validation.ts additions

New export: `normalizeBlockLoc(loc: string): string` — trims and uppercases.
