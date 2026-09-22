-- ─────────────────────────────────────────────────────────────────────────────
-- THE PRICE LENS PRINT gains WAREHOUSE SUBTOTALS WITH WEIGHTED LAB STATS,
-- and every block gains its WAREHOUSE and its SUPPLIER. ADDITIVE KEYS ONLY.
--
-- The owner, on the price lens print's per-band block tables: the warehouse subtotal row
-- prints its block count and its kilograms and then SEVEN BLANK LAB CELLS, and he wants
-- the kg-weighted MC / ASH / BD ASTM / BD JIS / GRIT / VM / FC and the weighted ₱/kg
-- there — plus a SUPPLIER column beside each block.
--
-- **THOSE CELLS ARE BLANK FOR A REASON, AND THE REASON IS THIS MIGRATION.**
-- `lens/lens-summary-model.ts` says it out loud in its own header: it makes exactly ONE
-- sum (a band's kilograms per warehouse) and it refuses to make a weighted average,
-- because *"a kg-weighted MC over a partition SQL never computed would be a second
-- definition of a lab average living in TypeScript"*. So the fix is not to relax that
-- rule in the print — it is to make SQL compute the partition. After this migration the
-- payload publishes a figure for "band 2's weighted MC in warehouse C", so the print can
-- render one instead of a blank, and the TypeScript sum it already makes becomes
-- checkable against a published kilogram total rather than merely unchallenged.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §A  WHAT IS ADDED — nothing else in the payload moves
-- ═════════════════════════════════════════════════════════════════════════════
-- (1) PER BLOCK, in `blocks[]` — four keys:
--       warehouse                  `A`…`D`, `PCA`, `PCB`, or `-`
--       dominant_supplier_display  the biggest supplier's name as the sheet spells it
--       dominant_share_pct         that supplier's share of the block's DELIVERED kilos
--       is_mixed                   more than one supplier filled this block
--
-- (2) A NEW TOP-LEVEL `warehouse_subtotals[]` — one row per (band, warehouse) that holds
--     a block, carrying `band_index`, `warehouse`, `block_count`, `kg`,
--     `kg_weighted_php_kg`, and the seven `w_<stat>` weighted lab means each with its own
--     `<stat>_kg` coverage weight.
--
-- (3) THE SAME weighted lab means + coverage weights on every existing `bands[]` entry
--     and on `total`, so the band total row and the yard total row can print the same
--     columns as the warehouse rows beneath them.
--
-- The signature does NOT change, so this is a `CREATE OR REPLACE` and the grants survive.
-- They are re-stated anyway, and the COMMENT is re-applied with the new paragraphs,
-- because `CREATE OR REPLACE` keeps the old COMMENT while a reader must find the current
-- text in this file — and because a ₱-bearing function silently losing its posture is the
-- shape of the L-043 / L-044 incidents.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §B  THE WAREHOUSE IS DERIVED THE WAY THE PAGE DERIVES IT — and that is a
--     DUPLICATION, stated rather than hidden
-- ═════════════════════════════════════════════════════════════════════════════
-- `lens-summary-model.ts::warehouseOfBlockLoc` is the print's rule: take the `block_loc`
-- prefix before the first `-`, upper-cased and trimmed, and keep it if it is one of the
-- six warehouses the grid lays out (`../constants`'s `WAREHOUSES`: A, B, C, D, PCA, PCB)
-- — otherwise `-`, which is a REAL answer and sorts last, because a block whose prefix is
-- not a warehouse is still a block and dropping it would make the sheet disagree with the
-- band table about how many blocks the band holds.
--
-- That list now exists in TWO places: `WAREHOUSES` in TypeScript (where the grid's
-- geometry lives and must live) and `v_whse` below. A SQL function cannot import a TS
-- constant, so the duplication is unavoidable — what is avoidable is it going UNNOTICED,
-- so `scripts/verify-blocking-price-lens.ts` imports `warehouseOfBlockLoc` from the app
-- module and asserts it agrees with this function's `warehouse` on EVERY block the lens
-- returns. If someone adds warehouse E to the grid, that assertion fails on the first
-- occupied E block rather than quietly filing it under `-`.
--
-- MEASURED after applying, 2026-09-22, at the default edges: **9 warehouse-subtotal rows**
-- over 3 bands and 4 warehouses, and the coverage columns genuinely diverge —
-- `total.mc_kg` is **10,575,183 kg (the whole priced yard)** while `ash_kg` / both `bd_*_kg`
-- / `grit_kg` / `vm_kg` / `fc_kg` all read **9,805,452 kg**, i.e. the 11 reading-less blocks
-- hold 769,731 kg between them. Live yard totals: `w_mc` 11.0242, `w_ash` 3.7218,
-- `w_bd_astm` 0.58115, `w_bd_jis` 0.59158, `w_grit` 2.83454, `w_vm` 12.8341, `w_fc` 83.4461.
--
-- MEASURED 2026-09-22: the yard is A 50 / B 34 / C 33 / D 53 blocks — no PCA, no PCB and
-- no `-` today, so those three branches are exercised by the SQL text and the equality
-- assertion rather than by live data. Stated because it is not the same as saying they
-- cannot happen: PCA/PCB are opt-in filter chips on a real part of the yard.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §C  THE SUPPLIER IS NOT A NEW DEFINITION — three rules, all READ
-- ═════════════════════════════════════════════════════════════════════════════
--   WHO A SUPPLIER IS   `canonical_supplier(split_part(supplier, ' - ', 1))` — THE one
--                       definition, and this migration never spells it out: it reads
--                       `view_blocking_block_suppliers` (20260902145145), which owns it.
--                       So the Blocking supplier SEARCH, the blend modal's green/orange,
--                       the SUPPLIER LENS and now the PRICE lens print answer to the same
--                       names.
--   WHICH ONE IS "THE"  the DOMINANT one, `ORDER BY kg DESC, supplier_key ASC` — lifted
--                       verbatim from `fn_blend_block_facts` (20260921034512) and reused
--                       by `fn_blocking_supplier_lens` (20260922011759). This is the
--                       THIRD consumer of that order and still not a second rule: the
--                       verify script proves this function's dominant supplier equals
--                       `fn_blend_block_facts`' on every block the lens returns.
--   ALL vs SOME         `is_mixed` IS the view's own `supplier_count_in_block > 1`,
--                       carried across, NEVER re-derived from a list length.
--
-- `dominant_share_pct` is the view's own `share_pct`, which is a share of the block's
-- DELIVERED kilograms, not of its balance. That is the same number the supplier lens
-- publishes under the same name, and it is deliberately NOT re-based onto the balance:
-- within one block the balance is a constant, so the two orderings are identical and
-- re-basing would only create a second percentage for the same fact.
--
-- NULL IS NEVER A GUESS. A block whose batch has no delivery row at all has no supplier,
-- so `dominant_supplier_display` and `dominant_share_pct` are NULL and `is_mixed` is
-- **NULL, never false** — "nobody has delivered into this pile" and "one supplier filled
-- it" are different answers. MEASURED: such a block cannot appear in `blocks[]` at all
-- today, because `avg_php_kg` is derived from the deliveries it does not have, so it
-- would be `unpriced` and in no band (grid: 170 occupied blocks, 0 unpriced, 0 without a
-- supplier row). The LEFT JOIN is still a LEFT JOIN.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §D  A LAB READING OF 0 IS "NO READING", AND IS EXCLUDED — not averaged as zero
-- ═════════════════════════════════════════════════════════════════════════════
-- `view_blocking_grid` COALESCEs its seven lab averages to 0, so `avg_ash = 0` means the
-- block's deliveries carry no ASH figure — it does not mean ash-free charcoal. This is
-- the L-008 unpriced-placeholder shape in a lab coat, and it is the rule
-- `fn_blend_analysis` already writes down: **unmeasured = NULL or ≤ 0.** So each stat is
-- read as `CASE WHEN g.avg_<stat> > 0 THEN g.avg_<stat> END` and every weighted mean is
-- taken over only the blocks that HAVE that reading:
--
--   w_<stat>    = Σ(kg × stat) ÷ Σ(kg), both FILTERed to blocks where the stat is
--                 measured. **NULL — never 0 — when no block in the group has it.**
--   <stat>_kg   = the kilograms that mean was actually taken over. A **REAL 0** when
--                 nothing is measured, because it is a WEIGHT and "zero measured
--                 kilograms" is a measurement — the same asymmetry
--                 `priced_dominant_kg` carries in the supplier lens, and the same
--                 `w_<stat>` / `<stat>_kg` pairing `view_ops_ledger_day_fed_blend`
--                 publishes for the fed blend.
--
-- **EACH STAT HAS ITS OWN COVERAGE AND THEY GENUINELY DIFFER — measured, which is why
-- there are seven coverage columns and not one.** Of the 170 occupied blocks, ALL 170
-- carry an MC reading while **11 read 0 on ash, both BDs, grit, VM and FC**. A single
-- shared "lab kg" would therefore have been wrong for MC or wrong for the other six on
-- every group in the yard.
--
-- Weighted by the grid `balance` — the same weight `kg_weighted_php_kg` uses and the same
-- one the print's warehouse kilogram subtotal sums, so the ₱ column and the seven lab
-- columns on one row describe the same kilograms.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §E  THE POPULATION, AND THE ONE ASYMMETRY IT INHERITS
-- ═════════════════════════════════════════════════════════════════════════════
-- `warehouse_subtotals` partitions the BANDED population — i.e. the PRICED blocks, which
-- is exactly what `blocks[]` and `bands[]` already cover. So:
--
--   Σ warehouse_subtotals[band].block_count  = bands[band].block_count   (gap 0)
--   Σ warehouse_subtotals[band].kg           = bands[band].kg            (gap exactly 0)
--
-- both EXACT, because both are plain sums of counts and balances.
--
-- `total`'s new weighted stats are taken over that same priced population, so
-- `Σ bands[].<stat>_kg = total.<stat>_kg` holds exactly. That inherits the asymmetry §4
-- of 20260921084500 already records for `kg_weighted_php_kg`: `total.block_count` and
-- `total.kg` count EVERY occupied block, priced or not, because they are a count of the
-- yard, while every weighted figure is weighted over what the bands contain. The
-- consequence is stated rather than hidden — **an UNPRICED block's lab readings are not
-- in `total.w_mc`** — and the fold is why it is the right trade: a total that did not
-- equal the sum of its bands would be a second population nobody could reconcile.
-- MEASURED: 0 of 170 occupied blocks are unpriced today, so the two populations coincide
-- and that branch is exercised by the invariant, not by live data.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §F  STILL ₱-BEARING, STILL A REFUSAL — the gate does not move
-- ═════════════════════════════════════════════════════════════════════════════
-- Band membership alone pins a block's ₱/kg to within a peso, so there is no price-free
-- half of this payload and `fetchBlockingPriceLens` REFUSES a `!canViewPrices()` caller
-- before touching the database. Nothing here changes that: the seven lab stats are not
-- money, but they arrive inside a payload that is, and splitting it would mean a second
-- classifier. The supplier lens is where a price-denied reader gets a warehouse picture,
-- and it nulls its two ₱ keys instead — that asymmetry is deliberate and is recorded in
-- both COMMENTs.
--
-- Grants unchanged and re-stated: `authenticated` only, `anon` REVOKEd, and **NOT
-- `service_role`** (no sync worker reads it, so `verify-worker-view-grants` stays at
-- 4 views / 0 findings).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §G  COST, MEASURED BEFORE ANY PROOF WAS WRITTEN (the 2026-09-14 rule)
-- ═════════════════════════════════════════════════════════════════════════════
-- `set local statement_timeout='5s'` then EXPLAIN (ANALYZE, BUFFERS), 2026-09-22:
--   view_blocking_grid alone, WITH the seven lab columns (170 rows)  7.9 ms /  459 buffers
--   fn_blocking_price_lens(40.23)            BEFORE this change     28.2 ms / 2,013 buffers
--   the new CORE QUERY as written below                             41.6 ms /   661 buffers
--   fn_blocking_price_lens(40.23)            AFTER  this change     52.2 ms / 2,414 buffers
--
-- **THE DATA READ GREW BY EXACTLY ONE SCAN, AND THE CORE QUERY'S 661 IS THE PROOF.** The
-- function's +401 buffers is that one 202-buffer relation plus plpgsql PLANNING of a
-- materially larger statement — the same shape 20260922051500 §E records for the supplier
-- lens (+120 planning buffers for two added aggregates on a figure already 1,494 buffers
-- of planning above its own execution).
--
-- **661 = 456 (ONE grid scan) + 202 (ONE `view_blocking_block_suppliers` scan) + 3**, so
-- the new relation is read EXACTLY ONCE although `sup` feeds `classified` which four
-- CTEs then read. The whole increase over the previous core query is that single
-- 202-buffer scan — the same scan `fn_blocking_supplier_lens` already pays, and its
-- 29 ms is `canonical_supplier()` per delivery row, paid INSIDE that view rather than
-- here. The seven lab columns are columns the grid ALREADY computes and `blk` ALREADY
-- scans, so carrying them costs nothing measurable.
--
-- Both populations are bounded BY CONSTRUCTION — one row per occupied block (170 today,
-- 238 slots maximum) and one row per (block, supplier) pair (203) — so neither can grow
-- into a whole-history scan however the yard changes. `warehouse_subtotals` is at most
-- (bands × 7) rows, i.e. 49 at the 6-edge cap.
--
-- HONEST NOTE ON THE `MATERIALIZED` HINTS: on the PRICE lens they are a measured win and
-- not insurance — the 20260919025729 header records 85.4 ms / 1,939 buffers without them
-- against 4.8 ms / 454 with. Every one of them is kept, and `sup` gets its own.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §H  NOTHING ELSE MOVED — and that is MEASURED, not asserted
-- ═════════════════════════════════════════════════════════════════════════════
-- BEFORE applying, the md5 of the whole payload was captured for three configurations —
-- `(40.23)`, `(40.23, ARRAY[-10,-1,0,5])` and `(41, ARRAY[-1,0], 41)` — and afterwards
-- recomputed with the new keys stripped out of `bands[]`, `blocks[]` and `total` and the
-- new top-level array removed. All three hashes matched:
--
--   default  038ec4e6e583ec8f7c2c9d94e686bc75
--   wide     471721cd4f86c0ef2cb9e9fd3f21e4af
--   typed    777ca847308c2a5b7e663cb4821d9ac0
--
-- The verify script repeats that comparison structurally (key sets, band by band, block
-- by block) rather than relying on a hash that a legitimate delivery would change.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- §1  fn_blocking_price_lens — same signature, four additive block keys, one new
--     array, and the weighted lab family on bands + total
-- ═════════════════════════════════════════════════════════════════════════════
-- Reading notes for the body below (kept OUT of the body so what is stored in `prosrc` is
-- exactly what this file says). Only the marked lines are new; everything else is
-- verbatim from 20260921034512 §4 as amended by 20260921084500 §4.
--
--   blk        one row per OCCUPIED block with charcoal still in it. NEW: it also carries
--              `batch_id` (to join the supplier view on the pair that view is keyed by),
--              the derived `warehouse`, and the seven lab stats with 0 read as "no
--              reading". `avg_php_kg` and the `unpriced` predicate are unchanged.
--   sup        NEW. The DOMINANT supplier per block — `DISTINCT ON` plus
--              fn_blend_block_facts' own order, so this is that function's rule and not
--              a third one. A block with no delivery row simply has no `sup` row.
--   classified NEW: LEFT JOINs `sup`, so a supplier-less block keeps NULLs rather than
--              vanishing, and carries the lab stats forward for the two aggregations.
--   whse_rows  NEW. The (band, warehouse) partition — the print's missing figures.
--   band_rows / priced
--              NEW: the same seven weighted means and coverage weights, per band and
--              over the whole priced population.
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
  -- The grid's own warehouse keys, in the grid's own layout order, plus the `-` bucket
  -- that sorts last. A DUPLICATION of `WAREHOUSES` in app/(app)/inventory/blocking/
  -- constants.ts — see §B: a SQL function cannot import a TS constant, so the verify
  -- script asserts the two agree on every block instead.
  v_whse       text[] := ARRAY['A', 'B', 'C', 'D', 'PCA', 'PCB'];
  v_whse_order text[] := ARRAY['A', 'B', 'C', 'D', 'PCA', 'PCB', '-'];
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
  -- MATERIALIZED, all of them, and it is not cosmetic: `blk` is read by five downstream
  -- CTEs and `classified` by four, and without the hint the planner re-executed the whole
  -- view_blocking_grid subtree for each reference — MEASURED 85 ms / 1,939 buffers
  -- before, 4.8 ms / 454 after, i.e. the grid is scanned exactly once.
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
           g.batch_id,                                          -- NEW, for the sup join
           g.balance::numeric                                   AS kg,
           g.avg_php_kg,
           (g.avg_php_kg IS NULL OR g.avg_php_kg <= 0)          AS unpriced,
           -- NEW. The page's own warehouse rule: the prefix if it is one of the grid's
           -- six warehouses, else the real `-` bucket. See §B.
           CASE WHEN upper(btrim(split_part(g.block_loc, '-', 1))) = ANY (v_whse)
                THEN upper(btrim(split_part(g.block_loc, '-', 1)))
                ELSE '-' END                                    AS warehouse,
           -- NEW. 0 IS "NO READING", not a measurement of zero — the grid COALESCEs
           -- these to 0. See §D. Same predicate fn_blend_analysis uses for `unmeasured`.
           CASE WHEN g.avg_mc      > 0 THEN g.avg_mc      END    AS mc,
           CASE WHEN g.avg_ash     > 0 THEN g.avg_ash     END    AS ash,
           CASE WHEN g.avg_bd_astm > 0 THEN g.avg_bd_astm END    AS bd_astm,
           CASE WHEN g.avg_bd_jis  > 0 THEN g.avg_bd_jis  END    AS bd_jis,
           CASE WHEN g.avg_grit    > 0 THEN g.avg_grit    END    AS grit,
           CASE WHEN g.avg_vm      > 0 THEN g.avg_vm      END    AS vm,
           CASE WHEN g.avg_fc      > 0 THEN g.avg_fc      END    AS fc
    FROM public.view_blocking_grid g
    WHERE g.balance > 0
  ),
  sup AS MATERIALIZED (
    -- NEW. THE DOMINANT SUPPLIER, in fn_blend_block_facts' own order — reused, never
    -- restated. Joined on BOTH keys because view_blocking_block_suppliers is keyed on
    -- the (block_loc, batch_id) pair and the grid resolves which batch occupies a slot.
    SELECT DISTINCT ON (v.block_loc)
           v.block_loc,
           v.supplier_display                AS dom_display,
           v.share_pct                       AS dom_share_pct,
           (v.supplier_count_in_block > 1)   AS is_mixed
    FROM blk b
    JOIN public.view_blocking_block_suppliers v
      ON v.block_loc = b.block_loc
     AND v.batch_id  = b.batch_id
    ORDER BY v.block_loc, v.kg DESC, v.supplier_key ASC
  ),
  classified AS MATERIALIZED (
    -- The highest band whose lower bound the price satisfies. Bands are contiguous
    -- and ordered, so that IS the band containing it; band 0's NULL lower bound
    -- makes the answer total.
    SELECT b.block_loc,
           b.kg,
           b.avg_php_kg,
           b.warehouse,                                              -- NEW
           b.mc, b.ash, b.bd_astm, b.bd_jis, b.grit, b.vm, b.fc,     -- NEW
           s.dom_display,                                            -- NEW, NULL-able
           s.dom_share_pct,                                          -- NEW, NULL-able
           s.is_mixed,                                               -- NEW, NULL-able
           (SELECT max(bd.band_index) FROM bands bd
             WHERE bd.lower_php IS NULL OR b.avg_php_kg >= bd.lower_php) AS band_index
    FROM blk b
    -- LEFT, not INNER: a block whose batch has no delivery row has no supplier, and it
    -- must keep its band rather than disappear out of the folds. See §C.
    LEFT JOIN sup s ON s.block_loc = b.block_loc
    WHERE NOT b.unpriced
  ),
  tot    AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg FROM blk),
  unp    AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg FROM blk WHERE unpriced),
  priced AS (SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg,
                    sum(kg * avg_php_kg) / NULLIF(sum(kg), 0) AS wtd_php,
                    -- NEW. The seven weighted means over the whole PRICED population,
                    -- each with the weight it was taken over. NULL never 0 on the mean;
                    -- a real 0 on the weight. See §D and §E.
                    sum(kg * mc)      FILTER (WHERE mc      IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE mc      IS NOT NULL), 0) AS w_mc,
                    COALESCE(sum(kg) FILTER (WHERE mc      IS NOT NULL), 0) AS mc_kg,
                    sum(kg * ash)     FILTER (WHERE ash     IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE ash     IS NOT NULL), 0) AS w_ash,
                    COALESCE(sum(kg) FILTER (WHERE ash     IS NOT NULL), 0) AS ash_kg,
                    sum(kg * bd_astm) FILTER (WHERE bd_astm IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE bd_astm IS NOT NULL), 0) AS w_bd_astm,
                    COALESCE(sum(kg) FILTER (WHERE bd_astm IS NOT NULL), 0) AS bd_astm_kg,
                    sum(kg * bd_jis)  FILTER (WHERE bd_jis  IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE bd_jis  IS NOT NULL), 0) AS w_bd_jis,
                    COALESCE(sum(kg) FILTER (WHERE bd_jis  IS NOT NULL), 0) AS bd_jis_kg,
                    sum(kg * grit)    FILTER (WHERE grit    IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE grit    IS NOT NULL), 0) AS w_grit,
                    COALESCE(sum(kg) FILTER (WHERE grit    IS NOT NULL), 0) AS grit_kg,
                    sum(kg * vm)      FILTER (WHERE vm      IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE vm      IS NOT NULL), 0) AS w_vm,
                    COALESCE(sum(kg) FILTER (WHERE vm      IS NOT NULL), 0) AS vm_kg,
                    sum(kg * fc)      FILTER (WHERE fc      IS NOT NULL) / NULLIF(sum(kg) FILTER (WHERE fc      IS NOT NULL), 0) AS w_fc,
                    COALESCE(sum(kg) FILTER (WHERE fc      IS NOT NULL), 0) AS fc_kg
               FROM classified),
  band_rows AS (
    SELECT bd.band_index, bd.lower_php, bd.upper_php,
           count(c.block_loc)::int      AS block_count,
           COALESCE(sum(c.kg), 0)       AS kg,
           -- ADDED 2026-09-21. NULL, never 0, on an empty band: no charcoal in the band
           -- means no price in the band.
           sum(c.kg * c.avg_php_kg) / NULLIF(sum(c.kg), 0) AS wtd_php,
           -- NEW 2026-09-22. The same seven, per band.
           sum(c.kg * c.mc)      FILTER (WHERE c.mc      IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.mc      IS NOT NULL), 0) AS w_mc,
           COALESCE(sum(c.kg) FILTER (WHERE c.mc      IS NOT NULL), 0) AS mc_kg,
           sum(c.kg * c.ash)     FILTER (WHERE c.ash     IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.ash     IS NOT NULL), 0) AS w_ash,
           COALESCE(sum(c.kg) FILTER (WHERE c.ash     IS NOT NULL), 0) AS ash_kg,
           sum(c.kg * c.bd_astm) FILTER (WHERE c.bd_astm IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.bd_astm IS NOT NULL), 0) AS w_bd_astm,
           COALESCE(sum(c.kg) FILTER (WHERE c.bd_astm IS NOT NULL), 0) AS bd_astm_kg,
           sum(c.kg * c.bd_jis)  FILTER (WHERE c.bd_jis  IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.bd_jis  IS NOT NULL), 0) AS w_bd_jis,
           COALESCE(sum(c.kg) FILTER (WHERE c.bd_jis  IS NOT NULL), 0) AS bd_jis_kg,
           sum(c.kg * c.grit)    FILTER (WHERE c.grit    IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.grit    IS NOT NULL), 0) AS w_grit,
           COALESCE(sum(c.kg) FILTER (WHERE c.grit    IS NOT NULL), 0) AS grit_kg,
           sum(c.kg * c.vm)      FILTER (WHERE c.vm      IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.vm      IS NOT NULL), 0) AS w_vm,
           COALESCE(sum(c.kg) FILTER (WHERE c.vm      IS NOT NULL), 0) AS vm_kg,
           sum(c.kg * c.fc)      FILTER (WHERE c.fc      IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.fc      IS NOT NULL), 0) AS w_fc,
           COALESCE(sum(c.kg) FILTER (WHERE c.fc      IS NOT NULL), 0) AS fc_kg
    FROM bands bd
    LEFT JOIN classified c ON c.band_index = bd.band_index
    GROUP BY bd.band_index, bd.lower_php, bd.upper_php
  ),
  whse_rows AS (
    -- NEW 2026-09-22. THE PARTITION THE PRINT COULD NOT PUBLISH. One row per (band,
    -- warehouse) THAT HOLDS A BLOCK — an empty pair is omitted rather than emitted as a
    -- zero row, because the print renders a warehouse group only when it has blocks;
    -- this is the one place the lens does NOT emit an empty group, and it is why the
    -- fold is stated as Σ over the rows PRESENT.
    SELECT c.band_index,
           c.warehouse,
           COALESCE(array_position(v_whse_order, c.warehouse), 99) AS whse_sort,
           count(*)::int                AS block_count,
           sum(c.kg)                    AS kg,
           sum(c.kg * c.avg_php_kg) / NULLIF(sum(c.kg), 0) AS wtd_php,
           sum(c.kg * c.mc)      FILTER (WHERE c.mc      IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.mc      IS NOT NULL), 0) AS w_mc,
           COALESCE(sum(c.kg) FILTER (WHERE c.mc      IS NOT NULL), 0) AS mc_kg,
           sum(c.kg * c.ash)     FILTER (WHERE c.ash     IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.ash     IS NOT NULL), 0) AS w_ash,
           COALESCE(sum(c.kg) FILTER (WHERE c.ash     IS NOT NULL), 0) AS ash_kg,
           sum(c.kg * c.bd_astm) FILTER (WHERE c.bd_astm IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.bd_astm IS NOT NULL), 0) AS w_bd_astm,
           COALESCE(sum(c.kg) FILTER (WHERE c.bd_astm IS NOT NULL), 0) AS bd_astm_kg,
           sum(c.kg * c.bd_jis)  FILTER (WHERE c.bd_jis  IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.bd_jis  IS NOT NULL), 0) AS w_bd_jis,
           COALESCE(sum(c.kg) FILTER (WHERE c.bd_jis  IS NOT NULL), 0) AS bd_jis_kg,
           sum(c.kg * c.grit)    FILTER (WHERE c.grit    IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.grit    IS NOT NULL), 0) AS w_grit,
           COALESCE(sum(c.kg) FILTER (WHERE c.grit    IS NOT NULL), 0) AS grit_kg,
           sum(c.kg * c.vm)      FILTER (WHERE c.vm      IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.vm      IS NOT NULL), 0) AS w_vm,
           COALESCE(sum(c.kg) FILTER (WHERE c.vm      IS NOT NULL), 0) AS vm_kg,
           sum(c.kg * c.fc)      FILTER (WHERE c.fc      IS NOT NULL) / NULLIF(sum(c.kg) FILTER (WHERE c.fc      IS NOT NULL), 0) AS w_fc,
           COALESCE(sum(c.kg) FILTER (WHERE c.fc      IS NOT NULL), 0) AS fc_kg
    FROM classified c
    GROUP BY c.band_index, c.warehouse
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
               'kg_weighted_php_kg', br.wtd_php,
               -- NEW 2026-09-22. Seven weighted means, seven coverage weights.
               'w_mc',      br.w_mc,      'mc_kg',      br.mc_kg,
               'w_ash',     br.w_ash,     'ash_kg',     br.ash_kg,
               'w_bd_astm', br.w_bd_astm, 'bd_astm_kg', br.bd_astm_kg,
               'w_bd_jis',  br.w_bd_jis,  'bd_jis_kg',  br.bd_jis_kg,
               'w_grit',    br.w_grit,    'grit_kg',    br.grit_kg,
               'w_vm',      br.w_vm,      'vm_kg',      br.vm_kg,
               'w_fc',      br.w_fc,      'fc_kg',      br.fc_kg)
             ORDER BY br.band_index)
      FROM band_rows br, priced p), '[]'::jsonb),
    'blocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'block_loc',  c.block_loc,
               'band_index', c.band_index,
               -- NEW 2026-09-22. The four additive per-block keys. `is_mixed` is the
               -- view's own supplier_count_in_block > 1, and all three supplier fields
               -- are NULL — never false, never 0 — on a block with no delivery row.
               'warehouse',                 c.warehouse,
               'dominant_supplier_display', c.dom_display,
               'dominant_share_pct',        c.dom_share_pct,
               'is_mixed',                  c.is_mixed)
             ORDER BY c.block_loc)
      FROM classified c), '[]'::jsonb),
    -- NEW 2026-09-22. One row per (band, warehouse) that holds a block, in the grid's
    -- own warehouse order with the `-` bucket last.
    'warehouse_subtotals', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'band_index',  w.band_index,
               'warehouse',   w.warehouse,
               'block_count', w.block_count,
               'kg',          w.kg,
               'kg_weighted_php_kg', w.wtd_php,
               'w_mc',      w.w_mc,      'mc_kg',      w.mc_kg,
               'w_ash',     w.w_ash,     'ash_kg',     w.ash_kg,
               'w_bd_astm', w.w_bd_astm, 'bd_astm_kg', w.bd_astm_kg,
               'w_bd_jis',  w.w_bd_jis,  'bd_jis_kg',  w.bd_jis_kg,
               'w_grit',    w.w_grit,    'grit_kg',    w.grit_kg,
               'w_vm',      w.w_vm,      'vm_kg',      w.vm_kg,
               'w_fc',      w.w_fc,      'fc_kg',      w.fc_kg)
             ORDER BY w.band_index, w.whse_sort, w.warehouse)
      FROM whse_rows w), '[]'::jsonb),
    'unpriced', (SELECT jsonb_build_object('block_count', u.block_count, 'kg', u.kg) FROM unp u),
    -- `block_count` and `kg` cover EVERY occupied block; every WEIGHTED figure is
    -- weighted over the PRICED ones only. See §4 of migration 20260921084500 and §E
    -- above — the fold against the bands is what makes that the right trade.
    'total',    (SELECT jsonb_build_object('block_count', t.block_count, 'kg', t.kg,
                          'kg_weighted_php_kg', p.wtd_php,
                          'w_mc',      p.w_mc,      'mc_kg',      p.mc_kg,
                          'w_ash',     p.w_ash,     'ash_kg',     p.ash_kg,
                          'w_bd_astm', p.w_bd_astm, 'bd_astm_kg', p.bd_astm_kg,
                          'w_bd_jis',  p.w_bd_jis,  'bd_jis_kg',  p.bd_jis_kg,
                          'w_grit',    p.w_grit,    'grit_kg',    p.grit_kg,
                          'w_vm',      p.w_vm,      'vm_kg',      p.vm_kg,
                          'w_fc',      p.w_fc,      'fc_kg',      p.fc_kg)
                   FROM tot t, priced p)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) IS
