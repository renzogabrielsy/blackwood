-- Migration: create_cenapro_schema
-- =====================================================================================
-- Onboards TENANT #2 — Cenapro (CI / Cebu charcoal) — onto the Blackwood platform as a
-- fully isolated Postgres schema. Builds the v1 database foundation per the authoritative
-- design doc /Users/renzosy/blackwood/cenapro/CENAPRO_SCHEMA.md (DVO deferred).
--
-- HARD ISOLATION GUARANTEE: everything lives in the dedicated `cenapro` schema. This
-- migration does NOT touch, alter, or reference any ICTC `public` object (deliveries,
-- rc_out, batches, production_*, etc.). Zero coupling — separate namespace by design.
--
-- Scope (v1, per design doc §1.2 / §13):
--   1. `cenapro` schema
--   2. Lookup/dimension tables + seed data:
--        shift, grade, plant, warehouse, source_location, partner_equipment
--   3. Core spine: production_event (§4.2)
--   4. warehouse_opening_balance (§4.3), drift_log (§4.4)
--   5. compute_unique_tag + BEFORE-trigger (§7.1)
--   6. flec_ledger(text, date) + flec_balance(text, date) set-returning functions (§6.1/§6.2)
--   7. view_production_daily (§6.3)
--   8. Grants mirroring ICTC's production pattern (no RLS in v1, §4.5)
--
-- DIVERGENCE FROM DESIGN DOC (explicitly requested by Renzo, 2026-06-01):
--   batch_year — every Cenapro batch is disambiguated by year, so the effective identity
--   is (batch, batch_year). The doc (§12 Q2) left this open with a working default of
--   "bare month text + rely on dates". This migration EXTENDS the doc: production_event
--   gains a `batch_year int NOT NULL` column, auto-derived from recv_date when not supplied
--   (BEFORE trigger), and folded into the advisory natural-key index. `unique_tag` keeps its
--   byte-for-byte workbook parity (Excel-serial date segments already encode the year, so the
--   exported tag string is unchanged); batch_year is the queryable first-class identity column.
--   See the COMMENT on production_event.batch_year and idx_cenapro_pe_batch_identity below.
--
-- NOTE — PostgREST exposure: a non-`public` schema is NOT reachable by supabase-js until
-- `cenapro` is added to the API "Exposed schemas" list (design doc §2.2). This migration
-- ATTEMPTS that via ALTER ROLE authenticator (bottom of file) but on managed Supabase the
-- canonical control is the dashboard toggle (Settings -> API -> Exposed schemas). The SQL
-- grants below are applied regardless so the schema is query-ready the moment it is exposed.
-- =====================================================================================

-- =====================================================================================
-- 0. Schema
-- =====================================================================================
CREATE SCHEMA IF NOT EXISTS cenapro;

COMMENT ON SCHEMA cenapro IS
  'Tenant #2 (Cenapro / CI Cebu charcoal). Fully isolated from ICTC public.* tables. '
  'v1 = CI production spine + flec inventory ledger (WHSE 1/2/5/7). DVO deferred (design doc §1.3).';

-- =====================================================================================
-- 1. Lookup / dimension tables (text `code` PK; spine FKs by code — design doc §4.1)
--    Divergence #1 from codo: text-PK lookups (not integer surrogate) to match ICTC's
--    text+CHECK convention and keep canonical strings visible in the spine for export.
-- =====================================================================================

-- 1.1 shift: M/E/N. Only 'M' observed in real data; E/N reserved (design doc §4.1).
CREATE TABLE IF NOT EXISTS cenapro.shift (
  code         text PRIMARY KEY CHECK (code IN ('M','E','N')),
  display_name text NOT NULL,
  sort_order   int  NOT NULL DEFAULT 0
);
COMMENT ON TABLE cenapro.shift IS 'Shift dimension (M=Morning, E=Evening, N=Night). Only M seen in data; E/N reserved.';

-- 1.2 grade: 3X50 / 2X6 / 3.5 / 4X8. '3.5' is stored numeric in the workbook — coerce on read.
--     expected_kg_per_bag_* are soft-warning bounds (app-layer only, design doc §8.3).
--     Renzo confirmed 3.5 and 4X8 are real grades (§12 Q7 default) with NULL bounds.
CREATE TABLE IF NOT EXISTS cenapro.grade (
  code                    text PRIMARY KEY,
  display_name            text NOT NULL,
  sort_order              int  NOT NULL DEFAULT 0,
  expected_kg_per_bag_min numeric,
  expected_kg_per_bag_max numeric
);
COMMENT ON TABLE cenapro.grade IS 'Grade/SKU dimension. expected_kg_per_bag_* are soft (app-layer) bounds; NULL = no warning.';

