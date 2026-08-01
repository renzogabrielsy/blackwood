-- ─────────────────────────────────────────────────────────────────────────────
-- Cenapro CCC/QC analysis — the write path.
--
-- TWO functions, both in `public` (the cenapro schema is not exposed to
-- PostgREST), both SECURITY INVOKER with a pinned empty search_path and every
-- reference schema-qualified — the idiom every other cenapro function already
-- uses (`cenapro.flec_ledger`, `public.cenapro_set_opening_balance`). An empty
-- search_path is strictly stronger than `SET search_path = public`.
--
--   1. public.cenapro_save_analysis_sample(...)      → authenticated + service_role
--      The app's save. Upserts by the natural key, stamps updated_by = auth.uid(),
--      and enforces OPTIMISTIC CONCURRENCY.
--
--   2. public.cenapro_import_analysis_samples(jsonb) → service_role ONLY
--      The idempotent sheet backfill. Never overwrites a human ('app') row.
--
-- DELETE has no RPC on purpose: `public.cenapro_analysis_samples` is an
-- auto-updatable view with DELETE granted to authenticated, and a delete carries
-- no provenance an RPC could add.
--
-- CONCURRENCY DECISION — optimistic locking IS enforced, cheaply.
-- The project idiom is `fn_save_schedule_day`: the expected `row_version` is
-- checked in the SAME statement as the write (never read-then-write). A lab
-- sample is far lower-contention than a schedule day, so "last write wins" was a
-- defensible option — but it was rejected. These four numbers are reported to the
-- partner, an operator will keep the entry ledger open in a tab while another
-- edits, and a silently reverted BD is indistinguishable from a lab that never
-- reported it. The cost is one integer column and one AND in a WHERE clause. The
-- read model (`cenapro.view_ccc_sample_group.sample_row_version`) already hands
-- the caller the token, and it is NULL for an unsampled group — which is exactly
-- the "I expect to create this" signal the RPC wants. So:
--   p_expected_row_version IS NULL  → INSERT, and a losing race returns
--                                     outcome='already_exists' (never a clobber)
--   p_expected_row_version = n      → UPDATE ... AND row_version = n; a mismatch
--                                     returns outcome='version_conflict' + the
--                                     current version, so the UI can re-read.
-- row_version is bumped by a TRIGGER, not by these functions, so a raw write
-- through the accessor view advances it too and cannot silently defeat the lock.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cenapro_save_analysis_sample(
  p_sample_date          date,
  p_source_location_code text,
  p_whse_key             text,
  p_bd                   numeric DEFAULT NULL,
  p_ash                  numeric DEFAULT NULL,
  p_grit                 numeric DEFAULT NULL,
  p_mc                   numeric DEFAULT NULL,
  p_expected_row_version integer DEFAULT NULL,
  p_notes                text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_src     text := cenapro.fn_canon_token(p_source_location_code);
  v_whse    text := cenapro.fn_canon_token(p_whse_key);
  v_id      uuid;
  v_version integer;
  v_current integer;
BEGIN
  IF p_sample_date IS NULL OR v_src = '' OR v_whse = '' THEN
    RETURN jsonb_build_object(
      'ok', false, 'outcome', 'invalid_key',
      'message', 'sample_date, source_location_code and whse_key are all required.');
  END IF;

  -- An all-null sample is not a sample (the base table CHECK agrees). Deleting is
  -- the way to remove a reading; this returns a typed outcome instead of a 500.
  IF p_bd IS NULL AND p_ash IS NULL AND p_grit IS NULL AND p_mc IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'outcome', 'no_metrics',
      'message', 'A sample must carry at least one of bd/ash/grit/mc. Delete the row instead.');
  END IF;

  IF p_expected_row_version IS NULL THEN
    -- Caller believes this (date, source, warehouse) carries no sample yet.
    INSERT INTO cenapro.analysis_sample AS s
      (sample_date, source_location_code, whse_key,
       bd, ash, grit, mc, source, notes, created_by, updated_by)
    VALUES
      (p_sample_date, v_src, v_whse,
       p_bd, p_ash, p_grit, p_mc, 'app', p_notes, auth.uid(), auth.uid())
    ON CONFLICT ON CONSTRAINT cenapro_analysis_sample_natural_key DO NOTHING
    RETURNING s.id, s.row_version INTO v_id, v_version;

    IF v_id IS NULL THEN
      SELECT s.row_version INTO v_current
        FROM cenapro.analysis_sample s
       WHERE s.sample_date          = p_sample_date
         AND s.source_location_code = v_src
         AND s.whse_key             = v_whse;
      RETURN jsonb_build_object(
        'ok', false, 'outcome', 'already_exists', 'row_version', v_current,
        'message', 'A sample already exists for this date/source/warehouse. Reload and edit it.');
    END IF;

    RETURN jsonb_build_object(
      'ok', true, 'outcome', 'inserted', 'id', v_id, 'row_version', v_version);
  END IF;

  -- Conditional UPDATE — the version is checked in the SAME statement as the write.
  -- `notes` is left unchanged when p_notes IS NULL, so a caller with no notes field
  -- cannot silently wipe one.
  UPDATE cenapro.analysis_sample AS s
     SET bd         = p_bd,
         ash        = p_ash,
         grit       = p_grit,
         mc         = p_mc,
         notes      = coalesce(p_notes, s.notes),
         source     = 'app',
         updated_by = auth.uid()
   WHERE s.sample_date          = p_sample_date
     AND s.source_location_code = v_src
     AND s.whse_key             = v_whse
     AND s.row_version          = p_expected_row_version
  RETURNING s.id, s.row_version INTO v_id, v_version;

  IF v_id IS NULL THEN
    SELECT s.row_version INTO v_current
      FROM cenapro.analysis_sample s
     WHERE s.sample_date          = p_sample_date
       AND s.source_location_code = v_src
       AND s.whse_key             = v_whse;

    IF v_current IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false, 'outcome', 'not_found',
        'message', 'That sample no longer exists — it was deleted. Reload the ledger.');
    END IF;

    RETURN jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this sample while you were editing. Reload to see their values.');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'outcome', 'updated', 'id', v_id, 'row_version', v_version);
