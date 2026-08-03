-- PRODUCTION FACTS — the HUMAN-EDIT LATCH (2026-08-03)
--
-- WHY
-- ---
-- `workers/sync/src/reports/production/apply.ts` step 5 ("Apply ALL VALUE_CHANGED")
-- turns every classify disagreement into `db.update(<table>, {id: eq.<id>}, patch)`.
-- The app edits those same six tables (app/(app)/production/{daily,trucks,electricity}/
-- actions.ts). So the moment a human corrects a number by hand, MC's workbook still
-- says the old value, the next run classifies VALUE_CHANGED, and the sync reverts the
-- human — silently. That is precisely the failure CLAUDE.md's "Sync Integrity" section
-- forbids: "Disagreements are never auto-resolved — the human arbitrates them."
--
-- (Today that UPDATE is DORMANT: the classifiers emit `{field:{db,email}}` /
-- `[{field,emailValue,dbValue}]`, while apply reads a `.new` key neither shape carries,
-- so the patch is always empty and the write is skipped. The bug is one obvious-looking
-- "fix the patch shape" commit away from going live. This migration puts the guard
-- UNDER the write path so it can never go live unguarded.)
--
-- THE MODEL — "human-edit latch" (deliberately LIGHTER than production_schedule's)
-- --------------------------------------------------------------------------------
-- Two nullable columns per table:
--   human_edited_at  NULL = sync-owned, the sync may update it freely.
--                    NOT NULL = a human touched this row in the app. THE SYNC WILL NOT
--                    WRITE IT — not "carefully", not at all.
--   human_edited_by  who (profiles.id), for the read model. NEVER read by the guard.
--
-- Why not the schedule's fuller `owner` + `pending_upstream` + `row_version` model:
--
--   * `owner` enum — the schedule has TWO competing upstreams (Joseph's email, Renzo's
--     PROD SCHED tab) and must know WHICH one to hand a released day back to. A
--     production fact has exactly ONE upstream (MC's / Ivy's workbook), so ownership is
--     binary and a nullable timestamp IS the boolean, with the "when" for free.
--
--   * `pending_upstream` — the schedule parks the withheld value ON the row because the
--     plan is a forward-looking document and the conflict must survive until arbitrated.
--     A production fact's withheld value is already fully described by the run's classify
--     diff, and MC's workbook is CUMULATIVE: it still says the same thing tomorrow, so the
--     run finding RE-FIRES every run until the human resolves it. A parked copy would be a
--     second, drifting record of something the source re-states for free.
--
--   * `row_version` — optimistic concurrency answers "did this row change since I read
--     it". The guard here answers "has a human EVER touched it", which is a MONOTONE
--     LATCH: NULL -> NOT NULL happens on any app write and only the explicit release RPC
--     moves it back, so there is no ABA hazard for a version token to catch. Threading a
--     version through 5 classifiers and 6 tables would buy nothing.
--
-- HOW THE STAMP IS SET — by TRIGGER, not by the caller
-- ----------------------------------------------------
-- A guard the app forgets to set is useless, and these tables have EIGHT app write sites
-- (runs insert/update, shifts upsert, downtime upsert, waste upsert, trucks
-- insert/update, electricity insert/update) plus whatever ships next. `fn_stamp_human_edit`
-- is a BEFORE INSERT OR UPDATE trigger on all six: if `auth.uid()` is non-null (an
-- authenticated app session) the row is stamped, full stop. The sync worker uses the
-- SERVICE-ROLE key, whose JWT carries no `sub`, so `auth.uid()` is NULL and sync writes
-- never stamp. The app's actions ALSO pass `human_edited_at` explicitly — belt and braces,
-- and it keeps the intent legible at the call site.
--
-- HOW A ROW GETS HANDED BACK
-- --------------------------
-- `fn_release_production_rows(table, ids)` clears the stamp, so the row follows the
-- workbook again. Without it ownership ratchets one way and the data slowly freezes —
-- the exact failure the schedule work called out (see 20260730070000). Release is
-- EXPLICIT only: a row is NOT auto-released just because the workbook later agrees, so
-- rule 1 ("a row a human edited is never overwritten") holds without exception.
--
-- NO NEW INDEXES on purpose: the guard rides the PK (`id = ... AND human_edited_at IS
-- NULL`), and the read model scans ~1,900 rows across all six tables. An index here would
-- be noise.
--
-- NO AUDIT TRIGGER on purpose either: the sync already writes its own audit_logs rows for
-- these tables via `write_ingestion_audit`, so a table-level audit trigger would DOUBLE
-- every ingestion row and pollute the activity feed / view_digest_audit_enriched. Giving
-- the production family a real audit trail means adding the trigger AND removing the
-- worker's manual writes in the same changeset — a separate piece of work. The stamp
-- columns themselves record who last touched each row by hand.

-- ===========================================================================
-- 1. Columns
-- ===========================================================================

ALTER TABLE public.production_shifts
  ADD COLUMN IF NOT EXISTS human_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_edited_by uuid;
ALTER TABLE public.production_runs
  ADD COLUMN IF NOT EXISTS human_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_edited_by uuid;
ALTER TABLE public.production_downtime
  ADD COLUMN IF NOT EXISTS human_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_edited_by uuid;
ALTER TABLE public.production_waste
  ADD COLUMN IF NOT EXISTS human_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_edited_by uuid;
ALTER TABLE public.electricity_readings
  ADD COLUMN IF NOT EXISTS human_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_edited_by uuid;
ALTER TABLE public.truck_readings
  ADD COLUMN IF NOT EXISTS human_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_edited_by uuid;

-- Every existing row stays NULL — nothing is retro-claimed. Rows written before this
-- migration were all sync-written or hand-entered with no way to tell them apart; the
-- safe default is "the sync may still correct it", which is today's behavior exactly.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'production_shifts', 'production_runs', 'production_downtime',
    'production_waste', 'electricity_readings', 'truck_readings'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', t)::regclass
         AND conname  = format('%s_human_edited_by_fkey', t)
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (human_edited_by) '
        'REFERENCES public.profiles(id) ON DELETE SET NULL',
        t, format('%s_human_edited_by_fkey', t));
    END IF;

    EXECUTE format(
      'COMMENT ON COLUMN public.%I.human_edited_at IS %L', t,
      'When a human last edited this row in the app. NULL = sync-owned (the sync may '
      'update it). NOT NULL = the sync WILL NOT update it; a differing workbook value is '
      'surfaced as a run finding instead. Set by the fn_stamp_human_edit trigger from '
      'auth.uid(); cleared ONLY by fn_release_production_rows.');
    EXECUTE format(
      'COMMENT ON COLUMN public.%I.human_edited_by IS %L', t,
      'Who last edited this row in the app (profiles.id, from auth.uid()). Display only '
      '- the sync guard reads human_edited_at, never this.');
  END LOOP;