-- 1.3 plant: includes 'DVO' so source_location FK + future DVO events stay valid (forward-compat).
--     branch is a label (CI=Cebu, ICTC=Davao), NOT a coupling to ICTC tables.
CREATE TABLE IF NOT EXISTS cenapro.plant (
  code         text PRIMARY KEY CHECK (code IN ('W6','W7','W6/W7','DVO')),
  display_name text NOT NULL,
  branch       text NOT NULL CHECK (branch IN ('CI','ICTC'))
);
COMMENT ON TABLE cenapro.plant IS 'Producing plant dimension. DVO row kept for FK forward-compat; no DVO events in v1.';

-- 1.4 warehouse: canonical WHSE 1/2/3/5/7 (Renzo confirmed exact set, §12 Q8 RESOLVED).
--     default_unit drives ledger flavor: flec_count for 1/2/5/7 (v1 flec ledger), kg for 3
--     (seeded for the deferred DVO ledger; no v1 events reference it).
CREATE TABLE IF NOT EXISTS cenapro.warehouse (
  code         text PRIMARY KEY CHECK (code IN ('WHSE 1','WHSE 2','WHSE 3','WHSE 5','WHSE 7')),
  display_name text NOT NULL,
  branch       text NOT NULL CHECK (branch IN ('CI','ICTC')),
  default_unit text NOT NULL CHECK (default_unit IN ('flec_count','kg'))
);
COMMENT ON TABLE cenapro.warehouse IS
  'Warehouse dimension. Exactly {WHSE 1,2,3,5,7} (Renzo 2026-06-01). default_unit=flec_count for 1/2/5/7; kg for 3 (DVO, deferred).';

-- 1.5 source_location: the truthful SRC field. kind drives the validity matrix (design doc §8).
--     plant_code is the forced plant for non-FLEC sources (§8.2); NULL for FLEC (origin unknowable).
CREATE TABLE IF NOT EXISTS cenapro.source_location (
  code         text PRIMARY KEY CHECK (code IN ('TNK 1','TNK 2','TNK 3','TNK 4','W6','W7','FLEC','DVO')),
  display_name text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('tank','plant_direct','warehouse_flec','dvo_container')),
  plant_code   text REFERENCES cenapro.plant(code)
);
COMMENT ON TABLE cenapro.source_location IS
  'SRC dimension. kind ∈ {tank, plant_direct, warehouse_flec, dvo_container} drives the §8.1 validity matrix. plant_code = forced plant for non-FLEC sources (§8.2).';

-- 1.6 partner_equipment: the downstream partner's 4 crushers + 4 rotary kilns.
--     (CENAPRO_PRODUCTION_ANALYSIS wrongly guessed these were "quality classes" — they are equipment.)
CREATE TABLE IF NOT EXISTS cenapro.partner_equipment (
  code         text PRIMARY KEY CHECK (code IN ('C1','C2','C3','C4','RK1','RK2','RK3','RK4')),
  display_name text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('crusher','kiln')),
  sort_order   int  NOT NULL DEFAULT 0
);
COMMENT ON TABLE cenapro.partner_equipment IS
  'Downstream partner equipment: 4 crushers (C1-C4) + 4 rotary kilns (RK1-RK4). NOT quality classes.';

-- =====================================================================================
-- 2. Seed data for the lookups (idempotent UPSERT on PK)
-- =====================================================================================

-- 2.1 shift
INSERT INTO cenapro.shift (code, display_name, sort_order) VALUES
  ('M', 'Morning', 1),
  ('E', 'Evening', 2),
  ('N', 'Night',   3)
ON CONFLICT (code) DO UPDATE SET display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order;