'Classify every occupied Blocking block against a GIVEN market PHP/kg, for the Blocking page price lens. It takes the market price as an argument on purpose, so the computed bases from fn_blocking_market_bases and a manually typed price share ONE classifier. R = floor(market) + 1 (40.23 -> 41, 39.8568 -> 40, and 40.00 -> 41 so the market price itself stays inside the at-market band). A TYPED PRICE IS THE LINE ITSELF, so p_rounded_up_php (2026-09-21) OVERRIDES R when given: the operator who types PHP 41 means PHP 41 and up is above market, and the measured rule would have given them 42. It must be a whole number of at least 1 (refusal invalid_rounded_up); NULL is not a refusal, it is the "compute R from the market price" signal. THE UI RULE: for the manual basis pass ceil(typed price); for every measured basis pass nothing. p_edge_offsets is a list of whole-peso offsets from R, de-duplicated and sorted; k edges give k+1 half-open [lower, upper) bands with the first open below (lower_php null) and the last open above (upper_php null); default ARRAY[-1,0] gives below / at market / above market. The per-block price is view_blocking_grid.avg_php_kg, the same column the cell displays — never a second definition. A block with NO price (null or 0, the L-008 unpriced placeholder — NULL is never PHP 0) lands in "unpriced", in no band, and is excluded from both share denominators, so sum of band counts plus unpriced equals total and each share family sums to 100 over the priced population.
EACH BAND AND THE TOTAL CARRY kg_weighted_php_kg (2026-09-21) so a lens print does not have to re-weight a band in TypeScript: NULL, never 0, on an empty band, and on total it is weighted over the PRICED population only while total.block_count / total.kg still count every occupied block — an unpriced block''s PHP 0 is the L-008 placeholder and averaging it in would drag the figure down the way batches.avg_cost once read PHP 11.01 against a real PHP 39.99.
ADDED 2026-09-22, ADDITIVE KEYS ONLY, because the price lens print''s WAREHOUSE SUBTOTAL row printed its blocks and kilograms beside SEVEN BLANK LAB CELLS — and those cells were blank on purpose: lens-summary-model.ts makes exactly one sum and refuses to make a weighted average, since a kg-weighted MC over a partition SQL never computed would be a second definition of a lab average living in TypeScript. So SQL now computes the partition. (1) Every blocks[] entry gains warehouse, dominant_supplier_display, dominant_share_pct and is_mixed. (2) A NEW top-level warehouse_subtotals[] gives one row per (band_index, warehouse) THAT HOLDS A BLOCK — an empty pair is omitted, the one place this lens does not emit an empty group — with block_count, kg, kg_weighted_php_kg and the seven weighted lab means. (3) The same weighted lab family rides on every bands[] entry and on total.
THE WAREHOUSE IS THE PAGE''S OWN RULE: the block_loc prefix before the first dash, upper-cased and trimmed, kept when it is one of the grid''s six warehouses (A, B, C, D, PCA, PCB — the WAREHOUSES constant in app/(app)/inventory/blocking/constants.ts) and otherwise the REAL bucket "-", which sorts last, because a block whose prefix is not a warehouse is still a block. That list is duplicated here because SQL cannot import a TypeScript constant, so scripts/verify-blocking-price-lens.ts imports warehouseOfBlockLoc from lens-summary-model.ts and asserts it agrees with this function on EVERY block returned — if warehouse E is ever added to the grid, that assertion fails rather than the block quietly landing in "-". Measured 2026-09-22: A 50 / B 34 / C 33 / D 53 blocks, no PCA, no PCB, no "-".
THE SUPPLIER IS NOT A NEW DEFINITION. Identity and the ALL/SOME rule are READ from view_blocking_block_suppliers (which owns canonical_supplier(split_part(supplier, '' - '', 1)) and supplier_count_in_block), and the DOMINANT supplier uses fn_blend_block_facts'' own order (kg DESC, supplier_key ASC) — the same order fn_blocking_supplier_lens reuses, making this the third consumer and still not a third rule; the verify script proves equality against that function on every block. is_mixed IS supplier_count_in_block > 1, carried across and never re-derived from a list length. dominant_share_pct is the view''s own share of the block''s DELIVERED kilos, not of its balance, and is deliberately not re-based (within one block the balance is a constant, so the orderings are identical and re-basing would only create a second percentage). NULL IS NEVER A GUESS: a block whose batch has no delivery row reads NULL display, NULL share and is_mixed NULL — never false. Such a block cannot reach blocks[] today, because avg_php_kg is derived from deliveries it does not have, so it is unpriced and in no band; the join is a LEFT JOIN anyway.
A LAB READING OF 0 IS "NO READING" AND IS EXCLUDED, NEVER AVERAGED AS ZERO — view_blocking_grid COALESCEs its seven lab averages to 0, which is the L-008 placeholder shape in a lab coat, so the predicate is the one fn_blend_analysis uses for unmeasured (NULL or <= 0). Each w_<stat> is Sigma(kg x stat) / Sigma(kg) over only the blocks that HAVE that reading and is NULL — never 0 — when no block in the group has it, while <stat>_kg is the weight the mean was taken over and is a REAL 0 in that case, because zero measured kilograms is a measurement. EACH STAT HAS ITS OWN COVERAGE AND THEY GENUINELY DIFFER: of 170 occupied blocks all 170 carry MC while 11 read 0 on ash, both BDs, grit, VM and FC, so one shared "lab kg" would have been wrong for MC or wrong for the other six on every group in the yard. The weight is the grid balance, the same weight kg_weighted_php_kg uses, so the money column and the seven lab columns on one row describe the same kilograms.
FOLDS: Sigma warehouse_subtotals[band].block_count = bands[band].block_count and Sigma warehouse_subtotals[band].kg = bands[band].kg, both exactly, since both are plain sums; and Sigma bands[].<stat>_kg = total.<stat>_kg, since total is weighted over the same priced population the bands partition. The consequence is stated rather than hidden: an UNPRICED block''s lab readings are not in total.w_mc. Measured: 0 of 170 occupied blocks are unpriced today, so the two populations coincide.
Every business refusal is jsonb {ok:false, reason, message} written for a human, never a raise: no_market_price, invalid_market_price, invalid_rounded_up, invalid_edge, no_edges, too_many_edges. CARRIES MONEY EVEN WHERE IT LOOKS LIKE IT DOES NOT — band membership alone pins a block''s PHP/kg to within a peso, so there is no price-free half of this payload and the seven lab stats do not create one: the server action REFUSES a canViewPrices()-denied caller BEFORE calling rather than nulling fields after. The supplier lens is where a price-denied reader gets a warehouse picture, and it nulls its two PHP keys instead; that asymmetry is deliberate. authenticated only; anon revoked; service_role deliberately not granted.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §2  Posture — re-stated, not assumed
-- ═════════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE FUNCTION keeps grants, but this function is ₱-bearing and a silent
-- posture loss on such a function is the L-043 / L-044 shape. Re-stated verbatim.
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §3  fn_blocking_price_lens_probe — the new figures get an INDEPENDENT witness
--
-- The probe's contract is unchanged in every other respect: it ASSERTS NOTHING, every
-- population is bounded BY CONSTRUCTION, and every assertion lives in
-- `scripts/verify-blocking-price-lens.ts` where a human can read it. It is NOT a
-- "verify everything" function — the 2026-09-14 `fn_ops_ledger_verify()` incident OOM-ed
-- the instance and took the live site down.
--
-- WHAT IS ADDED:
--   grid_blocks    one row per occupied positive-balance block straight off
--                  `view_blocking_grid` — block_loc, balance, the price, the seven lab
--                  readings and the `unpriced` flag — so the verify script can recompute
--                  EVERY weighted mean longhand, and can check this function's
--                  `warehouse` against the TypeScript rule per block.
--   facts_rows     `fn_blend_block_facts`' own dominant supplier per batch, so the
--                  dominance reuse is an AGREEMENT rather than a tautology.
--   view_rows      `view_blocking_block_suppliers` per (block_loc, supplier_key), the
--                  one-definition proof for the share and the ALL/SOME count.
--   lab_check      THE FOLD GAPS in exact `numeric` for the seven coverage weights and
--                  the two kilogram folds, at two edge configurations. These exist
--                  because "gap exactly 0" is a claim only exact decimal arithmetic can
--                  make: re-summing the same numbers in JavaScript doubles leaves a
--                  residue, so a script that added them up itself could only ever assert
--                  "gap < epsilon". The script still re-sums in JS to check the SHAPE of
--                  every row — it just does not source any exactness claim from there.
--
-- IT RETURNS ₱ — it always did (the four market prices and now the weighted block price
-- it forwards are the numbers under test). Everything the probe itself COMPUTES that is
-- new is a gap that must be 0, a kilogram weight, a count or a lab reading.
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
  v_ids    uuid[];
