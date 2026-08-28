-- ARCHIVE (migration A of two) — the production-schedule feature's grave.
--
-- Renzo is removing the in-app production-schedule feature. His hard requirement is
-- that NOTHING becomes unrecoverable. This migration takes the copy; a SECOND
-- migration (…_drop_production_schedule.sql) does the removal and is applied only
-- after the app and the sync worker have stopped referencing these objects.
--
-- THIS MIGRATION DROPS NOTHING AND CHANGES NO LIVE OBJECT. It is additive.
--
-- What it creates:
--   graveyard                                — a locked-down schema, no client grants
--   graveyard.production_schedule_20260827   — structural copy + ALL rows
--   graveyard.prod_schedule_ddl_20260827     — the exact restorable DDL of every
--                                              object migration B will drop OR rewrite
--
-- The same DDL is also committed at _archived/prod-schedule-v1/db/RESTORE.sql, with
-- a header explaining the restore order. The two are generated from ONE source, so
-- they cannot disagree.
--
-- Note the last two DDL rows: view_digest_stream_status and
-- view_digest_stream_freshness are SHARED and SURVIVE the removal — they read
-- production_schedule only for missed_working_days. Their PRE-REWRITE definitions are
-- archived so migration B's rewrite of that term is reversible too.

-- ---------------------------------------------------------------- --
-- 1. The vault
-- ---------------------------------------------------------------- --
CREATE SCHEMA IF NOT EXISTS graveyard;

COMMENT ON SCHEMA graveyard IS
  'Cold storage for removed features. Rows and DDL only — nothing in here is ever read by the app or the sync worker, and no client role holds any privilege on it. Deleting anything from it is always a separate, explicit decision.';

-- No client role needs this schema. Revoke explicitly rather than relying on the
-- absence of a default ACL: the "cenapro" schema taught us that a default ACL can
-- silently hand anon a SELECT on every new relation.
REVOKE ALL ON SCHEMA graveyard FROM PUBLIC;
REVOKE ALL ON SCHEMA graveyard FROM anon, authenticated, service_role;

-- ---------------------------------------------------------------- --
-- 2. The rows
-- ---------------------------------------------------------------- --
CREATE TABLE IF NOT EXISTS graveyard.production_schedule_20260827
  (LIKE public.production_schedule INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES INCLUDING COMMENTS);

COMMENT ON TABLE graveyard.production_schedule_20260827 IS
  'Verbatim copy of public.production_schedule taken 2026-08-28, before the feature was removed. Column order is identical to the original, so "INSERT INTO public.production_schedule SELECT * FROM this" restores it exactly. The FK to profiles is deliberately NOT copied — an archive must not be able to lose rows because a profile was deleted.';

INSERT INTO graveyard.production_schedule_20260827
SELECT * FROM public.production_schedule
ON CONFLICT (plan_date) DO NOTHING;

-- ---------------------------------------------------------------- --
-- 3. The DDL
-- ---------------------------------------------------------------- --
CREATE TABLE IF NOT EXISTS graveyard.prod_schedule_ddl_20260827 (
  object_name text PRIMARY KEY,
  object_kind text NOT NULL CHECK (object_kind IN ('table', 'view', 'function', 'trigger')),
  ddl         text NOT NULL CHECK (btrim(ddl) <> ''),
  note        text
);

COMMENT ON TABLE graveyard.prod_schedule_ddl_20260827 IS
  'The exact, replayable DDL of every object the production-schedule removal drops or rewrites — table, views, functions, their grants, policies and comments. Mirrored at _archived/prod-schedule-v1/db/RESTORE.sql, which also carries the restore ORDER (the table must come back before anything that references it).';

