-- ─────────────────────────────────────────────────────────────────────────────
-- THE SUPPLIER LENS gains a WEIGHTED ₱/kg per band — ADDITIVE KEYS ONLY
--
-- The owner looked at the supplier lens print's band table and said the last column —
-- "SUPPLIER · 4,542,073 kg dominant" — told him nothing he could not already read off the
-- two columns beside it, and asked for "average weighted price or something" instead. The
-- lens could not answer that: it published supplier names, kilograms, counts and shares
-- and NOTHING about what those kilograms cost, so a print that wanted a ₱ figure would
-- have had to re-weight a band in TypeScript, which CLAUDE.md forbids.
--
-- So: TWO keys per band, and the same two on `total`. Nothing else in the payload moves.
--
--   kg_weighted_php_kg   the kg-weighted mean of the grid's OWN per-block ₱/kg over the
--                        band's DOMINANT blocks, PRICED blocks only.
--   priced_dominant_kg   the weight that mean was actually taken over — so a reader can
--                        see how much of the band the figure covers.
--
-- This is the SECOND time this exact key has been added to a lens for this exact reason,
-- and it is deliberately the SAME key, with the same NULL rule and the same population
-- asymmetry, as `fn_blocking_price_lens.kg_weighted_php_kg` (migration 20260921084500 §4).
-- One name, one meaning, across both lenses.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §A  THE POPULATION IS THE BAND'S **DOMINANT** BLOCKS — the TINT's population
-- ═════════════════════════════════════════════════════════════════════════════
-- The lens publishes TWO kilogram attributions (see the 20260922011759 header): a block
-- BELONGS to its dominant supplier's band (`dominant_kg`, what the grid tint shows), while
-- `apportioned_kg` is a supplier's pro-rata slice of every block it appears in. A ₱/kg
-- figure has to pick one, and it picks DOMINANCE, for two reasons that both point the same
-- way:
--
--   1. IT IS THE ONE THAT IS MEASURED RATHER THAN ESTIMATED. `view_blocking_grid.avg_php_kg`
--      is a price per BLOCK, not per supplier — there is no per-supplier ₱/kg anywhere in
--      the database and none is derivable, because `rc_out` records which BATCH kilos left
--      and never whose. Weighting a block's own price by an apportioned slice would put a
--      pro-rata ESTIMATE inside a money figure; weighting it by the block's whole balance
--      puts a real price on a real pile.
--   2. IT IS THE COLUMN THE BAND TABLE ALREADY PRINTS. The row the owner is reading says
--      "N blocks, X kg" from the DOMINANCE family, so a ₱ figure weighted over a different
--      population would not be the price of the kilograms on its own row.
--
-- The consequence is stated rather than hidden: **this is the price of the blocks this
-- supplier DOMINATES, not the price of this supplier's charcoal.** On a mixed block every
-- supplier in it shares one price, and a supplier that dominates NOTHING has no ₱ figure at
-- all (a NULL beside a real `apportioned_kg` — MERCADO's shape). That is the honest answer,
-- and it is why `priced_dominant_kg` rides alongside: a reader can always see the weight.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §B  PRICED BLOCKS ONLY, AND NULL IS NEVER ZERO — the L-008 rule, fifth outing
-- ═════════════════════════════════════════════════════════════════════════════
-- `avg_php_kg` NULL **or ≤ 0** is the L-008 UNPRICED PLACEHOLDER, not a ₱0 block. Averaging
-- it in adds weight to the denominator and nothing to the numerator, which is exactly how
-- `batches.avg_cost` came to read ₱11.01 against a real ₱39.99 (CLAUDE.md, L-039). So the
-- test is `NOT (avg_php_kg IS NULL OR avg_php_kg <= 0)` — the SAME predicate
-- `fn_blocking_price_lens` uses to decide its `unpriced` bucket, word for word, so the two
-- lenses can never disagree about which blocks have a price.
--
-- Therefore:
--   kg_weighted_php_kg   NULL — NEVER 0 — when the band dominates no PRICED block at all
--                        (an empty band, or a band all of whose blocks are unpriced). No
--                        charcoal with a price means no price, not a free band.
--   priced_dominant_kg   a REAL 0 in that case. It is a WEIGHT, and "zero priced kilograms"
--                        is a measurement. It is not null-preserving, exactly as
--                        `dominant_kg` is not.
--
-- `total`'s pair is weighted over the PRICED **ATTRIBUTED** blocks, which is what makes
-- `Σ bands[].priced_dominant_kg = total.priced_dominant_kg` an EXACT fold (the bands
-- partition the attributed blocks by dominance). The same asymmetry §4 of 20260921084500
-- records applies: `total.block_count` / `total.kg` still count EVERY occupied block, priced
-- or not, because they are a count of the yard; the price is a price of what is priced.
-- An UNATTRIBUTED block (no delivery row at all) is excluded — and cannot carry a price
-- anyway, since `avg_php_kg` is derived from the deliveries it does not have. That is
-- measured, not assumed: the probe returns `price_check.unattributed_priced_count`, which
-- the verify script requires to be 0 (it IS 0 today, alongside 0 unattributed blocks).
--
-- MEASURED 2026-09-22, and stated because it is the honest limit of the live proof: **all
-- 170 occupied blocks carry a price today** (`grid.priced_count` 170, `priced_kg` 10,515,408
-- = the whole balance), so `priced_dominant_kg` equals `dominant_kg` on every band and the
-- NULL branch is exercised by the invariants and the SQL text, NOT by live data — exactly as
-- the `unattributed` bucket already is. That is not the same as saying it cannot happen: an
-- unpriced delivery is a normal daily stage (L-039, and `view_digest_unpriced_deliveries`
-- exists for it), so a band WILL eventually read a price over less than its whole balance.
-- That is precisely why `priced_dominant_kg` is published beside the price rather than left
-- implicit.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §C  THIS MAKES THE LENS ₱-BEARING, SO THE SERVER ACTION NOW GATES — but by NULLING
-- ═════════════════════════════════════════════════════════════════════════════
-- Until now the supplier lens carried no money at all and `fetchBlockingSupplierLens`
-- therefore had NO `canViewPrices()` call — deliberately, and the verify script asserted
-- that ABSENCE. These two keys change that fact, so the gate arrives WITH them, in the same
-- change. **But it is a NULLING, not a refusal, and the difference is the whole point:**
--
--   `fn_blocking_price_lens` REFUSES a `!canViewPrices()` caller before touching the
--   database, because THERE band membership itself is price information — a block's band
--   pins its ₱/kg to within a peso, so there is no price-free half of that payload.
--
--   HERE band membership is a SUPPLIER, which is not money and is not derivable into money.
--   Only these two keys are. So the action nulls exactly them (and sets `pricesHidden`) and
--   returns the whole rest of the payload — the bands, the tint map, both kilogram
--   families, every share and count — to Production, THE ROLE THAT WALKS THE YARD. This is
--   the `fetchBlendAnalysis` idiom (its `price` SECTION is deleted while `quality` and `age`
--   still ship), narrowed from a section to two keys.
--
-- The SQL is NOT the gate and must never become one: the RPC is `authenticated`-only and
-- returns the figures to every signed-in caller, exactly as `fn_blocking_price_lens` does.
-- Price visibility is a fact about the READER, so it is resolved where the reader is known.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §D  NOTHING ELSE MOVES — and that is MEASURED, not asserted
-- ═════════════════════════════════════════════════════════════════════════════
-- The signature is unchanged, so this is a CREATE OR REPLACE and the grants survive — they
-- are re-stated anyway, because a function that has just become ₱-bearing silently losing
-- its posture is the shape of the L-043/L-044 incidents. The COMMENT is re-applied with one
-- new paragraph naming the ₱ keys, since CREATE OR REPLACE keeps the old one but a reader
-- must find the current text in this file.
--
-- BEFORE applying, the whole old payload was captured for N = 1, 6 and 12 and compared key
-- by key against the new one with the two new keys removed: **IDENTICAL on all three, 0
-- differing keys** (bands, blocks, unattributed, total, top_n). The two new keys are the
-- only difference.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §E  COST, MEASURED BEFORE ANY PROOF WAS WRITTEN (the 2026-09-14 rule)
-- ═════════════════════════════════════════════════════════════════════════════
-- `set local statement_timeout='5s'` then EXPLAIN (ANALYZE, BUFFERS), 2026-09-22:
--   the lens's CORE QUERY  BEFORE this change     40.8 ms /   680 buffers
--   the lens's CORE QUERY  AFTER  this change     43.4 ms /   680 buffers   (+0)
--   SELECT fn_blocking_supplier_lens(6) BEFORE    47.9 ms / 2,174 buffers
--   SELECT fn_blocking_supplier_lens(6) AFTER     52.6 ms / 2,294 buffers   (+120)
--     (its first two calls after the replacement read 109.4 and 88.4 ms — cold plpgsql
--      planning, the same shape the 20260922011759 header records: 168.5 cold vs 48.0 warm)
--
-- **THE DATA READ DID NOT MOVE AT ALL, AND THE CORE QUERY'S 680 IS THE PROOF.** No new
-- relation is touched: the plan after the change still shows ONE `view_blocking_grid` scan
-- (453 buffers) and ONE `view_blocking_block_suppliers` scan (218), with the identical CTE
-- structure. `avg_php_kg` is a column that view ALREADY computes and `src` ALREADY scans, so
-- carrying it costs one more column in an existing 170-row CTE; the two aggregates are
-- FILTERed sums over `dom`, a 170-row CTE that was already MATERIALIZED and already scanned
-- by `dom_by_band`.
--
-- **The function's +120 buffers is therefore plpgsql PLANNING of a slightly larger
-- statement, not data**, and it is reported rather than rounded away: the honest number is
-- +120 on a figure that was already 1,494 buffers of planning above its own execution. The
-- millisecond deltas (+2.6 core, +4.7 function) are within run-to-run variance on a shared
-- instance — the same query measured 40.8 and 43.4 ms either side of an unrelated call.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- §1  fn_blocking_supplier_lens — unchanged except for the two ₱ keys
-- ═════════════════════════════════════════════════════════════════════════════
-- Reading notes for the body (kept OUT of the body so what is stored in `prosrc` is exactly
-- what this file says). Only the marked lines are new; everything else is verbatim from
-- migration 20260922011759.
--
--   src        one row per OCCUPIED block with charcoal still in it. NEW: it also carries
--              the block's own `avg_php_kg` and the `unpriced` predicate — the grid's own
--              column, never a second definition of what a block cost.
--   sup        src INNER JOINed to view_blocking_block_suppliers on (block_loc, batch_id).
--              NEW: carries the two price fields through, unchanged per block.
--   dom        the dominant supplier per block, fn_blend_block_facts' order. NEW: carries
--              the price fields, which are block-level so DISTINCT ON cannot pick wrong.
--   dom_by_band / attributed
--              NEW: the weighted mean and its weight, over PRICED dominant blocks only.
CREATE OR REPLACE FUNCTION public.fn_blocking_supplier_lens(
  p_top_n int DEFAULT 6
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_top_n  int;
  v_result jsonb;
BEGIN
  -- A NULL N cannot be placed on the scale, so it is REFUSED rather than defaulted: a
  -- caller that passed NULL meant something, and silently substituting 6 would answer a
  -- question nobody asked. (Omitting the argument entirely still gets the DEFAULT 6.)
  IF p_top_n IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_top_n',
      'message', 'Choose how many suppliers to show — between 1 and 12.');
  END IF;

  -- A fractional N is NOT detectable here (the parameter is `int`, so Postgres rounded it
  -- already) and is enforced in the server action under this same `invalid_top_n` reason.
  IF p_top_n < 1 OR p_top_n > 12 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'invalid_top_n',
      'message', format(
        'A supplier lens shows between 1 and 12 suppliers by name; this one asked for %s. Everyone else is grouped as Others.',
        p_top_n));
  END IF;

  v_top_n := p_top_n;

  WITH src AS MATERIALIZED (
    SELECT g.block_loc,
           g.batch_id,
           g.batch_code,
           g.balance::numeric AS kg,
           -- NEW. The grid's OWN per-block price, and the L-008 unpriced predicate spelled
           -- exactly as fn_blocking_price_lens spells it, so the two lenses can never
           -- disagree about which blocks have a price. NULL or <= 0 is the placeholder.
           g.avg_php_kg,
           (g.avg_php_kg IS NULL OR g.avg_php_kg <= 0) AS unpriced
    FROM public.view_blocking_grid g
    WHERE g.balance > 0
  ),
  sup AS MATERIALIZED (
    SELECT s.block_loc,
           s.batch_id,
           s.kg                                    AS block_kg,
           s.avg_php_kg,                            -- NEW, block-level
           s.unpriced,                              -- NEW, block-level
           v.supplier_key,
           v.supplier_display,
           v.kg                                    AS delivered_kg,
           v.share_pct,
           v.supplier_count_in_block,
           -- THE apportionment: this supplier's slice of what is still in the block.
           s.kg * v.share_pct / 100.0              AS bal_kg
    FROM src s
    JOIN public.view_blocking_block_suppliers v
      ON v.block_loc = s.block_loc
     AND v.batch_id  = s.batch_id
  ),
  dom AS MATERIALIZED (
    -- fn_blend_block_facts' own order, reused rather than restated.
    SELECT DISTINCT ON (sup.block_loc)
           sup.block_loc,
           sup.batch_id,
           sup.block_kg,
           sup.avg_php_kg,                          -- NEW
           sup.unpriced,                            -- NEW
           sup.supplier_key             AS dom_key,
           sup.supplier_display         AS dom_display,
           sup.share_pct                AS dom_share_pct,
           sup.supplier_count_in_block  AS supplier_count,
           (sup.supplier_count_in_block > 1) AS is_mixed
    FROM sup
    ORDER BY sup.block_loc, sup.delivered_kg DESC, sup.supplier_key ASC
  ),
  ranked AS MATERIALIZED (
    SELECT sup.supplier_key                                        AS x_key,
           mode() WITHIN GROUP (ORDER BY sup.supplier_display)      AS x_display,
           sum(sup.bal_kg)                                         AS x_ap_kg,
           sum(sup.delivered_kg)                                   AS x_del_kg,
           count(*)::int                                           AS x_blocks_present,
           row_number() OVER (
             ORDER BY sum(sup.bal_kg) DESC,
                      mode() WITHIN GROUP (ORDER BY sup.supplier_display) ASC,
                      sup.supplier_key ASC)::int                   AS x_rn
    FROM sup
    GROUP BY sup.supplier_key
  ),
  banded AS MATERIALIZED (
    -- Everything past N collapses onto the single `others` index, which is v_top_n.
    SELECT r.*,
           CASE WHEN r.x_rn <= v_top_n THEN (r.x_rn - 1) ELSE v_top_n END AS x_band
    FROM ranked r
  ),
  -- Per band: the DOMINANCE half (what the tint shows) …
  dom_by_band AS (
    SELECT b.x_band,
           count(*)::int                                   AS block_count,
           sum(d.block_kg)                                 AS kg,
           count(*) FILTER (WHERE d.is_mixed)::int          AS mixed_block_count,
           -- NEW. Kg-weighted over the band's PRICED dominant blocks. NULL, never 0, when
           -- the band dominates no priced block: no charcoal with a price means no price.
           sum(d.block_kg * d.avg_php_kg) FILTER (WHERE NOT d.unpriced)
             / NULLIF(sum(d.block_kg) FILTER (WHERE NOT d.unpriced), 0) AS wtd_php,
           -- NEW. The weight the mean was taken over. A REAL 0 when nothing is priced —
           -- this is a weight, and "zero priced kilograms" is a measurement.
           COALESCE(sum(d.block_kg) FILTER (WHERE NOT d.unpriced), 0)   AS priced_kg
    FROM dom d
    JOIN banded b ON b.x_key = d.dom_key
    GROUP BY b.x_band
  ),
  -- … and the APPORTIONED half (what the ratio bar shows).
  ap_by_band AS (
    SELECT b.x_band,
           min(b.x_rn)::int                                 AS first_rn,
           count(*)::int                                    AS supplier_count,
           sum(b.x_ap_kg)                                   AS apportioned_kg,
           sum(b.x_del_kg)                                  AS apportioned_delivered_kg,
           (array_agg(b.x_key     ORDER BY b.x_rn))[1]      AS key,
           (array_agg(b.x_display ORDER BY b.x_rn))[1]      AS display,
           array_agg(b.x_key ORDER BY b.x_rn)               AS supplier_keys
    FROM banded b
    GROUP BY b.x_band
  ),
  tot AS (
    SELECT count(*)::int AS block_count, COALESCE(sum(kg), 0) AS kg FROM src
  ),
  attributed AS (
    SELECT count(*)::int AS block_count,
           COALESCE(sum(block_kg), 0) AS kg,
           count(*) FILTER (WHERE is_mixed)::int AS mixed_block_count,
           -- NEW. The same two figures over every attributed block, which is exactly the
           -- union of the bands — so Σ bands[].priced_dominant_kg = this, EXACTLY.
           sum(block_kg * avg_php_kg) FILTER (WHERE NOT unpriced)
             / NULLIF(sum(block_kg) FILTER (WHERE NOT unpriced), 0) AS wtd_php,
           COALESCE(sum(block_kg) FILTER (WHERE NOT unpriced), 0)   AS priced_kg
    FROM dom
  ),
  unattr AS (
    -- A block with no supplier row at all. NOT "Others".
    SELECT count(*)::int AS block_count, COALESCE(sum(s.kg), 0) AS kg
    FROM src s
    WHERE NOT EXISTS (SELECT 1 FROM dom d WHERE d.block_loc = s.block_loc)
  ),
  band_rows AS (
    SELECT a.x_band                                        AS band_index,
           (a.x_band = v_top_n)                            AS is_others,
           CASE WHEN a.x_band = v_top_n THEN NULL ELSE a.key     END AS key,
           CASE WHEN a.x_band = v_top_n THEN NULL ELSE a.display END AS display,
           a.supplier_count,
           -- A named band names exactly one supplier, so the LIST is only meaningful —
           -- and is only published — for `others`.
           CASE WHEN a.x_band = v_top_n THEN to_jsonb(a.supplier_keys) END AS supplier_keys,
           a.apportioned_kg,
           a.apportioned_delivered_kg,
           -- A supplier that DOMINATES NOTHING still has a band; its dominance half is a
           -- real 0, not a missing value (MERCADO today: 11 blocks present, 0 dominated).
           COALESCE(d.block_count, 0)                      AS dominant_block_count,
           COALESCE(d.kg, 0)                               AS dominant_kg,
           COALESCE(d.mixed_block_count, 0)                AS mixed_block_count,
           -- NEW. The price is NULL-preserving (no COALESCE — a band with no priced block
           -- has no price); the weight is COALESCEd to a real 0.
           d.wtd_php                                       AS kg_weighted_php_kg,
           COALESCE(d.priced_kg, 0)                        AS priced_dominant_kg,
           a.first_rn
    FROM ap_by_band a
    LEFT JOIN dom_by_band d ON d.x_band = a.x_band
  )
  SELECT jsonb_build_object(
    'ok', true,
    'top_n', v_top_n,
    'bands', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'index',                    br.band_index,
               'key',                      br.key,
               'display',                  br.display,
               'is_others',                br.is_others,
               'supplier_count',           br.supplier_count,
               'supplier_keys',            br.supplier_keys,
               'dominant_block_count',     br.dominant_block_count,
               'dominant_kg',              br.dominant_kg,
               'apportioned_kg',           br.apportioned_kg,
               'apportioned_delivered_kg', br.apportioned_delivered_kg,
               -- Shares are over the ATTRIBUTED population, and NULL (never 0 ÷ 0) when
               -- nothing in the yard has a supplier at all.
               'kg_share_pct',             CASE WHEN at.kg > 0
                                                THEN br.apportioned_kg * 100.0 / at.kg END,
               'block_share_pct',          CASE WHEN at.block_count > 0
                                                THEN br.dominant_block_count * 100.0 / at.block_count END,
               'mixed_block_count',        br.mixed_block_count,
               -- NEW, and the ONLY two ₱-bearing keys in the whole payload. See §A/§B.
               'kg_weighted_php_kg',       br.kg_weighted_php_kg,
               'priced_dominant_kg',       br.priced_dominant_kg)
             ORDER BY br.band_index)
      FROM band_rows br, attributed at), '[]'::jsonb),
    'blocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'block_loc',                 d.block_loc,
               'batch_id',                  d.batch_id,
               'batch_code',                s.batch_code,
               'band_index',                b.x_band,
               'dominant_supplier_key',     d.dom_key,
               'dominant_supplier_display', d.dom_display,
               'dominant_share_pct',        d.dom_share_pct,
               -- THE ALL/SOME rule, carried from the view's own column.
               'is_mixed',                  d.is_mixed,
               'supplier_count',            d.supplier_count,
               'kg',                        d.block_kg,
               'suppliers', (
                 SELECT jsonb_agg(jsonb_build_object(
                          'key',        u.supplier_key,
                          'display',    u.supplier_display,
                          -- `kg` is DELIVERED — the view's own column, verbatim — and
                          -- `balance_kg` is the slice still in the block. Two names
                          -- because they are two numbers.
                          'kg',         u.delivered_kg,
                          'share_pct',  u.share_pct,
                          'balance_kg', u.bal_kg)
                        ORDER BY u.delivered_kg DESC, u.supplier_key ASC)
                 FROM sup u WHERE u.block_loc = d.block_loc))
             ORDER BY d.block_loc)
      FROM dom d
      JOIN src s    ON s.block_loc = d.block_loc
      JOIN banded b ON b.x_key     = d.dom_key), '[]'::jsonb),
    'unattributed', (SELECT jsonb_build_object('block_count', u.block_count, 'kg', u.kg) FROM unattr u),
    'total', (SELECT jsonb_build_object(
                'block_count',            t.block_count,
                'kg',                     t.kg,
                -- How many DISTINCT suppliers the yard holds — what tells a UI whether an
                -- `others` band exists at all.
                'supplier_count',         (SELECT count(*)::int FROM ranked),
                'mixed_block_count',      at.mixed_block_count,
                'attributed_block_count', at.block_count,
                'attributed_kg',          at.kg,
                -- NEW. Weighted over the PRICED ATTRIBUTED blocks, while block_count and
                -- kg above still count EVERY occupied block. See §B for why.
                'kg_weighted_php_kg',     at.wtd_php,
                'priced_dominant_kg',     at.priced_kg)
              FROM tot t, attributed at)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_supplier_lens(int) IS
