-- RC Movement weighted-average FED PRICE views (three grains).
--
-- Price basis (DECIDED): each batch's weighted-average PURCHASE cost computed
-- straight from deliveries.cost_basis:
--     batch_price = SUM(cost_basis * weight_kg) / SUM(weight_kg)  per batch_code
-- We deliberately DO NOT use batches.avg_cost: spot-checks found it stale for
-- some live batches (e.g. JAN-26-BLK11 stored 42.44 vs true 45.57). The Blocking
-- module already recomputes from deliveries for the same reason. Using one basis
-- for all three grains keeps day / month / block numbers mutually consistent.
--
-- All three views are SECURITY INVOKER (Postgres default for views) and inherit
-- RLS from the underlying tables. view_rc_movement is left UNTOUCHED.

-- (A) per-DAY weighted-avg fed price.
-- One row per calendar day on which any RC was fed. Queryable by date range.
-- wtd_fed_price = SUM(fed_kg * batch_price) / SUM(fed_kg) across batches fed that day.
CREATE OR REPLACE VIEW view_rc_movement_day_price AS
WITH batch_cost AS (
  SELECT
    d.batch_code,
    SUM(d.cost_basis * d.weight_kg) / NULLIF(SUM(d.weight_kg), 0) AS batch_price
  FROM deliveries d
  GROUP BY d.batch_code
),
fed AS (
  SELECT
    rc.transaction_date AS date,
    rc.batch_id,
    SUM(rc.weight_kg)   AS fed_kg,
    bc.batch_price
  FROM rc_out rc
  JOIN batches    b  ON b.id = rc.batch_id
  LEFT JOIN batch_cost bc ON bc.batch_code = b.batch_code
  GROUP BY rc.transaction_date, rc.batch_id, bc.batch_price
)
SELECT
  date,
  SUM(fed_kg * batch_price) / NULLIF(SUM(fed_kg), 0) AS wtd_fed_price,
  SUM(fed_kg)                                        AS total_fed
FROM fed
GROUP BY date;

-- (B) per-MONTH weighted-avg fed price + total fed.
-- month_start is the first day of the cycle month (date_trunc). The action resolves
-- one target month -> one row -> the footer value. Used downstream, so it's exact.
CREATE OR REPLACE VIEW view_rc_movement_month_price AS
WITH batch_cost AS (
  SELECT
    d.batch_code,
    SUM(d.cost_basis * d.weight_kg) / NULLIF(SUM(d.weight_kg), 0) AS batch_price
  FROM deliveries d
  GROUP BY d.batch_code
),
fed AS (
  SELECT
    date_trunc('month', rc.transaction_date)::date AS month_start,
    rc.batch_id,
    SUM(rc.weight_kg)   AS fed_kg,
    bc.batch_price
  FROM rc_out rc
  JOIN batches    b  ON b.id = rc.batch_id
  LEFT JOIN batch_cost bc ON bc.batch_code = b.batch_code
  GROUP BY date_trunc('month', rc.transaction_date), rc.batch_id, bc.batch_price
)
SELECT
  month_start,
  SUM(fed_kg * batch_price) / NULLIF(SUM(fed_kg), 0) AS wtd_fed_price,
  SUM(fed_kg)                                        AS total_fed
FROM fed
GROUP BY month_start;

-- (C) per-BLOCK (batch) weighted-avg cost.
-- One row per batch that has any RC OUT (i.e. appears as a matrix column). The
-- action joins this to its existing column batch list on batch_id. batch_price is
-- the SAME weighted-avg purchase cost used in (A) and (B).
CREATE OR REPLACE VIEW view_rc_movement_batch_price AS
WITH batch_cost AS (
  SELECT
    d.batch_code,
    SUM(d.cost_basis * d.weight_kg) / NULLIF(SUM(d.weight_kg), 0) AS batch_price
  FROM deliveries d
  GROUP BY d.batch_code
)
SELECT
  b.id          AS batch_id,
  b.batch_code  AS batch_code,
  bc.batch_price
FROM batches b
LEFT JOIN batch_cost bc ON bc.batch_code = b.batch_code
WHERE EXISTS (SELECT 1 FROM rc_out rc WHERE rc.batch_id = b.id);

-- GRANTS (a prior view rebuild silently dropped these and broke a chart).
GRANT SELECT ON view_rc_movement_day_price   TO authenticated, anon;
GRANT SELECT ON view_rc_movement_month_price TO authenticated, anon;
GRANT SELECT ON view_rc_movement_batch_price TO authenticated, anon;
