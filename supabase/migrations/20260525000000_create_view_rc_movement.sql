-- Migration: Create view_rc_movement
-- RC Movement — per-(batch_id, transaction_date) aggregation of RC OUT with running
-- balance, cumulative feed, pct_loss, feed day counter, and status.
-- One row per (batch_id, date). Multiple rc_out entries on the same (batch, day)
-- are collapsed via SUM/BOOL_OR/MAX.
--
-- Production-role cost scrubbing happens in the server action, NOT in this view.
-- View returns raw php_per_kg / php_total always.
--
-- Idempotent: CREATE OR REPLACE VIEW.

CREATE OR REPLACE VIEW view_rc_movement AS
WITH
-- batch_meta: one row per batch_code — supplier (most recent delivery) and total
-- deliveries weight. Computed once per batch, joined into day_agg to avoid
-- using aggregate functions inside correlated subquery WHERE clauses.
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

-- day_agg: collapse multiple rc_out rows per (batch_id, date) into one row.
-- MAX() on functionally-dependent columns (batch_code, avg_cost) is correct
-- because they are stable per batch_id. MAX(COALESCE(...)) for block_loc
-- handles the rare case of two different locations on the same day.
day_agg AS (
  SELECT
    rc.transaction_date                                       AS date,
    rc.batch_id,
    MAX(b.batch_code)                                        AS batch_code,
    MAX(COALESCE(rc.block_loc, b.location_ref))              AS block_loc,
    MAX(b.avg_cost)                                          AS php_per_kg,
    SUM(rc.weight_kg)                                        AS fed_today,
    BOOL_OR(rc.remarks ILIKE '%CLOSED%')                     AS closed_today,
    bm.supplier,
    bm.deliveries_total
  FROM   rc_out rc
  JOIN   batches    b  ON b.id  = rc.batch_id
  JOIN   batch_meta bm ON bm.batch_id = rc.batch_id
  GROUP  BY rc.transaction_date, rc.batch_id, bm.supplier, bm.deliveries_total
),

-- with_windows: apply window functions over the day-level rows to compute
-- running totals and ordinal counters per batch.
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

    -- Cumulative kg fed (inclusive of today)
    SUM(fed_today) OVER (
      PARTITION BY batch_id
      ORDER BY date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )                                                               AS cum_fed,

    -- Balance at start of today = total deliveries minus everything fed BEFORE today
    deliveries_total - COALESCE(
      SUM(fed_today) OVER (
        PARTITION BY batch_id
        ORDER BY date
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ), 0
    )                                                               AS start_balance,

    -- Balance after today's feeding
    deliveries_total - SUM(fed_today) OVER (
      PARTITION BY batch_id
      ORDER BY date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )                                                               AS balance_after,

    -- Ordinal day counter per batch (1 = first day this batch was fed)
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

  -- Residual fraction: proportion of original intake still unprocessed.
  -- Freezes as final shrinkage once status = 'closed'.
  CASE
    WHEN deliveries_total > 0 THEN balance_after / deliveries_total
    ELSE NULL
  END                                                               AS pct_loss,

  feed_day_n,
  php_per_kg,
  php_total,
  closed_today,

  -- Status: CLOSED remark OR balance depleted → closed; otherwise active.
  -- closed_today = TRUE takes priority even when balance_after > 0 (weighing variance).
  CASE
    WHEN closed_today = TRUE OR balance_after <= 0 THEN 'closed'
    ELSE 'active'
  END                                                               AS status

FROM with_windows
ORDER BY date DESC, batch_id;