-- 2.2 grade — 3X50 / 2X6 / 3.5 / 4X8. Bounds: 3X50 [400,700], 2X6 [400,650], 3.5 & 4X8 NULL (§8.3).
INSERT INTO cenapro.grade (code, display_name, sort_order, expected_kg_per_bag_min, expected_kg_per_bag_max) VALUES
  ('3X50', '3X50', 1, 400, 700),
  ('2X6',  '2X6',  2, 400, 650),
  ('3.5',  '3.5',  3, NULL, NULL),
  ('4X8',  '4X8',  4, NULL, NULL)
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order   = EXCLUDED.sort_order,
  expected_kg_per_bag_min = EXCLUDED.expected_kg_per_bag_min,
  expected_kg_per_bag_max = EXCLUDED.expected_kg_per_bag_max;

-- 2.3 plant — W6, W7, W6/W7, DVO (DVO seeded for forward-compat; no DVO events in v1).
INSERT INTO cenapro.plant (code, display_name, branch) VALUES
  ('W6',    'W6',    'CI'),
  ('W7',    'W7',    'CI'),
  ('W6/W7', 'W6/W7', 'CI'),
  ('DVO',   'Davao', 'ICTC')
ON CONFLICT (code) DO UPDATE SET display_name = EXCLUDED.display_name, branch = EXCLUDED.branch;

-- 2.4 warehouse — exactly {WHSE 1,2,3,5,7}. WHSE 3 = kg (DVO, deferred); rest = flec_count.
INSERT INTO cenapro.warehouse (code, display_name, branch, default_unit) VALUES
  ('WHSE 1', 'WHSE 1', 'CI',   'flec_count'),
  ('WHSE 2', 'WHSE 2', 'CI',   'flec_count'),
  ('WHSE 3', 'WHSE 3', 'ICTC', 'kg'),          -- DVO storage, forward-compat only
  ('WHSE 5', 'WHSE 5', 'CI',   'flec_count'),
  ('WHSE 7', 'WHSE 7', 'CI',   'flec_count')
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name, branch = EXCLUDED.branch, default_unit = EXCLUDED.default_unit;

-- 2.5 source_location — TNK 1-4 (tank, plant W6), W7 (tank, plant W7), W6 (plant_direct, plant W6),
--     FLEC (warehouse_flec, plant NULL), DVO (dvo_container, plant DVO — deferred). Per §8.2 pairing.
INSERT INTO cenapro.source_location (code, display_name, kind, plant_code) VALUES
  ('TNK 1', 'Tank 1', 'tank',           'W6'),
  ('TNK 2', 'Tank 2', 'tank',           'W6'),
  ('TNK 3', 'Tank 3', 'tank',           'W6'),
  ('TNK 4', 'Tank 4', 'tank',           'W6'),
  ('W7',    'W7',     'tank',           'W7'),
  ('W6',    'W6',     'plant_direct',   'W6'),
  ('FLEC',  'FLEC',   'warehouse_flec', NULL),
  ('DVO',   'DVO',    'dvo_container',  'DVO')   -- deferred; seeded for forward-compat
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name, kind = EXCLUDED.kind, plant_code = EXCLUDED.plant_code;

-- 2.6 partner_equipment — C1-C4 crushers, RK1-RK4 kilns.
INSERT INTO cenapro.partner_equipment (code, display_name, kind, sort_order) VALUES
  ('C1',  'Crusher 1',     'crusher', 1),
  ('C2',  'Crusher 2',     'crusher', 2),
  ('C3',  'Crusher 3',     'crusher', 3),
  ('C4',  'Crusher 4',     'crusher', 4),
  ('RK1', 'Rotary Kiln 1', 'kiln',    5),
  ('RK2', 'Rotary Kiln 2', 'kiln',    6),
  ('RK3', 'Rotary Kiln 3', 'kiln',    7),
  ('RK4', 'Rotary Kiln 4', 'kiln',    8)
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name, kind = EXCLUDED.kind, sort_order = EXCLUDED.sort_order;

