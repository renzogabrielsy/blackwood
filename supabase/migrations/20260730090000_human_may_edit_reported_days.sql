-- The human may edit a REPORTED day; the sync still may not  (2026-07-30)
--
-- WHY
-- ---
-- Phase A gave all three schedule writers the same three guards, one of which was the
-- ACTUALS FREEZE — `NOT EXISTS (production_shifts on that date)`. Applying it uniformly
-- conflated two things that are not the same thing at all:
--
--   * THE SYNC must never rewrite a reported day. Joseph's emailed schedule is a forecast;
--     once production has actually been reported, a stale forecast re-applying itself
--     would rewrite history behind everyone's back. This is the exact silent-overwrite
--     failure mode CLAUDE.md's "Sync Integrity" section forbids.
--     -> KEPT, UNCHANGED, in `fn_apply_schedule_upstream`. Nothing in this migration
--        touches that function, and planner rule 2 (is_reported -> FROZEN) still stands.
--
--   * THE OPERATOR correcting a past plan is legitimate, routine, and the whole point of
--     making the schedule a human-editable master. A plan row is a statement of INTENT.
--     Reporting the actuals does not make yesterday's intent unknowable or immutable —
--     the operator has every reason to fix a mis-plotted setup, a wrong shift count, or a
--     remark on a day that has already run. Refusing them is not a safety property; it is
--     a bug that locks 166 of the calendar's 273 days (every day from 2026-01-02 to
--     2026-07-29) out of reach with no in-app remedy.
--     -> REMOVED, from the two HUMAN write paths only.
--
-- EDITABILITY IS NO LONGER THE SAME THING AS REPORTEDNESS. After this migration those are
-- two independent facts, and the read model must keep them apart:
--
--   is_reported      — "production has been reported for this date". STILL TRUE, still
--                      exposed, still what the sync freezes on. The UI must keep SHOWING
--                      it. It is now purely INFORMATIONAL for the human editor.
--   effective_owner  — 'actual' when reported, else the stored owner. UNCHANGED, so every
--                      existing consumer keeps working.
--
-- Removing the freeze creates one read-model gap, and §3 below closes it: because
-- `effective_owner` collapses to 'actual' the moment a day is reported, a human who now
-- edits a reported day would become INVISIBLE in that column. The new additive
-- `human_edit_after_report` flag carries that signal without redefining either of the two
-- fields above.
--
-- WHAT DOES NOT CHANGE
-- --------------------
--   * `row_version` optimistic concurrency, checked IN THE SAME STATEMENT AS THE WRITE, on
--     every path. A save racing the sync or another operator is still REJECTED.
--   * `owner = 'human'` on the release path.
--   * The audit stamps. `fn_save_schedule_day` already sets `human_edited_at = now()` and
--     `human_edited_by = auth.uid()` on EVERY successful save, so an edit to a reported day
--     is self-evidently attributable — WHO and WHEN, next to `is_reported`. (There is no
--     audit trigger on `production_schedule`; these two columns plus `row_version` ARE the
--     trail, by design since Phase A.)
--
-- OUTCOME VOCABULARY: NARROWED, NOT EXTENDED. Nothing new is invented. The two human
-- functions simply can no longer return 'frozen' — the condition that produced it is gone.
-- `fn_apply_schedule_upstream` still returns 'frozen', and that is now the ONLY place the
-- word can come from, which is precisely the distinction this migration draws.

-- ===========================================================================
-- 1. fn_save_schedule_day — drop the actuals freeze
-- ===========================================================================
-- Byte-for-byte the Phase A function (20260730060000) minus the two freeze constructs:
-- the `NOT EXISTS (production_shifts …)` conjunct in the UPDATE's WHERE, and the 'frozen'
-- early return. The version check stays exactly where it was — inside the UPDATE.

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
$fn$;

COMMENT ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) IS
  'In-app write path for production_schedule. Flips owner to human, stamps human_edited_at/by, and bumps row_version — conditional on p_expected_row_version IN THE UPDATE''S OWN WHERE. As of 2026-07-30 it has NO actuals freeze: a REPORTED day IS editable by a human (correcting a past plan is legitimate). The sync''s freeze is unchanged and lives in fn_apply_schedule_upstream. Returns {ok, outcome, row_version}, outcome in saved|missing|version_conflict — ''frozen'' can no longer be returned from here.';

REVOKE EXECUTE ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) FROM public;
REVOKE EXECUTE ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_save_schedule_day(date, integer, jsonb, boolean) TO service_role;

