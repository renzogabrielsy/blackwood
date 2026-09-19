-- ─────────────────────────────────────────────────────────────────────────────
-- THE PRICE LENS on the Blocking grid — "show me the blocks above market"
--
-- Renzo, 2026-09-19: see the blocking grid "ratio'd in highlights based on price
-- filter" — if market (what deliveries currently cost) is 40.23, then ₱41 and up is
-- above market. Two functions, and the split between them is the whole design:
--
--   fn_blocking_market_bases()  answers "what IS market right now", four ways
--   fn_blocking_price_lens()    TAKES a market price and classifies the yard
--
-- The classifier takes the price as an ARGUMENT rather than choosing a basis itself,
-- so the user's `manual` basis (a ₱ they typed) and all four computed bases go
-- through ONE band-and-classify implementation. A second classifier for the typed
-- case is how "above market" would eventually come to mean two different things.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT "MARKET" MEANS, AND WHY THREE OF THE FOUR BASES DO NO ARITHMETIC
-- ═════════════════════════════════════════════════════════════════════════════
-- Market = the weighted average ₱/kg of MARKET-class, PRICED deliveries:
--   fn_delivery_class(batch_code, supplier, remarks) = 'market'  AND  cost_basis > 0
--   SUM(cost_basis * weight_kg) / SUM(weight_kg)
--
-- That statistic ALREADY HAS A HOME: `view_analytics_rcin_monthly.market_avg_price`
-- (analytics Phase 1), which CLAUDE.md records as byte-identical to
-- `view_delivery_monthly_analytics` on all 49 months precisely so the platform never
-- grows a second "monthly average purchase price". So the three calendar bases SELECT
-- it — `this_month` and `last_month` read the column verbatim, `last_3_months` divides
-- Σ market_php_total by Σ market_priced_kg (the ONLY honest way to combine three
-- monthly weighted averages; averaging the averages would weight a light month
-- equally with a heavy one).
--
-- `trailing_days` is the one basis with no monthly home, because a rolling window
-- does not align to a month. It reads `deliveries` directly with the IDENTICAL
-- predicate and the IDENTICAL expression, lifted arm for arm from the view above —
-- including its `market_delivery_count` counting ALL market deliveries while the
-- price is weighted over the PRICED ones only, so `delivery_count` means the same
-- thing on all four rows.
--
-- `market_php_kg` is NULL — NEVER 0 — when a basis has no priced market kilos (the
-- 1st of a month before anything has arrived, or a `trailing_days` window over a
-- shutdown). The view's own expression already NULLIFs its denominator; the NULLIF
-- here is belt-and-braces, not a second rule. NULL ≠ 0 is load-bearing: a lens built
-- on a ₱0 market would put every block in "above market".
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE R RULE, AND WHY IT ROUNDS UP EVEN ON A WHOLE NUMBER
-- ═════════════════════════════════════════════════════════════════════════════
--   R = floor(market) + 1
--   40.23 → 41      39.8568 → 40      40.00 → 41
--
-- The operator's own sentence is "if market is 40.23 then ₱41 and up is above
-- market", so R is the first WHOLE peso strictly above a fractional market price.
-- On an exactly-whole market price floor(40)+1 is still 41, which keeps the market
-- price ITSELF inside the "at market" band [R−1, R) rather than promoting it to
-- "above market" — a block priced at exactly market is not dearer than market.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- BANDS ARE EDGES, NOT A FIXED THREE
-- ═════════════════════════════════════════════════════════════════════════════
-- `p_edge_offsets` is a list of INTEGER peso offsets from R. It is de-duplicated and
-- sorted, and k edges produce k+1 bands, each half-open `[lower, upper)` with the
-- FIRST open below and the LAST open above:
--
--   default [-1, 0] → edges {R−1, R} → 3 bands
--     band 0  (−∞, R−1)   below market
--     band 1  [R−1, R)     at market   ← contains the market price itself
--     band 2  [R, +∞)      above market
--
--   [-10, -1, 0, 5]  → 4 edges → 5 bands
--
-- `lower_php` is null on band 0 and `upper_php` is null on the last band; null means
-- OPEN, never zero. Every band is emitted even when empty, so a legend can render
-- the whole scale without inventing rows the database did not return.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE UNPRICED RULE — NULL IS NEVER ₱0 (L-008), FOR THE FOURTH TIME
-- ═════════════════════════════════════════════════════════════════════════════
-- The block price is `view_blocking_grid.avg_php_kg`, THE column the Blocking cell
-- already displays — this function does not invent a second per-block price. That
-- column is `COALESCE(…, 0)`, so a block whose deliveries carry no price reads 0,
-- which is the L-008 unpriced PLACEHOLDER and not a free pile of charcoal. Such a
-- block goes in `unpriced`, in NO band, and is EXCLUDED from both share
-- denominators. Putting it in "below market" would paint the cheapest possible
-- colour on a block whose price is simply unknown — the exact mistake
-- `batches.avg_cost` made when it read ₱11.01 against a real ₱39.99.
--
-- Consequently `Σ bands[].block_count + unpriced.block_count = total.block_count`
-- and the same for kg, while the two share families are over the PRICED population
-- and each sums to 100. When nothing is priced the shares are NULL, not 0 ÷ 0.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ₱ SENSITIVITY — BAND MEMBERSHIP ALONE IS A PRICE LEAK
-- ═════════════════════════════════════════════════════════════════════════════
-- Both functions carry money, and the lens is money even where it looks like it is
-- not: knowing a block sits in `[R, +∞)` tells you its ₱/kg to within a peso. So
-- there is no "price-free half" of this payload to hand to Production, and nulling
-- fields at read time would not help. The gate is therefore a REFUSAL BEFORE THE
-- CALL: `fetchBlockingMarketBases` / `fetchBlockingPriceLens` in
-- app/(app)/inventory/blocking/actions.ts check the canonical `canViewPrices()`
-- FIRST and return `{ok:false, reason:'prices_hidden'}` without touching the
-- database. Grants match: `authenticated` only (every signed-in user, as with
-- fn_blend_proposal — the ROLE boundary lives in the action), `anon` revoked, and
-- **NOT `service_role`** — the sync worker calls neither, and
-- verify-worker-view-grants must stay at 4 views / 0 findings.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- COST, MEASURED BEFORE ANY PROOF WAS WRITTEN (the 2026-09-14 rule)
-- ═════════════════════════════════════════════════════════════════════════════
-- `set local statement_timeout='5s'` then EXPLAIN (ANALYZE, BUFFERS), 2026-09-19:
--   view_blocking_grid alone (balance > 0, 168 rows)          2.85 ms /   451 buffers
--   fn_blocking_price_lens(…)   BEFORE the CTE hints         85.4 ms / 1,939 buffers
--                               AFTER  (grid scanned once)    4.8 ms /   454 buffers
--   fn_blocking_market_bases(30) BEFORE                     330.7 ms / 1,291 buffers
--                                AFTER (view read once)     133.4 ms /   176 buffers
--   trailing_days at its 400-day CEILING, on its own         21.9 ms /    97 buffers
--
-- The first reading of each pair is why the MATERIALIZED hints in §1 and §2 are
-- load-bearing rather than decoration: a CTE the planner inlines is a CTE it
-- re-executes once per reference, and `view_blocking_grid` / the analytics view are
-- both expensive subtrees. Both populations are bounded BY CONSTRUCTION — the grid is
-- one row per occupied block (168 today, 238 slots maximum) and the delivery window
-- is clamped to 400 days — so neither function can grow into a whole-history scan.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- §1  fn_blocking_market_bases — what IS market right now, four ways
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blocking_market_bases(p_trailing_days int DEFAULT 30)
RETURNS TABLE (
  basis_key      text,
  market_php_kg  numeric,
  priced_kg      numeric,
  delivery_count int,
  from_date      date,
  to_date        date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH anchor AS (
    SELECT (now() AT TIME ZONE 'Asia/Manila')::date                                   AS today,
           date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date)::date        AS m0,
           (date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date)
              - interval '1 month')::date                                             AS m1,
           (date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date)
              - interval '2 months')::date                                            AS m2,
           -- Clamp, never refuse: a junk N from a stale client still returns a usable
           -- window, and the row says which one it used via from_date/to_date.
           least(greatest(COALESCE(p_trailing_days, 30), 1), 400)                      AS days
  ),
  -- READ THE ANALYTICS VIEW ONCE. It is a full pass over `deliveries` with
  -- fn_delivery_class evaluated per row and then grouped by month, so letting the
  -- three calendar bases each reference it separately costs three passes: MEASURED
  -- 330 ms / 1,291 buffers before this CTE, 133 ms / 176 after. The window m2..m0 is
  -- exactly the months all three of them need.
  months AS MATERIALIZED (
    SELECT v.month_start, v.market_avg_price, v.market_priced_kg,
           v.market_php_total, v.market_delivery_count
    FROM public.view_analytics_rcin_monthly v, anchor a
    WHERE v.month_start >= a.m2 AND v.month_start <= a.m0
  ),
  -- THE TRAILING WINDOW GETS ITS OWN CTE (named trail_window: TRAILING is reserved) so the DATE bound is a plain WHERE the
  -- planner may apply BEFORE fn_delivery_class. Inside a LEFT JOIN's ON clause it
  -- could not, and the class function then ran on all 1,765 deliveries rather than
  -- the ~52 in the window.
  trail_window AS MATERIALIZED (
    SELECT sum(d.cost_basis * d.weight_kg) FILTER (WHERE d.cost_basis > 0) AS money,
           sum(d.weight_kg)                FILTER (WHERE d.cost_basis > 0) AS priced_kg,
           count(*)::int                                                   AS n
    FROM public.deliveries d
    WHERE d.transaction_date >= (SELECT a.today - (a.days - 1) FROM anchor a)
      AND public.fn_delivery_class(d.batch_code, d.supplier, d.remarks) = 'market'
  ),
  -- NOTE the internal column names are deliberately NOT basis_key / market_php_kg /
  -- … : in a LANGUAGE sql function the RETURNS TABLE column names are also names in
  -- scope, so reusing them here would make the final SELECT's references ambiguous.
  basis_rows AS (
    -- THIS MONTH — the view's column verbatim.
    SELECT 1 AS sort_no,
           'this_month'::text                            AS k_basis,
           NULLIF(v.market_avg_price, 0)                  AS k_price,
           COALESCE(v.market_priced_kg, 0)                AS k_priced_kg,
           COALESCE(v.market_delivery_count, 0)::int      AS k_count,
           a.m0                                           AS k_from,
           (a.m0 + interval '1 month' - interval '1 day')::date AS k_to
    FROM anchor a
    LEFT JOIN months v ON v.month_start = a.m0

    UNION ALL

    -- LAST MONTH — same, one month back.
    SELECT 2,
           'last_month'::text,
           NULLIF(v.market_avg_price, 0),
           COALESCE(v.market_priced_kg, 0),
           COALESCE(v.market_delivery_count, 0)::int,
           a.m1,
           (a.m1 + interval '1 month' - interval '1 day')::date
    FROM anchor a
    LEFT JOIN months v ON v.month_start = a.m1

    UNION ALL

    -- LAST 3 MONTHS — Σ money ÷ Σ priced kilos over the current month and the two
    -- before it, counting only the months that HAVE a row (a month with nothing
    -- arriving has no row in that view at all). Never the mean of three averages.
    SELECT 3,
           'last_3_months'::text,
           NULLIF(sum(v.market_php_total) / NULLIF(sum(v.market_priced_kg), 0), 0),
           COALESCE(sum(v.market_priced_kg), 0),
           COALESCE(sum(v.market_delivery_count), 0)::int,
           a.m2,
           (a.m0 + interval '1 month' - interval '1 day')::date
    FROM anchor a
    LEFT JOIN months v ON TRUE
    GROUP BY a.m2, a.m0

    UNION ALL

    -- TRAILING N DAYS — the one basis with no monthly home. The predicate and the
    -- expression are lifted arm for arm from view_analytics_rcin_monthly: the price
    -- is weighted over PRICED market deliveries, the count covers ALL market
    -- deliveries. NO UPPER BOUND on the date, so a future-dated delivery is never
    -- invisible (the digest-view idiom); from_date/to_date name the window ANCHORS.
    SELECT 4,
           'trailing_days'::text,
           NULLIF(t.money / NULLIF(t.priced_kg, 0), 0),
           COALESCE(t.priced_kg, 0),
           t.n,
           (a.today - (a.days - 1))::date,
           a.today
    FROM anchor a, trail_window t
  )
  SELECT r.k_basis, r.k_price, r.k_priced_kg, r.k_count, r.k_from, r.k_to
  FROM basis_rows r
  ORDER BY r.sort_no;