END
$$;

-- ===========================================================================
-- 2. fn_stamp_human_edit — the trigger that makes the stamp unforgettable
-- ===========================================================================
--
-- Fires BEFORE INSERT OR UPDATE on all six tables.
--   * `auth.uid()` NULL  -> a service-role write (the sync worker) or a migration:
--                           leave the stamp alone. A sync INSERT therefore creates a
--                           sync-owned row, which is what we want.
--   * `auth.uid()` set   -> an authenticated app session: STAMP, unconditionally. The
--                           caller cannot opt out, and cannot clear the stamp either
--                           (a PATCH sending human_edited_at=null is re-stamped here).
--   * release in flight  -> `fn_release_production_rows` announces itself with the
--                           TRANSACTION-LOCAL GUC `blackwood.release_human_edit`; that
--                           is the ONE write allowed to clear the stamp. The GUC is set
--                           with is_local => true, so it dies with the statement's
--                           transaction and can never leak into a later request.
--
-- human_edited_by is resolved THROUGH profiles rather than assigned raw: an auth user
-- with no profile row (pending/failed handle_new_user) would otherwise 23503 and break
-- the operator's save outright. A missing profile degrades to a NULL "by" — the guard
-- only ever reads human_edited_at.

CREATE OR REPLACE FUNCTION public.fn_stamp_human_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid;
BEGIN
  IF COALESCE(current_setting('blackwood.release_human_edit', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.human_edited_at := now();
  NEW.human_edited_by := (SELECT p.id FROM public.profiles p WHERE p.id = v_uid);
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.fn_stamp_human_edit() IS
  'BEFORE INSERT OR UPDATE on the six production fact tables: stamps human_edited_at/by whenever auth.uid() is non-null (an app session), so an in-app edit can never forget to claim its row. Service-role (sync) writes have no auth.uid() and never stamp. Skipped only while fn_release_production_rows holds the transaction-local GUC blackwood.release_human_edit.';

REVOKE EXECUTE ON FUNCTION public.fn_stamp_human_edit() FROM public;
REVOKE EXECUTE ON FUNCTION public.fn_stamp_human_edit() FROM anon;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'production_shifts', 'production_runs', 'production_downtime',
    'production_waste', 'electricity_readings', 'truck_readings'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tr_stamp_human_edit ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER tr_stamp_human_edit BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_human_edit()', t);
  END LOOP;
END
$$;

-- ===========================================================================
-- 3. fn_apply_production_upstream — the ATOMIC conditional writer
-- ===========================================================================
--
-- The sync's ONLY update path into the production fact tables. Every write re-checks
-- `human_edited_at IS NULL` IN THE SAME STATEMENT AS THE WRITE (it is a predicate in the
-- UPDATE's own WHERE), so a save that lands between the worker's snapshot and this call
-- wins: our write simply does not match, and the op comes back labelled `human_edited`.
-- There is no read-then-write anywhere in this function.
--
-- CONTRACT
--   p_ops jsonb -- ARRAY of { table, id, patch: {col: value, ...} }
--   returns  jsonb -- ARRAY of { table, id, outcome }, outcome one of
--     'applied'           -- written
--     'human_edited'      -- REFUSED: a human owns this row (the whole point)
--     'missing'           -- no such row (deleted between classify and apply)
--     'empty_patch'       -- nothing to write
--     'unsupported_field' -- a patch key outside this table's allowlist; NOTHING written.
--                            Loud on purpose: a new classifier field must be added here
--                            deliberately, never smuggled into a fact table.
--
-- `production_shifts` is deliberately ABSENT from the allowlist: the sync only ever
-- INSERTs shifts (insertIfAbsent), never updates them, and its three columns are the
-- natural key. Adding it must be a conscious act.
--
-- Natural-key columns (reading_date/meter/plate_no) are absent for the same reason: the
-- classifiers key ON them, so a VALUE_CHANGED diff can never legitimately contain one.
-- Generated columns (diff_kwh/consumption_kwh/ttl_km) are absent because Postgres would
-- reject them anyway.
--
-- NOT NULL columns treat a null-ish patch value as "keep what's there" (COALESCE onto the
-- stored value); nullable columns honour an explicit null.

CREATE OR REPLACE FUNCTION public.fn_apply_production_upstream(p_ops jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' THEN
    RAISE EXCEPTION 'fn_apply_production_upstream: p_ops must be a JSON array (got %)',
      COALESCE(jsonb_typeof(p_ops), 'null');
  END IF;
  IF jsonb_array_length(p_ops) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) o
              WHERE NULLIF(o ->> 'table', '') IS NULL OR NULLIF(o ->> 'id', '') IS NULL) THEN
    RAISE EXCEPTION 'fn_apply_production_upstream: every op needs a table and an id';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) o
              WHERE (o ->> 'table') NOT IN ('production_runs', 'production_downtime',
                                            'production_waste', 'electricity_readings',
                                            'truck_readings')) THEN
    RAISE EXCEPTION 'fn_apply_production_upstream: unknown or non-updatable table in p_ops';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) o
              WHERE o ? 'patch' AND jsonb_typeof(o -> 'patch') <> 'object') THEN
    RAISE EXCEPTION 'fn_apply_production_upstream: patch must be a JSON object';
  END IF;

  WITH ops AS (
    SELECT
      (o ->> 'table')                       AS tbl,
      (o ->> 'id')::uuid                    AS id,
      COALESCE(o -> 'patch', '{}'::jsonb)   AS patch
    FROM jsonb_array_elements(p_ops) o
  ),
  -- The per-table column allowlist. Anything else refuses the whole op.
  allowed(tbl, col) AS (VALUES
    ('production_runs',      'customer'),
    ('production_runs',      'grade'),
    ('production_runs',      'ttl_kg'),
    ('production_runs',      'sacks_bags'),
    ('production_runs',      'remarks'),
    ('production_downtime',  'shift_hrs'),
    ('production_downtime',  'dt_hrs'),
    ('production_downtime',  'dt_mins'),
    ('production_downtime',  'dt_reason'),
    ('production_waste',     'rs1a_kg'),
    ('production_waste',     'rs1b_kg'),
    ('production_waste',     'bf_kg'),
    ('production_waste',     'rs23_kg'),
    ('production_waste',     'rs5_kg'),
    ('production_waste',     'trml1_kg'),
    ('production_waste',     'trml2_kg'),
    ('production_waste',     'grit_kg'),
    ('production_waste',     'remarks'),
    ('electricity_readings', 'start_kwh'),
    ('electricity_readings', 'end_kwh'),
    ('electricity_readings', 'meter_multiplier'),
    ('electricity_readings', 'remarks'),
    ('truck_readings',       'start_km'),
    ('truck_readings',       'end_km'),
    ('truck_readings',       'fuel_liters'),
    ('truck_readings',       'remarks')
  ),
  bad AS (
    SELECT DISTINCT o.tbl, o.id
      FROM ops o
      CROSS JOIN LATERAL jsonb_object_keys(o.patch) AS k(col)
     WHERE NOT EXISTS (SELECT 1 FROM allowed a WHERE a.tbl = o.tbl AND a.col = k.col)
  ),
  -- Writable ops: a non-empty, fully-allowlisted patch.
  w AS (
    SELECT o.* FROM ops o
     WHERE o.patch <> '{}'::jsonb
       AND NOT EXISTS (SELECT 1 FROM bad b WHERE b.tbl = o.tbl AND b.id = o.id)
  ),
  -- PRE-write snapshot of every targeted row, for classifying whatever did NOT write.
  -- Read in the same statement, so it sees the state the guards saw.
  snap AS (
    SELECT 'production_runs'::text AS tbl, t.id, t.human_edited_at
      FROM public.production_runs t
     WHERE t.id IN (SELECT id FROM ops WHERE tbl = 'production_runs')
    UNION ALL
    SELECT 'production_downtime', t.id, t.human_edited_at
      FROM public.production_downtime t
     WHERE t.id IN (SELECT id FROM ops WHERE tbl = 'production_downtime')
    UNION ALL
    SELECT 'production_waste', t.id, t.human_edited_at
      FROM public.production_waste t
     WHERE t.id IN (SELECT id FROM ops WHERE tbl = 'production_waste')
    UNION ALL
    SELECT 'electricity_readings', t.id, t.human_edited_at
      FROM public.electricity_readings t
     WHERE t.id IN (SELECT id FROM ops WHERE tbl = 'electricity_readings')
    UNION ALL
    SELECT 'truck_readings', t.id, t.human_edited_at
      FROM public.truck_readings t
     WHERE t.id IN (SELECT id FROM ops WHERE tbl = 'truck_readings')
  ),
  u_runs AS (
    UPDATE public.production_runs t
       SET customer   = CASE WHEN o.patch ? 'customer'
                             THEN COALESCE(NULLIF(o.patch ->> 'customer', ''), t.customer)
                             ELSE t.customer END,
           grade      = CASE WHEN o.patch ? 'grade'
                             THEN COALESCE(NULLIF(o.patch ->> 'grade', ''), t.grade)
                             ELSE t.grade END,
           ttl_kg     = CASE WHEN o.patch ? 'ttl_kg'
                             THEN COALESCE(NULLIF(o.patch ->> 'ttl_kg', '')::numeric, t.ttl_kg)
                             ELSE t.ttl_kg END,
           sacks_bags = CASE WHEN o.patch ? 'sacks_bags'
                             THEN NULLIF(o.patch ->> 'sacks_bags', '')::integer
                             ELSE t.sacks_bags END,
           remarks    = CASE WHEN o.patch ? 'remarks'
                             THEN NULLIF(o.patch ->> 'remarks', '')
                             ELSE t.remarks END
      FROM w o
     WHERE o.tbl = 'production_runs'
       AND t.id  = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  ),
  u_downtime AS (
    UPDATE public.production_downtime t
       SET shift_hrs = CASE WHEN o.patch ? 'shift_hrs'
                            THEN COALESCE(NULLIF(o.patch ->> 'shift_hrs', '')::numeric, t.shift_hrs)
                            ELSE t.shift_hrs END,
           dt_hrs    = CASE WHEN o.patch ? 'dt_hrs'
                            THEN COALESCE(NULLIF(o.patch ->> 'dt_hrs', '')::numeric, t.dt_hrs)
                            ELSE t.dt_hrs END,
           dt_mins   = CASE WHEN o.patch ? 'dt_mins'
                            THEN COALESCE(NULLIF(o.patch ->> 'dt_mins', '')::numeric, t.dt_mins)
                            ELSE t.dt_mins END,
           dt_reason = CASE WHEN o.patch ? 'dt_reason'
                            THEN NULLIF(o.patch ->> 'dt_reason', '')
                            ELSE t.dt_reason END
      FROM w o
     WHERE o.tbl = 'production_downtime'
       AND t.id  = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  ),
  u_waste AS (
    UPDATE public.production_waste t
       SET rs1a_kg  = CASE WHEN o.patch ? 'rs1a_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'rs1a_kg', '')::numeric, t.rs1a_kg)
                           ELSE t.rs1a_kg END,
           rs1b_kg  = CASE WHEN o.patch ? 'rs1b_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'rs1b_kg', '')::numeric, t.rs1b_kg)
                           ELSE t.rs1b_kg END,
           bf_kg    = CASE WHEN o.patch ? 'bf_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'bf_kg', '')::numeric, t.bf_kg)
                           ELSE t.bf_kg END,
           rs23_kg  = CASE WHEN o.patch ? 'rs23_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'rs23_kg', '')::numeric, t.rs23_kg)
                           ELSE t.rs23_kg END,
           rs5_kg   = CASE WHEN o.patch ? 'rs5_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'rs5_kg', '')::numeric, t.rs5_kg)
                           ELSE t.rs5_kg END,
           trml1_kg = CASE WHEN o.patch ? 'trml1_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'trml1_kg', '')::numeric, t.trml1_kg)
                           ELSE t.trml1_kg END,
           trml2_kg = CASE WHEN o.patch ? 'trml2_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'trml2_kg', '')::numeric, t.trml2_kg)
                           ELSE t.trml2_kg END,
           grit_kg  = CASE WHEN o.patch ? 'grit_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'grit_kg', '')::numeric, t.grit_kg)
                           ELSE t.grit_kg END,
           remarks  = CASE WHEN o.patch ? 'remarks'
                           THEN NULLIF(o.patch ->> 'remarks', '')
                           ELSE t.remarks END
      FROM w o
     WHERE o.tbl = 'production_waste'
       AND t.id  = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  ),
  u_elec AS (
    UPDATE public.electricity_readings t
       SET start_kwh        = CASE WHEN o.patch ? 'start_kwh'
                                   THEN COALESCE(NULLIF(o.patch ->> 'start_kwh', '')::numeric, t.start_kwh)
                                   ELSE t.start_kwh END,
           end_kwh          = CASE WHEN o.patch ? 'end_kwh'
                                   THEN COALESCE(NULLIF(o.patch ->> 'end_kwh', '')::numeric, t.end_kwh)
                                   ELSE t.end_kwh END,
           meter_multiplier = CASE WHEN o.patch ? 'meter_multiplier'
                                   THEN COALESCE(NULLIF(o.patch ->> 'meter_multiplier', '')::numeric, t.meter_multiplier)
                                   ELSE t.meter_multiplier END,
           remarks          = CASE WHEN o.patch ? 'remarks'
                                   THEN NULLIF(o.patch ->> 'remarks', '')
                                   ELSE t.remarks END
      FROM w o
     WHERE o.tbl = 'electricity_readings'
       AND t.id  = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  ),
  u_trucks AS (
    UPDATE public.truck_readings t
       SET start_km    = CASE WHEN o.patch ? 'start_km'
                              THEN COALESCE(NULLIF(o.patch ->> 'start_km', '')::numeric, t.start_km)
                              ELSE t.start_km END,
           end_km      = CASE WHEN o.patch ? 'end_km'
                              THEN COALESCE(NULLIF(o.patch ->> 'end_km', '')::numeric, t.end_km)
                              ELSE t.end_km END,
           fuel_liters = CASE WHEN o.patch ? 'fuel_liters'
                              THEN NULLIF(o.patch ->> 'fuel_liters', '')::numeric
                              ELSE t.fuel_liters END,
           remarks     = CASE WHEN o.patch ? 'remarks'
                              THEN NULLIF(o.patch ->> 'remarks', '')
                              ELSE t.remarks END
      FROM w o
     WHERE o.tbl = 'truck_readings'
       AND t.id  = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  ),
  done AS (
    SELECT 'production_runs'::text AS tbl, id FROM u_runs
    UNION ALL SELECT 'production_downtime',  id FROM u_downtime
    UNION ALL SELECT 'production_waste',     id FROM u_waste
    UNION ALL SELECT 'electricity_readings', id FROM u_elec
    UNION ALL SELECT 'truck_readings',       id FROM u_trucks
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'table',   o.tbl,
           'id',      o.id,
           'outcome', CASE
             WHEN d.id IS NOT NULL THEN 'applied'
             WHEN EXISTS (SELECT 1 FROM bad b WHERE b.tbl = o.tbl AND b.id = o.id)
               THEN 'unsupported_field'
             WHEN o.patch = '{}'::jsonb THEN 'empty_patch'
             WHEN s.id IS NULL THEN 'missing'
             WHEN s.human_edited_at IS NOT NULL THEN 'human_edited'
             ELSE 'not_applied'
           END
         ) ORDER BY o.tbl, o.id), '[]'::jsonb)
    INTO v_result
    FROM ops o
    LEFT JOIN done d ON d.tbl = o.tbl AND d.id = o.id
    LEFT JOIN snap s ON s.tbl = o.tbl AND s.id = o.id;

  RETURN v_result;