END;
$$;

COMMENT ON FUNCTION public.cenapro_save_analysis_sample(date, text, text, numeric, numeric, numeric, numeric, integer, text) IS
  'Upsert one CCC lab sample by its natural key (sample_date, source_location_code, whse_key). '
  'Pass p_expected_row_version = NULL to CREATE (a losing race returns already_exists), or the '
  'row_version you read to UPDATE (a mismatch returns version_conflict with the current version). '
  'Stamps created_by/updated_by = auth.uid() and flips source to app, which protects the row from '
  'the sheet backfill. Returns {ok, outcome, id, row_version, message}.';

REVOKE EXECUTE ON FUNCTION public.cenapro_save_analysis_sample(date, text, text, numeric, numeric, numeric, numeric, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cenapro_save_analysis_sample(date, text, text, numeric, numeric, numeric, numeric, integer, text) TO authenticated, service_role;


-- ── Bulk sheet import (service_role only) ────────────────────────────────────
-- Idempotent by construction:
--   • ON CONFLICT keyed on the natural key, so a re-run never duplicates.
--   • DO UPDATE is gated on `source = 'sheet_backfill'`, so it can NEVER overwrite
--     a reading an operator typed in the app.
--   • DO UPDATE is additionally gated on the values actually differing, so a
--     no-change re-run honestly reports 0 updates.
--   • DISTINCT ON de-duplicates within the payload (ON CONFLICT DO UPDATE cannot
--     touch the same row twice in one statement).
CREATE OR REPLACE FUNCTION public.cenapro_import_analysis_samples(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_total    integer := 0;
  v_inserted integer := 0;
  v_updated  integer := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'cenapro_import_analysis_samples: p_rows must be a JSON array';
  END IF;
  v_total := jsonb_array_length(p_rows);

  WITH incoming AS (
    SELECT DISTINCT ON (
             (r->>'sample_date')::date,
             cenapro.fn_canon_token(r->>'source_location_code'),
             cenapro.fn_canon_token(r->>'whse_key'))
           (r->>'sample_date')::date                          AS sample_date,
           cenapro.fn_canon_token(r->>'source_location_code') AS source_location_code,
           cenapro.fn_canon_token(r->>'whse_key')             AS whse_key,
           nullif(r->>'bd',   '')::numeric                    AS bd,
           nullif(r->>'ash',  '')::numeric                    AS ash,
           nullif(r->>'grit', '')::numeric                    AS grit,
           nullif(r->>'mc',   '')::numeric                    AS mc,
           nullif(r->>'notes','')                             AS notes
      FROM jsonb_array_elements(p_rows) r
  ),
  valid AS (
    SELECT * FROM incoming
     WHERE bd IS NOT NULL OR ash IS NOT NULL OR grit IS NOT NULL OR mc IS NOT NULL
  ),
  upserted AS (
    INSERT INTO cenapro.analysis_sample AS s
      (sample_date, source_location_code, whse_key, bd, ash, grit, mc, source, notes)
    SELECT v.sample_date, v.source_location_code, v.whse_key,
           v.bd, v.ash, v.grit, v.mc, 'sheet_backfill', v.notes
      FROM valid v
    ON CONFLICT ON CONSTRAINT cenapro_analysis_sample_natural_key DO UPDATE
      SET bd    = excluded.bd,
          ash   = excluded.ash,
          grit  = excluded.grit,
          mc    = excluded.mc,
          notes = excluded.notes
      WHERE s.source = 'sheet_backfill'
        AND (s.bd, s.ash, s.grit, s.mc, s.notes)
            IS DISTINCT FROM
            (excluded.bd, excluded.ash, excluded.grit, excluded.mc, excluded.notes)
    RETURNING (s.xmax = 0) AS was_insert
  )
  SELECT coalesce(count(*) FILTER (WHERE was_insert), 0),
         coalesce(count(*) FILTER (WHERE NOT was_insert), 0)
    INTO v_inserted, v_updated
    FROM upserted;

  RETURN jsonb_build_object(
    'ok', true,
    'received',               v_total,
    'inserted',               v_inserted,
    'updated',                v_updated,
    'unchanged_or_protected', v_total - v_inserted - v_updated);
END;
$$;

COMMENT ON FUNCTION public.cenapro_import_analysis_samples(jsonb) IS
  'Idempotent bulk import of CCC lab samples from the CCC-CI ANALYSIS sheet. p_rows is a JSON '
  'array of {sample_date, source_location_code, whse_key, bd, ash, grit, mc, notes}. Upserts by '
  'the natural key; DO UPDATE is gated on source = sheet_backfill so an operator edit made in '
  'the app is NEVER clobbered by a re-run, and on the values differing so an unchanged re-run '
  'reports 0 updates. service_role only — called by '
  'scripts/cenapro/backfill-ccc-analysis-samples.mjs.';

REVOKE EXECUTE ON FUNCTION public.cenapro_import_analysis_samples(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cenapro_import_analysis_samples(jsonb) TO service_role;