$$;

COMMENT ON FUNCTION public.fn_blocking_market_bases(int) IS
'What "market" costs right now, four ways, for the Blocking page price lens: this_month, last_month, last_3_months and trailing_days (N clamped to 1..400, default 30). Market means the weighted average PHP/kg of MARKET-class PRICED deliveries — fn_delivery_class(...) = ''market'' AND cost_basis > 0, SUM(cost_basis * weight_kg) / SUM(weight_kg). The three calendar bases SELECT that statistic from view_analytics_rcin_monthly rather than re-deriving it, so the lens can never disagree with the analytics matrix; last_3_months divides the summed money by the summed priced kilos (never the mean of three monthly averages). Only trailing_days reads deliveries directly, with the identical predicate and expression, windowed on the Asia/Manila calendar date with no upper bound so a future-dated delivery is never invisible. market_php_kg is NULL, never 0, when a basis has no priced market kilos. CARRIES MONEY: every caller is subject to canViewPrices() and the server action refuses a price-denied role BEFORE calling. authenticated only; anon revoked; service_role deliberately not granted (no sync worker reads it).';


-- ═════════════════════════════════════════════════════════════════════════════
-- §2  fn_blocking_price_lens — classify the yard against a given market price
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blocking_price_lens(
  p_market_php_kg numeric,
  p_edge_offsets  int[] DEFAULT ARRAY[-1, 0]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_offsets int[];
  v_r       numeric;
  v_result  jsonb;
BEGIN
  -- ── Refusals. EVERY business refusal is jsonb written for a human, never a RAISE
  -- (the fn_save_blend_proposal idiom) — the caller hands `message` straight to
  -- errorToast() without parsing an SQLSTATE.

  IF p_market_php_kg IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'no_market_price',
      'message', 'No market price to compare against yet. Pick a different market basis, or type one in.');
  END IF;

  -- NaN and Infinity are BOTH greater than every number in numeric comparison, so
  -- `> 0` alone would let them through and every block would land in one band.
  IF p_market_php_kg = 'NaN'::numeric
     OR p_market_php_kg = 'Infinity'::numeric
     OR p_market_php_kg = '-Infinity'::numeric
     OR p_market_php_kg <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_market_price',
      'message', 'The market price has to be a real amount above zero — a price of zero would put every block above market.');
  END IF;

  v_offsets := COALESCE(p_edge_offsets, ARRAY[-1, 0]);

  -- A NULL edge cannot be placed on the scale, so it is refused rather than dropped.
  -- NOTE a fractional edge is NOT detectable here: the parameter is int[], so
  -- Postgres has already rounded 1.5 to 2 before this body runs. Integrality is
  -- therefore enforced where it IS decidable — in the server action, which rejects a
  -- non-integer offset with this same `invalid_edge` reason before calling.
  IF EXISTS (SELECT 1 FROM unnest(v_offsets) AS o WHERE o IS NULL) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_edge',
      'message', 'Every band edge has to be a whole number of pesos away from market.');
  END IF;

  -- De-duplicate and order. The bands are DEFINED by the resulting list, which is
  -- why the cap is measured after the collapse and why the list is returned.
  SELECT array_agg(DISTINCT o ORDER BY o) INTO v_offsets FROM unnest(v_offsets) AS o;

  IF v_offsets IS NULL OR cardinality(v_offsets) = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'no_edges',
      'message', 'A price lens needs at least one band edge — with none, every block is in the same band and nothing is highlighted.');
  END IF;

  IF cardinality(v_offsets) > 6 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'too_many_edges',
      'message', format('A price lens takes at most 6 band edges; this one has %s.', cardinality(v_offsets)));
  END IF;

  -- ── R, then the bands, then the blocks. See the header for the R rule.
  v_r := floor(p_market_php_kg) + 1;

  WITH off AS (
    SELECT o, row_number() OVER (ORDER BY o)::int AS i
    FROM unnest(v_offsets) AS o
  ),
  k AS (SELECT count(*)::int AS n FROM off),
  -- MATERIALIZED, all three of them, and it is not cosmetic: `blk` is read by four
  -- downstream CTEs and `classified` by two, and without the hint the planner
  -- re-executed the whole view_blocking_grid subtree for each reference — MEASURED
  -- 85 ms / 1,939 buffers before, 4.8 ms / 454 after, i.e. the grid is now scanned
  -- exactly once (451 of those 454 buffers ARE that single scan).
  bands AS MATERIALIZED (
    -- k edges → k+1 bands. Band i is [E_i, E_{i+1}); the missing lookups at the two
    -- ends are exactly what makes band 0 open below and band k open above.
    SELECT gs.i                                                       AS band_index,
           (SELECT v_r + off.o FROM off WHERE off.i = gs.i)            AS lower_php,
           (SELECT v_r + off.o FROM off WHERE off.i = gs.i + 1)        AS upper_php
    FROM k, generate_series(0, k.n) AS gs(i)
  ),
  blk AS MATERIALIZED (
    -- One row per OCCUPIED block with charcoal still in it. avg_php_kg is the very
    -- column the Blocking cell renders; a negative balance is a misattribution
    -- (CLAUDE.md: 77 batches carry -3.22M kg) and has no price story to tell.
    SELECT g.block_loc,
           g.balance::numeric                                   AS kg,
           g.avg_php_kg,
           (g.avg_php_kg IS NULL OR g.avg_php_kg <= 0)          AS unpriced
    FROM public.view_blocking_grid g
    WHERE g.balance > 0
  ),
  classified AS MATERIALIZED (
    -- The highest band whose lower bound the price satisfies. Bands are contiguous
    -- and ordered, so that IS the band containing it; band 0's NULL lower bound
    -- makes the answer total.
    SELECT b.block_loc,
           b.kg,
           (SELECT max(bd.band_index) FROM bands bd
             WHERE bd.lower_php IS NULL OR b.avg_php_kg >= bd.lower_php) AS band_index
    FROM blk b
    WHERE NOT b.unpriced
  ),
  tot    AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg FROM blk),
  unp    AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg FROM blk WHERE unpriced),
  priced AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg FROM blk WHERE NOT unpriced),
  band_rows AS (
    SELECT bd.band_index, bd.lower_php, bd.upper_php,
           count(c.block_loc)::int      AS block_count,
           COALESCE(sum(c.kg), 0)       AS kg
    FROM bands bd
    LEFT JOIN classified c ON c.band_index = bd.band_index
    GROUP BY bd.band_index, bd.lower_php, bd.upper_php
  )
  SELECT jsonb_build_object(
    'ok', true,
    'market_php_kg', p_market_php_kg,
    'rounded_up_php', v_r,
    -- The list actually used, after de-duplication and ordering — so a UI never has
    -- to guess whether its input survived intact.
    'edge_offsets', to_jsonb(v_offsets),
    'bands', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'index',           br.band_index,
               'lower_php',       br.lower_php,          -- null = open below
               'upper_php',       br.upper_php,          -- null = open above
               'block_count',     br.block_count,
               'kg',              br.kg,
               -- Shares are over the PRICED population, and NULL (never 0 ÷ 0) when
               -- nothing is priced at all.
               'kg_share_pct',    CASE WHEN p.kg > 0 THEN br.kg * 100.0 / p.kg END,
               'block_share_pct', CASE WHEN p.block_count > 0
                                       THEN br.block_count * 100.0 / p.block_count END)
             ORDER BY br.band_index)
      FROM band_rows br, priced p), '[]'::jsonb),
    'blocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('block_loc', c.block_loc, 'band_index', c.band_index)
             ORDER BY c.block_loc)
      FROM classified c), '[]'::jsonb),
    'unpriced', (SELECT jsonb_build_object('block_count', u.block_count, 'kg', u.kg) FROM unp u),
    'total',    (SELECT jsonb_build_object('block_count', t.block_count, 'kg', t.kg) FROM tot t)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_price_lens(numeric, int[]) IS