-- =====================================================================================
-- 3. Core spine — cenapro.production_event (design doc §4.2)
--    One row per workbook Production row (DVO rows excluded in v1). Surrogate uuid identity;
--    unique_tag is audit/export-parity only, never a join key.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS cenapro.production_event (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  recv_date              date NOT NULL,                                  -- was CCC RECV (logging date)
  prod_date              date,                                           -- nullable (partner takeback rows omit)
  batch                  text NOT NULL,                                  -- 'NOVEMBER'..'MAY'; NOT derived from prod_date (codo rule 10)
  batch_year             int  NOT NULL,                                  -- DIVERGENCE (Renzo): year that disambiguates `batch`; auto-derived from recv_date if not supplied

  shift_code             text REFERENCES cenapro.shift(code),            -- nullable
  grade_code             text NOT NULL REFERENCES cenapro.grade(code),
  plant_code             text REFERENCES cenapro.plant(code),            -- nullable: NULL when source is FLEC (codo rule 27)
  warehouse_code         text REFERENCES cenapro.warehouse(code),        -- nullable: NULL on tank/plant-direct events
  source_location_code   text NOT NULL REFERENCES cenapro.source_location(code),

  weight_kg              numeric NOT NULL CHECK (weight_kg > 0),         -- was WT

  disposition_kind       text NOT NULL
                           CHECK (disposition_kind IN ('flec_bagging','partner_crusher','partner_kiln')),
  partner_equipment_code text REFERENCES cenapro.partner_equipment(code),
  flec_count             integer CHECK (flec_count IS NULL OR flec_count > 0),  -- bag count; was FLEC AMT

  whse_side              text CHECK (whse_side IS NULL OR whse_side IN ('LS','RS')),  -- only for WHSE 1/2/5/7
  flec_stat              text,                                           -- legacy 'DONE'; imported, never written/validated

  unique_tag             text NOT NULL UNIQUE,                           -- computed at write; audit/export parity only (§7.1)
  notes                  text,

  -- provenance + canonicalize-at-write pattern (architecture-reference)
  source_row             int,                                            -- original .xlsb row, for backfill traceability
  provenance             text NOT NULL DEFAULT 'cenapro_xlsb',
  dirty                  boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- Partner rows must name their equipment; flec_bagging rows must not (codo rule 1/2).
  CONSTRAINT production_event_partner_equipment_presence CHECK (
    (disposition_kind = 'flec_bagging'  AND partner_equipment_code IS NULL)
    OR
    (disposition_kind <> 'flec_bagging' AND partner_equipment_code IS NOT NULL)
  ),
  -- batch_year sanity bound (charcoal ops; data starts 2025).
  CONSTRAINT production_event_batch_year_range CHECK (batch_year BETWEEN 2000 AND 2100)
);

COMMENT ON TABLE cenapro.production_event IS
  'CI production spine — one row per workbook Production row (DVO rows excluded in v1). '
  'Surrogate uuid id is the real identity; unique_tag is audit/export parity only.';
COMMENT ON COLUMN cenapro.production_event.batch IS
  'Raw month label from the workbook (e.g. MAY). NOT derived from prod_date (same-day month-boundary rows exist — codo rule 10).';
COMMENT ON COLUMN cenapro.production_event.batch_year IS
  'DIVERGENCE from design doc (Renzo, 2026-06-01): the year that disambiguates `batch`. Effective batch identity is '
  '(batch, batch_year). Auto-derived from recv_date by tr_cenapro_pe_unique_tag when NULL/not supplied. unique_tag keeps '
  'byte-for-byte workbook parity (Excel-serial dates already encode the year); batch_year is the queryable identity column. '
  'See idx_cenapro_pe_batch_identity.';
COMMENT ON COLUMN cenapro.production_event.unique_tag IS
  'Computed-at-write 10-segment workbook tag (byte-for-byte parity, Excel-serial dates). Audit/export only — NEVER a join key. Collisions on backfill go to drift_log.';

-- Indexes (design doc §4.2) + the batch-identity index for the batch_year divergence.
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_warehouse_recv   ON cenapro.production_event (warehouse_code, recv_date);
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_grade_side_recv  ON cenapro.production_event (grade_code, whse_side, recv_date); -- ledger window
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_disposition      ON cenapro.production_event (disposition_kind);
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_plant_prod_date  ON cenapro.production_event (plant_code, prod_date);
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_unique_tag       ON cenapro.production_event (unique_tag);
-- DIVERGENCE: effective batch identity is (batch, batch_year) — advisory dedup/lookup index.
CREATE INDEX IF NOT EXISTS idx_cenapro_pe_batch_identity   ON cenapro.production_event (batch, batch_year);

