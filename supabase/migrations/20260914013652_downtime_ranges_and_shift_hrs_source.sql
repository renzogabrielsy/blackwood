-- ============================================================================
-- L-051 (2026-09-14) — production_downtime: keep the operator's OWN list of stop
-- times, and say WHY the shift is as long as it is.
--
-- THE BUG. MC's downtime block records each stoppage twice: as a LIST of time ranges
-- (column C) and as a hand-written DURATION total (column E). The extractor read only
-- the DURATION. From 2026-08-01 MC stopped filling it, so August published 0.0 downtime
-- hours across 23 of 23 rows and September 0.0 across 10 of 10 — beside a fully-written
-- list of stoppages (2026-09-03 states 8:00-8:07 and 9:50-11:41 = 118 minutes). Even
-- while the DURATION cell WAS filled it normally summarised only the FIRST range
-- (2026-07-04: `7 MINUTES` against a real 7 + 70 = 77), so July was understated too.
--
-- The extractor now reads the LIST and treats the DURATION as a cross-check. Two
-- additive columns make that readable and auditable from the database alone:
--
--   dt_ranges         the list verbatim, so the arithmetic can be checked without
--                     reopening the workbook. NEVER an input to any calculation.
--   shift_hrs_source  why `shift_hrs` is what it is. It used to be the literal 12 on
--                     every row the sync wrote; no cell in the workbook states the shift
--                     length, so it is now DERIVED (12 h on a day with an overtime
--                     signal, otherwise 8 h) and the basis travels with the number.
--
-- Nothing is dropped, no existing column changes type, no view or function that reads
-- this table is touched — the downtime fold in view_production_daily and the analytics
-- views simply start seeing the real minutes.
-- ============================================================================

ALTER TABLE public.production_downtime
  ADD COLUMN IF NOT EXISTS dt_ranges text,
  ADD COLUMN IF NOT EXISTS shift_hrs_source text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.production_downtime'::regclass
       AND conname = 'production_downtime_shift_hrs_source_check'
  ) THEN
    ALTER TABLE public.production_downtime
      ADD CONSTRAINT production_downtime_shift_hrs_source_check
      CHECK (shift_hrs_source IS NULL
             OR shift_hrs_source IN ('overtime_signal', 'duration_only', 'default_8h'));
  END IF;
END $$;

COMMENT ON COLUMN public.production_downtime.dt_ranges IS
  'L-051 (2026-09-14). The stop-and-start times exactly as MC wrote them in the downtime '
  'block''s time-range column, lines joined with "; " (e.g. "8:00-8:07; 9:50-11:41"). This '
  'is the SOURCE of dt_hrs/dt_mins and exists so the arithmetic can be checked against the '
  'operator''s own words without reopening the workbook. NEVER an input to any calculation, '
  'view or trigger. NULL on a row filed before 2026-09-14 and on a day whose time-range '
  'cell was blank.';

COMMENT ON COLUMN public.production_downtime.shift_hrs_source IS
  'L-051 (2026-09-14). Why shift_hrs carries the value it does. NO CELL IN MC''S WORKBOOK '
  'STATES THE SHIFT LENGTH (both surviving workbooks were scanned), so it is derived: '
  '"overtime_signal" = the day ran overtime (a runs row labelled OVERTIME with kilos, or '
  'the CHARCOAL FED OVERTIME row carrying sacks) and shift_hrs is 12; "default_8h" = no '
  'overtime signal, shift_hrs is 8, and the downtime minutes were read from the time '
  'ranges; "duration_only" = no overtime signal, shift_hrs is 8, and the minutes came from '
  'the hand-written DURATION cell because no time range could be read — recorded '
  'distinctly because that cell has been measured to summarise only the first stoppage. '
  'NULL on a row filed before 2026-09-14. NOTE the 158 rows backfilled from MASTER ICTC '
  'INPUT FILE V1.xlsx (2025-11-27 … 2026-05-23) carry shift_hrs = 9 and are Renzo''s own '
  'figures; they are deliberately left alone.';