'Classify every occupied Blocking block against a GIVEN market PHP/kg, for the Blocking page price lens. It takes the market price as an argument on purpose, so the four computed bases from fn_blocking_market_bases and a manually typed price share ONE classifier. R = floor(market) + 1 (40.23 -> 41, 39.8568 -> 40, and 40.00 -> 41 so the market price itself stays inside the at-market band). p_edge_offsets is a list of whole-peso offsets from R, de-duplicated and sorted; k edges give k+1 half-open [lower, upper) bands with the first open below (lower_php null) and the last open above (upper_php null); default ARRAY[-1,0] gives below / at market / above market. The per-block price is view_blocking_grid.avg_php_kg, the same column the cell displays — never a second definition. A block with NO price (null or 0, the L-008 unpriced placeholder — NULL is never PHP 0) lands in "unpriced", in no band, and is excluded from both share denominators, so sum of band counts plus unpriced equals total and each share family sums to 100 over the priced population. Every business refusal is jsonb {ok:false, reason, message} written for a human, never a raise: no_market_price, invalid_market_price, invalid_edge, no_edges, too_many_edges. CARRIES MONEY EVEN WHERE IT LOOKS LIKE IT DOES NOT — band membership alone pins a block''s PHP/kg to within a peso, so there is no price-free half of this payload: the server action refuses a canViewPrices()-denied caller BEFORE calling rather than nulling fields after. authenticated only; anon revoked; service_role deliberately not granted.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §3  Posture
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.fn_blocking_market_bases(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_market_bases(int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_market_bases(int) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[]) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[]) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §4  fn_blocking_price_lens_probe — the ACCESS BRIDGE for the verify script
--
-- NOT a "verify everything" function, and the distinction is the 2026-09-14
-- incident: `fn_ops_ledger_verify()` cross-checked every ops-ledger view over the
-- whole of history in one statement, OOM-ed the instance and took the live site
-- down. This probe asserts NOTHING. It calls the two functions above a fixed number
-- of times, reads three bounded rows, and HANDS THE RESULT BACK so every assertion
-- lives in scripts/verify-blocking-price-lens.ts where a human can read it.
--
-- It exists only because both functions are `authenticated`-only BY DESIGN and no
-- verify script holds a user JWT — the same reason the ops-ledger probes exist, and
-- the same SECURITY DEFINER + service_role-only shape.
--
-- BOUNDED BY CONSTRUCTION: 8 lens calls over a 168-row grid (238 slots maximum) and
-- one bases call whose delivery window is clamped to 400 days. Measured 2026-09-19
-- with `set local statement_timeout='5s'` then EXPLAIN (ANALYZE, BUFFERS) — see the
-- figure recorded in the verify script's header.
--
-- It returns the market PRICES (that is the number under test) and otherwise only
-- counts, kilograms, gaps and booleans.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blocking_price_lens_probe(p_trailing_days int DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today  date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_m0     date := date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date)::date;
  v_m1     date := (date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date) - interval '1 month')::date;
  v_m2     date := (date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date) - interval '2 months')::date;
  v_price  numeric;