-- =====================================================================================
-- 4. Opening balances — cenapro.warehouse_opening_balance (design doc §4.3)
--    Replaces the workbook STARTING block. Seeds flec_ledger (most-recent opening <= start date).
-- =====================================================================================
CREATE TABLE IF NOT EXISTS cenapro.warehouse_opening_balance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_code     text NOT NULL REFERENCES cenapro.warehouse(code),
  grade_code         text NOT NULL REFERENCES cenapro.grade(code),
  side               text NOT NULL CHECK (side IN ('LS','RS')),
  period_start_date  date NOT NULL,
  opening_flec_count integer NOT NULL DEFAULT 0 CHECK (opening_flec_count >= 0),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cenapro_wob_natural_key UNIQUE (warehouse_code, grade_code, side, period_start_date)
);

COMMENT ON TABLE cenapro.warehouse_opening_balance IS
  'Flec-count opening balances per (warehouse, grade, side, period_start_date). Seeds cenapro.flec_ledger: '
  'the seed is the most-recent opening with period_start_date <= the ledger start date. WHSE 3 does NOT use this (DVO, deferred).';

CREATE INDEX IF NOT EXISTS idx_cenapro_wob_seed_lookup
  ON cenapro.warehouse_opening_balance (warehouse_code, grade_code, side, period_start_date DESC);

-- =====================================================================================
-- 5. Drift log — cenapro.drift_log (design doc §4.4)
--    Append-only telemetry for every silent-failure path (canonicalize failures, unique_tag
--    collisions, cosmetic WHSE=W6/W7, and every v1-deferred SRC=DVO row).
-- =====================================================================================
CREATE TABLE IF NOT EXISTS cenapro.drift_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,   -- 'unique_tag_collision' | 'whse_w6_w7_cosmetic' | 'dvo_row_deferred' | ...
  source_row  int,             -- original .xlsb row when applicable
  target_id   uuid,            -- production_event.id when applicable
  expected    text,
  actual      text,
  message     text,
  resolved_at timestamptz,
  resolved_by text
);

COMMENT ON TABLE cenapro.drift_log IS
  'Append-only drift/exclusion telemetry. Every canonicalize failure, unique_tag collision, cosmetic WHSE=W6/W7, '
  'and v1-deferred SRC=DVO row lands here (never silently dropped). A human resolves drift; lookups are NEVER auto-created.';

CREATE INDEX IF NOT EXISTS idx_cenapro_drift_unresolved
  ON cenapro.drift_log (detected_at) WHERE resolved_at IS NULL;

-- =====================================================================================
-- 6. unique_tag — compute-at-write (design doc §7.1)
--    compute_unique_tag(production_event) takes the table row type, so it must be defined
--    AFTER the table. BEFORE trigger persists unique_tag + auto-derives batch_year + bumps updated_at.
--
--    Q5 default (design doc §12): byte-for-byte parity → Excel-serial date segments
--    (days since 1899-12-30), blank DVO_SIDE segment preserved.
-- =====================================================================================
CREATE OR REPLACE FUNCTION cenapro.compute_unique_tag(e cenapro.production_event)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('-',
    -- Excel serial = days since 1899-12-30 (1900 date system).
    (e.recv_date - DATE '1899-12-30')::text,
    COALESCE((e.prod_date - DATE '1899-12-30')::text, ''),
    e.batch,
    COALESCE(e.shift_code, ''),
    e.grade_code,
    COALESCE(e.plant_code, ''),
    COALESCE(e.warehouse_code, ''),
    COALESCE(e.whse_side, ''),                 -- blank DVO_SIDE segment preserved for parity
    e.source_location_code,
    CASE WHEN e.disposition_kind = 'flec_bagging' THEN 'FLEC'
         ELSE e.partner_equipment_code END
  );
$$;

COMMENT ON FUNCTION cenapro.compute_unique_tag(cenapro.production_event) IS
  'Computes the 10-segment workbook unique_tag (Excel-serial dates, blank DVO_SIDE segment) for export parity. Audit-only, never a key.';

CREATE OR REPLACE FUNCTION cenapro.fn_set_unique_tag()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- DIVERGENCE (Renzo): auto-derive batch_year from recv_date when the caller did not supply it.
  -- batch_year is NOT NULL with no default, so an INSERT that omits it would fail; we coalesce here.
  -- (A backfill that knows the real campaign year passes it explicitly and this no-ops.)
  IF NEW.batch_year IS NULL THEN
    NEW.batch_year := EXTRACT(YEAR FROM NEW.recv_date)::int;
  END IF;

  NEW.unique_tag := cenapro.compute_unique_tag(NEW);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION cenapro.fn_set_unique_tag() IS
  'BEFORE INSERT/UPDATE on production_event: persists unique_tag, auto-derives batch_year from recv_date when NULL, bumps updated_at.';

