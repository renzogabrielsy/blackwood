-- BUG A backfill (Renzo arbitration, 2026-07-11) — DO NOT RUN AUTOMATICALLY.
-- The orchestrator runs this manually, after the migration
-- supabase/migrations/20260711033000_fn_is_close_remark_and_trigger_update.sql has been
-- applied. This is intentionally NOT a migration file: it is a one-time data correction,
-- not a schema change, and its blast radius must be reviewed by a human before the UPDATE
-- runs.
--
-- ============================================================================
-- STEP 1 — REVIEW: batches that are NOT CLOSED but have an rc_out remark that
-- fn_is_close_remark() now recognizes as a close signal.
-- ============================================================================
-- Run this first. As of the 2026-07-11 survey this returns ZERO rows — every batch with
-- a live "CLOSED" remark had already been auto-closed by the OLD (ILIKE '%CLOSED%')
-- trigger logic, so there is no backlog of remark-matched-but-not-closed batches. This
-- query is still worth keeping/re-running: it is the general-purpose drift check for any
-- future close-signal phrase that slips through ingestion before the trigger sees it.

SELECT
    b.id,
    b.batch_code,
    b.location_ref,
    b.status,
    b.current_weight,
    array_agg(DISTINCT r.remarks) FILTER (WHERE fn_is_close_remark(r.remarks)) AS matching_remarks
FROM batches b
JOIN rc_out r ON r.batch_id = b.id
WHERE b.status != 'CLOSED'
  AND fn_is_close_remark(r.remarks)
GROUP BY b.id, b.batch_code, b.location_ref, b.status, b.current_weight
ORDER BY b.batch_code;

-- ============================================================================
-- STEP 2 — GENERAL BACKFILL: close every batch the review query above surfaces.
-- ============================================================================
-- Safe to run repeatedly (idempotent — only touches rows where status != 'CLOSED').
-- Uses the exact same fn_is_close_remark() predicate as the trigger, so this can never
-- close a batch the live trigger logic wouldn't also close going forward.

-- UPDATE batches b
-- SET status = 'CLOSED', updated_at = now()
-- WHERE b.status != 'CLOSED'
--   AND EXISTS (
--     SELECT 1 FROM rc_out r
--     WHERE r.batch_id = b.id
--       AND fn_is_close_remark(r.remarks)
--   );

-- ============================================================================
-- STEP 3 — ONE-OFF: AUG-25-BLK2 (block C-12A).
-- ============================================================================
-- This batch is NOT caught by Step 1/2's remark-matching query — its rc_out row
-- (transaction_date=2026-07-08, batch_code=AUG-25-BLK2, weight_kg=15,286) currently has
-- remarks=NULL in the DB. The plant's PROPOSED DAILY REPORT for that date carried the
-- remark "DONE FEEDING", but it never reached the DB (see the ingestion finding reported
-- alongside this backfill — the extraction/apply path is dropping remarks for this
-- section shape). Closing this batch is authorized by Renzo's 2026-07-11 arbitration
-- ("BUG A") citing the PROPOSED DAILY REPORT text directly, independent of what's stored
-- in the DB row.
--
-- Verify before running:
--   SELECT id, batch_code, location_ref, status, current_weight
--   FROM batches WHERE batch_code = 'AUG-25-BLK2';
--   -- expect: status='IN-USE', current_weight=265.00, location_ref='C-12A' (as of 2026-07-11)

-- UPDATE batches
-- SET status = 'CLOSED', updated_at = now()
-- WHERE batch_code = 'AUG-25-BLK2'
--   AND status != 'CLOSED';
