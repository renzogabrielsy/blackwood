-- Migration: create_production_tables
-- Creates the 5 core production domain tables for the Production Manager agent.
-- Tables: production_runs, production_downtime, production_waste,
--         electricity_readings, truck_readings
-- No RLS — follows existing pattern (auth enforced at role-check layer via lib/auth.ts).
-- Grants applied in the companion migration 20260527010001_create_production_views.sql.

-- ============================================================
-- 1. production_runs
--    Natural key: (transaction_date, grade, shift)
--    One row per grade per shift — MASTER PROD cols A-F
-- ============================================================
CREATE TABLE IF NOT EXISTS production_runs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_date  date        NOT NULL,
  production_batch  text        NOT NULL,           -- 'MAY', 'JUNE', etc. (month campaign)
  grade             text        NOT NULL,           -- '3X50' | '6X50' | '8X50' | '2X6'
  shift             text        NOT NULL,           -- 'M' | 'E' | 'N'
  ttl_kg            numeric     NOT NULL CHECK (ttl_kg >= 0),
  sacks_bags        integer,                        -- sack/bag count from MC's email
  remarks           text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT production_runs_natural_key UNIQUE (transaction_date, grade, shift),
  CONSTRAINT production_runs_grade_check CHECK (grade IN ('3X50', '6X50', '8X50', '2X6')),
  CONSTRAINT production_runs_shift_check CHECK (shift IN ('M', 'E', 'N'))
);

CREATE INDEX IF NOT EXISTS idx_production_runs_date
  ON production_runs (transaction_date DESC);

COMMENT ON TABLE production_runs IS
  'Daily production output by grade and shift. Natural key: (transaction_date, grade, shift). Source: MC Daily Production Report email + MASTER PROD cols A-F.';

-- ============================================================
-- 2. production_downtime
--    Natural key: (transaction_date, shift)
--    One row per shift — MASTER PROD cols H-O
-- ============================================================
CREATE TABLE IF NOT EXISTS production_downtime (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_date  date        NOT NULL,
  production_batch  text        NOT NULL,
  shift             text        NOT NULL,           -- 'M' | 'E' | 'N'
  shift_hrs         numeric     NOT NULL CHECK (shift_hrs > 0),
  dt_hrs            numeric     NOT NULL DEFAULT 0  CHECK (dt_hrs >= 0),
  dt_mins           numeric     NOT NULL DEFAULT 0  CHECK (dt_mins >= 0 AND dt_mins < 60),
  dt_reason         text,                           -- from MC's email; not in MASTER
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- dt_ttl_hrs and productive_hrs are derived in view_production_daily, not stored
  CONSTRAINT production_downtime_natural_key UNIQUE (transaction_date, shift),
  CONSTRAINT production_downtime_shift_check CHECK (shift IN ('M', 'E', 'N'))
);

CREATE INDEX IF NOT EXISTS idx_production_downtime_date
  ON production_downtime (transaction_date DESC);

COMMENT ON TABLE production_downtime IS
  'Shift downtime records. Natural key: (transaction_date, shift). dt_ttl_hrs and productive_hrs computed in view_production_daily. Source: MC Daily Production Report email + MASTER PROD cols H-O.';

