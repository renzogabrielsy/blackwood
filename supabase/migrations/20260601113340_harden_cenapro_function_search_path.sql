-- Migration: harden_cenapro_function_search_path
-- =====================================================================================
-- Pins `search_path = ''` on the 4 cenapro functions to clear the Supabase security
-- advisor warning `function_search_path_mutable` and prevent search-path hijacking.
--
-- Safe because every schema object the bodies reference is already schema-qualified
-- (cenapro.production_event, cenapro.source_location, cenapro.warehouse,
-- cenapro.warehouse_opening_balance) and all other identifiers are pg_catalog built-ins
-- (concat_ws, COALESCE, EXTRACT, now(), SUM() OVER, DATE literal) which resolve implicitly
-- regardless of search_path. No behavior change — bodies are byte-identical to the
-- create_cenapro_schema migration, only the SET clause is added.
--
-- ISOLATION: touches only cenapro.* functions. No public/ICTC object referenced or altered.
-- =====================================================================================

-- 1. compute_unique_tag — workbook unique_tag (Excel-serial dates, blank DVO_SIDE segment).
CREATE OR REPLACE FUNCTION cenapro.compute_unique_tag(e cenapro.production_event)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT concat_ws('-',
    (e.recv_date - DATE '1899-12-30')::text,
    COALESCE((e.prod_date - DATE '1899-12-30')::text, ''),
    e.batch,
    COALESCE(e.shift_code, ''),
    e.grade_code,
    COALESCE(e.plant_code, ''),
    COALESCE(e.warehouse_code, ''),
    COALESCE(e.whse_side, ''),
    e.source_location_code,
    CASE WHEN e.disposition_kind = 'flec_bagging' THEN 'FLEC'
         ELSE e.partner_equipment_code END
  );
$$;

-- 2. fn_set_unique_tag — BEFORE trigger: persists unique_tag, derives batch_year, bumps updated_at.
CREATE OR REPLACE FUNCTION cenapro.fn_set_unique_tag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.batch_year IS NULL THEN
    NEW.batch_year := EXTRACT(YEAR FROM NEW.recv_date)::int;
  END IF;
  NEW.unique_tag := cenapro.compute_unique_tag(NEW);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 3. flec_ledger — WHSE 1/2/5/7 start-date-scoped flec running balance.
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
           COALESCE((
             SELECT ob.opening_flec_count
             FROM cenapro.warehouse_opening_balance ob
             WHERE ob.warehouse_code = wr.warehouse_code
               AND ob.grade_code     = wr.grade_code
               AND ob.side           = wr.side
               AND ob.period_start_date <= p_start_date
             ORDER BY ob.period_start_date DESC
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

-- 4. flec_balance — closing balance per (grade, side) for the period; wraps flec_ledger.
CREATE OR REPLACE FUNCTION cenapro.flec_balance(
  p_warehouse_code text,
  p_start_date     date
)
RETURNS TABLE (
  warehouse_code text,
  grade_code     text,
  side           text,
  current_flec   bigint,
  opening_seed   integer,
  as_of          date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT DISTINCT ON (l.grade_code, l.side)
    l.warehouse_code, l.grade_code, l.side,
    l.running_balance AS current_flec,
    l.opening_seed,
    l.recv_date       AS as_of
  FROM cenapro.flec_ledger(p_warehouse_code, p_start_date) l
  ORDER BY l.grade_code, l.side, l.recv_date DESC, l.id DESC;
$$;