END
$fn$;

COMMENT ON FUNCTION public.fn_apply_production_upstream(jsonb) IS
  'The sync worker''s ONLY update path into the production fact tables. Applies {table,id,patch} ops, re-checking human_edited_at IS NULL IN THE SAME STATEMENT AS EACH WRITE, so a row a human edited in the app is never overwritten. Never inserts, never deletes. Returns [{table,id,outcome}] with outcome applied|human_edited|missing|empty_patch|unsupported_field.';

REVOKE EXECUTE ON FUNCTION public.fn_apply_production_upstream(jsonb) FROM public;
REVOKE EXECUTE ON FUNCTION public.fn_apply_production_upstream(jsonb) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_apply_production_upstream(jsonb) TO service_role;

-- ===========================================================================
-- 4. fn_release_production_rows — the way BACK
-- ===========================================================================
--
-- Clears the latch so the row follows MC's/Ivy's workbook again. Without this,
-- ownership only ratchets one way and the production data slowly freezes.
--
-- The guard lives in the UPDATE's own WHERE (`human_edited_at IS NOT NULL`), so
-- releasing a row nobody claimed writes nothing and reports it as skipped. The table
-- name is dynamic, but only after an exact-match allowlist check, and it is interpolated
-- with %I; the ids are bound, never interpolated.
--
--   returns { ok, table, released[], released_count, skipped[], skipped_count }

