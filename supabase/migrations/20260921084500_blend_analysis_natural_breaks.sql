-- ─────────────────────────────────────────────────────────────────────────────
-- BLEND PROPOSAL **ANALYSIS** — the extra pages, on the Blocking page
--
-- Renzo, 2026-09-21: in a saved blend proposal, when viewing AND printing, add pages
-- that "group and arrange blocks according to high priced and low priced and average
-- priced … a statistical way of properly grouping these as something we can objectively
-- agree to be high and low", another page for MC / ash / BD, maybe age, tables "with
-- footers that show totals or averages when appropriate", "incorporating some of the
-- logic of our price lens into blend proposal".
--
--   §1  fn_natural_breaks_3   — THE grouping method, pure maths, reusable per metric
--   §2  fn_blend_analysis     — the whole payload: price · quality · age
--   §3  posture for both
--   §4  fn_blocking_price_lens gains kg_weighted_php_kg (additive keys only)
--   §5  fn_blend_analysis_probe — the ACCESS BRIDGE for the verify script
--
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §0a  WHY NATURAL BREAKS, AND NOT MEAN ± 1 SD
-- ═════════════════════════════════════════════════════════════════════════════
-- The owner asked for a split "we can objectively agree to be high and low". The obvious
-- answer — mean ± one standard deviation — was MEASURED on his own proposal and REJECTED.
--
-- "26 OCT RUN V2" v2: 24 blocks, kg-weighted mean ₱43.56, SD ₱5.11, and the prices sit
-- in TWO CLUMPS — ₱36.57…₱42.00 and ₱47.00…₱49.50 — with the mean landing in the EMPTY
-- GAP between them. Mean ± 1 SD is therefore [₱38.45, ₱48.67], which files a ₱39 block
-- and a ₱48 block together as "average": it puts the two clumps' inner halves in one
-- band and splits each clump in the middle. The statistic describes a distribution the
-- data does not have.
--
-- NATURAL BREAKS (Jenks, the 1-D optimal partition) places the cut lines where the gaps
-- ACTUALLY ARE, by minimising the kg-WEIGHTED within-group sum of squares:
--
--   minimise   Σ_groups Σ_i  kg_i · (x_i − weighted_mean_of_its_group)²
--
-- It is not a heuristic here and not an approximation: §1 enumerates EVERY pair of cut
-- positions and picks the best one, so the answer is optimal by construction rather than
-- by iteration count. Prefix sums make each candidate O(1):
--
--   for a group spanning sorted items i..j with  W = Σkg, S = Σkg·x, Q = Σkg·x² ,
--   its weighted SS is exactly  Q − S²/W  — one subtraction, one divide.
--
-- Cut positions are only ever taken BETWEEN TWO DISTINCT ADJACENT VALUES, so two blocks
-- at the same price can never be separated, and no cut is invented inside a tie.
--
-- WEIGHTED BY KILOGRAMS, ALWAYS. A 74,590 kg block and a 30,115 kg block are not equal
-- opinions about what the blend costs; the whole page exists to describe a PILE. That is
-- also what makes the group footers agree with the blend's own weighted averages.
--
-- THE TIE-BREAK IS DETERMINISTIC AND IS PART OF THE CONTRACT: among candidate cut pairs
-- with equal within-SS, the LOWEST first cut wins, then the lowest second cut. Without a
-- stated rule, two consecutive calls on identical data could return different groupings
-- and nobody would be able to tell which was "right".
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §0b  GOODNESS OF VARIANCE FIT — so the print can say how clean the split is
-- ═════════════════════════════════════════════════════════════════════════════
--   gvf = 1 − within_ss / total_ss
-- 1.0 = every group is a single value; 0 = the grouping explains nothing. It is NULL —
-- never 0 — when total_ss is 0 (one distinct value, so there is no variance to explain
-- and "explained none of it" would be a lie). The owner's proposal reads 0.96 on price,
-- which is what licences the sentence "these really are three clumps".
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §0c  DEGENERATE CASES — never an empty group, never a fabricated cut
-- ═════════════════════════════════════════════════════════════════════════════
-- k is 3 by NAME and by intent, but 3 groups need 3 distinct values. With fewer, the
-- function returns FEWER GROUPS rather than an empty one:
--   ≥ 3 distinct → 3 groups, labels low · mid · high
--     2 distinct → 2 groups, labels low · high
--     1 distinct → 1 group,  label  mid      (it is neither low nor high)
--     0 measured → 0 groups, everything is `unmeasured`, gvf NULL
-- The label vocabulary is CLOSED to {low, mid, high} so a UI's colour map is total.
-- `group_count` is published so a caller never infers it from array length by accident.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §0d  UNMEASURED — NULL IS NEVER 0, for the fifth time in this codebase
-- ═════════════════════════════════════════════════════════════════════════════
-- A metric value that is NULL **or ≤ 0** is the NOT-RECORDED placeholder, not a reading:
--   * `php_kg` 0 is the L-008 unpriced placeholder (`avg_php_kg` is COALESCEd to 0 by
--     `view_blocking_grid`), the same rule the price lens's `unpriced` bucket applies —
--     the ₱11.01-vs-₱39.99 `avg_cost` bug.
--   * a lab reading of 0 is likewise "no lab result": `view_blocking_grid` COALESCEs
--     avg_ash / avg_bd_astm / avg_bd_jis to 0, and MEASURED 2026-09-21, **11 of the 170
--     occupied blocks read exactly 0 on all three** while 0 of 170 read 0 on mc or php.
--     Charcoal with 0.000 % ash does not exist; calling it the cleanest block in the
--     blend is the same mistake in a new costume.
-- Such a block goes in `unmeasured`, in NO group, and is EXCLUDED from every average and
-- from every share denominator. A block with no positive WEIGHT is excluded too (it has
-- a reading but no say), and the two reasons are counted separately so a UI can explain
-- the blank. Consequently, in EVERY section:
--   Σ groups[].kg + unmeasured.kg = total_kg     (and the same for block_count)
--   Σ kg_share_pct = 100  and  Σ block_share_pct = 100  over the MEASURED population.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §0e  SAVED vs LIVE, AND THE AS-OF RULE
-- ═════════════════════════════════════════════════════════════════════════════
-- Exactly one source is given.
--   SAVED  `p_proposal_id` (+ optional `p_version_no`, default the current one). The
--          block rows and every lab/price figure are read from the STORED
--          `blend_proposal_versions.snapshot` VERBATIM and are never recomputed: a
--          proposal is a statement about the yard ON A PARTICULAR DAY, and its snapshot
--          is immutable and HASHED (`fn_blend_snapshot_hash`). This migration touches
--          nothing in that feature — no table, no snapshot, no hash, no grant.
--   LIVE   `p_block_locs` → `fn_blend_proposal_snapshot(p_block_locs)`, the ONE existing
--          builder, so the live analysis and a save made in the same second describe the
--          same numbers. Its arithmetic is not restated here.
--
-- THE AS-OF DATE is the Asia/Manila calendar date of the version's own `created_at` for
-- a saved version (the same choice `fn_blend_block_facts` is documented to take —
-- `created_at` is the column the read model always populates; `snapshot.computed_at` is
-- the same instant for a version saved normally), and TODAY in Asia/Manila for live.
-- It matters for exactly one thing: the AGE section counts only deliveries dated on or
-- before it, so a delivery that lands later can never repaint an old proposal. MEASURED
-- on live data 2026-09-21: the archived "ZZ TEST" proposal v3 (as of 2026-09-03) holds
-- `AUG-26-BLK12`, whose last delivery on that day was 2026-09-01 — and one arrived on
-- 2026-09-07. The saved analysis reads 2026-09-01 and the live analysis reads 2026-09-07.
--
-- READING AN ARCHIVED PROPOSAL IS ALLOWED. `fn_save_blend_proposal` refuses to WRITE to
-- one; refusing to read it would hide the proposals list's own archived rows.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §0f  ₱ LIVES IN EXACTLY ONE SECTION, AND THAT IS THE SECURITY BOUNDARY
-- ═════════════════════════════════════════════════════════════════════════════
-- `sections.price` carries money — the group ₱/kg, the band edges, Σ kg·₱, and, exactly
-- as the price lens records, BAND MEMBERSHIP ITSELF (knowing a block is in the `high`
-- group pins its ₱/kg to a range). `sections.quality` and `sections.age` carry NONE and
-- none is derivable from them: readings, kilograms, day counts, shares.
--
-- So unlike `fn_blocking_price_lens` — whose whole payload is price, so its action
-- REFUSES a `!canViewPrices()` caller — this function's payload SPLITS, and
-- `fetchBlendAnalysis` therefore DELETES `sections.price` (sets it null, with
-- `pricesHidden: true`) and still returns quality + age to Production. Not one key
-- matching `php|peso|cost|price|value_php|amount` exists outside `sections.price`, which
-- is what makes that deletion sufficient rather than hopeful; the quality metric's own
-- reading is deliberately named `value` / `kg_weighted_value` (a moisture percentage is
-- not money) and the verify script scans for the money names on a real payload.
--
-- Grants: `authenticated` only (it is pure arithmetic over relations that role already
-- reads), `anon` and `PUBLIC` revoked, and **NOT `service_role`** — no sync worker calls
-- it, so `verify-worker-view-grants` stays at 4 views / 0 findings.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §0g  COST, MEASURED BEFORE ANY PROOF WAS WRITTEN (the 2026-09-14 rule)
-- ═════════════════════════════════════════════════════════════════════════════
-- `set local statement_timeout='5s'` then EXPLAIN (ANALYZE, BUFFERS), 2026-09-21:
--   fn_natural_breaks_3, 250 distinct values (31,125 candidate cut pairs)   57.7 ms
--   fn_natural_breaks_3, 1,000 values — the hard cap (499,500 candidates)  726.5 ms
--   fn_blend_proposal_snapshot(3 locs), the live path's own input           30.9 ms
--   (the per-call figures for fn_blend_analysis itself are recorded beside
--    the assertions in scripts/verify-blend-analysis.ts, measured the same day)
--
-- THE SEARCH RUNS ON `double precision` PREFIX SUMS AND THE REPORTED FIGURES ON
-- `numeric` ONES, and that split is measured, not stylistic: a `numeric[]` element is
-- varlena, so `arr[k]` walks the array and the "O(1) per candidate" claim is false —
-- the identical function on numeric prefix sums took **279 ms** at 250 values against
-- 57.7 ms on float8 (fixed-width, genuinely O(1)). Every number the function PUBLISHES
-- is recomputed in exact `numeric` for the ≤ 3 groups that survive, so only the
-- comparison that chooses between candidates is in floating point — and that is also
-- what makes the TypeScript brute-force oracle in the verify script able to agree with
-- it exactly rather than within a tolerance.
--
-- The cost is quadratic in DISTINCT values, so §1 refuses more than 1,000 outright and
-- the server action caps a blend at 250 blocks. Both bounds are by construction: a blend
-- cannot hold more blocks than the yard has occupied ones (170 today, 238 slots).
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- §1  fn_natural_breaks_3 — THE grouping method. Pure maths, no table access.
-- ═════════════════════════════════════════════════════════════════════════════
-- Reading notes (kept OUT of the body so `prosrc` is exactly what this file says):
--
--   v_x / v_w    the MEASURED items, sorted ascending by value (ties ordered by weight,
--                so the array is deterministic even though the sums are not affected).
--   v_pw/ps/pq   exact prefix sums, length n+1, index 1 = 0. Group i..j reads
--                `v_pw[j+1] − v_pw[i]`, so no CASE for the first group.
--   v_fw/fs/fq   the same, as float8, for the SEARCH only (see §0g).
--   v_bp         the cut POSITIONS that are legal: p where x[p] < x[p+1]. k distinct
--                values give exactly k−1 of them.
--   the search   every pair (a < b) of legal positions, scored by the summed weighted
--                SS of the three groups it induces, ordered by (score, a, b) — THE
--                documented tie-break.
--
-- `p_weights` NULL means EQUAL WEIGHTS (all 1). That exists for the hand-checkable unit
-- cases in the verify script, not for production: every caller here weights by kilograms.
CREATE OR REPLACE FUNCTION public.fn_natural_breaks_3(
  p_values  numeric[],
  p_weights numeric[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
  v_len      int;
  v_wlen     int;
  v_x        numeric[];
  v_w        numeric[];
  v_n        int;
  v_pw       numeric[];
  v_ps       numeric[];
  v_pq       numeric[];
  v_fw       double precision[];
  v_fs       double precision[];
  v_fq       double precision[];
  v_bp       int[];
  v_d        int;
  v_cuts     int[] := ARRAY[]::int[];
  v_total_w  numeric;
  v_total_s  numeric;
  v_total_q  numeric;
  v_total_ss numeric;
  v_within   numeric := 0;
  v_a        int;
  v_b        int;
  v_cand     bigint := 0;
  v_groups   jsonb := '[]'::jsonb;
  v_cutj     jsonb := '[]'::jsonb;
  v_gc       int;
  v_i        int;
  v_start    int;
  v_end      int;
  v_gw       numeric;
  v_gs       numeric;
  v_gq       numeric;
  v_gss      numeric;
BEGIN
  v_len  := COALESCE(cardinality(p_values), 0);
  v_wlen := COALESCE(cardinality(p_weights), 0);

  -- A refusal is jsonb written for a human, never a RAISE (the fn_save_blend_proposal
  -- idiom) — the caller hands `message` straight to errorToast().
  IF p_weights IS NOT NULL AND v_wlen <> v_len THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'length_mismatch',
      'message', format('There are %s values but %s weights - a natural-breaks split needs one weight per value.', v_len, v_wlen));
  END IF;

  -- Quadratic in distinct values, so the bound is structural rather than advisory.
  IF v_len > 1000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many_values',
      'message', format('A natural-breaks split takes at most 1,000 values; this one has %s.', v_len));
  END IF;

  -- NaN and Infinity are excluded EXPLICITLY: in numeric comparison NaN = NaN is TRUE
  -- and NaN sorts ABOVE every number, so `w > 0` alone would admit a NaN weight and one
  -- unorderable value would decide every cut.
  SELECT array_agg(t.x ORDER BY t.x, t.w), array_agg(t.w ORDER BY t.x, t.w)
    INTO v_x, v_w
  FROM (
    SELECT p_values[g.i] AS x,
           CASE WHEN p_weights IS NULL THEN 1::numeric ELSE p_weights[g.i] END AS w
    FROM generate_series(1, v_len) AS g(i)
  ) t
  WHERE t.x IS NOT NULL AND t.w IS NOT NULL
    AND t.x <> 'NaN'::numeric AND t.x <> 'Infinity'::numeric AND t.x <> '-Infinity'::numeric
    AND t.w <> 'NaN'::numeric AND t.w <> 'Infinity'::numeric
    AND t.w > 0;

  v_n := COALESCE(cardinality(v_x), 0);

  -- Nothing measurable. NOT an error and NOT zeroes: no groups, no cuts, NULL gvf.
  IF v_n = 0 THEN
    RETURN jsonb_build_object('ok', true, 'k', 3, 'group_count', 0, 'n', 0,
      'excluded_count', v_len, 'distinct_count', 0, 'total_weight', 0,
      'weighted_mean', NULL, 'total_ss', NULL, 'within_ss', NULL, 'between_ss', NULL,
      'gvf', NULL, 'candidates_considered', 0, 'cuts', '[]'::jsonb, 'groups', '[]'::jsonb);
  END IF;

  WITH items AS (
    SELECT g.i, v_x[g.i] AS x, v_w[g.i] AS w FROM generate_series(1, v_n) AS g(i)
  ), pref AS (
    SELECT i, sum(w) OVER (ORDER BY i) AS cw, sum(w * x) OVER (ORDER BY i) AS cs,
              sum(w * x * x) OVER (ORDER BY i) AS cq
    FROM items
  )
  SELECT array_prepend(0::numeric, array_agg(cw ORDER BY i)),
         array_prepend(0::numeric, array_agg(cs ORDER BY i)),
         array_prepend(0::numeric, array_agg(cq ORDER BY i)),
         array_prepend(0::float8,  array_agg(cw::float8 ORDER BY i)),
         array_prepend(0::float8,  array_agg(cs::float8 ORDER BY i)),
         array_prepend(0::float8,  array_agg(cq::float8 ORDER BY i))
    INTO v_pw, v_ps, v_pq, v_fw, v_fs, v_fq
  FROM pref;

  v_total_w  := v_pw[v_n + 1];
  v_total_s  := v_ps[v_n + 1];
  v_total_q  := v_pq[v_n + 1];
  -- greatest(.., 0) only guards the last bits of numeric rounding; Q − S²/W is >= 0.
  v_total_ss := greatest(v_total_q - v_total_s * v_total_s / v_total_w, 0);

  SELECT COALESCE(array_agg(g.p ORDER BY g.p), ARRAY[]::int[]) INTO v_bp
  FROM generate_series(1, v_n - 1) AS g(p) WHERE v_x[g.p] < v_x[g.p + 1];

  v_d := COALESCE(cardinality(v_bp), 0) + 1;

  IF v_d >= 3 THEN
    SELECT c.a, c.b, c.total INTO v_a, v_b, v_cand
    FROM (
      SELECT ba.p AS a, bb.p AS b,
             ( (v_fq[ba.p+1] - v_fq[1])      - (v_fs[ba.p+1] - v_fs[1])      ^ 2 / (v_fw[ba.p+1] - v_fw[1]) )
           + ( (v_fq[bb.p+1] - v_fq[ba.p+1]) - (v_fs[bb.p+1] - v_fs[ba.p+1]) ^ 2 / (v_fw[bb.p+1] - v_fw[ba.p+1]) )
           + ( (v_fq[v_n+1]  - v_fq[bb.p+1]) - (v_fs[v_n+1]  - v_fs[bb.p+1]) ^ 2 / (v_fw[v_n+1]  - v_fw[bb.p+1]) )
               AS w_ss,
             count(*) OVER () AS total
      FROM unnest(v_bp) AS ba(p) CROSS JOIN unnest(v_bp) AS bb(p)
      WHERE ba.p < bb.p
    ) c
    ORDER BY c.w_ss ASC, c.a ASC, c.b ASC
    LIMIT 1;
    v_cuts := ARRAY[v_a, v_b];
  ELSIF v_d = 2 THEN
    -- Exactly one legal position, so there is nothing to search and nothing to choose.
    v_cuts := v_bp;
    v_cand := 1;
  END IF;

  v_gc := COALESCE(cardinality(v_cuts), 0) + 1;

  FOR v_i IN 1 .. v_gc LOOP
    v_start := CASE WHEN v_i = 1    THEN 1   ELSE v_cuts[v_i - 1] + 1 END;
    v_end   := CASE WHEN v_i = v_gc THEN v_n ELSE v_cuts[v_i]         END;
    v_gw  := v_pw[v_end + 1] - v_pw[v_start];
    v_gs  := v_ps[v_end + 1] - v_ps[v_start];
    v_gq  := v_pq[v_end + 1] - v_pq[v_start];
    v_gss := greatest(v_gq - v_gs * v_gs / v_gw, 0);
    v_within := v_within + v_gss;
    v_groups := v_groups || jsonb_build_object(
      'index', v_i - 1,
      -- CLOSED vocabulary. A single group is `mid`: it is neither low nor high.
      'label', CASE WHEN v_gc = 3 THEN (ARRAY['low','mid','high'])[v_i]
                    WHEN v_gc = 2 THEN (ARRAY['low','high'])[v_i]
                    ELSE 'mid' END,
      -- The range ACTUALLY OBSERVED in the group, not the cut lines around it.
      'range_min', v_x[v_start], 'range_max', v_x[v_end],
      'n', v_end - v_start + 1, 'weight', v_gw,
      'weighted_mean', v_gs / v_gw, 'within_ss', v_gss);
  END LOOP;

  -- A cut is published three ways: the two values it sits between, and the midpoint.
  -- MEMBERSHIP IS DECIDED ON `above` (an observed value), never on the midpoint — the
  -- midpoint is for a legend, and a caller must not reinvent the test from it.
  FOR v_i IN 1 .. COALESCE(cardinality(v_cuts), 0) LOOP
    v_cutj := v_cutj || jsonb_build_object(
      'index', v_i - 1,
      'below', v_x[v_cuts[v_i]],
      'above', v_x[v_cuts[v_i] + 1],
      'value', (v_x[v_cuts[v_i]] + v_x[v_cuts[v_i] + 1]) / 2);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'k', 3, 'group_count', v_gc, 'n', v_n,
    'excluded_count', v_len - v_n, 'distinct_count', v_d,
    'total_weight', v_total_w, 'weighted_mean', v_total_s / v_total_w,
    'total_ss', v_total_ss, 'within_ss', v_within,
    'between_ss', greatest(v_total_ss - v_within, 0),
    -- NULL, never 0, when there is no variance to explain.
    'gvf', CASE WHEN v_total_ss > 0 THEN 1 - v_within / v_total_ss END,
    'candidates_considered', v_cand, 'cuts', v_cutj, 'groups', v_groups);
