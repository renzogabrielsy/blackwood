-- ============================================================================
-- L-051b (2026-09-14) — Renzo settled the two questions L-051 left open.
--
-- 1. A NORMAL SHIFT IS NINE HOURS, not eight. `shift_hrs_source` gains
--    'default_9h'; 'default_8h' is RETIRED — nothing emits it any more, and the
--    CHECK keeps accepting it only so a historical row stays readable. The 48
--    rows that carried it are re-derived to 9 / 'default_9h' by
--    `workers/sync/scripts/backfill-downtime-ranges.ts`, through
--    `fn_apply_production_upstream` with one audit row each — never by an UPDATE
--    in this file, because the human-edit latch lives in that function's own
--    WHERE clause and a migration would walk straight past it.
--
-- 2. "NO STOP OPERATION" IS A CONVENTION, NOT FREE TEXT. A range whose reason
--    says the plant did not stop is trouble production RAN THROUGH — an
--    incident, not downtime. Those minutes contribute 0, and the range text is
--    kept in the new `dt_incident_ranges`. `dt_ranges` still holds the FULL
--    verbatim list, so THE RANGES THAT COUNTED ARE `dt_ranges` MINUS
--    `dt_incident_ranges` — one definition, and no existing column changed
--    meaning under a row already written.
--
-- Additive only: no column dropped, no type changed, no view or trigger touched.
-- ============================================================================

ALTER TABLE public.production_downtime
  ADD COLUMN IF NOT EXISTS dt_incident_ranges text;

ALTER TABLE public.production_downtime
  DROP CONSTRAINT IF EXISTS production_downtime_shift_hrs_source_check;

ALTER TABLE public.production_downtime
  ADD CONSTRAINT production_downtime_shift_hrs_source_check
  CHECK (shift_hrs_source IS NULL
         OR shift_hrs_source IN ('overtime_signal', 'duration_only',
                                 'default_9h', 'default_8h'));

COMMENT ON COLUMN public.production_downtime.dt_incident_ranges IS
  'L-051b (2026-09-14). The subset of dt_ranges EXCLUDED from dt_hrs/dt_mins because the '
  'reason on that line says the plant did not stop ("NO STOP OPERATION" and its family) — '
  'trouble production ran through is an incident, not downtime. Same "; " join as '
  'dt_ranges, which still holds the FULL verbatim list, so the ranges that actually '
  'counted are dt_ranges MINUS dt_incident_ranges. Matched PER RANGE BY INDEX (reason line '
  'i marks range i), never swept over the day: on 2026-04-21 the first range is a real '
  '4-minute screen clean and only the second says the plant kept running, and 4 minutes is '
  'exactly what the operator''s own DURATION cell records for that day. NULL when the day '
  'had no incident. Never an input to any calculation.';

COMMENT ON COLUMN public.production_downtime.shift_hrs_source IS
  'L-051 (2026-09-14), values settled by L-051b the same day. Why shift_hrs carries the '
  'value it does. NO CELL IN MC''S WORKBOOK STATES THE SHIFT LENGTH (both surviving '
  'workbooks were scanned), so it is derived: "overtime_signal" = the day ran overtime (a '
  'runs row labelled OVERTIME with kilos, or the CHARCOAL FED OVERTIME row carrying sacks) '
  'and shift_hrs is 12; "default_9h" = no overtime signal, shift_hrs is 9 (a normal shift '
  'is 08:00-17:00 with an hour off — Renzo, 2026-09-14 — which is also what all 158 rows '
  'backfilled from MASTER ICTC INPUT FILE V1.xlsx already said), minutes read from the time '
  'ranges; "duration_only" = the same 9 h, but the minutes came from the hand-written '
  'DURATION cell because no time range could be read, recorded distinctly because that cell '
  'has been measured to summarise only the first stoppage. "default_8h" is RETIRED — it was '
  'emitted for one day on 2026-09-14 before the shift length was settled, nothing writes it '
  'now, and the 48 rows that carried it were re-derived to default_9h. NULL on a row filed '
  'before 2026-09-14, including the master-file era (which already carries shift_hrs = 9) '
  'and the 25 rows no surviving workbook covers.';

-- ── fn_apply_production_upstream — dt_incident_ranges joins the allowlist ─────
-- The sync's ONLY update path into these tables refuses the WHOLE op on one unknown key,
-- so a column the classifier can diff must be a column this function can write. Only the
-- `allowed` CTE and the production_downtime UPDATE change; every guard, every other table
-- and the return shape are byte-identical to migration 20260914013652.
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
    ('production_downtime',  'dt_ranges'),
    ('production_downtime',  'dt_incident_ranges'),
    ('production_downtime',  'shift_hrs_source'),
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
  w AS (
    SELECT o.* FROM ops o
     WHERE o.patch <> '{}'::jsonb
       AND NOT EXISTS (SELECT 1 FROM bad b WHERE b.tbl = o.tbl AND b.id = o.id)
  ),
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
           dt_ranges = CASE WHEN o.patch ? 'dt_ranges'
                            THEN NULLIF(o.patch ->> 'dt_ranges', '')
                            ELSE t.dt_ranges END,
           dt_incident_ranges = CASE WHEN o.patch ? 'dt_incident_ranges'
                            THEN NULLIF(o.patch ->> 'dt_incident_ranges', '')
                            ELSE t.dt_incident_ranges END,
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