CREATE OR REPLACE FUNCTION public.fn_release_production_rows(
  p_table text,
  p_ids   uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_released uuid[];
BEGIN
  IF p_table IS NULL OR p_table NOT IN (
       'production_shifts', 'production_runs', 'production_downtime',
       'production_waste', 'electricity_readings', 'truck_readings') THEN
    RAISE EXCEPTION 'fn_release_production_rows: % is not a production fact table',
      COALESCE(p_table, '(null)');
  END IF;

  IF p_ids IS NULL OR COALESCE(array_length(p_ids, 1), 0) = 0 THEN
    RETURN jsonb_build_object(
      'ok', true, 'table', p_table,
      'released', '[]'::jsonb, 'released_count', 0,
      'skipped', '[]'::jsonb, 'skipped_count', 0);
  END IF;

  -- Transaction-local: tells fn_stamp_human_edit that THIS statement is the sanctioned
  -- release, and is gone by commit. Nothing else in the codebase ever sets it.
  PERFORM set_config('blackwood.release_human_edit', 'on', true);

  EXECUTE format(
    'WITH r AS (
       UPDATE public.%I t
          SET human_edited_at = NULL, human_edited_by = NULL
        WHERE t.id = ANY($1) AND t.human_edited_at IS NOT NULL
       RETURNING t.id)
     SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) FROM r', p_table)
  INTO v_released
  USING p_ids;

  PERFORM set_config('blackwood.release_human_edit', 'off', true);

  RETURN jsonb_build_object(
    'ok', true,
    'table', p_table,
    'released', to_jsonb(v_released),
    'released_count', COALESCE(array_length(v_released, 1), 0),
    'skipped', to_jsonb(ARRAY(
      SELECT x FROM unnest(p_ids) AS x WHERE NOT (x = ANY(v_released)))),
    'skipped_count', (
      SELECT count(*) FROM unnest(p_ids) AS x WHERE NOT (x = ANY(v_released))));
