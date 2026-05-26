# RC Movement — Backend (SQL view, migration, server action, types)

## Read first

- `/Users/renzosy/blackwood/CLAUDE.md` — project conventions, Excel Standard, audit/comment patterns, role gating
- `/Users/renzosy/blackwood/TIMELINE.md` — current sprint, recent completions
- `/Users/renzosy/blackwood/FLASK_PORT_PLAN.md` — sections 3.4 (schema drift), 4 (server actions inventory), 5 (auth + permissions)
- `/Users/renzosy/blackwood/app/(app)/inventory/rc-out/actions.ts` — closest existing pattern (read patterns, role checks)
- `/Users/renzosy/blackwood/app/(app)/inventory/blocking/actions.ts` — view-driven module pattern + role-gated cost scrubbing
- `/Users/renzosy/blackwood/supabase/migrations/20260214173709_rewrite_trigger_view_and_data_fix.sql` — existing CREATE OR REPLACE VIEW example for `view_rc_in_master`
- `/Users/renzosy/blackwood/lib/auth.ts` — `getUserRole()` pattern with dev override cookie

## Context

ICTC (the first tenant) is a coconut shell charcoal grading plant. Blackwood already has RC IN (deliveries), RC OUT (usage), and Blocking (warehouse grid). The user wants a new feature called **RC Movement** — a context-rich, derived read over RC OUT that mirrors a pivot table they currently maintain in Excel. It answers the question: *for each day in a selected month, which batches were fed, what was the running balance per batch, and how close is each batch to closing?*

This is read-only. RC OUT remains the raw event log. RC Movement is a SIBLING tab — not a replacement.

## What you're building

1. **SQL view `view_rc_movement`** — Postgres view that aggregates RC OUT into per-`(batch, date)` rows with running balance via window functions
2. **Migration file** under `supabase/migrations/` (timestamped per existing convention, e.g. `26052500000_create_view_rc_movement.sql`)
3. **Regenerate** `types/supabase.ts` to pick up the new view
4. **Server action** at `app/(app)/inventory/rc-movement/actions.ts` exporting `fetchRcMovementData(year, month)`
5. **Role-gated cost columns** — scrub `php_per_kg`, `php_total`, and day-total `ttlPhp` for users whose role is `'Production'`

## SQL view spec — column-by-column

One row per `(batch_id, transaction_date)` pair. Source: rc_out joined to batches joined to deliveries (for batch totals). Collapse multiple rc_out entries on same (batch, date) into one row via SUM.

| Column | Type | Derivation |
|---|---|---|
| `date` | date | rc_out.transaction_date |
| `batch_id` | uuid | rc_out.batch_id |
| `batch_code` | text | batches.batch_code via join |
| `block_loc` | text | COALESCE(rc_out.block_loc, batches.location_ref) |
| `supplier` | text | most recent deliveries.supplier for this batch_code (correlated subquery, ORDER BY transaction_date DESC LIMIT 1) |
| `deliveries_total` | numeric | SUM(deliveries.weight_kg) for this batch_code (correlated subquery) |
| `fed_today` | numeric | SUM(rc_out.weight_kg) for this (batch_id, date) — the collapse |
| `cum_fed` | numeric | `SUM(fed_today) OVER (PARTITION BY batch_id ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` |
| `start_balance` | numeric | `deliveries_total - COALESCE(SUM(fed_today) OVER (PARTITION BY batch_id ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)` |
| `balance_after` | numeric | `deliveries_total - cum_fed` |
| `pct_loss` | numeric | `CASE WHEN deliveries_total > 0 THEN balance_after / deliveries_total ELSE NULL END` — semantically: residual fraction. Provisional until status='closed' at which point it freezes as the final shrinkage. |
| `feed_day_n` | int | `DENSE_RANK() OVER (PARTITION BY batch_id ORDER BY date)` |
| `php_per_kg` | numeric | batches.avg_cost |
| `php_total` | numeric | `fed_today * batches.avg_cost` |
| `closed_today` | boolean | BOOL_OR(rc_out.remarks ILIKE '%CLOSED%') across the day's entries for this batch |
| `status` | text | `'closed'` if `closed_today = true` OR `balance_after <= 0`, else `'active'` |

Order by `date DESC, batch_id`.

## Important SQL notes

- Use `CREATE OR REPLACE VIEW view_rc_movement AS ...` so the migration is idempotent
- The collapse step (SUM per `batch_id, date`) must happen in a CTE before the window functions — window functions need the day-level rows, not the raw rc_out rows
- The status logic: if a batch's `balance_after` is non-zero but `closed_today = true`, status is still `'closed'` (rare but possible if `CLOSED` is in remarks but DB balance doesn't quite zero out due to weighing variance — this is the % LOSS residual)
- Production-role scrubbing happens in the server action, NOT in the view. The view returns raw data; the action redacts.