END;
$$;

COMMENT ON FUNCTION public.fn_natural_breaks_3(numeric[], numeric[]) IS
'THE grouping method behind the Blend Proposal ANALYSIS pages: a WEIGHTED 1-D optimal partition (Jenks natural breaks) into at most THREE groups, labelled low / mid / high. It is EXACT, not a heuristic: it enumerates every pair of cut positions taken BETWEEN TWO DISTINCT ADJACENT VALUES and returns the pair minimising the weighted within-group sum of squares, sum over groups of kg_i * (x_i - weighted mean of its group) squared, computed in O(1) per candidate from prefix sums of weight, weight*x and weight*x*x. THE TIE-BREAK IS PART OF THE CONTRACT: on equal within-SS the LOWEST first cut wins, then the lowest second cut, so two calls on identical data cannot disagree. Chosen over mean +/- 1 SD because that statistic was MEASURED on the owner''s own proposal and found to describe a distribution the data does not have: 24 blocks in two price clumps with the kg-weighted mean sitting in the empty gap between them, so mean +/- 1 SD filed a PHP 39 block and a PHP 48 block together as "average". p_weights NULL means EQUAL WEIGHTS (all 1) and exists for hand-checkable unit tests; every production caller weights by KILOGRAMS, because a 74,590 kg block and a 30,115 kg block are not equal opinions about what a pile contains. DEGENERATE CASES RETURN FEWER GROUPS, never an empty one and never a fabricated cut: 2 distinct values give 2 groups (low / high), 1 gives 1 (labelled mid - it is neither low nor high), and nothing measurable gives 0 groups with NULL statistics. An element is EXCLUDED and counted in excluded_count when its value is NULL or non-finite or its weight is NULL, non-finite or not positive - it is the caller''s job to report those as "unmeasured", and NULL is never read as 0. gvf = 1 - within_ss / total_ss says how clean the split is, and is NULL (never 0) when total_ss is 0. Each cut is published as the two values it sits between plus their midpoint; MEMBERSHIP IS DECIDED ON `above`, an observed value, never on the midpoint. Refusals are jsonb {ok:false, reason, message} written for a human: length_mismatch, too_many_values (above 1,000 - the cost is quadratic in distinct values). IMMUTABLE, no table access, carries no money and knows nothing about charcoal. MEASURED 2026-09-21: 57.7 ms for 250 distinct values (31,125 candidates), 726 ms at the 1,000 cap; the candidate SEARCH runs on double-precision prefix sums because a numeric[] subscript is not O(1) (the same function on numeric prefix sums took 279 ms at 250), while every PUBLISHED figure is recomputed in exact numeric. authenticated only; anon and PUBLIC revoked.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §2  fn_blend_analysis — price · quality · age for one blend
-- ═════════════════════════════════════════════════════════════════════════════
-- Reading notes for the body (kept out of it):
--
--   v_snapshot  the blend, in `fn_blend_proposal_snapshot`'s shape, from the STORED
--               version (saved) or from that function (live). Never rebuilt by hand.
--   v_rows      one jsonb object per block: the snapshot's own figures PLUS the age
--               fold. Built ONCE and read by every section, so no two sections can
--               describe different populations.
--   age         `view_batch_age_days`' expression, lifted ARM FOR ARM (the 2000-01-01
--               day-number epoch, the NULLIF denominator) and narrowed by
--               `transaction_date <= as_of`. At as_of = today it is that view's
--               `age_days` exactly; the verify script requires a 0 gap on every block.
--               THERE IS NO SECOND AGE DEFINITION HERE.
--   membership  price/quality: "how many cuts has this value passed" (count of
--               `cuts[].above` reached) — TOTAL by construction. age: the price lens's
--               own "highest band whose lower bound is satisfied", which is what puts a
--               NEGATIVE age (a future-dated delivery) in band 0 rather than in no band.
CREATE OR REPLACE FUNCTION public.fn_blend_analysis(
  p_proposal_id        uuid    DEFAULT NULL,
  p_version_no         int     DEFAULT NULL,
  p_block_locs         text[]  DEFAULT NULL,
  p_price_edge_offsets int[]   DEFAULT ARRAY[-1, 0],
  p_age_edge_days      int[]   DEFAULT ARRAY[60, 120, 365],
  p_market_php_kg      numeric DEFAULT NULL,
  p_rounded_up_php     int     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_source        text;
  v_snapshot      jsonb;
  v_as_of         date;
  v_title         text;
  v_version_no    int;
  v_cur_version   int;
  v_created_at    timestamptz;
  v_locs          text[];
  v_missing       text[];
  v_rows          jsonb;
  v_block_count   int;
  v_total_kg      numeric;
  v_price_edges   int[];
  v_age_edges     int[];
  v_market        numeric;
  v_market_basis  text;
  v_market_month  date;
  v_r             numeric;
  v_nb            jsonb;
  v_price         jsonb;
  v_vs_market     jsonb;
  v_vs_unavail    jsonb;
  v_quality       jsonb := '{}'::jsonb;
  v_age           jsonb;
  v_metric        text;
  v_section       jsonb;
BEGIN
  -- ════════════════════════════════════════════════════════════════════════
  -- (1) EXACTLY ONE SOURCE
  -- ════════════════════════════════════════════════════════════════════════
  IF p_proposal_id IS NOT NULL AND p_block_locs IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'both_sources',
      'message', 'Analyse either a saved proposal version or a live list of blocks - not both at once.');
  END IF;

  IF p_proposal_id IS NULL AND p_block_locs IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_source',
      'message', CASE WHEN p_version_no IS NOT NULL
                      THEN 'A version number needs a proposal to belong to. Give the proposal as well, or give a list of blocks.'
                      ELSE 'Nothing to analyse yet - give a saved proposal, or a list of blocks.' END);
  END IF;

  IF p_proposal_id IS NOT NULL THEN
    v_source := 'saved';

    SELECT bp.title, bp.current_version_no INTO v_title, v_cur_version
    FROM public.blend_proposals bp WHERE bp.id = p_proposal_id;

    IF v_cur_version IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'unknown_proposal',
        'message', 'That proposal no longer exists. Reopen the proposals list and try again.');
    END IF;

    -- No version given = the CURRENT one, which is what the viewer opens on.
    -- READING AN ARCHIVED PROPOSAL IS DELIBERATELY ALLOWED - see the header.
    v_version_no := COALESCE(p_version_no, v_cur_version);

    SELECT bv.snapshot, bv.created_at INTO v_snapshot, v_created_at
    FROM public.blend_proposal_versions bv
    WHERE bv.proposal_id = p_proposal_id AND bv.version_no = v_version_no;

    IF v_snapshot IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'unknown_version',
        'message', format('There is no v%s of "%s" - its latest version is v%s.',
                          v_version_no, v_title, v_cur_version));
    END IF;

    -- THE AS-OF DATE. `created_at`, not `snapshot.computed_at`: it is the column the
    -- version read model always populates, which is the choice fn_blend_block_facts
    -- records, and the two are the same instant for a version saved normally.
    v_as_of := (v_created_at AT TIME ZONE 'Asia/Manila')::date;

  ELSE
    v_source := 'live';

    SELECT COALESCE(array_agg(DISTINCT btrim(l)), ARRAY[]::text[]) INTO v_locs
    FROM unnest(p_block_locs) AS l
    WHERE btrim(COALESCE(l, '')) <> '';

    IF COALESCE(cardinality(v_locs), 0) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_blocks',
        'message', 'Pick at least one block first.');
    END IF;

    IF cardinality(v_locs) > 250 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'too_many_blocks',
        'message', format('That is %s blocks; an analysis covers at most 250 at a time.', cardinality(v_locs)));
    END IF;

    -- A block that is not on the grid is NAMED, never silently dropped: analysing a set
    -- you could not resolve would quietly describe a different blend (the
    -- fn_save_blend_proposal discipline).
    SELECT COALESCE(array_agg(l ORDER BY l), ARRAY[]::text[]) INTO v_missing
    FROM unnest(v_locs) AS l
    WHERE NOT EXISTS (SELECT 1 FROM public.view_blocking_grid g WHERE g.block_loc = l);

    IF COALESCE(cardinality(v_missing), 0) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'unknown_block_loc',
        'message', format('No active batch is in %s right now, so it cannot be analysed.',
                          array_to_string(v_missing, ', ')));
    END IF;

    -- THE ONE EXISTING BUILDER. Its arithmetic is not restated here.
    v_snapshot := public.fn_blend_proposal_snapshot(v_locs);
    v_as_of    := (now() AT TIME ZONE 'Asia/Manila')::date;
  END IF;

  IF jsonb_typeof(v_snapshot -> 'blocks') <> 'array'
     OR jsonb_array_length(v_snapshot -> 'blocks') = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_blocks',
      'message', 'This blend has no blocks to analyse.');
  END IF;

  IF jsonb_array_length(v_snapshot -> 'blocks') > 250 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many_blocks',
      'message', format('That blend holds %s blocks; an analysis covers at most 250 at a time.',
                        jsonb_array_length(v_snapshot -> 'blocks')));
  END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- (2) THE EDGE LISTS. Same rules and same words as the two lenses; the REASON
  --     codes are prefixed because one function takes both families and a caller
  --     has to know which list it got wrong.
  -- ════════════════════════════════════════════════════════════════════════
  v_price_edges := COALESCE(p_price_edge_offsets, ARRAY[-1, 0]);

  IF EXISTS (SELECT 1 FROM unnest(v_price_edges) AS o WHERE o IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_price_edge',
      'message', 'Every band edge has to be a whole number of pesos away from market.');
  END IF;

  SELECT array_agg(DISTINCT o ORDER BY o) INTO v_price_edges FROM unnest(v_price_edges) AS o;

  IF v_price_edges IS NULL OR cardinality(v_price_edges) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_price_edges',
      'message', 'A price lens needs at least one band edge - with none, every block is in the same band and nothing is highlighted.');
  END IF;

  IF cardinality(v_price_edges) > 6 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many_price_edges',
      'message', format('A price lens takes at most 6 band edges; this one has %s.', cardinality(v_price_edges)));
  END IF;

  v_age_edges := COALESCE(p_age_edge_days, ARRAY[60, 120, 365]);

  IF EXISTS (SELECT 1 FROM unnest(v_age_edges) AS e WHERE e IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_age_edge',
      'message', 'Every cut line has to be a whole number of days.');
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(v_age_edges) AS e WHERE e <= 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_age_edge',
      'message', 'A cut line has to be at least 1 day - the first band already starts at day 0.');
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(v_age_edges) AS e WHERE e > 5000) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_age_edge',
      'message', 'A cut line above 5,000 days is further back than any charcoal in the yard - check the number.');
  END IF;

  SELECT array_agg(DISTINCT e ORDER BY e) INTO v_age_edges FROM unnest(v_age_edges) AS e;

  IF v_age_edges IS NULL OR cardinality(v_age_edges) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_age_edges',
      'message', 'An age lens needs at least one cut line - with none, every block is in the same band and nothing is highlighted.');
  END IF;

  IF cardinality(v_age_edges) > 6 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many_age_edges',
      'message', format('An age lens takes at most 6 cut lines; this one has %s.', cardinality(v_age_edges)));
  END IF;

  -- A GIVEN cut line IS R (a typed price is the line itself - the 2026-09-21 price-lens
  -- rule). NULL is not a refusal, it is "compute R from the market price".
  IF p_rounded_up_php IS NOT NULL AND p_rounded_up_php < 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_rounded_up',
      'message', 'The price you type has to be a whole number of pesos, at least 1 peso.');
  END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- (3) MARKET. Given, or THE ONE definition read for the AS-OF MONTH.
  -- ════════════════════════════════════════════════════════════════════════
  IF p_market_php_kg IS NOT NULL THEN
    IF p_market_php_kg = 'NaN'::numeric OR p_market_php_kg = 'Infinity'::numeric
       OR p_market_php_kg = '-Infinity'::numeric OR p_market_php_kg <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_market_price',
        'message', 'The market price has to be a real amount above zero - a price of zero would put every block above market.');
    END IF;
    v_market       := p_market_php_kg;
    v_market_basis := 'given';
    v_market_month := NULL;
  ELSE
    -- `this_month`, for the month the BLEND belongs to. A saved version is compared with
    -- the market of the month it was saved in, never with today's - the whole point of
    -- an as-of. The statistic itself is view_analytics_rcin_monthly.market_avg_price,
    -- the same column fn_blocking_market_bases reads, so there is no second definition.
    v_market_basis := 'as_of_month';
    v_market_month := date_trunc('month', v_as_of)::date;
    SELECT NULLIF(v.market_avg_price, 0) INTO v_market
    FROM public.view_analytics_rcin_monthly v WHERE v.month_start = v_market_month;
  END IF;

  IF v_market IS NULL THEN
    -- NULL market, never 0: a lens built on zero would call every block above market.
    v_vs_market  := NULL;
    v_vs_unavail := jsonb_build_object(
      'reason', 'no_market_price',
      'message', format('No market price for %s yet, so this blend cannot be compared with market. Type one in instead.',
                        to_char(v_market_month, 'FMMonth YYYY')),
      'market_basis', v_market_basis, 'market_basis_month', v_market_month);
    v_r := NULL;
  ELSE
    v_r := COALESCE(p_rounded_up_php::numeric, floor(v_market) + 1);
  END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- (4) THE BLOCK ROWS, ONCE — the snapshot's own figures plus the age fold.
  -- ════════════════════════════════════════════════════════════════════════
  WITH blk AS (
    SELECT b ->> 'batch_id'   AS batch_id,
           b ->> 'block_loc'  AS block_loc,
           b ->> 'batch_code' AS batch_code,
           b ->> 'status'     AS status,
           COALESCE((b ->> 'balance')::numeric, 0) AS kg,
           (b ->> 'php_kg')::numeric  AS php_kg,
           (b ->> 'mc')::numeric      AS mc,
           (b ->> 'ash')::numeric     AS ash,
           (b ->> 'bd_astm')::numeric AS bd_astm,
           (b ->> 'bd_jis')::numeric  AS bd_jis,
           (b ->> 'grit')::numeric    AS grit,
           (b ->> 'vm')::numeric      AS vm,
           (b ->> 'fc')::numeric      AS fc
    FROM jsonb_array_elements(v_snapshot -> 'blocks') AS b
  ),
  del AS (
    -- view_batch_age_days' own expression, narrowed to the as-of date.
    SELECT d.batch_code,
           sum(d.weight_kg * (d.transaction_date - '2000-01-01'::date)::numeric)
             / NULLIF(sum(d.weight_kg), 0::numeric) AS mean_daynum,
           min(d.transaction_date) AS first_date,
           max(d.transaction_date) AS last_date,
           count(*)::int           AS delivery_count
    FROM public.deliveries d
    WHERE d.transaction_date IS NOT NULL
      AND d.batch_code IS NOT NULL
      AND d.transaction_date <= v_as_of
      AND d.batch_code IN (SELECT blk.batch_code FROM blk WHERE blk.batch_code IS NOT NULL)
    GROUP BY d.batch_code
  )
  SELECT jsonb_agg(jsonb_build_object(
           'batch_id', blk.batch_id, 'block_loc', blk.block_loc,
           'batch_code', blk.batch_code, 'status', blk.status,
           'kg', blk.kg, 'php_kg', blk.php_kg,
           'mc', blk.mc, 'ash', blk.ash, 'bd_astm', blk.bd_astm, 'bd_jis', blk.bd_jis,
           'grit', blk.grit, 'vm', blk.vm, 'fc', blk.fc,
           -- NULL (never 0) when the batch has no delivery at or before the as-of date.
           'age_days', ((v_as_of - '2000-01-01'::date)::numeric - del.mean_daynum),
           'first_delivery_date', del.first_date,
           'last_delivery_date',  del.last_date,
           'delivery_count', COALESCE(del.delivery_count, 0))
         ORDER BY blk.block_loc)
    INTO v_rows
  FROM blk LEFT JOIN del ON del.batch_code = blk.batch_code;

  SELECT count(*)::int, COALESCE(sum((r ->> 'kg')::numeric), 0)
    INTO v_block_count, v_total_kg
  FROM jsonb_array_elements(v_rows) AS r;

  -- ════════════════════════════════════════════════════════════════════════
  -- (5) PRICE — the natural grouping, then the market comparison.
  -- ════════════════════════════════════════════════════════════════════════
  SELECT public.fn_natural_breaks_3(
           array_agg((r ->> 'php_kg')::numeric ORDER BY r ->> 'block_loc'),
           array_agg((r ->> 'kg')::numeric     ORDER BY r ->> 'block_loc'))
    INTO v_nb
  FROM jsonb_array_elements(v_rows) AS r
  WHERE (r ->> 'php_kg') IS NOT NULL AND (r ->> 'php_kg')::numeric > 0
    AND (r ->> 'kg')::numeric > 0;

  v_nb := COALESCE(v_nb, public.fn_natural_breaks_3(ARRAY[]::numeric[]));

  WITH src AS (
    SELECT r ->> 'batch_id' AS batch_id, r ->> 'block_loc' AS block_loc,
           r ->> 'batch_code' AS batch_code,
           (r ->> 'kg')::numeric AS kg, (r ->> 'php_kg')::numeric AS val
    FROM jsonb_array_elements(v_rows) AS r
  ),
  split AS (
    SELECT src.*,
           (src.val IS NOT NULL AND src.val > 0 AND src.kg > 0) AS measured
    FROM src
  ),
  cuts AS (SELECT (c ->> 'above')::numeric AS above FROM jsonb_array_elements(v_nb -> 'cuts') AS c),
  asg AS (
    SELECT s.*, (SELECT count(*)::int FROM cuts WHERE s.val >= cuts.above) AS gi
    FROM split s WHERE s.measured
  ),
  den AS (SELECT count(*)::int AS bc, COALESCE(sum(kg), 0) AS kg FROM split WHERE measured),
  g AS (
    SELECT (gg ->> 'index')::int AS gi, gg ->> 'label' AS label,
           (gg ->> 'range_min')::numeric AS rmin, (gg ->> 'range_max')::numeric AS rmax
    FROM jsonb_array_elements(v_nb -> 'groups') AS gg
  ),
  gagg AS (
    SELECT g.gi, g.label, g.rmin, g.rmax,
           count(a.block_loc)::int AS bc,
           COALESCE(sum(a.kg), 0) AS kg,
           sum(a.kg * a.val) / NULLIF(sum(a.kg), 0) AS wtd,
           COALESCE(sum(a.kg * a.val), 0) AS value_php,
           COALESCE(jsonb_agg(jsonb_build_object(
                      'batch_id', a.batch_id, 'block_loc', a.block_loc,
                      'batch_code', a.batch_code, 'kg', a.kg, 'php_kg', a.val)
                    ORDER BY a.val DESC, a.block_loc)
                    FILTER (WHERE a.block_loc IS NOT NULL), '[]'::jsonb) AS blocks
    FROM g LEFT JOIN asg a ON a.gi = g.gi
    GROUP BY g.gi, g.label, g.rmin, g.rmax
  ),
  unm AS (
    SELECT count(*)::int AS bc, COALESCE(sum(kg), 0) AS kg,
           count(*) FILTER (WHERE val IS NULL OR val <= 0)::int AS no_value,
           count(*) FILTER (WHERE val IS NOT NULL AND val > 0 AND kg <= 0)::int AS no_weight,
           COALESCE(jsonb_agg(jsonb_build_object(
                      'batch_id', batch_id, 'block_loc', block_loc,
                      'batch_code', batch_code, 'kg', kg)
                    ORDER BY block_loc), '[]'::jsonb) AS blocks
    FROM split WHERE NOT measured
  )
  SELECT jsonb_build_object(
    'metric', 'php_kg',
    'group_count', v_nb -> 'group_count',
    'gvf',   v_nb -> 'gvf',
    'cuts',  v_nb -> 'cuts',
    'stats', jsonb_build_object(
       'n', v_nb -> 'n', 'distinct_count', v_nb -> 'distinct_count',
       'total_weight', v_nb -> 'total_weight', 'weighted_mean', v_nb -> 'weighted_mean',
       'total_ss', v_nb -> 'total_ss', 'within_ss', v_nb -> 'within_ss',
       'between_ss', v_nb -> 'between_ss',
       'candidates_considered', v_nb -> 'candidates_considered'),
    'groups', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
                'index', gagg.gi, 'label', gagg.label,
                'range_min', gagg.rmin, 'range_max', gagg.rmax,
                'block_count', gagg.bc, 'kg', gagg.kg,
                'kg_share_pct',    CASE WHEN den.kg > 0 THEN gagg.kg * 100.0 / den.kg END,
                'block_share_pct', CASE WHEN den.bc > 0 THEN gagg.bc * 100.0 / den.bc END,
                'kg_weighted_php_kg', gagg.wtd, 'value_php', gagg.value_php,
                'blocks', gagg.blocks)
              ORDER BY gagg.gi)
       FROM gagg, den), '[]'::jsonb),
    'unmeasured', (SELECT jsonb_build_object(
       'block_count', unm.bc, 'kg', unm.kg,
       'no_value_count', unm.no_value, 'no_weight_count', unm.no_weight,
       'blocks', unm.blocks) FROM unm),
    'overall', (SELECT jsonb_build_object(
       'block_count', den.bc, 'kg', den.kg,
       'kg_weighted_php_kg', (SELECT sum(kg * val) / NULLIF(sum(kg), 0) FROM split WHERE measured),
       'value_php', (SELECT COALESCE(sum(kg * val), 0) FROM split WHERE measured),
       -- The blend's OWN raw price, lifted verbatim from the snapshot, never recomputed.
       -- The gap is 0 whenever nothing is unmeasured; when something IS, the snapshot's
       -- figure is dragged down by an L-008 zero and this one is the honest number.
       'snapshot_php_kg', (v_snapshot ->> 'raw_price_per_kg')::numeric,
       'snapshot_gap', (SELECT sum(kg * val) / NULLIF(sum(kg), 0) FROM split WHERE measured)
                       - (v_snapshot ->> 'raw_price_per_kg')::numeric,
       'equals_snapshot', ((SELECT sum(kg * val) / NULLIF(sum(kg), 0) FROM split WHERE measured)
                       - (v_snapshot ->> 'raw_price_per_kg')::numeric) = 0
     ) FROM den)
  ) INTO v_price;

  -- ── vs_market: the PRICE LENS's logic, applied to THIS blend's blocks.
  IF v_market IS NOT NULL THEN
    WITH off AS (
      SELECT o, row_number() OVER (ORDER BY o)::int AS i FROM unnest(v_price_edges) AS o
    ),
    k AS (SELECT count(*)::int AS n FROM off),
    bands AS (
      -- k edges -> k+1 half-open [lower, upper) bands, the first open below and the last
      -- open above. NULL means OPEN, never zero. Lifted from fn_blocking_price_lens.
      SELECT gs.i AS band_index,
             (SELECT v_r + off.o FROM off WHERE off.i = gs.i)     AS lower_php,
             (SELECT v_r + off.o FROM off WHERE off.i = gs.i + 1) AS upper_php
      FROM k, generate_series(0, k.n) AS gs(i)
    ),
    src AS (
      SELECT r ->> 'batch_id' AS batch_id, r ->> 'block_loc' AS block_loc,
             r ->> 'batch_code' AS batch_code,
             (r ->> 'kg')::numeric AS kg, (r ->> 'php_kg')::numeric AS val,
             ((r ->> 'php_kg') IS NOT NULL AND (r ->> 'php_kg')::numeric > 0
              AND (r ->> 'kg')::numeric > 0) AS measured
      FROM jsonb_array_elements(v_rows) AS r
    ),
    asg AS (
      SELECT src.*, (SELECT max(bd.band_index) FROM bands bd
                       WHERE bd.lower_php IS NULL OR src.val >= bd.lower_php) AS bi
      FROM src WHERE src.measured
    ),
    den AS (SELECT count(*)::int AS bc, COALESCE(sum(kg), 0) AS kg FROM src WHERE measured),
    bagg AS (
      SELECT bd.band_index, bd.lower_php, bd.upper_php,
             count(a.block_loc)::int AS bc,
             COALESCE(sum(a.kg), 0) AS kg,
             sum(a.kg * a.val) / NULLIF(sum(a.kg), 0) AS wtd,
             COALESCE(sum(a.kg * a.val), 0) AS value_php,
             COALESCE(jsonb_agg(jsonb_build_object(
                        'batch_id', a.batch_id, 'block_loc', a.block_loc,
                        'batch_code', a.batch_code, 'kg', a.kg, 'php_kg', a.val)
                      ORDER BY a.val DESC, a.block_loc)
                      FILTER (WHERE a.block_loc IS NOT NULL), '[]'::jsonb) AS blocks
      FROM bands bd LEFT JOIN asg a ON a.bi = bd.band_index
      GROUP BY bd.band_index, bd.lower_php, bd.upper_php
    ),
    unm AS (
      SELECT count(*)::int AS bc, COALESCE(sum(kg), 0) AS kg,
             COALESCE(jsonb_agg(jsonb_build_object(
                        'batch_id', batch_id, 'block_loc', block_loc,
                        'batch_code', batch_code, 'kg', kg) ORDER BY block_loc), '[]'::jsonb) AS blocks
      FROM src WHERE NOT measured
    )
    SELECT jsonb_build_object(
      'market_php_kg', v_market,
      'market_basis', v_market_basis,
      'market_basis_month', v_market_month,
      'rounded_up_php', v_r,
      'edge_offsets', to_jsonb(v_price_edges),
      'bands', COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
                  'index', bagg.band_index,
                  'lower_php', bagg.lower_php, 'upper_php', bagg.upper_php,
                  'block_count', bagg.bc, 'kg', bagg.kg,
                  'kg_share_pct',    CASE WHEN den.kg > 0 THEN bagg.kg * 100.0 / den.kg END,
                  'block_share_pct', CASE WHEN den.bc > 0 THEN bagg.bc * 100.0 / den.bc END,
                  'kg_weighted_php_kg', bagg.wtd, 'value_php', bagg.value_php,
                  'blocks', bagg.blocks)
                ORDER BY bagg.band_index)
         FROM bagg, den), '[]'::jsonb),
      'unmeasured', (SELECT jsonb_build_object(
         'block_count', unm.bc, 'kg', unm.kg, 'blocks', unm.blocks) FROM unm),
      'overall', (SELECT jsonb_build_object(
         'block_count', den.bc, 'kg', den.kg,
         'kg_weighted_php_kg', (SELECT sum(kg * val) / NULLIF(sum(kg), 0) FROM src WHERE measured),
         'value_php', (SELECT COALESCE(sum(kg * val), 0) FROM src WHERE measured)) FROM den)
    ) INTO v_vs_market;
  END IF;

  -- `vs_market` is NULL (json null) when market could not be measured, and the REASON
  -- rides beside it in `vs_market_unavailable` — a null cannot carry one.
  v_price := jsonb_build_object('natural', v_price,
                                'vs_market', v_vs_market,
                                'vs_market_unavailable', v_vs_unavail);

  -- ════════════════════════════════════════════════════════════════════════
  -- (6) QUALITY — the SAME natural grouping, once per lab metric. NO MONEY.
  --     `value` / `kg_weighted_value` is the metric's own READING (a moisture
  --     percentage, an ash percentage, a bulk density) - deliberately not a
  --     money-shaped key name, so a ₱ key-scan over this section finds nothing.
  -- ════════════════════════════════════════════════════════════════════════
  FOREACH v_metric IN ARRAY ARRAY['mc', 'ash', 'bd_astm', 'bd_jis'] LOOP
    SELECT public.fn_natural_breaks_3(
             array_agg((r ->> v_metric)::numeric ORDER BY r ->> 'block_loc'),
             array_agg((r ->> 'kg')::numeric     ORDER BY r ->> 'block_loc'))
      INTO v_nb
    FROM jsonb_array_elements(v_rows) AS r
    WHERE (r ->> v_metric) IS NOT NULL AND (r ->> v_metric)::numeric > 0
      AND (r ->> 'kg')::numeric > 0;

    v_nb := COALESCE(v_nb, public.fn_natural_breaks_3(ARRAY[]::numeric[]));

    WITH src AS (
      SELECT r ->> 'batch_id' AS batch_id, r ->> 'block_loc' AS block_loc,
             r ->> 'batch_code' AS batch_code,
             (r ->> 'kg')::numeric AS kg, (r ->> v_metric)::numeric AS val
      FROM jsonb_array_elements(v_rows) AS r
    ),
    split AS (
      SELECT src.*, (src.val IS NOT NULL AND src.val > 0 AND src.kg > 0) AS measured FROM src
    ),
    cuts AS (SELECT (c ->> 'above')::numeric AS above FROM jsonb_array_elements(v_nb -> 'cuts') AS c),
    asg AS (
      SELECT s.*, (SELECT count(*)::int FROM cuts WHERE s.val >= cuts.above) AS gi
      FROM split s WHERE s.measured
    ),
    den AS (SELECT count(*)::int AS bc, COALESCE(sum(kg), 0) AS kg FROM split WHERE measured),
    g AS (
      SELECT (gg ->> 'index')::int AS gi, gg ->> 'label' AS label,
             (gg ->> 'range_min')::numeric AS rmin, (gg ->> 'range_max')::numeric AS rmax
      FROM jsonb_array_elements(v_nb -> 'groups') AS gg
    ),
    gagg AS (
      SELECT g.gi, g.label, g.rmin, g.rmax,
             count(a.block_loc)::int AS bc,
             COALESCE(sum(a.kg), 0) AS kg,
             sum(a.kg * a.val) / NULLIF(sum(a.kg), 0) AS wtd,
             COALESCE(jsonb_agg(jsonb_build_object(
                        'batch_id', a.batch_id, 'block_loc', a.block_loc,
                        'batch_code', a.batch_code, 'kg', a.kg, 'value', a.val)
                      ORDER BY a.val DESC, a.block_loc)
                      FILTER (WHERE a.block_loc IS NOT NULL), '[]'::jsonb) AS blocks
      FROM g LEFT JOIN asg a ON a.gi = g.gi
      GROUP BY g.gi, g.label, g.rmin, g.rmax
    ),
    unm AS (
      SELECT count(*)::int AS bc, COALESCE(sum(kg), 0) AS kg,
             count(*) FILTER (WHERE val IS NULL OR val <= 0)::int AS no_value,
             count(*) FILTER (WHERE val IS NOT NULL AND val > 0 AND kg <= 0)::int AS no_weight,
             COALESCE(jsonb_agg(jsonb_build_object(
                        'batch_id', batch_id, 'block_loc', block_loc,
                        'batch_code', batch_code, 'kg', kg) ORDER BY block_loc), '[]'::jsonb) AS blocks
      FROM split WHERE NOT measured
    )
    SELECT jsonb_build_object(
      'metric', v_metric,
      'group_count', v_nb -> 'group_count',
      'gvf',   v_nb -> 'gvf',
      'cuts',  v_nb -> 'cuts',
      'stats', jsonb_build_object(
         'n', v_nb -> 'n', 'distinct_count', v_nb -> 'distinct_count',
         'total_weight', v_nb -> 'total_weight', 'weighted_mean', v_nb -> 'weighted_mean',
         'total_ss', v_nb -> 'total_ss', 'within_ss', v_nb -> 'within_ss',
         'between_ss', v_nb -> 'between_ss',
         'candidates_considered', v_nb -> 'candidates_considered'),
      'groups', COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
                  'index', gagg.gi, 'label', gagg.label,
                  'range_min', gagg.rmin, 'range_max', gagg.rmax,
                  'block_count', gagg.bc, 'kg', gagg.kg,
                  'kg_share_pct',    CASE WHEN den.kg > 0 THEN gagg.kg * 100.0 / den.kg END,
                  'block_share_pct', CASE WHEN den.bc > 0 THEN gagg.bc * 100.0 / den.bc END,
                  'kg_weighted_value', gagg.wtd,
                  'blocks', gagg.blocks)
                ORDER BY gagg.gi)
         FROM gagg, den), '[]'::jsonb),
      'unmeasured', (SELECT jsonb_build_object(
         'block_count', unm.bc, 'kg', unm.kg,
         'no_value_count', unm.no_value, 'no_weight_count', unm.no_weight,
         'blocks', unm.blocks) FROM unm),
      'overall', (SELECT jsonb_build_object(
         'block_count', den.bc, 'kg', den.kg,
         'kg_weighted_value', (SELECT sum(kg * val) / NULLIF(sum(kg), 0) FROM split WHERE measured),
         -- The blend's OWN weighted stat, lifted verbatim from the snapshot.
         'snapshot_value', (v_snapshot -> 'weighted' ->> v_metric)::numeric,
         'snapshot_gap', (SELECT sum(kg * val) / NULLIF(sum(kg), 0) FROM split WHERE measured)
                         - (v_snapshot -> 'weighted' ->> v_metric)::numeric,
         'equals_snapshot', ((SELECT sum(kg * val) / NULLIF(sum(kg), 0) FROM split WHERE measured)
                         - (v_snapshot -> 'weighted' ->> v_metric)::numeric) = 0
       ) FROM den)
    ) INTO v_section;

    v_quality := v_quality || jsonb_build_object(v_metric, v_section);
  END LOOP;

  v_quality := jsonb_build_object('metrics', to_jsonb(ARRAY['mc', 'ash', 'bd_astm', 'bd_jis'])) || v_quality;

  -- ════════════════════════════════════════════════════════════════════════
  -- (7) AGE — FIXED cut lines in days, the age lens's exact semantics. NO MONEY.
  --     Not natural breaks: 60 / 120 / 365 days are meaningful in themselves (the
  --     owner-approved defaults), and a grouping that moved with the yard would make
  --     "over a year old" mean something different on every proposal.
  --     WEIGHT IS THE BLOCK'S KILOGRAMS IN THE BLEND (the snapshot's balance).
  -- ════════════════════════════════════════════════════════════════════════
  WITH cut AS (
    SELECT e, row_number() OVER (ORDER BY e)::int AS i FROM unnest(v_age_edges) AS e
  ),
  k AS (SELECT count(*)::int AS n FROM cut),
  bands AS (
    -- Band 0's lower bound is the literal day 0 - age has a floor where money does not.
    SELECT gs.i AS band_index,
           CASE WHEN gs.i = 0 THEN 0 ELSE (SELECT cut.e FROM cut WHERE cut.i = gs.i) END AS lower_days,
           (SELECT cut.e FROM cut WHERE cut.i = gs.i + 1) AS upper_days
    FROM k, generate_series(0, k.n) AS gs(i)
  ),
  src AS (
    SELECT r ->> 'batch_id' AS batch_id, r ->> 'block_loc' AS block_loc,
           r ->> 'batch_code' AS batch_code,
           (r ->> 'kg')::numeric AS kg,
           (r ->> 'age_days')::numeric AS age_days,
           (r ->> 'first_delivery_date')::date AS first_date,
           (r ->> 'last_delivery_date')::date  AS last_date,
           (r ->> 'delivery_count')::int AS delivery_count
    FROM jsonb_array_elements(v_rows) AS r
  ),
  asg AS (
    -- HOW MANY CUT LINES HAS THIS AGE PASSED - total by construction, so a NEGATIVE age
    -- (a future-dated delivery) lands in band 0 instead of matching nothing.
    SELECT src.*, (SELECT count(*)::int FROM cut WHERE src.age_days >= cut.e) AS bi
    FROM src WHERE src.age_days IS NOT NULL
  ),
  den AS (SELECT count(*)::int AS bc, COALESCE(sum(kg), 0) AS kg,
                 sum(kg * age_days) / NULLIF(sum(kg), 0) AS wtd
            FROM asg),
  oldest AS (SELECT batch_code, block_loc, age_days FROM asg
              ORDER BY age_days DESC, block_loc ASC LIMIT 1),
  bagg AS (
    SELECT bd.band_index, bd.lower_days, bd.upper_days,
           count(a.block_loc)::int AS bc,
           COALESCE(sum(a.kg), 0) AS kg,
           sum(a.kg * a.age_days) / NULLIF(sum(a.kg), 0) AS wtd,
           COALESCE(jsonb_agg(jsonb_build_object(
                      'batch_id', a.batch_id, 'block_loc', a.block_loc,
                      'batch_code', a.batch_code, 'kg', a.kg, 'age_days', a.age_days,
                      'first_delivery_date', a.first_date, 'last_delivery_date', a.last_date,
                      'delivery_count', a.delivery_count)
                    ORDER BY a.age_days DESC, a.block_loc)
                    FILTER (WHERE a.block_loc IS NOT NULL), '[]'::jsonb) AS blocks
    FROM bands bd LEFT JOIN asg a ON a.bi = bd.band_index
    GROUP BY bd.band_index, bd.lower_days, bd.upper_days
  ),
  und AS (
    SELECT count(*)::int AS bc, COALESCE(sum(kg), 0) AS kg,
           COALESCE(jsonb_agg(jsonb_build_object(
                      'batch_id', batch_id, 'block_loc', block_loc,
                      'batch_code', batch_code, 'kg', kg) ORDER BY block_loc), '[]'::jsonb) AS blocks
    FROM src WHERE age_days IS NULL
  )
  SELECT jsonb_build_object(
    'as_of', v_as_of,
    'edge_days', to_jsonb(v_age_edges),
    'bands', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
                'index', bagg.band_index,
                'lower_days', bagg.lower_days, 'upper_days', bagg.upper_days,
                'block_count', bagg.bc, 'kg', bagg.kg,
                'kg_share_pct',    CASE WHEN den.kg > 0 THEN bagg.kg * 100.0 / den.kg END,
                'block_share_pct', CASE WHEN den.bc > 0 THEN bagg.bc * 100.0 / den.bc END,
                'kg_weighted_age_days', bagg.wtd,
                'blocks', bagg.blocks)
              ORDER BY bagg.band_index)
       FROM bagg, den), '[]'::jsonb),
    'undated', (SELECT jsonb_build_object(
       'block_count', und.bc, 'kg', und.kg, 'blocks', und.blocks) FROM und),
    'overall', (SELECT jsonb_build_object(
       'block_count', den.bc, 'kg', den.kg,
       'kg_weighted_age_days', den.wtd,
       'oldest_age_days',  (SELECT o.age_days   FROM oldest o),
       'oldest_block_loc', (SELECT o.block_loc  FROM oldest o),
       'oldest_batch_code',(SELECT o.batch_code FROM oldest o)) FROM den)
  ) INTO v_age;

  -- ════════════════════════════════════════════════════════════════════════
  -- (8) THE PAYLOAD
  -- ════════════════════════════════════════════════════════════════════════
  RETURN jsonb_build_object(
    'ok', true,
    'source', v_source,
    'as_of', v_as_of,
    'proposal_id', p_proposal_id,
    'version_no', v_version_no,
    'title', v_title,
    'snapshot_computed_at', v_snapshot ->> 'computed_at',
    'computed_at', now(),
    'block_count', v_block_count,
    'total_kg', v_total_kg,
    'sections', jsonb_build_object('price', v_price, 'quality', v_quality, 'age', v_age));
