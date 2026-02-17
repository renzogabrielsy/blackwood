# Supabase Backend Engineer Memory

## Database Schema Insights

### Batch Status Management (Updated 2026-02-17)

**Critical Discovery:** The `batch_status` enum drives the STATE column in RC IN. Status is now **fully derived from RC OUT data** via the `fn_process_blackwood_usage` trigger, with one exception: SUNDRIED is set by `fn_update_blackwood_state` on RC IN deliveries.

**Status Values:**
- `STORED` — default for new batches, no rc_out entries
- `IN-USE` — batch has rc_out entry with `destination='MAIN'`, no CLOSED remarks
- `CLOSED` — batch has ANY rc_out with `remarks ILIKE '%CLOSED%'` (regardless of destination)
- `SUNDRYING` — batch has rc_out with `destination='SUNDRY'`, no CLOSED remarks
- `SUNDRIED` — SUNDRY batch that has received deliveries but has no rc_out entries (sundrying complete, material stored)

**Priority Order:** CLOSED > SUNDRYING > IN-USE > SUNDRIED > STORED

**CLOSED takes absolute priority** — a batch with both SUNDRY destination AND CLOSED remark becomes CLOSED, not SUNDRYING.

**SUNDRIED Semantics:** SUNDRIED means "sundrying process complete, material received and stored." It is set by `fn_update_blackwood_state` when a delivery is added to a SUNDRY batch that is currently in STORED status. When RC OUT usage is recorded against a SUNDRIED batch, it moves to SUNDRYING (if destination='SUNDRY') or IN-USE (if destination='MAIN'). When all RC OUT records are deleted, it falls back to SUNDRIED (not STORED) because it's a SUNDRY batch.

**Note on FEED:** The `FEED` enum value still exists in `batch_status` but is no longer actively set by triggers (as of 2026-02-15). FEED location is indicated by the WHSE column in RC IN (derived from `block_loc` starting with 'F'), not by batch status. FEED batches follow the same status rules as other batches.

### Trigger: fn_process_blackwood_usage (2026-02-17 CLOSED Priority Fix)

**File:** Located in `supabase/migrations/` — full rewrite 2026-02-15, CLOSED priority fix 2026-02-17

**Operations Supported:**
1. **INSERT** — Optimized, checks only new row, depletes weight, sets status
2. **DELETE** — Adds weight back, **recalculates** status from remaining rc_out records
3. **UPDATE** — Adjusts weight delta, **recalculates** status; handles batch_id changes

**Key Behavior:**
- Block location (`block_loc`) auto-copied from `batches.location_ref` if not provided
- Status recalculation uses `EXISTS` queries with priority cascade
- UPDATE/DELETE operations query ALL rc_out records to determine correct state
- If batch_id changes during UPDATE, BOTH old and new batches are recalculated

**Status Priority (CRITICAL):** CLOSED > SUNDRYING > IN-USE > SUNDRIED > STORED
- **CLOSED remark ALWAYS takes highest priority** — regardless of destination
- INSERT CASE statement checks `NEW.remarks ILIKE '%CLOSED%'` FIRST, before destination checks
- This ensures SUNDRY + CLOSED → CLOSED (not SUNDRYING)
- DELETE/UPDATE fallback: checks if batch is SUNDRY (`batch_code ILIKE '%SUNDRY%'`) before defaulting to STORED
- Migration `fix_closed_remark_priority_in_rc_out_trigger.sql` (2026-02-17) fixed the INSERT logic

**Common Pitfall:** Previously, the RC IN batch upsert **overrode** trigger-managed status back to 'STORED'. This was fixed by removing the `status` field from `upsertBatchesFromRows()` in `app/(app)/inventory/rc-in/actions.ts` (line 17).

### Trigger: fn_update_blackwood_state (2026-02-17 current_weight Fix)

**File:** Located in `supabase/migrations/` — fixed to handle UPDATE operations on 2026-02-16, SUNDRIED status added 2026-02-17, current_weight recalculation added 2026-02-17

**Operations Supported:**
1. **INSERT** — Incremental weighted average for `avg_cost`, `quality_stats`, `current_weight`; sets SUNDRIED for SUNDRY batches
2. **UPDATE** — Recalculates `avg_cost` AND `current_weight` (delivery total − rc_out total) from scratch
3. **DELETE** — Recalculates `avg_cost` AND `current_weight` (delivery total − rc_out total) from scratch

