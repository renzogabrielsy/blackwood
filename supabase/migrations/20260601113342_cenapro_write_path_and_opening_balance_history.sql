-- Migration: cenapro_write_path_and_opening_balance_history
-- =====================================================================================
-- Turns the Cenapro (Tenant #2) module from READ-ONLY into the MAINTAINING app — the
-- screens become editable and replace the hand-kept .xlsb as the source of truth. All
-- writes go through the already-PostgREST-served `public` schema (the `cenapro` schema
-- itself is still NOT exposed and stays that way), layering on top of the read accessors
-- from 20260601113341_add_public_cenapro_accessors.
--
-- HARD ISOLATION GUARANTEE: this migration touches ONLY `cenapro.*` objects and the
-- `public.cenapro_*` accessor surface. It does NOT alter, reference, or grant on any ICTC
-- `public` object (deliveries, rc_out, batches, production_*, profiles, etc.). Zero coupling.
--
-- WHAT THIS ADDS / CHANGES:
--   PART A — Production write path (editable grid)
--     A1. GRANT INSERT, UPDATE, DELETE on the existing auto-updatable view
--         public.cenapro_production_events to authenticated.
--         VERIFIED auto-updatable: information_schema.views reports is_insertable_into=YES,
--         is_updatable=YES, is_trigger_*=NO (a simple single-table projection — no INSTEAD OF
--         trigger needed). A rolled-back write test as the real `authenticated` role proved an
--         INSERT through the view fires the base-table BEFORE trigger (computes unique_tag +
--         batch_year), fills the provenance/dirty/timestamp defaults, and validates the FK +
--         partner-equipment-presence CHECK; UPDATE of warehouse_code and DELETE also succeed.
--         The caller already holds USAGE on cenapro + INSERT/UPDATE/DELETE on the base table
--         (granted when the schema was built) and the view is SECURITY INVOKER, so this single
--         GRANT is all that is required to carry writes through. NO RPC fallback needed.
--
--   PART B — Opening balances: modular + append-only history
--     B1. Drop the UNIQUE (warehouse_code, grade_code, side, period_start_date) constraint
--         (cenapro_wob_natural_key) and replace it with a plain (non-unique) index, so
--         re-setting the same (warehouse, grade, side, date) cell keeps a FULL AUDIT TRAIL
--         instead of overwriting. The table becomes APPEND-ONLY: every "set" is a NEW row;
--         nothing is ever UPDATEd or DELETEd. created_at (already present) is the within-date
--         tiebreak that disambiguates two sets on the same effective date.
--     B2. Update cenapro.flec_ledger so the opening SEED uses the LATEST-EFFECTIVE rule:
--         most-recent period_start_date <= start date, tie-broken by greatest created_at.
--         (Adds `created_at DESC` to the existing correlated-subquery ORDER BY. Body is
--         otherwise byte-identical, so the search-path-hardened definition is preserved and
--         the verified numbers still hold — WHSE 7 3X50/RS opens 53 -> current 56.)
--         flec_balance is UNCHANGED (it wraps flec_ledger, so it inherits the new seed rule);
--         the public.cenapro_flec_ledger / cenapro_flec_balance passthroughs are likewise
--         unchanged (they 1:1 delegate to the cenapro functions).
--     B3. Public write + read accessors (in `public`, mirroring the read-accessor pattern):
--         - public.cenapro_set_opening_balance(warehouse, grade, side, effective_date, count)
--             -> INSERTS a new append-only opening-balance entry. SECURITY INVOKER (the caller
--                already holds INSERT on cenapro.warehouse_opening_balance). EXECUTE -> authenticated.
--         - public.cenapro_opening_balances(warehouse, as_of_date)
--             -> the CURRENT effective opening per (grade, side) for that warehouse as of the date
--                (latest period_start_date <= as_of, created_at DESC tiebreak). Drives the
--                editable STARTING block display. SECURITY INVOKER. EXECUTE -> authenticated, anon.
--         - public.cenapro_opening_balance_history(warehouse)
--             -> ALL entries (grade, side, period_start_date, opening_flec_count, created_at)
--                for a backtracking view. SECURITY INVOKER. EXECUTE -> authenticated, anon.
--
-- SECURITY MODEL: everything stays SECURITY INVOKER end-to-end (no SECURITY DEFINER anywhere),
-- exactly like the read accessors. The caller acts with its OWN cenapro grants — zero privilege
-- escalation, tenant isolation preserved. Public functions pin `SET search_path = ''` (their
-- bodies are fully schema-qualified) purely to clear the function_search_path_mutable advisor,
-- matching the cenapro + read-accessor functions.
-- =====================================================================================

-- =====================================================================================
-- PART A — Production write path: grant DML on the auto-updatable public view.
-- =====================================================================================
-- The view is already auto-updatable (verified). authenticated already has the base-table
-- DML + cenapro USAGE; this exposes write through PostgREST so supabase-js can do
-- .from('cenapro_production_events').insert()/.update()/.delete()/.upsert().
GRANT INSERT, UPDATE, DELETE ON public.cenapro_production_events TO authenticated;

COMMENT ON VIEW public.cenapro_production_events IS
  'Read/WRITE PostgREST window onto cenapro.production_event (Tenant #2). SECURITY INVOKER + '
  'auto-updatable (simple single-table projection), so supabase-js INSERT/UPDATE/DELETE/UPSERT '
  'rewrite to base-table DML and fire the base BEFORE trigger (computes unique_tag + batch_year), '
  'fill defaults (provenance/dirty/timestamps), and validate FK + CHECK. The caller writes with '
  'its OWN cenapro DML grant; no data is copied out of cenapro. unique_tag + batch_year are '
  'trigger-computed — never client-set (a supplied value is overwritten by the trigger).';

-- =====================================================================================
-- PART B1 — Make warehouse_opening_balance APPEND-ONLY.
--   Drop the UNIQUE natural key; replace with a plain seed-lookup index. Every "set" is a
--   new row; nothing is overwritten. The existing idx_cenapro_wob_seed_lookup already covers
--   the (warehouse, grade, side, period_start_date DESC) seed scan, so no read regression.
-- =====================================================================================
ALTER TABLE cenapro.warehouse_opening_balance
  DROP CONSTRAINT IF EXISTS cenapro_wob_natural_key;

-- Plain (non-unique) replacement index on the former natural-key tuple. The DESC seed-lookup
-- index (idx_cenapro_wob_seed_lookup) remains and is what the ledger/accessors actually use;
-- this one preserves the tuple as a queryable/audit grouping without enforcing uniqueness.
CREATE INDEX IF NOT EXISTS idx_cenapro_wob_cell
  ON cenapro.warehouse_opening_balance (warehouse_code, grade_code, side, period_start_date);

COMMENT ON TABLE cenapro.warehouse_opening_balance IS
  'APPEND-ONLY flec-count opening balances per (warehouse, grade, side). Every operator "set" '
  'is a NEW row (period_start_date = chosen effective/as-of date; created_at = insert time). '
  'Nothing is ever UPDATEd or DELETEd — re-setting the same cell/date keeps the full audit '
  'trail for backtracking. The EFFECTIVE opening as of date D = greatest period_start_date <= D, '
  'tie-broken by greatest created_at. Seeds cenapro.flec_ledger. WHSE 3 does NOT use this (DVO, deferred).';

-- =====================================================================================
-- PART B2 — flec_ledger: add created_at DESC tiebreak to the opening SEED.
--   Latest-effective rule: most-recent period_start_date <= p_start_date, then greatest
--   created_at. ONLY the seed subquery's ORDER BY changes (… DESC -> … DESC, ob.created_at DESC);
--   the rest of the body is identical to the hardened definition (SET search_path = '' kept).
--   flec_balance is unaffected (it wraps this function).
-- =====================================================================================
CREATE OR REPLACE FUNCTION cenapro.flec_ledger(
  p_warehouse_code text,
  p_start_date     date
)
RETURNS TABLE (
  id                     uuid,
  warehouse_code         text,
  grade_code             text,
  side                   text,
  recv_date              date,
  prod_date              date,
  source_location_code   text,
  disposition_kind       text,
  partner_equipment_code text,
  kg_moved               numeric,
  flec_in                integer,
  flec_out               integer,
  opening_seed           integer,
  flec_in_to_date        bigint,
  flec_out_to_date       bigint,
  running_balance        bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH warehouse_rows AS (
    SELECT
      pe.id,
      pe.warehouse_code,
      pe.grade_code,
      pe.whse_side                                      AS side,
      pe.recv_date,
      pe.prod_date,
      pe.source_location_code,
      pe.disposition_kind,
      pe.partner_equipment_code,
      CASE WHEN pe.disposition_kind = 'flec_bagging'
             AND pe.warehouse_code IS NOT NULL
           THEN pe.flec_count END                       AS flec_in,
      CASE WHEN pe.disposition_kind IN ('partner_crusher','partner_kiln')
             AND sl.kind = 'warehouse_flec'
             AND pe.warehouse_code IS NOT NULL
           THEN pe.flec_count END                       AS flec_out,
      pe.weight_kg
    FROM cenapro.production_event pe
    JOIN cenapro.source_location sl ON sl.code = pe.source_location_code
    JOIN cenapro.warehouse       w  ON w.code  = pe.warehouse_code
    WHERE w.default_unit = 'flec_count'
      AND pe.warehouse_code = p_warehouse_code
      AND pe.whse_side IS NOT NULL
      AND pe.recv_date >= p_start_date
      AND (
           (pe.disposition_kind = 'flec_bagging')
        OR (pe.disposition_kind IN ('partner_crusher','partner_kiln') AND sl.kind = 'warehouse_flec')
      )
  ),
  seeded AS (
    SELECT wr.*,
           -- SEED: latest-effective opening — most-recent period_start_date <= the user's
           -- start date, tie-broken by greatest created_at (append-only history: a later
           -- "set" on the same effective date supersedes the earlier one).
           COALESCE((
             SELECT ob.opening_flec_count
             FROM cenapro.warehouse_opening_balance ob
             WHERE ob.warehouse_code = wr.warehouse_code
               AND ob.grade_code     = wr.grade_code
               AND ob.side           = wr.side
               AND ob.period_start_date <= p_start_date
             ORDER BY ob.period_start_date DESC, ob.created_at DESC
             LIMIT 1
           ), 0) AS opening_seed
    FROM warehouse_rows wr
  )
  SELECT
    s.id,
    s.warehouse_code,
    s.grade_code,
    s.side,
    s.recv_date,
    s.prod_date,
    s.source_location_code,
    s.disposition_kind,
    s.partner_equipment_code,
    s.weight_kg                                         AS kg_moved,
    s.flec_in,
    s.flec_out,
    s.opening_seed,
    SUM(COALESCE(s.flec_in,0))
      OVER (PARTITION BY s.grade_code, s.side
            ORDER BY s.recv_date, s.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)          AS flec_in_to_date,
    SUM(COALESCE(s.flec_out,0))
      OVER (PARTITION BY s.grade_code, s.side
            ORDER BY s.recv_date, s.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)          AS flec_out_to_date,
    s.opening_seed
      + SUM(COALESCE(s.flec_in,0) - COALESCE(s.flec_out,0))
          OVER (PARTITION BY s.grade_code, s.side
                ORDER BY s.recv_date, s.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)      AS running_balance
  FROM seeded s
  ORDER BY s.grade_code, s.side, s.recv_date, s.id;
$$;

COMMENT ON FUNCTION cenapro.flec_ledger(text, date) IS
  'WHSE 1/2/5/7 flec-count ledger, scoped to (p_warehouse_code, p_start_date). '
  'opening_seed = LATEST-EFFECTIVE warehouse_opening_balance: greatest period_start_date <= '
  'p_start_date, tie-broken by greatest created_at (append-only history), per (grade, side); '
  'rows are events with recv_date >= p_start_date; running_balance = opening_seed + windowed '
  'SUM(flec_in - flec_out). No double-count: pre-start movements live in the seed, not the rows. '
  'Direction derived from disposition_kind + source kind (not the workbook substring trick). '
  'kg shown per-row, never summed forward. Start date is the deliberate period-filter hook.';

-- =====================================================================================
-- PART B3a — public.cenapro_set_opening_balance: APPEND a new opening-balance entry.
--   INSERTS only (append-only); never updates/deletes. SECURITY INVOKER — the caller already
--   has INSERT on cenapro.warehouse_opening_balance. Returns the inserted row so the UI can
--   confirm/optimistically render it.
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.cenapro_set_opening_balance(
  p_warehouse_code text,
  p_grade_code     text,
  p_side           text,
  p_effective_date date,
  p_count          integer
)
RETURNS TABLE (
  id                 uuid,
  warehouse_code     text,
  grade_code         text,
  side               text,
  period_start_date  date,
  opening_flec_count integer,
  created_at         timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  INSERT INTO cenapro.warehouse_opening_balance
    (warehouse_code, grade_code, side, period_start_date, opening_flec_count)
  VALUES
    (p_warehouse_code, p_grade_code, p_side, p_effective_date, p_count)
  RETURNING id, warehouse_code, grade_code, side, period_start_date, opening_flec_count, created_at;
$$;

COMMENT ON FUNCTION public.cenapro_set_opening_balance(text, text, text, date, integer) IS
  'Append-only setter for a Cenapro warehouse opening balance (Tenant #2). INSERTS a NEW '
  'cenapro.warehouse_opening_balance row (warehouse, grade, side, effective/as-of date, flec '
  'count); never updates or deletes, so the full history is preserved for backtracking. '
  'SECURITY INVOKER — runs with the caller''s own cenapro INSERT grant. Exists so supabase-js '
  'rpc() can write opening balances without exposing the cenapro schema to PostgREST. The new '
  'entry becomes the effective opening for dates >= its effective date (latest created_at wins '
  'on a same-date re-set).';

GRANT EXECUTE ON FUNCTION public.cenapro_set_opening_balance(text, text, text, date, integer)
  TO authenticated, service_role;

-- =====================================================================================
-- PART B3b — public.cenapro_opening_balances: CURRENT effective opening per (grade, side)
--   for a warehouse as of a date. Latest period_start_date <= as_of, created_at DESC tiebreak.
--   Drives the editable STARTING block display. SECURITY INVOKER (caller has SELECT on the table).
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.cenapro_opening_balances(
  p_warehouse_code text,
  p_as_of_date     date
)
RETURNS TABLE (
  warehouse_code     text,
  grade_code         text,
  side               text,
  period_start_date  date,
  opening_flec_count integer,
  created_at         timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT DISTINCT ON (ob.grade_code, ob.side)
    ob.warehouse_code,
    ob.grade_code,
    ob.side,
    ob.period_start_date,
    ob.opening_flec_count,
    ob.created_at
  FROM cenapro.warehouse_opening_balance ob
  WHERE ob.warehouse_code = p_warehouse_code
    AND ob.period_start_date <= p_as_of_date
  ORDER BY ob.grade_code, ob.side, ob.period_start_date DESC, ob.created_at DESC;
$$;

COMMENT ON FUNCTION public.cenapro_opening_balances(text, date) IS
  'CURRENT effective Cenapro opening balance per (grade, side) for a warehouse as of a date '
  '(Tenant #2). For each (grade, side): the row with the greatest period_start_date <= '
  'p_as_of_date, tie-broken by greatest created_at (append-only "latest set wins"). Matches the '
  'seed rule used by cenapro.flec_ledger, so the displayed STARTING block agrees with the ledger '
  'baseline. SECURITY INVOKER. Exists so supabase-js rpc() can read the editable STARTING block '
  'without exposing the cenapro schema to PostgREST.';

GRANT EXECUTE ON FUNCTION public.cenapro_opening_balances(text, date)
  TO authenticated, anon, service_role;

-- =====================================================================================
-- PART B3c — public.cenapro_opening_balance_history: ALL entries for a warehouse, ordered
--   for a backtracking view. SECURITY INVOKER (caller has SELECT on the table).
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.cenapro_opening_balance_history(
  p_warehouse_code text
)
RETURNS TABLE (
  id                 uuid,
  warehouse_code     text,
  grade_code         text,
  side               text,
  period_start_date  date,
  opening_flec_count integer,
  created_at         timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    ob.id,
    ob.warehouse_code,
    ob.grade_code,
    ob.side,
    ob.period_start_date,
    ob.opening_flec_count,
    ob.created_at
  FROM cenapro.warehouse_opening_balance ob
  WHERE ob.warehouse_code = p_warehouse_code
  ORDER BY ob.grade_code, ob.side, ob.period_start_date DESC, ob.created_at DESC;
$$;

COMMENT ON FUNCTION public.cenapro_opening_balance_history(text) IS
  'FULL append-only history of Cenapro opening-balance entries for a warehouse (Tenant #2): '
  'every (grade, side, period_start_date, opening_flec_count, created_at) ever set, newest first '
  'per (grade, side). Drives the backtracking/audit view. SECURITY INVOKER. Exists so supabase-js '
  'rpc() can read opening-balance history without exposing the cenapro schema to PostgREST.';

GRANT EXECUTE ON FUNCTION public.cenapro_opening_balance_history(text)
  TO authenticated, anon, service_role;

-- =====================================================================================
-- Nudge PostgREST to pick up the new write grant + the new public functions immediately.
-- =====================================================================================
NOTIFY pgrst, 'reload schema';
