-- =====================================================================
-- ICTC Owner Analytics — PHASE 4 data layer: THE PRODUCTION MATRIX
-- Plan: .agents/plans/ictc-analytics-dashboard-plan.md  (P4 — "the
-- pattern rollout": the same matrix chassis for Production — grades,
-- yield, downtime).
--
-- APPLIED 2026-09-01 as version 20260901142417.
--
-- TWO views. No new tables. Nothing that already has a definition is
-- re-derived:
--   * WHAT WAS PRODUCED is `view_rc_movement_production_monthly` — the
--     existing (month x grade) one-definition. The monthly headline is
--     its own SUM and the grade view is built directly ON it, so the two
--     cannot disagree with each other, with `view_rc_movement_yield_monthly`,
--     or with the RC Movement screen. Proven: 0 mismatches / 10 of 10
--     months against BOTH existing views, max gap 0.0 kg.
--   * WHAT DOWNTIME MEANS is `view_production_daily.dt_total_hrs`
--     (`COALESCE(dt_hrs,0) + COALESCE(dt_mins,0)/60.0`) — the existing
--     SQL fold, mirrored client-side by `daily/ledger-derive.ts`. It is
--     SELECTed here, never restated, so a third spelling cannot appear.
--   * WHAT A REPORTED PRODUCTION DAY IS, is
--     `view_digest_stream_reported_days` (stream = 'production') — which
--     OWNS the "a production day is a day with a production_runs child"
--     rule. Reuse is FREE: the view is a UNION ALL over a constant
--     `stream` literal, so the planner prunes the other four branches to
--     `One-Time Filter: false` (measured: 12 shared buffers, 0.9 ms).
--
-- POSTURE (identical to P1/P2/P3, template 20260901115129):
--   security_invoker · SELECT to `authenticated` only · anon REVOKEd ·
--   NOT granted to service_role (the sync worker reads neither of these;
--   L-044's arrow direction — a consumer is not a dependency).
--   `scripts/verify-worker-view-grants.ts` must still read 4 views / 0
--   findings after this migration.
--
-- NO PESO COLUMN EXISTS HERE AND NONE IS DERIVABLE. That is deliberate,
-- not incidental: production is the one module of the platform with no
-- money in it at all (`app/(app)/production/CONTEXT.md`), so the whole
-- production matrix — grades, tonnage, downtime, power intensity — stays
-- visible to the Production role with no `canViewPrices()` gate and no
-- nulling in the server action. The money that MEETS production
-- (P/kg fed, P per produced kg) already lives in P2's
-- `view_analytics_cost_monthly` and is gated there.
--
-- WINDOWING: none. Measured row counts: 18 rows all-history for the
-- monthly view, 39 for the grade view. Three orders of magnitude under
-- PostgREST's 1000-row cap, so a whole-history read is safe — but the
-- cap is real (the RC IN drill-down lesson), so the page should still
-- fold these reads into its `truncated` test.
--
-- ---------------------------------------------------------------------
-- FOUR MEASURED FACTS THIS MIGRATION EXISTS TO KEEP VISIBLE. Each one is
-- a figure that is WRONG-LOOKING-RIGHT or RIGHT-LOOKING-WRONG, and each
-- gets a companion column rather than a silent correction.
--
-- (1) ONE ELECTRICITY READING IS MIS-KEYED AND IT IS 97% OF ITS MONTH.
--     2026-03-01 / MAIN reads start_kwh = 0.0, end_kwh = 5641.2 — a
--     start that was never filled in, against an end that belongs to
--     2026-03-03 (2026-03-02 and -03 correctly re-walk 5629.9 -> 5641.2).
--     x120 multiplier, that single row publishes 676,944 kWh into a
--     month whose true consumption is ~20,000, taking 2026-03 to 696,924
--     kWh against 30,996 in February and 16,572 in April. An intensity
--     computed on it reads 0.7630 kWh/kg where the neighbours read 0.03.
--     The detector is STRUCTURAL, not a hardcoded date: a start of 0 is
--     only a genuine meter reset if the counter WRAPPED, i.e. this row's
--     end is BELOW the meter's previous end. Measured over all 818
--     readings the rule fires on exactly ONE row — this one — and
--     correctly clears 2026-03-04 (start 0.0, end 2.7 after 5641.2),
--     which is a real rollover. `kwh` still publishes the plain sum so
--     it can never disagree with `view_digest_daily_power`; the derived
--     `kwh_per_produced_kg` is NULL rather than wrong whenever a suspect
--     reading is present, and `kwh_per_produced_kg_excl_suspect` gives
--     the honest estimate (2026-03: 0.0219, not 0.7630).
--     NOTHING IS REPAIRED HERE. Fixing the reading is Renzo's call and a
--     separate, audited write.
--
-- (2) AUGUST 2026 READS ZERO DOWNTIME AND IT IS NOT A PERFECT MONTH.
--     All 23 of its downtime rows carry a REPAIR reason — "CLEANED
--     SCREEN RS 2A AND RS 2B" and so on — and all 23 carry dt_hrs = 0
--     AND dt_mins = 0. The work was recorded; the DURATION stopped being
--     filled in. A matrix row printing 0.00 hours would read as the best
--     month ever recorded. The two halves of the report drifted apart in
--     both directions and the history says so exactly: Nov 2025 - Apr
--     2026 recorded durations and NOT ONE reason; reasons begin in May
--     2026 (5 of 22); Jun/Jul record both; Aug records reason only, 23
--     of 23. So `downtime_shifts_reason_only` is the column that keeps a
--     zero honest, and it is a count of a real pattern, not a threshold.
--
-- (3) SACKS DID NOT EXIST BEFORE MAY 2026. Zero of the 179 runs from Nov
--     2025 through Apr 2026 carry `sacks_bags`; May 2026 carries 1 of
--     38 (2.63%), June 36 of 38, July 44 of 44, August 33 of 33. So
--     `sacks` is NULL — never 0 — on a month where no run recorded any,
--     because "we did not count bags" and "we produced no bags" are
--     different answers and 0 asserts the second. `sacks_coverage_pct`
--     is a real measured number even when it is 0.00, and May's 2.63%
--     is what tells a reader that its 270 bags describe one run out of
--     thirty-eight.
--
-- (4) NOVEMBER 2025 IS A THREE-DAY PRODUCTION MONTH INSIDE A FULL MONTH
--     OF METERING. Production reporting began 2025-11-27; the meters ran
--     all month. So 2025-11 divides 24 days of power by 3 days of
--     output and reads 1.2766 kWh/kg against ~0.05 everywhere else — a
--     25x artefact that would be the biggest mover on any board.
--     It is deliberately NOT nulled, and the distinction from (1) is the
--     whole point: March's kWh is FACTUALLY WRONG, so its ratio is
--     suppressed; November's kWh is FACTUALLY RIGHT and merely NOT
--     COMPARABLE, so it is published beside `power_days` (24),
--     `reported_days` (3) and `first_reported_date` (2025-11-27), which
--     say why. Suppressing a correct number is how a data layer starts
--     lying; the page's existing first-period callout guard (P2) is the
--     right place for the rest.
-- ---------------------------------------------------------------------
--
-- THE SPINE IS PRODUCTION MONTHS *UNION* ELECTRICITY MONTHS, and that is
-- a decision worth stating. Production reporting starts 2025-11; the
-- meters start 2025-03, so eight months carry power and no output. A
-- production-months-only spine would have dropped 577,438 kWh out of a
-- view that has a kWh column — the silent hole this codebase keeps
-- learning about. They are included, flagged `production_reported =
-- false`, with every production figure NULL rather than 0. An exclusion
-- can be forgotten by a UI; a row cannot. A page that wants the ten
-- production months filters one boolean.
-- =====================================================================


-- ---------------------------------------------------------------------
-- view_analytics_production_monthly
-- ---------------------------------------------------------------------
-- Grain: one row per calendar month, all history.
--
-- `produced_kg` is the SUM of the existing (month x grade) view and is
-- NULL — never 0 — on a month with no production runs, the same
-- structural-zero rule P2 applied to `yield_pct`: 0 would claim the
-- plant ran and made nothing.
--
-- `reported_days` is PRODUCTION'S OWN denominator — days on which
-- production reported — and NOT the flow view's working days. The two
-- are different questions and mixing them is how a per-day figure
-- silently changes meaning. `produced_per_reported_day` normalises
-- output for a short month without inventing a calendar.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_production_monthly
WITH (security_invoker = true) AS
WITH shifts AS (
  SELECT
    date_trunc('month', ps.transaction_date)::date AS month_start,
    count(*)::int                                  AS shift_count,
    min(ps.transaction_date)                       AS first_reported_date,
    max(ps.transaction_date)                       AS last_reported_date
  FROM public.production_shifts ps
  GROUP BY 1
),
-- The downtime fold is SELECTed from view_production_daily, never
-- restated. dt_total_hrs is 0 (not NULL) on a shift with no downtime
-- record, so the FILTER on dt_hrs IS NOT NULL is what separates "no
-- downtime happened" from "no downtime was reported".
downtime AS (
  SELECT
    date_trunc('month', vpd.transaction_date)::date                   AS month_start,
    sum(vpd.dt_total_hrs) FILTER (WHERE vpd.dt_hrs IS NOT NULL)       AS downtime_hrs,
    count(*) FILTER (WHERE vpd.dt_hrs IS NOT NULL)::int               AS downtime_shift_count,
    count(*) FILTER (WHERE vpd.dt_hrs > 0 OR vpd.dt_mins > 0)::int    AS downtime_shifts_with_duration,
    count(*) FILTER (WHERE vpd.dt_reason IS NOT NULL
                       AND vpd.dt_hrs = 0 AND vpd.dt_mins = 0)::int   AS downtime_shifts_reason_only
  FROM public.view_production_daily vpd
  GROUP BY 1
),
runs AS (
  SELECT
    date_trunc('month', ps.transaction_date)::date                AS month_start,
    count(*)::int                                                 AS run_count,
    count(*) FILTER (WHERE pr.sacks_bags IS NOT NULL)::int         AS runs_with_sacks,
    sum(pr.sacks_bags)::bigint                                     AS sacks
  FROM public.production_runs pr
  JOIN public.production_shifts ps ON ps.id = pr.shift_id
  GROUP BY 1
),
-- the ONE definition of produced kilos, summed across grades
produced AS (
  SELECT month_start, sum(produced_kg)::numeric AS produced_kg
  FROM public.view_rc_movement_production_monthly
  GROUP BY 1
),
-- the ONE definition of a reported production day
reported AS (
  SELECT
    date_trunc('month', reported_date)::date AS month_start,
    count(*)::int                            AS reported_days
  FROM public.view_digest_stream_reported_days
  WHERE stream = 'production'
  GROUP BY 1
),
-- A start_kwh of 0 is a genuine meter reset only when the counter
-- wrapped (this row's end is BELOW the meter's previous end). A 0 start
-- against an end that is still climbing is a start that was never
-- entered, and the x120 multiplier turns it into a five-digit phantom.
readings AS (
  SELECT
    e.reading_date,
    e.meter,
    e.consumption_kwh,
    (    e.start_kwh = 0
     AND lag(e.end_kwh) OVER w IS NOT NULL
     AND e.end_kwh >= lag(e.end_kwh) OVER w) AS is_suspect
  FROM public.electricity_readings e
  WINDOW w AS (PARTITION BY e.meter ORDER BY e.reading_date, e.id)
),
power AS (
  SELECT
    date_trunc('month', reading_date)::date                              AS month_start,
    sum(consumption_kwh)::numeric                                        AS kwh,
    count(DISTINCT reading_date)::int                                    AS power_days,
    count(DISTINCT meter)::int                                           AS power_meter_count,
    count(*) FILTER (WHERE is_suspect)::int                              AS kwh_suspect_reading_count,
    COALESCE(sum(consumption_kwh) FILTER (WHERE is_suspect), 0)::numeric AS kwh_suspect
  FROM readings
  GROUP BY 1
),
spine AS (
  SELECT month_start FROM shifts
  UNION
  SELECT month_start FROM power
)
SELECT
  sp.month_start,
  EXTRACT(year  FROM sp.month_start)::int AS year,
  EXTRACT(month FROM sp.month_start)::int AS month,

  -- did production report at all this month?
  (r.run_count IS NOT NULL)               AS production_reported,

  -- OUTPUT (NULL, never 0, when nothing was reported)
  p.produced_kg,
  r.run_count,
  s.shift_count,
  rep.reported_days,
  (p.produced_kg / NULLIF(rep.reported_days, 0))::numeric AS produced_per_reported_day,
  s.first_reported_date,
  s.last_reported_date,

  -- DOWNTIME (hours; the coverage trio is what keeps a 0.00 honest)
  d.downtime_hrs,
  d.downtime_shift_count,
  d.downtime_shifts_with_duration,
  d.downtime_shifts_reason_only,

  -- POWER (plain sum — identical to the digest's daily power definition)
  pw.kwh,
  pw.power_days,
  pw.power_meter_count,
  pw.kwh_suspect_reading_count,
  pw.kwh_suspect,

  -- POWER INTENSITY: suppressed when an input reading is broken,
  -- published with the broken reading removed beside it.
  CASE WHEN COALESCE(pw.kwh_suspect_reading_count, 0) = 0
       THEN (pw.kwh / NULLIF(p.produced_kg, 0))::numeric
  END                                                        AS kwh_per_produced_kg,
  ((pw.kwh - COALESCE(pw.kwh_suspect, 0)) / NULLIF(p.produced_kg, 0))::numeric
                                                             AS kwh_per_produced_kg_excl_suspect,

  -- BAGS (NULL, never 0, on a month where no run recorded any)
  CASE WHEN COALESCE(r.runs_with_sacks, 0) > 0 THEN r.sacks END AS sacks,
  r.runs_with_sacks,
  (100.0 * r.runs_with_sacks / NULLIF(r.run_count, 0))::numeric AS sacks_coverage_pct
FROM spine sp
LEFT JOIN shifts   s   ON s.month_start   = sp.month_start
LEFT JOIN downtime d   ON d.month_start   = sp.month_start
LEFT JOIN runs     r   ON r.month_start   = sp.month_start
LEFT JOIN produced p   ON p.month_start   = sp.month_start
LEFT JOIN reported rep ON rep.month_start = sp.month_start
LEFT JOIN power    pw  ON pw.month_start  = sp.month_start;

COMMENT ON VIEW public.view_analytics_production_monthly IS
  'WHAT THE PLANT MADE, MONTH BY MONTH. One row per calendar month for all of history. '
  'produced_kg is the finished charcoal produced that month, taken straight from the RC Movement '
  'production view rather than counted again here, so this matrix and the RC Movement screen can '
  'never disagree. It is left BLANK rather than shown as zero on a month where production was not '
  'reported at all — the plant did not run and make nothing, it simply was not reporting yet. '
  'Daily production reporting begins on 27 November 2025, so NOVEMBER 2025 IS A THREE-DAY MONTH: '
  'read first_reported_date and last_reported_date before comparing it to anything. '
  'reported_days is PRODUCTION''S OWN denominator — the number of days production actually reported '
  'that month — and is deliberately NOT the working-day count the flow analytics use, because they '
  'answer different questions. produced_per_reported_day divides by it, which is the fair way to '
  'compare a short month with a long one. run_count and shift_count are how many production entries '
  'and how many shifts sit behind the tonnage. '
  'DOWNTIME is the reported hours lost, folded from the hours-and-minutes pair exactly the way the '
  'Daily ledger folds it. Read it WITH its three coverage counts, because a zero can mean two very '
  'different things: downtime_shift_count is how many shifts filed a downtime record at all, '
  'downtime_shifts_with_duration is how many of those actually put a number on it, and '
  'downtime_shifts_reason_only is how many described the work — "cleaned the screens", "changed a '
  'spring" — while leaving the duration at zero. AUGUST 2026 IS ENTIRELY THE THIRD KIND: all 23 of '
  'its shifts named a repair and none recorded how long it took, so its 0.00 hours is a gap in the '
  'report, NOT a flawless month. '
  'POWER is the metered consumption for the month across every meter, the same figure the home '
  'dashboard shows daily. Note only the MAIN meter has reported since December 2025 — the bunkhouse '
  'and pump meters stopped — so power_meter_count reads 1 from January 2026 onward. '
  'kwh_per_produced_kg is the power intensity: units of electricity per kilo of product, the number '
  'that says whether the plant is getting more or less efficient. It is left BLANK on any month '
  'containing a meter reading we can prove is mis-keyed, because a wrong reading here does not look '
  'wrong, it looks like a finding: ONE bad row on 1 March 2026 (a starting reading left at zero) '
  'publishes 676,944 units into a month whose real consumption is about 20,000, and would report a '
  'twenty-fold efficiency collapse that never happened. kwh_suspect_reading_count names how many '
  'such readings a month contains and kwh_per_produced_kg_excl_suspect gives the honest figure with '
  'them removed. The raw kwh total is still published exactly as metered — nothing here silently '
  'corrects the underlying record. '
  'SACKS is the bag count, and it is BLANK rather than zero before bags began being counted: not one '
  'production run recorded a bag count before May 2026. sacks_coverage_pct says what share of the '
  'month''s runs the figure actually speaks for — May 2026 reads 2.63%, meaning its bag count '
  'describes a single run out of thirty-eight. '
  'This view carries NO PESO COLUMN and none can be derived from it, so the whole production matrix '
  'is safe for every role including Production; the money that meets production lives in the cost '
  'analytics view and is gated there.';

GRANT SELECT ON public.view_analytics_production_monthly TO authenticated;
REVOKE ALL ON public.view_analytics_production_monthly FROM anon;


-- ---------------------------------------------------------------------
-- view_analytics_production_grade_monthly
-- ---------------------------------------------------------------------
-- Grain: one row per (calendar month x grade).
--
-- `kg` is SELECTed from view_rc_movement_production_monthly — the same
-- one-definition the parent sums — so the grade rows and the monthly
-- headline are literally the same arithmetic, not two that agree.
--
-- `share_of_month_pct` takes its denominator by JOINING the parent view
-- (the P3 trick), never by re-summing the month here. That is what makes
-- it structurally impossible for a grade share and the monthly total to
-- disagree.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_production_grade_monthly
WITH (security_invoker = true) AS
WITH runs AS (
  SELECT
    date_trunc('month', ps.transaction_date)::date AS month_start,
    pr.grade,
    count(*)::int                                  AS run_count,
    count(*) FILTER (WHERE pr.sacks_bags IS NOT NULL)::int AS runs_with_sacks,
    sum(pr.sacks_bags)::bigint                     AS sacks
  FROM public.production_runs pr
  JOIN public.production_shifts ps ON ps.id = pr.shift_id
  GROUP BY 1, 2
)
SELECT
  g.month_start,
  EXTRACT(year  FROM g.month_start)::int AS year,
  EXTRACT(month FROM g.month_start)::int AS month,
  g.grade,
  g.produced_kg                          AS kg,
  r.run_count,
  (100.0 * g.produced_kg / NULLIF(m.produced_kg, 0))::numeric AS share_of_month_pct,
  -- the month's own published total, carried so one row is self-auditable
  m.produced_kg                          AS month_produced_kg,
  CASE WHEN COALESCE(r.runs_with_sacks, 0) > 0 THEN r.sacks END AS sacks,
  r.runs_with_sacks
FROM public.view_rc_movement_production_monthly g
LEFT JOIN runs r
       ON r.month_start = g.month_start AND r.grade = g.grade
LEFT JOIN public.view_analytics_production_monthly m
       ON m.month_start = g.month_start;

COMMENT ON VIEW public.view_analytics_production_grade_monthly IS
  'WHAT GRADES THE PLANT MADE, MONTH BY MONTH. One row for every grade produced in a given month — '
  'the monthly production figure broken out by product. kg comes from the same RC Movement '
  'production view the monthly total is built from, so the grade rows are not a second count of the '
  'same charcoal: they are the same arithmetic, split. share_of_month_pct is this grade as a '
  'percentage of everything produced that month, and its denominator is READ from the monthly '
  'production analytics view rather than recalculated, so a grade share and the monthly headline can '
  'never drift apart. The shares of a month always add to 100. month_produced_kg carries the '
  'month''s own published total on every row, so a single row can be checked without a second query. '
  'run_count is how many production entries make up the grade''s tonnage. sacks is the bag count and '
  'is BLANK rather than zero wherever bags were not being counted — no run recorded a bag count '
  'before May 2026 — with runs_with_sacks saying how many entries the figure rests on. '
  'This view carries NO PESO COLUMN and none can be derived from it, so it is safe for every role '
  'including Production.';

GRANT SELECT ON public.view_analytics_production_grade_monthly TO authenticated;
REVOKE ALL ON public.view_analytics_production_grade_monthly FROM anon;