**Critical INSERT Behavior (SUNDRIED Status):**
- After updating avg_cost/quality_stats, checks if `batch_code ILIKE '%SUNDRY%'` AND batch status is STORED
- If both conditions are true, upgrades status to SUNDRIED
- This only upgrades from STORED → SUNDRIED (won't override IN-USE or CLOSED)

**Critical UPDATE Behavior:**
- When `batch_code` changes: recalculates BOTH old and new batches from all their deliveries
- When `cost_basis` or `weight_kg` changes (same batch): recalculates that batch from all its deliveries
- Uses full aggregation query: `SUM(cost_basis * weight_kg) / NULLIF(SUM(weight_kg), 0)`

**current_weight Formula (DELETE/UPDATE):**
```sql
current_weight = SUM(deliveries.weight_kg WHERE batch_code = X)
               - SUM(rc_out.weight_kg JOIN batches WHERE batch_code = X)
```

**Why the Fix Was Needed:**
- DELETE/UPDATE handlers only recalculated `avg_cost` — `current_weight` was never updated on edits/deletes
- Migration `fix_delivery_trigger_current_weight` (2026-02-17) added current_weight to DELETE/UPDATE handlers
- Migration `recalculate_all_batch_weights` (2026-02-17) one-time fixed all stale current_weight values
- INSERT handler was left untouched (it correctly does incremental += already)
- The original fix history: trigger added UPDATE support in `fix_delivery_trigger_handle_updates.sql` (2026-02-16)

**Data Cleanup:** If batches have stale avg_cost, run:
```sql
UPDATE batches b
SET avg_cost = COALESCE(calc.avg, 0)
FROM (
  SELECT batch_code, SUM(cost_basis * weight_kg) / NULLIF(SUM(weight_kg), 0) as avg
  FROM deliveries
  GROUP BY batch_code
) calc
WHERE calc.batch_code = b.batch_code;
```

### Batches Table: Key Schema Facts

- `location_ref` is **NOT NULL** — empty string `''` is the sentinel for "no location" (cannot use NULL)
- When clearing location on CLOSED batches: `SET location_ref = ''` not `NULL`
- `status` is nullable with default `'STORED'::batch_status`
- No `updated_at` column exists in the current schema (trigger sets it — actually it does exist per trigger code; verify if issues arise)

### Blocking Integrity Constraints (Added 2026-02-17)

**Migration:** `add_blocking_integrity_constraints`

- `chk_block_loc_format` on `deliveries`: `block_loc IS NULL OR block_loc ~ '^[A-DF]-\d{1,2}[A-D]$'`
- `chk_location_ref_format` on `batches`: `location_ref = '' OR location_ref ~ '^[A-DF]-\d{1,2}[A-D]$'`
- `idx_unique_active_batch_per_location`: partial unique index on `batches(location_ref)` WHERE status IN ('STORED','IN-USE') AND location_ref != ''

**Format pattern:** `^[A-DF]-\d{1,2}[A-D]$` — WHSE A/B/C/D/F, hyphen, 1-2 digit column, letter row A-D

**Pre-constraint cleanup done:**
- Test/QA batches closed: `test`, `TEST_RT_BATCH`, `QA_NOTIF_TEST_001`, `QA_POLL_TEST_002`, `FEB-26-TEST1`, `JAN-25-BLK01`
- Empty string `block_loc` values → NULL (85 rows cleaned)
- Duplicate active locations resolved: keep highest `current_weight`, close others

### View: view_blocking_grid (Updated 2026-02-17)

**Migration:** `update_view_blocking_grid_dedup`

Uses `DISTINCT ON (b.location_ref)` ordered by `current_weight DESC` to guarantee one row per location.

**Columns:** `batch_id`, `batch_code`, `block_loc`, `status`, `balance`, `php_per_kg`, `bd`, `ash`, `mc`

**Note:** Previous view had different column aliases (`avg_php_kg`, `avg_mc`, etc.) and more columns. The blocking module expects the new aliases. Drop + recreate was required (not `CREATE OR REPLACE`) because columns were removed.

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

## RC OUT Module Architecture (2026-02-17 Refactor)

### fetchRcOutTabData() Server Action

**Location:** `app/(app)/inventory/rc-out/actions.ts`, line ~226

**Purpose:** Lazy-loads ALL rc_out records on first tab render (when user switches to Usage tab). No date scoping — loads entire dataset.

**Return Shape:**
```ts
{
  records: RcOutRow[];        // ALL rc_out records, desc by transaction_date
  batches: Batch[];           // for bulk input batch resolution
  destinations: string[];     // distinct rc_out.destination values
  batchOptions: string[];     // plain production_batch codes (no year annotations)
  yearOptions: number[];      // distinct years from transaction_date, descending
  blockLocs: string[];        // union of rc_out.block_loc + batches.location_ref, natural sorted
}
```

**Key Implementation Details:**
1. **Paginated fetch with `fetchAll()`** — bypasses PostgREST 1000-row `max_rows` cap
2. **Full join query:** Same select as `getRcOutRecords()` with batches join + generated columns
3. **Flattening logic:** Handles array vs single object for `batches` join (same pattern as `getRcOutRecords`)
4. **Natural sort for blockLocs:** `localeCompare(_, _, { numeric: true })` ensures "A1" < "A10"
5. **Derived filters:** `destinations`, `batchOptions`, `yearOptions` all computed from `records` — no separate queries
6. **blockLocs union:** Fetches BOTH `rc_out.block_loc` AND `batches.location_ref` (paginated), deduplicates, natural sorts

**Data Volume:** 1,414 rc_out records — same ballpark as RC IN, proven safe with fetchAll + TanStack Virtual.

**Previous Behavior (Removed 2026-02-17):**
- Month-based date scoping with `startDate`/`endDate` from `date-fns`
- Year annotations in `allBatchOptions` (e.g., "OCTOBER (2024, 2025)")
- Separate query for `productionBatchesRaw` with transaction_date join
- Returned `year`, `month` strings

**Why Removed:**
- RC OUT table already uses infinite scroll (not month-based pagination)
- Client-side filtering handles year/month selection via footer controls
- Loading ALL data upfront enables instant filter changes (no refetch needed)
- Year annotations were redundant — batch codes are unique enough without year labels

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
- Initial (after STATE rewrite): CLOSED: 258, STORED: 154, FEED: 73, IN-USE: 5, SUNDRYING: 3
- After FEED removal: CLOSED: 322, STORED: 159, IN-USE: 9, SUNDRYING: 3 (0 FEED)

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
3. `20260215XXXXXX_remove_feed_status_from_triggers.sql` — Remove FEED from trigger logic

**Changes:**
- Added SUNDRYING to batch_status enum
- Rewrote fn_process_blackwood_usage to handle INSERT/UPDATE/DELETE
- Updated view_rc_in_master to include `state` column
- One-time data fix recalculated all batch statuses from rc_out data
- Removed status from batch upsert in RC IN actions
- Updated RC IN page to fetch and map batch status
- Updated DeliveryHistoryRow type to include status
- Removed FEED priority checks from both fn_process_blackwood_usage and fn_update_blackwood_state
- Recalculated all FEED batches to proper status based on rc_out records

**Files Modified:**
- `supabase/migrations/` (3 migrations)
- `app/(app)/inventory/rc-in/actions.ts` (line 17 — removed status)
- `app/(app)/inventory/rc-in/page.tsx` (line 30, 79 — added status)
- `app/(app)/inventory/rc-in/CONTEXT.md` (removed FEED from status list)
- `app/(app)/inventory/rc-out/CONTEXT.md` (removed FEED from trigger priority)
- `types/rc-in.ts` (line 27 — added status to batches type)
- `types/supabase.ts` (regenerated)

## PostgREST Query Limits (2026-02-16 Discovery)

### max_rows Cap: 1000

PostgREST has a server-side `max_rows` setting (default 1000) that **silently truncates** result sets regardless of client-side `.limit()` values. This caused RC OUT filter queries with `.limit(5000)` to return only the first 1000 rows alphabetically.

**Impact:** With 1,414 RC OUT rows where 1,395 are "MAIN" destination, alphabetical ordering meant the first 1000 were ALL "MAIN" — so rare values like "MAN", "MIAN", and "SUNDRY" (17 rows) never appeared in filter dropdowns.

**Fix Pattern: Paginated `.range()` Loops**

```ts
const PAGE = 1000;
async function fetchAll<T>(buildQuery: () => any): Promise<T[]> {
    let all: T[] = [];
    let from = 0;
    let hasMore = true;
    while (hasMore) {
        const { data } = await buildQuery().range(from, from + PAGE - 1);
        all = all.concat(data || []);
        hasMore = (data?.length || 0) === PAGE;
        from += PAGE;
    }
    return all;
}

// Usage
const destinations = await fetchAll<{ destination: string }>(() =>
    supabase.from('rc_out').select('destination').not('destination', 'is', null).order('destination')
);
```

**Applied in:** `app/(app)/inventory/rc-out/actions.ts` `fetchRcOutTabData()` — all 3 filter queries (destinations, production_batch, block_loc) now use paginated fetch.

**When to Use:** Any filter/autocomplete query that needs to collect ALL unique values from a table with >1000 rows.

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