END;
$$;

COMMENT ON FUNCTION public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int) IS
'The Blend Proposal ANALYSIS payload for one blend, in THREE sections - price, quality and age - for the extra viewer/print pages on the Blocking page. EXACTLY ONE SOURCE: p_proposal_id (+ optional p_version_no, default the proposal''s current version) reads the STORED blend_proposal_versions.snapshot VERBATIM and never recomputes a lab or price figure, because a proposal is a statement about the yard ON A PARTICULAR DAY and its snapshot is immutable and hashed; or p_block_locs builds the same rows from fn_blend_proposal_snapshot(), the ONE existing builder. Reading an ARCHIVED proposal is deliberately allowed - only WRITING to one is refused. THE AS-OF DATE is the Asia/Manila calendar date of the version''s own created_at (saved) or today in Asia/Manila (live), and it governs the AGE section: only deliveries dated on or before it count, so a delivery that lands later can never repaint an old proposal. GROUPING IS WEIGHTED NATURAL BREAKS (fn_natural_breaks_3, k = 3, labels low/mid/high), kg-weighted, chosen over mean +/- 1 SD because that was measured on the owner''s own proposal and found to file a PHP 39 block and a PHP 48 block together as "average"; each section publishes its cut lines and its gvf (1 - within_ss / total_ss, NULL when there is no variance) so a print can say how clean the split is. AGE USES FIXED CUT LINES IN DAYS instead (default 60/120/365, the age lens''s exact semantics including "how many cut lines has this age passed", so a NEGATIVE age lands in band 0), because those days are meaningful in themselves and a grouping that moved with the yard would make "over a year old" mean something different on every proposal; its weight is the block''s KILOGRAMS IN THE BLEND. AGE IS NOT REDEFINED: it is view_batch_age_days'' own kg-weighted-mean-delivery-date expression narrowed to the as-of date, and at as_of = today it equals that view exactly. NULL IS NEVER 0: a metric value that is NULL or <= 0 is the NOT-RECORDED placeholder (php_kg 0 is the L-008 unpriced placeholder; view_blocking_grid COALESCEs avg_ash / avg_bd_astm / avg_bd_jis to 0 and 11 of 170 occupied blocks read exactly 0 on all three), so such a block lands in `unmeasured`, in NO group, out of every average and every share denominator - as does a block with no positive weight, counted separately. Therefore in every section the group kilograms plus the unmeasured kilograms equal total_kg, and each share family sums to 100 over the measured population. Every business refusal is jsonb {ok:false, reason, message} written for a human, never a raise: both_sources, no_source, unknown_proposal, unknown_version, no_blocks, too_many_blocks, unknown_block_loc, invalid_price_edge / no_price_edges / too_many_price_edges, invalid_age_edge / no_age_edges / too_many_age_edges, invalid_rounded_up, invalid_market_price. MONEY LIVES IN sections.price ONLY - the group PHP/kg, the band edges, Sum kg*PHP, and BAND MEMBERSHIP ITSELF - and NOT ONE key matching php|peso|cost|price|value_php|amount exists in sections.quality or sections.age, so fetchBlendAnalysis DELETES sections.price for a canViewPrices()-denied caller and still returns quality and age to Production. That is the opposite of fn_blocking_price_lens, whose whole payload is price and whose action refuses such a caller outright. STABLE, SECURITY INVOKER; authenticated only, anon and PUBLIC revoked, service_role deliberately not granted (no sync worker calls it).';


