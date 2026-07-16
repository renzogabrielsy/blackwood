-- Re-sync batches.current_weight = SUM(deliveries) - SUM(rc_out) for the 3 active
-- batches whose cached current_weight drifted +phantom (AUDIT_FINDINGS AF-001 / L-005).
--
-- Root cause was an ingestion-path imperative `current_weight += weight` that ran on
-- top of the trigger's own increment (the 2026-05-27 deliveries-manager run), plus a
-- 2026-05-30 rc_out reassignment on MAY-26-FEED5/FEED6 that left current_weight stale.
-- We ONLY touch the derived current_weight here — no transaction rows are altered.
--
-- Scope is restricted to an explicit batch_code allow-list so this can never mass-update
-- legacy/pre-2025 history. A full sweep on 2026-05-31 also surfaced two CLOSED legacy
-- batches with drift (MAY-26-FEED5 +13,330, JAN-26-SUNDRY7 -2,533); those are
-- intentionally NOT auto-fixed here and are flagged for human review.
--
-- Pre-fix vs target:
--   MAY-26-FEED6 : 32,660 -> 13,330  (in 19,330 - out 6,000)
--   MAY-26-BLK9  : 74,130 -> 55,405  (in 55,405 - out 0)
--   MAY-26-BLK7  : 62,125 -> 45,990  (in 45,990 - out 0)

UPDATE batches b
SET current_weight = COALESCE((
        SELECT SUM(d.weight_kg) FROM deliveries d WHERE d.batch_code = b.batch_code
    ), 0)
    - COALESCE((
        SELECT SUM(r.weight_kg) FROM rc_out r WHERE r.batch_id = b.id
    ), 0),
    updated_at = now()
WHERE b.batch_code IN ('MAY-26-FEED6', 'MAY-26-BLK9', 'MAY-26-BLK7');
