-- ─────────────────────────────────────────────────────────────────────────────
-- THE MARKET CONTEXT BEHIND THE LENS PRINTS — a CURRENT-QUARTER basis, a market
-- time series, and a per-supplier price-vs-volume series.
--
--   §1  fn_blocking_market_bases  gains a `this_quarter` row — additive, same signature
--   §2  fn_blocking_market_context(p_months)        NEW — the market's own series
--   §3  fn_blocking_supplier_market(p_months, keys) NEW — one series per supplier
--   §4  fn_blocking_market_context_probe()          NEW — access bridge, MARKET half
--   §5  fn_blocking_supplier_market_probe()         NEW — access bridge, SUPPLIER half
--
-- The lens prints say what the yard looks like TODAY against one number. They cannot say
-- whether that number is high or low, or which supplier moved it — and a print that wants
-- to say so would have to average a price in TypeScript, which CLAUDE.md forbids. So the
-- context is computed where every other market figure already is.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §A  "MARKET" GETS NO SECOND DEFINITION — every figure in this file is SELECTed
-- ═════════════════════════════════════════════════════════════════════════════
-- Market = the weighted average ₱/kg of MARKET-class PRICED deliveries:
--   fn_delivery_class(batch_code, supplier, remarks) = 'market'  AND  cost_basis > 0
--   SUM(cost_basis × weight_kg) / SUM(weight_kg)
--
-- and that statistic already has a home — `view_analytics_rcin_monthly` (analytics
-- Phase 1), which CLAUDE.md records as byte-identical to `view_delivery_monthly_analytics`
-- on every month precisely so the platform never grows a second "monthly average purchase
-- price". EVERY month, quarter, year and trailing figure in §1 and §2 is **Σ market_php_total
-- ÷ Σ market_priced_kg** over that view's own rows. Never the mean of monthly averages,
-- which would weight a light month equally with a heavy one.
--
-- §3 does the same one level down: `view_analytics_supplier_monthly` (Phase 3) owns supplier
-- identity (`canonical_supplier()`), the per-supplier weighted price, `share_of_month_pct`
-- and `premium_php_kg`, and joins its month baseline FROM the Phase-1 view — which is
-- exactly what makes a supplier's share and premium structurally incapable of disagreeing
-- with the monthly matrix. This function aggregates those rows; it re-derives nothing.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §B  A MONTH WITH NO DELIVERY HAS NO ROW — the spine is rows, not a calendar
-- ═════════════════════════════════════════════════════════════════════════════
-- `view_analytics_rcin_monthly` has one row per calendar month THAT HAD A DELIVERY, so
-- "the last 12 months" here means the last 12 months that HAVE a row, ascending — not the
-- last 12 calendar months. That is the Phase-1 rule carried across rather than patched: the
-- complete zero-filled month spine is `view_analytics_flow_monthly`, and substituting it
-- here would invent ₱0 months, which is the L-008 mistake with a calendar instead of a
-- price. Measured 2026-09-22: 50 rows, 2020-07 … 2026-09, so a 12-month window is dense
-- today and a 36-month one reaches back to 2023.
--
-- `trailing_12m`, `year_to_date` and `quarters[]` are DATE-bounded rather than row-bounded,
-- because "the last 12 calendar months" and "this year" are date questions. They therefore
-- aggregate over whatever rows fall inside those dates and carry a `month_count` so a
-- reader can see how many months answered.
--
-- A QUARTER AT THE WINDOW EDGE IS PARTIAL, and that is why every `quarters[]` entry carries
-- `month_count`, `first_month` and `last_month`: a 12-month window starting mid-quarter
-- shows a one-month quarter, and without the count it would read as a full one. `is_current`
-- flags the quarter containing the Manila month, which is partial for a different reason
-- (it has not finished yet).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §C  THE `this_quarter` BASIS, AND WHY IT COSTS NOTHING
-- ═════════════════════════════════════════════════════════════════════════════
-- Renzo wants the price lens to open on the CURRENT QUARTER by default, which is the basis
-- the four existing ones could not express: `this_month` is noisy early in a month,
-- `last_3_months` is a rolling three regardless of where the quarter boundary falls, and
-- `trailing_days` does not align to one at all. `this_quarter` is the quarter TO DATE —
-- the same weighted expression, over the current Asia/Manila calendar quarter's rows.
--
-- **IT NEEDS NO NEW READ, and that is arithmetic rather than luck.** The quarter to date is
-- month 1, 2 or 3 of the quarter, so it always spans at most three months ending with the
-- current one — exactly the `m2 … m0` window the existing `months` CTE already
-- MATERIALIZES for `last_3_months`. So the row is a FILTERed aggregate over a CTE that was
-- already there, and the function's cost does not move.
--
-- **THE ROW IS ADDITIVE, BUT IT SHIFTS AN ORDINAL.** The function returns rows in a fixed
-- order and `this_quarter` is placed with the other calendar bases, at sort position 4,
-- pushing `trailing_days` from 4 to 5. Every existing ROW is byte-identical in content and
-- every caller in this codebase keys by `basis_key` (the server action maps rows to
-- `basisKey`, never to an index), so nothing reads the ordinal — but a caller that did
-- would move, which is why it is said here rather than left to be discovered.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §D  NULL IS NEVER 0, EVERYWHERE — five separate places
-- ═════════════════════════════════════════════════════════════════════════════
--   a price        NULL when the window has no priced market kilos. A lens built on ₱0
--                 would put every block above market. Never coerce it.
--   a premium      NULL when either side has no priced kilos — "we don't know" and
--                 "exactly at market" are different answers (the Phase-3 rule).
--   a correlation  NULL below THREE active months. Two points always correlate perfectly,
--                 so a two-month `corr` of ±1 is arithmetic, not a finding.
--   a change       NULL when the first month has no price, or its price is 0, so there is
--                 nothing to change FROM.
--   a direction    NULL when the change it reads is NULL. "Flat" is a claim.
--
-- A KILOGRAM or a COUNT is a real 0 in the same situations, because it is a WEIGHT and
-- zero kilograms is a measurement — the `priced_dominant_kg` asymmetry again.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §E  `premium_php_kg` MAY ONLY BE AVERAGED WEIGHTED BY PRICED KG
-- ═════════════════════════════════════════════════════════════════════════════
-- CLAUDE.md states it and it is load-bearing here: the month's market price IS the
-- priced-kg-weighted mean of its suppliers' prices, so weighted by priced kg the premium is
-- **zero by construction** across a whole month (measured max |deviation| 7.1e-17 over all
-- 49 months when that view shipped). An UNWEIGHTED average of the column is meaningless.
-- `summary.avg_premium_php_kg` is therefore Σ(premium × priced_kg) ÷ Σ(priced_kg) over the
-- months where the premium exists, and NULL — never 0 — when none do.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §F  ₱-BEARING, AND THE GATE IS A REFUSAL — not a nulling pass
-- ═════════════════════════════════════════════════════════════════════════════
-- Both new functions are money almost end to end. §2's whole reason to exist is a price
-- series. §3 carries `avg_price_php_kg`, `premium_php_kg`, `kg_weighted_php_kg`, both
-- prices, both changes AND `price_volume_corr`, which is DERIVED FROM price and therefore
-- price information however it is labelled.
--
-- **A nulled variant was considered and rejected, and the reason is stated rather than
-- assumed:** what would survive is a per-supplier monthly kilogram series with its share
-- and delivery count — which `view_digest_rcin_supplier_daily` and
-- `fn_blocking_supplier_lens` already publish to every role, at grains that suit their own
-- screens. Keeping a third, half-blank copy alive for a reader who has two better ones is
-- how a payload acquires a second meaning. So `fetchBlockingMarketContext` and
-- `fetchBlockingSupplierMarket` call the canonical `canViewPrices()` FIRST and return
-- `{ok:false, reason:'prices_hidden'}` WITHOUT TOUCHING THE DATABASE — the
-- `fetchBlockingPriceLens` idiom, not the supplier lens's two-key nulling.
--
-- The SQL is NOT the gate and must never become one: both are `authenticated`-only and
-- return their figures to every signed-in caller, exactly as `fn_blocking_price_lens` does.
-- Price visibility is a fact about the READER, so it is resolved where the reader is known.
-- `anon` REVOKEd; **NOT `service_role`** — no sync worker reads either, so
-- `verify-worker-view-grants` stays at 4 views / 0 findings.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §G  REFUSALS, NOT CLAMPS — and why that differs from §1
-- ═════════════════════════════════════════════════════════════════════════════
-- `fn_blocking_market_bases` CLAMPS its `p_trailing_days` to 1..400 because it
-- `RETURNS TABLE` and has no channel for a readable refusal — a junk N from a stale client
-- still gets a usable window, and the row says which one via `from_date`/`to_date`.
-- The two new functions return **jsonb**, so they can refuse the way every lens does:
-- `{ok:false, reason, message}` written for a human, never a RAISE. `p_months` is 1..36
-- (`invalid_months`; NULL is refused rather than defaulted, because a caller that passed
-- NULL meant something and silently substituting 12 answers a question nobody asked — the
-- `fn_blocking_supplier_lens` rule). `p_supplier_keys` takes at most 40 entries
-- (`too_many_suppliers`); NULL means EVERY supplier active in the window.
--
-- A key that matches nothing in the window returns **no entry**, never a zero-filled row:
-- "this supplier sold nothing in this window" and "this supplier sold 0 kg" are the same
-- statement, and inventing a row to say it would put a supplier on a chart it is absent
-- from. The caller compares the keys it asked for against the keys it got back.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §H  COST, MEASURED BEFORE ANY PROOF WAS WRITTEN (the 2026-09-14 rule)
-- ═════════════════════════════════════════════════════════════════════════════
-- `set local statement_timeout='5s'` then EXPLAIN (ANALYZE, BUFFERS), 2026-09-22:
--   view_analytics_rcin_monthly alone (50 rows)                   1.4 ms /  80 buffers
--   view_analytics_supplier_monthly alone (281 rows)            164.1 ms / 128 buffers
--   fn_blocking_market_bases(30)  BEFORE §1                     118.8 ms / 1,126 buffers
--   §2's core query as written below                             227.0 ms / 131 buffers
--   §3's core query as written below (12-month window)           261.7 ms / 200 buffers
--
-- **THE COST IS `fn_delivery_class` PER DELIVERY, PAID INSIDE THE VIEW, AND IT IS PAID
-- ONCE.** Both cores read their analytics view exactly once (`src AS MATERIALIZED`; the
-- plans show a single 128-buffer / 120-buffer scan feeding every downstream CTE), and the
-- remaining milliseconds are that view's own `Seq Scan on deliveries` with the class
-- function evaluated per row — 1,780 rows today. **The window does NOT reduce it and cannot:**
-- the date bound filters the view's already-grouped output, so narrowing `p_months` from 36
-- to 1 saves nothing. Making it cheaper would mean re-deriving "market" against the raw
-- table with a date predicate, which is exactly the second definition §A exists to forbid.
--
-- Every population is bounded BY CONSTRUCTION: 50 monthly rows for all of history (75 in
-- `view_analytics_flow_monthly`'s complete spine, so ~1 row per month forever), and
-- **267 (supplier × month) rows inside the 36-month maximum** window against 281 for all
-- of history — three orders of magnitude under PostgREST's 1,000-row cap, and neither can
-- grow into a whole-history scan because history is already what they read.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §I  THE IDENTITY AGREEMENT, MEASURED — the supplier lens and this share a name space
-- ═════════════════════════════════════════════════════════════════════════════
-- `fn_blocking_supplier_lens` keys on `view_blocking_block_suppliers.supplier_key`
-- (`canonical_supplier(split_part(supplier, ' - ', 1))`) and this function keys on
-- `view_analytics_supplier_monthly.supplier_canonical` (`canonical_supplier(supplier)`).
-- Those are DIFFERENT EXPRESSIONS, so the frontend passing the lens's band keys straight in
-- is a claim that needs proving, not assuming. Three measurements, all 2026-09-22:
--
--   **the strip is NOT a no-op in general — of the 68 DISTINCT supplier strings in
--   `deliveries`, 16 change under it.** Those are the sundry re-entries carrying a
--   `- <BATCH>` suffix (`Layupan - JAN-26-BLK9`), which is precisely why the blocking view
--   strips and why Phase 3 keys its `sundry_origin_kg` the same way. Measuring it over
--   DISTINCT STRINGS rather than per row is both cheaper (87 ms against 150) and a
--   STRONGER statement, because it shows the 16 exist rather than only that they are absent
--   from one population.
--
--   **and NOT ONE of the 1,683 MARKET deliveries carries any of those 16 strings** — so on
--   the population this function actually reads, the two expressions agree exactly. That
--   is the claim the frontend depends on, and it is checked as "no market delivery is in
--   the differing set", which needs no class call at all while the set stays empty.
--
--   **every one of the yard's 17 supplier keys is a supplier the analytics view knows —
--   0 unknown** (27 canonical suppliers across all history).
--
-- All three are asserted every verify run, so a future change to either expression fails
-- here rather than silently returning an empty series for a supplier standing in the yard.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §J  THE PROBE IS TWO PROBES, AND EACH FORWARDED CALL IS ITS OWN STATEMENT
-- ═════════════════════════════════════════════════════════════════════════════
-- The first version of the access bridge was ONE function assembling every forwarded call
-- inside a single `jsonb_build_object`. **It timed out at 20 s** — not because any one
-- figure is slow (the identity block is 87 ms, a context call 240 ms, a supplier call
-- 290 ms) but because fourteen references to two expensive `security_invoker` views inside
-- ONE expression are fourteen executions the planner interleaves.
--
-- That is the 2026-09-14 `fn_ops_ledger_verify()` shape arriving a second time, and it gets
-- the same answer: **split by concern, and make each expensive call its own statement.**
-- So there are two probes — `fn_blocking_market_context_probe()` and
-- `fn_blocking_supplier_market_probe()` — and inside each one every forwarded payload is
-- assigned to a VARIABLE first, because a plpgsql assignment is planned and executed on its
-- own. The final `jsonb_build_object` then only reads variables.
--
-- Neither probe asserts anything. MEASURED after the split, 2026-09-22, as wall clock from
-- a laptop over the REST round trip: **context probe 2.93 s, supplier probe 2.77 s**, and
-- the untouched `fn_blocking_price_lens_probe` 0.96 s — against a 20 s server-side timeout
-- that the single combined version blew. Note the two halves come out roughly EQUAL: the
-- combined version was not one slow half plus one fast one, it was both halves' view
-- executions interleaved in a single plan.
--
-- ONE HONEST DIFFERENCE IN NAMING: `view_analytics_supplier_monthly` publishes only the
-- CANONICAL name, so `suppliers[].display` equals `suppliers[].key` here. The supplier LENS
-- has a prettier `supplier_display` (the `mode()` of the raw spellings — "Ornales" rather
-- than "ORNALES"), so a UI showing both should take the label from the lens and join on the
-- key. This function does not invent a display name it does not have.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- §1  fn_blocking_market_bases — the fifth basis, `this_quarter`
-- ═════════════════════════════════════════════════════════════════════════════
-- Everything below is verbatim from 20260919025729 §1 except the `q0` anchor and the one
-- new UNION ALL arm. See §C for why it needs no new read and for the ordinal shift.
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
           -- NEW 2026-09-22. The first month of the CURRENT Asia/Manila calendar quarter.
           -- It is always m0, m1 or m2, which is why the `months` CTE below already
           -- covers the quarter to date and this basis costs no extra read. See §C.
           date_trunc('quarter', (now() AT TIME ZONE 'Asia/Manila')::date)::date       AS q0,
           -- Clamp, never refuse: a junk N from a stale client still returns a usable
           -- window, and the row says which one it used via from_date/to_date.
           least(greatest(COALESCE(p_trailing_days, 30), 1), 400)                      AS days
  ),
  -- READ THE ANALYTICS VIEW ONCE. It is a full pass over `deliveries` with
  -- fn_delivery_class evaluated per row and then grouped by month, so letting the
  -- calendar bases each reference it separately costs a pass each: MEASURED
  -- 330 ms / 1,291 buffers before this CTE, 133 ms / 176 after. The window m2..m0 is
  -- exactly the months all FOUR calendar bases need.
  months AS MATERIALIZED (
    SELECT v.month_start, v.market_avg_price, v.market_priced_kg,
           v.market_php_total, v.market_delivery_count
    FROM public.view_analytics_rcin_monthly v, anchor a
    WHERE v.month_start >= a.m2 AND v.month_start <= a.m0
  ),
  -- THE TRAILING WINDOW GETS ITS OWN CTE (named trail_window: TRAILING is reserved) so the
  -- DATE bound is a plain WHERE the planner may apply BEFORE fn_delivery_class. Inside a
  -- LEFT JOIN's ON clause it could not, and the class function then ran on all 1,765
  -- deliveries rather than the ~52 in the window.
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

    -- NEW 2026-09-22. THIS QUARTER TO DATE — the SAME weighted expression, over the
    -- current Asia/Manila calendar quarter's months only. The FILTER is what makes this
    -- free: `months` already holds m2..m0 and the quarter to date is a suffix of that
    -- window (see §C), so no additional relation is touched. `from_date`/`to_date` are the
    -- QUARTER's own bounds, so `to_date` is in the future for an unfinished quarter —
    -- exactly as `this_month`'s already is mid-month. Placed with the calendar bases,
    -- which pushes trailing_days from ordinal 4 to 5; every caller keys by basis_key.
    SELECT 4,
           'this_quarter'::text,
           NULLIF(sum(v.market_php_total)  FILTER (WHERE v.month_start >= a.q0)
                    / NULLIF(sum(v.market_priced_kg) FILTER (WHERE v.month_start >= a.q0), 0), 0),
           COALESCE(sum(v.market_priced_kg)      FILTER (WHERE v.month_start >= a.q0), 0),
           COALESCE(sum(v.market_delivery_count) FILTER (WHERE v.month_start >= a.q0), 0)::int,
           a.q0,
           (a.q0 + interval '3 months' - interval '1 day')::date
    FROM anchor a
    LEFT JOIN months v ON TRUE
    GROUP BY a.q0

    UNION ALL

    -- TRAILING N DAYS — the one basis with no monthly home. The predicate and the
    -- expression are lifted arm for arm from view_analytics_rcin_monthly: the price
    -- is weighted over PRICED market deliveries, the count covers ALL market
    -- deliveries. NO UPPER BOUND on the date, so a future-dated delivery is never
    -- invisible (the digest-view idiom); from_date/to_date name the window ANCHORS.
    SELECT 5,
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
'What "market" costs right now, FIVE ways, for the Blocking page price lens: this_month, last_month, last_3_months, this_quarter and trailing_days (N clamped to 1..400, default 30). Market means the weighted average PHP/kg of MARKET-class PRICED deliveries — fn_delivery_class(...) = ''market'' AND cost_basis > 0, SUM(cost_basis * weight_kg) / SUM(weight_kg). The four calendar bases SELECT that statistic from view_analytics_rcin_monthly rather than re-deriving it, so the lens can never disagree with the analytics matrix; last_3_months and this_quarter divide the summed money by the summed priced kilos (never the mean of monthly averages, which would weight a light month equally with a heavy one). Only trailing_days reads deliveries directly, with the identical predicate and expression, windowed on the Asia/Manila calendar date with no upper bound so a future-dated delivery is never invisible.
ADDED 2026-09-22: this_quarter is the CURRENT Asia/Manila calendar quarter TO DATE — the basis the other four could not express, since this_month is noisy early in a month, last_3_months is a rolling three wherever the quarter boundary falls, and trailing_days does not align to one at all. IT NEEDS NO NEW READ, and that is arithmetic not luck: the quarter to date always spans at most the three months m2..m0 that the months CTE already materializes for last_3_months, so the row is a FILTERed aggregate over a CTE that was already there. Its from_date/to_date are the QUARTER''s own bounds, so to_date is in the future for an unfinished quarter, exactly as this_month''s already is mid-month. IT IS ADDITIVE BUT IT SHIFTS AN ORDINAL: placed with the calendar bases at sort position 4, it pushes trailing_days from 4 to 5. Every existing row is byte-identical in content and every caller keys by basis_key, never by index — said here rather than left to be discovered. The UI should DEFAULT a first-time price lens to this_quarter.
market_php_kg is NULL, never 0, when a basis has no priced market kilos; priced_kg and delivery_count are real 0s there, because they are weights and zero kilograms is a measurement. CARRIES MONEY: every caller is subject to canViewPrices() and the server action refuses a price-denied role BEFORE calling. authenticated only; anon revoked; service_role deliberately not granted (no sync worker reads it).';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_market_bases(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_market_bases(int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_market_bases(int) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §2  fn_blocking_market_context — the market's OWN series, four grains
-- ═════════════════════════════════════════════════════════════════════════════
-- Reading notes (kept OUT of the body so `prosrc` is exactly what this file says):
--   src    view_analytics_rcin_monthly, read EXACTLY ONCE. Six CTEs reference it.
--   win    the last N months that HAVE a row, by row_number over month_start DESC.
--          Emitted ASCENDING, because a series is read left to right.
--   qtr    the quarters those months fall in. A quarter at the window edge is PARTIAL
--          and says so through month_count / first_month / last_month.
CREATE OR REPLACE FUNCTION public.fn_blocking_market_context(p_months int DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_n      int;
  v_result jsonb;
BEGIN
  -- A NULL N cannot bound a window, so it is REFUSED rather than defaulted: a caller that
  -- passed NULL meant something. (Omitting the argument still gets the DEFAULT 12.)
  IF p_months IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_months',
      'message', 'Choose how many months of market history to show — between 1 and 36.');
  END IF;

  -- A fractional N is NOT detectable here (the parameter is `int`, so Postgres rounded it
  -- already) and is enforced in the server action under this same `invalid_months` reason.
  IF p_months < 1 OR p_months > 36 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_months',
      'message', format(
        'A market history covers between 1 and 36 months; this one asked for %s.', p_months));
  END IF;

  v_n := p_months;

  WITH anchor AS (
    SELECT (now() AT TIME ZONE 'Asia/Manila')::date                             AS today,
           date_trunc('month',   (now() AT TIME ZONE 'Asia/Manila')::date)::date AS m0,
           date_trunc('quarter', (now() AT TIME ZONE 'Asia/Manila')::date)::date AS q0,
           date_trunc('year',    (now() AT TIME ZONE 'Asia/Manila')::date)::date AS y0
  ),
  src AS MATERIALIZED (
    -- ONE read. Six CTEs below reference it, and it is a full pass over `deliveries` with
    -- fn_delivery_class per row — see §H.
    SELECT v.month_start, v.market_kg, v.market_priced_kg, v.market_avg_price,
           v.market_php_total, v.market_delivery_count, v.active_suppliers
    FROM public.view_analytics_rcin_monthly v
  ),
  ranked AS (
    SELECT s.*, row_number() OVER (ORDER BY s.month_start DESC)::int AS rn FROM src s
  ),
  win AS MATERIALIZED (
    SELECT * FROM ranked WHERE rn <= v_n
  ),
  qtr AS (
    SELECT date_trunc('quarter', w.month_start)::date AS q_start,
           count(*)::int                             AS month_count,
           min(w.month_start)                        AS first_month,
           max(w.month_start)                        AS last_month,
           sum(w.market_kg)                          AS kg,
           sum(w.market_priced_kg)                   AS priced_kg,
           sum(w.market_php_total)                   AS php_total,
           sum(w.market_delivery_count)::int         AS delivery_count
    FROM win w
    GROUP BY date_trunc('quarter', w.month_start)::date
  ),
  -- The three DATE-bounded aggregates. Each is over `src`, not `win`: "this year" is a
  -- date question and must not be truncated by the row window the caller chose.
  ytd AS (
    SELECT count(*)::int AS month_count, min(s.month_start) AS first_month, max(s.month_start) AS last_month,
           sum(s.market_kg) AS kg, sum(s.market_priced_kg) AS priced_kg,
           sum(s.market_php_total) AS php_total, sum(s.market_delivery_count)::int AS delivery_count
    FROM src s, anchor a WHERE s.month_start >= a.y0 AND s.month_start <= a.m0
  ),
  t12 AS (
    SELECT count(*)::int AS month_count, min(s.month_start) AS first_month, max(s.month_start) AS last_month,
           sum(s.market_kg) AS kg, sum(s.market_priced_kg) AS priced_kg,
           sum(s.market_php_total) AS php_total, sum(s.market_delivery_count)::int AS delivery_count
    FROM src s, anchor a
    WHERE s.month_start >= (a.m0 - interval '11 months')::date AND s.month_start <= a.m0
  ),
  latest AS (
    SELECT s.* FROM src s ORDER BY s.month_start DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'ok', true,
    'months_requested', v_n,
    'as_of', (SELECT a.today FROM anchor a),
    -- THE MONTH SERIES. The last N months that HAVE a row, ASCENDING. A month with no
    -- delivery has no row at all — see §B; that is the Phase-1 rule, not a gap to fill.
    'months', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'month',            w.month_start,
               -- The view's own column verbatim. NULL, never 0, with no priced kilos.
               'market_php_kg',    NULLIF(w.market_avg_price, 0),
               'market_kg',        w.market_kg,
               'market_priced_kg', w.market_priced_kg,
               'delivery_count',   w.market_delivery_count,
               'active_suppliers', w.active_suppliers)
             ORDER BY w.month_start)
      FROM win w), '[]'::jsonb),
    -- THE QUARTERS THOSE MONTHS SPAN. month_count is what tells a reader a quarter at the
    -- window edge is partial; is_current flags the one that has not finished.
    'quarters', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'quarter_key',    to_char(q.q_start, 'YYYY') || '-Q' || to_char(q.q_start, 'Q'),
               'label',          'Q' || to_char(q.q_start, 'Q') || ' ' || to_char(q.q_start, 'YYYY'),
               'quarter_start',  q.q_start,
               'market_php_kg',  NULLIF(q.php_total / NULLIF(q.priced_kg, 0), 0),
               'market_kg',      q.kg,
               'market_priced_kg', q.priced_kg,
               'delivery_count', q.delivery_count,
               'month_count',    q.month_count,
               'first_month',    q.first_month,
               'last_month',     q.last_month,
               'is_current',     (q.q_start = (SELECT a.q0 FROM anchor a)))
             ORDER BY q.q_start)
      FROM qtr q), '[]'::jsonb),
    -- YEAR TO DATE. from_date is 1 January; to_date is the END of the current month, the
    -- same window-ANCHOR convention `this_month` already uses in fn_blocking_market_bases
    -- (the rows are whole months, so a to_date of "today" would misdescribe them).
    'year_to_date', (SELECT jsonb_build_object(
        'market_php_kg',    NULLIF(y.php_total / NULLIF(y.priced_kg, 0), 0),
        'market_kg',        COALESCE(y.kg, 0),
        'market_priced_kg', COALESCE(y.priced_kg, 0),
        'delivery_count',   COALESCE(y.delivery_count, 0),
        'month_count',      y.month_count,
        'from_date',        a.y0,
        'to_date',          (a.m0 + interval '1 month' - interval '1 day')::date)
      FROM ytd y, anchor a),
    -- TRAILING 12 CALENDAR MONTHS, ending with the current one. DATE-bounded, so it is not
    -- the same thing as `months` when the history has gaps.
    'trailing_12m', (SELECT jsonb_build_object(
        'market_php_kg',    NULLIF(t.php_total / NULLIF(t.priced_kg, 0), 0),
        'market_kg',        COALESCE(t.kg, 0),
        'market_priced_kg', COALESCE(t.priced_kg, 0),
        'delivery_count',   COALESCE(t.delivery_count, 0),
        'month_count',      t.month_count,
        'from_date',        (a.m0 - interval '11 months')::date,
        'to_date',          (a.m0 + interval '1 month' - interval '1 day')::date)
      FROM t12 t, anchor a),
    -- THE MOST RECENT MONTH THAT HAS A ROW. Not necessarily the current month.
    'latest_month', (SELECT jsonb_build_object(
        'month',            l.month_start,
        'market_php_kg',    NULLIF(l.market_avg_price, 0),
        'market_kg',        l.market_kg,
        'market_priced_kg', l.market_priced_kg,
        'delivery_count',   l.market_delivery_count,
        'active_suppliers', l.active_suppliers,
        'is_current_month', (l.month_start = (SELECT a.m0 FROM anchor a)))
      FROM latest l),
    -- How many months of history exist at all, so a UI can say "12 of 50" rather than
    -- silently showing everything when the caller asked for more than there is.
    'months_available', (SELECT count(*)::int FROM src),
    'months_returned',  (SELECT count(*)::int FROM win)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_market_context(int) IS