INSERT INTO graveyard.prod_schedule_ddl_20260827 (object_name, object_kind, ddl, note)
VALUES (
  'public.production_schedule',
  'table',
  $ARCHIVE_DDL$-- ============================================================
-- public.production_schedule — the daily production PLAN table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.production_schedule (
  plan_date        date        NOT NULL,
  year             integer     NOT NULL,
  month            integer     NOT NULL,
  dow              text,
  shifts           integer     NOT NULL DEFAULT 0,
  setup            text,
  projected_tons   numeric,
  grades           jsonb,
  remarks          text,
  source           text        NOT NULL DEFAULT 'gsheet:PROD SCHED'::text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  owner            text        NOT NULL DEFAULT 'gsheet'::text,
  source_rev       text,
  pending_upstream jsonb,
  row_version      integer     NOT NULL DEFAULT 1,
  human_edited_at  timestamptz,
  human_edited_by  uuid,
  CONSTRAINT production_schedule_pkey PRIMARY KEY (plan_date),
  CONSTRAINT production_schedule_owner_check
    CHECK ((owner = ANY (ARRAY['joseph'::text, 'gsheet'::text, 'human'::text, 'actual'::text]))),
  CONSTRAINT production_schedule_human_edited_by_fkey
    FOREIGN KEY (human_edited_by) REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_production_schedule_year_month
  ON public.production_schedule USING btree (year, month);
CREATE INDEX IF NOT EXISTS idx_production_schedule_pending_upstream
  ON public.production_schedule USING btree (plan_date) WHERE (pending_upstream IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_production_schedule_owner
  ON public.production_schedule USING btree (owner);

ALTER TABLE public.production_schedule ENABLE ROW LEVEL SECURITY;

-- NOTE the shape: authenticated may SELECT and UPDATE, but there is deliberately
-- NO insert and NO delete policy. Days are created by the sync, never by a person.
CREATE POLICY production_schedule_select_authenticated
  ON public.production_schedule FOR SELECT TO authenticated USING (true);
CREATE POLICY production_schedule_update_authenticated
  ON public.production_schedule FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, UPDATE ON public.production_schedule TO authenticated;
GRANT ALL    ON public.production_schedule TO service_role;

COMMENT ON TABLE public.production_schedule IS
  'Daily production PLAN sourced from the Google Sheet "PROD SCHED" tab (one row per calendar day). Feeds the Home Digest operational-day states + plant-status + week plan. Written by the sync worker / scripts/sync-prod-schedule.ts (service role, replace-by-plan_date). Not price data — no gating.';
COMMENT ON COLUMN public.production_schedule.shifts IS
  '0 = planned rest/holiday, 1 = normal shift, 2 = double shift';
COMMENT ON COLUMN public.production_schedule.projected_tons IS
  'Planned TTL tons for the day (sheet col S "TTL KG", which is actually tons).';
COMMENT ON COLUMN public.production_schedule.grades IS
  'Per-grade projected tons jsonb, zeros/nulls dropped, e.g. {"3X50":21,"4X8":5}.';
COMMENT ON COLUMN public.production_schedule.owner IS
  'Who owns this day: joseph (following the email) | gsheet (Renzo baseline) | human (edited in-app — the sync will NOT write it) | actual (reserved; reported days are frozen via production_shifts, see view_production_schedule_state.effective_owner).';
COMMENT ON COLUMN public.production_schedule.source_rev IS
  'The upstream revision this row was derived from: "<source>|<messageTag>|<dayHash12>". source = the provenance tag also in `source`; messageTag = "gm<threadId>.<uid>" of Joseph''s email (Gmail''s message identity — lib/gmail.ts FetchedEmail exposes no RFC-822 Message-ID) or "-" for Renzo-only days; dayHash12 = first 12 hex of sha256 over THAT day''s canonical plan payload. Equality means "the sync has already applied exactly this" -> write nothing.';
COMMENT ON COLUMN public.production_schedule.pending_upstream IS
  'Joseph''s WITHHELD proposed value for a human-owned day: {source_rev, proposed{shifts,setup,projected_tons,grades,remarks,source}, changed_fields[], observed_at}. Non-null = an unarbitrated conflict; see view_production_schedule_conflicts.';
COMMENT ON COLUMN public.production_schedule.row_version IS
  'Optimistic-concurrency token. EVERY write bumps it, and every write is conditional on the caller''s expected value IN THE SAME STATEMENT — never read-then-write.';
COMMENT ON COLUMN public.production_schedule.human_edited_at IS
  'When the day was last edited in-app (set by fn_save_schedule_day).';
COMMENT ON COLUMN public.production_schedule.human_edited_by IS
  'Who last edited the day in-app (profiles.id; set by fn_save_schedule_day from auth.uid()).';

-- Restore the 273 archived rows (PK plan_date 2026-01-01 .. 2026-09-30):
--   INSERT INTO public.production_schedule
--   SELECT * FROM graveyard.production_schedule_20260827;
-- The column order of the archive table is identical to the CREATE TABLE above,
-- because it was made with CREATE TABLE ... (LIKE public.production_schedule ...).$ARCHIVE_DDL$,
  'The PLAN table itself: 17 columns, PK plan_date, 3 secondary indexes, the owner CHECK, the profiles FK, RLS on with SELECT+UPDATE policies for authenticated (deliberately NO insert/delete policy), grants, and all 10 comments. 273 rows live in graveyard.production_schedule_20260827.'
)
ON CONFLICT (object_name) DO UPDATE
  SET object_kind = EXCLUDED.object_kind,
      ddl         = EXCLUDED.ddl,
      note        = EXCLUDED.note;

INSERT INTO graveyard.prod_schedule_ddl_20260827 (object_name, object_kind, ddl, note)
VALUES (
  'public.view_production_schedule_state',
  'view',
  $ARCHIVE_DDL$-- ============================================================
-- public.view_production_schedule_state
-- ============================================================
CREATE OR REPLACE VIEW public.view_production_schedule_state
WITH (security_invoker = true) AS
 SELECT plan_date,
    year,
    month,
    dow,
    shifts,
    setup,
    projected_tons,
    grades,
    remarks,
    source,
    owner,
    source_rev,
    row_version,
    pending_upstream,
    pending_upstream ->> 'source_rev'::text AS pending_source_rev,
    pending_upstream IS NOT NULL AS has_pending_upstream,
    (EXISTS ( SELECT 1
           FROM production_shifts ps
          WHERE ps.transaction_date = s.plan_date)) AS is_reported,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM production_shifts ps
              WHERE ps.transaction_date = s.plan_date)) THEN 'actual'::text
            ELSE owner
        END AS effective_owner,
    human_edited_at,
    human_edited_by,
    updated_at,
    owner = 'human'::text AND (EXISTS ( SELECT 1
           FROM production_shifts ps
          WHERE ps.transaction_date = s.plan_date)) AS human_edit_after_report
   FROM production_schedule s;

GRANT SELECT ON public.view_production_schedule_state TO authenticated, service_role;

COMMENT ON VIEW public.view_production_schedule_state IS
  'Ownership-aware read model for production_schedule. is_reported = a production_shifts row exists for the date — the SYNC''s actuals freeze, and since 2026-07-30 purely INFORMATIONAL for the human editor (a reported day IS humanly editable; see fn_save_schedule_day). effective_owner = "actual" when reported, else the stored owner. human_edit_after_report = reported AND owner=human, i.e. the operator corrected the plan after the fact — the signal effective_owner masks. Read by the sync worker (service_role) to plan a conditional refresh, and by the app.';$ARCHIVE_DDL$,
  'Ownership-aware read model. Schedule-only — dropped by migration B. Restore the table first.'
)
ON CONFLICT (object_name) DO UPDATE
  SET object_kind = EXCLUDED.object_kind,
      ddl         = EXCLUDED.ddl,
      note        = EXCLUDED.note;

