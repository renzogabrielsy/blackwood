-- view_rc_out_closed_blocks
-- One summary row per CLOSED block (batches.status = 'CLOSED' that has rc_out feedings),
-- collapsing all of a batch's rc_out feedings into totals, dated by when it was logged closed.
-- READ-ONLY. No triggers, no writes. Powers the frontend's "Closed Blocks" summary toggle
-- (one summary row per closed block instead of one row per feeding).
--
-- SECURITY INVOKER (Postgres default for views): inherits RLS from rc_out + batches,
-- same as view_blocking_grid and the view_rc_movement_* views.
--
-- BASE = rc_out (FROM rc_out JOIN batches WHERE status='CLOSED'): only closed batches that
-- have at least one feeding appear. This naturally yields 440 rows (449 CLOSED batches exist,
-- but 9 are test/QA junk with zero rc_out and zero deliveries, so they have no real data and
-- no resolvable close_date) and guarantees close_date is non-null for every row.
--
-- PRICE SOURCE = deliveries.cost_basis weighted-avg per batch (NOT batches.avg_cost, which is
-- documented STALE for some live batches due to a known imperative-ingestion += drift, e.g.
-- JAN-26-BLK11). Same basis the Blocking module and the view_rc_movement_*_price views use.
--
-- PRICE COLUMNS ARE NOT GATED HERE. total_value and avg_price are exposed raw and MUST be
-- role-gated DOWNSTREAM by the frontend's server fetch (null them when !canViewPrices()),
-- exactly like view_blocking_grid + its server action. Production is the only price-denied role.

CREATE OR REPLACE VIEW view_rc_out_closed_blocks AS
WITH batch_cost AS (
  -- Blended ₱/kg per batch from deliveries (NOT batches.avg_cost). NULLIF guard -> NULL when
  -- a batch has no priced deliveries (zero total delivered weight).
  SELECT
    d.batch_code,
    SUM(d.cost_basis * d.weight_kg) / NULLIF(SUM(d.weight_kg), 0) AS batch_unit_cost
  FROM deliveries d
  GROUP BY d.batch_code
),
agg AS (
  SELECT
    b.id           AS batch_id,
    b.batch_code   AS batch_code,
    b.location_ref AS location_ref,
    -- close_date: when the batch was logged closed. Prefer the latest CLOSED-marked feeding;
    -- fall back to the latest feeding of any kind when no feeding carries a CLOSED marker
    -- (~1 batch under this base, e.g. FEB-25-BLK8). Always non-null since the base requires
    -- at least one rc_out row.
    COALESCE(
      MAX(r.transaction_date) FILTER (WHERE r.remarks ILIKE '%CLOSED%'),
      MAX(r.transaction_date)
    )                AS close_date,
    SUM(r.weight_kg) AS total_fed_kg,
    COUNT(*)::int    AS feed_count,
    MIN(r.transaction_date) AS first_fed_date,
    -- Most recent non-empty rc_out.block_loc for this batch, used as a fallback when the
    -- batch has no location_ref (correlated to the batch id).
    (
      SELECT r2.block_loc
      FROM rc_out r2
      WHERE r2.batch_id = b.id
        AND NULLIF(trim(r2.block_loc), '') IS NOT NULL
      ORDER BY r2.transaction_date DESC, r2.created_at DESC
      LIMIT 1
    )                AS rc_out_block_loc
  FROM rc_out r
  JOIN batches b ON b.id = r.batch_id
  WHERE b.status = 'CLOSED'
  GROUP BY b.id, b.batch_code, b.location_ref
)
SELECT
  a.batch_id,
  a.batch_code,
  -- block_loc: prefer the batch's location_ref; if NULL or '' fall back to the most recent
  -- non-empty rc_out.block_loc. MAY be NULL for FEED batches that never had a block.
  COALESCE(NULLIF(trim(a.location_ref), ''), a.rc_out_block_loc) AS block_loc,
  a.close_date,
  a.total_fed_kg,
  a.feed_count,
  a.first_fed_date,
  -- total_value = total fed weight * blended ₱/kg; NULL when the batch has no priced deliveries.
  a.total_fed_kg * bc.batch_unit_cost AS total_value,
  -- avg_price = total_value / total_fed_kg, which equals the blended ₱/kg (batch_unit_cost).
  (a.total_fed_kg * bc.batch_unit_cost) / NULLIF(a.total_fed_kg, 0) AS avg_price
FROM agg a
LEFT JOIN batch_cost bc ON bc.batch_code = a.batch_code;

-- Inherit RLS from rc_out + batches (SECURITY INVOKER). Grant read access to the same roles
-- as the other read views in this project.
GRANT SELECT ON view_rc_out_closed_blocks TO authenticated, anon;