-- ═════════════════════════════════════════════════════════════════════════════
-- §3  Posture
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.fn_natural_breaks_3(numeric[], numeric[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_natural_breaks_3(numeric[], numeric[]) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_natural_breaks_3(numeric[], numeric[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §4  fn_blocking_price_lens gains kg_weighted_php_kg — ADDITIVE KEYS ONLY
--
-- The lens already says how many blocks and how many kilograms are in each band; it
-- could not say what those kilograms COST, so a lens print had to re-weight the band in
-- TypeScript, which CLAUDE.md forbids. One key per band and one on `total`.
--
-- `total.kg_weighted_php_kg` IS WEIGHTED OVER THE PRICED POPULATION, not over
-- `total.block_count` / `total.kg`, and the asymmetry is deliberate: an unpriced block's
-- PHP 0 is the L-008 placeholder, so averaging it in would drag the figure down exactly
-- as `batches.avg_cost` once read PHP 11.01 against a real PHP 39.99. The counts still
-- cover every block, because they are a count of the yard; the price is a price of what
-- is priced - the same population the two share denominators already use.
--
-- SIGNATURE UNCHANGED, so this is a CREATE OR REPLACE and the grants survive - but they
-- are re-stated anyway, because a ₱-bearing function silently losing its posture is
-- the shape of the L-043/L-044 incidents. The COMMENT is re-applied verbatim plus one
-- paragraph, since CREATE OR REPLACE keeps it but a reader should find it in this file.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blocking_price_lens(
  p_market_php_kg  numeric,
  p_edge_offsets   int[] DEFAULT ARRAY[-1, 0],
  p_rounded_up_php int   DEFAULT NULL
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

  -- A GIVEN cut line has to be a whole peso of at least 1. NULL is not a refusal — it
  -- is the "no override, compute R from the market price" signal, which is why this
  -- guard tests `IS NOT NULL` first. A fractional value is NOT detectable here (the
  -- parameter is `int`, so Postgres rounded it already) and is enforced in the server
  -- action under this same `invalid_rounded_up` reason.
  IF p_rounded_up_php IS NOT NULL AND p_rounded_up_php < 1 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_rounded_up',
      'message', 'The price you type has to be a whole number of pesos, at least ₱1.');
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

  -- ── R. A GIVEN cut line IS R — a typed price is the line itself (see migration
  -- 20260921034512 §4). Otherwise the measured rule, written down exactly once: see the
  -- header of migration 20260919025729 for why it rounds up even on a whole number.
  IF p_rounded_up_php IS NOT NULL THEN
    v_r := p_rounded_up_php::numeric;
  ELSE
    v_r := floor(p_market_php_kg) + 1;
  END IF;

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
           b.avg_php_kg,
           (SELECT max(bd.band_index) FROM bands bd
             WHERE bd.lower_php IS NULL OR b.avg_php_kg >= bd.lower_php) AS band_index
    FROM blk b
    WHERE NOT b.unpriced
  ),
  tot    AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg FROM blk),
  unp    AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg FROM blk WHERE unpriced),
  priced AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg,
                    sum(kg * avg_php_kg) / NULLIF(sum(kg), 0) AS wtd_php
               FROM blk WHERE NOT unpriced),
  band_rows AS (
    SELECT bd.band_index, bd.lower_php, bd.upper_php,
           count(c.block_loc)::int      AS block_count,
           COALESCE(sum(c.kg), 0)       AS kg,
           -- ADDED 2026-09-21. NULL, never 0, on an empty band: no charcoal in the band
           -- means no price in the band.
           sum(c.kg * c.avg_php_kg) / NULLIF(sum(c.kg), 0) AS wtd_php
    FROM bands bd
    LEFT JOIN classified c ON c.band_index = bd.band_index
    GROUP BY bd.band_index, bd.lower_php, bd.upper_php
  )
  SELECT jsonb_build_object(
    'ok', true,
    'market_php_kg', p_market_php_kg,
    -- R, whether it was GIVEN or computed. No new key says which: the payload must stay
    -- byte-identical to the pre-override one when no override is passed.
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
                                       THEN br.block_count * 100.0 / p.block_count END,
               'kg_weighted_php_kg', br.wtd_php)
             ORDER BY br.band_index)
      FROM band_rows br, priced p), '[]'::jsonb),
    'blocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('block_loc', c.block_loc, 'band_index', c.band_index)
             ORDER BY c.block_loc)
      FROM classified c), '[]'::jsonb),
    'unpriced', (SELECT jsonb_build_object('block_count', u.block_count, 'kg', u.kg) FROM unp u),
    -- `block_count` and `kg` cover EVERY occupied block; `kg_weighted_php_kg` is
    -- weighted over the PRICED ones only. See §4 of migration 20260921084500.
    'total',    (SELECT jsonb_build_object('block_count', t.block_count, 'kg', t.kg,
                          'kg_weighted_php_kg', (SELECT p.wtd_php FROM priced p))
                   FROM tot t)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) IS