-- ── fn_apply_production_upstream — the two new columns join the allowlist ──────
-- The sync's ONLY update path into these tables refuses the WHOLE op on one unknown key,
-- so a column the classifier can diff must be a column this function can write. Only the
-- `allowed` CTE and the production_downtime UPDATE change; every guard, every other
-- table and the return shape are byte-identical to migration 20260803* / 20260814*.
CREATE OR REPLACE FUNCTION public.fn_apply_production_upstream(p_ops jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' THEN
    RAISE EXCEPTION 'fn_apply_production_upstream: p_ops must be a JSON array (got %)',
      COALESCE(jsonb_typeof(p_ops), 'null');
  END IF;
  IF jsonb_array_length(p_ops) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) o
              WHERE NULLIF(o ->> 'table', '') IS NULL OR NULLIF(o ->> 'id', '') IS NULL) THEN
    RAISE EXCEPTION 'fn_apply_production_upstream: every op needs a table and an id';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) o
              WHERE (o ->> 'table') NOT IN ('production_runs', 'production_downtime',
                                            'production_waste', 'electricity_readings',
                                            'truck_readings')) THEN
    RAISE EXCEPTION 'fn_apply_production_upstream: unknown or non-updatable table in p_ops';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) o
              WHERE o ? 'patch' AND jsonb_typeof(o -> 'patch') <> 'object') THEN
    RAISE EXCEPTION 'fn_apply_production_upstream: patch must be a JSON object';
  END IF;

  WITH ops AS (
    SELECT
      (o ->> 'table')                       AS tbl,
      (o ->> 'id')::uuid                    AS id,
      COALESCE(o -> 'patch', '{}'::jsonb)   AS patch
    FROM jsonb_array_elements(p_ops) o
  ),
  -- The per-table column allowlist. Anything else refuses the whole op.
  allowed(tbl, col) AS (VALUES
    ('production_runs',      'customer'),
    ('production_runs',      'grade'),
    ('production_runs',      'ttl_kg'),
    ('production_runs',      'sacks_bags'),
    ('production_runs',      'remarks'),
    ('production_downtime',  'shift_hrs'),
    ('production_downtime',  'dt_hrs'),
    ('production_downtime',  'dt_mins'),
    ('production_downtime',  'dt_reason'),
    ('production_downtime',  'dt_ranges'),        -- L-051
    ('production_downtime',  'shift_hrs_source'), -- L-051
    ('production_waste',     'rs1a_kg'),
    ('production_waste',     'rs1b_kg'),
    ('production_waste',     'bf_kg'),
    ('production_waste',     'rs23_kg'),
    ('production_waste',     'rs5_kg'),
    ('production_waste',     'trml1_kg'),
    ('production_waste',     'trml2_kg'),
    ('production_waste',     'grit_kg'),
    ('production_waste',     'remarks'),
    ('electricity_readings', 'start_kwh'),
    ('electricity_readings', 'end_kwh'),
    ('electricity_readings', 'meter_multiplier'),
    ('electricity_readings', 'remarks'),
    ('truck_readings',       'start_km'),
    ('truck_readings',       'end_km'),
    ('truck_readings',       'fuel_liters'),
    ('truck_readings',       'remarks')
  ),
  bad AS (
    SELECT DISTINCT o.tbl, o.id
      FROM ops o
      CROSS JOIN LATERAL jsonb_object_keys(o.patch) AS k(col)
     WHERE NOT EXISTS (SELECT 1 FROM allowed a WHERE a.tbl = o.tbl AND a.col = k.col)
  ),
  -- Writable ops: a non-empty, fully-allowlisted patch.
  w AS (
    SELECT o.* FROM ops o
     WHERE o.patch <> '{}'::jsonb
       AND NOT EXISTS (SELECT 1 FROM bad b WHERE b.tbl = o.tbl AND b.id = o.id)
  ),
  -- PRE-write snapshot of every targeted row, for classifying whatever did NOT write.
  -- Read in the same statement, so it sees the state the guards saw.
  snap AS (
    SELECT 'production_runs'::text AS tbl, t.id, t.human_edited_at
      FROM public.production_runs t
     WHERE t.id IN (SELECT id FROM ops WHERE tbl = 'production_runs')
    UNION ALL
    SELECT 'production_downtime', t.id, t.human_edited_at
      FROM public.production_downtime t
     WHERE t.id IN (SELECT id FROM ops WHERE tbl = 'production_downtime')
    UNION ALL
    SELECT 'production_waste', t.id, t.human_edited_at
      FROM public.production_waste t
     WHERE t.id IN (SELECT id FROM ops WHERE tbl = 'production_waste')
    UNION ALL
    SELECT 'electricity_readings', t.id, t.human_edited_at
      FROM public.electricity_readings t
     WHERE t.id IN (SELECT id FROM ops WHERE tbl = 'electricity_readings')
    UNION ALL
    SELECT 'truck_readings', t.id, t.human_edited_at
      FROM public.truck_readings t
     WHERE t.id IN (SELECT id FROM ops WHERE tbl = 'truck_readings')
  ),
  u_runs AS (
    UPDATE public.production_runs t
       SET customer   = CASE WHEN o.patch ? 'customer'
                             THEN COALESCE(NULLIF(o.patch ->> 'customer', ''), t.customer)
                             ELSE t.customer END,
           grade      = CASE WHEN o.patch ? 'grade'
                             THEN COALESCE(NULLIF(o.patch ->> 'grade', ''), t.grade)
                             ELSE t.grade END,
           ttl_kg     = CASE WHEN o.patch ? 'ttl_kg'
                             THEN COALESCE(NULLIF(o.patch ->> 'ttl_kg', '')::numeric, t.ttl_kg)
                             ELSE t.ttl_kg END,
           sacks_bags = CASE WHEN o.patch ? 'sacks_bags'
                             THEN NULLIF(o.patch ->> 'sacks_bags', '')::integer
                             ELSE t.sacks_bags END,
           remarks    = CASE WHEN o.patch ? 'remarks'
                             THEN NULLIF(o.patch ->> 'remarks', '')
                             ELSE t.remarks END
      FROM w o
     WHERE o.tbl = 'production_runs'
       AND t.id  = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  ),
  u_downtime AS (
    UPDATE public.production_downtime t
       SET shift_hrs = CASE WHEN o.patch ? 'shift_hrs'
                            THEN COALESCE(NULLIF(o.patch ->> 'shift_hrs', '')::numeric, t.shift_hrs)
                            ELSE t.shift_hrs END,
           dt_hrs    = CASE WHEN o.patch ? 'dt_hrs'
                            THEN COALESCE(NULLIF(o.patch ->> 'dt_hrs', '')::numeric, t.dt_hrs)
                            ELSE t.dt_hrs END,
           dt_mins   = CASE WHEN o.patch ? 'dt_mins'
                            THEN COALESCE(NULLIF(o.patch ->> 'dt_mins', '')::numeric, t.dt_mins)
                            ELSE t.dt_mins END,
           dt_reason = CASE WHEN o.patch ? 'dt_reason'
                            THEN NULLIF(o.patch ->> 'dt_reason', '')
                            ELSE t.dt_reason END,
           -- L-051. Both are plain text and both are allowed to become NULL: a day whose
           -- time-range cell is genuinely blank must be able to CLEAR a stale list, which
           -- is why these use NULLIF and not the COALESCE-keep shape the numerics use.
           dt_ranges = CASE WHEN o.patch ? 'dt_ranges'
                            THEN NULLIF(o.patch ->> 'dt_ranges', '')
                            ELSE t.dt_ranges END,
           shift_hrs_source = CASE WHEN o.patch ? 'shift_hrs_source'
                            THEN NULLIF(o.patch ->> 'shift_hrs_source', '')
                            ELSE t.shift_hrs_source END
      FROM w o
     WHERE o.tbl = 'production_downtime'
       AND t.id  = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  ),
  u_waste AS (
    UPDATE public.production_waste t
       SET rs1a_kg  = CASE WHEN o.patch ? 'rs1a_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'rs1a_kg', '')::numeric, t.rs1a_kg)
                           ELSE t.rs1a_kg END,
           rs1b_kg  = CASE WHEN o.patch ? 'rs1b_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'rs1b_kg', '')::numeric, t.rs1b_kg)
                           ELSE t.rs1b_kg END,
           bf_kg    = CASE WHEN o.patch ? 'bf_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'bf_kg', '')::numeric, t.bf_kg)
                           ELSE t.bf_kg END,
           rs23_kg  = CASE WHEN o.patch ? 'rs23_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'rs23_kg', '')::numeric, t.rs23_kg)
                           ELSE t.rs23_kg END,
           rs5_kg   = CASE WHEN o.patch ? 'rs5_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'rs5_kg', '')::numeric, t.rs5_kg)
                           ELSE t.rs5_kg END,
           trml1_kg = CASE WHEN o.patch ? 'trml1_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'trml1_kg', '')::numeric, t.trml1_kg)
                           ELSE t.trml1_kg END,
           trml2_kg = CASE WHEN o.patch ? 'trml2_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'trml2_kg', '')::numeric, t.trml2_kg)
                           ELSE t.trml2_kg END,
           grit_kg  = CASE WHEN o.patch ? 'grit_kg'
                           THEN COALESCE(NULLIF(o.patch ->> 'grit_kg', '')::numeric, t.grit_kg)
                           ELSE t.grit_kg END,
           remarks  = CASE WHEN o.patch ? 'remarks'
                           THEN NULLIF(o.patch ->> 'remarks', '')
                           ELSE t.remarks END
      FROM w o
     WHERE o.tbl = 'production_waste'
       AND t.id  = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  ),
  u_elec AS (
    UPDATE public.electricity_readings t
       SET start_kwh        = CASE WHEN o.patch ? 'start_kwh'
                                   THEN COALESCE(NULLIF(o.patch ->> 'start_kwh', '')::numeric, t.start_kwh)
                                   ELSE t.start_kwh END,
           end_kwh          = CASE WHEN o.patch ? 'end_kwh'
                                   THEN COALESCE(NULLIF(o.patch ->> 'end_kwh', '')::numeric, t.end_kwh)
                                   ELSE t.end_kwh END,
           meter_multiplier = CASE WHEN o.patch ? 'meter_multiplier'
                                   THEN COALESCE(NULLIF(o.patch ->> 'meter_multiplier', '')::numeric, t.meter_multiplier)
                                   ELSE t.meter_multiplier END,
           remarks          = CASE WHEN o.patch ? 'remarks'
                                   THEN NULLIF(o.patch ->> 'remarks', '')
                                   ELSE t.remarks END
      FROM w o
     WHERE o.tbl = 'electricity_readings'
       AND t.id  = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  ),
  u_trucks AS (
    UPDATE public.truck_readings t
       SET start_km    = CASE WHEN o.patch ? 'start_km'
                              THEN COALESCE(NULLIF(o.patch ->> 'start_km', '')::numeric, t.start_km)
                              ELSE t.start_km END,
           end_km      = CASE WHEN o.patch ? 'end_km'
                              THEN COALESCE(NULLIF(o.patch ->> 'end_km', '')::numeric, t.end_km)
                              ELSE t.end_km END,
           fuel_liters = CASE WHEN o.patch ? 'fuel_liters'
                              THEN NULLIF(o.patch ->> 'fuel_liters', '')::numeric
                              ELSE t.fuel_liters END,
           remarks     = CASE WHEN o.patch ? 'remarks'
                              THEN NULLIF(o.patch ->> 'remarks', '')
                              ELSE t.remarks END
      FROM w o
     WHERE o.tbl = 'truck_readings'
       AND t.id  = o.id
       AND t.human_edited_at IS NULL
    RETURNING t.id
  ),
  done AS (
    SELECT 'production_runs'::text AS tbl, id FROM u_runs
    UNION ALL SELECT 'production_downtime',  id FROM u_downtime
    UNION ALL SELECT 'production_waste',     id FROM u_waste
    UNION ALL SELECT 'electricity_readings', id FROM u_elec
    UNION ALL SELECT 'truck_readings',       id FROM u_trucks
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'table',   o.tbl,
           'id',      o.id,
           'outcome', CASE
             WHEN d.id IS NOT NULL THEN 'applied'
             WHEN EXISTS (SELECT 1 FROM bad b WHERE b.tbl = o.tbl AND b.id = o.id)
               THEN 'unsupported_field'
             WHEN o.patch = '{}'::jsonb THEN 'empty_patch'
             WHEN s.id IS NULL THEN 'missing'
             WHEN s.human_edited_at IS NOT NULL THEN 'human_edited'
             ELSE 'not_applied'
           END
         ) ORDER BY o.tbl, o.id), '[]'::jsonb)
    INTO v_result
    FROM ops o
    LEFT JOIN done d ON d.tbl = o.tbl AND d.id = o.id
    LEFT JOIN snap s ON s.tbl = o.tbl AND s.id = o.id;

  RETURN v_result;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_apply_production_upstream(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_apply_production_upstream(jsonb) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_apply_production_upstream(jsonb) TO service_role;