END
$fn$;

COMMENT ON FUNCTION public.fn_release_production_rows(text, uuid[]) IS
  'Hands human-edited production rows back to the sync by clearing human_edited_at/by. The ONLY sanctioned way to clear the latch (it holds the transaction-local GUC blackwood.release_human_edit so fn_stamp_human_edit does not immediately re-stamp). Guard is in the UPDATE''s own WHERE; a row nobody claimed is reported as skipped, not written. Returns {ok, table, released[], released_count, skipped[], skipped_count}.';

REVOKE EXECUTE ON FUNCTION public.fn_release_production_rows(text, uuid[]) FROM public;
REVOKE EXECUTE ON FUNCTION public.fn_release_production_rows(text, uuid[]) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_release_production_rows(text, uuid[]) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_release_production_rows(text, uuid[]) TO service_role;

-- ===========================================================================
-- 5. view_production_human_edited — the read model
-- ===========================================================================
--
-- One row per production record a human owns, across all six tables, carrying enough
-- identity to name it in a UI ("2026-06-30 - JUNE-26 - Morning - runs") and the id the
-- release RPC needs. security_invoker, so it inherits each base table's RLS.

CREATE OR REPLACE VIEW public.view_production_human_edited
WITH (security_invoker = true) AS
SELECT
  'production_shifts'::text AS table_name,
  'shift'::text             AS section,
  s.id                      AS record_id,
  s.transaction_date,
  s.production_batch,
  s.shift,
  NULL::text                AS meter,
  NULL::text                AS plate_no,
  s.human_edited_at,
  s.human_edited_by,
  p.display_name            AS human_edited_by_name