BEGIN
  SELECT NULLIF(v.market_avg_price, 0) INTO v_price
  FROM public.view_analytics_rcin_monthly v WHERE v.month_start = v_m0;

  RETURN jsonb_build_object(
    'manila_today',   v_today,
    'this_month',     v_m0,
    'last_month',     v_m1,
    'trailing_days',  least(greatest(COALESCE(p_trailing_days, 30), 1), 400),

    -- the four basis rows, exactly as the function returns them
    'bases', COALESCE((
      SELECT jsonb_agg(to_jsonb(b) ORDER BY b.basis_key)
      FROM public.fn_blocking_market_bases(p_trailing_days) b), '[]'::jsonb),

    -- the SAME three statistics read straight from the analytics view, so the script
    -- can prove the reuse instead of trusting the COMMENT that claims it
    'rcin_this_month', (SELECT to_jsonb(x) FROM (
      SELECT NULLIF(v.market_avg_price, 0) AS php_kg, v.market_priced_kg AS priced_kg,
             v.market_delivery_count AS delivery_count
      FROM public.view_analytics_rcin_monthly v WHERE v.month_start = v_m0) x),
    'rcin_last_month', (SELECT to_jsonb(x) FROM (
      SELECT NULLIF(v.market_avg_price, 0) AS php_kg, v.market_priced_kg AS priced_kg,
             v.market_delivery_count AS delivery_count
      FROM public.view_analytics_rcin_monthly v WHERE v.month_start = v_m1) x),
    'rcin_last_3', (SELECT to_jsonb(x) FROM (
      SELECT NULLIF(sum(v.market_php_total) / NULLIF(sum(v.market_priced_kg), 0), 0) AS php_kg,
             COALESCE(sum(v.market_priced_kg), 0)          AS priced_kg,
             COALESCE(sum(v.market_delivery_count), 0)::int AS delivery_count
      FROM public.view_analytics_rcin_monthly v
      WHERE v.month_start >= v_m2 AND v.month_start <= v_m0) x),

    -- the grid's own totals, computed here independently of the lens
    'grid', (SELECT jsonb_build_object(
        'block_count',          count(*)::int,
        'kg',                   COALESCE(sum(g.balance), 0),
        'priced_block_count',   count(*) FILTER (WHERE g.avg_php_kg > 0)::int,
        'priced_kg',            COALESCE(sum(g.balance) FILTER (WHERE g.avg_php_kg > 0), 0),
        'unpriced_block_count', count(*) FILTER (WHERE g.avg_php_kg IS NULL OR g.avg_php_kg <= 0)::int,
        'unpriced_kg',          COALESCE(sum(g.balance) FILTER (WHERE g.avg_php_kg IS NULL OR g.avg_php_kg <= 0), 0))
      FROM public.view_blocking_grid g WHERE g.balance > 0),

    -- lenses: the live basis, a wide edge list, and the three R-rule cases
    'lens_live',       public.fn_blocking_price_lens(v_price),
    'lens_wide',       public.fn_blocking_price_lens(v_price, ARRAY[-10, -1, 0, 5]),
    'r_40_23',         public.fn_blocking_price_lens(40.23),
    'r_40_00',         public.fn_blocking_price_lens(40.00),
    'r_39_8568',       public.fn_blocking_price_lens(39.8568),

    -- refusals
    'refusal_null_price',     public.fn_blocking_price_lens(NULL::numeric),
    'refusal_zero_price',     public.fn_blocking_price_lens(0),
    'refusal_nan_price',      public.fn_blocking_price_lens('NaN'::numeric),
    'refusal_too_many_edges', public.fn_blocking_price_lens(40, ARRAY[-3, -2, -1, 0, 1, 2, 3]),
    'refusal_null_edge',      public.fn_blocking_price_lens(40, ARRAY[NULL, 0]::int[]),
    'refusal_no_edges',       public.fn_blocking_price_lens(40, ARRAY[]::int[]),

    -- catalog posture for all three functions
    'posture', jsonb_build_object(
      'bases_authenticated', has_function_privilege('authenticated', 'public.fn_blocking_market_bases(int)', 'EXECUTE'),
      'bases_anon',          has_function_privilege('anon',          'public.fn_blocking_market_bases(int)', 'EXECUTE'),
      'bases_service_role',  has_function_privilege('service_role',  'public.fn_blocking_market_bases(int)', 'EXECUTE'),
      'lens_authenticated',  has_function_privilege('authenticated', 'public.fn_blocking_price_lens(numeric, int[])', 'EXECUTE'),
      'lens_anon',           has_function_privilege('anon',          'public.fn_blocking_price_lens(numeric, int[])', 'EXECUTE'),
      'lens_service_role',   has_function_privilege('service_role',  'public.fn_blocking_price_lens(numeric, int[])', 'EXECUTE'),
      'probe_authenticated', has_function_privilege('authenticated', 'public.fn_blocking_price_lens_probe(int)', 'EXECUTE'),
      'probe_anon',          has_function_privilege('anon',          'public.fn_blocking_price_lens_probe(int)', 'EXECUTE'),
      'probe_service_role',  has_function_privilege('service_role',  'public.fn_blocking_price_lens_probe(int)', 'EXECUTE'),
      'invoker_count',       (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public'
                                 AND p.proname IN ('fn_blocking_market_bases', 'fn_blocking_price_lens')
                                 AND p.prosecdef = false),
      'stable_count',        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public'
                                 AND p.proname IN ('fn_blocking_market_bases', 'fn_blocking_price_lens', 'fn_blocking_price_lens_probe')
                                 AND p.provolatile = 's'),
      'search_path_pinned',  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public'
                                 AND p.proname IN ('fn_blocking_market_bases', 'fn_blocking_price_lens', 'fn_blocking_price_lens_probe')
                                 AND p.proconfig @> ARRAY['search_path=public']),
      'commented_count',     (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public'
                                 AND p.proname IN ('fn_blocking_market_bases', 'fn_blocking_price_lens')
                                 AND obj_description(p.oid, 'pg_proc') IS NOT NULL)
    )
  );
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_price_lens_probe(int) IS
'Read-only ACCESS BRIDGE so scripts/verify-blocking-price-lens.ts can exercise the two authenticated-only price-lens functions with the service-role key it holds. It ASSERTS NOTHING — it calls them a fixed number of times, reads the same three statistics straight from view_analytics_rcin_monthly and the grid''s own totals independently, and hands everything back so every assertion lives in the script where a human can read it. Deliberately NOT a whole-database verifier (the 2026-09-14 fn_ops_ledger_verify incident): both populations are bounded by construction — one row per occupied block, and a delivery window clamped to 400 days. SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) TO service_role;
