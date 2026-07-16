-- Patch: view_rc_movement was returning '' for block_loc when rc_out.block_loc
-- was an empty string (not NULL). NULLIF converts '' to NULL so the COALESCE
-- properly falls back to batches.location_ref. CREATE OR REPLACE is safe.

CREATE OR REPLACE VIEW view_rc_movement AS
WITH
batch_meta AS (
  SELECT
    b.id                                                      AS batch_id,
    (
      SELECT d.supplier
      FROM   deliveries d
      WHERE  d.batch_code = b.batch_code
      ORDER  BY d.transaction_date DESC
      LIMIT  1
    )                                                         AS supplier,
    (
      SELECT COALESCE(SUM(d.weight_kg), 0)
      FROM   deliveries d
      WHERE  d.batch_code = b.batch_code
    )                                                         AS deliveries_total
  FROM batches b
  WHERE EXISTS (
    SELECT 1 FROM rc_out rc WHERE rc.batch_id = b.id
  )
),
day_agg AS (
  SELECT
    rc.transaction_date                                              AS date,
    rc.batch_id,
    MAX(b.batch_code)                                                AS batch_code,
    MAX(COALESCE(NULLIF(rc.block_loc, ''), b.location_ref))          AS block_loc,
    MAX(b.avg_cost)                                                  AS php_per_kg,
    SUM(rc.weight_kg)                                                AS fed_today,
    BOOL_OR(rc.remarks ILIKE '%CLOSED%')                             AS closed_today,
    bm.supplier,
    bm.deliveries_total
  FROM   rc_out rc
  JOIN   batches    b  ON b.id  = rc.batch_id
  JOIN   batch_meta bm ON bm.batch_id = rc.batch_id
  GROUP  BY rc.transaction_date, rc.batch_id, bm.supplier, bm.deliveries_total
),
with_windows AS (
  SELECT
    date,
    batch_id,
    batch_code,
    block_loc,
    supplier,
    deliveries_total,
    fed_today,
    closed_today,
    php_per_kg,
    fed_today * php_per_kg                                          AS php_total,
    SUM(fed_today) OVER (
      PARTITION BY batch_id
      ORDER BY date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )                                                               AS cum_fed,
    deliveries_total - COALESCE(
      SUM(fed_today) OVER (
        PARTITION BY batch_id
        ORDER BY date
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ), 0
    )                                                               AS start_balance,
    deliveries_total - SUM(fed_today) OVER (
      PARTITION BY batch_id
      ORDER BY date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )                                                               AS balance_after,
    DENSE_RANK() OVER (
      PARTITION BY batch_id
      ORDER BY date
    )                                                               AS feed_day_n
  FROM day_agg
)
SELECT
  date,
  batch_id,
  batch_code,
  block_loc,
  supplier,
  deliveries_total,
  fed_today,
  cum_fed,
  start_balance,
  balance_after,
  CASE
    WHEN deliveries_total > 0 THEN balance_after / deliveries_total
    ELSE NULL
  END                                                               AS pct_loss,
  feed_day_n,
  php_per_kg,
  php_total,
  closed_today,
  CASE
    WHEN closed_today = TRUE OR balance_after <= 0 THEN 'closed'
    ELSE 'active'
  END                                                               AS status
FROM with_windows
ORDER BY date DESC, batch_id;