'Classify every occupied Blocking block by WHOSE charcoal is in it, for the Blocking page SUPPLIER LENS — the THIRD lens, sibling of fn_blocking_price_lens and fn_blocking_age_lens. NOTHING HERE IS A NEW DEFINITION: supplier identity and the ALL/SOME rule are READ from view_blocking_block_suppliers (which owns canonical_supplier(split_part(supplier, '' - '', 1)) and supplier_count_in_block), and the DOMINANT supplier uses fn_blend_block_facts'' own order (kg DESC, supplier_key ASC) — proven equal to that function on every batch the grid shows, 0 mismatches. is_mixed IS supplier_count_in_block > 1, carried across and never re-derived from the suppliers array. p_top_n is 1..12 (default 6): the yard''s suppliers are ranked by apportioned_kg DESC then display ASC then supplier_key ASC (unique, so the order is total), the first N get a band each at index 0..N-1, and every remaining supplier folds into ONE others band at index N, present if and only if there are more than N suppliers and carrying supplier_keys[] so the UI can name its members. THERE ARE TWO HONEST KILOGRAM ATTRIBUTIONS AND BOTH ARE PUBLISHED, because they answer different questions: dominant_block_count/dominant_kg are the blocks where this supplier is the biggest and their whole balance — WHAT THE GRID TINT SHOWS — while apportioned_kg is this supplier''s own slice of every block it appears in — WHAT THE YARD-SHARE RATIO BAR MUST USE. Measured: MERCADO appears in 11 blocks and dominates none, so publishing only one of the two would state something false. apportioned_kg is a slice of the BALANCE (block balance x share_pct/100), NOT the delivered total: view_blocking_block_suppliers.kg is kilograms DELIVERED and sums to the grid''s total_in, which EXCEEDS the balance by every kilogram ever fed out of an occupied block — a structural gap that grows on every feeding (measured twice ninety minutes apart on 2026-09-22: delivered 10,576,307 kg both times, balance 10,543,087 then 10,515,408, gap 33,220 then 60,899) — so summing it would describe a yard that no longer exists and would break the fold against total.kg; the delivered figure rides alongside as apportioned_delivered_kg and folds to total_in exactly. THE TWO FOLDS ARE EXACT TO DIFFERENT DEGREES, which is stated because it would be easy to claim otherwise: dominant_kg is a plain SUM OF BALANCES so its fold is exactly 0.00, as are the block counts and the delivered fold, while apportioned_kg multiplies by share_pct — itself a numeric DIVISION truncated at a finite scale — so its fold carries that residue, measured 5.896e-14 kg against a 10,515,408 kg yard, about six parts in 10 to the 21st. It is NOT zero and is not claimed to be; the verify script demands an exact 0 where one is deliverable and bounds this one at 1e-6 kg. THE PRO-RATA IS AN APPORTIONMENT, NOT A MEASUREMENT — there is no FIFO by supplier and none is possible, since rc_out records which BATCH kilos left and never whose, the same argument view_analytics_aging_eom records for age; it is exact on a block never fed, and dominant_kg needs no apportionment at all. A block whose batch has NO delivery row has no supplier: it lands in unattributed, in NO band, excluded from both share denominators — the price lens''s unpriced and the age lens''s undated bucket again, and never silently called Others. Therefore sum of dominant_block_count plus unattributed equals total.block_count, sum of dominant_kg and sum of apportioned_kg each plus unattributed.kg equal total.kg to the precision stated above, and both share families sum to 100 over the attributed population. Scope is occupied blocks with a POSITIVE balance, exactly the price and age lenses'' population, so the three describe ONE yard. Every business refusal is jsonb {ok:false, reason, message} written for a human, never a raise: invalid_top_n (NULL, below 1, or above 12).
IT CARRIES MONEY SINCE 2026-09-22, IN EXACTLY TWO KEYS, AND ONLY IN THEM — kg_weighted_php_kg and priced_dominant_kg, on each band and on total; nothing else in the payload is money and nothing else is derivable into money (the owner asked for "average weighted price or something" in place of a band-table column that merely restated the two columns beside it). kg_weighted_php_kg is the kg-weighted mean of view_blocking_grid.avg_php_kg — the grid''s OWN per-block price, the same column the cell displays, never a second definition — taken over the band''s DOMINANT blocks, i.e. the very population dominant_block_count and dominant_kg describe, so the figure is the price of the kilograms on its own row. It is therefore THE PRICE OF THE BLOCKS THIS SUPPLIER DOMINATES, NOT THE PRICE OF THIS SUPPLIER''S CHARCOAL: avg_php_kg is a price per BLOCK and no per-supplier price exists anywhere or is derivable (rc_out records which BATCH kilos left, never whose), so on a mixed block every supplier shares one price and a supplier that dominates nothing has NO price figure at all, a NULL beside a real apportioned_kg. Weighting by apportioned_kg was rejected for exactly that reason: it would put a pro-rata ESTIMATE inside a money figure. PRICED BLOCKS ONLY: avg_php_kg NULL or <= 0 is the L-008 unpriced placeholder and averaging it in is how batches.avg_cost came to read PHP 11.01 against a real PHP 39.99, so the predicate is the one fn_blocking_price_lens uses word for word. NULL IS NEVER 0 — kg_weighted_php_kg is NULL (never 0) when the band dominates no priced block, while priced_dominant_kg is a real 0 there, because it is the WEIGHT the mean was taken over and zero priced kilograms is a measurement; it rides alongside precisely so a reader can see how much of the band the price covers. On total the pair is weighted over the PRICED ATTRIBUTED blocks, so Σ bands[].priced_dominant_kg = total.priced_dominant_kg EXACTLY, while total.block_count and total.kg still count every occupied block priced or not — the same deliberate asymmetry recorded in fn_blocking_price_lens. This is the SAME key name, NULL rule and population asymmetry as fn_blocking_price_lens.kg_weighted_php_kg (migration 20260921084500 §4): one name, one meaning, across both lenses. THE SQL IS NOT THE PRICE GATE AND MUST NOT BECOME ONE — price visibility is a fact about the READER, so fetchBlockingSupplierLens NULLS these two keys (and sets pricesHidden) for a canViewPrices()-denied caller and still returns the bands, the tint map, both kilogram families and every share and count, because a supplier name beside a kilogram total is not money and Production is the role that walks the yard. That is a NULLING, the fetchBlendAnalysis idiom narrowed from a section to two keys — NOT the outright refusal fn_blocking_price_lens requires, where band membership itself pins a block''s price. authenticated only; anon revoked; service_role deliberately not granted.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §2  Posture — re-stated, not assumed
-- ═════════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE FUNCTION keeps grants, but this function has just become ₱-bearing and
-- a silent posture loss on such a function is the L-043/L-044 shape. Re-stated verbatim.
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens(int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_supplier_lens(int) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §3  fn_blocking_supplier_lens_probe — the two new figures get an INDEPENDENT witness
--
-- The probe's contract is unchanged in every other respect: it ASSERTS NOTHING, every
-- population is bounded BY CONSTRUCTION, and every assertion lives in
-- `scripts/verify-blocking-supplier-lens.ts` where a human can read it. It is NOT a
-- "verify everything" function — the 2026-09-14 `fn_ops_ledger_verify()` incident OOM-ed
-- the instance and took the live site down.
--
-- WHAT IS ADDED: `price_check`, which recomputes the weighted mean and its weight
-- INDEPENDENTLY — off `view_blocking_grid` joined to the lens's own published band
-- membership — and returns the GAPS in exact `numeric`. Band membership is reused rather
-- than re-derived because it is already proven correct by the other probe reads (against
-- `view_blocking_block_suppliers` on every (block, supplier) pair and against
-- `fn_blend_block_facts` on every batch); what is NEW and therefore needs a second witness
-- is the WEIGHTED AVERAGE.
--
-- Returning GAPS rather than a second set of prices is the `fn_ops_ledger_verify_*` idiom:
-- a number that must be 0 says everything a comparison needs and carries no money.
--
-- ONE HONEST CHANGE OF CLAIM: this probe used to state it returned "no money value of any
-- kind". It FORWARDS the lens payload, and that payload now carries two ₱ keys, so the
-- claim is narrowed rather than quietly kept — see the re-applied COMMENT below.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blocking_supplier_lens_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT array_agg(g.batch_id) INTO v_ids
  FROM public.view_blocking_grid g WHERE g.balance > 0;

  RETURN jsonb_build_object(
    'manila_today', (now() AT TIME ZONE 'Asia/Manila')::date,

    'lens_default', public.fn_blocking_supplier_lens(),
    'lens_6',       public.fn_blocking_supplier_lens(6),
    'lens_1',       public.fn_blocking_supplier_lens(1),
    'lens_12',      public.fn_blocking_supplier_lens(12),

    'refusal_null_top_n', public.fn_blocking_supplier_lens(NULL::int),
    'refusal_zero_top_n', public.fn_blocking_supplier_lens(0),
    'refusal_neg_top_n',  public.fn_blocking_supplier_lens(-3),
    'refusal_big_top_n',  public.fn_blocking_supplier_lens(13),

    'grid', (
      SELECT jsonb_build_object(
          'block_count',            count(*)::int,
          'kg',                     COALESCE(sum(g.balance), 0),
          'total_in_kg',            COALESCE(sum(g.total_in), 0),
          -- Blocks the supplier view says nothing about: the unattributed population,
          -- computed here off the grid rather than from the lens.
          'unattributed_count',     count(*) FILTER (
                                      WHERE NOT EXISTS (
                                        SELECT 1 FROM public.view_blocking_block_suppliers v
                                         WHERE v.block_loc = g.block_loc))::int,
          'unattributed_kg',        COALESCE(sum(g.balance) FILTER (
                                      WHERE NOT EXISTS (
                                        SELECT 1 FROM public.view_blocking_block_suppliers v
                                         WHERE v.block_loc = g.block_loc)), 0),
          -- ADDED 2026-09-22. How much of the yard has a price at all, so the verify
          -- script can say the weighted figure's coverage rather than assume it. Counts
          -- and kilograms only — no price value.
          'priced_count',           count(*) FILTER (
                                      WHERE NOT (g.avg_php_kg IS NULL OR g.avg_php_kg <= 0))::int,
          'priced_kg',              COALESCE(sum(g.balance) FILTER (
                                      WHERE NOT (g.avg_php_kg IS NULL OR g.avg_php_kg <= 0)), 0))
      FROM public.view_blocking_grid g WHERE g.balance > 0),

    'view_rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'block_loc',               v.block_loc,
               'batch_id',                v.batch_id,
               'supplier_key',            v.supplier_key,
               'kg',                      v.kg,
               'share_pct',               v.share_pct,
               'supplier_count_in_block', v.supplier_count_in_block)
             ORDER BY v.block_loc, v.supplier_key)
      FROM public.view_blocking_block_suppliers v
      JOIN public.view_blocking_grid g
        ON g.block_loc = v.block_loc AND g.batch_id = v.batch_id
      WHERE g.balance > 0), '[]'::jsonb),

    'facts_rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'batch_id',              f.batch_id,
               'dominant_supplier_key', f.dominant_supplier_key,
               'supplier_count',        f.supplier_count,
               'is_single_supplier',    f.is_single_supplier)
             ORDER BY f.batch_id)
      FROM public.fn_blend_block_facts(v_ids) f), '[]'::jsonb),

    'supplier_totals', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'supplier_key',    x.k,
               'apportioned_kg',  x.ap,
               'delivered_kg',    x.del,
               'blocks_present',  x.n)
             ORDER BY x.ap DESC, x.k)
      FROM (
        SELECT v.supplier_key                            AS k,
               sum(g.balance * v.share_pct / 100.0)      AS ap,
               sum(v.kg)                                 AS del,
               count(*)::int                             AS n
        FROM public.view_blocking_block_suppliers v
        JOIN public.view_blocking_grid g
          ON g.block_loc = v.block_loc AND g.batch_id = v.batch_id
        WHERE g.balance > 0
        GROUP BY v.supplier_key) x), '[]'::jsonb),

    -- ADDED 2026-09-22. THE INDEPENDENT WITNESS to the two new ₱ keys, as GAPS in exact
    -- decimal — no price value is returned here, only numbers that must be 0 plus counts
    -- and kilogram weights. The band membership is the lens's own published `blocks[]`
    -- (already proven correct by `view_rows` and `facts_rows` above); what is recomputed
    -- longhand off `view_blocking_grid` is the WEIGHTED MEAN and its WEIGHT, which is the
    -- only genuinely new arithmetic in this change.
    'price_check', (
      WITH lensj AS (SELECT public.fn_blocking_supplier_lens(6) AS j),
      memb AS (
        SELECT (b->>'block_loc')     AS block_loc,
               (b->>'band_index')::int AS band_index
        FROM lensj, jsonb_array_elements(lensj.j->'blocks') b
      ),
      joined AS (
        SELECT m.band_index,
               g.balance::numeric AS kg,
               g.avg_php_kg,
               (g.avg_php_kg IS NULL OR g.avg_php_kg <= 0) AS unpriced
        FROM memb m
        JOIN public.view_blocking_grid g ON g.block_loc = m.block_loc
        WHERE g.balance > 0
      ),
      ind AS (
        SELECT band_index,
               sum(kg * avg_php_kg) FILTER (WHERE NOT unpriced)
                 / NULLIF(sum(kg) FILTER (WHERE NOT unpriced), 0) AS wtd,
               COALESCE(sum(kg) FILTER (WHERE NOT unpriced), 0)   AS priced_kg,
               count(*) FILTER (WHERE NOT unpriced)::int          AS priced_count
        FROM joined GROUP BY band_index
      ),
      ind_all AS (
        SELECT sum(kg * avg_php_kg) FILTER (WHERE NOT unpriced)
                 / NULLIF(sum(kg) FILTER (WHERE NOT unpriced), 0) AS wtd,
               COALESCE(sum(kg) FILTER (WHERE NOT unpriced), 0)   AS priced_kg
        FROM joined
      ),
      pub AS (
        SELECT (b->>'index')::int                    AS band_index,
               (b->>'kg_weighted_php_kg')::numeric   AS wtd,
               (b->>'priced_dominant_kg')::numeric   AS priced_kg,
               (b->>'dominant_block_count')::int     AS dominant_block_count
        FROM lensj, jsonb_array_elements(lensj.j->'bands') b
      )
      SELECT jsonb_build_object(
        'bands', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
                   'band_index',               p.band_index,
                   -- 0 required. NULL only when BOTH sides are NULL, which the two flags
                   -- below make decidable rather than ambiguous.
                   'gap_wtd_php',              (p.wtd - i.wtd),
                   'published_wtd_is_null',    (p.wtd IS NULL),
                   'independent_wtd_is_null',  (i.wtd IS NULL),
                   'gap_priced_kg',            (p.priced_kg - COALESCE(i.priced_kg, 0)),
                   'priced_kg',                p.priced_kg,
                   'priced_block_count',       COALESCE(i.priced_count, 0),
                   'dominant_block_count',     p.dominant_block_count)
                 ORDER BY p.band_index)
          FROM pub p LEFT JOIN ind i ON i.band_index = p.band_index), '[]'::jsonb),
        'total', (
          SELECT jsonb_build_object(
            'gap_wtd_php',             ((lensj.j->'total'->>'kg_weighted_php_kg')::numeric - a.wtd),
            'published_wtd_is_null',   ((lensj.j->'total'->>'kg_weighted_php_kg') IS NULL),
            'independent_wtd_is_null', (a.wtd IS NULL),
            'gap_priced_kg',           ((lensj.j->'total'->>'priced_dominant_kg')::numeric - a.priced_kg),
            'priced_kg',               (lensj.j->'total'->>'priced_dominant_kg')::numeric,
            -- Σ over the bands must equal the total EXACTLY: the bands partition the
            -- attributed blocks by dominance, and this is a plain sum of balances.
            'gap_band_fold_priced_kg', (
              (SELECT COALESCE(sum(p.priced_kg), 0) FROM pub p)
                - (lensj.j->'total'->>'priced_dominant_kg')::numeric))
          FROM lensj, ind_all a),
        -- An UNATTRIBUTED block cannot carry a price (avg_php_kg is derived from the
        -- deliveries it does not have), so total's attributed-only population and the
        -- whole occupied yard's priced population coincide. MEASURED, not assumed.
        'unattributed_priced_count', (
          SELECT count(*)::int FROM public.view_blocking_grid g
           WHERE g.balance > 0
             AND NOT (g.avg_php_kg IS NULL OR g.avg_php_kg <= 0)
             AND NOT EXISTS (SELECT 1 FROM public.view_blocking_block_suppliers v
                              WHERE v.block_loc = g.block_loc))
      )),

    -- THE FOLD GAPS, IN EXACT DECIMAL. Every kg/count gap here must be 0; the two share
    -- gaps carry `numeric` division's own trailing digits, so the script bounds those
    -- rather than demanding a literal zero.
    'folds', (
      SELECT jsonb_object_agg(v.label, (
        SELECT jsonb_build_object(
          'top_n',                     (v.lens->>'top_n')::int,
          'gap_dominant_kg',           COALESCE(sum((b->>'dominant_kg')::numeric), 0)
                                         + (v.lens->'unattributed'->>'kg')::numeric
                                         - (v.lens->'total'->>'kg')::numeric,
          'gap_apportioned_kg',        COALESCE(sum((b->>'apportioned_kg')::numeric), 0)
                                         + (v.lens->'unattributed'->>'kg')::numeric
                                         - (v.lens->'total'->>'kg')::numeric,
          'gap_block_count',           COALESCE(sum((b->>'dominant_block_count')::int), 0)
                                         + (v.lens->'unattributed'->>'block_count')::int
                                         - (v.lens->'total'->>'block_count')::int,
          'gap_mixed_block_count',     COALESCE(sum((b->>'mixed_block_count')::int), 0)
                                         - (v.lens->'total'->>'mixed_block_count')::int,
          -- The DELIVERED family folds to the grid's total_in, NOT to the balance. That is
          -- the whole reason there are two kilogram families.
          'gap_delivered_vs_total_in', COALESCE(sum((b->>'apportioned_delivered_kg')::numeric), 0)
                                         - (SELECT COALESCE(sum(g.total_in), 0)
                                              FROM public.view_blocking_grid g WHERE g.balance > 0),
          'gap_kg_share_pct',          COALESCE(sum((b->>'kg_share_pct')::numeric), 0) - 100,
          'gap_block_share_pct',       COALESCE(sum((b->>'block_share_pct')::numeric), 0) - 100,
          -- ADDED 2026-09-22. The priced WEIGHT folds exactly, at every N.
          'gap_priced_dominant_kg',    COALESCE(sum((b->>'priced_dominant_kg')::numeric), 0)
                                         - (v.lens->'total'->>'priced_dominant_kg')::numeric,
          'band_count',                count(*)::int)
        FROM jsonb_array_elements(v.lens->'bands') b))
      FROM (VALUES
        ('n6',  public.fn_blocking_supplier_lens(6)),
        ('n1',  public.fn_blocking_supplier_lens(1)),
        ('n12', public.fn_blocking_supplier_lens(12))
      ) AS v(label, lens)),

    'posture', jsonb_build_object(
      'lens_authenticated',  has_function_privilege('authenticated', 'public.fn_blocking_supplier_lens(int)', 'EXECUTE'),
      'lens_anon',           has_function_privilege('anon',          'public.fn_blocking_supplier_lens(int)', 'EXECUTE'),
      'lens_service_role',   has_function_privilege('service_role',  'public.fn_blocking_supplier_lens(int)', 'EXECUTE'),
      'probe_authenticated', has_function_privilege('authenticated', 'public.fn_blocking_supplier_lens_probe()', 'EXECUTE'),
      'probe_anon',          has_function_privilege('anon',          'public.fn_blocking_supplier_lens_probe()', 'EXECUTE'),
      'probe_service_role',  has_function_privilege('service_role',  'public.fn_blocking_supplier_lens_probe()', 'EXECUTE'),
      'lens_invoker',        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_supplier_lens'
                                 AND p.prosecdef = false),
      -- An OVERLOAD would be a second home for the band logic. Exactly one must exist.
      'lens_overload_count', (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_supplier_lens'),
      'stable_count',        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public'
                                 AND p.proname IN ('fn_blocking_supplier_lens', 'fn_blocking_supplier_lens_probe')
                                 AND p.provolatile = 's'),
      'search_path_pinned',  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public'
                                 AND p.proname IN ('fn_blocking_supplier_lens', 'fn_blocking_supplier_lens_probe')
                                 AND p.proconfig @> ARRAY['search_path=public']),
      'commented',           (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_supplier_lens'
                                 AND obj_description(p.oid, 'pg_proc') IS NOT NULL),
      -- The view this lens READS its identity rule from must stay authenticated-only and
      -- security_invoker; CREATE OR REPLACE VIEW RESETS reloptions, so this is the live
      -- guard for it (the trap that bit view_ops_ledger_campaign_kpis twice).
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

