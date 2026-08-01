-- ─────────────────────────────────────────────────────────────────────────────
-- Cenapro CCC/QC analysis — the lab-sample base table + its public accessor.
--
-- WHAT THIS IS
-- The partner (CCC) draws CI charcoal daily; a lab reports BD / ASH / GRIT / MC
-- per sample. The WEIGHTS already live in `cenapro.production_event`. This adds
-- the missing lab VALUES. Aggregation over them lands in a sibling migration
-- (`..073646_cenapro_ccc_analysis_views`) — per CLAUDE.md, never in TypeScript.
--
-- THE GRAIN (verified against Renzo's CCC-CI ANALYSIS sheet)
-- One lab sample covers EVERY equipment draw from the same source on the same
-- day into the same warehouse — i.e. (sample_date, source_location_code,
-- effective warehouse) — NOT one sample per event row.
--
-- THE NULL-WAREHOUSE UNIQUENESS TRAP
-- The "effective warehouse" is `coalesce(warehouse_code, plant_code)`: tank and
-- W7 partner draws carry a NULL `warehouse_code` and the sheet writes the PLANT
-- there instead. A UNIQUE constraint spanning a nullable column would NOT
-- de-duplicate those rows, because `NULL <> NULL` in a unique index — every tank
-- sample would be insertable an unlimited number of times. So this table stores
-- the resolved token in a NOT NULL `whse_key` column and the unique constraint
-- spans three NOT NULL columns only. `cenapro.fn_canon_token()` is the single
-- definition of that normalization, shared by the table, the views and the RPCs.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The one canonicalization definition ──────────────────────────────────────
-- Mirrors the TypeScript `normalize()` the drafts use: trim, collapse internal
-- whitespace, uppercase. IMMUTABLE so it is usable in CHECK constraints, index
-- expressions and views alike.
CREATE OR REPLACE FUNCTION cenapro.fn_canon_token(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT upper(regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g'));
$$;

COMMENT ON FUNCTION cenapro.fn_canon_token(text) IS
  'Canonical token normalization for Cenapro CCC analysis keys: trim, collapse '
  'internal whitespace, uppercase. The SQL twin of the drafts TypeScript normalize(). '
  'Used by cenapro.analysis_sample CHECKs, the ccc analysis views (effective '
  'warehouse = fn_canon_token(coalesce(warehouse_code, plant_code))) and the write RPCs, '
  'so all three can never drift apart.';

REVOKE EXECUTE ON FUNCTION cenapro.fn_canon_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cenapro.fn_canon_token(text) TO authenticated, service_role;


-- ── The base table ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cenapro.analysis_sample (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Natural key. All three NOT NULL — see "THE NULL-WAREHOUSE UNIQUENESS TRAP".
  sample_date           date NOT NULL,
  source_location_code  text NOT NULL REFERENCES cenapro.source_location(code),
  whse_key              text NOT NULL,   -- canon(coalesce(warehouse_code, plant_code))

  -- The four metrics. INDEPENDENTLY nullable on purpose: the sheet genuinely has
  -- samples missing one metric (2026-05-08 WHSE 5 carries no ASH). A row missing
  -- ASH still contributes to the BD weighted average.
  bd                    numeric,   -- bulk density
  ash                   numeric,   -- %
  grit                  numeric,   -- %
  mc                    numeric,   -- %

  -- Provenance
  source                text NOT NULL DEFAULT 'app',
  notes                 text,
  row_version           integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  CONSTRAINT cenapro_analysis_sample_natural_key
    UNIQUE (sample_date, source_location_code, whse_key),

  CONSTRAINT cenapro_analysis_sample_source_ck
    CHECK (source IN ('sheet_backfill', 'app')),

  -- whse_key must already be canonical, and must look like a warehouse or a
  -- plant token ('WHSE 5', 'W6', 'W6/W7'). Cheap junk guard; deliberately shape-
  -- based rather than an enumerated list so a new WHSE/plant needs no migration.
  CONSTRAINT cenapro_analysis_sample_whse_key_canonical
    CHECK (whse_key = cenapro.fn_canon_token(whse_key) AND whse_key <> ''),
  CONSTRAINT cenapro_analysis_sample_whse_key_shape
    CHECK (whse_key ~ '^(WHSE [0-9]+|W[0-9]+(/W[0-9]+)*)$'),

  -- Unit-sanity bounds ONLY. Observed ranges across all 500 sheet samples are
  -- bd 0.547–0.586, ash 0.29–4.637, grit 0.13–9.53, mc 7.53–19.53; these bounds
  -- are far wider on purpose. A tighter "observed range" bound would reject a
  -- legitimate future outlier, which is exactly the reading an analyst most needs
  -- to see. A percentage above 100 or a negative density is a typo, not data.
  CONSTRAINT cenapro_analysis_sample_bd_range   CHECK (bd   IS NULL OR (bd   >  0 AND bd   <= 5)),
  CONSTRAINT cenapro_analysis_sample_ash_range  CHECK (ash  IS NULL OR (ash  >= 0 AND ash  <= 100)),
  CONSTRAINT cenapro_analysis_sample_grit_range CHECK (grit IS NULL OR (grit >= 0 AND grit <= 100)),
  CONSTRAINT cenapro_analysis_sample_mc_range   CHECK (mc   IS NULL OR (mc   >= 0 AND mc   <= 100)),

  -- An all-null sample is not a sample; it is a deletion the caller forgot to do.
  CONSTRAINT cenapro_analysis_sample_any_metric
    CHECK (bd IS NOT NULL OR ash IS NOT NULL OR grit IS NOT NULL OR mc IS NOT NULL)
);

COMMENT ON TABLE cenapro.analysis_sample IS
  'CCC/QC lab readings (BD/ASH/GRIT/MC), one row per (sample_date, source_location_code, '
  'whse_key) — the true grain of a lab sample: every draw from the same source into the '
  'same warehouse on the same day shares ONE reading. whse_key is the NOT NULL resolved '
  'effective warehouse = cenapro.fn_canon_token(coalesce(warehouse_code, plant_code)) on '
  'the matching cenapro.production_event rows; it is NOT NULL precisely so the natural-key '
  'UNIQUE actually de-duplicates tank/W7 rows, whose warehouse_code is NULL. Weights are '
  'NEVER stored here — they are joined from production_event by the ccc analysis views.';

COMMENT ON COLUMN cenapro.analysis_sample.whse_key IS
  'Effective warehouse token, canonicalized: warehouse_code when present, else plant_code. '
  'NOT NULL by design (NULL <> NULL would defeat the natural-key UNIQUE).';
COMMENT ON COLUMN cenapro.analysis_sample.source IS
  'sheet_backfill = imported from the CCC-CI ANALYSIS sheet; app = typed in Blackwood. '
  'cenapro_import_analysis_samples only ever overwrites sheet_backfill rows, so re-running '
  'the backfill can never clobber an operator edit.';
COMMENT ON COLUMN cenapro.analysis_sample.row_version IS
  'Optimistic-concurrency token, bumped by trigger on EVERY update (including raw view DML). '
  'cenapro_save_analysis_sample checks it in the same statement as the write.';

-- The natural-key UNIQUE index leads with sample_date, so date-range scans and
-- month rollups are already covered. No additional index needed at this size.


-- ── updated_at / row_version trigger ─────────────────────────────────────────
-- Bumping row_version in a TRIGGER (not in the RPC) means optimistic concurrency
-- still holds when someone writes through the auto-updatable accessor view
-- instead of the RPC. created_at/created_by are pinned to their original values.
CREATE OR REPLACE FUNCTION cenapro.fn_touch_analysis_sample()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at  := now();
  NEW.row_version := OLD.row_version + 1;
  NEW.created_at  := OLD.created_at;
  NEW.created_by  := OLD.created_by;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION cenapro.fn_touch_analysis_sample() IS
  'BEFORE UPDATE on cenapro.analysis_sample: stamps updated_at, increments row_version, '
  'and freezes created_at/created_by. Lives in a trigger so every write path — RPC or raw '
  'view DML — advances the concurrency token.';

DROP TRIGGER IF EXISTS tr_cenapro_analysis_sample_touch ON cenapro.analysis_sample;
CREATE TRIGGER tr_cenapro_analysis_sample_touch
  BEFORE UPDATE ON cenapro.analysis_sample
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_touch_analysis_sample();

-- Postgres grants EXECUTE on new functions to PUBLIC by default; per the CLAUDE.md
-- convention, revoke and grant back only the roles that need it.
REVOKE EXECUTE ON FUNCTION cenapro.fn_touch_analysis_sample() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cenapro.fn_touch_analysis_sample() TO authenticated, service_role;


-- ── RLS: single-org posture ──────────────────────────────────────────────────
-- Matches the platform posture in CLAUDE.md: authenticated = org member = broad
-- read + write; enforcement of roles lives in the server-action layer, not in
-- row predicates. anon gets nothing. service_role bypasses RLS.
ALTER TABLE cenapro.analysis_sample ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cenapro_analysis_sample_select ON cenapro.analysis_sample;
CREATE POLICY cenapro_analysis_sample_select ON cenapro.analysis_sample
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cenapro_analysis_sample_insert ON cenapro.analysis_sample;
CREATE POLICY cenapro_analysis_sample_insert ON cenapro.analysis_sample
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS cenapro_analysis_sample_update ON cenapro.analysis_sample;
CREATE POLICY cenapro_analysis_sample_update ON cenapro.analysis_sample
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS cenapro_analysis_sample_delete ON cenapro.analysis_sample;
CREATE POLICY cenapro_analysis_sample_delete ON cenapro.analysis_sample
  FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON cenapro.analysis_sample TO authenticated, service_role;
REVOKE ALL ON cenapro.analysis_sample FROM anon;


-- ── Public look-through accessor (CENAPRO_SCHEMA.md §2.2) ────────────────────
-- The `cenapro` schema is NOT exposed to PostgREST. A thin single-table
-- projection in `public` is auto-updatable, so a plain GRANT lets
-- supabase.from('cenapro_analysis_samples').insert()/.update()/.delete()
-- rewrite straight to base-table DML — exactly like cenapro_production_events.
-- The canonical SAVE path is still the RPC (it stamps updated_by and enforces
-- optimistic concurrency); this view is the read model + the escape hatch.
CREATE OR REPLACE VIEW public.cenapro_analysis_samples
WITH (security_invoker = true)
AS
SELECT
  s.id,
  s.sample_date,
  s.source_location_code,
  s.whse_key,
  s.bd,
  s.ash,
  s.grit,
  s.mc,
  s.source,
  s.notes,
  s.row_version,
  s.created_at,
  s.created_by,
  s.updated_at,
  s.updated_by
FROM cenapro.analysis_sample s;

COMMENT ON VIEW public.cenapro_analysis_samples IS
  'Public look-through accessor for cenapro.analysis_sample (the cenapro schema is not '
  'exposed to PostgREST). Auto-updatable single-table projection — INSERT/UPDATE/DELETE '
  'rewrite to the base table and fire its triggers/constraints. Prefer '
  'public.cenapro_save_analysis_sample() for saves: it stamps updated_by and enforces '
  'row_version. Shows ALL samples including sheet rows that match no event group yet.';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cenapro_analysis_samples TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cenapro_analysis_samples TO service_role;
REVOKE ALL ON public.cenapro_analysis_samples FROM anon;
