# Supabase Backend Engineer Memory

## Database Schema Insights

### Batch Status Management (Updated 2026-02-15)

**Critical Discovery:** The `batch_status` enum drives the STATE column in RC IN. Status is now **fully derived from RC OUT data** via the `fn_process_blackwood_usage` trigger.

**Status Values:**
- `STORED` — default for new batches, no rc_out entries
- `IN-USE` — batch has rc_out entry with `destination='MAIN'`, no CLOSED remarks
- `CLOSED` — batch has rc_out with `destination='MAIN'` AND `remarks ILIKE '%CLOSED%'`
- `SUNDRYING` — batch has rc_out with `destination='SUNDRY'`
- `FEED` — preserved for batches with `batch_code ILIKE '%FEED%'` (takes priority)

**Priority Order:** FEED > CLOSED > SUNDRYING > IN-USE > STORED

### Trigger: fn_process_blackwood_usage

**File:** Located in `supabase/migrations/` — full rewrite completed 2026-02-15

**Operations Supported:**
1. **INSERT** — Optimized, checks only new row, depletes weight, sets status
2. **DELETE** — Adds weight back, **recalculates** status from remaining rc_out records
3. **UPDATE** — Adjusts weight delta, **recalculates** status; handles batch_id changes

**Key Behavior:**
- Block location (`block_loc`) auto-copied from `batches.location_ref` if not provided
- Status recalculation uses `EXISTS` queries with priority cascade
- UPDATE/DELETE operations query ALL rc_out records to determine correct state
- If batch_id changes during UPDATE, BOTH old and new batches are recalculated

**Common Pitfall:** Previously, the RC IN batch upsert **overrode** trigger-managed status back to 'STORED'. This was fixed by removing the `status` field from `upsertBatchesFromRows()` in `app/(app)/inventory/rc-in/actions.ts` (line 17).

### View: view_rc_in_master

**Columns Include:** `state` (aliased from `batches.status`)

**Query Pattern:**
```sql
SELECT *, batches(location_ref, status) FROM deliveries
```

Always fetch BOTH `location_ref` and `status` when querying deliveries for the RC IN module.

### Enum Addition Best Practice

PostgreSQL requires enum values to be committed before use in function definitions. Always split enum additions into separate migrations:
1. Migration 1: `ALTER TYPE batch_status ADD VALUE 'NEW_VALUE';`
2. Migration 2: Function/trigger updates that reference the new value

**Error if violated:** `unsafe use of new value "X" of enum type`

## RC IN Module Architecture

### Batch Upsert Strategy

**Location:** `app/(app)/inventory/rc-in/actions.ts`, function `upsertBatchesFromRows()`

**Pattern:**
1. Map delivery rows to batch upsert payload (`batch_code`, `location_ref`)
2. Deduplicate via JS Map keyed by `batch_code`
3. Upsert with `onConflict: 'batch_code'`
4. **DO NOT include `status`** — DB default ('STORED') + trigger handle state

**Critical Rule:** Never send `status` in batch upserts. The trigger owns state management.

### Data Flow for STATE Column

1. User submits deliveries → `submitBulkDeliveries()` action
2. Batches upserted → default status = 'STORED'
3. User creates RC OUT entry → `fn_process_blackwood_usage` trigger fires
4. Trigger updates batch status based on RC OUT data
5. RC IN page queries `deliveries` with `batches(status)` join
6. Frontend displays color-coded STATE badges

### Type Definitions

**File:** `types/rc-in.ts`

**Key Types:**
- `DeliveryRow` — includes optional `state?: string`
- `DeliveryHistoryRow` — extends DeliveryRow, includes `batches?: { location_ref: string; status: string }`
- Always map `(d as any).batches?.status || 'STORED'` to `state` in page.tsx

## Common Debugging Patterns

### Verify Trigger Behavior

```sql
-- Check trigger is active
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'tr_blackwood_usage';

-- View function source
SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'fn_process_blackwood_usage';
```

### Verify Status Distribution

```sql
SELECT status, COUNT(*) FROM batches GROUP BY status ORDER BY count DESC;
```

Expected distribution post-migration (2026-02-15):
- CLOSED: 258
- STORED: 154
- FEED: 73
- IN-USE: 5
- SUNDRYING: 3

### Test Trigger Operations

```sql
-- Test INSERT (should set SUNDRYING)
INSERT INTO rc_out (batch_id, destination, weight_kg, transaction_date)
SELECT id, 'SUNDRY', 100, '2026-01-01' FROM batches WHERE batch_code = 'TEST-BATCH';

-- Test DELETE (should recalculate to STORED if no other rc_out records)
DELETE FROM rc_out WHERE id = '<rc_out_id>';

-- Verify batch status changed
SELECT batch_code, status FROM batches WHERE batch_code = 'TEST-BATCH';
```

## Migration History

### 2026-02-15: STATE Column Rewrite

**Migrations:**
1. `20260214173510_rewrite_state_column_derive_from_rc_out.sql` — Add SUNDRYING enum
2. `20260214173709_rewrite_trigger_view_and_data_fix.sql` — Rewrite trigger, update view, fix data

**Changes:**
- Added SUNDRYING to batch_status enum
- Rewrote fn_process_blackwood_usage to handle INSERT/UPDATE/DELETE
- Updated view_rc_in_master to include `state` column
- One-time data fix recalculated all batch statuses from rc_out data
- Removed status from batch upsert in RC IN actions
- Updated RC IN page to fetch and map batch status
- Updated DeliveryHistoryRow type to include status

**Files Modified:**
- `supabase/migrations/` (2 new migrations)
- `app/(app)/inventory/rc-in/actions.ts` (line 17 — removed status)
- `app/(app)/inventory/rc-in/page.tsx` (line 30, 79 — added status)
- `types/rc-in.ts` (line 27 — added status to batches type)
- `types/supabase.ts` (regenerated)

## Supabase CLI Patterns

### Type Regeneration

Always run after schema changes:
```bash
supabase gen types typescript --linked > types/supabase.ts
```

### Migration Workflow

1. Create migration: `supabase migration new <descriptive_name>`
2. Write idempotent SQL (use `IF NOT EXISTS`, `CREATE OR REPLACE`)
3. Apply via MCP: `mcp__supabase__apply_migration`
4. Verify with diagnostic queries
5. Regenerate types

### Verification After Deployment

1. Check enum values: `SELECT unnest(enum_range(NULL::batch_status))::text;`
2. Check data distribution: `SELECT status, COUNT(*) FROM batches GROUP BY status;`
3. Test CRUD operations on rc_out and verify batch status updates
4. Run `npm run build` to catch type errors

## Performance Notes

### Trigger Efficiency

The rewritten trigger uses `EXISTS` subqueries for status recalculation. For large datasets:
- INSERT is optimized (no subqueries, direct CASE evaluation)
- DELETE/UPDATE are slower (must scan rc_out table for each batch)

**Monitoring:** If rc_out grows large (>10k records per batch), consider:
- Indexing `rc_out(batch_id, destination, remarks)` for EXISTS queries
- Debouncing bulk deletes/updates to reduce trigger invocations

### View Performance

`view_rc_in_master` uses LEFT JOIN on batches. No indexing needed (batch_code is unique key).

## Related Modules

- **RC OUT:** Creates rc_out records that trigger batch status updates
- **RC IN:** Displays batch status in STATE column (read-only, no manual override)
- See `app/(app)/inventory/rc-in/CONTEXT.md` and `rc-out/CONTEXT.md` for module details