COMMENT ON FUNCTION public.fn_blocking_supplier_lens_probe() IS
'Read-only ACCESS BRIDGE so scripts/verify-blocking-supplier-lens.ts can exercise the authenticated-only fn_blocking_supplier_lens with the service-role key it holds. It ASSERTS NOTHING — it calls the lens a fixed number of times, recomputes the grid''s totals and the per-supplier yard aggregation INDEPENDENTLY, reads view_blocking_block_suppliers and fn_blend_block_facts so the one-definition proofs are agreements rather than tautologies, and hands everything back so every assertion lives in the script where a human can read it. Deliberately NOT a whole-database verifier (the 2026-09-14 fn_ops_ledger_verify incident): every population is bounded by construction — one row per occupied block, one row per (block, supplier) pair, one row per supplier. price_check (2026-09-22) is the INDEPENDENT WITNESS to the lens''s two new PHP keys: it recomputes the kg-weighted mean and its weight longhand off view_blocking_grid, joined to the lens''s OWN published band membership (already proven correct by view_rows and facts_rows, so what gets a second witness is the weighted average, which is the only new arithmetic), and returns GAPS IN EXACT NUMERIC that must be 0 — plus kilogram weights, counts and two is-null flags that make a NULL gap decidable instead of ambiguous. NARROWED CLAIM, 2026-09-22: this probe used to state it returned no money value of any kind. It FORWARDS the lens payload, which now carries kg_weighted_php_kg and priced_dominant_kg on each band and on total, so it does return those two. Everything the probe itself COMPUTES is still money-free — gaps that must be 0, kilograms, counts and booleans — and it remains SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() TO service_role;
