-- production_schedule OWNERSHIP + CONDITIONAL SYNC  (Phase A of the "master plotter",
-- 2026-07-30)
--
-- WHY
-- ---
-- `production_schedule` is today 100% sync-owned: the worker's Stage-3c refresh
-- (`reports/prodSchedule/refresh.ts`) UNCONDITIONALLY upserts EVERY plan_date on EVERY
-- run, re-applying the same Joseph email over and over. The moment the plan becomes
-- editable in-app, that unconditional upsert erases the human's edit on the next sync —
-- the exact silent-overwrite failure mode CLAUDE.md's "Sync Integrity" section forbids
-- ("Disagreements are never auto-resolved — the human arbitrates them in the app").
--
-- Phase A is the safety net: the DB learns WHO owns each day, WHICH upstream revision a
-- row was derived from, and WHERE to park an upstream value it is not allowed to apply.
-- Phase B (not in this migration) adds the in-app editing UI on top.
--
-- OWNERSHIP MODEL — "follow until touched"
-- ----------------------------------------
--   joseph  — following Joseph Go's emailed schedule; the sync updates it freely.
--   gsheet  — Renzo's PROD SCHED baseline, no Joseph coverage; the sync updates it freely.
--   human   — edited in the app. THE SYNC WILL NOT WRITE IT. A differing upstream value is
--             parked in `pending_upstream` and surfaced for arbitration.
--   actual  — production has already been reported for that date; frozen for everyone.
--             DERIVED, not stored: the authoritative signal is "a `production_shifts` row
--             exists for that date", which is always fresh. `view_production_schedule_state`
--             exposes it as `effective_owner`; the enum value is reserved for a future
--             explicit promotion. NOTHING in this migration ever stores 'actual'.
--
-- Editing in-app is what flips ownership to 'human' — there is no separate lock toggle,
-- and lock granularity is the WHOLE DAY (approved decision): any field edit takes the date.
--
-- `owner` is a CHECKed text column, not a PG enum, on purpose: `ALTER TYPE … ADD VALUE`
-- cannot run inside a transaction (so it cannot ship in a normal migration), and this
-- vocabulary is expected to grow in Phase B.

-- ===========================================================================
-- 1. Columns
-- ===========================================================================

ALTER TABLE public.production_schedule
  ADD COLUMN IF NOT EXISTS owner            text,
  ADD COLUMN IF NOT EXISTS source_rev       text,
  ADD COLUMN IF NOT EXISTS pending_upstream jsonb,
  ADD COLUMN IF NOT EXISTS row_version      integer,
  ADD COLUMN IF NOT EXISTS human_edited_at  timestamptz,
  ADD COLUMN IF NOT EXISTS human_edited_by  uuid;

-- Backfill BEFORE the NOT NULLs. Every existing row is sync-written, so its owner is
-- derivable from the provenance already in `source`: 'joseph:REV5' → joseph (91 rows),
-- 'gsheet:PROD SCHED' → gsheet (182 rows). No row is 'human' — there is no in-app write
-- path yet. `source_rev` stays NULL: these rows predate revision stamping, and a NULL rev
-- can never equal an incoming rev, so the first post-migration run re-stamps them once
-- (a full-plan write) and every run after that is a no-op.
UPDATE public.production_schedule
   SET owner = CASE WHEN source LIKE 'joseph:%' THEN 'joseph' ELSE 'gsheet' END
 WHERE owner IS NULL;

UPDATE public.production_schedule SET row_version = 1 WHERE row_version IS NULL;

