-- =====================================================================
-- ICTC Owner Analytics — THE PRODUCTION BAND MOVES TO THE BATCH CLOCK
-- APPLIED 2026-09-02 as version 20260902083625.
--
-- Owner decision, 2026-09-02: the /analytics PRODUCTION band is read on
-- the PRODUCTION-BATCH (campaign) clock, not the calendar month, so that
-- its yield equals the campaign panel's BY CONSTRUCTION rather than by
-- coincidence.
--
-- TWO views. NOTHING IS DROPPED: view_analytics_production_monthly and
-- view_analytics_production_grade_monthly (P4, migration 20260901142417)
-- stay exactly as they are — the digest, and any other consumer, are
-- untouched. This is a SECOND clock published beside the first, the same
-- way P2 publishes the calendar-month money read (view_analytics_cost_
-- monthly) beside the campaign one (view_analytics_batch_cost).
--
-- WHY A BATCH CLOCK EXISTS AT ALL, and why it is EXACT here.
-- `production_shifts.production_batch` is NEVER the calendar month of the
-- date: batches routinely span month boundaries and a changeover day
-- carries TWO batches on one date (AUGUST closed and SEPTEMBER opened on
-- 2026-08-29). The batch tag comes from the SOURCE's own signal — MC's
-- column-H ENDING/STARTING markers for runs, and the TAB a waste row is
-- filed under for waste (L-046, 2026-09-01). So every shift, run,
-- downtime record and waste record in the database ALREADY CARRIES its
-- campaign, and attributing them to a campaign is a GROUP BY, not an
-- estimate. Measured: 250 of 250 production_shifts carry a non-blank
-- production_batch — there is no orphan bucket.
--
-- THE ONE THING THAT IS *MAPPED* RATHER THAN TAGGED IS ELECTRICITY.
-- `electricity_readings` is keyed on (reading_date, meter) and carries no
-- batch, so it is assigned to a campaign BY DATE SPAN. See the
-- CHANGEOVER CONVENTION below; the split between exact attribution and
-- mapped attribution is stated in the view's COMMENT so a reader always
-- knows which kind of number they are looking at.
--
-- POSTURE (identical to P1/P2/P3/P4, template 20260901115129):
--   security_invoker · SELECT to `authenticated` only · anon REVOKEd ·
--   NOT granted to service_role (the sync worker reads neither of these;
--   L-044's arrow direction — a consumer is not a dependency).
--   `scripts/verify-worker-view-grants.ts` must still read 4 views / 0
--   findings after this migration.
--
-- NO PESO COLUMN EXISTS HERE AND NONE IS DERIVABLE — the same deliberate
-- property P4 has. Production is the one module of the platform with no
-- money in it, so the whole batch-clock production matrix stays visible
-- to the Production role with no `canViewPrices()` gate and no nulling in
-- the server action. The money that MEETS a campaign already lives in
-- P2's `view_analytics_batch_cost` and is gated there.
--
-- WINDOWING: none. Measured 32 rows for the campaign view and 19 for the
-- grade view — the campaign grain is naturally tiny, two orders of
-- magnitude under PostgREST's 1000-row cap.
--
-- ---------------------------------------------------------------------
-- WHAT IS REUSED, AND WHAT HAD TO BE RESTATED (say which, always)
--
--   * YIELD AND FED KILOS ARE SELECTED FROM
--     `view_rc_movement_campaign_yield`, VERBATIM. That view is THE
--     definition the campaign panel reads, and this is the entire point
--     of the change: the production band's yield is now literally the
--     same column, so the two screens cannot disagree. Nothing here
--     recomputes a yield.
--
--   * THE SPINE IS `campaign_options UNION campaign_yield`, the exact
--     spine `view_analytics_batch_cost` uses — options is built from
--     rc_out, so a campaign that has PRODUCED but not yet been FED is
--     missing from it, and SEPTEMBER 2026 is precisely that today
--     (7,506 kg produced, 0 kg fed, opened 2026-08-29 under the L-046 tab
--     rule). Driving off options alone would make the current campaign
--     vanish on the day it starts.
--
--   * THE DOWNTIME FOLD IS *SELECTED* FROM `view_production_daily`
--     (dt_total_hrs = COALESCE(dt_hrs,0) + COALESCE(dt_mins,0)/60.0),
--     never restated — the same reuse P4 makes, and it is exact here
--     because that view already carries `production_batch` on every row.
--
--   * REPORTED DAYS HAD TO BE RESTATED, and this is the one place a rule
--     is spelled out a second time. `view_digest_stream_reported_days`
--     OWNS the rule "a production day is a day with a production_runs
--     child", but it is keyed on DATE ALONE and carries no batch, so it
--     cannot be filtered per campaign. The PREDICATE is carried across
--     unchanged (EXISTS a production_runs child) and the result is
--     RECONCILED to the owner rather than assumed: counting distinct
--     dates per campaign gives 221 campaign-days over 214 distinct
--     calendar dates, and the digest view reports exactly 214 — the
--     surplus of 7 is exactly the 7 changeover dates, each of which
--     genuinely belongs to two campaigns (2026-02-02, 03-30, 04-30,
--     05-29, 06-30, 08-01, 08-29). A per-campaign day count therefore
--     SUMS TO MORE than the calendar count, on purpose, and the COMMENT
--     says so.
--
-- ---------------------------------------------------------------------
-- THE CHANGEOVER CONVENTION FOR ELECTRICITY — ONE SENTENCE, ONE RULE.
--
--   A day's metered consumption belongs to the campaign that had most
--   recently STARTED on that day, so on a changeover day the power goes
--   to the INCOMING batch.
--
-- Mechanically: each campaign owns the half-open date interval
-- [its first shift date, the next campaign's first shift date), and the
-- last campaign's interval runs to the end of the readings. Half-open
-- intervals over a totally ordered set of start dates are a PARTITION —
-- no reading can land in two campaigns and none can be dropped between
-- them — so the kWh sum is PRESERVED EXACTLY. (The 10 campaign start
-- dates are all distinct — measured, 0 ties — and the ordering carries
-- campaign_year and production_batch as tie-breakers so a future tie
-- degenerates to a zero-width interval rather than a double count.)
--
-- THE ONE HOLE, STATED RATHER THAN HIDDEN: the meters start 2025-03-01
-- and production reporting starts 2025-11-27, so 192 metered days —
-- 561,930.00 kWh — precede the first campaign and belong to NO campaign
-- on this clock. They are not silently dropped: `kwh_unmapped_pre_
-- campaign` carries that plant-wide figure on EVERY row, so the identity
-- SUM(kwh) + kwh_unmapped_pre_campaign = total metered kWh is checkable
-- from a single row. Measured: 913,152.00 + 561,930.00 = 1,475,082.00,
-- which is the sum of all 818 readings and equals SUM(kwh) over
-- view_analytics_production_monthly exactly. The calendar-month view is
-- where those pre-campaign kilowatt-hours are readable.
--
-- THE MIS-KEYED METER READING IS STILL FLAGGED, PER CAMPAIGN. The P4
-- structural detector is ported verbatim: a start_kwh of 0 is a genuine
-- meter reset only if the counter WRAPPED (this row's end is BELOW the
-- meter's previous end). It fires on exactly ONE of 818 readings —
-- 2026-03-01 / MAIN, whose x120 multiplier publishes 676,944 kWh — and
-- on this clock that row lands in the MARCH 2026 campaign, which
-- therefore reads 696,948 kWh against a true ~20,004. So
-- `kwh_per_produced_kg` is NULL rather than wrong there and
-- `kwh_per_produced_kg_excl_suspect` gives the honest 0.0225. NOTHING IS
-- REPAIRED HERE; fixing the reading is Renzo's call and a separate,
-- audited write.
--
-- THE ONE DELIBERATE DIVERGENCE FROM view_analytics_batch_cost, stated
-- so nobody later "fixes" it. `produced_kg` here is NULL, never 0, on a
-- campaign that never reported production; batch_cost publishes 0 there,
-- because for it that column is a DENOMINATOR feeding a money ratio,
-- whereas here it is a HEADLINE an owner reads. "The plant produced
-- nothing" and "nobody was reporting yet" are different answers, and the
-- calendar sibling (view_analytics_production_monthly) already draws the
-- line this way. Measured and fully accounted: of the 32 campaigns, the
-- 10 that reported production agree with batch_cost EXACTLY (0
-- mismatches), and all 22 that differ are precisely the never-reported
-- ones (NULL here, 0 there) — there is no third case. `production_reported`
-- is the boolean that tells the two apart, on the row itself.
--
-- AND THE AUGUST ZERO-DOWNTIME HONESTY CARRIES OVER PER CAMPAIGN. The
-- AUGUST 2026 campaign reads 0.00 downtime hours across 22 shifts that
-- ALL filed a repair reason and NONE recorded a duration. Without
-- `downtime_shifts_reason_only` that zero renders as the best campaign
-- ever run. Note the batch clock splits the calendar month's 23
-- reason-only shifts across JULY (3) and AUGUST (22) — because 2026-08-01
-- is JULY's closing day — which is the clock working, not a discrepancy.
--
-- ---------------------------------------------------------------------
-- PROOFS RUN AGAINST THE LIVE DATABASE, 2026-09-02 (numbers, not claims)
--
--   ROW BUDGET            32 rows (campaign view) / 19 rows (grade view).
--                         Two orders of magnitude under PostgREST's cap.
--
--   THE TWO CLOCKS TIE, GRAND TOTAL FOR GRAND TOTAL
--     produced   6,001,592.000 kg by campaign  ==  6,001,592.000 kg by
--                month (view_analytics_production_monthly) == the raw
--                SUM(production_runs.ttl_kg). Gap 0.000 kg.
--     downtime   129.546666667 h by campaign == 129.546666667 h by month
--                == the raw fold over view_production_daily. Gap 0.
--     power      913,152.00 kWh assigned to campaigns
--              +   561,930.00 kWh kwh_unmapped_pre_campaign
--              = 1,475,082.00 kWh == SUM(kwh) by month == SUM over all
--                818 electricity_readings. Gap 0.00 kWh — the date-span
--                mapping is a PARTITION, exactly as claimed.
--     (Nothing can fall between the two clocks: 250 of 250
--      production_shifts carry a non-blank production_batch.)
--
--   YIELD AND FED ARE THE CAMPAIGN PANEL'S OWN COLUMNS, BYTE-EQUAL
--     yield_pct  IS DISTINCT FROM view_rc_movement_campaign_yield.yield_pct
--                on 0 of 32 campaigns; likewise 0 of 32 against
--                view_analytics_batch_cost.yield_pct.
--     fed_kg     0 of 32 mismatches against BOTH of the same two views.
--     produced   0 mismatches on the 10 campaigns that reported; the 22
--                that differ are exactly the NULL-vs-0 divergence above.
--
--   THE GRADE SPLIT ADDS BACK
--     SUM(grade kg) == campaign produced_kg on 10 of 10 campaigns,
--     max gap 0.0 kg; SUM(share_of_campaign_pct) == 100 on 10 of 10,
--     max deviation 0.0 (exact). 4 distinct grades.
--
--   REPORTED DAYS RECONCILE TO THE DIGEST
--     221 campaign-days over 214 distinct calendar dates; the digest's
--     production stream reports 214. Surplus 7 == the 7 changeover dates.
--
--   THE REPO FILE REPLAYS TO THE LIVE VIEWS
--     Re-running this file's DDL leaves md5(pg_get_viewdef) unchanged:
--     64418fc62982922c16cff9e5536d4a13 (campaign) and
--     51bd322465c3e0fa5b50d56c2af67438 (grade).
--
--   POSTURE VERIFIED IN pg_class / role_table_grants
--     both views: security_invoker=true, `authenticated:SELECT` and
--     nothing else — no anon, no service_role.
--     scripts/verify-worker-view-grants.ts: 4 views / 0 findings.
--
--   THE 2026 CAMPAIGNS AS THEY READ TODAY (produced t / t per reported
--   day / downtime h / kWh / kWh per kg / yield):
--     DECEMBER 2025  774.3 · 30.97 · 20.48 ·  66,168 · 0.0855 · 80.48%
--     JANUARY 2026   687.7 · 25.47 · 18.53 ·  32,844 · 0.0478 · 82.92%
--     FEBRUARY 2026  520.3 · 23.65 · 19.23 ·  15,108 · 0.0290 · 76.09%
--     MARCH 2026     888.3 · 37.01 · 18.33 · 696,948 ·  NULL  · 84.47%
--                    (0.0225 excl. the one mis-keyed reading)
--     APRIL 2026     600.2 · 25.01 · 13.78 ·  16,224 · 0.0270 · 83.50%
--     MAY 2026       645.8 · 28.08 · 10.08 ·  30,696 · 0.0475 · 80.19%
--     JUNE 2026      702.9 · 28.12 · 19.63 ·  18,516 · 0.0263 · 83.67%
--     JULY 2026      621.2 · 23.01 ·  9.47 ·  21,096 · 0.0340 · 79.52%
--     AUGUST 2026    553.4 · 24.06 ·  0.00 ·  14,688 · 0.0265 · 79.36%
--                    (the 0.00 is 22 of 22 shifts reason-only)
--     SEPTEMBER 2026   7.5 ·  7.51 ·  NULL ·     864 · 0.1151 ·  NULL
--                    (opened 2026-08-29; nothing fed to it yet)
--   JANUARY 2026's 82.92% is the campaign panel's own figure, to the
--   digit — which is the whole reason this migration exists. DECEMBER
--   2025 reads a high 0.0855 kWh/kg honestly: it is the only campaign
--   with three live meters (kwh_meter_count = 3; the bunkhouse and pump
--   meters stopped reporting 2025-12-12).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. view_analytics_production_by_batch
-- ---------------------------------------------------------------------
-- Grain: one row per campaign (production_batch, campaign_year), all
-- history. Measured 32 rows; 10 of them reported production.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_production_by_batch
WITH (security_invoker = true) AS
WITH spine AS (
  SELECT production_batch, campaign_year FROM public.view_rc_movement_campaign_options
  UNION
  SELECT production_batch, campaign_year FROM public.view_rc_movement_campaign_yield
),
-- EXACT attribution: every shift carries its own batch tag.
shifts AS (
  SELECT
    ps.production_batch,
    EXTRACT(year FROM ps.transaction_date)::int AS campaign_year,
    count(*)::int                               AS shift_count,
    min(ps.transaction_date)                    AS first_reported_date,
    max(ps.transaction_date)                    AS last_reported_date
  FROM public.production_shifts ps
  WHERE ps.production_batch IS NOT NULL AND btrim(ps.production_batch) <> ''
  GROUP BY 1, 2
),
-- The digest's rule ("a production day is a day with a production_runs
-- child"), carried across because the digest view has no batch column.
reported AS (
  SELECT
    ps.production_batch,
    EXTRACT(year FROM ps.transaction_date)::int    AS campaign_year,
    count(DISTINCT ps.transaction_date)::int       AS reported_days
  FROM public.production_shifts ps
  WHERE ps.production_batch IS NOT NULL AND btrim(ps.production_batch) <> ''
    AND EXISTS (SELECT 1 FROM public.production_runs pr WHERE pr.shift_id = ps.id)
  GROUP BY 1, 2
),
-- The downtime fold is SELECTed from view_production_daily, never
-- restated. dt_total_hrs is 0 (not NULL) on a shift with no downtime
-- record, so the FILTER on dt_hrs IS NOT NULL is what separates "no
-- downtime happened" from "no downtime was reported".
downtime AS (
  SELECT
    vpd.production_batch,
    EXTRACT(year FROM vpd.transaction_date)::int                      AS campaign_year,
    sum(vpd.dt_total_hrs) FILTER (WHERE vpd.dt_hrs IS NOT NULL)       AS downtime_hrs,
    count(*) FILTER (WHERE vpd.dt_hrs IS NOT NULL)::int               AS downtime_shift_count,
    count(*) FILTER (WHERE vpd.dt_hrs > 0 OR vpd.dt_mins > 0)::int    AS downtime_shifts_with_duration,
    count(*) FILTER (WHERE vpd.dt_reason IS NOT NULL
                       AND vpd.dt_hrs = 0 AND vpd.dt_mins = 0)::int   AS downtime_shifts_reason_only
  FROM public.view_production_daily vpd
  WHERE vpd.production_batch IS NOT NULL AND btrim(vpd.production_batch) <> ''
  GROUP BY 1, 2
),
runs AS (
  SELECT
    ps.production_batch,
    EXTRACT(year FROM ps.transaction_date)::int             AS campaign_year,
    count(*)::int                                          AS run_count,
    count(*) FILTER (WHERE pr.sacks_bags IS NOT NULL)::int  AS runs_with_sacks,
    sum(pr.sacks_bags)::bigint                             AS sacks
  FROM public.production_runs pr
  JOIN public.production_shifts ps ON ps.id = pr.shift_id
  WHERE ps.production_batch IS NOT NULL AND btrim(ps.production_batch) <> ''
  GROUP BY 1, 2
),
-- MAPPED attribution: readings carry no batch, so each campaign owns the
-- half-open span [its first shift date, the next campaign's first shift
-- date). A changeover day goes to the INCOMING campaign, which is the
-- campaign whose span opens that day.
campaign_span AS (
  SELECT
    s.production_batch,
    s.campaign_year,
    s.first_reported_date AS span_start,
    lead(s.first_reported_date) OVER (
      ORDER BY s.first_reported_date, s.campaign_year, s.production_batch
    )                     AS span_end
  FROM shifts s
),
-- The P4 structural suspect detector, ported verbatim: a start of 0 is a
-- genuine meter reset only when the counter WRAPPED.
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
    cs.production_batch,
    cs.campaign_year,
    sum(r.consumption_kwh)::numeric                                        AS kwh,
    count(DISTINCT r.reading_date)::int                                    AS kwh_days,
    count(DISTINCT r.meter)::int                                           AS kwh_meter_count,
    count(*) FILTER (WHERE r.is_suspect)::int                              AS kwh_suspect_reading_count,
    COALESCE(sum(r.consumption_kwh) FILTER (WHERE r.is_suspect), 0)::numeric AS kwh_suspect
  FROM campaign_span cs
  JOIN readings r
    ON r.reading_date >= cs.span_start
   AND (cs.span_end IS NULL OR r.reading_date < cs.span_end)
  GROUP BY 1, 2
),
-- Every metered kilowatt-hour that predates the first campaign. Carried
-- on every row so SUM(kwh) + this = the plant's total metered kWh is
-- checkable without a second query.
unmapped AS (
  SELECT COALESCE(sum(r.consumption_kwh), 0)::numeric AS kwh_unmapped_pre_campaign
  FROM readings r
  WHERE r.reading_date < (SELECT min(span_start) FROM campaign_span)
)
SELECT
  sp.production_batch,
  sp.campaign_year,
  sp.production_batch || ' ' || sp.campaign_year::text AS campaign_label,

  -- did production report against this campaign at all?
  (s.shift_count IS NOT NULL)                          AS production_reported,
  s.first_reported_date,
  s.last_reported_date,

  -- OUTPUT (NULL, never 0, on a campaign that never reported production)
  CASE WHEN s.shift_count IS NOT NULL THEN cy.total_produced END AS produced_kg,
  r.run_count,
  s.shift_count,
  rep.reported_days,
  (CASE WHEN s.shift_count IS NOT NULL THEN cy.total_produced END
     / NULLIF(rep.reported_days, 0))::numeric          AS produced_per_reported_day,

  -- FEEDING AND YIELD — selected verbatim from the campaign panel's own
  -- view. This is the whole point of the batch clock.
  cy.total_fed                                         AS fed_kg,
  cy.yield_pct,

  -- DOWNTIME (hours; the coverage trio is what keeps a 0.00 honest)
  d.downtime_hrs,
  d.downtime_shift_count,
  d.downtime_shifts_with_duration,
  d.downtime_shifts_reason_only,

  -- POWER (mapped by date span — see the changeover convention)
  pw.kwh,
  pw.kwh_days,
  pw.kwh_meter_count,
  pw.kwh_suspect_reading_count,
  pw.kwh_suspect,
  u.kwh_unmapped_pre_campaign,

  -- POWER INTENSITY: suppressed when an input reading is provably broken,
  -- published with the broken reading removed beside it.
  CASE WHEN COALESCE(pw.kwh_suspect_reading_count, 0) = 0
       THEN (pw.kwh / NULLIF(CASE WHEN s.shift_count IS NOT NULL THEN cy.total_produced END, 0))::numeric
  END                                                  AS kwh_per_produced_kg,
  ((pw.kwh - COALESCE(pw.kwh_suspect, 0))
     / NULLIF(CASE WHEN s.shift_count IS NOT NULL THEN cy.total_produced END, 0))::numeric
                                                       AS kwh_per_produced_kg_excl_suspect,

  -- BAGS (NULL, never 0, on a campaign where no run recorded any)
  CASE WHEN COALESCE(r.runs_with_sacks, 0) > 0 THEN r.sacks END AS sacks,
  r.runs_with_sacks,
  (100.0 * r.runs_with_sacks / NULLIF(r.run_count, 0))::numeric AS sacks_coverage_pct
FROM spine sp
CROSS JOIN unmapped u
LEFT JOIN shifts   s   ON s.production_batch   = sp.production_batch AND s.campaign_year   = sp.campaign_year
LEFT JOIN reported rep ON rep.production_batch = sp.production_batch AND rep.campaign_year = sp.campaign_year
LEFT JOIN downtime d   ON d.production_batch   = sp.production_batch AND d.campaign_year   = sp.campaign_year
LEFT JOIN runs     r   ON r.production_batch   = sp.production_batch AND r.campaign_year   = sp.campaign_year
LEFT JOIN power    pw  ON pw.production_batch  = sp.production_batch AND pw.campaign_year  = sp.campaign_year
LEFT JOIN public.view_rc_movement_campaign_yield cy
       ON cy.production_batch = sp.production_batch AND cy.campaign_year = sp.campaign_year;

COMMENT ON VIEW public.view_analytics_production_by_batch IS
  'WHAT THE PLANT MADE, CAMPAIGN BY CAMPAIGN — the production matrix read on the PRODUCTION-BATCH '
  'clock instead of the calendar. One row per production batch and year, for all of history. '
  'A production batch is NOT a calendar month: batches run across month boundaries and a changeover '
  'day carries two of them, so this is the clock the plant actually works to, and the calendar view '
  'beside it (the monthly production analytics) answers the calendar question. '
  'MOST OF THIS IS EXACT, NOT ESTIMATED. Every shift, run and downtime record in the database '
  'already carries the batch it belongs to — the batch is taken from the daily report''s own '
  'start/end markers and from the tab a waste row is filed under — so tonnage, runs, shifts, '
  'reported days, downtime and bags are simply grouped by it. The ONE exception is ELECTRICITY, '
  'which is metered by date and carries no batch; see the power note below. '
  'YIELD AND CHARCOAL FED ARE READ STRAIGHT FROM THE CAMPAIGN VIEW THE RC MOVEMENT PANEL USES, '
  'which is the reason this view exists: the yield shown on the analytics production band and the '
  'yield shown on the campaign panel are now the same column, so they cannot drift apart. Yield is '
  'a FRACTION, not a percent (0.8292 means 82.92%). It is BLANK on a campaign with no feeding '
  'recorded against it — SEPTEMBER 2026 opened on 29 August and has produced 7,506 kg while every '
  'kilo it consumed was still being booked to the August campaign, so its fed figure reads zero and '
  'no yield can be computed yet. '
  'produced_kg is left BLANK rather than shown as zero on the campaigns that ran before daily '
  'production reporting began on 27 November 2025 — the plant did not run and make nothing, it '
  'simply was not reporting yet. Read production_reported to tell the two apart; 10 of the 32 '
  'campaigns reported production. '
  'reported_days is how many days this campaign actually reported production, using the same rule '
  'the home dashboard uses (a day with at least one production entry). BECAUSE A CHANGEOVER DAY '
  'BELONGS TO TWO CAMPAIGNS, these day counts add up to slightly more than the number of calendar '
  'days: 221 campaign-days across 214 calendar dates, the difference being exactly the seven '
  'changeover days. That is correct, not double counting — both campaigns really did run that day. '
  'DOWNTIME is the reported hours lost, folded from the hours-and-minutes pair exactly the way the '
  'Daily ledger folds it. Read it WITH its three coverage counts, because a zero can mean two very '
  'different things: downtime_shift_count is how many shifts filed a downtime record at all, '
  'downtime_shifts_with_duration is how many put a number on it, and downtime_shifts_reason_only is '
  'how many described the work — "cleaned the screens" — while leaving the duration at zero. THE '
  'AUGUST 2026 CAMPAIGN IS ENTIRELY THE THIRD KIND: all 22 of its downtime shifts named a repair '
  'and none recorded how long it took, so its 0.00 hours is a gap in the report, NOT a flawless '
  'campaign. '
  'POWER IS THE ONE MAPPED FIGURE. Meter readings carry a date but no batch, so a day''s '
  'consumption is credited to the campaign that had most recently started on that day — which means '
  'ON A CHANGEOVER DAY THE POWER GOES TO THE INCOMING BATCH. Every metered day from the first '
  'campaign onward belongs to exactly one campaign, so nothing is counted twice and nothing is '
  'lost. The meters were running for 192 days before the first campaign was reported, and that '
  '561,930 kWh belongs to no campaign on this clock; it is carried on every row as '
  'kwh_unmapped_pre_campaign so the totals can always be reconciled, and it is readable by month in '
  'the calendar production view. '
  'kwh_per_produced_kg is the power intensity — units of electricity per kilo of product. It is '
  'left BLANK on any campaign containing a meter reading we can prove is mis-keyed, because a wrong '
  'reading here does not look wrong, it looks like a finding: ONE bad row on 1 March 2026 (a '
  'starting reading left at zero) publishes 676,944 units into the MARCH 2026 campaign, whose real '
  'consumption is about 20,000, and would report an efficiency collapse that never happened. '
  'kwh_suspect_reading_count names how many such readings a campaign contains and '
  'kwh_per_produced_kg_excl_suspect gives the honest figure with them removed. The raw kwh total is '
  'still published exactly as metered — nothing here silently corrects the underlying record. Note '
  'also that only the MAIN meter has reported since December 2025, so kwh_meter_count reads 1 from '
  'the January 2026 campaign onward. '
  'SACKS is the bag count, and it is BLANK rather than zero wherever bags were not being counted — '
  'no production run recorded a bag count before May 2026 — with sacks_coverage_pct saying what '
  'share of the campaign''s runs the figure speaks for. '
  'This view carries NO PESO COLUMN and none can be derived from it, so the whole batch-clock '
  'production matrix is safe for every role including Production; the money that meets a campaign '
  'lives in the campaign cost analytics view and is gated there.';

GRANT SELECT ON public.view_analytics_production_by_batch TO authenticated;
REVOKE ALL ON public.view_analytics_production_by_batch FROM anon;


-- ---------------------------------------------------------------------
-- 2. view_analytics_production_grade_by_batch
-- ---------------------------------------------------------------------
-- Grain: one row per (campaign x grade). Measured 19 rows.
--
-- `kg` is the same arithmetic the parent's produced_kg is — a sum of
-- production_runs.ttl_kg over shifts carrying the batch tag — SPLIT by
-- grade, not counted a second time. There is no existing (campaign x
-- grade) definition to select from (view_rc_movement_production_monthly
-- is month x grade), so this is the one figure computed here; it is
-- proven to sum to the parent on every campaign.
--
-- `share_of_campaign_pct` takes its denominator by JOINING the parent
-- view (the P3 trick), never by re-summing the campaign here. That is
-- what makes it structurally impossible for a grade share and the
-- campaign headline to disagree.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_analytics_production_grade_by_batch
WITH (security_invoker = true) AS
WITH runs AS (
  SELECT
    ps.production_batch,
    EXTRACT(year FROM ps.transaction_date)::int             AS campaign_year,
    pr.grade,
    sum(pr.ttl_kg)                                         AS kg,
    count(*)::int                                          AS run_count,
    count(*) FILTER (WHERE pr.sacks_bags IS NOT NULL)::int  AS runs_with_sacks,
    sum(pr.sacks_bags)::bigint                             AS sacks
  FROM public.production_runs pr
  JOIN public.production_shifts ps ON ps.id = pr.shift_id
  WHERE ps.production_batch IS NOT NULL AND btrim(ps.production_batch) <> ''
  GROUP BY 1, 2, 3
)
SELECT
  g.production_batch,
  g.campaign_year,
  g.production_batch || ' ' || g.campaign_year::text AS campaign_label,
  g.grade,
  g.kg,
  g.run_count,
  (100.0 * g.kg / NULLIF(m.produced_kg, 0))::numeric AS share_of_campaign_pct,
  -- the campaign's own published total, carried so one row is self-auditable
  m.produced_kg                                      AS campaign_produced_kg,
  CASE WHEN COALESCE(g.runs_with_sacks, 0) > 0 THEN g.sacks END AS sacks,
  g.runs_with_sacks
FROM runs g
LEFT JOIN public.view_analytics_production_by_batch m
       ON m.production_batch = g.production_batch AND m.campaign_year = g.campaign_year;

COMMENT ON VIEW public.view_analytics_production_grade_by_batch IS
  'WHAT GRADES EACH CAMPAIGN MADE. One row for every grade a production batch produced — the '
  'campaign''s tonnage broken out by product, on the same production-batch clock as the campaign '
  'production view. kg is the same arithmetic that view''s produced_kg is, split by grade rather '
  'than counted again, and the grade rows always add back to the campaign total exactly. '
  'share_of_campaign_pct is this grade as a percentage of everything the campaign produced, and its '
  'denominator is READ from the campaign production analytics view rather than recalculated, so a '
  'grade share and the campaign headline can never drift apart. The shares of a campaign always add '
  'to 100. campaign_produced_kg carries the campaign''s own published total on every row, so a '
  'single row can be checked without a second query. run_count is how many production entries make '
  'up the grade''s tonnage. sacks is the bag count and is BLANK rather than zero wherever bags were '
  'not being counted — no run recorded a bag count before May 2026 — with runs_with_sacks saying '
  'how many entries the figure rests on. '
  'This view carries NO PESO COLUMN and none can be derived from it, so it is safe for every role '
  'including Production.';

GRANT SELECT ON public.view_analytics_production_grade_by_batch TO authenticated;
REVOKE ALL ON public.view_analytics_production_grade_by_batch FROM anon;
