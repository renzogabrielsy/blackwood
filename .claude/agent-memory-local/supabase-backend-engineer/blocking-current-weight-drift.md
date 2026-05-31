# Blocking phantom-inventory fix (2026-05-31)

AUDIT_FINDINGS AF-001 / LEARNING_LEDGER L-005+L-006. ~54 t of phantom inventory shown in the
blocking grid because `batches.current_weight` was over-stated on several batches and
`view_blocking_grid.balance` read that cache directly.

## Root cause (CONFIRMED — NOT a trigger bug)

The two triggers that maintain `current_weight` are correct and were NOT changed:
- `fn_update_blackwood_state` (BEFORE INSERT/UPDATE/DELETE on `deliveries`, trigger `tr_blackwood_delivery`,
  tgtype=31): INSERT does a single `current_weight = current_weight + NEW.weight_kg`. UPDATE/DELETE
  recompute from scratch (`SUM(deliveries) − SUM(rc_out)`).
- `fn_process_blackwood_usage` (INSERT/UPDATE/DELETE on `rc_out`): INSERT does a single
  `current_weight = current_weight - NEW.weight_kg`. UPDATE does `+ OLD.weight_kg - NEW.weight_kg`.

The double-count was an **ingestion-path imperative `UPDATE batches SET current_weight = current_weight + <weight>`**
that the **deliveries-manager** EXECUTE run on **2026-05-27 03:04:39** issued ON TOP of the trigger
(the L-001 family — agent imperative update racing/duplicating a maintaining trigger).

## How I proved trigger-vs-imperative (reusable technique)

Decisive test: compare rows that went through the **same trigger** on **different ingestion runs**.
- The 6 deliveries inserted on 2026-05-26 → NOT doubled.
- The 3 deliveries inserted on 2026-05-27 03:04:39 → each doubled by *exactly its own weight*
  (BLK7 +16,135, BLK9 +18,725, FEED6 +19,330).
A trigger bug would corrupt BOTH runs equally. "Only one run's rows wrong, each off by exactly its own
weight" ⇒ an external `+= delta` on that run, not the trigger. `audit_logs` INSERT timestamps tied the
bad run to a specific Gmail thread/operator UID.

Also: MAY-26-FEED5 +13,330 drift = the 2026-05-30 rc_out reassignment run leaving `current_weight` stale.

## Fix applied

1. Migration `20260531041520_fix_blocking_view_balance_from_transactions` — `view_blocking_grid.balance`
   = `SUM(deliveries.weight_kg) − SUM(rc_out.weight_kg)`. The rc_out total is a **correlated subquery
   `(SELECT SUM(r.weight_kg) FROM rc_out r WHERE r.batch_id = b.id)` evaluated OUTSIDE the GROUP BY** —
   critical, because the per-delivery `LEFT JOIN deliveries` fans out one row per delivery; putting the
   rc_out sum inside the aggregate would multiply it by the delivery count. Kept SECURITY INVOKER, all
   column names (`balance`, `total_in`, `avg_php_kg`, `avg_*`), DISTINCT ON dedup, and grants identical
   → `types/supabase.ts` view surface unchanged (regenerated, byte-identical), no frontend change needed.
2. Migration `20260531041615_resync_current_weight_for_drifted_active_batches` — re-synced the 3 active
   batches via explicit `batch_code` allow-list (never mass-updates legacy history).

## Playbook rule for ingestion agents (deliveries-manager / gsheet-sync)

After a delivery or rc_out INSERT, NEVER `UPDATE batches SET current_weight = current_weight + delta` —
the trigger already did it. The only legit `current_weight` write is `INSERT INTO batches (... current_weight)
VALUES (..., 0) ON CONFLICT DO NOTHING` for brand-new batches (0 before the first delivery's trigger fires).
If reconciliation is ever needed, use the **idempotent absolute form**:
`SET current_weight = COALESCE((SELECT SUM(weight_kg) FROM deliveries WHERE batch_code=b.batch_code),0)
 - COALESCE((SELECT SUM(weight_kg) FROM rc_out r WHERE r.batch_id=b.id),0)` — never `+= delta`.

## Left for Renzo (flagged, not auto-fixed)

Full sweep also found 2 legacy CLOSED batches with drift: MAY-26-FEED5 (+13,330), JAN-26-SUNDRY7
(−2,533). Both CLOSED ⇒ absent from the grid (view filters STORED/IN-USE/SUNDRYING/SUNDRIED with
non-empty location_ref). JAN-26-SUNDRY7 also retains `location_ref='A-4C'` despite CLOSED (separate
location-not-cleared-on-close artifact, harmless to the grid).

## Env gotcha hit this session

`supabase gen types typescript --linked` failed with a `cli_login_postgres` "permission denied to alter role"
error AND its `>` redirect truncated `types/supabase.ts` to 0 bytes first. Use the MCP
`generate_typescript_types` tool instead; if the CLI already nuked the file, restore from the MCP output.