DROP TRIGGER IF EXISTS tr_cenapro_pe_unique_tag ON cenapro.production_event;
CREATE TRIGGER tr_cenapro_pe_unique_tag
  BEFORE INSERT OR UPDATE ON cenapro.production_event
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_set_unique_tag();

-- NOTE: because batch_year is NOT NULL and the trigger fills it, the column is technically
-- populated at BEFORE-trigger time (after constraints are checked at statement end), so an
-- INSERT omitting batch_year succeeds. Backfill should still pass batch_year explicitly when
-- the campaign year differs from the recv_date year (year-boundary batches).

-- =====================================================================================
-- 7. Flec ledger — cenapro.flec_ledger(p_warehouse_code, p_start_date) (design doc §6.1)
--    THE central Blackwood divergence from codo: WHSE 1/2/5/7 running balance in SQL with a
--    window function (no balance math in TS). Start-date-scoped set-returning function:
--      - seed   = most-recent warehouse_opening_balance with period_start_date <= p_start_date
--      - rows   = events with recv_date >= p_start_date only (no double-count)
--      - balance= seed + windowed SUM(flec_in - flec_out) per (grade, side)
--    Direction derived from typed columns (NOT the workbook unique_tag substring trick).
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
  kg_moved               numeric,   -- per-row kg (NOT summed forward; codo §4.5)
  flec_in                integer,
  flec_out               integer,
  opening_seed           integer,   -- baseline as of p_start_date, per (grade, side)
  flec_in_to_date        bigint,    -- cumulative ins from p_start_date forward
  flec_out_to_date       bigint,    -- cumulative outs from p_start_date forward
  running_balance        bigint     -- opening_seed + cumulative (in - out)
)
LANGUAGE sql
STABLE
SECURITY INVOKER
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
      -- direction derived from typed columns (NOT the unique_tag substring trick)
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
    WHERE w.default_unit = 'flec_count'                 -- WHSE 1/2/5/7 only
      AND pe.warehouse_code = p_warehouse_code          -- the chosen warehouse
      AND pe.whse_side IS NOT NULL
      AND pe.recv_date >= p_start_date                  -- START-DATE FLOOR: rows from the start date forward
      AND (
           (pe.disposition_kind = 'flec_bagging')
        OR (pe.disposition_kind IN ('partner_crusher','partner_kiln') AND sl.kind = 'warehouse_flec')
      )
  ),
  seeded AS (
    SELECT wr.*,
           -- SEED: most-recent opening balance dated on/before the user's start date.
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

COMMENT ON FUNCTION cenapro.flec_ledger(text, date) IS
  'WHSE 1/2/5/7 flec-count ledger, scoped to (p_warehouse_code, p_start_date). '
  'opening_seed = most-recent warehouse_opening_balance with period_start_date <= p_start_date, per (grade, side); '
  'rows are events with recv_date >= p_start_date; running_balance = opening_seed + windowed SUM(flec_in - flec_out). '
  'No double-count: pre-start movements live in the seed, not the rows. Direction derived from disposition_kind + source kind '
  '(not the workbook substring trick). kg shown per-row, never summed forward. Start date is the deliberate period-filter hook.';

GRANT EXECUTE ON FUNCTION cenapro.flec_ledger(text, date) TO authenticated, service_role;

-- =====================================================================================
-- 8. Current-balance summary — cenapro.flec_balance(p_warehouse_code, p_start_date) (§6.2)
--    Last running_balance per (grade, side) for the period; wraps flec_ledger.
-- =====================================================================================
CREATE OR REPLACE FUNCTION cenapro.flec_balance(
  p_warehouse_code text,
  p_start_date     date
)
RETURNS TABLE (
  warehouse_code text,
  grade_code     text,
  side           text,
  current_flec   bigint,   -- last running_balance for the (grade, side) within the period
  opening_seed   integer,  -- the period's baseline (as of p_start_date)
  as_of          date      -- recv_date of the latest counted row
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (l.grade_code, l.side)
    l.warehouse_code, l.grade_code, l.side,
    l.running_balance AS current_flec,
    l.opening_seed,
    l.recv_date       AS as_of
  FROM cenapro.flec_ledger(p_warehouse_code, p_start_date) l
  ORDER BY l.grade_code, l.side, l.recv_date DESC, l.id DESC;
$$;

COMMENT ON FUNCTION cenapro.flec_balance(text, date) IS
  'Closing flec balance per (grade, side) for (p_warehouse_code, p_start_date) — the last running_balance row from '
  'cenapro.flec_ledger. Inherits the start-date scope (period close, not all-time). A (grade, side) with an opening but no '
  'events >= p_start_date produces no row; the adapter should left-join the opening seed set to show current_flec = opening_seed.';

GRANT EXECUTE ON FUNCTION cenapro.flec_balance(text, date) TO authenticated, service_role;

-- =====================================================================================
-- 9. Production daily summary — cenapro.view_production_daily (design doc §6.3)
--    On-demand GROUP BY pivot of weight_kg by disposition bucket. Cross-check only; never persisted.
-- =====================================================================================
CREATE OR REPLACE VIEW cenapro.view_production_daily
WITH (security_invoker = true)
AS
SELECT
  pe.plant_code,
  pe.prod_date,
  pe.batch,
  pe.batch_year,                                                            -- DIVERGENCE: surface the disambiguating year
  pe.source_location_code AS tnk_or_source,
  pe.shift_code,
  pe.grade_code,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'C1')                          AS c1_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'C2')                          AS c2_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'C3')                          AS c3_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'C4')                          AS c4_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'RK1')                         AS rk1_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'RK2')                         AS rk2_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'RK3')                         AS rk3_kg,
  SUM(pe.weight_kg) FILTER (WHERE pq.code = 'RK4')                         AS rk4_kg,
  SUM(pe.weight_kg) FILTER (WHERE pe.disposition_kind = 'flec_bagging')    AS flec_kg,
  SUM(pe.weight_kg)                                                        AS total_kg
