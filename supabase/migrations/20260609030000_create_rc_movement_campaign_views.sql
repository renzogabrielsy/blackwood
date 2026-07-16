-- RC Movement matrix re-keyed from CALENDAR MONTH to PRODUCTION CAMPAIGN.
--
-- A campaign = (production_batch, campaign_year) where
--     campaign_year = EXTRACT(YEAR FROM transaction_date)::int
-- Campaigns straddle calendar months (e.g. MAY 2026 = Apr30..May29) and a single
-- date can hold feeds from TWO campaigns on the SAME batch_id (e.g. 2026-05-29 has
-- a MAY feed 11,210kg AND a JUNE feed 10,600kg on JAN-26-BLK10). Grouping by
-- production_batch is what splits that transition day correctly — the older
-- month-keyed (date,batch_id) grouping MERGED it.
--
-- campaign_year is safe: empirically NO campaign instance spans a Dec->Jan New
-- Year boundary (verified). A MAY campaign's Apr-30 start is the same calendar
-- year as the rest of May, etc. The same (production_batch, campaign_year) key is
-- used on BOTH the fed side (rc_out) and the produced side
-- (production_shifts.production_batch + EXTRACT(YEAR FROM ps.transaction_date)) so
-- they JOIN for yield.
--
-- Rows with production_batch IS NULL or '' (pure-2024 legacy) are EXCLUDED from
-- every named campaign view.
--
-- Price basis = each batch's weighted-avg PURCHASE cost from deliveries.cost_basis
-- (NOT batches.avg_cost, which is stale for some live batches). Reuses the same
-- basis as view_rc_movement_batch_price so day/campaign/block prices are consistent.
--
-- All views are SECURITY INVOKER (Postgres default) and inherit RLS from the base
-- tables. view_rc_movement and view_rc_movement_batch_price are LEFT UNTOUCHED.
-- Every view is GRANTed SELECT to authenticated AND anon (a prior rebuild lost
-- grants and broke a chart — do not repeat that).