FROM public.production_shifts s
LEFT JOIN public.profiles p ON p.id = s.human_edited_by
WHERE s.human_edited_at IS NOT NULL

UNION ALL
SELECT 'production_runs', 'runs', r.id, s.transaction_date, s.production_batch, s.shift,
       NULL::text, NULL::text, r.human_edited_at, r.human_edited_by, p.display_name
FROM public.production_runs r
JOIN public.production_shifts s ON s.id = r.shift_id
LEFT JOIN public.profiles p ON p.id = r.human_edited_by
WHERE r.human_edited_at IS NOT NULL

UNION ALL
SELECT 'production_downtime', 'downtime', d.id, s.transaction_date, s.production_batch, s.shift,
       NULL::text, NULL::text, d.human_edited_at, d.human_edited_by, p.display_name
FROM public.production_downtime d
JOIN public.production_shifts s ON s.id = d.shift_id
LEFT JOIN public.profiles p ON p.id = d.human_edited_by
WHERE d.human_edited_at IS NOT NULL

UNION ALL
SELECT 'production_waste', 'waste', w.id, s.transaction_date, s.production_batch, s.shift,
       NULL::text, NULL::text, w.human_edited_at, w.human_edited_by, p.display_name
FROM public.production_waste w
JOIN public.production_shifts s ON s.id = w.shift_id
LEFT JOIN public.profiles p ON p.id = w.human_edited_by
WHERE w.human_edited_at IS NOT NULL

