-- ─────────────────────────────────────────────────────────────────────────────
-- THE AGE LENS on the Blocking grid — "show me the charcoal that has been sitting"
--
-- The SECOND lens on the frame the price lens built (migration 20260919025729), and
-- deliberately its sibling in every shape: one function, jsonb out, integer cut lines
-- de-duplicated and sorted, k edges -> k+1 half-open bands, every band returned even
-- when empty, a jsonb {ok:false, reason, message} written for a human instead of a
-- raise, and the same MATERIALIZED-CTE discipline. Owner-approved default cuts:
-- 60 / 120 / 365 DAYS -> four bands.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- AGE ALREADY HAS A DEFINITION, AND THIS MIGRATION DOES NOT ADD A SECOND ONE
-- ═════════════════════════════════════════════════════════════════════════════
-- A batch's age is the kg-WEIGHTED MEAN DELIVERY DATE carried by whatever balance is
-- still in the pile:
--
--   age_days = as_of - SUM(weight_kg * delivery_date) / SUM(weight_kg)
--
-- That is what `view_analytics_aging_watchlist.age_days` (the live "go and look at
-- these" list) and `view_analytics_aging_eom.age_days` (the month-end profile) already
-- publish, and THERE IS NO FIFO AND NONE IS POSSIBLE — `rc_out` records which BATCH
-- kilos left, never which delivery within it, so a FIFO answer would be fiction
-- dressed as precision. Deliveries into one batch cluster within days, so the error is
-- small against ages in the hundreds of days.
--
-- §1 lifts that expression into ONE relation, `view_batch_age_days`, which this lens
-- reads. WHY A VIEW AND NOT "SELECT age FROM the watchlist":
--
--   The watchlist's population is `status <> 'CLOSED' AND current_weight > 1000` —
--   open piles OVER A TONNE, because it is a list of piles worth walking out to. The
--   grid's population is every occupied block with a POSITIVE balance. Today those
--   coincide exactly (measured 2026-09-19: all 168 grid blocks are watchlist rows, 0
--   outside, min grid balance 8,557 kg) — but they coincide BY LUCK, not by rule. A
--   block is fed down day by day, and a nearly-empty block legitimately drops under a
--   tonne while still occupying its slot. Reading age FROM the watchlist would then
--   silently report that block as UNDATED — i.e. "this pile has no deliveries", which
--   is a lie about a pile that plainly has them, and the kind of quiet wrong this
--   codebase refuses. The tonne floor is a statement about what is worth LISTING, not
--   about what has an AGE.
--
-- WHAT WAS DELIBERATELY NOT DONE: `view_analytics_aging_watchlist` is NOT re-pointed
-- at the new view. It is a ₱-bearing view the /analytics page reads live; a
-- CREATE OR REPLACE on it RESETS `reloptions` (so `security_invoker` would have to be
-- re-asserted — the trap that bit view_ops_ledger_campaign_kpis TWICE), and its own
-- `del` CTE computes six other columns in the same grouped scan that a per-row join
-- would not improve. So the expression exists in two places and DRIFT IS PROVEN
-- IMPOSSIBLE INSTEAD OF ASSUMED: scripts/verify-blocking-age-lens.ts requires
-- `view_batch_age_days.age_days` to equal `view_analytics_aging_watchlist.age_days` on
-- EVERY batch both cover, gap exactly 0 at the view's own precision (measured
-- 2026-09-19: 170 batches, 0 mismatches, max gap 0.0000000000000000). If someone edits
-- one copy, that assertion fails and names the other.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE UNDATED RULE — NULL IS NEVER 0 DAYS, the price lens's unpriced rule again
-- ═════════════════════════════════════════════════════════════════════════════
-- A block whose batch has NO delivery rows (pre-system stock; the L-042 phantom
-- batches) has no mean delivery date, so it has NO AGE. It goes in `undated`, in NO
-- band, and is EXCLUDED from both share denominators and from every weighted age.
-- Calling it 0 days old would paint the FRESHEST possible colour on a pile whose age
-- is simply unknown — the exact shape of the ₱11.01-vs-₱39.99 `avg_cost` bug, and of
-- the price lens's `unpriced` bucket. Consequently
-- `SUM(bands[].block_count) + undated.block_count = total.block_count`, the same for
-- kg, while the two share families are over the DATED population and each sums to 100.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- BANDS: CUT LINES IN DAYS, AND WHY BAND 0 STARTS AT 0 BUT STILL CATCHES A NEGATIVE
-- ═════════════════════════════════════════════════════════════════════════════
-- `p_edge_days` is a list of POSITIVE whole numbers of days, de-duplicated and sorted.
-- k edges give k+1 half-open `[lower, upper)` bands; `lower_days` is 0 on the first
-- band and `upper_days` is null on the last (null means OPEN ABOVE, never zero days):
--
--   default [60, 120, 365] -> 4 bands
--     band 0  [0, 60)      up to 60 days
--     band 1  [60, 120)
--     band 2  [120, 365)
--     band 3  [365, +inf)  over a year
--
-- MEMBERSHIP IS "HOW MANY CUT LINES HAS THIS AGE PASSED" (`count(*) WHERE age >= e`),
-- NOT a lower-bound lookup. That is what makes the answer TOTAL: a NEGATIVE age — real
-- and reachable, since a future-dated delivery is never filtered out of the
-- deliveries-side windows (the digest-view idiom) — has passed no cut line and lands
-- in band 0, rather than matching no band and vanishing out of the folds. Band 0's
-- published `lower_days = 0` is therefore a LABEL for the reader, not the test.
--
-- ROUNDING, stated because it has a visible edge case: per-block `age_days` in the
-- payload is rounded to 1 decimal (it is a figure a cell shows), while the BAND is
-- decided on the exact fractional age. So a block at 59.97 days publishes
-- `age_days: 60.0` inside band 0 — correct, and not an off-by-one. Band and total
-- `kg_weighted_age_days` are published at FULL precision so a verify script can prove
-- them against its own arithmetic exactly rather than within a tolerance.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- NO ₱ ANYWHERE, AND THEREFORE NO PRICE GATE — the opposite of the price lens
-- ═════════════════════════════════════════════════════════════════════════════
-- The price lens carries money even where it looks like it does not (band membership
-- pins a block's ₱/kg to within a peso), so its server actions REFUSE a
-- `!canViewPrices()` caller before touching the database. Nothing of the sort applies
-- here: this payload is dates, kilograms, counts and percentages, no cost/price/value
-- column exists on `view_batch_age_days` or anywhere in the jsonb, and none is
-- derivable — so the Age lens is safe for EVERY role INCLUDING Production, exactly as
-- `view_blocking_block_suppliers` and the whole analytics production matrix are.
-- `fetchBlockingAgeLens` deliberately has no `canViewPrices()` call and
-- scripts/verify-blocking-age-lens.ts asserts its ABSENCE, so nobody "fixes" the
-- asymmetry by copying the price lens's gate across. Grants match the sibling anyway:
-- `authenticated` only (every signed-in user), `anon` revoked, and NOT `service_role`
-- (no sync worker reads any of this, so verify-worker-view-grants stays at 4 views /
-- 0 findings).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- COST, MEASURED BEFORE ANY PROOF WAS WRITTEN (the 2026-09-14 rule)
-- ═════════════════════════════════════════════════════════════════════════════
-- `set local statement_timeout='5s'` then EXPLAIN (ANALYZE, BUFFERS), 2026-09-19:
--   the per-batch age fold alone (659 batch codes)              2.57 ms /   76 buffers
--   view_blocking_grid alone (balance > 0, 168 rows)            2.85 ms /  451 buffers
--   the whole lens query as written below                        8.05 ms /  530 buffers
--   SELECT fn_blocking_age_lens()  (warm, whole function)       14.3 ms / 2,095 buffers
-- 530 = 451 (ONE grid scan) + 76 (ONE age fold) + 3, so `src` is built exactly once
-- although five downstream CTEs read it, and `classified` once although two do. The
-- function's larger buffer count is plpgsql PLANNING across its eight statements (the
-- core query's planning alone measured 433-520 buffers); execution is the 530.
--
-- HONEST NOTE ON THE `MATERIALIZED` HINTS, because the measurement did not say what
-- was expected: removing them changes NOTHING here — 530 buffers / 8.1 ms either way.
-- Postgres 12+ already materializes a CTE that is referenced more than once, and `src`
-- is referenced three times and `classified` four. So unlike the price lens (85.4 ms /
-- 1,939 buffers before its hints, 4.8 ms / 454 after) these are EXPLICIT INSURANCE,
-- not a measured win: they exist so that a future edit which happens to leave a SINGLE
-- reference to one of these expensive subtrees cannot silently re-inline it. Keep
-- them, and do not claim they bought the current number.
--
-- Both populations are bounded BY CONSTRUCTION — one row per occupied block (168
-- today, 238 slots maximum) and one row per batch code that has ever had a delivery
-- (659) — so neither can grow into a whole-history scan.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- §1  view_batch_age_days — THE definition of a batch's age, in one place
-- ═════════════════════════════════════════════════════════════════════════════
-- One row per `batch_code` that has at least one dated delivery. A batch absent from
-- this view has no age at all; that absence is the UNDATED answer and must never be
-- read as 0.
--
-- The expression is lifted ARM FOR ARM from `view_analytics_aging_watchlist`'s `del`
-- CTE, including the '2000-01-01' day-number epoch, the `NULLIF(sum(weight_kg), 0)`
-- denominator and the Asia/Manila `as_of_date` — so the two are numerically identical
-- rather than merely similar, and the verify script requires exactly that.
--
--   age_days            THE age. NULL (never 0) when the batch's dated deliveries
--                       weigh nothing at all, which the NULLIF produces rather than
--                       dividing by zero. Can legitimately be NEGATIVE.
--   mean_daynum         the raw day-number, kept so the arithmetic can be checked
--                       without redoing it.
--   mean_delivery_date  a readable form of the same instant, ROUNDED to a whole day.
--                       It is a LABEL: `age_days` keeps the fractional value and is
--                       what bands are decided on.
CREATE OR REPLACE VIEW public.view_batch_age_days AS
WITH del AS (
  SELECT d.batch_code,
         sum(d.weight_kg * (d.transaction_date - '2000-01-01'::date)::numeric)
           / NULLIF(sum(d.weight_kg), 0::numeric)  AS mean_daynum,
         sum(d.weight_kg)                          AS delivered_kg,
         count(*)::int                             AS delivery_count,
         min(d.transaction_date)                   AS first_delivery_date,
         max(d.transaction_date)                   AS last_delivery_date
  FROM public.deliveries d
  WHERE d.transaction_date IS NOT NULL
    AND d.batch_code IS NOT NULL
  GROUP BY d.batch_code
)
SELECT del.batch_code,
       (now() AT TIME ZONE 'Asia/Manila')::date                                   AS as_of_date,
       ((now() AT TIME ZONE 'Asia/Manila')::date - '2000-01-01'::date)::numeric
         - del.mean_daynum                                                        AS age_days,
       del.mean_daynum,
       ('2000-01-01'::date + round(del.mean_daynum)::int)                          AS mean_delivery_date,
       del.delivered_kg,
       del.delivery_count,
       del.first_delivery_date,
       del.last_delivery_date
FROM del;

ALTER VIEW public.view_batch_age_days SET (security_invoker = true);

COMMENT ON VIEW public.view_batch_age_days IS
'THE definition of how old a batch of charcoal is: one row per batch_code with at least one dated delivery, carrying age_days = today (Asia/Manila) minus the kg-WEIGHTED MEAN DELIVERY DATE of that batch. This is the same statistic view_analytics_aging_watchlist and view_analytics_aging_eom publish, lifted arm for arm into one relation so the Blocking page''s AGE LENS reads it instead of growing a second definition; scripts/verify-blocking-age-lens.ts proves it equals the watchlist''s age_days on every batch both cover, gap exactly 0. THERE IS NO FIFO AND NONE IS POSSIBLE — rc_out records which BATCH kilos left, never which delivery within it, so a FIFO age would be fiction dressed as precision; deliveries into one batch cluster within days, so the error is small against ages in the hundreds of days. A batch with no dated delivery is ABSENT from this view and has NO age: that absence means UNDATED and must never be read as 0 days old. age_days can legitimately be NEGATIVE if a delivery is dated in the future. mean_delivery_date is a readable label rounded to a whole day; age_days keeps the fractional value. NO MONEY COLUMN and none derivable, so every read is safe for every role including Production. security_invoker; authenticated SELECT only; anon revoked; service_role deliberately not granted (no sync worker reads it).';

REVOKE ALL     ON public.view_batch_age_days FROM PUBLIC;
REVOKE ALL     ON public.view_batch_age_days FROM anon;
GRANT  SELECT  ON public.view_batch_age_days TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §2  fn_blocking_age_lens — classify the yard by how long it has been sitting
-- ═════════════════════════════════════════════════════════════════════════════
-- Reading notes for the body below (kept OUT of the body so what is stored in
-- `prosrc` is exactly what this file says):
--
--   cut / k / bands   k cut lines -> k+1 bands. Band i is [E_i, E_{i+1}); the missing
--                     lookup at the top end is what makes the last band open above,
--                     and band 0's lower bound is the literal day 0 rather than a
--                     NULL, because age has a floor and money did not.
--   src               one row per OCCUPIED block with charcoal still in it, carrying
--                     its batch's age. `balance` comes from the very view the Blocking
--                     cell renders; the age from §1, the ONE definition. A negative
--                     balance is misattribution (CLAUDE.md: 77 batches carry -3.22M
--                     kg) and has no age story, so this population is EXACTLY
--                     fn_blocking_price_lens's.
--   classified        HOW MANY CUT LINES HAS THIS AGE PASSED — total by construction,
--                     so a negative age lands in band 0 instead of matching nothing.
--   band_rows.wtd_age NULL, never 0, on an empty band: no charcoal there means no age
--                     there.
--   shares            over the DATED population, NULL (never 0/0) when nothing in the
--                     yard has an age at all.
--   total.kg          counts undated blocks too (the folds must add up to the yard),
--                     while total.kg_weighted_age_days is weighted over DATED kilos
--                     only.
--   oldest            deterministic on a tie: the earlier block_loc wins, so two
--                     equally old piles cannot make consecutive calls disagree.
CREATE OR REPLACE FUNCTION public.fn_blocking_age_lens(
  p_edge_days int[] DEFAULT ARRAY[60, 120, 365]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_edges  int[];
  v_as_of  date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_result jsonb;
BEGIN
  v_edges := COALESCE(p_edge_days, ARRAY[60, 120, 365]);

  -- A NULL cut line cannot be placed on the scale, so it is REFUSED rather than dropped.
  -- A fractional edge is NOT detectable here (int[] rounded it already) and is enforced
  -- in the server action under this same `invalid_edge` reason.
  IF EXISTS (SELECT 1 FROM unnest(v_edges) AS e WHERE e IS NULL) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_edge',
      'message', 'Every cut line has to be a whole number of days.');
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(v_edges) AS e WHERE e <= 0) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_edge',
      'message', 'A cut line has to be at least 1 day — the first band already starts at day 0.');
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(v_edges) AS e WHERE e > 5000) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_edge',
      'message', 'A cut line above 5,000 days is further back than any charcoal in the yard — check the number.');
  END IF;

  -- De-duplicate and order. The bands are DEFINED by the resulting list, which is why
  -- the cap is measured AFTER the collapse and why the list is returned.
  SELECT array_agg(DISTINCT e ORDER BY e) INTO v_edges FROM unnest(v_edges) AS e;

  IF v_edges IS NULL OR cardinality(v_edges) = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'no_edges',
      'message', 'An age lens needs at least one cut line — with none, every block is in the same band and nothing is highlighted.');
  END IF;

  IF cardinality(v_edges) > 6 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'too_many_edges',
      'message', format('An age lens takes at most 6 cut lines; this one has %s.', cardinality(v_edges)));
  END IF;

  WITH cut AS (
    SELECT e, row_number() OVER (ORDER BY e)::int AS i
    FROM unnest(v_edges) AS e
  ),
  k AS (SELECT count(*)::int AS n FROM cut),
  bands AS MATERIALIZED (
    SELECT gs.i                                                      AS band_index,
           CASE WHEN gs.i = 0 THEN 0
                ELSE (SELECT cut.e FROM cut WHERE cut.i = gs.i) END  AS lower_days,
           (SELECT cut.e FROM cut WHERE cut.i = gs.i + 1)            AS upper_days
    FROM k, generate_series(0, k.n) AS gs(i)
  ),
  src AS MATERIALIZED (
    SELECT g.block_loc,
           g.balance::numeric AS kg,
           a.age_days
    FROM public.view_blocking_grid g
    LEFT JOIN public.view_batch_age_days a ON a.batch_code = g.batch_code
    WHERE g.balance > 0
  ),
  classified AS MATERIALIZED (
    SELECT s.block_loc,
           s.kg,
           s.age_days,
           (SELECT count(*)::int FROM cut WHERE s.age_days >= cut.e) AS band_index
    FROM src s
    WHERE s.age_days IS NOT NULL
  ),
  tot   AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg FROM src),
  und   AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg
              FROM src WHERE age_days IS NULL),
  dated AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg,
                   sum(kg * age_days) / NULLIF(sum(kg), 0) AS wtd_age,
                   max(age_days)                          AS oldest_age
              FROM classified),
  oldest AS (
    SELECT c.block_loc, c.age_days
    FROM classified c
    ORDER BY c.age_days DESC, c.block_loc ASC
    LIMIT 1
  ),
  band_rows AS (
    SELECT bd.band_index, bd.lower_days, bd.upper_days,
           count(c.block_loc)::int                            AS block_count,
           COALESCE(sum(c.kg), 0)                             AS kg,
           sum(c.kg * c.age_days) / NULLIF(sum(c.kg), 0)       AS wtd_age
    FROM bands bd
    LEFT JOIN classified c ON c.band_index = bd.band_index
    GROUP BY bd.band_index, bd.lower_days, bd.upper_days
  )
  SELECT jsonb_build_object(
    'ok', true,
    'as_of', v_as_of,
    'edge_days', to_jsonb(v_edges),
    'bands', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'index',                br.band_index,
               'lower_days',           br.lower_days,
               'upper_days',           br.upper_days,
               'block_count',          br.block_count,
               'kg',                   br.kg,
               'kg_share_pct',         CASE WHEN d.kg > 0 THEN br.kg * 100.0 / d.kg END,
               'block_share_pct',      CASE WHEN d.block_count > 0
                                            THEN br.block_count * 100.0 / d.block_count END,
               'kg_weighted_age_days', br.wtd_age)
             ORDER BY br.band_index)
      FROM band_rows br, dated d), '[]'::jsonb),
    'blocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'block_loc',  c.block_loc,
               'band_index', c.band_index,
               'age_days',   round(c.age_days, 1))
             ORDER BY c.block_loc)
      FROM classified c), '[]'::jsonb),
    'undated', (SELECT jsonb_build_object('block_count', u.block_count, 'kg', u.kg) FROM und u),
    'total', (SELECT jsonb_build_object(
                'block_count',          t.block_count,
                'kg',                   t.kg,
                'kg_weighted_age_days', d.wtd_age,
                'oldest_age_days',      round(d.oldest_age, 1),
                'oldest_block_loc',     (SELECT o.block_loc FROM oldest o))
              FROM tot t, dated d)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_age_lens(int[]) IS
