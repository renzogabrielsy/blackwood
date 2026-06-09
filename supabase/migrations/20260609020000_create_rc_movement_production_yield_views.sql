-- RC Movement: production output (by grade) + monthly yield/loss views.
-- All aggregation/ratios are SQL (per CLAUDE.md Database Rules). SECURITY INVOKER (default for views).
-- Fed basis matches view_rc_movement.fed_today / view_rc_movement_month_price.total_fed = SUM(rc_out.weight_kg), no destination filter.
-- Production is continuous-tank: NOT attributable to a raw input batch, so aggregated per DAY and per MONTH only.

-- 1a. Per-day produced by grade (one row per date+grade, total across shifts)
DROP VIEW IF EXISTS public.view_rc_movement_production_daily;
CREATE VIEW public.view_rc_movement_production_daily AS
SELECT
    ps.transaction_date AS date,
    pr.grade,
    SUM(pr.ttl_kg) AS produced_kg
FROM public.production_runs pr
JOIN public.production_shifts ps ON ps.id = pr.shift_id
GROUP BY ps.transaction_date, pr.grade;

-- 1b. Per-day produced TOTAL (all grades summed) — SQL daily total so frontend never aggregates
DROP VIEW IF EXISTS public.view_rc_movement_production_daily_total;
CREATE VIEW public.view_rc_movement_production_daily_total AS
SELECT
    ps.transaction_date AS date,
    SUM(pr.ttl_kg) AS produced_kg
FROM public.production_runs pr
JOIN public.production_shifts ps ON ps.id = pr.shift_id
GROUP BY ps.transaction_date;

-- 2. Per-month produced by grade (footer per grade column = month grade total)
DROP VIEW IF EXISTS public.view_rc_movement_production_monthly;
CREATE VIEW public.view_rc_movement_production_monthly AS
SELECT
    date_trunc('month', ps.transaction_date)::date AS month_start,
    pr.grade,
    SUM(pr.ttl_kg) AS produced_kg
FROM public.production_runs pr
JOIN public.production_shifts ps ON ps.id = pr.shift_id
GROUP BY date_trunc('month', ps.transaction_date)::date, pr.grade;

-- 3. Monthly yield/loss — total_fed (rc_out) vs total_produced (production_runs), yield% + loss kg, all SQL.
--    FULL OUTER JOIN so months with fed-but-no-production (or vice versa) still appear with NULL-safe zeros.
DROP VIEW IF EXISTS public.view_rc_movement_yield_monthly;
CREATE VIEW public.view_rc_movement_yield_monthly AS
WITH fed AS (
    SELECT date_trunc('month', rc.transaction_date)::date AS month_start,
           SUM(rc.weight_kg) AS total_fed
    FROM public.rc_out rc
    GROUP BY date_trunc('month', rc.transaction_date)::date
),
produced AS (
    SELECT date_trunc('month', ps.transaction_date)::date AS month_start,
           SUM(pr.ttl_kg) AS total_produced
    FROM public.production_runs pr
    JOIN public.production_shifts ps ON ps.id = pr.shift_id
    GROUP BY date_trunc('month', ps.transaction_date)::date
)
SELECT
    COALESCE(f.month_start, p.month_start) AS month_start,
    COALESCE(f.total_fed, 0)::numeric AS total_fed,
    COALESCE(p.total_produced, 0)::numeric AS total_produced,
    COALESCE(p.total_produced, 0)::numeric / NULLIF(f.total_fed, 0) AS yield_pct,
    COALESCE(f.total_fed, 0)::numeric - COALESCE(p.total_produced, 0)::numeric AS loss_kg
FROM fed f
FULL OUTER JOIN produced p ON p.month_start = f.month_start;

-- GRANTs: SELECT to authenticated AND anon on EVERY view (prior rebuild lost grants and broke a chart).
GRANT SELECT ON public.view_rc_movement_production_daily        TO authenticated, anon;
GRANT SELECT ON public.view_rc_movement_production_daily_total  TO authenticated, anon;
GRANT SELECT ON public.view_rc_movement_production_monthly      TO authenticated, anon;
GRANT SELECT ON public.view_rc_movement_yield_monthly           TO authenticated, anon;
