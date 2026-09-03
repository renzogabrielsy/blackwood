-- =====================================================================
-- RC INVENTORY PRICE — value the OPEN piles only (2026-09-03)
-- =====================================================================
-- Renzo, 2026-09-03: "Why is stock avg cost not aligned with my current
-- blocking inventory price? I think RC inventory avg price is 37
-- something currently? Why isn't stock avg cost displaying the same."
--
-- He was right, and the gap was exactly one population.
-- MEASURED before this change:
--   * view_analytics_inventory_eom, current row (2026-09-01):
--       avg_unit_cost_php_kg  P36.2587  over 11,743,657.10 kg
--   * Blocking page header (view_blocking_grid, balance-weighted):
--       P37.1400 over 10,527,344.00 kg across 170 blocks
--   * The difference is 347 CLOSED batches still carrying
--       1,216,313.10 kg at P28.6310/kg.
-- Closed-pile residue is resiko / evaporation — LOSS, not stock — which
-- is Renzo's standing rule and is already how view_analytics_aging_eom
-- draws its headline (`open_kg` vs `closed_residue_kg`). Valuing that
-- residue as if it were sellable inventory dragged the yard's unit cost
-- down by up to P1.12/kg and made the analytics page disagree with the
-- Blocking page for no reason a reader could see.
--
-- WHAT CHANGES: `ending_value_php`, `avg_unit_cost_php_kg`, `valued_kg`,
-- `unvalued_kg` and `value_coverage_pct` are now computed over OPEN
-- positive balances only. The kilo columns (`ending_kg`,
-- `positive_balance_kg`, `negative_*`, `active_batches`,
-- `batches_with_balance`, `runway_days`) are UNTOUCHED — the residue is
-- physically in the yard and the stock line must keep saying so.
--
-- ONE DEFINITION OF "OPEN", NOT A THIRD ONE. The `closed` CTE below is
-- lifted verbatim from view_analytics_aging_eom: a batch is closed as of
-- a month-end when view_rc_movement_block_actual_price.close_date (the
-- block's last feeding, or the feeding remarked CLOSED) is on or before
-- that month's as_of_date. The two views therefore draw the line in the
-- same place by construction, and their published kilos add up:
--   PROVEN, 75 of 75 months, max gap 0.00 kg:
--     valued_kg + view_analytics_aging_eom.closed_residue_kg
--       = positive_balance_kg
--   (and identically open_kg + closed_residue_kg = positive_balance_kg).
--
-- PROVEN AGAINST BLOCKING on the current row (2026-09-01):
--   avg_unit_cost_php_kg  = 37.139967505327993986
--   SUM(avg_php_kg*balance)/SUM(balance) over view_blocking_grid
--                         = 37.139967505327993986   (identical digits)
--   valued_kg = 10,527,344.00 kg = the grid's total balance, 170 blocks.
-- The two are computed from different starting points — the grid reads
-- live `batches`/`deliveries`/`rc_out`, this view replays every month
-- from events — so the agreement is a check, not a tautology.
--
-- NOTHING IS SILENTLY LOST. The previous figures are preserved under
-- names that say what they are: `all_positive_avg_unit_cost_php_kg` is
-- the old `avg_unit_cost_php_kg` to the last digit, and the old
-- `ending_value_php` is recoverable as
-- `ending_value_php + closed_residue_value_php` by construction. So a UI
-- that ever needs "the whole yard including the residue" can still print
-- it, and can print the residue's own P/kg beside it.
--
-- MEASURED IMPACT: 30 of 75 months move (2024-04 .. 2026-09 — the months
-- that have any closed block with residue); the other 45 are byte
-- identical. Largest move P+1.1158/kg on 2026-01 (34.5116 -> 35.6274).
-- Early months move DOWNWARD (2024-10, P-0.0657) because the residue
-- there was dearer than the open stock; recent months move upward.
--
-- POSTURE UNCHANGED: CREATE OR REPLACE (never DROP + CREATE, so the
-- grants survive — L-044), security_invoker, `authenticated` SELECT only,
-- `anon` revoked, and deliberately NO service_role grant (the sync worker
-- reads none of the analytics views). The new dependency,
-- view_rc_movement_block_actual_price, is already readable by
-- `authenticated` and is already in view_analytics_aging_eom's closure.
-- The four new columns are APPENDED and every existing column keeps its
-- name, type and position, so lib/analytics/queries.ts keeps compiling
-- and types/supabase.ts gains only additions.
--
-- STILL A P VIEW: ending_value_php, avg_unit_cost_php_kg,
-- closed_residue_value_php, closed_residue_php_kg and
-- all_positive_avg_unit_cost_php_kg all carry money and are nulled
-- server-side by canViewPrices() before the payload leaves the server.
-- =====================================================================

CREATE OR REPLACE VIEW public.view_analytics_inventory_eom
WITH (security_invoker = true) AS
WITH batch_month AS (
  SELECT
    d.batch_code,
    date_trunc('month', d.transaction_date)::date            AS month_start,
    sum(d.weight_kg)                                          AS in_kg,
    0::numeric                                                AS out_kg,
    sum(d.cost_basis * d.weight_kg) FILTER (WHERE d.cost_basis > 0) AS priced_value,
    sum(d.weight_kg)                FILTER (WHERE d.cost_basis > 0) AS priced_kg
  FROM public.deliveries d
  WHERE d.transaction_date IS NOT NULL
    AND d.batch_code IS NOT NULL
  GROUP BY d.batch_code, date_trunc('month', d.transaction_date)::date

  UNION ALL

  SELECT
    b.batch_code,
    date_trunc('month', r.transaction_date)::date,
    0::numeric,
    sum(r.weight_kg),
    0::numeric,
    0::numeric
  FROM public.rc_out r
  JOIN public.batches b ON b.id = r.batch_id
  WHERE r.transaction_date IS NOT NULL
  GROUP BY b.batch_code, date_trunc('month', r.transaction_date)::date
),
deltas AS (
  SELECT
    batch_code,
    month_start,
    sum(in_kg)                        AS in_kg,
    sum(out_kg)                       AS out_kg,
    sum(COALESCE(priced_value, 0))    AS priced_value,
    sum(COALESCE(priced_kg, 0))       AS priced_kg
  FROM batch_month
  GROUP BY batch_code, month_start
),
-- THE ONE "is this pile still open" RULE, lifted verbatim from
-- view_analytics_aging_eom so the two views cannot disagree. A block's
-- close date is its last feeding (or the feeding remarked CLOSED), the
-- approximation view_rc_movement_block_actual_price already publishes.
closed AS (
  SELECT batch_code, min(close_date) AS close_date
  FROM public.view_rc_movement_block_actual_price
  WHERE close_date IS NOT NULL
  GROUP BY batch_code
),
first_seen AS (
  SELECT batch_code, min(month_start) AS first_month
  FROM deltas
  GROUP BY batch_code
),
grid AS (
  SELECT fs.batch_code, s.month_start, s.as_of_date
  FROM first_seen fs
  JOIN public.view_analytics_flow_monthly s ON s.month_start >= fs.first_month
),
running AS (
  SELECT
    g.batch_code,
    g.month_start,
    g.as_of_date,
    sum(COALESCE(d.in_kg, 0) - COALESCE(d.out_kg, 0)) OVER w AS balance_kg,
    sum(COALESCE(d.priced_value, 0))                  OVER w AS priced_value,
    sum(COALESCE(d.priced_kg, 0))                     OVER w AS priced_kg
  FROM grid g
  LEFT JOIN deltas d
    ON d.batch_code = g.batch_code
   AND d.month_start = g.month_start
  WINDOW w AS (PARTITION BY g.batch_code ORDER BY g.month_start)
),
flagged AS (
  SELECT
    r.*,
    (c.close_date IS NULL OR c.close_date > r.as_of_date) AS is_open
  FROM running r
  LEFT JOIN closed c ON c.batch_code = r.batch_code
),
per_month AS (
  SELECT
    month_start,

    -- THE PHYSICAL YARD — every batch, open or closed. UNCHANGED.
    sum(balance_kg)                                                   AS ending_kg,
    sum(balance_kg) FILTER (WHERE balance_kg > 0)                     AS positive_balance_kg,
    sum(balance_kg) FILTER (WHERE balance_kg < 0)                     AS negative_balance_kg,
    count(*) FILTER (WHERE balance_kg < 0)::int                       AS negative_batch_count,
    count(*) FILTER (WHERE balance_kg > 500)::int                     AS active_batches,
    count(*) FILTER (WHERE balance_kg <> 0)::int                      AS batches_with_balance,

    -- THE MONEY — OPEN positive piles only (closed residue is loss).
    sum(balance_kg * (priced_value / NULLIF(priced_kg, 0)))
      FILTER (WHERE balance_kg > 0 AND is_open AND priced_kg > 0)     AS ending_value_php,
    sum(balance_kg) FILTER (WHERE balance_kg > 0 AND is_open AND priced_kg > 0)
                                                                      AS valued_kg,
    sum(balance_kg) FILTER (WHERE balance_kg > 0 AND is_open AND priced_kg = 0)
                                                                      AS unvalued_kg,

    -- THE RESIDUE, reported rather than folded in.
    sum(balance_kg) FILTER (WHERE balance_kg > 0 AND NOT is_open)     AS closed_residue_kg,
    sum(balance_kg * (priced_value / NULLIF(priced_kg, 0)))
      FILTER (WHERE balance_kg > 0 AND NOT is_open AND priced_kg > 0) AS closed_residue_value_php,
    sum(balance_kg) FILTER (WHERE balance_kg > 0 AND NOT is_open AND priced_kg > 0)
                                                                      AS closed_residue_valued_kg,

    -- THE PREVIOUS DEFINITION, kept so nothing is silently lost.
    sum(balance_kg * (priced_value / NULLIF(priced_kg, 0)))
      FILTER (WHERE balance_kg > 0 AND priced_kg > 0)                 AS all_positive_value_php,
    sum(balance_kg) FILTER (WHERE balance_kg > 0 AND priced_kg > 0)   AS all_positive_valued_kg
  FROM flagged
  GROUP BY month_start
)
SELECT
  f.month_start,
  f.year,
  f.month,
  f.as_of_date,
  f.is_partial_month,

  COALESCE(p.ending_kg, 0)             AS ending_kg,
  COALESCE(p.positive_balance_kg, 0)   AS positive_balance_kg,
  COALESCE(p.negative_balance_kg, 0)   AS negative_balance_kg,
  COALESCE(p.negative_batch_count, 0)  AS negative_batch_count,
  COALESCE(p.active_batches, 0)        AS active_batches,
  COALESCE(p.batches_with_balance, 0)  AS batches_with_balance,

  p.ending_value_php,
  p.ending_value_php / NULLIF(p.valued_kg, 0)  AS avg_unit_cost_php_kg,
  COALESCE(p.valued_kg, 0)             AS valued_kg,
  COALESCE(p.unvalued_kg, 0)           AS unvalued_kg,
  100.0 * COALESCE(p.valued_kg, 0)
    / NULLIF(COALESCE(p.valued_kg, 0) + COALESCE(p.unvalued_kg, 0), 0)
                                       AS value_coverage_pct,

  f.out_kg,
  f.working_days,
  f.out_per_working_day,
  COALESCE(p.ending_kg, 0) / NULLIF(f.out_per_working_day, 0) AS runway_days,
  COALESCE(f.as_of_date >= (SELECT min(r.transaction_date) FROM public.rc_out r), false)
                                       AS outflow_recorded,

  -- APPENDED 2026-09-03 -------------------------------------------------
  COALESCE(p.closed_residue_kg, 0)     AS closed_residue_kg,
  p.closed_residue_value_php           AS closed_residue_value_php,
  p.closed_residue_value_php / NULLIF(p.closed_residue_valued_kg, 0)
                                       AS closed_residue_php_kg,
  p.all_positive_value_php / NULLIF(p.all_positive_valued_kg, 0)
                                       AS all_positive_avg_unit_cost_php_kg
FROM public.view_analytics_flow_monthly f
LEFT JOIN per_month p ON p.month_start = f.month_start;


COMMENT ON VIEW public.view_analytics_inventory_eom IS
  'HOW MUCH CHARCOAL WAS IN THE YARD AT THE END OF EACH MONTH, AND WHAT IT COST — rebuilt from '
  'the events (every delivery in, every feeding out), one row per month from the first delivery '
  'to the current month. THE KILO COLUMNS COUNT EVERY PILE: ending_kg is the net across all '
  'batches, positive_balance_kg is the charcoal actually sitting there, and the negative columns '
  'report the piles that read below zero because charcoal was fed out under a different spelling '
  'of the batch code than it arrived under. THE PESO COLUMNS VALUE OPEN PILES ONLY: '
  'avg_unit_cost_php_kg is the RC INVENTORY PRICE — the balance-weighted arrival cost of every '
  'pile still open at month-end — and it equals the Blocking page''s Wtd Avg P/kg on the current '
  'month, to the last decimal, by construction. Charcoal left in a CLOSED block is resiko / '
  'evaporation, i.e. loss rather than stock, so it is excluded from the price and reported '
  'separately as closed_residue_kg / closed_residue_value_php / closed_residue_php_kg; '
  'all_positive_avg_unit_cost_php_kg is the older whole-yard-including-residue figure, kept so '
  'nothing was silently taken away. "Open" here is the SAME rule view_analytics_aging_eom uses '
  '(the block''s close date from view_rc_movement_block_actual_price), so the two views agree by '
  'construction: valued_kg + aging''s closed_residue_kg = positive_balance_kg on all 75 months, '
  'to 0.00 kg. Two questions it deliberately cannot answer: how many BLOCKS were occupied in a '
  'past month (a block''s location is reused, so read utilization live from view_blocking_grid) '
  'and what the STORED / IN-USE / CLOSED mix was at a past month-end (status changes are not '
  'dated). Months before 2024-01 read outflow_recorded = false — deliveries were being recorded '
  'but feedings were not, so the stock line can only rise in them.';

COMMENT ON COLUMN public.view_analytics_inventory_eom.avg_unit_cost_php_kg IS
  'RC INVENTORY PRICE — the balance-weighted arrival cost of every OPEN pile as of month-end. '
  'Each pile''s remaining kilos are carried at that pile''s own delivery-weighted purchase price '
  '(priced deliveries only, since cost_basis = 0 means "no price yet", not a free truckload), '
  'and the yard figure is the total pesos over the total kilos — never an average of averages. '
  'On the current month this equals the Blocking page''s Wtd Avg P/kg exactly. Charcoal still '
  'logged in a CLOSED block is excluded because it is loss, not stock; read closed_residue_php_kg '
  'for what that residue cost and all_positive_avg_unit_cost_php_kg for the two combined.';

COMMENT ON COLUMN public.view_analytics_inventory_eom.ending_value_php IS
  'What the OPEN stock cost to buy, at month-end: the sum over every open pile of (kilos still in '
  'the pile x that pile''s own priced arrival cost). Pairs with valued_kg, NOT with ending_kg or '
  'positive_balance_kg — closed-block residue is excluded (it is loss) and a pile whose '
  'deliveries carry no price yet is left out of both halves. Add closed_residue_value_php to get '
  'the whole-yard figure this column used to report.';

COMMENT ON COLUMN public.view_analytics_inventory_eom.valued_kg IS
  'Kilos the peso columns actually speak for: open piles, positive balance, at least one priced '
  'delivery. valued_kg + view_analytics_aging_eom.closed_residue_kg = positive_balance_kg, exactly, '
  'on all 75 months.';

COMMENT ON COLUMN public.view_analytics_inventory_eom.unvalued_kg IS
  'Kilos in OPEN piles that no price can be put on yet, because none of that pile''s deliveries '
  'has been priced. Measured 2026-09-03: zero on all 75 months — the column exists to show the '
  'gap the next time Czarina''s price file lags, not to report a known one.';

COMMENT ON COLUMN public.view_analytics_inventory_eom.value_coverage_pct IS
  'Share of the OPEN positive stock the peso columns cover (valued_kg over valued_kg + '
  'unvalued_kg). 100 means every open pile has a price.';

COMMENT ON COLUMN public.view_analytics_inventory_eom.closed_residue_kg IS
  'Charcoal still logged against CLOSED blocks at month-end — resiko / evaporation. It is real '
  'weight and is inside positive_balance_kg, but it is loss rather than sellable stock, so it is '
  'kept out of every peso column. Matches view_analytics_aging_eom.closed_residue_kg exactly.';

COMMENT ON COLUMN public.view_analytics_inventory_eom.closed_residue_value_php IS
  'What that closed-block residue originally cost to buy, on the same arrival-cost basis as '
  'ending_value_php. Reported so the loss can be priced; never added into the stock value.';

COMMENT ON COLUMN public.view_analytics_inventory_eom.closed_residue_php_kg IS
  'Peso per kilo of the closed-block residue (its value over its priced kilos). Currently far '
  'below the open stock''s price (P28.63 vs P37.14 on 2026-09) because the residue is old '
  'charcoal bought when charcoal was cheaper — which is exactly why folding it into the yard '
  'price dragged that price down.';

COMMENT ON COLUMN public.view_analytics_inventory_eom.all_positive_avg_unit_cost_php_kg IS
  'The PREVIOUS definition of avg_unit_cost_php_kg, kept so nothing was silently taken away: '
  'every positive pile including closed-block residue. Use it only to answer "what did everything '
  'in the yard cost, loss included" — the headline inventory price is avg_unit_cost_php_kg.';


-- Posture, restated so a future reader does not have to go looking.
-- No service_role grant: the sync worker reads none of the analytics views.
REVOKE ALL ON public.view_analytics_inventory_eom FROM anon;
GRANT SELECT ON public.view_analytics_inventory_eom TO authenticated;
