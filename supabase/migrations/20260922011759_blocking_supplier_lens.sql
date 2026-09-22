-- ─────────────────────────────────────────────────────────────────────────────
-- THE SUPPLIER LENS on the Blocking grid — "whose charcoal is in my yard"
--
-- The THIRD lens on the frame the price lens built (20260919025729) and the age lens
-- joined (20260919133042), and deliberately their sibling in every shape: ONE function,
-- jsonb out, every band returned even when empty, a jsonb {ok:false, reason, message}
-- written for a human instead of a raise, the same MATERIALIZED-CTE discipline, a
-- service_role-only probe that ASSERTS NOTHING, and the age lens's posture — no ₱, so no
-- price gate. Owner-approved direction: "top suppliers as bands, colour each block by its
-- biggest supplier, mark mixed blocks." Default N = 6.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- NOTHING HERE IS A NEW DEFINITION — not identity, not dominance, not ALL-vs-SOME
-- ═════════════════════════════════════════════════════════════════════════════
-- Three rules this lens needs already exist, and all three are READ rather than restated:
--
--   WHO A SUPPLIER IS      `canonical_supplier(split_part(supplier, ' - ', 1))` — THE one
--                          definition, and this migration never spells it out: it reads
--                          `view_blocking_block_suppliers` (20260902145145), which owns
--                          it. So the Blocking supplier SEARCH, the blend modal's green/
--                          orange and this lens answer to the same names, and a sundry
--                          re-entry booked as 'Layupan - JAN-26-BLK9' attributes to
--                          LAYUPAN rather than inventing a phantom supplier.
--
--   ALL vs SOME            `is_mixed` is that view's OWN `supplier_count_in_block > 1`,
--                          carried across, NEVER re-derived from a list length. That
--                          column exists precisely so the test lives in one place.
--
--   WHICH SUPPLIER IS      the DOMINANT one, ordered `kg DESC, supplier_key ASC` —
--   "THE" SUPPLIER         lifted verbatim from `fn_blend_block_facts` (20260921034512),
--                          which already had to answer this question for the blend
--                          modal. This is NOT a third dominance rule: PROVEN equal to
--                          that function's `dominant_supplier_key` on every batch the
--                          grid shows (measured 2026-09-22: 170 of 170, 0 mismatches,
--                          and 0 mismatches on `supplier_count` too).
--
-- A note on why that tie rule is unambiguous here. `fn_blend_block_facts` ranks on the
-- supplier's DELIVERED kilograms. Within one block the balance is a constant, so ordering
-- by delivered kg and ordering by `share_pct` are the SAME order — dominance cannot
-- depend on which of the two kilogram families below you rank it by. The tie-break on
-- `supplier_key ASC` is what stops two equally large suppliers making consecutive calls
-- disagree.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THERE ARE **TWO** HONEST KILOGRAM ATTRIBUTIONS AND THE LENS PUBLISHES BOTH
-- ═════════════════════════════════════════════════════════════════════════════
-- This is the one genuinely new decision in this file, it was forced by a MEASUREMENT,
-- and getting it wrong would put two different numbers under one name.
--
-- A block belongs to ONE band (its dominant supplier's) — that is what the grid TINT
-- shows. But a mixed block's kilos belong to SEVERAL suppliers, so "what share of the
-- yard is ORNALES" is a different question from "how many blocks does ORNALES own", and
-- the two do not even have the same answer shape. MEASURED 2026-09-22: **MERCADO appears
-- in 11 blocks and dominates NONE of them.** A lens that published only dominance would
-- say Mercado has 0 kg in the yard, which is false; one that published only apportioned
-- kg could not colour a cell at all. So:
--
--   dominant_block_count / dominant_kg   the blocks where this supplier is the biggest,
--                                        and their WHOLE balance. == WHAT THE TINT SHOWS.
--   apportioned_kg                       this supplier's own slice of every block it
--                                        appears in. == WHAT THE RATIO BAR SHOWS.
--
-- **AND `apportioned_kg` IS A SLICE OF THE BALANCE, NOT THE DELIVERED TOTAL.** The brief
-- asked for `view_blocking_block_suppliers.kg`, and that is measurably the wrong
-- denominator for a yard-share bar: that column is kilograms DELIVERED, so it sums to the
-- grid's `total_in`, and DELIVERED EXCEEDS BALANCE BY EVERY KILOGRAM EVER FED OUT OF AN
-- OCCUPIED BLOCK — a structural gap that grows every time the plant feeds. Measured twice
-- ninety minutes apart on 2026-09-22, which is the clearest way to show it is not a fixed
-- number: delivered 10,576,307 kg both times, balance **10,543,087 → 10,515,408 kg**, gap
-- **33,220 → 60,899 kg**. Summing the delivered column would make the ratio bar describe a
-- yard that no longer exists and would break the fold against `total.kg` that every other
-- lens guarantees. So
--
--   apportioned_kg = block balance × (that supplier's share_pct / 100)
--
-- which sums to the yard, whenever it is asked. **AND THE TWO FOLDS ARE EXACT TO DIFFERENT
-- DEGREES — stated because it would be easy to claim otherwise.** `dominant_kg` is a plain
-- SUM OF BALANCES, so its fold is **exactly 0.00**, as are the block counts and the
-- delivered-vs-`total_in` fold. `apportioned_kg` multiplies by `share_pct`, which is itself
-- a `numeric` DIVISION truncated at a finite scale, so the slices carry that division's own
-- trailing residue: MEASURED **5.896e-14 kg against a 10,515,408 kg yard**, i.e. about six
-- parts in 10^21. It is NOT zero and is not claimed to be; the verify script demands an
-- exact 0 on the folds that can deliver one and bounds this one at 1e-6 kg. (The two share
-- families carry the same kind of residue, ~5e-19 to −4e-17 against 100.) The delivered
-- figure is NOT discarded: it rides alongside as
-- `apportioned_delivered_kg` so the arrival total stays auditable against the view that
-- owns it. Both are on every band, both are named for what they are. THE LIVE FUNCTION IS
-- ALWAYS THE AUTHORITY FOR THE FIGURES — the invariants, not the numbers, are what this
-- file guarantees.
--
-- **THE PRO-RATA IS AN APPORTIONMENT AND IT IS LABELLED AS ONE.** There is NO FIFO by
-- supplier and none is possible — `rc_out` records which BATCH kilos left, never which
-- DELIVERY within it, let alone whose. That is the identical argument
-- `view_analytics_aging_eom` records for age, and it has the identical consequence: a
-- pro-rata split is the only defensible answer, so `apportioned_kg` on a block that has
-- been fed is an ESTIMATE of whose charcoal remains, not a measurement. It is EXACT on
-- every block that has never been fed (most of them — the gap above is 0.58% of the yard),
-- and `dominant_kg` needs no apportionment ever, which is a second reason both are
-- published rather than one.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- BANDS: THE TOP N OF THE CURRENT YARD, PLUS ONE `others`
-- ═════════════════════════════════════════════════════════════════════════════
-- `p_top_n` is 1..12 (default 6). The yard's suppliers are ranked by `apportioned_kg`
-- DESC — the yard-share metric the bar draws, so the legend's order and the bar's order
-- cannot disagree — with `display ASC` then `supplier_key ASC` as tie-breaks, the last of
-- which is unique and therefore makes the order TOTAL. The first N get a band each (index
-- 0..N-1); EVERY remaining supplier is folded into ONE `others` band at index N, which is
-- present IF AND ONLY IF there are more than N suppliers. It carries `supplier_keys[]`,
-- so the UI can name who is in it rather than describing it as a remainder.
--
-- (Measured 2026-09-22: ranking by apportioned kg and ranking by delivered kg give the
-- IDENTICAL order on all 17 suppliers today. They are not the same rule and may diverge;
-- the apportioned one is the published one.)
--
-- ═════════════════════════════════════════════════════════════════════════════
-- `unattributed` — THE undated/unpriced BUCKET AGAIN, AND NULL IS NEVER 0
-- ═════════════════════════════════════════════════════════════════════════════
-- An occupied block with a positive balance whose batch has NO delivery row at all has no
-- supplier. It goes in `unattributed`, in NO band, and is excluded from both share
-- denominators — exactly as the price lens's `unpriced` and the age lens's `undated`
-- blocks are. Calling it "Others" would assert a supplier we do not have; leaving it out
-- of the folds would lose it. Consequently
--
--   Σ bands[].dominant_block_count + unattributed.block_count = total.block_count  (gap 0)
--   Σ bands[].dominant_kg          + unattributed.kg          = total.kg           (gap 0)
--   Σ bands[].apportioned_kg       + unattributed.kg          = total.kg      (gap ~6e-14)
--
-- and both share families sum to 100 over the ATTRIBUTED population (residue ~1e-17; see
-- the note on exactness above). MEASURED: there are **0 unattributed blocks today** (all 170
-- grid blocks have deliveries), so that branch is exercised by the invariants rather than
-- by live data — which is not the same as saying it cannot happen, and is why it is a
-- first-class bucket and not an omission.
--
-- SCOPE is occupied blocks with a POSITIVE balance — EXACTLY the price and age lenses'
-- population, so the three describe ONE yard (asserted across the probes). A negative
-- balance is misattribution (CLAUDE.md: 77 batches carry −3.22M kg) and has no supplier
-- story.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- NO ₱ ANYWHERE, AND THEREFORE NO PRICE GATE — the AGE-lens posture
-- ═════════════════════════════════════════════════════════════════════════════
-- Suppliers, kilograms, counts, shares and block addresses. `cost_basis` is never read,
-- `avg_php_kg` is never selected, no cost/price/value column exists anywhere in the
-- payload and none is derivable from it — a supplier's name plus a kilogram total says
-- nothing about what it cost. So `fetchBlockingSupplierLens` has NO `canViewPrices()`
-- call and this lens is visible to EVERY role INCLUDING Production, the role that walks
-- the yard. `scripts/verify-blocking-supplier-lens.ts` asserts the gate's ABSENCE and
-- recursively scans every key of the live payload for a money-shaped name, so nobody can
-- "tidy up" the asymmetry with `fn_blocking_price_lens` — whose band membership genuinely
-- does pin a block's ₱/kg to within a peso. Grants match the siblings: `authenticated`
-- only, `anon` REVOKEd, and NOT `service_role` (no sync worker reads any of this, so
-- `verify-worker-view-grants` stays at 4 views / 0 findings).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- COST, MEASURED BEFORE ANY PROOF WAS WRITTEN (the 2026-09-14 rule)
-- ═════════════════════════════════════════════════════════════════════════════
-- `set local statement_timeout='5s'` then EXPLAIN (ANALYZE, BUFFERS), 2026-09-22:
--   view_blocking_block_suppliers alone (203 rows, warm)      36.7 ms /   239 buffers
--     (its FIRST call read 120.7 ms — `canonical_supplier()` per delivery row is the
--      whole cost, and it is paid inside that view, not here)
--   view_blocking_grid alone (balance > 0, 170 rows)            2.4 ms /   455 buffers
--   this lens's core query, as written below                   29.7 ms /   679 buffers
--   SELECT fn_blocking_supplier_lens(6)  (warm, whole fn)      48.0 ms / 2,174 buffers
--     (its FIRST call after creation read 168.5 ms — cold plpgsql planning)
-- 679 = 455 (ONE grid scan) + 221 (ONE supplier-view scan) + 3, so `src` is built exactly
-- once although three downstream CTEs read it, and `sup` once although five do. The
-- function's larger buffer count is plpgsql PLANNING across its statements, exactly as the
-- age lens records (8.05 ms / 530 core vs 14.3 ms / 2,095 for the whole function);
-- EXECUTION is the 679.
--
-- The dominant cost is `canonical_supplier()` inside the view, and BOTH populations are
-- bounded BY CONSTRUCTION — one row per occupied block (170 today, 238 slots maximum) and
-- one row per (block, supplier) pair (203) — so neither can grow into a whole-history
-- scan however the yard changes.
--
-- HONEST NOTE ON THE `MATERIALIZED` HINTS, because the measurement did NOT say what was
-- expected (the same correction the age lens had to record). Removing them changes
-- essentially NOTHING here — the equivalent un-hinted query measured **35.5 ms / 680
-- buffers** against 29.7 ms / 679, and its plan still shows ONE 221-buffer scan of
-- `view_blocking_block_suppliers` and ONE 459-buffer scan of the grid. Postgres 12+
-- already materializes a CTE referenced more than once, and every CTE here is: `src` is
-- read by `sup`, `tot` and `unattr`, and `sup` by `dom`, `ranked` and the per-block
-- `suppliers` sub-select. So these hints are EXPLICIT INSURANCE, not a measured win —
-- they exist so that a future edit which happens to leave a SINGLE reference to one of
-- these expensive subtrees cannot silently re-inline it. Keep them, and do NOT claim they
-- bought the current number. (This is the opposite of the PRICE lens, where the hints
-- genuinely took 85.4 ms / 1,939 buffers down to 4.8 ms / 454.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- §1  fn_blocking_supplier_lens — classify the yard by WHOSE charcoal is in it
-- ═════════════════════════════════════════════════════════════════════════════
-- Reading notes for the body below (kept OUT of the body so what is stored in `prosrc` is
-- exactly what this file says):
--
--   src        one row per OCCUPIED block with charcoal still in it. `kg` is `balance`,
--              the very column the Blocking cell renders; the population is EXACTLY
--              fn_blocking_price_lens's and fn_blocking_age_lens's.
--   sup        src INNER JOINed to view_blocking_block_suppliers on (block_loc,
--              batch_id) — both keys, because that view is keyed on the pair and the
--              grid resolves which batch occupies a slot. A block with no delivery row
--              simply has no `sup` row, which IS the unattributed answer.
--   bal_kg     the apportionment. `share_pct` is the view's own column, verbatim.
--   dom        the dominant supplier per block. `DISTINCT ON` + the fn_blend_block_facts
--              order, so this is that function's rule and not a second one.
--   ranked     the yard's suppliers, ordered by apportioned kg. `x_rn` fixes the order
--              ONCE; `x_band` maps it to a band index, collapsing everything past N onto
--              the single `others` index.
--   bands      one row per band INCLUDING an empty one, so a legend can render the whole
--              scale. The `others` row is emitted only when it has members.
--   shares     over the ATTRIBUTED population, NULL (never 0/0) when nothing in the yard
--              has a supplier at all.
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
           g.balance::numeric AS kg
    FROM public.view_blocking_grid g
    WHERE g.balance > 0
  ),
  sup AS MATERIALIZED (
    SELECT s.block_loc,
           s.batch_id,
           s.kg                                    AS block_kg,
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
           count(*) FILTER (WHERE d.is_mixed)::int          AS mixed_block_count
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
           count(*) FILTER (WHERE is_mixed)::int AS mixed_block_count
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
               'mixed_block_count',        br.mixed_block_count)
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
                'attributed_kg',          at.kg)
              FROM tot t, attributed at)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fn_blocking_supplier_lens(int) IS