-- ============================================================
-- 3. production_waste
--    Natural key: (transaction_date, shift)
--    8 waste streams + sacks (text) — MASTER PROD cols Q-AK
--    GRIT has no sacks column per design doc.
--    Sacks columns are text because MASTER has mixed types ("3 bags", integers).
-- ============================================================
CREATE TABLE IF NOT EXISTS production_waste (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_date  date        NOT NULL,
  production_batch  text        NOT NULL,
  shift             text        NOT NULL,           -- 'M' | 'E' | 'N'

  -- Stream 1: RS1A
  rs1a_kg           numeric     NOT NULL DEFAULT 0 CHECK (rs1a_kg >= 0),
  rs1a_sacks        text,

  -- Stream 2: RS1B
  rs1b_kg           numeric     NOT NULL DEFAULT 0 CHECK (rs1b_kg >= 0),
  rs1b_sacks        text,

  -- Stream 3: BF (Bag Fines)
  bf_kg             numeric     NOT NULL DEFAULT 0 CHECK (bf_kg >= 0),
  bf_sacks          text,

  -- Stream 4: RS2/3
  rs23_kg           numeric     NOT NULL DEFAULT 0 CHECK (rs23_kg >= 0),
  rs23_sacks        text,

  -- Stream 5: RS5
  rs5_kg            numeric     NOT NULL DEFAULT 0 CHECK (rs5_kg >= 0),
  rs5_sacks         text,

  -- Stream 6: TRML1 (Trommel 1)
  trml1_kg          numeric     NOT NULL DEFAULT 0 CHECK (trml1_kg >= 0),
  trml1_sacks       text,

  -- Stream 7: TRML2 (Trommel 2)
  trml2_kg          numeric     NOT NULL DEFAULT 0 CHECK (trml2_kg >= 0),
  trml2_sacks       text,

  -- Stream 8: GRIT — no sacks column per design doc
  grit_kg           numeric     NOT NULL DEFAULT 0 CHECK (grit_kg >= 0),

  remarks           text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- ttl_waste_kg and prod_loss_pct computed in view_production_daily, not stored
  CONSTRAINT production_waste_natural_key UNIQUE (transaction_date, shift),
  CONSTRAINT production_waste_shift_check CHECK (shift IN ('M', 'E', 'N'))
);

CREATE INDEX IF NOT EXISTS idx_production_waste_date
  ON production_waste (transaction_date DESC);

COMMENT ON TABLE production_waste IS
  '8-stream waste summary per shift. Natural key: (transaction_date, shift). ttl_waste_kg and prod_loss_pct are computed in view_production_daily. Source: Ivy WASTE PRODUCTION REPORT email + MASTER PROD cols Q-AK.';

-- ============================================================
-- 4. electricity_readings
--    Natural key: (reading_date, meter)
--    diff_kwh is a GENERATED ALWAYS column (end - start)
--    meter is text (not enum) — PUMP/MAIN/BUNKHOUSE confirmed; others may exist
-- ============================================================
CREATE TABLE IF NOT EXISTS electricity_readings (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_date     date        NOT NULL,
  meter            text        NOT NULL,            -- 'MAIN' | 'BUNKHOUSE' | 'PUMP' | (others)
  start_kwh        numeric     NOT NULL CHECK (start_kwh >= 0),
  end_kwh          numeric     NOT NULL CHECK (end_kwh >= 0),
  diff_kwh         numeric     GENERATED ALWAYS AS (end_kwh - start_kwh) STORED,
  rate_php_per_kwh numeric     NOT NULL DEFAULT 120 CHECK (rate_php_per_kwh > 0),
  remarks          text,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT electricity_readings_natural_key UNIQUE (reading_date, meter)
);

CREATE INDEX IF NOT EXISTS idx_electricity_readings_date
  ON electricity_readings (reading_date DESC);

COMMENT ON TABLE electricity_readings IS
  'Daily electricity meter readings. Natural key: (reading_date, meter). diff_kwh is computed (end_kwh - start_kwh). Source: MC Daily Production Report email sections 8/9/10.';

-- ============================================================
-- 5. truck_readings
--    Natural key: (reading_date, plate_no)
--    ttl_km is a GENERATED ALWAYS column (end - start)
-- ============================================================
CREATE TABLE IF NOT EXISTS truck_readings (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_date date        NOT NULL,
  plate_no     text        NOT NULL,                -- 'AAV 6111', 'KCA 378', etc.
  start_km     numeric     NOT NULL CHECK (start_km >= 0),
  end_km       numeric     NOT NULL CHECK (end_km >= 0),
  ttl_km       numeric     GENERATED ALWAYS AS (end_km - start_km) STORED,
  fuel_liters  numeric              CHECK (fuel_liters >= 0),
  remarks      text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT truck_readings_natural_key UNIQUE (reading_date, plate_no)
);

CREATE INDEX IF NOT EXISTS idx_truck_readings_date
  ON truck_readings (reading_date DESC);

COMMENT ON TABLE truck_readings IS
  'Daily truck odometer + fuel readings. Natural key: (reading_date, plate_no). ttl_km is computed (end_km - start_km). Source: MC Daily Production Report email section 7.';