-- ===========================================================================
-- 2. fn_release_schedule_day — drop the actuals freeze TOO (a deliberate call)
-- ===========================================================================
--
-- THE CALL: remove it. Reasoning, in order of weight:
--
--   1. SYMMETRY IS THE WHOLE POINT OF THIS FUNCTION. `fn_release_schedule_day` exists for
--      exactly one reason (see 20260730070000): `fn_save_schedule_day` unconditionally
--      claims a day for the human, so without a way back, ownership ratchets one way and
--      the calendar freezes into "touched once, mine forever". §1 just opened 166 reported
--      days to human editing. Keeping the freeze here would re-create that ratchet on
--      precisely the days the new capability unlocks — take it, and you can never give it
--      back except by hand-editing the table with the service role. A pair of functions
--      that can TAKE a day but not RELEASE it is the bug the release function was written
--      to prevent.
--
--   2. RELEASING A REPORTED DAY IS INERT, NOT DANGEROUS. Release never touches a single
--      plan field — it only clears the ownership claim (owner back to the `source` prefix,
--      source_rev/pending_upstream/human_edited_at/by nulled). And the sync STILL cannot
--      write the date afterwards: planner rule 2 and fn_apply_schedule_upstream's own
--      freeze both hold. So the end state of releasing a reported day is "a reported day
--      labelled with its upstream owner that the sync will never write" — which is
--      identical to the state of every reported day nobody ever edited. There is no
--      window in which the row shows values nobody wrote.
--
--   3. THE NULLED `source_rev` IS STILL CORRECT. Its purpose is "force the next run to
--      re-apply rather than no-op". On a reported day the next run declines to write for a
--      different reason (the freeze), so the nulling is simply a no-op there — not a lie
--      and not a trap.
--
-- The cost of removal is the loss of one audit fact: who last edited a released day. That
-- is inherent to release (it nulls those stamps on unreported days too) and is not made
-- worse by reported days. Weighed against a permanent one-way lock on 60% of the calendar,
-- removal wins clearly.

CREATE OR REPLACE FUNCTION public.fn_release_schedule_day(
  p_plan_date            date,
  p_expected_row_version integer
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
    RAISE EXCEPTION 'fn_release_schedule_day: p_plan_date is required';
  END IF;
  IF p_expected_row_version IS NULL THEN
    RAISE EXCEPTION 'fn_release_schedule_day: p_expected_row_version is required';
  END IF;

  -- Two guards now, not three: version + ownership. The actuals freeze is gone for the
  -- same reason it is gone from fn_save_schedule_day — see the block above.
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
$fn$;

COMMENT ON FUNCTION public.fn_release_schedule_day(date, integer) IS
  'In-app REVERT path for production_schedule: hands a human-owned day back to the sync. Restores owner from the source prefix (joseph:% -> joseph, else gsheet), nulls source_rev, pending_upstream and human_edited_at/by, bumps row_version; conditional on p_expected_row_version AND owner=''human'' IN THE UPDATE''S OWN WHERE. Plan fields untouched. As of 2026-07-30 it has NO actuals freeze, mirroring fn_save_schedule_day — a human who can TAKE a reported day must be able to give it back, and release is inert on a reported day because the sync still cannot write it. Returns {ok, outcome, row_version}, outcome in reclaimed|missing|version_conflict — ''frozen'' can no longer be returned from here.';

REVOKE EXECUTE ON FUNCTION public.fn_release_schedule_day(date, integer) FROM public;
REVOKE EXECUTE ON FUNCTION public.fn_release_schedule_day(date, integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_release_schedule_day(date, integer) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_release_schedule_day(date, integer) TO service_role;

-- ===========================================================================
-- 3. view_production_schedule_state — one ADDITIVE column
-- ===========================================================================
-- `is_reported` and `effective_owner` are reproduced EXACTLY as Phase A defined them; the
-- UI still needs both, and both existing consumers (components/digest/schedule-month-view
-- and workers/sync/src/lib/db.ts::readScheduleState) name their columns explicitly, so
-- appending one is safe.
--
-- `human_edit_after_report` closes the gap §1 opens: `effective_owner` collapses to
-- 'actual' the moment a day is reported, so a human who now edits a reported day would
-- otherwise be invisible in the read model. This flag says "reported AND humanly owned" —
-- the day the operator deliberately corrected after the fact. It is the signal the editor
-- should badge, and it exists so nobody is tempted to re-conflate reportedness with
-- editability by redefining `effective_owner`.

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
  s.updated_at,
  -- ADDITIVE (2026-07-30): reported AND still humanly owned = the operator corrected the
  -- plan after production was reported. Not derivable from `effective_owner`, which masks
  -- the human owner behind 'actual' on every reported day.
  (
    s.owner = 'human'
    AND EXISTS (
      SELECT 1 FROM public.production_shifts ps
       WHERE ps.transaction_date = s.plan_date
    )
  )                                                AS human_edit_after_report
FROM public.production_schedule s;

COMMENT ON VIEW public.view_production_schedule_state IS
  'Ownership-aware read model for production_schedule. is_reported = a production_shifts row exists for the date — the SYNC''s actuals freeze, and since 2026-07-30 purely INFORMATIONAL for the human editor (a reported day IS humanly editable; see fn_save_schedule_day). effective_owner = "actual" when reported, else the stored owner. human_edit_after_report = reported AND owner=human, i.e. the operator corrected the plan after the fact — the signal effective_owner masks. Read by the sync worker (service_role) to plan a conditional refresh, and by the app.';

GRANT SELECT ON public.view_production_schedule_state TO authenticated, service_role;
REVOKE ALL   ON public.view_production_schedule_state FROM anon;