UNION ALL
SELECT 'electricity_readings', 'electricity', e.id, e.reading_date, NULL::text, NULL::text,
       e.meter, NULL::text, e.human_edited_at, e.human_edited_by, p.display_name
FROM public.electricity_readings e
LEFT JOIN public.profiles p ON p.id = e.human_edited_by
WHERE e.human_edited_at IS NOT NULL

UNION ALL
SELECT 'truck_readings', 'trucks', k.id, k.reading_date, NULL::text, NULL::text,
       NULL::text, k.plate_no, k.human_edited_at, k.human_edited_by, p.display_name
FROM public.truck_readings k
LEFT JOIN public.profiles p ON p.id = k.human_edited_by
WHERE k.human_edited_at IS NOT NULL;

COMMENT ON VIEW public.view_production_human_edited IS
  'Every production fact row a human currently owns (human_edited_at IS NOT NULL), across all six tables, with its date/batch/shift or meter/plate identity and who claimed it. The sync will not update any row listed here; fn_release_production_rows(table, ids) hands one back.';

-- ===========================================================================
-- 6. Grants — single-org posture (CLAUDE.md RLS section)
-- ===========================================================================
-- The six base tables already carry permissive authenticated policies + grants; the new
-- columns ride the existing table-level grants. Only the view needs its own.

GRANT SELECT ON public.view_production_human_edited TO authenticated, service_role;
REVOKE ALL   ON public.view_production_human_edited FROM anon;