ALTER TABLE public.production_schedule
  ALTER COLUMN owner       SET DEFAULT 'gsheet',
  ALTER COLUMN owner       SET NOT NULL,
  ALTER COLUMN row_version SET DEFAULT 1,
  ALTER COLUMN row_version SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.production_schedule'::regclass
       AND conname  = 'production_schedule_owner_check'
  ) THEN
    ALTER TABLE public.production_schedule
      ADD CONSTRAINT production_schedule_owner_check
      CHECK (owner IN ('joseph', 'gsheet', 'human', 'actual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.production_schedule'::regclass
       AND conname  = 'production_schedule_human_edited_by_fkey'
  ) THEN
    ALTER TABLE public.production_schedule
      ADD CONSTRAINT production_schedule_human_edited_by_fkey
      FOREIGN KEY (human_edited_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END
$$;

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

-- Partial index: the conflict view and the digest's pending count both scan exactly this.
CREATE INDEX IF NOT EXISTS idx_production_schedule_pending_upstream
  ON public.production_schedule (plan_date)
  WHERE pending_upstream IS NOT NULL;

-- The sync reads state by owner to decide what it may touch.
CREATE INDEX IF NOT EXISTS idx_production_schedule_owner
  ON public.production_schedule (owner);

-- ===========================================================================
-- 2. Read model
-- ===========================================================================

-- The state view the sync worker plans against and the future in-app editor reads.
-- `is_reported` is the AUTHORITATIVE freeze signal (a production_shifts row exists for the
-- date) — always fresh, never a stored flag that can drift. `effective_owner` folds it in.
CREATE OR REPLACE VIEW public.view_production_schedule_state
WITH (security_invoker = true) AS
SELECT
  s.plan_date,
  s.year,
  s.month,
  s.dow,
  s.shifts,
  s.setup,
  s.projected_tons,
  s.grades,
  s.remarks,
  s.source,
  s.owner,
  s.source_rev,
  s.row_version,
  s.pending_upstream,
  (s.pending_upstream ->> 'source_rev')            AS pending_source_rev,
  (s.pending_upstream IS NOT NULL)                 AS has_pending_upstream,
  EXISTS (
    SELECT 1 FROM public.production_shifts ps
     WHERE ps.transaction_date = s.plan_date
  )                                                AS is_reported,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM public.production_shifts ps
       WHERE ps.transaction_date = s.plan_date
    ) THEN 'actual'
    ELSE s.owner
  END                                              AS effective_owner,
  s.human_edited_at,
  s.human_edited_by,
  s.updated_at
FROM public.production_schedule s;

COMMENT ON VIEW public.view_production_schedule_state IS
  'Ownership-aware read model for production_schedule. is_reported = a production_shifts row exists for the date (the authoritative actuals freeze); effective_owner = "actual" when reported, else the stored owner. Read by the sync worker (service_role) to plan a conditional refresh, and by the app.';

-- The pending-conflict feed. ONE row per day whose upstream value was withheld because a
-- human owns the day. THE DIGEST'S PENDING COUNT READS THIS:
--   supabase.from('view_production_schedule_conflicts')
--           .select('plan_date', { count: 'exact', head: true })
-- (head:true -> no rows transferred; the partial index above serves it.)
CREATE OR REPLACE VIEW public.view_production_schedule_conflicts
WITH (security_invoker = true) AS
SELECT
  s.plan_date,
  s.owner,
  s.row_version,
  s.human_edited_at,
  s.human_edited_by,
  (s.pending_upstream ->> 'source_rev')    AS pending_source_rev,
  (s.pending_upstream ->> 'observed_at')   AS observed_at,
  (s.pending_upstream -> 'proposed')       AS proposed,
  (s.pending_upstream -> 'changed_fields') AS changed_fields,
  -- the CURRENT (human-owned) values, so a reviewer sees both sides without a 2nd query
  jsonb_build_object(
    'shifts',         s.shifts,
    'setup',          s.setup,
    'projected_tons', s.projected_tons,
    'grades',         s.grades,
    'remarks',        s.remarks,
    'source',         s.source
  )                                        AS current_values,
  s.updated_at
FROM public.production_schedule s
WHERE s.pending_upstream IS NOT NULL;

COMMENT ON VIEW public.view_production_schedule_conflicts IS
  'Days where the sync withheld an upstream (Joseph) value because a human owns the day. One row per unarbitrated conflict, carrying BOTH sides. The Home Digest reads the COUNT from here (select plan_date, {count:exact, head:true}); the schedule page reads the rows.';

-- ===========================================================================
-- 3. fn_apply_schedule_upstream — the ATOMIC conditional writer
-- ===========================================================================
--
-- The sync worker plans PURELY (workers/sync/src/reports/prodSchedule/plan.ts) against a
-- snapshot read from view_production_schedule_state, then hands the planned operations
-- here. Every write in this function RE-CHECKS its preconditions IN THE SAME STATEMENT:
--
--   * `row_version = expected_row_version`  (optimistic concurrency — a save that landed
--                                            between the snapshot and this call wins;
--                                            our write simply does not match)
--   * `owner        = expected_owner`       (ownership cannot have flipped underneath)
--   * NOT EXISTS a production_shifts row    (actuals freeze — re-checked, never trusted
--                                            from the snapshot)
--
-- All three writes plus the outcome classification are ONE statement (data-modifying
-- CTEs), so there is no read-then-write anywhere: the planner's read is advisory, these
-- guards are the truth. A row that fails a guard is not written and comes back labelled.
--
-- CONTRACT
--   p_ops jsonb — ARRAY of operations (plan_date unique across the array):
--     { plan_date, action, expected_row_version, expected_owner, source_rev, new_owner,
--       row: {year,month,dow,shifts,setup,projected_tons,grades,remarks,source},
--       pending: {...} }
--     action:
--       insert  — the day has no row yet; create it (owner from new_owner).
--       apply   — sync-owned day, upstream changed; overwrite the plan fields.
--       reclaim — human-owned day whose values now EQUAL the upstream (rule 4): clear the
--                 parked value and hand ownership back to the upstream owner.
--       park    — human-owned day whose values DIFFER (rule 3): write ONLY
--                 pending_upstream; the plan fields are untouched.
--   returns jsonb — ARRAY of { plan_date, action, outcome } where outcome is one of
--     'inserted' | 'applied' | 'reclaimed' | 'parked' | 'frozen' | 'version_conflict' |
--     'missing' | 'exists'
--
-- Days ABSENT from p_ops are never touched. Absence is never deletion — this function has
-- no DELETE at all, so the flecon BUG-015 class of bug is structurally impossible here.

CREATE OR REPLACE FUNCTION public.fn_apply_schedule_upstream(p_ops jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
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
  -- (a) INSERT a day that has no row yet. ON CONFLICT DO NOTHING lets a concurrent
  --     creator win rather than clobbering it.
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
  -- (b) APPLY / RECLAIM — overwrite the plan fields. Guards are inline in the WHERE.
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
  -- (c) PARK — write ONLY pending_upstream. The human's plan values stand untouched
  --     until they arbitrate. Same three guards.
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
  -- Classify everything that did NOT get written, so the caller learns WHY. The
  -- EXISTS probes below read the statement's pre-write snapshot, which is exactly
  -- right: anything this statement wrote is already resolved through `done`.
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
$fn$;

COMMENT ON FUNCTION public.fn_apply_schedule_upstream(jsonb) IS
  'ATOMIC conditional writer for production_schedule. Applies the sync worker''s planned ops (insert/apply/reclaim/park), re-checking row_version + owner + the production_shifts actuals freeze IN THE SAME STATEMENT AS EACH WRITE. Never deletes; days absent from p_ops are untouched. Returns [{plan_date, action, outcome}].';

REVOKE EXECUTE ON FUNCTION public.fn_apply_schedule_upstream(jsonb) FROM public;
REVOKE EXECUTE ON FUNCTION public.fn_apply_schedule_upstream(jsonb) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_apply_schedule_upstream(jsonb) TO service_role;

-- ===========================================================================
-- 4. fn_save_schedule_day — the in-app write path (Phase B calls it; built now so the
--    ownership flip and the concurrency guard are testable and cannot be bypassed)
-- ===========================================================================
--
-- Editing in-app IS what flips ownership to 'human'. Whole-day granularity: any field in
-- the patch takes the entire date. The version check lives in the UPDATE's own WHERE, so a
-- save racing the sync (or another operator) is REJECTED, never silently applied.
--
--   p_plan_date            date  — the day to edit (must already exist).
--   p_expected_row_version int   — the version the editor loaded.
--   p_patch                jsonb — any subset of {shifts,setup,projected_tons,grades,remarks}.
--                                  An ABSENT key keeps the stored value; a key explicitly
--                                  set to null clears it.
--   p_clear_pending        bool  — default FALSE. An unrelated edit must NOT silently
--                                  discard Joseph's parked proposal; only an explicit
--                                  arbitration clears it.
--   returns jsonb — {ok, outcome, row_version}, outcome in
--                   'saved' | 'frozen' | 'missing' | 'version_conflict'

CREATE OR REPLACE FUNCTION public.fn_save_schedule_day(
  p_plan_date            date,
  p_expected_row_version integer,
  p_patch                jsonb   DEFAULT '{}'::jsonb,
  p_clear_pending        boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
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
     AND NOT EXISTS (
       SELECT 1 FROM public.production_shifts ps WHERE ps.transaction_date = s.plan_date
     )
  RETURNING s.row_version INTO v_new_version;

  IF v_new_version IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'saved', 'row_version', v_new_version);
  END IF;

  IF EXISTS (SELECT 1 FROM public.production_shifts ps
              WHERE ps.transaction_date = p_plan_date) THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'frozen', 'row_version', NULL);
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
$fn$;

COMMENT ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) IS
  'In-app write path for production_schedule (Phase B). Flips owner to human, stamps human_edited_at/by, and bumps row_version — all conditional on p_expected_row_version and the production_shifts actuals freeze IN THE UPDATE''S OWN WHERE. Returns {ok, outcome, row_version}.';