'THE MARKET''S OWN SERIES, for the Blocking price lens print''s context block — what market has been costing, so a lens built on one number can say whether that number is high or low. Every figure is SELECTed or summed from view_analytics_rcin_monthly (analytics Phase 1), which OWNS "monthly average purchase price"; nothing here re-derives it, and every aggregate is Sigma market_php_total / Sigma market_priced_kg — never the mean of monthly averages, which would weight a light month equally with a heavy one.
p_months is 1..36, default 12. months[] is THE LAST N MONTHS THAT HAVE A ROW, ascending — not the last N calendar months: view_analytics_rcin_monthly has one row per month that had a delivery, and substituting view_analytics_flow_monthly''s complete zero-filled spine would invent PHP 0 months, the L-008 mistake with a calendar instead of a price. Measured 2026-09-22: 50 rows exist, 2020-07 to 2026-09, so months_available / months_returned let a UI say "12 of 50". quarters[] are the quarters those months span, and A QUARTER AT THE WINDOW EDGE IS PARTIAL — month_count, first_month and last_month are what say so, while is_current flags the quarter that has not finished. year_to_date and trailing_12m are DATE-bounded rather than row-bounded, because "this year" and "the last 12 calendar months" are date questions, and their to_date is the END of the current month, the same window-ANCHOR convention this_month already uses in fn_blocking_market_bases (the rows are whole months, so a to_date of today would misdescribe them). latest_month is the most recent month with a row and is not necessarily the current one — read is_current_month.
NULL IS NEVER 0: a market price is NULL when the window has no priced market kilos, because a lens built on PHP 0 would call every block above market; kilograms and counts are real 0s in the same situation, because they are weights and zero kilograms is a measurement. Every business refusal is jsonb {ok:false, reason, message} written for a human, never a raise: invalid_months (NULL, below 1, or above 36) — NULL is refused rather than defaulted, because a caller that passed NULL meant something.
COST: the analytics view is read EXACTLY ONCE (src AS MATERIALIZED; six CTEs reference it) and the ~230 ms is that view''s own Seq Scan on deliveries with fn_delivery_class evaluated per row. The window does NOT reduce it and cannot — the date bound filters already-grouped output — and making it cheaper would mean re-deriving "market" against the raw table, which is the second definition this function exists to avoid. Bounded by construction: ~1 row per calendar month, forever.
THE WHOLE PAYLOAD IS MONEY and there is no price-free half worth keeping: fetchBlockingMarketContext calls canViewPrices() FIRST and returns {ok:false, reason:''prices_hidden''} WITHOUT touching the database — the fn_blocking_price_lens idiom, not the supplier lens''s two-key nulling. The SQL is NOT the gate and must not become one; price visibility is a fact about the READER. authenticated only; anon revoked; service_role deliberately not granted.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_market_context(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_market_context(int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_market_context(int) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §3  fn_blocking_supplier_market — price vs volume, one series per supplier
-- ═════════════════════════════════════════════════════════════════════════════
-- Reading notes (kept OUT of the body so `prosrc` is exactly what this file says):
--   src     view_analytics_supplier_monthly, read EXACTLY ONCE, windowed to the last N
--           calendar months and **NOT filtered by `p_supplier_keys`**. MARKET deliveries
--           only — that is the view's own population.
--   spine   the distinct months `src` covers, so THE SPINE IS THE WINDOW'S, NOT THE
--           SELECTION'S. That distinction was found by testing an unknown key: with the
--           filter applied to `src`, asking for a supplier that sold nothing returned an
--           EMPTY spine, which would leave a chart with no axis to draw a gap on. The
--           filter therefore lives downstream, and the cost does not move — it never
--           reduced the view scan, only the rows the CTE carried. The verify script proves
--           this spine equals `view_analytics_rcin_monthly`'s own last-N months, so the
--           two spines are ONE.
--   sel     `src` narrowed to the requested keys. Every per-supplier figure reads this.
--   act     the ACTIVE months of each SELECTED supplier (kg > 0). Every summary figure
--           that talks about a first or a last month reads this, never a sundry-only row.
--   mkt     the ACTIVE months of the WHOLE window — the comparison baseline, so a
--           supplier row is comparable to the market and not merely to its neighbours in
--           the selection. `window_total` is this; `selected_total` is `act`. With no
--           filter the two are equal, and the verify script asserts that.
--   agg     one row per supplier. `corr` is Postgres' own Pearson correlation and is
--           NULL below three active months — two points always correlate perfectly.
CREATE OR REPLACE FUNCTION public.fn_blocking_supplier_market(
  p_months        int    DEFAULT 12,
  p_supplier_keys text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_n      int;
  v_keys   text[];
  v_result jsonb;
  -- THE DEAD BAND, stated as a number rather than buried in a CASE: a price move inside
  -- ±2% is called `flat`, because month-to-month noise on a weighted purchase price is
  -- routinely a peso and calling every such wobble a trend is how a chart starts lying.
  -- It is published in the payload so a UI can label it and a test can pin it.
  v_dead   numeric := 2.0;
BEGIN
  IF p_months IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_months',
      'message', 'Choose how many months of supplier history to show — between 1 and 36.');
  END IF;

  IF p_months < 1 OR p_months > 36 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_months',
      'message', format(
        'A supplier history covers between 1 and 36 months; this one asked for %s.', p_months));
  END IF;

  v_n := p_months;

  -- NULL means EVERY supplier active in the window. A list is de-duplicated and stripped
  -- of NULL / blank entries first, so the cap is measured on the REAL list — the
  -- fn_blocking_price_lens edge rule.
  IF p_supplier_keys IS NULL THEN
    v_keys := NULL;
  ELSE
    SELECT array_agg(DISTINCT btrim(x)) INTO v_keys
    FROM unnest(p_supplier_keys) AS x
    WHERE x IS NOT NULL AND btrim(x) <> '';

    IF v_keys IS NULL OR cardinality(v_keys) = 0 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'no_suppliers',
        'message', 'Name at least one supplier, or ask for all of them by passing none.');
    END IF;

    IF cardinality(v_keys) > 40 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'too_many_suppliers',
        'message', format(
          'A supplier comparison takes at most 40 suppliers; this one asked for %s.',
          cardinality(v_keys)));
    END IF;
  END IF;

  WITH anchor AS (
    SELECT (now() AT TIME ZONE 'Asia/Manila')::date                             AS today,
           date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date)::date  AS m0
  ),
  src AS MATERIALIZED (
    -- ONE read, and DELIBERATELY UNFILTERED by key. MARKET deliveries only — the view's
    -- own population, so a sundry re-entry and a re-cook fee are never supplier volume
    -- (fn_delivery_class). Windowed to the last N calendar months ending with the current
    -- one. The key filter is applied in `sel` below so the SPINE stays the window's.
    SELECT s.month_start, s.supplier_canonical, s.kg, s.priced_kg, s.avg_price_php_kg,
           s.php_total, s.premium_php_kg, s.share_of_month_pct, s.delivery_count,
           s.month_avg_price_php_kg
    FROM public.view_analytics_supplier_monthly s, anchor a
    WHERE s.month_start >  (a.m0 - make_interval(months => v_n))::date
      AND s.month_start <= a.m0
  ),
  spine AS (
    -- THE WINDOW'S months, not the selection's. See the reading note: filtering `src`
    -- made an unknown key return an empty spine, i.e. a chart with no axis.
    SELECT DISTINCT s.month_start FROM src s
  ),
  sel AS MATERIALIZED (
    SELECT s.* FROM src s
    WHERE v_keys IS NULL OR s.supplier_canonical = ANY (v_keys)
  ),
  mkt AS (
    -- The WHOLE window's active rows — the comparison baseline, unaffected by the filter.
    SELECT s.* FROM src s WHERE s.kg > 0
  ),
  act AS MATERIALIZED (
    -- The SELECTED suppliers' ACTIVE months: a real purchase. A row with kg = 0 is a
    -- sundry-only pair (the Phase-3 view emits those) and must not become a first or a
    -- last month.
    SELECT s.* FROM sel s WHERE s.kg > 0
  ),
  first_last AS (
    SELECT a.supplier_canonical,
           (array_agg(a.month_start      ORDER BY a.month_start))[1]      AS first_month,
           (array_agg(a.month_start      ORDER BY a.month_start DESC))[1] AS last_month,
           (array_agg(a.avg_price_php_kg ORDER BY a.month_start))[1]      AS first_price,
           (array_agg(a.avg_price_php_kg ORDER BY a.month_start DESC))[1] AS last_price,
           (array_agg(a.kg               ORDER BY a.month_start))[1]      AS first_kg,
           (array_agg(a.kg               ORDER BY a.month_start DESC))[1] AS last_kg
    FROM act a
    GROUP BY a.supplier_canonical
  ),
  agg AS (
    SELECT a.supplier_canonical                                    AS k,
           count(*)::int                                           AS months_active,
           sum(a.kg)                                               AS total_kg,
           sum(a.priced_kg)                                        AS total_priced_kg,
           sum(a.delivery_count)::int                              AS total_delivery_count,
           -- THE weighted price over the window. Never the mean of monthly averages.
           NULLIF(sum(a.php_total) / NULLIF(sum(a.priced_kg), 0), 0) AS wtd_php,
           -- PRICED-KG-WEIGHTED, the only honest way to average a premium (§E).
           sum(a.premium_php_kg * a.priced_kg) FILTER (WHERE a.premium_php_kg IS NOT NULL)
             / NULLIF(sum(a.priced_kg) FILTER (WHERE a.premium_php_kg IS NOT NULL), 0) AS avg_prem,
           -- Postgres' own Pearson correlation over the months that HAVE both a price and
           -- kilos. NULL below three, applied below — two points always correlate ±1.
           count(*) FILTER (WHERE a.avg_price_php_kg IS NOT NULL)::int AS priced_months,
           corr(a.avg_price_php_kg::double precision, a.kg::double precision) AS pv_corr
    FROM act a
    GROUP BY a.supplier_canonical
  ),
  sums AS (
    SELECT g.*, f.first_month, f.last_month, f.first_price, f.last_price, f.first_kg, f.last_kg,
           (f.last_price - f.first_price)                                   AS price_change,
           CASE WHEN f.first_price IS NOT NULL AND f.first_price <> 0
                THEN (f.last_price - f.first_price) * 100.0 / f.first_price END AS price_change_pct,
           CASE WHEN f.first_kg IS NOT NULL AND f.first_kg <> 0
                THEN (f.last_kg - f.first_kg) * 100.0 / f.first_kg END          AS kg_change_pct
    FROM agg g JOIN first_last f ON f.supplier_canonical = g.k
  )
  SELECT jsonb_build_object(
    'ok', true,
    'months_requested', v_n,
    'as_of', (SELECT a.today FROM anchor a),
    'from_month', (SELECT min(month_start) FROM spine),
    'to_month',   (SELECT max(month_start) FROM spine),
    -- The dead band the `direction` verdict was taken with, so a UI can label it and a
    -- test can pin it rather than re-guessing the threshold.
    'direction_dead_band_pct', v_dead,
    -- Echoed back after de-duplication, so a caller knows which keys its request became.
    -- NULL means "every supplier active in the window".
    'supplier_keys_requested', CASE WHEN v_keys IS NULL THEN NULL ELSE to_jsonb(v_keys) END,
    -- THE MONTH SPINE, ascending. The verify script proves it equals
    -- view_analytics_rcin_monthly's own last-N months, so the two spines are ONE.
    'months', COALESCE((SELECT jsonb_agg(sp.month_start ORDER BY sp.month_start) FROM spine sp), '[]'::jsonb),
    'suppliers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'key',     s.k,
               -- The analytics view publishes only the CANONICAL name, so display = key
               -- here. fn_blocking_supplier_lens has the prettier raw-spelling display;
               -- a UI showing both should take the label from there and join on the key.
               -- This function does not invent a name it does not have. See §I.
               'display', s.k,
               'series', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'month',              r.month_start,
                          'kg',                 r.kg,
                          'priced_kg',          r.priced_kg,
                          -- The view's own columns, verbatim. NULL, never 0.
                          'avg_price_php_kg',   r.avg_price_php_kg,
                          'premium_php_kg',     r.premium_php_kg,
                          'share_of_month_pct', r.share_of_month_pct,
                          'delivery_count',     r.delivery_count)
                        ORDER BY r.month_start)
                 FROM sel r WHERE r.supplier_canonical = s.k), '[]'::jsonb),
               'summary', jsonb_build_object(
                 -- Months with a REAL purchase (kg > 0). A sundry-only row is not activity.
                 'months_active',         s.months_active,
                 'total_kg',              s.total_kg,
                 'total_priced_kg',       s.total_priced_kg,
                 'delivery_count',        s.total_delivery_count,
                 'kg_weighted_php_kg',    s.wtd_php,
                 'first_month',           s.first_month,
                 'last_month',            s.last_month,
                 'first_price',           s.first_price,
                 'last_price',            s.last_price,
                 'price_change_php_kg',   s.price_change,
                 'price_change_pct',      s.price_change_pct,
                 'kg_change_pct',         s.kg_change_pct,
                 -- NULL below THREE active months: two points always correlate perfectly,
                 -- so a two-month corr of ±1 is arithmetic and not a finding.
                 'price_volume_corr',     CASE WHEN s.priced_months >= 3 THEN s.pv_corr END,
                 'corr_month_count',      s.priced_months,
                 -- NULL, never 'flat', when the change it reads is NULL. "Flat" is a claim.
                 'direction',             CASE
                                            WHEN s.price_change_pct IS NULL THEN NULL
                                            WHEN s.price_change_pct >  v_dead THEN 'up'
                                            WHEN s.price_change_pct < -v_dead THEN 'down'
                                            ELSE 'flat' END,
                 'avg_premium_php_kg',    s.avg_prem))
             -- Ordered by total_kg DESC, which is the order a "who matters" list wants;
             -- the key is unique, so the order is TOTAL and two calls cannot disagree.
             ORDER BY s.total_kg DESC, s.k ASC)
      FROM sums s), '[]'::jsonb),
    'supplier_count', (SELECT count(*)::int FROM sums),
    -- THE WHOLE WINDOW'S market figures — UNAFFECTED by p_supplier_keys — so a supplier row
    -- is comparable to THE MARKET and not merely to its neighbours in the selection, and
    -- without a second call. Summed from the SAME rows the series come from, so they cannot
    -- disagree; and `window_total.market_php_kg` equals
    -- fn_blocking_market_context(12).trailing_12m.market_php_kg at N = 12, which the verify
    -- script asserts as a cross-function agreement.
    'window_total', (SELECT jsonb_build_object(
        'market_kg',        COALESCE(sum(m.kg), 0),
        'market_priced_kg', COALESCE(sum(m.priced_kg), 0),
        'market_php_kg',    NULLIF(sum(m.php_total) / NULLIF(sum(m.priced_kg), 0), 0),
        'delivery_count',   COALESCE(sum(m.delivery_count), 0)::int)
      FROM mkt m),
    -- The SELECTED suppliers' own total. Equal to window_total when nothing was filtered,
    -- which the verify script asserts; a strict subset otherwise. Two names because a
    -- selection's share of the market is exactly the question a filtered call is asking.
    'selected_total', (SELECT jsonb_build_object(
        'market_kg',        COALESCE(sum(a.kg), 0),
        'market_priced_kg', COALESCE(sum(a.priced_kg), 0),
        'market_php_kg',    NULLIF(sum(a.php_total) / NULLIF(sum(a.priced_kg), 0), 0),
        'delivery_count',   COALESCE(sum(a.delivery_count), 0)::int)
      FROM act a)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_supplier_market(int, text[]) IS