'Classify every occupied Blocking block against a GIVEN market PHP/kg, for the Blocking page price lens. It takes the market price as an argument on purpose, so the four computed bases from fn_blocking_market_bases and a manually typed price share ONE classifier. R = floor(market) + 1 (40.23 -> 41, 39.8568 -> 40, and 40.00 -> 41 so the market price itself stays inside the at-market band). A TYPED PRICE IS THE LINE ITSELF, so p_rounded_up_php (2026-09-21) OVERRIDES R when given: the operator who types PHP 41 means PHP 41 and up is above market, and the measured rule would have given them 42. It must be a whole number of at least 1 (refusal invalid_rounded_up); NULL is not a refusal, it is the "compute R from the market price" signal, and with NULL the payload is BYTE-IDENTICAL to the pre-override function. THE UI RULE: for the manual basis pass ceil(typed price); for every measured basis pass nothing. p_edge_offsets is a list of whole-peso offsets from R, de-duplicated and sorted; k edges give k+1 half-open [lower, upper) bands with the first open below (lower_php null) and the last open above (upper_php null); default ARRAY[-1,0] gives below / at market / above market. EACH BAND AND THE TOTAL ALSO CARRY kg_weighted_php_kg (added 2026-09-21 so a lens print does not have to re-weight a band in TypeScript): NULL, never 0, on an empty band, and on `total` it is weighted over the PRICED population only while total.block_count / total.kg still count every occupied block - an unpriced block''s PHP 0 is the L-008 placeholder and averaging it in would drag the figure down the way batches.avg_cost once read PHP 11.01 against a real PHP 39.99. The per-block price is view_blocking_grid.avg_php_kg, the same column the cell displays — never a second definition. A block with NO price (null or 0, the L-008 unpriced placeholder — NULL is never PHP 0) lands in "unpriced", in no band, and is excluded from both share denominators, so sum of band counts plus unpriced equals total and each share family sums to 100 over the priced population. Every business refusal is jsonb {ok:false, reason, message} written for a human, never a raise: no_market_price, invalid_market_price, invalid_rounded_up, invalid_edge, no_edges, too_many_edges. CARRIES MONEY EVEN WHERE IT LOOKS LIKE IT DOES NOT — band membership alone pins a block''s PHP/kg to within a peso, so there is no price-free half of this payload: the server action refuses a canViewPrices()-denied caller BEFORE calling rather than nulling fields after. authenticated only; anon revoked; service_role deliberately not granted.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §5  fn_blend_analysis_probe — the ACCESS BRIDGE for the verify script
--
-- NOT a "verify everything" function, and the distinction is the 2026-09-14 incident:
-- `fn_ops_ledger_verify()` cross-checked every ops-ledger view over the whole of history
-- in ONE statement, OOM-ed the instance and took the live site down. THIS PROBE ASSERTS
-- NOTHING. It calls fn_blend_analysis a fixed number of times ON ONE NAMED VERSION,
-- reads three bounded relations INDEPENDENTLY of it, and hands everything back so every
-- assertion lives in scripts/verify-blend-analysis.ts where a human can read it.
--
-- It exists only because fn_blend_analysis is `authenticated`-only BY DESIGN and no
-- verify script in this repo holds a user JWT — the same reason
-- fn_blocking_price_lens_probe / fn_blocking_age_lens_probe / fn_blend_block_facts_probe
-- exist, and the same SECURITY DEFINER + service_role-only shape. ALL THREE OF THOSE ARE
-- UNTOUCHED by this migration. Note also that `service_role` holds NOTHING on
-- blend_proposals / blend_proposal_versions, so the saved path is reachable from a verify
-- script ONLY through a definer function.
--
-- ONE VERSION PER CALL, and that is structural: `p_proposal_id` + `p_version_no` are
-- required, so it is impossible to point this probe at every saved version at once.
--
-- What each independent read is FOR:
--   saved / live        the two sources over the same blocks - the as-of proof's two sides.
--   snapshot_weighted   the version's OWN stored weighted stats + raw price, so the
--                       `overall` footers are an AGREEMENT rather than a tautology.
--   age_view_rows       view_batch_age_days' age_days per batch_code, so the age half is
--                       proven against THE age definition rather than against itself.
--   lens                fn_blocking_price_lens on the same market / R / edges, so the
--                       vs_market classification is proven against the lens that owns it.
--   nb_cases            the hand-checkable natural-breaks unit cases, run in SQL.
--   refusals            every jsonb refusal, exercised.
--   posture             the catalog, as a second witness to the real role calls.
--
-- IT RETURNS ₱ (the analysis payload's price section is money) and is therefore
-- service_role-only, never authenticated, never anon.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blend_analysis_probe(
  p_proposal_id uuid,
  p_version_no  int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot jsonb;
  v_as_of    date;
  v_locs     text[];
  v_codes    text[];
  v_saved    jsonb;
  v_market   numeric;
  v_r        numeric;
BEGIN
  SELECT bv.snapshot, (bv.created_at AT TIME ZONE 'Asia/Manila')::date
    INTO v_snapshot, v_as_of
  FROM public.blend_proposal_versions bv
  WHERE bv.proposal_id = p_proposal_id AND bv.version_no = p_version_no;

  IF v_snapshot IS NULL THEN
    RETURN jsonb_build_object('found', false, 'proposal_id', p_proposal_id, 'version_no', p_version_no);
  END IF;

  SELECT array_agg(b ->> 'block_loc'), array_agg(b ->> 'batch_code')
    INTO v_locs, v_codes
  FROM jsonb_array_elements(v_snapshot -> 'blocks') AS b;

  v_saved := public.fn_blend_analysis(p_proposal_id, p_version_no);

  -- The market the SAVED analysis used, re-read here independently, so the lens can be
  -- pointed at the same number.
  v_market := (v_saved #>> ARRAY['sections','price','vs_market','market_php_kg'])::numeric;
  v_r      := (v_saved #>> ARRAY['sections','price','vs_market','rounded_up_php'])::numeric;

  RETURN jsonb_build_object(
    'found', true,
    'manila_today', (now() AT TIME ZONE 'Asia/Manila')::date,
    'as_of', v_as_of,
    'block_locs', to_jsonb(v_locs),

    'saved', v_saved,
    -- The SAME blocks, live. Its as_of is today, so every difference between the two is
    -- the as-of rule doing its job.
    'live', public.fn_blend_analysis(NULL, NULL, v_locs),
    -- Called twice: identical output is what makes the natural-breaks tie-break a
    -- contract rather than a hope.
    'saved_again', public.fn_blend_analysis(p_proposal_id, p_version_no),

    'snapshot_weighted', v_snapshot -> 'weighted',
    'snapshot_raw_price', (v_snapshot ->> 'raw_price_per_kg')::numeric,
    'snapshot_blocks', v_snapshot -> 'blocks',

    -- fn_blend_proposal, called DIRECTLY over the same block_locs: the ONE definition the
    -- live analysis must agree with, read here so the agreement is not a tautology.
    'blend_proposal_direct', (
      SELECT to_jsonb(p) FROM public.fn_blend_proposal(v_locs) p),

    -- THE age definition, read independently.
    'age_view_rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'batch_code', a.batch_code, 'as_of_date', a.as_of_date,
               'age_days', a.age_days,
               'first_delivery_date', a.first_delivery_date,
               'last_delivery_date', a.last_delivery_date)
             ORDER BY a.batch_code)
      FROM public.view_batch_age_days a
      WHERE a.batch_code = ANY (v_codes)), '[]'::jsonb),

    -- Deliveries AFTER the as-of date, among the blend's batches: the precondition that
    -- makes the as-of narrowing provable on live data. 0 means the script must say so
    -- out loud rather than pass vacuously.
    'deliveries_after_as_of', (
      SELECT jsonb_build_object(
          'row_count', count(*)::int,
          'batch_codes', COALESCE(jsonb_agg(DISTINCT d.batch_code), '[]'::jsonb))
      FROM public.deliveries d
      WHERE d.batch_code = ANY (v_codes) AND d.transaction_date > v_as_of),

    -- THE lens that owns "above market", on the same market price, R and edges.
    'lens', CASE WHEN v_market IS NOT NULL
                 THEN public.fn_blocking_price_lens(v_market, ARRAY[-1, 0], v_r::int) END,
    -- ...and the live grid's own price per block, so the lens comparison is not circular.
    'grid_prices', COALESCE((
      SELECT jsonb_object_agg(g.block_loc, g.avg_php_kg)
      FROM public.view_blocking_grid g WHERE g.block_loc = ANY (v_locs)), '{}'::jsonb),

    -- The hand-checkable unit cases, in SQL.
    'nb_cases', jsonb_build_object(
      'classic',       public.fn_natural_breaks_3(ARRAY[1,2,3,10,11,12,20,21,22]::numeric[]),
      'equal_four',    public.fn_natural_breaks_3(ARRAY[1,2,3,4]::numeric[], ARRAY[1,1,1,1]::numeric[]),
      'heavy_top',     public.fn_natural_breaks_3(ARRAY[1,2,3,4]::numeric[], ARRAY[1,1,1,10]::numeric[]),
      'two_distinct',  public.fn_natural_breaks_3(ARRAY[5,5,9,9]::numeric[]),
      'one_distinct',  public.fn_natural_breaks_3(ARRAY[7,7,7]::numeric[]),
      'all_null',      public.fn_natural_breaks_3(ARRAY[NULL,NULL]::numeric[]),
      'null_array',    public.fn_natural_breaks_3(NULL::numeric[]),
      'zero_weight',   public.fn_natural_breaks_3(ARRAY[1,2,3]::numeric[], ARRAY[1,0,1]::numeric[]),
      'nan_value',     public.fn_natural_breaks_3(ARRAY['NaN'::numeric,1,2,3]),
      'length_mismatch', public.fn_natural_breaks_3(ARRAY[1,2]::numeric[], ARRAY[1]::numeric[]),
      'too_many',      public.fn_natural_breaks_3((SELECT array_agg(g.i::numeric) FROM generate_series(1,1001) AS g(i)))
    ),

    'refusals', jsonb_build_object(
      'both_sources',        public.fn_blend_analysis(p_proposal_id, p_version_no, v_locs),
      'no_source',           public.fn_blend_analysis(),
      'version_no_alone',    public.fn_blend_analysis(NULL, 2),
      'unknown_proposal',    public.fn_blend_analysis('00000000-0000-0000-0000-000000000000'::uuid, 1),
      'unknown_version',     public.fn_blend_analysis(p_proposal_id, 9999),
      'no_blocks',           public.fn_blend_analysis(NULL, NULL, ARRAY[]::text[]),
      'unknown_block_loc',   public.fn_blend_analysis(NULL, NULL, ARRAY['ZZ-99Z']),
      'invalid_price_edge',  public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[NULL, 0]::int[]),
      'no_price_edges',      public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[]::int[]),
      'too_many_price_edges',public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-3,-2,-1,0,1,2,3]),
      'invalid_age_edge_null',   public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-1,0], ARRAY[NULL,60]::int[]),
      'invalid_age_edge_zero',   public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-1,0], ARRAY[0,60]),
      'invalid_age_edge_huge',   public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-1,0], ARRAY[60,5001]),
      'no_age_edges',        public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-1,0], ARRAY[]::int[]),
      'too_many_age_edges',  public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-1,0], ARRAY[10,20,30,40,50,60,70]),
      'invalid_rounded_up',  public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-1,0], ARRAY[60,120,365], NULL, 0),
      'invalid_market_zero', public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-1,0], ARRAY[60,120,365], 0),
      'invalid_market_nan',  public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-1,0], ARRAY[60,120,365], 'NaN'::numeric)
    ),

    -- A typed market price, to prove p_rounded_up_php sets R here exactly as it does in
    -- the lens, and a wide edge list.
    'given_market_41',  public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-1,0], ARRAY[60,120,365], 41, 41),
    'given_market_41_no_override', public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-1,0], ARRAY[60,120,365], 41),
    'wide_edges', public.fn_blend_analysis(p_proposal_id, p_version_no, NULL, ARRAY[-10,-1,0,5]),

    'posture', jsonb_build_object(
      'nb_authenticated',       has_function_privilege('authenticated', 'public.fn_natural_breaks_3(numeric[], numeric[])', 'EXECUTE'),
      'nb_anon',                has_function_privilege('anon',          'public.fn_natural_breaks_3(numeric[], numeric[])', 'EXECUTE'),
      'nb_service_role',        has_function_privilege('service_role',  'public.fn_natural_breaks_3(numeric[], numeric[])', 'EXECUTE'),
      'analysis_authenticated', has_function_privilege('authenticated', 'public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int)', 'EXECUTE'),
      'analysis_anon',          has_function_privilege('anon',          'public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int)', 'EXECUTE'),
      'analysis_service_role',  has_function_privilege('service_role',  'public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int)', 'EXECUTE'),
      'probe_authenticated',    has_function_privilege('authenticated', 'public.fn_blend_analysis_probe(uuid, int)', 'EXECUTE'),
      'probe_anon',             has_function_privilege('anon',          'public.fn_blend_analysis_probe(uuid, int)', 'EXECUTE'),
      'probe_service_role',     has_function_privilege('service_role',  'public.fn_blend_analysis_probe(uuid, int)', 'EXECUTE'),
      'lens_authenticated',     has_function_privilege('authenticated', 'public.fn_blocking_price_lens(numeric, int[], int)', 'EXECUTE'),
      'lens_anon',              has_function_privilege('anon',          'public.fn_blocking_price_lens(numeric, int[], int)', 'EXECUTE'),
      'lens_service_role',      has_function_privilege('service_role',  'public.fn_blocking_price_lens(numeric, int[], int)', 'EXECUTE'),
      -- Exactly ONE of each: an overload would be a second home for the logic.
      'nb_overload_count',      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public' AND p.proname = 'fn_natural_breaks_3'),
      'analysis_overload_count',(SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public' AND p.proname = 'fn_blend_analysis'),
      'lens_overload_count',    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_price_lens'),
      'invoker_count',          (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public'
                                    AND p.proname IN ('fn_natural_breaks_3', 'fn_blend_analysis', 'fn_blocking_price_lens')
                                    AND p.prosecdef = false),
      'nb_immutable',           (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public' AND p.proname = 'fn_natural_breaks_3'
                                    AND p.provolatile = 'i'),
      'analysis_stable',        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public' AND p.proname = 'fn_blend_analysis'
                                    AND p.provolatile = 's'),
      'search_path_pinned',     (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public'
                                    AND p.proname IN ('fn_natural_breaks_3', 'fn_blend_analysis', 'fn_blend_analysis_probe')
                                    AND p.proconfig @> ARRAY['search_path=public']),
      'commented_count',        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public'
                                    AND p.proname IN ('fn_natural_breaks_3', 'fn_blend_analysis', 'fn_blocking_price_lens')
                                    AND obj_description(p.oid, 'pg_proc') IS NOT NULL)
    )
  );