INSERT INTO graveyard.prod_schedule_ddl_20260827 (object_name, object_kind, ddl, note)
VALUES (
  'public.view_production_schedule_conflicts',
  'view',
  $ARCHIVE_DDL$-- ============================================================
-- public.view_production_schedule_conflicts
-- ============================================================
CREATE OR REPLACE VIEW public.view_production_schedule_conflicts
WITH (security_invoker = true) AS
 SELECT plan_date,
    owner,
    row_version,
    human_edited_at,
    human_edited_by,
    pending_upstream ->> 'source_rev'::text AS pending_source_rev,
    pending_upstream ->> 'observed_at'::text AS observed_at,
    pending_upstream -> 'proposed'::text AS proposed,
    pending_upstream -> 'changed_fields'::text AS changed_fields,
    jsonb_build_object('shifts', shifts, 'setup', setup, 'projected_tons', projected_tons, 'grades', grades, 'remarks', remarks, 'source', source) AS current_values,
    updated_at
   FROM production_schedule s
  WHERE pending_upstream IS NOT NULL;

GRANT SELECT ON public.view_production_schedule_conflicts TO authenticated, service_role;

COMMENT ON VIEW public.view_production_schedule_conflicts IS
  'Days where the sync withheld an upstream (Joseph) value because a human owns the day. One row per unarbitrated conflict, carrying BOTH sides. The Home Digest reads the COUNT from here (select plan_date, {count:exact, head:true}); the schedule page reads the rows.';$ARCHIVE_DDL$,
  'One row per unarbitrated pending upstream. Schedule-only — dropped by migration B. Restore the table first. 24 rows had a non-null pending_upstream at archive time.'
)
ON CONFLICT (object_name) DO UPDATE
  SET object_kind = EXCLUDED.object_kind,
      ddl         = EXCLUDED.ddl,
      note        = EXCLUDED.note;