'PRICE vs VOLUME, one series per supplier, for the Blocking SUPPLIER lens print''s context block — the supplier lens says whose charcoal is in the yard, and this says what each of them has been charging and how much they have been sending. Every figure is aggregated from view_analytics_supplier_monthly (analytics Phase 3), which OWNS supplier identity (canonical_supplier()), the per-supplier weighted price, share_of_month_pct and premium_php_kg, and which joins its month baseline FROM view_analytics_rcin_monthly — that is exactly what makes a share and a premium structurally incapable of disagreeing with the monthly matrix. MARKET deliveries only: a sundry re-entry and a re-cook fee are never supplier volume.
p_months is 1..36 (default 12), a window of calendar months ending with the current Asia/Manila one. p_supplier_keys NULL means EVERY supplier active in the window, ordered by total_kg DESC then key ASC (unique, so the order is TOTAL); a list is de-duplicated and blank-stripped before the 40-entry cap is measured. A KEY THAT MATCHES NOTHING RETURNS NO ENTRY, never a zero-filled row — inventing a row would put a supplier on a chart it is absent from; the caller compares what it asked for against what came back.
THE MONTH SPINE IS THE WINDOW''S, NOT THE SELECTION''S, and that was found by testing rather than reasoned: with the key filter applied to the source CTE, asking for a supplier that sold nothing returned an EMPTY months[] — a chart with no axis to draw the gap on. The filter therefore lives downstream and the spine is every month the window covers, which also costs nothing, since the filter never reduced the view scan but only the rows the CTE carried. For the same reason there are TWO totals: window_total is the WHOLE window''s market, unaffected by p_supplier_keys, so a supplier row is comparable to THE MARKET and not merely to its neighbours in the selection; selected_total is the selected suppliers'' own. They are equal when nothing was filtered (asserted), and window_total.market_php_kg equals fn_blocking_market_context(12).trailing_12m.market_php_kg at N = 12 — a cross-function agreement the verify script checks.
IDENTITY AGREES WITH THE SUPPLIER LENS, MEASURED NOT ASSUMED. The lens keys on view_blocking_block_suppliers.supplier_key (canonical_supplier(split_part(supplier, '' - '', 1))) and this keys on supplier_canonical (canonical_supplier(supplier)) — different expressions, so passing the lens''s band keys straight in is a claim that needs proving. Measured 2026-09-22: the strip is a NO-OP on the market population (0 of 1,683 market deliveries differ) and every one of the yard''s 17 supplier keys is a supplier this view knows (0 unknown, 27 canonical suppliers in all history). Both are asserted every verify run. ONE HONEST DIFFERENCE: the analytics view publishes only the CANONICAL name, so display equals key here; the lens has the prettier raw-spelling display ("Ornales" not "ORNALES"), so a UI showing both takes the label from the lens and joins on the key.
months_active counts months with a REAL purchase (kg > 0), and every first/last figure reads those months only. kg_weighted_php_kg is Sigma php_total / Sigma priced_kg, never the mean of monthly averages. avg_premium_php_kg is PRICED-KG-WEIGHTED and may only ever be — CLAUDE.md''s rule, and it is load-bearing: a month''s market price IS the priced-kg-weighted mean of its suppliers'' prices, so an unweighted average of the premium column is meaningless. price_volume_corr is Postgres'' own Pearson corr(avg_price, kg) over the active months that carry a price, POSITIVE meaning the bigger months came at the higher prices, and NULL below THREE such months because two points always correlate perfectly and a two-month correlation of plus or minus one is arithmetic, not a finding (read corr_month_count). direction reads price_change_pct with a +/-2% DEAD BAND, published as direction_dead_band_pct so a UI can label it and a test can pin it: month-to-month noise on a weighted purchase price is routinely a peso and calling every wobble a trend is how a chart starts lying.
NULL IS NEVER 0 anywhere: a price, a premium, a correlation, a change and a direction are each NULL rather than zero when the thing they describe does not exist — and direction is NULL rather than ''flat'', because flat is a claim. Kilograms and counts are real 0s, because they are weights. Every business refusal is jsonb {ok:false, reason, message} written for a human, never a raise: invalid_months, no_suppliers, too_many_suppliers.
COST: the analytics view is read EXACTLY ONCE (src AS MATERIALIZED) and the ~260 ms is that view''s own Seq Scan on deliveries with fn_delivery_class per row; the window filters already-grouped output, so narrowing it saves nothing and making it cheaper would mean re-deriving "market". Bounded by construction: 267 (supplier x month) rows inside the 36-month maximum against 281 for all of history.
IT IS MONEY ALMOST END TO END — avg_price, premium, the weighted price, both prices, both changes and price_volume_corr, which is DERIVED FROM price and is therefore price information however it is labelled. A nulled variant was considered and REJECTED: what would survive is a per-supplier kilogram series with its share and count, which view_digest_rcin_supplier_daily and fn_blocking_supplier_lens already publish to every role at grains that suit their own screens, and keeping a third half-blank copy is how a payload acquires a second meaning. So fetchBlockingSupplierMarket calls canViewPrices() FIRST and returns {ok:false, reason:''prices_hidden''} WITHOUT touching the database. The SQL is NOT the gate and must not become one. authenticated only; anon revoked; service_role deliberately not granted.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_market(int, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_market(int, text[]) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_supplier_market(int, text[]) TO authenticated;



-- ═════════════════════════════════════════════════════════════════════════════
-- §4  fn_blocking_market_context_probe — the ACCESS BRIDGE for the MARKET half
--
-- NOT a "verify everything" function. THIS PROBE ASSERTS NOTHING: it calls
-- fn_blocking_market_context a fixed number of times, reads
-- view_analytics_rcin_monthly INDEPENDENTLY so every reuse proof is an agreement
-- rather than a tautology, and hands everything back so every assertion lives in
-- `scripts/verify-blocking-price-lens.ts` where a human can read it.
--
-- It exists only because the function is `authenticated`-only BY DESIGN and no verify
-- script in this repo holds a user JWT — the same reason the four existing probes exist,
-- and the same SECURITY DEFINER + service_role-only shape.
--
-- **EVERY FORWARDED CALL IS ITS OWN STATEMENT (see §J).** A single
-- `jsonb_build_object` holding all of them timed out at 20 s, because fourteen references
-- to two expensive `security_invoker` views inside ONE expression are fourteen executions
-- the planner interleaves — the 2026-09-14 incident's shape arriving again. A plpgsql
-- assignment is planned and executed on its own, so each payload is assigned to a variable
-- first and the final object only reads variables. Measured after the split: 2.93 s.
--
-- BOUNDED BY CONSTRUCTION: 50 monthly rows and a fixed number of calls.
--
-- IT RETURNS ₱ — the prices ARE the numbers under test.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blocking_market_context_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_m0    date := date_trunc('month',   (now() AT TIME ZONE 'Asia/Manila')::date)::date;
  v_q0    date := date_trunc('quarter', (now() AT TIME ZONE 'Asia/Manila')::date)::date;
  v_y0    date := date_trunc('year',    (now() AT TIME ZONE 'Asia/Manila')::date)::date;
  v_bases jsonb;
  v_rows  jsonb;
  v_rq    jsonb;
  v_c12   jsonb;
  v_c1    jsonb;
  v_c36   jsonb;
BEGIN
  -- ONE STATEMENT PER EXPENSIVE CALL. See §J.
  SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.basis_key), '[]'::jsonb) INTO v_bases
  FROM public.fn_blocking_market_bases(30) b;

  -- The quarter figure read STRAIGHT from the analytics view, so `this_quarter` is proven
  -- to be that statistic rather than trusted to be.
  SELECT to_jsonb(x) INTO v_rq FROM (
    SELECT NULLIF(sum(v.market_php_total) / NULLIF(sum(v.market_priced_kg), 0), 0) AS php_kg,
           COALESCE(sum(v.market_priced_kg), 0)           AS priced_kg,
           COALESCE(sum(v.market_delivery_count), 0)::int AS delivery_count,
           count(*)::int                                  AS month_count
    FROM public.view_analytics_rcin_monthly v
    WHERE v.month_start >= v_q0 AND v.month_start <= v_m0) x;

  -- The view's OWN rows, so months[] is provably the view's rows and every quarter / YTD /
  -- trailing figure can be recomputed longhand. 50 rows today.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'month',            v.month_start,
           'market_php_kg',    NULLIF(v.market_avg_price, 0),
           'market_kg',        v.market_kg,
           'market_priced_kg', v.market_priced_kg,
           'market_php_total', v.market_php_total,
           'delivery_count',   v.market_delivery_count,
           'active_suppliers', v.active_suppliers)
         ORDER BY v.month_start), '[]'::jsonb) INTO v_rows
  FROM public.view_analytics_rcin_monthly v;

  v_c12 := public.fn_blocking_market_context(12);
  v_c1  := public.fn_blocking_market_context(1);
  v_c36 := public.fn_blocking_market_context(36);

  RETURN jsonb_build_object(
    'manila_today', v_today,
    'this_month',   v_m0,
    'this_quarter', v_q0,
    'this_year',    v_y0,

    'bases',             v_bases,
    'rcin_this_quarter', v_rq,
    'rcin_rows',         v_rows,

    'context_12', v_c12,
    'context_1',  v_c1,
    'context_36', v_c36,

    -- Refusals are cheap: each returns before touching a relation.
    'refusal_context_null', public.fn_blocking_market_context(NULL::int),
    'refusal_context_zero', public.fn_blocking_market_context(0),
    'refusal_context_big',  public.fn_blocking_market_context(37),

    'posture', jsonb_build_object(
      'bases_authenticated',   has_function_privilege('authenticated', 'public.fn_blocking_market_bases(int)', 'EXECUTE'),
      'bases_anon',            has_function_privilege('anon',          'public.fn_blocking_market_bases(int)', 'EXECUTE'),
      'bases_service_role',    has_function_privilege('service_role',  'public.fn_blocking_market_bases(int)', 'EXECUTE'),
      'context_authenticated', has_function_privilege('authenticated', 'public.fn_blocking_market_context(int)', 'EXECUTE'),
      'context_anon',          has_function_privilege('anon',          'public.fn_blocking_market_context(int)', 'EXECUTE'),
      'context_service_role',  has_function_privilege('service_role',  'public.fn_blocking_market_context(int)', 'EXECUTE'),
      'probe_authenticated',   has_function_privilege('authenticated', 'public.fn_blocking_market_context_probe()', 'EXECUTE'),
      'probe_anon',            has_function_privilege('anon',          'public.fn_blocking_market_context_probe()', 'EXECUTE'),
      'probe_service_role',    has_function_privilege('service_role',  'public.fn_blocking_market_context_probe()', 'EXECUTE'),
      'invoker_count',         (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                 WHERE n.nspname = 'public'
                                   AND p.proname IN ('fn_blocking_market_bases', 'fn_blocking_market_context')
                                   AND p.prosecdef = false),
      'stable_count',          (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                 WHERE n.nspname = 'public'
                                   AND p.proname IN ('fn_blocking_market_bases', 'fn_blocking_market_context', 'fn_blocking_market_context_probe')
                                   AND p.provolatile = 's'),
      'search_path_pinned',    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                 WHERE n.nspname = 'public'
                                   AND p.proname IN ('fn_blocking_market_bases', 'fn_blocking_market_context', 'fn_blocking_market_context_probe')
                                   AND p.proconfig @> ARRAY['search_path=public']),
      'commented_count',       (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                 WHERE n.nspname = 'public'
                                   AND p.proname IN ('fn_blocking_market_bases', 'fn_blocking_market_context')
                                   AND obj_description(p.oid, 'pg_proc') IS NOT NULL),
      -- An OVERLOAD would be a second home for the same logic. Exactly one each.
      'bases_overloads',       (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                 WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_market_bases'),
      'context_overloads',     (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                 WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_market_context')
    )
  );
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_market_context_probe() IS
'Read-only ACCESS BRIDGE so scripts/verify-blocking-price-lens.ts can exercise the authenticated-only fn_blocking_market_context (and the new this_quarter basis of fn_blocking_market_bases) with the service-role key it holds. It ASSERTS NOTHING — it calls them a fixed number of times, reads view_analytics_rcin_monthly INDEPENDENTLY so the reuse proof is an agreement rather than a tautology, and hands everything back so every assertion lives in the script where a human can read it. EVERY FORWARDED CALL IS ITS OWN STATEMENT, assigned to a variable before the final jsonb is built: the first version assembled all of them inside ONE jsonb_build_object and TIMED OUT AT 20 s, because fourteen references to two expensive security_invoker views in one expression are fourteen interleaved executions — the 2026-09-14 fn_ops_ledger_verify shape arriving a second time. Measured after the split: 2.93 s (and the supplier half 2.77 s). Bounded by construction: 50 monthly rows and a fixed number of calls. It DOES return PHP, because the prices are the numbers under test. SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_market_context_probe() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_market_context_probe() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_market_context_probe() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_market_context_probe() TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- §5  fn_blocking_supplier_market_probe — the ACCESS BRIDGE for the SUPPLIER half
--
-- Same contract, same shape, same reason it is SEPARATE (see §J): the supplier half reads
-- the more expensive of the two analytics views, so putting it in the same function as the
-- market half is what blew the 20 s timeout.
--
-- What each independent read is FOR:
--   supplier_rows  view_analytics_supplier_monthly's OWN rows inside the 36-month maximum,
--                  so every series row and every summary figure can be recomputed longhand.
--   corr_check     Postgres' `corr()` recomputed INDEPENDENTLY per supplier, returned as
--                  the GAP against the published figure plus two is-null flags that make a
--                  NULL gap decidable instead of ambiguous. `corr` is double precision, so
--                  the script BOUNDS the gap rather than demanding a literal zero.
--   identity       THE identity agreement (§I), measured over DISTINCT supplier strings
--                  rather than per row — cheaper AND a stronger statement, because it shows
--                  the 16 differing strings EXIST rather than only that they are absent
--                  from the market population.
--
-- BOUNDED BY CONSTRUCTION: 267 (supplier × month) rows at the 36-month maximum, 68 distinct
-- supplier strings, 17 yard keys, and a fixed number of calls. Measured: 2.77 s.
--
-- IT RETURNS ₱ — the prices ARE the numbers under test.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blocking_supplier_market_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_m0      date := date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date)::date;
  v_top     text[];
  v_rows    jsonb;
  v_s12     jsonb;
  v_s36     jsonb;
  v_stop3   jsonb;
  v_sunk    jsonb;
  v_corr    jsonb;
  v_ident   jsonb;
