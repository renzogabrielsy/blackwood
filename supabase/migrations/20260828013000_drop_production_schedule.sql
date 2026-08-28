-- REMOVAL (migration B of two) — retire the production-schedule feature.
--
-- ############################################################################
-- DO NOT APPLY THIS UNTIL BOTH DEPLOY TARGETS HAVE STOPPED READING THESE OBJECTS.
--
--   1. The Next.js app must be merged to `main` and DEPLOYED by Vercel with every
--      reference to production_schedule / view_production_schedule_* /
--      fn_*_schedule_* removed.
--   2. The sync worker must be deployed to Fly (`cd workers/sync && npm run deploy`)
--      with reports/prodSchedule/** removed. MERGING TO `main` DOES NOT DEPLOY THE
--      WORKER — a still-running old bundle calls fn_apply_schedule_upstream every
--      run and would start erroring the moment this migration lands.
--
-- Applying B early does not lose data (migration A already took the copy), but it
-- WILL break a live sync run and a live page. Order matters, not safety.
-- ############################################################################
--
-- EVERYTHING DROPPED HERE IS RECOVERABLE:
--   graveyard.production_schedule_20260827   — all 273 rows
--   graveyard.prod_schedule_ddl_20260827     — the exact replayable DDL
--   _archived/prod-schedule-v1/db/RESTORE.sql — the same DDL plus the restore ORDER
-- Deleting the graveyard is a separate, explicit decision and is NOT part of this.
--
-- Applied by migration A: 20260828012428_archive_production_schedule.sql

-- ================================================================ --
-- 1. FIRST, free the one shared view — before anything is dropped.
--
-- view_digest_stream_status is NOT a schedule view. It survives. It reads
-- production_schedule for exactly one term, missed_working_days, so that term has
-- to be rewritten before the table can go.
--
-- OLD DEFINITION: planned days (production_schedule.shifts > 0) strictly between
--   the stream's latest reported day and the operational date.
-- NEW DEFINITION: days on which ANY OTHER STREAM REPORTED, strictly between the
--   same two dates, derived from view_digest_stream_reported_days.
--
-- WHY THE SEMANTIC SURVIVES — and it is NOT "nothing reports on a Sunday".
-- That would be a comfortable story and the data refuses it: in 2026 to date,
-- 8 of 34 Sundays and 15 planned rest days in total (Sundays, New Year, Labor
-- Day, a forced leave, the earthquake leave) carried at least one stream's
-- report. What actually preserves "a Sunday is never late" is the STRICT
-- `< operational_date` bound combined with operational_date being itself derived
-- from reported activity: a quiet stretch that ENDS on a Sunday cannot be
-- counted, because that Sunday IS the operational date.
--
-- MEASURED, not assumed. Replaying all 239 days of 2026 x 5 streams (1,195
-- stream-days), reconstructing through_date and operational_date as of each day:
--   * 1,188 of 1,195 identical verdicts (99.4%)
--   * 6 days the new rule flags and the old did not — every one a Sunday or
--     holiday on which the plant demonstrably had activity while the stream in
--     question stayed silent (2026-01-01 rc_out, 02-16 production, 03-16
--     electricity/production/trucks, 06-08 rc_out). Arguably the truer signal:
--     the plant was moving and this stream said nothing.
--   * 1 day the old rule flagged and the new does not — 2026-05-04, trucks,
--     where the missed day (2026-05-02) was a planned working day on which NO
--     stream reported at all.
--
-- THAT LAST CASE IS THE NEW RULE'S ONE BLIND SPOT, AND IT IS STRUCTURAL: with no
-- schedule table, nothing in the database records that a completely silent day
-- was supposed to be worked. A total plant-wide outage therefore reads as a
-- holiday. It is not hidden by this migration — it is stated here because the
-- next person to wonder why a quiet week went unflagged deserves to find it
-- written down rather than infer it.
--
-- CREATE OR REPLACE, NEVER DROP + CREATE (L-044). DROP VIEW loses the grants, and
-- the service_role grant on this view is the only thing standing between the sync
-- worker's stream-freshness watch and another silent 42501. The column list,
-- order and types are unchanged, so REPLACE is legal here and no grant moves.
-- ================================================================ --
CREATE OR REPLACE VIEW public.view_digest_stream_status
WITH (security_invoker = true) AS
 WITH op AS (
         SELECT view_digest_operational_days.operational_date
           FROM view_digest_operational_days
        )
 SELECT r.stream,
    r.label,
    r.reports_next_day,
    agg.through_date,
    agg.prev_reported_date,
    op.operational_date,
        CASE
            WHEN agg.through_date IS NULL OR op.operational_date IS NULL THEN NULL::integer
            ELSE ( SELECT count(DISTINCT other.reported_date)::integer AS count
               FROM view_digest_stream_reported_days other
              WHERE other.stream <> r.stream
                AND other.reported_date > agg.through_date
                AND other.reported_date < op.operational_date)
        END AS missed_working_days,
    r.sort_order
   FROM view_digest_stream_registry r
     CROSS JOIN op
     LEFT JOIN LATERAL ( SELECT max(x.reported_date) FILTER (WHERE x.rn = 1) AS through_date,
            max(x.reported_date) FILTER (WHERE x.rn = 2) AS prev_reported_date
           FROM ( SELECT s.reported_date,
                    row_number() OVER (ORDER BY s.reported_date DESC) AS rn
                   FROM view_digest_stream_reported_days s
                  WHERE s.stream = r.stream) x
          WHERE x.rn <= 2) agg ON true
  ORDER BY r.sort_order;

-- Belt and braces. CREATE OR REPLACE keeps these, but a lost service_role grant is
-- precisely the failure that went unnoticed for two weeks, so re-state it rather
-- than trust that it survived.
GRANT SELECT ON public.view_digest_stream_status TO authenticated, service_role;

COMMENT ON VIEW public.view_digest_stream_status IS
  'Lag-aware per-stream reporting status: prev_reported_date, operational_date and missed_working_days. Owns the ONE definition of "a stream is late". Since 2026-08-28 missed_working_days counts DAYS ON WHICH ANY OTHER STREAM REPORTED, strictly between this stream''s latest reported day and the operational date — production_schedule was removed (see graveyard.prod_schedule_ddl_20260827 / _archived/prod-schedule-v1/db/RESTORE.sql). Replaying 2026 gave the same verdict on 1,188 of 1,195 stream-days; the new rule is marginally MORE sensitive (it flags a Sunday or holiday the plant actually worked) and has one structural blind spot (a day on which NO stream reported at all cannot be known to have been a working day). "A Sunday is never late" still holds, but because the < operational_date bound is strict and operational_date is activity-derived — NOT because nothing reports on Sundays: 8 Sundays in 2026 did. Read by BOTH the Home digest (as authenticated) and the sync worker''s stream-freshness watch (as service_role) -- security_invoker, so BOTH roles need SELECT on this view AND on its whole dependency chain (view_digest_stream_registry, view_digest_stream_reported_days, view_digest_operational_days). Without the service_role half the worker read fails with SQLSTATE 42501 and the freshness watch silently reports nothing.';

-- view_digest_stream_freshness is a thin projection of the above and is NOT touched:
-- its three columns did not move. It is deliberately still authenticated-only — it is
-- a CONSUMER of view_digest_stream_status, not a dependency of it, and the worker
-- never reads it (see scripts/verify-worker-view-grants.ts).

-- ================================================================ --
-- 2. The stream vocabulary needs no edit — verified, not assumed.
--
-- view_digest_stream_registry lists exactly five streams (deliveries, rc_out,
-- production, electricity, trucks). There has never been a prod-schedule stream:
-- the schedule was the PLAN the streams were measured against, never a reporting
-- stream of its own. This assertion exists so that if someone adds one later, this
-- migration refuses rather than leaving a stream pointing at a table that is gone.
-- ================================================================ --
DO $vocab$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(stream, ', ') INTO v_bad
    FROM public.view_digest_stream_registry
   WHERE stream ILIKE '%schedule%' OR stream ILIKE '%prod_sched%' OR stream ILIKE '%plan%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'the stream registry still names a schedule stream (%) — remove it from view_digest_stream_registry before dropping the table', v_bad;
  END IF;
END
$vocab$;

-- ================================================================ --
-- 3. Drop the schedule-only objects, in dependency order.
--
-- No CASCADE anywhere. CASCADE would happily take something with it that nobody
-- inspected; a plain DROP that fails is the signal that the dependency walk missed
-- something. The two views come first because they read the table; the functions
-- are independent of each other; the table is last.
-- ================================================================ --
DROP VIEW IF EXISTS public.view_production_schedule_conflicts;
DROP VIEW IF EXISTS public.view_production_schedule_state;

DROP FUNCTION IF EXISTS public.fn_apply_schedule_upstream(jsonb);
DROP FUNCTION IF EXISTS public.fn_save_schedule_day(date, integer, jsonb, boolean);
DROP FUNCTION IF EXISTS public.fn_release_schedule_day(date, integer);

DROP TABLE IF EXISTS public.production_schedule;

-- ================================================================ --
-- 4. Prove it landed clean.
-- ================================================================ --
DO $checks$
DECLARE
  v_left text;
  v_rows integer;
  v_arch integer;
BEGIN
  -- Nothing in any schema may still reference the dropped objects.
  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO v_left
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relname IN ('production_schedule',
                       'view_production_schedule_state',
                       'view_production_schedule_conflicts')
     AND n.nspname = 'public';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'still present in public: %', v_left;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_apply_schedule_upstream', 'fn_save_schedule_day', 'fn_release_schedule_day');
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'schedule function(s) still present: %', v_left;
  END IF;

  -- No function body anywhere may still name the table.
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prosrc ILIKE '%production_schedule%';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'a function body still references production_schedule: %', v_left;
  END IF;

  -- The shared view still works and still answers for all five streams.
  SELECT count(*) INTO v_rows FROM public.view_digest_stream_status;
  IF v_rows <> 5 THEN
    RAISE EXCEPTION 'view_digest_stream_status returned % rows, expected 5', v_rows;
  END IF;
  PERFORM 1 FROM public.view_digest_stream_freshness;

  -- And the grave is still full. If this ever fails, DO NOT proceed — the removal
  -- would have become irreversible.
  SELECT count(*) INTO v_arch FROM graveyard.production_schedule_20260827;
  IF v_arch <> 273 THEN
    RAISE EXCEPTION 'graveyard holds % rows, expected 273 — the archive is not intact', v_arch;
  END IF;
  IF (SELECT count(*) FROM graveyard.prod_schedule_ddl_20260827) <> 8 THEN
    RAISE EXCEPTION 'graveyard DDL table does not hold the expected 8 objects';
  END IF;

  RAISE NOTICE 'production-schedule removed; % rows and 8 object definitions remain recoverable in graveyard', v_arch;
END
$checks$;

-- ================================================================ --
-- 5. THE COORDINATOR'S POST-APPLY STEPS — this migration cannot do them.
--
--   a. npx tsx scripts/verify-worker-view-grants.ts
--      It reads AS service_role over PostgREST, which SQL running as postgres
--      cannot simulate. It must report FOUR views (view_blocking_grid,
--      view_digest_stream_status, view_digest_unpriced_deliveries,
--      view_flecon_bag_balance) and zero findings. view_production_schedule_state
--      leaves the list on its own: the script derives the list from string
--      literals in workers/sync/src, so it disappears the moment the worker code
--      does. If the script still names it, the WORKER HAS NOT BEEN UPDATED and
--      this migration was applied too early.
--
--   b. supabase gen types typescript --linked > types/supabase.ts
--      Only now. Regenerating before this point would keep the dropped table in
--      the types and the app would compile against something that no longer exists.
-- ================================================================ --