INSERT INTO graveyard.prod_schedule_ddl_20260827 (object_name, object_kind, ddl, note)
VALUES (
  'public.fn_apply_schedule_upstream(jsonb)',
  'function',
  $ARCHIVE_DDL$-- ============================================================
-- public.fn_apply_schedule_upstream(jsonb)
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_apply_schedule_upstream(p_ops jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result   jsonb;
  v_distinct integer;
BEGIN
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' THEN
    RAISE EXCEPTION 'fn_apply_schedule_upstream: p_ops must be a JSON array (got %)',
      COALESCE(jsonb_typeof(p_ops), 'null');
  END IF;

  IF jsonb_array_length(p_ops) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) AS o
              WHERE NULLIF(o ->> 'plan_date', '') IS NULL) THEN
    RAISE EXCEPTION 'fn_apply_schedule_upstream: plan_date is required on every op';
  END IF;

  SELECT count(DISTINCT (o ->> 'plan_date')::date) INTO v_distinct
    FROM jsonb_array_elements(p_ops) AS o;
  IF v_distinct <> jsonb_array_length(p_ops) THEN
    RAISE EXCEPTION 'fn_apply_schedule_upstream: duplicate plan_date in p_ops (% distinct of %)',
      v_distinct, jsonb_array_length(p_ops);
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) AS o
              WHERE o ->> 'action' IS DISTINCT FROM 'insert'
                AND o ->> 'action' IS DISTINCT FROM 'apply'
                AND o ->> 'action' IS DISTINCT FROM 'reclaim'
                AND o ->> 'action' IS DISTINCT FROM 'park') THEN
    RAISE EXCEPTION 'fn_apply_schedule_upstream: unknown action in p_ops';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) AS o
              WHERE COALESCE(NULLIF(o ->> 'new_owner', ''), 'gsheet')
                    NOT IN ('joseph', 'gsheet', 'human', 'actual')) THEN
    RAISE EXCEPTION 'fn_apply_schedule_upstream: unknown new_owner in p_ops';
  END IF;

  WITH ops AS (
    SELECT
      (o ->> 'plan_date')::date                         AS plan_date,
       o ->> 'action'                                   AS action,
      NULLIF(o ->> 'expected_row_version', '')::int     AS expected_row_version,
      NULLIF(o ->> 'expected_owner', '')                AS expected_owner,
      NULLIF(o ->> 'source_rev', '')                    AS source_rev,
      COALESCE(NULLIF(o ->> 'new_owner', ''), 'gsheet') AS new_owner,
       o -> 'row'                                       AS row_json,
       o -> 'pending'                                   AS pending
    FROM jsonb_array_elements(p_ops) AS o
  ),
  ins AS (
    INSERT INTO public.production_schedule
      (plan_date, year, month, dow, shifts, setup, projected_tons, grades, remarks,
       source, owner, source_rev, row_version, updated_at)
    SELECT
      o.plan_date,
      (o.row_json ->> 'year')::int,
      (o.row_json ->> 'month')::int,
      NULLIF(o.row_json ->> 'dow', ''),
      COALESCE((o.row_json ->> 'shifts')::int, 0),
      NULLIF(o.row_json ->> 'setup', ''),
      NULLIF(o.row_json ->> 'projected_tons', '')::numeric,
      CASE WHEN jsonb_typeof(o.row_json -> 'grades') = 'object'
           THEN o.row_json -> 'grades' END,
      NULLIF(o.row_json ->> 'remarks', ''),
      COALESCE(NULLIF(o.row_json ->> 'source', ''), 'gsheet:PROD SCHED'),
      o.new_owner,
      o.source_rev,
      1,
      now()
    FROM ops o
    WHERE o.action = 'insert'
      AND NOT EXISTS (
        SELECT 1 FROM public.production_shifts ps WHERE ps.transaction_date = o.plan_date
      )
    ON CONFLICT (plan_date) DO NOTHING
    RETURNING plan_date
  ),
  upd AS (
    UPDATE public.production_schedule s
       SET year             = COALESCE((o.row_json ->> 'year')::int, s.year),
           month            = COALESCE((o.row_json ->> 'month')::int, s.month),
           dow              = NULLIF(o.row_json ->> 'dow', ''),
           shifts           = COALESCE((o.row_json ->> 'shifts')::int, 0),
           setup            = NULLIF(o.row_json ->> 'setup', ''),
           projected_tons   = NULLIF(o.row_json ->> 'projected_tons', '')::numeric,
           grades           = CASE WHEN jsonb_typeof(o.row_json -> 'grades') = 'object'
                                   THEN o.row_json -> 'grades' END,
           remarks          = NULLIF(o.row_json ->> 'remarks', ''),
           source           = COALESCE(NULLIF(o.row_json ->> 'source', ''), s.source),
           owner            = o.new_owner,
           source_rev       = o.source_rev,
           pending_upstream = NULL,
           row_version      = s.row_version + 1,
           updated_at       = now()
      FROM ops o
     WHERE s.plan_date   = o.plan_date
       AND o.action      IN ('apply', 'reclaim')
       AND s.row_version = o.expected_row_version
       AND s.owner       = o.expected_owner
       AND NOT EXISTS (
         SELECT 1 FROM public.production_shifts ps WHERE ps.transaction_date = s.plan_date
       )
    RETURNING s.plan_date, o.action
  ),
  prk AS (
    UPDATE public.production_schedule s
       SET pending_upstream = o.pending,
           row_version      = s.row_version + 1,
           updated_at       = now()
      FROM ops o
     WHERE s.plan_date   = o.plan_date
       AND o.action      = 'park'
       AND s.row_version = o.expected_row_version
       AND s.owner       = 'human'
       AND NOT EXISTS (
         SELECT 1 FROM public.production_shifts ps WHERE ps.transaction_date = s.plan_date
       )
    RETURNING s.plan_date
  ),
  done AS (
    SELECT plan_date, 'inserted'::text AS outcome FROM ins
    UNION ALL
    SELECT plan_date, CASE WHEN action = 'apply' THEN 'applied' ELSE 'reclaimed' END
      FROM upd
    UNION ALL
    SELECT plan_date, 'parked'::text FROM prk
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'plan_date', o.plan_date,
           'action',    o.action,
           'outcome',   COALESCE(
             d.outcome,
             CASE
               WHEN EXISTS (SELECT 1 FROM public.production_shifts ps
                             WHERE ps.transaction_date = o.plan_date) THEN 'frozen'
               WHEN o.action = 'insert'                               THEN 'exists'
               WHEN NOT EXISTS (SELECT 1 FROM public.production_schedule s
                                 WHERE s.plan_date = o.plan_date)     THEN 'missing'
               ELSE 'version_conflict'
             END)
         ) ORDER BY o.plan_date), '[]'::jsonb)
    INTO v_result
    FROM ops o
    LEFT JOIN done d ON d.plan_date = o.plan_date;

  RETURN v_result;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_apply_schedule_upstream(jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_apply_schedule_upstream(jsonb) TO service_role;

COMMENT ON FUNCTION public.fn_apply_schedule_upstream(jsonb) IS
  'ATOMIC conditional writer for production_schedule. Applies the sync worker''s planned ops (insert/apply/reclaim/park), re-checking row_version + owner + the production_shifts actuals freeze IN THE SAME STATEMENT AS EACH WRITE. Never deletes; days absent from p_ops are untouched. Returns [{plan_date, action, outcome}].';$ARCHIVE_DDL$,
  'The sync worker''s ATOMIC conditional writer. service_role EXECUTE only. Dropped by migration B.'
)
ON CONFLICT (object_name) DO UPDATE
  SET object_kind = EXCLUDED.object_kind,
      ddl         = EXCLUDED.ddl,
      note        = EXCLUDED.note;

