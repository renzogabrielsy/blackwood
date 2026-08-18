-- Fix: the sync worker cannot read two of the five views it depends on.
--
-- SYMPTOM. Reading `view_digest_stream_status` or `view_digest_unpriced_deliveries`
-- with the service-role key returns HTTP 403 / SQLSTATE 42501, "permission denied".
-- Both reads sit behind a bare `catch` in the worker, so the permission error has
-- been rendered as "nothing to report" since the day each alarm was built:
--
--   * the stream-freshness watch (2026-08-04) -- `sync_runs.result.reconciliation
--     .stale_streams` is ABSENT on every run in the table. The watch has never once
--     fired, including on days when the view plainly reports a late stream.
--   * the unpriced-delivery chase (2026-08-07, L-039 rule 5) -- the warning that
--     exists precisely to catch a price outage the price step itself missed.
--
-- These are the only two of the worker's five views that carry an alarm, and they
-- are exactly the two it cannot read.
--
-- WHY IT LOOKED FINE. Every one of these is a `security_invoker` view, so the
-- CALLER's privileges are applied to every relation underneath, all the way down.
-- The denial therefore CASCADES, and the error names the DEPENDENCY rather than the
-- view that was actually asked for. Measured pre-fix, as service_role:
--
--   SELECT ... FROM view_digest_unpriced_deliveries
--     -> ERROR 42501: permission denied for view view_digest_operational_days
--
-- `view_digest_unpriced_deliveries` HAD its service_role grant the whole time --
-- 20260807040107 granted it `TO authenticated, service_role`, correctly
-- anticipating the worker. It still 403s, because `view_digest_operational_days`
-- (20260604000000, granted `authenticated` only, back when the digest was app-only)
-- does not. A grant on the outermost view alone buys nothing. That is the trap this
-- migration exists to close, and it is why the fix is a CLOSURE, not a grant.
--
-- THE CLOSURE, walked over pg_depend/pg_rewrite rather than by inspection:
--
--   view_digest_stream_status         (root, worker-read)   MISSING
--     |- view_digest_stream_registry                        MISSING
--     |- view_digest_stream_reported_days                   MISSING
--     |- view_digest_operational_days                       MISSING
--     `- production_schedule                    (table)     ok
--   view_digest_unpriced_deliveries   (root, worker-read)   ok (20260807040107)
--     `- view_digest_operational_days                       MISSING  <-- shared
--
-- Every base table underneath (deliveries, rc_out, production_shifts,
-- production_runs, electricity_readings, truck_readings, production_schedule)
-- already holds service_role SELECT, and the closure reaches NO functions at all,
-- so relation grants are the entire fix.
--
-- SCOPE. `service_role` only. `anon` is untouched and stays revoked (Phase-4
-- hardening, deliberate). `authenticated` is untouched -- it already reads all of
-- these, and this migration widens nothing for the app.
--
-- NOT DOING: converting anything away from `security_invoker`, and not adding or
-- relaxing an RLS policy. `service_role` already holds rolbypassrls, so RLS was
-- never the obstacle; the obstacle is a plain table-level privilege and the correct
-- instrument is a plain GRANT. Re-rooting a view to `security_definer` would make it
-- run as its owner for EVERY caller -- a permanent privilege change to paper over a
-- missing grant. Same trade CLAUDE.md rejects under "Database Rules" for
-- `fn_recompute_batch_state`: grant the helper, never re-root the invoker.

GRANT SELECT ON public.view_digest_stream_status        TO service_role;
GRANT SELECT ON public.view_digest_stream_registry      TO service_role;
GRANT SELECT ON public.view_digest_stream_reported_days TO service_role;
GRANT SELECT ON public.view_digest_operational_days     TO service_role;

-- Already granted by 20260807040107. Restated so this migration names the COMPLETE
-- closure rather than only the half that happened to be broken -- reading it later
-- should tell the whole story. GRANT is idempotent.
GRANT SELECT ON public.view_digest_unpriced_deliveries  TO service_role;

-- DELIBERATELY NOT GRANTED, and this is the part that is easy to get backwards.
-- `view_digest_stream_freshness` and `view_digest_unpriced_recent` are CONSUMERS of
-- the worker's two views, not dependencies of them -- freshness reads FROM
-- view_digest_stream_status, unpriced_recent reads FROM
-- view_digest_unpriced_deliveries. Neither is in the closure and the worker reads
-- neither, so both stay `authenticated`-only under "grant back only the roles that
-- call it". If the worker ever does read one, scripts/verify-worker-view-grants.ts
-- fails on it by construction -- which is the point of deriving that script's view
-- list from the worker source instead of from a hand-kept list.

COMMENT ON VIEW public.view_digest_stream_status IS
  'Lag-aware per-stream reporting status: prev_reported_date, operational_date and '
  'missed_working_days (production_schedule days with shifts > 0 STRICTLY between the '
  'stream''s latest reported day and the operational date). Owns the ONE definition of '
  '"a stream is late". Read by BOTH the Home digest (as authenticated) and the sync '
  'worker''s stream-freshness watch (as service_role) -- security_invoker, so BOTH '
  'roles need SELECT on this view AND on its whole dependency chain '
  '(view_digest_stream_registry, view_digest_stream_reported_days, '
  'view_digest_operational_days). Without the service_role half the worker read fails '
  'with SQLSTATE 42501 and the freshness watch silently reports nothing.';

COMMENT ON VIEW public.view_digest_stream_registry IS
  'The ONE stream list + labels + reports_next_day. Dependency of '
  'view_digest_stream_status, so it needs SELECT for every role that reads that view '
  '-- authenticated (Home digest) and service_role (sync worker). security_invoker '
  'means a missing grant here denies the OUTER view, naming this one in the error.';

COMMENT ON VIEW public.view_digest_stream_reported_days IS
  'One row per stream per REPORTED date. Owns the production "has a production_runs '
  'child" rule -- do not duplicate or weaken it. Dependency of '
  'view_digest_stream_status, so it needs SELECT for every role that reads that view '
  '-- authenticated (Home digest) and service_role (sync worker).';

COMMENT ON VIEW public.view_digest_operational_days IS
  'The operational date -- the latest day the plant has actually reported, which lags '
  'the calendar. Dependency of BOTH view_digest_stream_status and '
  'view_digest_unpriced_deliveries, which is why a service_role grant on either of '
  'those alone was not enough: security_invoker cascades the caller''s privileges down '
  'the whole chain, so from 2026-08-07 to 2026-08-18 a correctly-granted '
  'view_digest_unpriced_deliveries still failed with "permission denied for view '
  'view_digest_operational_days". Needs SELECT for authenticated AND service_role.';

-- NOTE for whoever edits these views next: `CREATE OR REPLACE VIEW` PRESERVES grants,
-- but `DROP VIEW` + `CREATE VIEW` DOES NOT. If you drop and recreate any relation in
-- this closure, re-grant service_role in the same migration, and run
-- `npx tsx scripts/verify-worker-view-grants.ts` before you call it done.