REVOKE EXECUTE ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) FROM public;
REVOKE EXECUTE ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) TO service_role;

-- ===========================================================================
-- 5. RLS / grants — single-org posture
-- ===========================================================================
-- authenticated = org member = broad read + write; anon = nothing. The server actions +
-- role gates are the enforcement layer, NOT row-level predicates (CLAUDE.md RLS posture).
-- fn_save_schedule_day is SECURITY INVOKER, so `authenticated` needs a real UPDATE grant
-- plus a permissive UPDATE policy for it to work at all.
--
-- INSERT/DELETE stay service-role-only on purpose: the sync creates the calendar, the
-- human edits days that exist. Phase B can widen this if the editor needs to add a day.

DROP POLICY IF EXISTS "production_schedule_update_authenticated" ON public.production_schedule;
CREATE POLICY "production_schedule_update_authenticated"
  ON public.production_schedule
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

GRANT SELECT, UPDATE ON public.production_schedule TO authenticated;
GRANT ALL            ON public.production_schedule TO service_role;
REVOKE ALL           ON public.production_schedule FROM anon;

-- security_invoker views: grant SELECT to the roles that read them. The sync worker uses
-- the service-role key, and RLS bypass is NOT grant bypass — service_role needs its own
-- SELECT grant on the state view or the conditional refresh cannot read a snapshot.
GRANT SELECT ON public.view_production_schedule_state     TO authenticated, service_role;
GRANT SELECT ON public.view_production_schedule_conflicts TO authenticated, service_role;
REVOKE ALL   ON public.view_production_schedule_state     FROM anon;
REVOKE ALL   ON public.view_production_schedule_conflicts FROM anon;