INSERT INTO graveyard.prod_schedule_ddl_20260827 (object_name, object_kind, ddl, note)
VALUES (
  'public.fn_save_schedule_day(date, integer, jsonb, boolean)',
  'function',
  $ARCHIVE_DDL$-- ============================================================
-- public.fn_save_schedule_day(date, integer, jsonb, boolean)
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_save_schedule_day(p_plan_date date, p_expected_row_version integer, p_patch jsonb DEFAULT '{}'::jsonb, p_clear_pending boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_version integer;
BEGIN
  IF p_plan_date IS NULL THEN
    RAISE EXCEPTION 'fn_save_schedule_day: p_plan_date is required';
  END IF;
  IF p_expected_row_version IS NULL THEN
    RAISE EXCEPTION 'fn_save_schedule_day: p_expected_row_version is required';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'fn_save_schedule_day: p_patch must be a JSON object (got %)',
      COALESCE(jsonb_typeof(p_patch), 'null');
  END IF;

  -- NOTE: no production_shifts guard here, on purpose. A reported day is editable BY A
  -- HUMAN. The sync's freeze lives in fn_apply_schedule_upstream and is untouched.
  UPDATE public.production_schedule s
     SET shifts = CASE WHEN p_patch ? 'shifts'
                       THEN COALESCE((p_patch ->> 'shifts')::int, 0) ELSE s.shifts END,
         setup = CASE WHEN p_patch ? 'setup'
                      THEN NULLIF(p_patch ->> 'setup', '') ELSE s.setup END,
         projected_tons = CASE WHEN p_patch ? 'projected_tons'
                               THEN NULLIF(p_patch ->> 'projected_tons', '')::numeric
                               ELSE s.projected_tons END,
         grades = CASE WHEN p_patch ? 'grades'
                       THEN CASE WHEN jsonb_typeof(p_patch -> 'grades') = 'object'
                                 THEN p_patch -> 'grades' END
                       ELSE s.grades END,
         remarks = CASE WHEN p_patch ? 'remarks'
                        THEN NULLIF(p_patch ->> 'remarks', '') ELSE s.remarks END,
         owner            = 'human',
         human_edited_at  = now(),
         human_edited_by  = auth.uid(),
         pending_upstream = CASE WHEN p_clear_pending THEN NULL ELSE s.pending_upstream END,
         row_version      = s.row_version + 1,
         updated_at       = now()
   WHERE s.plan_date   = p_plan_date
     AND s.row_version = p_expected_row_version
  RETURNING s.row_version INTO v_new_version;

  IF v_new_version IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'saved', 'row_version', v_new_version);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.production_schedule s
                  WHERE s.plan_date = p_plan_date) THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'missing', 'row_version', NULL);
  END IF;
  RETURN jsonb_build_object(
    'ok', false, 'outcome', 'version_conflict',
    'row_version', (SELECT row_version FROM public.production_schedule
                     WHERE plan_date = p_plan_date));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) IS
  'In-app write path for production_schedule. Flips owner to human, stamps human_edited_at/by, and bumps row_version — conditional on p_expected_row_version IN THE UPDATE''S OWN WHERE. As of 2026-07-30 it has NO actuals freeze: a REPORTED day IS editable by a human (correcting a past plan is legitimate). The sync''s freeze is unchanged and lives in fn_apply_schedule_upstream. Returns {ok, outcome, row_version}, outcome in saved|missing|version_conflict — ''frozen'' can no longer be returned from here.';$ARCHIVE_DDL$,
  'The in-app write path. authenticated + service_role EXECUTE. Dropped by migration B.'
)
ON CONFLICT (object_name) DO UPDATE
  SET object_kind = EXCLUDED.object_kind,
      ddl         = EXCLUDED.ddl,
      note        = EXCLUDED.note;