END;
$$;

COMMENT ON FUNCTION public.fn_blend_analysis_probe(uuid, int) IS
'Read-only ACCESS BRIDGE so scripts/verify-blend-analysis.ts can exercise the authenticated-only fn_blend_analysis / fn_natural_breaks_3 with the service-role key it holds - which it otherwise could not, because service_role holds NOTHING on blend_proposals or blend_proposal_versions. It ASSERTS NOTHING: it calls the analysis on ONE NAMED version (both arguments are required, so it is structurally impossible to point it at every saved version at once), calls the same blocks live, calls it twice to prove the natural-breaks tie-break is deterministic, reads the version''s own stored weighted stats, view_batch_age_days and fn_blocking_price_lens INDEPENDENTLY so the equality proofs are agreements rather than tautologies, runs the hand-checkable natural-breaks unit cases, exercises every refusal, and hands everything back so every assertion lives in the script where a human can read it. Deliberately NOT a whole-database verifier (the 2026-09-14 fn_ops_ledger_verify incident took the live site down). It DOES return money - the analysis payload''s price section is money - so it is SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis_probe(uuid, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis_probe(uuid, int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis_probe(uuid, int) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blend_analysis_probe(uuid, int) TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- §6  fn_blend_analysis_probe_cases — DISCOVERY, so the proofs run on live data
--
-- Two jobs the per-version probe deliberately cannot do, both read-only and both bounded:
--
--   (a) THE VERSION INDEX. `service_role` holds NOTHING on blend_proposals /
--       blend_proposal_versions, so the verify script cannot even find out which versions
--       exist — let alone pick the one whose blend has a delivery AFTER its as-of date,
--       which is what makes the as-of rule provable on LIVE data instead of on a fixture.
--       One row per saved version (5 today); capped at 200 with a `truncated` flag, so it
--       can never turn into a whole-history walk.
--
--   (b) THE DEGENERATE AND UNMEASURED CASES, DISCOVERED not hardcoded. A blend of two
--       blocks that happen to share one ₱/kg has ONE distinct value and must return ONE
--       group (labelled `mid`) with a NULL gvf; add a third block at a different price and
--       it must return TWO (low / high). And a block whose ash / BD read exactly 0 — the
--       COALESCE placeholder, 11 of the yard's 170 today — must land in `unmeasured` on
--       those metrics while still counting in `total_kg`, which is also the one live case
--       where the honest footer legitimately DIFFERS from the snapshot's own weighted stat.
--       The probe finds such blocks by looking at the grid, so the proofs survive the yard
--       changing under them; it says so (NULL) when today's yard has no such case, and the
--       script then reports that out loud rather than passing vacuously.
--
-- IT ASSERTS NOTHING and returns ₱, so it is SECURITY DEFINER, service_role only.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blend_analysis_probe_cases()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_same   text[];
  v_other  text;
  v_zero   text;
  v_extra  text[];