BEGIN
  SELECT NULLIF(v.market_avg_price, 0) INTO v_price
  FROM public.view_analytics_rcin_monthly v WHERE v.month_start = v_m0;

  SELECT array_agg(g.batch_id) INTO v_ids
  FROM public.view_blocking_grid g WHERE g.balance > 0;

  RETURN jsonb_build_object(
    'manila_today',   v_today,
    'this_month',     v_m0,
    'last_month',     v_m1,
    'trailing_days',  least(greatest(COALESCE(p_trailing_days, 30), 1), 400),

    -- the basis rows, exactly as the function returns them
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

    -- ADDED 2026-09-22. THE RAW GRID ROWS, so the script can recompute every weighted
    -- mean longhand and check the warehouse rule per block against the TypeScript one.
    -- 170 rows today, 238 slots maximum — bounded by construction.
    'grid_blocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'block_loc',  g.block_loc,
               'batch_id',   g.batch_id,
               'kg',         g.balance,
               'avg_php_kg', g.avg_php_kg,
               'unpriced',   (g.avg_php_kg IS NULL OR g.avg_php_kg <= 0),
               'mc',         g.avg_mc,
               'ash',        g.avg_ash,
               'bd_astm',    g.avg_bd_astm,
               'bd_jis',     g.avg_bd_jis,
               'grit',       g.avg_grit,
               'vm',         g.avg_vm,
               'fc',         g.avg_fc)
             ORDER BY g.block_loc)
      FROM public.view_blocking_grid g WHERE g.balance > 0), '[]'::jsonb),

    -- ADDED 2026-09-22. fn_blend_block_facts' OWN dominance verdict per batch — so the
    -- reuse claim is an agreement with the function that owns the rule.
    'facts_rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'batch_id',                  f.batch_id,
               'dominant_supplier_key',     f.dominant_supplier_key,
               'dominant_supplier_display', f.dominant_supplier_display,
               'dominant_share_pct',        f.dominant_share_pct,
               'supplier_count',            f.supplier_count,
               'is_single_supplier',        f.is_single_supplier)
             ORDER BY f.batch_id)
      FROM public.fn_blend_block_facts(v_ids) f), '[]'::jsonb),

    -- ADDED 2026-09-22. The view that OWNS supplier identity, the share and the ALL/SOME
    -- count, per (block, supplier) pair over exactly the lens's population. 203 rows.
    'view_rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'block_loc',               v.block_loc,
               'batch_id',                v.batch_id,
               'supplier_key',            v.supplier_key,
               'supplier_display',        v.supplier_display,
               'kg',                      v.kg,
               'share_pct',               v.share_pct,
               'supplier_count_in_block', v.supplier_count_in_block)
             ORDER BY v.block_loc, v.supplier_key)
      FROM public.view_blocking_block_suppliers v
      JOIN public.view_blocking_grid g
        ON g.block_loc = v.block_loc AND g.batch_id = v.batch_id
      WHERE g.balance > 0), '[]'::jsonb),

    -- lenses: the live basis, a wide edge list, and the three R-rule cases
    'lens_live',       public.fn_blocking_price_lens(v_price),
    'lens_wide',       public.fn_blocking_price_lens(v_price, ARRAY[-10, -1, 0, 5]),
    'r_40_23',         public.fn_blocking_price_lens(40.23),
    'r_40_00',         public.fn_blocking_price_lens(40.00),
    'r_39_8568',       public.fn_blocking_price_lens(39.8568),

    -- THE ROUNDED-UP OVERRIDE (2026-09-21), carried forward VERBATIM. `override_null` must be
    -- byte-identical to `lens_live`, which is the whole compatibility claim of that parameter;
    -- `override_41_market_41` is the typed-price case beside `r_41_no_override`, the measured
    -- rule on the same number. **These five were briefly dropped while this migration's probe
    -- was written and the verify script failed on the first run** — which is exactly what a
    -- probe whose keys are all asserted is for.
    'override_null',            public.fn_blocking_price_lens(v_price, ARRAY[-1, 0], NULL),
    'override_41_market_41',    public.fn_blocking_price_lens(41, ARRAY[-1, 0], 41),
    'r_41_no_override',         public.fn_blocking_price_lens(41),
    'refusal_override_zero',    public.fn_blocking_price_lens(40, ARRAY[-1, 0], 0),
    'refusal_override_negative', public.fn_blocking_price_lens(40, ARRAY[-1, 0], -5),

    -- ADDED 2026-09-22. THE FOLD GAPS, IN EXACT DECIMAL, at two configurations. Every
    -- number here must be 0. No price value is returned — only gaps, weights and counts.
    'lab_check', (
      SELECT jsonb_object_agg(v.label, (
        SELECT jsonb_build_object(
          -- Σ over the (band, warehouse) rows == the band's own published figures.
          'gap_whse_block_count', COALESCE((
              SELECT sum((w->>'block_count')::int) FROM jsonb_array_elements(v.lens->'warehouse_subtotals') w), 0)
            - COALESCE((SELECT sum((b->>'block_count')::int) FROM jsonb_array_elements(v.lens->'bands') b), 0),
          'gap_whse_kg', COALESCE((
              SELECT sum((w->>'kg')::numeric) FROM jsonb_array_elements(v.lens->'warehouse_subtotals') w), 0)
            - COALESCE((SELECT sum((b->>'kg')::numeric) FROM jsonb_array_elements(v.lens->'bands') b), 0),
          -- Σ over the bands' coverage weights == the total's, for all seven stats.
          'gap_mc_kg',      COALESCE((SELECT sum((b->>'mc_kg')::numeric)      FROM jsonb_array_elements(v.lens->'bands') b), 0) - (v.lens->'total'->>'mc_kg')::numeric,
          'gap_ash_kg',     COALESCE((SELECT sum((b->>'ash_kg')::numeric)     FROM jsonb_array_elements(v.lens->'bands') b), 0) - (v.lens->'total'->>'ash_kg')::numeric,
          'gap_bd_astm_kg', COALESCE((SELECT sum((b->>'bd_astm_kg')::numeric) FROM jsonb_array_elements(v.lens->'bands') b), 0) - (v.lens->'total'->>'bd_astm_kg')::numeric,
          'gap_bd_jis_kg',  COALESCE((SELECT sum((b->>'bd_jis_kg')::numeric)  FROM jsonb_array_elements(v.lens->'bands') b), 0) - (v.lens->'total'->>'bd_jis_kg')::numeric,
          'gap_grit_kg',    COALESCE((SELECT sum((b->>'grit_kg')::numeric)    FROM jsonb_array_elements(v.lens->'bands') b), 0) - (v.lens->'total'->>'grit_kg')::numeric,
          'gap_vm_kg',      COALESCE((SELECT sum((b->>'vm_kg')::numeric)      FROM jsonb_array_elements(v.lens->'bands') b), 0) - (v.lens->'total'->>'vm_kg')::numeric,
          'gap_fc_kg',      COALESCE((SELECT sum((b->>'fc_kg')::numeric)      FROM jsonb_array_elements(v.lens->'bands') b), 0) - (v.lens->'total'->>'fc_kg')::numeric,
          'whse_row_count', (SELECT count(*)::int FROM jsonb_array_elements(v.lens->'warehouse_subtotals') w),
          'band_count',     (SELECT count(*)::int FROM jsonb_array_elements(v.lens->'bands') b))))
      FROM (VALUES
        ('default', public.fn_blocking_price_lens(40.23)),
        ('wide',    public.fn_blocking_price_lens(40.23, ARRAY[-10, -1, 0, 5]))
      ) AS v(label, lens)),

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
      'lens_authenticated',  has_function_privilege('authenticated', 'public.fn_blocking_price_lens(numeric, int[], int)', 'EXECUTE'),
      'lens_anon',           has_function_privilege('anon',          'public.fn_blocking_price_lens(numeric, int[], int)', 'EXECUTE'),
      'lens_service_role',   has_function_privilege('service_role',  'public.fn_blocking_price_lens(numeric, int[], int)', 'EXECUTE'),
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
                                 AND obj_description(p.oid, 'pg_proc') IS NOT NULL),
      'lens_overload_count', (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_price_lens'),
      -- The view this lens now READS its supplier rule from must stay authenticated-only
      -- and security_invoker; CREATE OR REPLACE VIEW RESETS reloptions, so this is the
      -- live guard for it (the trap that bit view_ops_ledger_campaign_kpis twice).
      'view_authenticated',    has_table_privilege('authenticated', 'public.view_blocking_block_suppliers', 'SELECT'),
      'view_anon',             has_table_privilege('anon',          'public.view_blocking_block_suppliers', 'SELECT'),
      'view_service_role',     has_table_privilege('service_role',  'public.view_blocking_block_suppliers', 'SELECT'),
      'view_security_invoker', (SELECT count(*)::int FROM pg_class c
                                  JOIN pg_namespace n ON n.oid = c.relnamespace
                                 WHERE n.nspname = 'public'
                                   AND c.relname = 'view_blocking_block_suppliers'
                                   AND c.reloptions @> ARRAY['security_invoker=true'])
    )
  );
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_price_lens_probe(int) IS
'Read-only ACCESS BRIDGE so scripts/verify-blocking-price-lens.ts can exercise the authenticated-only price-lens functions with the service-role key it holds. It ASSERTS NOTHING — it calls them a fixed number of times, reads the same three statistics straight from view_analytics_rcin_monthly and the grid''s own totals independently, and hands everything back so every assertion lives in the script where a human can read it. Deliberately NOT a whole-database verifier (the 2026-09-14 fn_ops_ledger_verify incident): every population is bounded by construction — one row per occupied block (170 today, 238 slots maximum), one row per (block, supplier) pair, one row per batch, and a delivery window clamped to 400 days. ADDED 2026-09-22 for the warehouse-subtotal and weighted-lab keys: grid_blocks (the raw grid rows, so every weighted mean can be recomputed longhand and the SQL warehouse rule can be checked per block against the TypeScript warehouseOfBlockLoc), facts_rows (fn_blend_block_facts'' own dominance verdict, so the reuse is an agreement rather than a tautology), view_rows (view_blocking_block_suppliers, which owns identity, the share and the ALL/SOME count) and lab_check (the fold gaps in exact numeric, which must be 0 — re-summing them in JavaScript doubles leaves a residue, so no exactness claim may be sourced there). It DOES return PHP: the market prices and the weighted block prices it forwards are the numbers under test. Everything the probe itself computes is a gap that must be 0, a kilogram weight, a count or a lab reading. SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) TO service_role;
