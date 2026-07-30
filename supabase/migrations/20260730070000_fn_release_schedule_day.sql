-- fn_release_schedule_day — hand a human-owned day BACK to the sync  (Phase B gap-fill,
-- 2026-07-30)
--
-- WHY
-- ---
-- Phase A (`20260730060000_production_schedule_ownership.sql`) shipped exactly two
-- sanctioned writers:
--
--   fn_apply_schedule_upstream  — the SYNC's writer (service_role only).
--   fn_save_schedule_day        — the APP's writer. It UNCONDITIONALLY sets owner='human'.
--
-- Ownership therefore only ever ratchets ONE WAY: every in-app edit takes a day away from
-- the sync, and nothing gives one back. Over time the calendar freezes solid and the
-- "follow until touched" model degrades into "touched once, mine forever".
--
-- Phase B's revert action needs the opposite move, and neither existing RPC can express
-- it: fn_save_schedule_day always claims the day, and the app must never call
-- fn_apply_schedule_upstream (that is the sync's service-role-only writer, and its ops
-- contract carries an upstream payload the app does not have). So the action had to fall
-- back on a conditional PostgREST UPDATE — which can express `row_version` and `owner`
-- inline, but CANNOT express the `NOT EXISTS (production_shifts …)` actuals freeze. That
-- guard was read beforehand from `view_production_schedule_state`: a read-then-write, and
-- the ONLY one in this feature. This function closes it.
--
-- WHAT "RELEASE" MEANS
-- -------------------
--   * owner            → back to the UPSTREAM owner implied by `source`. Derived exactly
--                        the way Phase A's backfill derived it — 'joseph:%' → joseph,
--                        everything else → gsheet — so the two can never disagree.
--   * source_rev       → NULL. This is load-bearing, not tidiness: the sync no-ops when the
--                        stored rev equals the incoming rev, so leaving a stale rev behind
--                        would hand the day back in name only and the human's values would
--                        survive under a `joseph` label. A NULL rev never equals an
--                        incoming rev, so the next run RE-APPLIES the upstream value for
--                        real (same mechanism as Phase A's one-shot re-stamp).
--   * pending_upstream → NULL. A parked proposal is about to be applied for real; keeping
--                        it would leave a phantom conflict in
--                        view_production_schedule_conflicts and in the digest's count.
--   * human_edited_at/by → NULL. Nobody owns the day anymore.
--   * row_version      → bumped, like every other write to this table.
--
-- Plan FIELDS (shifts/setup/projected_tons/grades/remarks) are deliberately left ALONE.
-- Release is a statement about OWNERSHIP, not about values: the human's numbers stand
-- until the next sync run actually applies Joseph's — through fn_apply_schedule_upstream,
-- with its own guards. There is no window in which the day shows values nobody wrote.
--
-- GUARDS — all three inline, same discipline as both siblings
--   row_version = p_expected_row_version        -- optimistic concurrency
--   owner       = 'human'                       -- only a human-owned day can be released
--   NOT EXISTS (production_shifts on the date)  -- actuals freeze, re-checked in SQL
--
-- OUTCOME VOCABULARY — reused verbatim from the siblings, nothing invented:
--   'reclaimed'        — success. Phase A already uses this exact word for "clear the
--                        parked value and hand ownership back to the upstream owner"
--                        (fn_apply_schedule_upstream's rule-4 action). Same end state,
--                        same word; the difference is only who initiated it.
--   'frozen'           — production is already reported for the date.
--   'missing'          — no schedule row for the date.
--   'version_conflict' — the row_version OR the owner guard failed. Folding the ownership
--                        miss into 'version_conflict' is also inherited, not invented:
--                        fn_apply_schedule_upstream's classifier does precisely this (its
--                        final ELSE catches both the version and the owner mismatch).
--                        Either way the truthful message is "it changed under you".
--
--   p_plan_date            date — the day to release (must exist, must be human-owned).
--   p_expected_row_version int  — the version the editor loaded.
--   returns jsonb — {ok, outcome, row_version}

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
     AND NOT EXISTS (
       SELECT 1 FROM public.production_shifts ps WHERE ps.transaction_date = s.plan_date
     )
  RETURNING s.row_version INTO v_new_version;

  IF v_new_version IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'reclaimed', 'row_version', v_new_version);
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

COMMENT ON FUNCTION public.fn_release_schedule_day(date, integer) IS
  'In-app REVERT path for production_schedule (Phase B): hands a human-owned day back to the sync. Restores owner from the source prefix (joseph:% -> joseph, else gsheet), nulls source_rev (so the next run re-applies rather than no-ops), pending_upstream and human_edited_at/by, and bumps row_version — all conditional on p_expected_row_version, owner=''human'', and the production_shifts actuals freeze IN THE UPDATE''S OWN WHERE. Plan fields are untouched. Returns {ok, outcome, row_version}, outcome in reclaimed|frozen|missing|version_conflict.';

REVOKE EXECUTE ON FUNCTION public.fn_release_schedule_day(date, integer) FROM public;
REVOKE EXECUTE ON FUNCTION public.fn_release_schedule_day(date, integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_release_schedule_day(date, integer) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_release_schedule_day(date, integer) TO service_role;