'Classify every occupied Blocking block by WHOSE charcoal is in it, for the Blocking page SUPPLIER LENS — the THIRD lens, sibling of fn_blocking_price_lens and fn_blocking_age_lens. NOTHING HERE IS A NEW DEFINITION: supplier identity and the ALL/SOME rule are READ from view_blocking_block_suppliers (which owns canonical_supplier(split_part(supplier, '' - '', 1)) and supplier_count_in_block), and the DOMINANT supplier uses fn_blend_block_facts'' own order (kg DESC, supplier_key ASC) — proven equal to that function on every batch the grid shows, 0 mismatches. is_mixed IS supplier_count_in_block > 1, carried across and never re-derived from the suppliers array. p_top_n is 1..12 (default 6): the yard''s suppliers are ranked by apportioned_kg DESC then display ASC then supplier_key ASC (unique, so the order is total), the first N get a band each at index 0..N-1, and every remaining supplier folds into ONE others band at index N, present if and only if there are more than N suppliers and carrying supplier_keys[] so the UI can name its members. THERE ARE TWO HONEST KILOGRAM ATTRIBUTIONS AND BOTH ARE PUBLISHED, because they answer different questions: dominant_block_count/dominant_kg are the blocks where this supplier is the biggest and their whole balance — WHAT THE GRID TINT SHOWS — while apportioned_kg is this supplier''s own slice of every block it appears in — WHAT THE YARD-SHARE RATIO BAR MUST USE. Measured: MERCADO appears in 11 blocks and dominates none, so publishing only one of the two would state something false. apportioned_kg is a slice of the BALANCE (block balance x share_pct/100), NOT the delivered total: view_blocking_block_suppliers.kg is kilograms DELIVERED and sums to the grid''s total_in, which EXCEEDS the balance by every kilogram ever fed out of an occupied block — a structural gap that grows on every feeding (measured twice ninety minutes apart on 2026-09-22: delivered 10,576,307 kg both times, balance 10,543,087 then 10,515,408, gap 33,220 then 60,899) — so summing it would describe a yard that no longer exists and would break the fold against total.kg; the delivered figure rides alongside as apportioned_delivered_kg and folds to total_in exactly. THE TWO FOLDS ARE EXACT TO DIFFERENT DEGREES, which is stated because it would be easy to claim otherwise: dominant_kg is a plain SUM OF BALANCES so its fold is exactly 0.00, as are the block counts and the delivered fold, while apportioned_kg multiplies by share_pct — itself a numeric DIVISION truncated at a finite scale — so its fold carries that residue, measured 5.896e-14 kg against a 10,515,408 kg yard, about six parts in 10 to the 21st. It is NOT zero and is not claimed to be; the verify script demands an exact 0 where one is deliverable and bounds this one at 1e-6 kg. THE PRO-RATA IS AN APPORTIONMENT, NOT A MEASUREMENT — there is no FIFO by supplier and none is possible, since rc_out records which BATCH kilos left and never whose, the same argument view_analytics_aging_eom records for age; it is exact on a block never fed, and dominant_kg needs no apportionment at all. A block whose batch has NO delivery row has no supplier: it lands in unattributed, in NO band, excluded from both share denominators — the price lens''s unpriced and the age lens''s undated bucket again, and never silently called Others. Therefore sum of dominant_block_count plus unattributed equals total.block_count, sum of dominant_kg and sum of apportioned_kg each plus unattributed.kg equal total.kg to the precision stated above, and both share families sum to 100 over the attributed population. Scope is occupied blocks with a POSITIVE balance, exactly the price and age lenses'' population, so the three describe ONE yard. Every business refusal is jsonb {ok:false, reason, message} written for a human, never a raise: invalid_top_n (NULL, below 1, or above 12). CARRIES NO MONEY AND NONE IS DERIVABLE — cost_basis is never read, avg_php_kg is never selected, and a supplier name beside a kilogram total says nothing about what it cost — so this lens is safe for EVERY role including Production and is deliberately NOT canViewPrices()-gated, unlike its price sibling. authenticated only; anon revoked; service_role deliberately not granted.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §2  Posture
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens(int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_supplier_lens(int) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §3  fn_blocking_supplier_lens_probe — the ACCESS BRIDGE for the verify script
--
-- NOT a "verify everything" function, and the distinction is the 2026-09-14 incident:
-- `fn_ops_ledger_verify()` cross-checked every ops-ledger view over the whole of history
-- in ONE statement, OOM-ed the instance and took the live site down. THIS PROBE ASSERTS
-- NOTHING. It calls the lens a fixed number of times, reads three bounded relations
-- INDEPENDENTLY of it, and hands everything back so every assertion lives in
-- `scripts/verify-blocking-supplier-lens.ts` where a human can read it.
--
-- It exists only because fn_blocking_supplier_lens is `authenticated`-only BY DESIGN and
-- no verify script in this repo holds a user JWT — the same reason
-- fn_blocking_price_lens_probe, fn_blocking_age_lens_probe and fn_blend_block_facts_probe
-- exist, and the same SECURITY DEFINER + service_role-only shape. All THREE of those
-- probes are untouched by this migration.
--
-- What each independent read is FOR:
--   grid            the grid's own totals off view_blocking_grid, so the folds are an
--                   AGREEMENT rather than a tautology.
--   view_rows       view_blocking_block_suppliers per (block_loc, supplier_key) — the
--                   ONE-DEFINITION proof for the per-block kilograms, the share and the
--                   ALL/SOME count.
--   facts_rows      fn_blend_block_facts' own dominant supplier per batch — the proof
--                   that this lens did not invent a third dominance rule.
--   supplier_totals the yard's per-supplier apportioned and delivered kilograms,
--                   aggregated longhand and independently, as a second opinion on the
--                   band folds.
--   folds           THE FOLD GAPS, SUMMED IN `numeric`, for three values of N. These exist
--                   because "gap exactly 0" is a claim that can only be made in exact
--                   decimal arithmetic: re-summing the same bands in JavaScript doubles
--                   leaves a residue (MEASURED: −1.86e-9 kg on the apportioned fold), so a
--                   verify script that added the numbers up itself could only ever assert
--                   "gap < epsilon". Summed here as `numeric`, every kilogram and count gap
--                   is exact where it CAN be (see the exactness note in the header: the
--                   dominant, count and delivered folds are exactly 0; the apportioned fold
--                   and the two share families carry `numeric` division residue). The script
--                   still re-sums in JS to check the SHAPE of every band — it just does not
--                   source any exactness claim from there.
--
-- BOUNDED BY CONSTRUCTION: 8 lens calls over a 170-row grid (238 slots maximum), one
-- 203-row view read, one 170-row fn_blend_block_facts call and one 17-row aggregation.
--
-- IT RETURNS NO ₱ AT ALL — only supplier names, kilograms, counts, shares and booleans.
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
                                         WHERE v.block_loc = g.block_loc)), 0))
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
'Read-only ACCESS BRIDGE so scripts/verify-blocking-supplier-lens.ts can exercise the authenticated-only fn_blocking_supplier_lens with the service-role key it holds. It ASSERTS NOTHING — it calls the lens a fixed number of times, recomputes the grid''s totals and the per-supplier yard aggregation INDEPENDENTLY, reads view_blocking_block_suppliers and fn_blend_block_facts so the one-definition proofs are agreements rather than tautologies, and hands everything back so every assertion lives in the script where a human can read it. Deliberately NOT a whole-database verifier (the 2026-09-14 fn_ops_ledger_verify incident): every population is bounded by construction — one row per occupied block, one row per (block, supplier) pair, one row per supplier. Returns NO money value of any kind. SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() TO service_role;
