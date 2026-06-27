-- Blend Proposal aggregation function (Blocking module "Blend Proposal" feature).
--
-- Given a set of block_loc keys (the user's selection in the warehouse grid), this
-- returns ONE row of BALANCE-WEIGHTED averages across the selected blocks, computed
-- entirely in SQL: SUM(stat * balance) / SUM(balance). This keeps every weighted
-- average on the DB side, per the project rule "never compute weighted averages or
-- inventory balances in TypeScript — trust the DB".
--
-- The server action does only trivial scalar work on top of this (the x1.30 product
-- cost markup and assembling the response object). It separately fetches the per-block
-- passthrough rows via a plain SELECT (no aggregation there either).
--
-- Price note (mirrors the L-008 placeholder discipline used elsewhere): a block with a
-- NULL avg_php_kg (no cost basis recorded) is EXCLUDED from the price weight via
-- FILTER (WHERE avg_php_kg IS NOT NULL), so one priceless block does not poison the
-- blended price. It is still counted in volume (total_balance) and lab weighting.
-- raw_price_per_kg is NULL when no selected block carries a price.
--
-- SECURITY INVOKER (default for SQL functions here): the function reads view_blocking_grid
-- under the caller's RLS, consistent with the rest of the blocking data layer. Price
-- GATING (the security boundary) is enforced in the server action via canViewPrices(),
-- which nulls every price field before the payload leaves the server.

CREATE OR REPLACE FUNCTION public.fn_blend_proposal(p_block_locs text[])
RETURNS TABLE (
  block_count    integer,
  total_balance  numeric,
  w_mc           numeric,
  w_ash          numeric,
  w_bd_astm      numeric,
  w_bd_jis       numeric,
  w_grit         numeric,
  w_vm           numeric,
  w_fc           numeric,
  raw_price_per_kg numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*)::integer                                                AS block_count,
    COALESCE(SUM(g.balance), 0)                                      AS total_balance,
    SUM(g.avg_mc      * g.balance) / NULLIF(SUM(g.balance), 0)       AS w_mc,
    SUM(g.avg_ash     * g.balance) / NULLIF(SUM(g.balance), 0)       AS w_ash,
    SUM(g.avg_bd_astm * g.balance) / NULLIF(SUM(g.balance), 0)       AS w_bd_astm,
    SUM(g.avg_bd_jis  * g.balance) / NULLIF(SUM(g.balance), 0)       AS w_bd_jis,
    SUM(g.avg_grit    * g.balance) / NULLIF(SUM(g.balance), 0)       AS w_grit,
    SUM(g.avg_vm      * g.balance) / NULLIF(SUM(g.balance), 0)       AS w_vm,
    SUM(g.avg_fc      * g.balance) / NULLIF(SUM(g.balance), 0)       AS w_fc,
    SUM(g.avg_php_kg  * g.balance) FILTER (WHERE g.avg_php_kg IS NOT NULL)
      / NULLIF(SUM(g.balance) FILTER (WHERE g.avg_php_kg IS NOT NULL), 0)
                                                                    AS raw_price_per_kg
  FROM public.view_blocking_grid g
  WHERE g.block_loc = ANY(p_block_locs);
$$;

GRANT EXECUTE ON FUNCTION public.fn_blend_proposal(text[]) TO authenticated, anon;