INSERT INTO graveyard.prod_schedule_ddl_20260827 (object_name, object_kind, ddl, note)
VALUES (
  'public.fn_release_schedule_day(date, integer)',
  'function',
  $ARCHIVE_DDL$-- ============================================================
-- public.fn_release_schedule_day(date, integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_release_schedule_day(p_plan_date date, p_expected_row_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_version integer;
BEGIN
  IF p_plan_date IS NULL THEN
    RAISE EXCEPTION 'fn_release_schedule_day: p_plan_date is required';
  END IF;
  IF p_expected_row_version IS NULL THEN
    RAISE EXCEPTION 'fn_release_schedule_day: p_expected_row_version is required';
  END IF;

  -- Two guards now, not three: version + ownership. The actuals freeze is gone for the
  -- same reason it is gone from fn_save_schedule_day.
  UPDATE public.production_schedule s
     SET owner            = CASE WHEN s.source LIKE 'joseph:%' THEN 'joseph'
                                 ELSE 'gsheet' END,
         source_rev       = NULL,
         pending_upstream = NULL,
         human_edited_at  = NULL,
         human_edited_by  = NULL,
         row_version      = s.row_version + 1,
         updated_at       = now()
   WHERE s.plan_date   = p_plan_date
     AND s.row_version = p_expected_row_version
     AND s.owner       = 'human'
  RETURNING s.row_version INTO v_new_version;

  IF v_new_version IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'reclaimed', 'row_version', v_new_version);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.production_schedule s
                  WHERE s.plan_date = p_plan_date) THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'missing', 'row_version', NULL);
  END IF;
  RETURN jsonb_build_object(
    'ok', false, 'outcome', 'version_conflict',
    'row_version', (SELECT row_version FROM public.production_schedule
                     WHERE plan_date = p_plan_date));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_release_schedule_day(date, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_release_schedule_day(date, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_release_schedule_day(date, integer) IS
  'In-app REVERT path for production_schedule: hands a human-owned day back to the sync. Restores owner from the source prefix (joseph:% -> joseph, else gsheet), nulls source_rev, pending_upstream and human_edited_at/by, bumps row_version; conditional on p_expected_row_version AND owner=''human'' IN THE UPDATE''S OWN WHERE. As of 2026-07-30 it has NO actuals freeze, mirroring fn_save_schedule_day — a human who can TAKE a reported day must be able to give it back, and release is inert on a reported day because the sync still cannot write it. Returns {ok, outcome, row_version}, outcome in reclaimed|missing|version_conflict — ''frozen'' can no longer be returned from here.';$ARCHIVE_DDL$,
  'The in-app revert path (hand a human day back to the sync). authenticated + service_role EXECUTE. Dropped by migration B.'
)
ON CONFLICT (object_name) DO UPDATE
  SET object_kind = EXCLUDED.object_kind,
      ddl         = EXCLUDED.ddl,
      note        = EXCLUDED.note;

INSERT INTO graveyard.prod_schedule_ddl_20260827 (object_name, object_kind, ddl, note)
VALUES (
  'public.view_digest_stream_status',
  'view',
  $ARCHIVE_DDL$-- ============================================================
-- public.view_digest_stream_status — THE PRE-REWRITE DEFINITION
--
-- This view SURVIVES the removal; migration B only REWRITES its
-- missed_working_days term to stop reading production_schedule. This block is
-- here so that rewrite is reversible: replaying it restores the schedule-based
-- arithmetic exactly, and it will only work while public.production_schedule
-- exists (restore the table block above first).
--
-- CREATE OR REPLACE, never DROP+CREATE: DROP loses the service_role grant the
-- sync worker's stream-freshness watch depends on (L-044).
-- ============================================================
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
            ELSE ( SELECT count(*)::integer AS count
               FROM production_schedule ps
              WHERE ps.shifts > 0 AND ps.plan_date > agg.through_date AND ps.plan_date < op.operational_date)
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

GRANT SELECT ON public.view_digest_stream_status TO authenticated, service_role;

COMMENT ON VIEW public.view_digest_stream_status IS
  'Lag-aware per-stream reporting status: prev_reported_date, operational_date and missed_working_days (production_schedule days with shifts > 0 STRICTLY between the stream''s latest reported day and the operational date). Owns the ONE definition of "a stream is late". Read by BOTH the Home digest (as authenticated) and the sync worker''s stream-freshness watch (as service_role) -- security_invoker, so BOTH roles need SELECT on this view AND on its whole dependency chain (view_digest_stream_registry, view_digest_stream_reported_days, view_digest_operational_days). Without the service_role half the worker read fails with SQLSTATE 42501 and the freshness watch silently reports nothing.';$ARCHIVE_DDL$,
  'SHARED, SURVIVES. Archived at its PRE-REWRITE definition so migration B''s missed_working_days rewrite is reversible. Depends on production_schedule — replay only after restoring the table.'
)
ON CONFLICT (object_name) DO UPDATE
  SET object_kind = EXCLUDED.object_kind,
      ddl         = EXCLUDED.ddl,
      note        = EXCLUDED.note;

INSERT INTO graveyard.prod_schedule_ddl_20260827 (object_name, object_kind, ddl, note)
VALUES (
  'public.view_digest_stream_freshness',
  'view',
  $ARCHIVE_DDL$-- ============================================================
-- public.view_digest_stream_freshness — THE PRE-REWRITE DEFINITION
--
-- Unchanged by migration B (it is a thin 3-column projection and its column
-- shape does not move), archived only so the pair can be replayed together.
-- Note it holds NO service_role grant, and that is correct: it is a CONSUMER of
-- view_digest_stream_status, not a dependency of it, and the worker never
-- reads it.
-- ============================================================
CREATE OR REPLACE VIEW public.view_digest_stream_freshness
WITH (security_invoker = true) AS
 SELECT stream,
    label,
    through_date
   FROM view_digest_stream_status;

GRANT SELECT ON public.view_digest_stream_freshness TO authenticated;$ARCHIVE_DDL$,
  'SHARED, SURVIVES, and migration B does not change it. Archived so the pair replays together.'
)
ON CONFLICT (object_name) DO UPDATE
  SET object_kind = EXCLUDED.object_kind,
      ddl         = EXCLUDED.ddl,
      note        = EXCLUDED.note;

-- ---------------------------------------------------------------- --
-- 4. Lock the vault
-- ---------------------------------------------------------------- --
REVOKE ALL ON graveyard.production_schedule_20260827 FROM PUBLIC;
REVOKE ALL ON graveyard.production_schedule_20260827 FROM anon, authenticated, service_role;
REVOKE ALL ON graveyard.prod_schedule_ddl_20260827   FROM PUBLIC;
REVOKE ALL ON graveyard.prod_schedule_ddl_20260827   FROM anon, authenticated, service_role;

-- Second, independent lock: RLS on with NO policy at all, so even a future blanket
-- GRANT on the schema still reads nothing. The owner (postgres) is unaffected, which
-- is what makes a restore possible.
ALTER TABLE graveyard.production_schedule_20260827 ENABLE ROW LEVEL SECURITY;
ALTER TABLE graveyard.prod_schedule_ddl_20260827   ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- --
-- 5. Refuse to have archived nothing
-- ---------------------------------------------------------------- --
DO $checks$
DECLARE
  v_live integer;
  v_arch integer;
  v_ddl  integer;
BEGIN
  SELECT count(*) INTO v_live FROM public.production_schedule;
  SELECT count(*) INTO v_arch FROM graveyard.production_schedule_20260827;
  IF v_live <> v_arch THEN
    RAISE EXCEPTION 'archive row count mismatch: live=% archived=%', v_live, v_arch;
  END IF;

  SELECT count(*) INTO v_ddl FROM graveyard.prod_schedule_ddl_20260827;
  IF v_ddl <> 8 THEN
    RAISE EXCEPTION 'expected 8 DDL rows, found %', v_ddl;
  END IF;

  IF EXISTS (SELECT 1 FROM graveyard.prod_schedule_ddl_20260827 WHERE btrim(ddl) = '') THEN
    RAISE EXCEPTION 'an archived DDL entry is empty';
  END IF;

  RAISE NOTICE 'graveyard OK: % schedule rows, % DDL objects', v_arch, v_ddl;
END
$checks$;