## Server action spec

**File:** `app/(app)/inventory/rc-movement/actions.ts`

**Function:** `export async function fetchRcMovementData(year: number, month: number)`

**Behavior:**
1. Get current user from Supabase server client
2. Resolve role via `getUserRole(user.id)` (same pattern as blocking/actions.ts)
3. `canViewPrices = role !== 'Production'`
4. Query `view_rc_movement` filtered to dates between first-of-month and last-of-month (inclusive)
5. Group result by date in JavaScript (already sorted by date DESC from the view)
6. Compute daily totals: `ttlKg = sum(fed_today)`, `ttlPhp = sum(php_total)`, `laneCount = rows.length`
7. If `!canViewPrices`, set every `php_per_kg`, `php_total`, and `ttlPhp` to `null` before returning

**Return type:**
```typescript
export type RcMovementRow = {
  batchCode: string
  blockLoc: string | null
  supplier: string | null
  startBalance: number
  batchFed: number
  ttlFed: number
  pctLoss: number | null
  phpPerKg: number | null   // null if !canViewPrices
  phpTotal: number | null   // null if !canViewPrices
  status: 'active' | 'closed'
  feedDayN: number
}

export type RcMovementDay = {
  date: string             // YYYY-MM-DD
  day: number              // day-of-month
  ttlKg: number
  ttlPhp: number | null    // null if !canViewPrices
  laneCount: number
  rows: RcMovementRow[]
}

export type RcMovementData = {
  days: RcMovementDay[]
  canViewPrices: boolean
}

export async function fetchRcMovementData(year: number, month: number): Promise<RcMovementData>
```

**Error handling:**
- If user not authed, return empty days array + `canViewPrices: false`
- If view query fails, log error, return empty + `canViewPrices: false` (do not throw — match blocking/actions.ts pattern)

## Schema drift caveat

Per `FLASK_PORT_PLAN.md` Section 3.4, the live Supabase project has objects (`user_dashboard_prefs`, `view_blocking_grid`) that aren't in tracked migrations. **Do not try to reconcile that drift now.** Just add the new migration for `view_rc_movement` and apply it. The Flask port phase will handle drift reconciliation later.

## Schema migration file structure

Match the existing convention seen in `supabase/migrations/20260214173709_rewrite_trigger_view_and_data_fix.sql`:
- Header comment explaining what the migration does
- `CREATE OR REPLACE VIEW view_rc_movement AS ...`
- Optional `GRANT SELECT` if needed (check existing views' grants)
- Idempotent — running twice does nothing harmful

Use today's timestamp prefix: `YYYYMMDDHHMMSS_create_view_rc_movement.sql`. Today is 2026-05-25.

## Process

1. **Enter plan mode FIRST** via `ExitPlanMode`. Present:
   - The exact SQL for `view_rc_movement` (full text, ready to paste)
   - The migration filename
   - The server action signature + return type
   - The type regeneration command
2. After plan approval, execute:
   - Create the migration file under `supabase/migrations/`
   - Apply the migration to the linked Supabase project using the Supabase MCP tools available to you
   - Regenerate `types/supabase.ts`: `supabase gen types typescript --linked > types/supabase.ts`
   - Create the directory `app/(app)/inventory/rc-movement/` if it doesn't exist
   - Create the server action file
3. **Verify** by running the server action mentally against May 2026 data — you should see rows for May 18–22 at minimum (per our recent inspection)
4. Update `TIMELINE.md` with a new entry in **Recent Completions** at the top of the table, dated 2026-05-25, summarizing what landed
5. Output a summary including the EXACT TypeScript return type so the frontend agent can build against it without ambiguity

## Constraints

- **DO NOT** touch existing RC OUT actions or table — RC Movement is a sibling, not a replacement
- **DO NOT** update `FLASK_PORT_PLAN.md` yet — that comes after the frontend lands
- **DO NOT** add audit logging for read-only queries
- **DO NOT** add any new tables, only the view
- **Do not skip the type regeneration step** — the frontend agent needs accurate types
- Use `model: 'sonnet'` if you spawn any sub-subagents (per project convention)

## Done criteria

- `view_rc_movement` exists in Supabase and returns rows when queried directly
- `types/supabase.ts` includes the new view's row type
- `app/(app)/inventory/rc-movement/actions.ts` exists and `fetchRcMovementData(2026, 5)` returns at least the May 18–22 days
- `TIMELINE.md` updated with a new top-row Recent Completions entry
- You report back the final return type as a code block

Report when done.