-- Shared batch weighted-avg purchase cost (defined inline per view since Postgres
-- views can't share a CTE across definitions).

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Campaign OPTIONS — drives the picker. One row per (production_batch, year).
-- ───────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.view_rc_movement_campaign_options;
CREATE VIEW public.view_rc_movement_campaign_options AS
SELECT
  rc.production_batch                                   AS production_batch,
  EXTRACT(YEAR FROM rc.transaction_date)::int          AS campaign_year,
  COUNT(DISTINCT rc.transaction_date)                  AS feed_days,
  SUM(rc.weight_kg)                                    AS total_fed,
  MIN(rc.transaction_date)                             AS min_date,
  MAX(rc.transaction_date)                             AS max_date
FROM public.rc_out rc
WHERE rc.production_batch IS NOT NULL AND rc.production_batch <> ''
GROUP BY rc.production_batch, EXTRACT(YEAR FROM rc.transaction_date);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Fed CELLS, campaign-aware — (campaign, date, batch) feed kg.
--    GROUP BY production_batch is the split that keeps the 5/29 two-campaign day
--    separate. The matrix pivots this into rows(date) x columns(batch) for a
--    chosen (production_batch, campaign_year).
-- ───────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.view_rc_movement_campaign_cells;
CREATE VIEW public.view_rc_movement_campaign_cells AS
SELECT
  rc.production_batch                            AS production_batch,
  EXTRACT(YEAR FROM rc.transaction_date)::int   AS campaign_year,
  rc.transaction_date                           AS date,
  rc.batch_id                                   AS batch_id,
  b.batch_code                                  AS batch_code,
  MIN(rc.block_loc)                             AS block_loc,
  SUM(rc.weight_kg)                             AS fed_kg
FROM public.rc_out rc
JOIN public.batches b ON b.id = rc.batch_id
WHERE rc.production_batch IS NOT NULL AND rc.production_batch <> ''
GROUP BY rc.production_batch, EXTRACT(YEAR FROM rc.transaction_date),
         rc.transaction_date, rc.batch_id, b.batch_code;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Fed PRICE per (campaign, date) — weighted-avg ₱/kg fed that day in campaign.
--    wtd_fed_price = SUM(fed_kg * batch_price) / SUM(fed_kg). NULL on zero-fed.
-- ───────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.view_rc_movement_campaign_day_price;
CREATE VIEW public.view_rc_movement_campaign_day_price AS
WITH batch_cost AS (
  SELECT d.batch_code,
         SUM(d.cost_basis * d.weight_kg) / NULLIF(SUM(d.weight_kg), 0) AS batch_price
  FROM public.deliveries d
  GROUP BY d.batch_code
),
fed AS (
  SELECT
    rc.production_batch                          AS production_batch,
    EXTRACT(YEAR FROM rc.transaction_date)::int AS campaign_year,
    rc.transaction_date                         AS date,
    rc.batch_id,
    SUM(rc.weight_kg)                           AS fed_kg,
    bc.batch_price
  FROM public.rc_out rc
  JOIN public.batches b ON b.id = rc.batch_id
  LEFT JOIN batch_cost bc ON bc.batch_code = b.batch_code
  WHERE rc.production_batch IS NOT NULL AND rc.production_batch <> ''
  GROUP BY rc.production_batch, EXTRACT(YEAR FROM rc.transaction_date),
           rc.transaction_date, rc.batch_id, bc.batch_price
)
SELECT
  production_batch,
  campaign_year,
  date,
  SUM(fed_kg * batch_price) / NULLIF(SUM(fed_kg), 0) AS wtd_fed_price,
  SUM(fed_kg)                                        AS total_fed
FROM fed
GROUP BY production_batch, campaign_year, date;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Fed PRICE per campaign — footer campaign-avg fed price + total fed.
-- ───────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.view_rc_movement_campaign_price;
CREATE VIEW public.view_rc_movement_campaign_price AS
WITH batch_cost AS (
  SELECT d.batch_code,
         SUM(d.cost_basis * d.weight_kg) / NULLIF(SUM(d.weight_kg), 0) AS batch_price
  FROM public.deliveries d
  GROUP BY d.batch_code
),
fed AS (
  SELECT
    rc.production_batch                          AS production_batch,
    EXTRACT(YEAR FROM rc.transaction_date)::int AS campaign_year,
    rc.batch_id,
    SUM(rc.weight_kg)                           AS fed_kg,
    bc.batch_price
  FROM public.rc_out rc
  JOIN public.batches b ON b.id = rc.batch_id
  LEFT JOIN batch_cost bc ON bc.batch_code = b.batch_code
  WHERE rc.production_batch IS NOT NULL AND rc.production_batch <> ''
  GROUP BY rc.production_batch, EXTRACT(YEAR FROM rc.transaction_date),
           rc.batch_id, bc.batch_price
)
SELECT
  production_batch,
  campaign_year,
  SUM(fed_kg * batch_price) / NULLIF(SUM(fed_kg), 0) AS wtd_fed_price,
  SUM(fed_kg)                                        AS total_fed
FROM fed
GROUP BY production_batch, campaign_year;

-- ───────────────────────────────────────────────────────────────────────────
-- 5a. Produced per (campaign, date, grade). Campaign-keyed via
--     production_shifts.production_batch + year of ps.transaction_date.
-- ───────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.view_rc_movement_campaign_production_daily;
CREATE VIEW public.view_rc_movement_campaign_production_daily AS
SELECT
  ps.production_batch                          AS production_batch,
  EXTRACT(YEAR FROM ps.transaction_date)::int AS campaign_year,
  ps.transaction_date                         AS date,
  pr.grade                                     AS grade,
  SUM(pr.ttl_kg)                               AS produced_kg
FROM public.production_runs pr
JOIN public.production_shifts ps ON ps.id = pr.shift_id
WHERE ps.production_batch IS NOT NULL AND ps.production_batch <> ''
GROUP BY ps.production_batch, EXTRACT(YEAR FROM ps.transaction_date),
         ps.transaction_date, pr.grade;

-- 5b. Produced per (campaign, date) TOTAL (all grades) — SQL daily total so the
--     frontend never sums grades in TS.
DROP VIEW IF EXISTS public.view_rc_movement_campaign_production_daily_total;
CREATE VIEW public.view_rc_movement_campaign_production_daily_total AS
SELECT
  ps.production_batch                          AS production_batch,
  EXTRACT(YEAR FROM ps.transaction_date)::int AS campaign_year,
  ps.transaction_date                         AS date,
  SUM(pr.ttl_kg)                               AS produced_kg
FROM public.production_runs pr
JOIN public.production_shifts ps ON ps.id = pr.shift_id
WHERE ps.production_batch IS NOT NULL AND ps.production_batch <> ''
GROUP BY ps.production_batch, EXTRACT(YEAR FROM ps.transaction_date),
         ps.transaction_date;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Produced per (campaign, grade) — grade-column footer totals.
-- ───────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.view_rc_movement_campaign_production;
CREATE VIEW public.view_rc_movement_campaign_production AS
SELECT
  ps.production_batch                          AS production_batch,
  EXTRACT(YEAR FROM ps.transaction_date)::int AS campaign_year,
  pr.grade                                     AS grade,
  SUM(pr.ttl_kg)                               AS produced_kg
FROM public.production_runs pr
JOIN public.production_shifts ps ON ps.id = pr.shift_id
WHERE ps.production_batch IS NOT NULL AND ps.production_batch <> ''
GROUP BY ps.production_batch, EXTRACT(YEAR FROM ps.transaction_date), pr.grade;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Yield per campaign — total_fed vs total_produced, yield% + loss kg.
--    FULL OUTER JOIN so campaigns with fed-but-no-production still appear.
-- ───────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.view_rc_movement_campaign_yield;
CREATE VIEW public.view_rc_movement_campaign_yield AS
WITH fed AS (
  SELECT rc.production_batch                          AS production_batch,
         EXTRACT(YEAR FROM rc.transaction_date)::int AS campaign_year,
         SUM(rc.weight_kg)                           AS total_fed
  FROM public.rc_out rc
  WHERE rc.production_batch IS NOT NULL AND rc.production_batch <> ''
  GROUP BY rc.production_batch, EXTRACT(YEAR FROM rc.transaction_date)
),
produced AS (
  SELECT ps.production_batch                          AS production_batch,
         EXTRACT(YEAR FROM ps.transaction_date)::int AS campaign_year,
         SUM(pr.ttl_kg)                               AS total_produced
  FROM public.production_runs pr
  JOIN public.production_shifts ps ON ps.id = pr.shift_id
  WHERE ps.production_batch IS NOT NULL AND ps.production_batch <> ''
  GROUP BY ps.production_batch, EXTRACT(YEAR FROM ps.transaction_date)
)
SELECT
  COALESCE(f.production_batch, p.production_batch) AS production_batch,
  COALESCE(f.campaign_year, p.campaign_year)      AS campaign_year,
  COALESCE(f.total_fed, 0)::numeric               AS total_fed,
  COALESCE(p.total_produced, 0)::numeric          AS total_produced,
  COALESCE(p.total_produced, 0)::numeric / NULLIF(f.total_fed, 0) AS yield_pct,
  COALESCE(f.total_fed, 0)::numeric - COALESCE(p.total_produced, 0)::numeric AS loss_kg
FROM fed f
FULL OUTER JOIN produced p
  ON p.production_batch = f.production_batch
 AND p.campaign_year   = f.campaign_year;

-- ───────────────────────────────────────────────────────────────────────────
-- GRANTs — SELECT to authenticated AND anon on EVERY view (prior rebuild lost
-- grants and broke a chart; never skip).
-- ───────────────────────────────────────────────────────────────────────────
GRANT SELECT ON public.view_rc_movement_campaign_options                 TO authenticated, anon;
GRANT SELECT ON public.view_rc_movement_campaign_cells                   TO authenticated, anon;
GRANT SELECT ON public.view_rc_movement_campaign_day_price               TO authenticated, anon;
GRANT SELECT ON public.view_rc_movement_campaign_price                   TO authenticated, anon;
GRANT SELECT ON public.view_rc_movement_campaign_production_daily         TO authenticated, anon;
GRANT SELECT ON public.view_rc_movement_campaign_production_daily_total   TO authenticated, anon;
GRANT SELECT ON public.view_rc_movement_campaign_production              TO authenticated, anon;
GRANT SELECT ON public.view_rc_movement_campaign_yield                   TO authenticated, anon;