BEGIN
  -- Two blocks sharing ONE price: the busiest duplicate price in the yard.
  SELECT (grp.locs)[1:2] INTO v_same
  FROM (
    SELECT g.avg_php_kg, array_agg(g.block_loc ORDER BY g.block_loc) AS locs, count(*) AS n
    FROM public.view_blocking_grid g
    WHERE g.balance > 0 AND g.avg_php_kg > 0
    GROUP BY g.avg_php_kg
    HAVING count(*) >= 2
    ORDER BY count(*) DESC, g.avg_php_kg
    LIMIT 1
  ) grp;

  -- ...and one at a DIFFERENT price, so the same call shape yields two groups.
  IF v_same IS NOT NULL THEN
    SELECT g.block_loc INTO v_other
    FROM public.view_blocking_grid g
    WHERE g.balance > 0 AND g.avg_php_kg > 0
      AND g.block_loc <> ALL (v_same)
      AND g.avg_php_kg <> (SELECT x.avg_php_kg FROM public.view_blocking_grid x
                            WHERE x.block_loc = v_same[1])
    ORDER BY g.block_loc
    LIMIT 1;
  END IF;

  -- A block whose ash reads exactly 0 — the "no lab result" placeholder.
  SELECT g.block_loc INTO v_zero
  FROM public.view_blocking_grid g
  WHERE g.balance > 0 AND g.avg_ash <= 0
  ORDER BY g.block_loc
  LIMIT 1;

  IF v_zero IS NOT NULL THEN
    SELECT array_agg(g.block_loc) INTO v_extra
    FROM (SELECT g2.block_loc FROM public.view_blocking_grid g2
           WHERE g2.balance > 0 AND g2.avg_ash > 0 AND g2.avg_php_kg > 0
           ORDER BY g2.block_loc LIMIT 2) g;
  END IF;

  RETURN jsonb_build_object(
    'manila_today', (now() AT TIME ZONE 'Asia/Manila')::date,

    'versions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'proposal_id', x.proposal_id,
               'version_no',  x.version_no,
               'title',       x.title,
               'is_current',  x.is_current,
               'is_archived', x.is_archived,
               'as_of',       x.as_of,
               'block_count', x.block_count,
               'block_locs',  x.block_locs,
               'deliveries_after_as_of', x.after_n)
             ORDER BY x.created_at)
      FROM (
        SELECT bv.proposal_id, bv.version_no, bp.title,
               (bv.version_no = bp.current_version_no) AS is_current,
               (bp.archived_at IS NOT NULL)            AS is_archived,
               (bv.created_at AT TIME ZONE 'Asia/Manila')::date AS as_of,
               jsonb_array_length(bv.snapshot -> 'blocks')      AS block_count,
               (SELECT to_jsonb(array_agg(b ->> 'block_loc'))
                  FROM jsonb_array_elements(bv.snapshot -> 'blocks') AS b) AS block_locs,
               (SELECT count(*)::int FROM public.deliveries d
                 WHERE d.batch_code IN (SELECT b2 ->> 'batch_code'
                                          FROM jsonb_array_elements(bv.snapshot -> 'blocks') AS b2)
                   AND d.transaction_date > (bv.created_at AT TIME ZONE 'Asia/Manila')::date) AS after_n,
               bv.created_at
        FROM public.blend_proposal_versions bv
        JOIN public.blend_proposals bp ON bp.id = bv.proposal_id
        ORDER BY bv.created_at
        LIMIT 200
      ) x), '[]'::jsonb),

    'versions_truncated', (SELECT count(*) > 200 FROM public.blend_proposal_versions),

    -- ONE distinct price -> ONE group, labelled `mid`, gvf NULL.
    'single_value', CASE WHEN v_same IS NOT NULL THEN jsonb_build_object(
        'block_locs', to_jsonb(v_same),
        'analysis',   public.fn_blend_analysis(NULL, NULL, v_same)) END,

    -- TWO distinct prices -> TWO groups, low / high.
    'two_value', CASE WHEN v_same IS NOT NULL AND v_other IS NOT NULL THEN jsonb_build_object(
        'block_locs', to_jsonb(v_same || v_other),
        'analysis',   public.fn_blend_analysis(NULL, NULL, v_same || v_other)) END,

    -- A zero lab reading is UNMEASURED, not the cleanest block in the blend.
    'zero_lab', CASE WHEN v_zero IS NOT NULL AND v_extra IS NOT NULL THEN jsonb_build_object(
        'zero_block_loc', v_zero,
        'block_locs', to_jsonb(v_extra || v_zero),
        'analysis',   public.fn_blend_analysis(NULL, NULL, v_extra || v_zero)) END,

    -- How many occupied blocks read 0 on each metric, so the script can say whether the
    -- unmeasured case could be exercised at all.
    'grid_zero_counts', (
      SELECT jsonb_build_object(
          'blocks', count(*)::int,
          'php_kg', count(*) FILTER (WHERE g.avg_php_kg <= 0)::int,
          'mc',     count(*) FILTER (WHERE g.avg_mc <= 0)::int,
          'ash',    count(*) FILTER (WHERE g.avg_ash <= 0)::int,
          'bd_astm',count(*) FILTER (WHERE g.avg_bd_astm <= 0)::int,
          'bd_jis', count(*) FILTER (WHERE g.avg_bd_jis <= 0)::int)
      FROM public.view_blocking_grid g WHERE g.balance > 0)
  );