FROM cenapro.production_event pe
LEFT JOIN cenapro.partner_equipment pq ON pq.code = pe.partner_equipment_code
GROUP BY pe.plant_code, pe.prod_date, pe.batch, pe.batch_year, pe.source_location_code, pe.shift_code, pe.grade_code;

COMMENT ON VIEW cenapro.view_production_daily IS
  'On-demand pivot of production_event.weight_kg by (plant, prod_date, batch, batch_year, source, shift, grade) across '
  'disposition buckets. Reproduces W6/W7 Summary tabs for cross-check; never persisted. Monthly rollup = wrap in '
  'DATE_TRUNC(''month'', prod_date).';

-- =====================================================================================
-- 10. Grants — mirror ICTC's production-module pattern (design doc §4.5). NO RLS in v1.
--     USAGE on schema; SELECT/INSERT/UPDATE/DELETE on tables for authenticated + service_role;
--     SELECT for anon; default privileges so future cenapro tables inherit grants;
--     SELECT on the view; EXECUTE on the functions (granted inline above).
-- =====================================================================================
GRANT USAGE ON SCHEMA cenapro TO authenticated, anon, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA cenapro TO authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA cenapro TO anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA cenapro
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA cenapro
  GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA cenapro
  GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

-- The view is a relation; ALL TABLES above covers it, but grant explicitly for clarity/parity.
GRANT SELECT ON cenapro.view_production_daily TO authenticated, anon, service_role;

-- =====================================================================================
-- 11. PostgREST exposure (design doc §2.2) — make cenapro reachable from supabase-js.
--     On managed Supabase the canonical control is the dashboard (Settings -> API ->
--     Exposed schemas). We ALSO set it at the role level here; whichever the platform honors,
--     the grants above make the schema query-ready. If the dashboard later overrides this,
--     Renzo must add `cenapro` to the Exposed schemas list manually.
-- =====================================================================================
DO $$
BEGIN
  -- Append 'cenapro' to the authenticator role's pgrst.db_schemas if not already present.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles r
    LEFT JOIN LATERAL unnest(r.rolconfig) AS cfg(setting) ON true
    WHERE r.rolname = 'authenticator'
      AND cfg.setting LIKE 'pgrst.db_schemas=%cenapro%'
  ) THEN
    BEGIN
      ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, cenapro';
    EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
      RAISE NOTICE 'Could not ALTER ROLE authenticator (insufficient privilege). Expose cenapro via Dashboard -> Settings -> API -> Exposed schemas.';
    END;
  END IF;
END $$;

-- Ask PostgREST to reload its config so the schema change takes effect without a restart.
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