'Classify every occupied Blocking block by HOW OLD its charcoal is, for the Blocking page AGE LENS — the sibling of fn_blocking_price_lens. Age is NOT redefined here: it is read from view_batch_age_days, which carries the kg-weighted-mean-delivery-date definition view_analytics_aging_watchlist and view_analytics_aging_eom already publish (there is no FIFO and none is possible). p_edge_days is a list of POSITIVE whole numbers of DAYS, de-duplicated and sorted; k cut lines give k+1 half-open [lower, upper) bands with lower_days 0 on the first and upper_days NULL (= OPEN ABOVE, never 0 days) on the last; the default ARRAY[60,120,365] gives up to 60 days / 60-120 / 120-365 / over a year. MEMBERSHIP IS "how many cut lines has this age passed", which is total by construction, so a NEGATIVE age from a future-dated delivery lands in band 0 rather than in no band; band 0''s published lower_days = 0 is a label, not the test. A block whose batch has NO dated delivery has NO age: it lands in "undated", in no band, excluded from both share denominators and from every weighted age — NULL is never 0 days old, the same rule as the price lens''s unpriced bucket. Therefore sum of band block_count plus undated equals total, likewise kg, and each share family sums to 100 over the dated population. Per-block age_days is rounded to 1 decimal for display while the band is decided on the exact value; band and total kg_weighted_age_days are full precision. Every business refusal is jsonb {ok:false, reason, message} written for a human, never a raise: invalid_edge (a NULL, a non-positive, or one above 5000 days), no_edges, too_many_edges. CARRIES NO MONEY AND NONE IS DERIVABLE — no cost/price/value column exists in the payload — so this lens is safe for EVERY role including Production and is deliberately NOT canViewPrices()-gated, unlike its price sibling. authenticated only; anon revoked; service_role deliberately not granted.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §3  Posture
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.fn_blocking_age_lens(int[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_age_lens(int[]) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_age_lens(int[]) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §4  fn_blocking_age_lens_probe — the ACCESS BRIDGE for the verify script
--
-- NOT a "verify everything" function, and the distinction is the 2026-09-14 incident:
-- `fn_ops_ledger_verify()` cross-checked every ops-ledger view over the whole of
-- history in one statement, OOM-ed the instance and took the live site down. This
-- probe ASSERTS NOTHING. It calls fn_blocking_age_lens a fixed number of times, reads
-- three bounded relations INDEPENDENTLY of it, and hands everything back so every
-- assertion lives in scripts/verify-blocking-age-lens.ts where a human can read it.
--
-- It exists only because fn_blocking_age_lens is `authenticated`-only BY DESIGN and no
-- verify script in this repo holds a user JWT — the same reason
-- fn_blocking_price_lens_probe and the ops-ledger probes exist, and the same SECURITY
-- DEFINER + service_role-only shape. The PRICE probe is deliberately left untouched.
--
-- What each independent read is FOR:
--   grid                the grid's own totals off view_blocking_grid + the age view,
--                       so the folds are an AGREEMENT rather than a tautology.
--   grid_bands_default  the same per-band split with the default cuts, spelled out
--                       longhand, as a second opinion on the classifier.
--   age_reuse           THE one-definition proof: our age against the aging
--                       watchlist's on every batch both cover. `mismatches` must be 0
--                       and `max_gap` exactly 0.
--   coverage            how far the grid population sits from the watchlist's
--                       one-tonne floor, which is exactly why the lens reads
--                       view_batch_age_days and not the watchlist.
--
-- BOUNDED BY CONSTRUCTION: 10 lens calls over a 168-row grid (238 slots maximum), one
-- 168-row grid aggregation, and one 170-row join against the aging watchlist.
--
-- IT RETURNS NO ₱ AT ALL — only dates, day counts, kilograms, gaps and booleans.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blocking_age_lens_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_of date := (now() AT TIME ZONE 'Asia/Manila')::date;
BEGIN
  RETURN jsonb_build_object(
    'manila_today', v_as_of,

    'lens_default', public.fn_blocking_age_lens(),
    'lens_wide',    public.fn_blocking_age_lens(ARRAY[30, 60, 90, 120, 180, 365]),
    'lens_single',  public.fn_blocking_age_lens(ARRAY[365]),
    'lens_dupes',   public.fn_blocking_age_lens(ARRAY[365, 60, 120, 60, 365]),

    'refusal_no_edges',       public.fn_blocking_age_lens(ARRAY[]::int[]),
    'refusal_too_many_edges', public.fn_blocking_age_lens(ARRAY[10, 20, 30, 40, 50, 60, 70]),
    'refusal_null_edge',      public.fn_blocking_age_lens(ARRAY[NULL, 60]::int[]),
    'refusal_zero_edge',      public.fn_blocking_age_lens(ARRAY[0, 60]),
    'refusal_negative_edge',  public.fn_blocking_age_lens(ARRAY[-5, 60]),
    'refusal_huge_edge',      public.fn_blocking_age_lens(ARRAY[60, 5001]),

    'grid', (
      SELECT jsonb_build_object(
          'block_count',          count(*)::int,
          'kg',                   COALESCE(sum(s.kg), 0),
          'dated_block_count',    count(*) FILTER (WHERE s.age_days IS NOT NULL)::int,
          'dated_kg',             COALESCE(sum(s.kg) FILTER (WHERE s.age_days IS NOT NULL), 0),
          'undated_block_count',  count(*) FILTER (WHERE s.age_days IS NULL)::int,
          'undated_kg',           COALESCE(sum(s.kg) FILTER (WHERE s.age_days IS NULL), 0),
          'kg_weighted_age_days', sum(s.kg * s.age_days) / NULLIF(sum(s.kg) FILTER (WHERE s.age_days IS NOT NULL), 0),
          'oldest_age_days',      max(s.age_days))
      FROM (
        SELECT g.block_loc, g.balance::numeric AS kg, a.age_days
        FROM public.view_blocking_grid g
        LEFT JOIN public.view_batch_age_days a ON a.batch_code = g.batch_code
        WHERE g.balance > 0
      ) s),

    'grid_bands_default', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'index', x.band_index, 'block_count', x.block_count, 'kg', x.kg,
               'kg_weighted_age_days', x.wtd_age) ORDER BY x.band_index)
      FROM (
        SELECT CASE WHEN s.age_days >= 365 THEN 3
                    WHEN s.age_days >= 120 THEN 2
                    WHEN s.age_days >=  60 THEN 1
                    ELSE 0 END                             AS band_index,
               count(*)::int                               AS block_count,
               sum(s.kg)                                   AS kg,
               sum(s.kg * s.age_days) / NULLIF(sum(s.kg), 0) AS wtd_age
        FROM (
          SELECT g.balance::numeric AS kg, a.age_days
          FROM public.view_blocking_grid g
          LEFT JOIN public.view_batch_age_days a ON a.batch_code = g.batch_code
          WHERE g.balance > 0 AND a.age_days IS NOT NULL
        ) s
        GROUP BY 1) x), '[]'::jsonb),

    'age_reuse', (
      SELECT jsonb_build_object(
          'both_cover',  count(*)::int,
          'mismatches',  count(*) FILTER (WHERE m.age_days IS DISTINCT FROM w.age_days)::int,
          'max_gap',     COALESCE(max(abs(m.age_days - w.age_days)), 0))
      FROM public.view_analytics_aging_watchlist w
      JOIN public.view_batch_age_days m ON m.batch_code = w.batch_code
      WHERE w.age_days IS NOT NULL),

    'coverage', (
      SELECT jsonb_build_object(
          'grid_blocks',           count(*)::int,
          'in_watchlist',          count(w.batch_id)::int,
          'min_grid_balance_kg',   min(g.balance),
          'grid_blocks_under_1t',  count(*) FILTER (WHERE g.balance <= 1000)::int)
      FROM public.view_blocking_grid g
      LEFT JOIN public.view_analytics_aging_watchlist w ON w.batch_id = g.batch_id
      WHERE g.balance > 0),

    'posture', jsonb_build_object(
      'lens_authenticated',  has_function_privilege('authenticated', 'public.fn_blocking_age_lens(int[])', 'EXECUTE'),
      'lens_anon',           has_function_privilege('anon',          'public.fn_blocking_age_lens(int[])', 'EXECUTE'),
      'lens_service_role',   has_function_privilege('service_role',  'public.fn_blocking_age_lens(int[])', 'EXECUTE'),
      'probe_authenticated', has_function_privilege('authenticated', 'public.fn_blocking_age_lens_probe()', 'EXECUTE'),
      'probe_anon',          has_function_privilege('anon',          'public.fn_blocking_age_lens_probe()', 'EXECUTE'),
      'probe_service_role',  has_function_privilege('service_role',  'public.fn_blocking_age_lens_probe()', 'EXECUTE'),
      'view_authenticated',  has_table_privilege('authenticated', 'public.view_batch_age_days', 'SELECT'),
      'view_anon',           has_table_privilege('anon',          'public.view_batch_age_days', 'SELECT'),
      'view_service_role',   has_table_privilege('service_role',  'public.view_batch_age_days', 'SELECT'),
      'view_security_invoker', (SELECT count(*)::int FROM pg_class c
                                  JOIN pg_namespace n ON n.oid = c.relnamespace
                                 WHERE n.nspname = 'public' AND c.relname = 'view_batch_age_days'
                                   AND c.reloptions @> ARRAY['security_invoker=true']),
      'lens_invoker',        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_age_lens'
                                 AND p.prosecdef = false),
      'stable_count',        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public'
                                 AND p.proname IN ('fn_blocking_age_lens', 'fn_blocking_age_lens_probe')
                                 AND p.provolatile = 's'),
      'search_path_pinned',  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public'
                                 AND p.proname IN ('fn_blocking_age_lens', 'fn_blocking_age_lens_probe')
                                 AND p.proconfig @> ARRAY['search_path=public']),
      'commented',           (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_age_lens'
                                 AND obj_description(p.oid, 'pg_proc') IS NOT NULL)
    )
  );
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_age_lens_probe() IS
'Read-only ACCESS BRIDGE so scripts/verify-blocking-age-lens.ts can exercise the authenticated-only fn_blocking_age_lens with the service-role key it holds. It ASSERTS NOTHING — it calls the lens a fixed number of times, recomputes the grid''s totals and the default band split INDEPENDENTLY off view_blocking_grid + view_batch_age_days, joins view_batch_age_days against view_analytics_aging_watchlist to prove the two ages are one definition, and hands everything back so every assertion lives in the script where a human can read it. Deliberately NOT a whole-database verifier (the 2026-09-14 fn_ops_ledger_verify incident): every population is bounded by construction — one row per occupied block, one row per batch code with a delivery, 170 watchlist rows. Returns NO money value of any kind. SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_age_lens_probe() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_age_lens_probe() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_age_lens_probe() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_age_lens_probe() TO service_role;