END;
$$;

COMMENT ON FUNCTION public.fn_blend_analysis_probe_cases() IS
'Read-only DISCOVERY bridge for scripts/verify-blend-analysis.ts, beside fn_blend_analysis_probe. It exists because service_role holds NOTHING on blend_proposals / blend_proposal_versions, so the script cannot find out which saved versions exist - in particular it cannot pick the version whose blend has a delivery AFTER its own as-of date, which is what makes the as-of rule provable on LIVE data rather than on a fixture. It also DISCOVERS the degenerate cases from the grid rather than hardcoding block names: two blocks sharing one PHP/kg (one distinct value, so ONE group labelled mid and a NULL gvf), a third at a different price (TWO groups), and a block whose ash reads exactly 0 - the COALESCE "no lab result" placeholder, 11 of the yard''s 170 occupied blocks today - which must land in `unmeasured` and is the one live case where the honest footer legitimately differs from the snapshot''s own weighted stat. NULL means today''s yard has no such case and the script must say so out loud rather than pass vacuously. It ASSERTS NOTHING; every population is bounded by construction (one row per saved version, capped at 200 with a truncated flag; one row per occupied block). It returns money, so it is SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis_probe_cases() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis_probe_cases() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis_probe_cases() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blend_analysis_probe_cases() TO service_role;