BEGIN
  -- ONE STATEMENT PER EXPENSIVE CALL. See §J.

  -- The three biggest suppliers of the last 12 months, so the key-filtered call is
  -- exercised on REAL keys rather than a fixture.
  SELECT array_agg(k ORDER BY kg DESC) INTO v_top FROM (
    SELECT s.supplier_canonical AS k, sum(s.kg) AS kg
    FROM public.view_analytics_supplier_monthly s
    WHERE s.month_start > (v_m0 - interval '12 months')::date
      AND s.month_start <= v_m0
      AND s.kg > 0
    GROUP BY s.supplier_canonical
    ORDER BY sum(s.kg) DESC
    LIMIT 3) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'month',              s.month_start,
           'key',                s.supplier_canonical,
           'kg',                 s.kg,
           'priced_kg',          s.priced_kg,
           'avg_price_php_kg',   s.avg_price_php_kg,
           'php_total',          s.php_total,
           'premium_php_kg',     s.premium_php_kg,
           'share_of_month_pct', s.share_of_month_pct,
           'delivery_count',     s.delivery_count)
         ORDER BY s.month_start, s.supplier_canonical), '[]'::jsonb) INTO v_rows
  FROM public.view_analytics_supplier_monthly s
  WHERE s.month_start > (v_m0 - interval '36 months')::date
    AND s.month_start <= v_m0;

  v_s12   := public.fn_blocking_supplier_market(12);
  v_s36   := public.fn_blocking_supplier_market(36);
  v_stop3 := public.fn_blocking_supplier_market(12, v_top);
  -- A key that matches nothing: ok:true, no supplier entry, and the SPINE still intact.
  v_sunk  := public.fn_blocking_supplier_market(12, ARRAY['NO SUCH SUPPLIER EVER']);

  -- THE INDEPENDENT `corr`, compared against the ALREADY-COMPUTED v_s12 rather than a
  -- second call to the function (which would be a second 290 ms execution for nothing).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'key',                 i.k,
           'independent_corr',    i.c,
           'independent_is_null', (i.c IS NULL),
           'independent_months',  i.n,
           'published_corr',      p.c,
           'published_is_null',   (p.c IS NULL),
           'gap',                 (p.c - i.c))
         ORDER BY i.k), '[]'::jsonb) INTO v_corr
  FROM (
    SELECT s.supplier_canonical AS k,
           CASE WHEN count(*) FILTER (WHERE s.avg_price_php_kg IS NOT NULL) >= 3
                THEN corr(s.avg_price_php_kg::double precision, s.kg::double precision) END AS c,
           count(*) FILTER (WHERE s.avg_price_php_kg IS NOT NULL)::int AS n
    FROM public.view_analytics_supplier_monthly s
    WHERE s.month_start > (v_m0 - interval '12 months')::date
      AND s.month_start <= v_m0 AND s.kg > 0
    GROUP BY s.supplier_canonical) i
  LEFT JOIN (
    SELECT e->>'key' AS k, (e->'summary'->>'price_volume_corr')::double precision AS c
    FROM jsonb_array_elements(v_s12->'suppliers') e) p ON p.k = i.k;

  -- THE IDENTITY AGREEMENT (§I), over DISTINCT supplier strings: cheaper than per row
  -- (87 ms against 150) AND a stronger statement, because it shows the differing strings
  -- EXIST rather than only that they are absent from the market population.
  WITH dsup AS (SELECT DISTINCT d.supplier FROM public.deliveries d),
  diff AS (
    SELECT s.supplier FROM dsup s
    WHERE public.canonical_supplier(s.supplier)
          IS DISTINCT FROM public.canonical_supplier(split_part(s.supplier, ' - ', 1))
  )
  SELECT jsonb_build_object(
    'distinct_supplier_strings', (SELECT count(*)::int FROM dsup),
    -- NOT expected to be 0: the sundry re-entries carrying a `- <BATCH>` suffix are exactly
    -- what the strip exists for. The script asserts this is > 0, so a strip that silently
    -- became a no-op would FAIL rather than pass vacuously.
    'differing_supplier_strings', (SELECT count(*)::int FROM diff),
    -- THIS is the claim the frontend depends on, and it must be 0. No class call happens at
    -- all while `diff` and the market population stay disjoint.
    'market_rows_in_differing_set', (
      SELECT count(*)::int FROM public.deliveries d JOIN diff ON diff.supplier = d.supplier
       WHERE public.fn_delivery_class(d.batch_code, d.supplier, d.remarks) = 'market'),
    'yard_keys', COALESCE((
      SELECT jsonb_agg(DISTINCT v.supplier_key)
      FROM public.view_blocking_block_suppliers v
      JOIN public.view_blocking_grid g ON g.block_loc = v.block_loc AND g.batch_id = v.batch_id
      WHERE g.balance > 0), '[]'::jsonb),
    'yard_keys_unknown_to_analytics', (
      SELECT count(*)::int FROM (
        SELECT DISTINCT v.supplier_key AS k
        FROM public.view_blocking_block_suppliers v
        JOIN public.view_blocking_grid g ON g.block_loc = v.block_loc AND g.batch_id = v.batch_id
        WHERE g.balance > 0) y
      WHERE NOT EXISTS (SELECT 1 FROM public.view_analytics_supplier_monthly s
                         WHERE s.supplier_canonical = y.k))
  ) INTO v_ident;

  RETURN jsonb_build_object(
    'manila_today', v_today,
    'this_month',   v_m0,
    'top3_keys',    COALESCE(to_jsonb(v_top), 'null'::jsonb),

    'supplier_rows',    v_rows,
    'supplier_12',      v_s12,
    'supplier_36',      v_s36,
    'supplier_top3',    v_stop3,
    'supplier_unknown', v_sunk,

    -- Refusals are cheap: each returns before touching a relation.
    'refusal_supplier_null_months', public.fn_blocking_supplier_market(NULL::int),
    'refusal_supplier_zero_months', public.fn_blocking_supplier_market(0),
    'refusal_supplier_big_months',  public.fn_blocking_supplier_market(37),
    'refusal_supplier_empty_keys',  public.fn_blocking_supplier_market(12, ARRAY[]::text[]),
    'refusal_supplier_blank_keys',  public.fn_blocking_supplier_market(12, ARRAY[NULL, '  ']::text[]),
    'refusal_supplier_too_many',    public.fn_blocking_supplier_market(
                                      12, (SELECT array_agg('S' || g) FROM generate_series(1, 41) g)),

    'corr_check', v_corr,
    'identity',   v_ident,

    'posture', jsonb_build_object(
      'supmkt_authenticated', has_function_privilege('authenticated', 'public.fn_blocking_supplier_market(int, text[])', 'EXECUTE'),
      'supmkt_anon',          has_function_privilege('anon',          'public.fn_blocking_supplier_market(int, text[])', 'EXECUTE'),
      'supmkt_service_role',  has_function_privilege('service_role',  'public.fn_blocking_supplier_market(int, text[])', 'EXECUTE'),
      'probe_authenticated',  has_function_privilege('authenticated', 'public.fn_blocking_supplier_market_probe()', 'EXECUTE'),
      'probe_anon',           has_function_privilege('anon',          'public.fn_blocking_supplier_market_probe()', 'EXECUTE'),
      'probe_service_role',   has_function_privilege('service_role',  'public.fn_blocking_supplier_market_probe()', 'EXECUTE'),
      'invoker_count',        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_supplier_market'
                                  AND p.prosecdef = false),
      'stable_count',         (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                WHERE n.nspname = 'public'
                                  AND p.proname IN ('fn_blocking_supplier_market', 'fn_blocking_supplier_market_probe')
                                  AND p.provolatile = 's'),
      'search_path_pinned',   (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                WHERE n.nspname = 'public'
                                  AND p.proname IN ('fn_blocking_supplier_market', 'fn_blocking_supplier_market_probe')
                                  AND p.proconfig @> ARRAY['search_path=public']),
      'commented',            (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_supplier_market'
                                  AND obj_description(p.oid, 'pg_proc') IS NOT NULL),
      -- An OVERLOAD would be a second home for the same logic. Exactly one.
      'supmkt_overloads',     (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_supplier_market'),
      -- The view this function reads its identity from must stay authenticated-only and
      -- security_invoker; CREATE OR REPLACE VIEW RESETS reloptions, so this is the live
      -- guard (the trap that bit view_ops_ledger_campaign_kpis twice).
      'view_authenticated',    has_table_privilege('authenticated', 'public.view_analytics_supplier_monthly', 'SELECT'),
      'view_anon',             has_table_privilege('anon',          'public.view_analytics_supplier_monthly', 'SELECT'),
      'view_service_role',     has_table_privilege('service_role',  'public.view_analytics_supplier_monthly', 'SELECT'),
      'view_security_invoker', (SELECT count(*)::int FROM pg_class c
                                  JOIN pg_namespace n ON n.oid = c.relnamespace
                                 WHERE n.nspname = 'public'
                                   AND c.relname = 'view_analytics_supplier_monthly'
                                   AND c.reloptions @> ARRAY['security_invoker=true'])
    )
  );
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_supplier_market_probe() IS
'Read-only ACCESS BRIDGE so scripts/verify-blocking-supplier-lens.ts can exercise the authenticated-only fn_blocking_supplier_market with the service-role key it holds. It ASSERTS NOTHING — it calls the function a fixed number of times (including a key-filtered call on the three REAL biggest suppliers and a key that matches nothing), reads view_analytics_supplier_monthly INDEPENDENTLY so every series row and summary figure can be recomputed longhand, recomputes Postgres corr() per supplier and returns the GAP against the published figure with two is-null flags so a NULL gap is decidable, and measures the IDENTITY AGREEMENT with the supplier lens over DISTINCT supplier strings — cheaper than per row AND a stronger statement, because it shows the 16 differing strings EXIST (the sundry "- BATCH" suffixes) rather than only that they are absent from the market population, which is the separate figure that must be 0. It is a SEPARATE function from fn_blocking_market_context_probe on purpose: one probe holding both halves TIMED OUT AT 20 s, because many references to two expensive security_invoker views in one expression are many interleaved executions — the 2026-09-14 fn_ops_ledger_verify shape again — so every forwarded call here is assigned to a variable, i.e. its own statement. Measured after the split: 2.77 s (and the market half 2.93 s). Bounded by construction: 267 (supplier x month) rows at the 36-month maximum, 68 distinct supplier strings, 17 yard keys. It DOES return PHP, because the prices are the numbers under test. SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_market_probe() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_market_probe() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_market_probe() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_supplier_market_probe() TO service_role;
