-- ─────────────────────────────────────────────────────────────────────────────
-- TWO SMALL DATA-LAYER JOBS FOR THE BLOCKING PAGE
--
--   §1-§3  fn_blend_block_facts  — WHO filled each block in a blend proposal, and
--                                  HOW LONG AGO, reconstructible AS OF a past date
--   §4-§6  fn_blocking_price_lens gains p_rounded_up_php — because A TYPED PRICE IS
--                                  THE LINE ITSELF
--
-- They travel together only because they are one changeset on one page. Neither
-- touches the other's objects, and §4 is the ONLY thing in this file that replaces
-- something that already exists.
--
--
-- ═════════════════════════════════════════════════════════════════════════════
-- §0  JOB 1 — WHY AN AS-OF FUNCTION AND NOT A VIEW
-- ═════════════════════════════════════════════════════════════════════════════
-- The owner wants the blend modal's "Selected blocks" table to say, per block, the
-- supplier picture in the page's EXISTING vocabulary — GREEN when the whole block is
-- one supplier, ORANGE when it is mixed, naming the DOMINANT one — plus how long ago
-- the block was opened and how long ago it was last piled on. The modal renders in two
-- modes and that is the whole design problem:
--
--   LIVE what-if      the operator has just ticked some blocks. "Now" is the answer.
--   SAVED version     `blend_proposal_versions` — and CLAUDE.md's shaping fact for that
--                     feature is that A PROPOSAL IS A STATEMENT ABOUT THE YARD ON A
--                     PARTICULAR DAY. Its `snapshot` is IMMUTABLE and HASHED
--                     (`fn_blend_snapshot_hash`), so the supplier picture cannot be
--                     added to it: every stored snapshot would have to be rewritten,
--                     every hash would move, and a "change to the blend" that was really
--                     a schema change would invent a new version of every proposal.
--
-- So NOTHING ABOUT THE SAVED FEATURE IS TOUCHED — not `fn_blend_proposal_snapshot`, not
-- `fn_blend_snapshot_hash`, not a stored snapshot, not a proposal table, not a grant on
-- one. Instead this is a RECONSTRUCTION: given the batch ids a version already records
-- and the date that version was saved, rebuild the supplier picture and the two ages
-- from `deliveries` as they stood on that day. `p_as_of DEFAULT NULL` means "today, in
-- Asia/Manila", which is exactly what the LIVE modal wants — so ONE function serves both
-- modes and "the whole block is one supplier" can only ever mean one thing.
--
-- KEYED BY `batch_id`, NEVER BY `block_loc`. A block address is REUSED — `location_ref`
-- is cleared when a pile empties — so resolving a saved version by block name would
-- silently describe DIFFERENT charcoal under the same address. That is the same
-- load-bearing rule `lib/blocking/blend-diff.ts::resolveBlendBlocks` already follows,
-- and it is why `fn_blend_proposal_snapshot` records `blocks[].batch_id` at all.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SUPPLIER IDENTITY IS NOT A NEW DEFINITION
-- ─────────────────────────────────────────────────────────────────────────────
-- `canonical_supplier(split_part(supplier, ' - ', 1))`, lifted ARM FOR ARM from
-- `view_blocking_block_suppliers` (migration 20260902145145) including its belt-and-
-- braces `COALESCE(NULLIF(btrim(...), ''), 'UNKNOWN')` — so the blend modal's green/
-- orange and the Blocking page's supplier SEARCH answer to the same names. The origin
-- strip handles a sundry re-entry booked as 'Layupan - JAN-26-BLK9'; MEASURED on this
-- population 2026-09-21, 0 of the 597 joined delivery rows carry a ' - ' suffix at all,
-- so it is a no-op today and can only ever fold a suffixed spelling back onto the seller
-- it names.
--
-- THE GREEN/ORANGE RULE IS A COLUMN: `is_single_supplier`. It is `supplier_count = 1`,
-- computed here, identical in meaning to `view_blocking_block_suppliers
-- .supplier_count_in_block = 1`, and PROVEN equal to it for `p_as_of = today` on every
-- batch the grid shows (0 mismatches on the count, the flag AND the per-supplier
-- kilograms — `scripts/verify-blend-block-facts.ts`). A caller must never re-derive it
-- from `suppliers` length; that is how the two screens would eventually disagree.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- "OPENED" MEANS THE FIRST DELIVERY, NOT THE FIRST FEEDING
-- ─────────────────────────────────────────────────────────────────────────────
-- `first_delivery_date` is the earliest delivery into the batch at or before the as-of
-- date and `last_delivery_date` the latest, so `days_since_opened` reads "opened /
-- created <n> days ago" and `days_since_last_piled` reads "last piled on <n> days ago".
-- Neither has anything to do with `rc_out`: a block is OPENED when charcoal first
-- arrives in it, and it is CLOSED (a `rc_out` fact, `view_rc_movement_block_actual_price
-- .close_date`) when it stops being fed. Do not read one for the other.
--
-- These two dates are DELIBERATELY NOT AN AGE. `view_batch_age_days.age_days` is THE
-- age of a batch — the kg-WEIGHTED MEAN delivery date carried by the remaining balance —
-- and the Blocking AGE LENS reads it. A first/last date is a different, simpler fact
-- ("when did this pile start, when did it last grow"), and the two must not be confused:
-- there is no second age definition here and none is derivable from these columns.
-- The two ARE reconciled: the verify script requires this function's
-- `first_delivery_date` / `last_delivery_date` to equal `view_batch_age_days`' own
-- columns of the same name on every batch both cover, and the DATED populations to be
-- the same set.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NULL IS NEVER 0, AND AN UNKNOWN ID IS NOT A ROW
-- ─────────────────────────────────────────────────────────────────────────────
-- A batch with NO delivery at or before the as-of date has no supplier and no dates, so
-- it returns a row with `supplier_count = 0`, `delivery_count = 0`, `suppliers = []`,
-- and NULL on `dominant_supplier_key` / `_display` / `dominant_share_pct` /
-- `is_single_supplier` / both dates / both day counts. It is NOT 0 days old and it is
-- NOT single-supplier: a blank cell is the honest answer, and calling it green would
-- paint a certainty on a pile nobody has delivered into yet. `suppliers` is the one
-- deliberate exception — an EMPTY ARRAY, never NULL, because a list of suppliers with
-- nothing in it is itself a fact and every caller can iterate it safely.
--
-- A `p_batch_ids` element that is NOT a row in `batches` returns NO ROW AT ALL (the join
-- is an inner one). So the result may be SHORTER than the input list, and a caller's
-- record may lack a key it asked for — which is the truthful answer to "tell me about
-- this batch" when there is no such batch. Never fill such a gap with zeroes.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO ₱ ANYWHERE, THEREFORE NO PRICE GATE (the AGE-LENS posture, not the PRICE-LENS one)
-- ─────────────────────────────────────────────────────────────────────────────
-- Not one column here is money and none is derivable from these columns: suppliers,
-- kilograms, shares, dates and day counts. `cost_basis` is never read. So
-- `fetchBlendBlockFacts` has NO `canViewPrices()` call and this is safe for EVERY role
-- INCLUDING Production — the same posture as `view_blocking_block_suppliers` and
-- `fn_blocking_age_lens`, and the OPPOSITE of `fn_blocking_price_lens`, whose band
-- membership alone pins a block's ₱/kg to within a peso. Do not "tidy up" the asymmetry.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- COST, MEASURED BEFORE ANY PROOF WAS WRITTEN (the 2026-09-14 rule)
-- ─────────────────────────────────────────────────────────────────────────────
-- `set local statement_timeout='5s'` then EXPLAIN (ANALYZE, BUFFERS), 2026-09-21:
--   the whole query below, inline, over ALL 167 grid batches   29.7 ms /   245 buffers
--   the same as a FUNCTION CALL, 167 ids (warm)                31.7 ms / 1,451 buffers
--     of which the caller's own view_blocking_grid scan,
--     used only to obtain the id list, is                       1.5 ms /   111 buffers
--   a REALISTIC blend — 3 batch ids                             7.3 ms /   953 buffers
--   (first call after creation read 73.5 ms with 16 ms of
--    plpgsql/sql planning; the warm figures above are the ones to compare against)
-- The dominant cost is `canonical_supplier()` evaluated per delivery row (the `del` CTE
-- accounts for ~23 of those ms), and the population is bounded BY CONSTRUCTION: one pass
-- over `deliveries` (1,765 rows) whatever the id list contains, so a longer list cannot
-- turn this into a whole-history scan. The server action caps the list at 250 anyway.
--
-- THE `MATERIALIZED` HINTS are explicit insurance, exactly as the age lens records:
-- Postgres 12+ already materializes a CTE referenced more than once, and `del` is read
-- twice and `sup` once — the hints exist so that a future edit leaving a SINGLE
-- reference to one of these expensive subtrees cannot silently re-inline it. They did
-- not buy the number above and are not claimed to.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY EVERY INTERNAL ALIAS IS PREFIXED `x_`
-- ─────────────────────────────────────────────────────────────────────────────
-- In a LANGUAGE sql function the RETURNS TABLE column names are also names in scope, so
-- an internal column called `batch_id` or `supplier_count` makes the final SELECT's
-- references ambiguous — the same trap `fn_blocking_market_bases` records with its
-- `k_` prefixes. Reusing that idiom rather than inventing one.
-- ═════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════
-- §1  fn_blend_block_facts — the supplier picture and the two ages, AS OF a date
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blend_block_facts(
  p_batch_ids uuid[],
  p_as_of     date DEFAULT NULL
)
RETURNS TABLE (
  batch_id                  uuid,
  batch_code                text,
  as_of                     date,
  supplier_count            int,
  dominant_supplier_key     text,
  dominant_supplier_display text,
  dominant_share_pct        numeric,
  is_single_supplier        boolean,
  suppliers                 jsonb,
  first_delivery_date       date,
  last_delivery_date        date,
  days_since_opened         int,
  days_since_last_piled     int,
  delivery_count            int
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH anchor AS (
    -- NULL as-of = TODAY in Asia/Manila. The clock is named once, here.
    SELECT COALESCE(p_as_of, (now() AT TIME ZONE 'Asia/Manila')::date) AS x_as_of
  ),
  ids AS (
    SELECT DISTINCT u.x_id
    FROM unnest(p_batch_ids) AS u(x_id)
    WHERE u.x_id IS NOT NULL
  ),
  tgt AS MATERIALIZED (
    -- An INNER join: an id that is not a batch yields no row. See the header.
    SELECT b.id AS x_batch_id, b.batch_code AS x_code
    FROM ids
    JOIN public.batches b ON b.id = ids.x_id
  ),
  del AS MATERIALIZED (
    -- Every delivery into those batches AT OR BEFORE the as-of date. `batch_code` is the
    -- link (CLAUDE.md: batch_code is text-based linking, not uuid), which is the same
    -- join `view_blocking_grid` and `view_blocking_block_suppliers` make.
    SELECT t.x_batch_id,
           COALESCE(
             NULLIF(btrim(public.canonical_supplier(split_part(d.supplier, ' - ', 1))), ''),
             'UNKNOWN'
           )                                     AS x_key,
           d.supplier                            AS x_raw,
           COALESCE(d.weight_kg, 0::numeric)     AS x_kg,
           d.transaction_date                    AS x_date
    FROM tgt t
    JOIN public.deliveries d ON d.batch_code = t.x_code
    CROSS JOIN anchor a
    WHERE d.transaction_date IS NOT NULL
      AND d.transaction_date <= a.x_as_of
  ),
  sup AS MATERIALIZED (
    SELECT del.x_batch_id,
           del.x_key,
           -- A representative RAW spelling, for display only — never for matching.
           mode() WITHIN GROUP (ORDER BY del.x_raw) AS x_display,
           sum(del.x_kg)                            AS x_kg,
           count(*)::int                            AS x_n
    FROM del
    GROUP BY del.x_batch_id, del.x_key
  ),
  ranked AS (
    -- One pass: the per-batch totals ride along as window functions so nothing has to be
    -- re-grouped, and `x_rn` fixes the order ONCE — biggest kilograms first, and on a
    -- tie the alphabetically-first canonical key, so two equally large suppliers can
    -- never make consecutive calls disagree about which one is "dominant".
    SELECT sup.x_batch_id, sup.x_key, sup.x_display, sup.x_kg, sup.x_n,
           sum(sup.x_kg)  OVER (PARTITION BY sup.x_batch_id)        AS x_batch_kg,
           count(*)       OVER (PARTITION BY sup.x_batch_id)::int   AS x_supplier_count,
           sum(sup.x_n)   OVER (PARTITION BY sup.x_batch_id)::int   AS x_batch_n,
           row_number()   OVER (PARTITION BY sup.x_batch_id
                                ORDER BY sup.x_kg DESC, sup.x_key ASC) AS x_rn
    FROM sup
  ),
  agg AS (
    SELECT r.x_batch_id,
           max(r.x_supplier_count) AS x_supplier_count,
           max(r.x_batch_n)        AS x_delivery_count,
           (array_agg(r.x_key     ORDER BY r.x_rn))[1] AS x_dom_key,
           (array_agg(r.x_display ORDER BY r.x_rn))[1] AS x_dom_display,
           -- NULL, never 0, when the batch's dated deliveries weigh nothing at all.
           (array_agg(CASE WHEN r.x_batch_kg > 0 THEN r.x_kg * 100.0 / r.x_batch_kg END
                      ORDER BY r.x_rn))[1]             AS x_dom_share,
           jsonb_agg(jsonb_build_object(
                       'key',       r.x_key,
                       'display',   r.x_display,
                       'kg',        r.x_kg,
                       'share_pct', CASE WHEN r.x_batch_kg > 0
                                         THEN r.x_kg * 100.0 / r.x_batch_kg END)
                     ORDER BY r.x_rn)                  AS x_suppliers
    FROM ranked r
    GROUP BY r.x_batch_id
  ),
  dates AS (
    SELECT del.x_batch_id,
           min(del.x_date) AS x_first,
           max(del.x_date) AS x_last,
           count(*)::int   AS x_n
    FROM del
    GROUP BY del.x_batch_id
  )
  SELECT t.x_batch_id,
         t.x_code,
         a.x_as_of,
         COALESCE(agg.x_supplier_count, 0),
         agg.x_dom_key,
         agg.x_dom_display,
         agg.x_dom_share,
         -- THE green/orange rule, as a COLUMN. NULL (neither) when nothing is delivered.
         CASE WHEN agg.x_supplier_count IS NOT NULL THEN agg.x_supplier_count = 1 END,
         -- An empty LIST, never NULL — see the header.
         COALESCE(agg.x_suppliers, '[]'::jsonb),
         dates.x_first,
         dates.x_last,
         (a.x_as_of - dates.x_first),
         (a.x_as_of - dates.x_last),
         COALESCE(dates.x_n, 0)
  FROM tgt t
  CROSS JOIN anchor a
  LEFT JOIN agg   ON agg.x_batch_id   = t.x_batch_id
  LEFT JOIN dates ON dates.x_batch_id = t.x_batch_id
  ORDER BY t.x_code;
$$;

COMMENT ON FUNCTION public.fn_blend_block_facts(uuid[], date) IS
'Per BATCH: who filled it, how concentrated that is, when it was opened and when it was last piled on — reconstructed AS OF a date. Built for the Blend Proposal "Selected blocks" table (the live modal, a SAVED version''s viewer and the landscape print), and keyed by batch_id NEVER block_loc, because a block address is reused when a pile empties and resolving by name would silently describe different charcoal. p_as_of NULL means TODAY in Asia/Manila (what the live modal wants); a saved version passes the Asia/Manila date its version was created, and only deliveries with transaction_date <= that date are considered — so nothing about blend_proposal_versions, fn_blend_proposal_snapshot or fn_blend_snapshot_hash had to change, and no stored snapshot moved. SUPPLIER IDENTITY is public.canonical_supplier(split_part(supplier, '' - '', 1)), lifted arm for arm from view_blocking_block_suppliers so the blend modal and the Blocking supplier search answer to the same names; an identity that resolves to nothing is the literal UNKNOWN. THE GREEN/ORANGE RULE IS THE COLUMN is_single_supplier (= supplier_count = 1, identical in meaning to view_blocking_block_suppliers.supplier_count_in_block = 1 and proven equal to it for as_of = today on every batch the grid shows) — never re-derive it from the suppliers array. "OPENED" IS THE FIRST DELIVERY, not the first feeding: first_delivery_date/last_delivery_date and their day counts are about arrivals, and closure is an rc_out fact living in view_rc_movement_block_actual_price.close_date. They are NOT an age — view_batch_age_days.age_days (the kg-weighted mean delivery date) remains THE age of a batch and this function does not add a second definition; the two dates are proven equal to that view''s own columns of the same name. NULL IS NEVER 0: a batch with no delivery at or before the as-of date reads supplier_count 0, delivery_count 0, suppliers [] and NULL on every dominant field, both dates and both day counts — it is not 0 days old and it is not single-supplier. suppliers is the one exception, an EMPTY ARRAY never NULL, because a list with nothing in it is itself a fact. A p_batch_ids element that is not a row in batches returns NO ROW, so the result may be shorter than the input list; never fill that gap with zeroes. CARRIES NO MONEY AND NONE IS DERIVABLE — no cost/price/value column exists here and cost_basis is never read — so this is safe for EVERY role including Production and is deliberately NOT canViewPrices()-gated, unlike fn_blocking_price_lens. Cost is bounded by construction: one pass over deliveries whatever the id list contains (measured 29.7 ms / 245 buffers over all 167 occupied blocks, 2026-09-21); the server action caps the list at 250. authenticated only; anon revoked; service_role deliberately not granted.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §2  Posture for §1
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.fn_blend_block_facts(uuid[], date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blend_block_facts(uuid[], date) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blend_block_facts(uuid[], date) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §3  fn_blend_block_facts_probe — the ACCESS BRIDGE for the verify script
--
-- NOT a "verify everything" function, and the distinction is the 2026-09-14 incident:
-- `fn_ops_ledger_verify()` cross-checked every ops-ledger view over the whole of history
-- in ONE statement, OOM-ed the instance and took the live site down. THIS PROBE ASSERTS
-- NOTHING. It calls fn_blend_block_facts a fixed number of times, reads three bounded
-- relations INDEPENDENTLY of it, and hands everything back so every assertion lives in
-- `scripts/verify-blend-block-facts.ts` where a human can read it.
--
-- It exists only because fn_blend_block_facts is `authenticated`-only BY DESIGN and no
-- verify script in this repo holds a user JWT — the same reason
-- fn_blocking_price_lens_probe and fn_blocking_age_lens_probe exist, and the same
-- SECURITY DEFINER + service_role-only shape. Both of THOSE probes are untouched by §3;
-- §6 below touches the price one for an unrelated and unavoidable reason.
--
-- What each independent read is FOR:
--   facts_today       the function over every batch the grid shows (167), the population
--                     the equality proofs are measured on.
--   view_rows         view_blocking_block_suppliers per (batch_id, supplier_key) — the
--                     ONE-DEFINITION proof for the count, the flag and the kilograms.
--                     An AGREEMENT, not a tautology: that view reads the grid, this
--                     function reads a uuid list.
--   age_view_rows     view_batch_age_days' own first/last delivery dates, so the two
--                     date families are reconciled rather than assumed compatible.
--   out_of_window     deliveries dated AFTER today or with no date at all, among those
--                     batches. It is 0 / 0 today (measured 2026-09-21), which is WHY the
--                     as_of = today equality can be exact; if it ever stops being 0 this
--                     key is what explains the failure instead of leaving a mystery.
--   flip_candidate    a REAL mixed block whose second supplier arrived later, with the
--                     cut date that makes it read single-supplier — so the as-of rule is
--                     proven on live data rather than on a fixture. NULL when today's
--                     yard contains no such block; the script then says so out loud
--                     rather than passing vacuously.
--   undated_case      the same batch as of 2000-01-01 (before any delivery), the NULL-
--                     never-0 proof; plus an id that is not a batch at all.
--
-- BOUNDED BY CONSTRUCTION: 4 function calls, one 167-row grid population, one ~200-row
-- view read and one ~659-row age-view read. IT RETURNS NO ₱ OF ANY KIND.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_blend_block_facts_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_of   date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_ids     uuid[];
  v_flip    jsonb;
  v_flip_id uuid;
  v_flip_cut date;
  v_one     uuid;
BEGIN
  SELECT array_agg(g.batch_id) INTO v_ids FROM public.view_blocking_grid g;

  -- A REAL orange -> green case, discovered live: a mixed batch for which exactly ONE
  -- supplier had delivered before its last-arriving supplier's first delivery.
  WITH grid AS (SELECT g.batch_id, g.batch_code FROM public.view_blocking_grid g),
  firsts AS (
    SELECT grid.batch_id,
           grid.batch_code,
           COALESCE(
             NULLIF(btrim(public.canonical_supplier(split_part(d.supplier, ' - ', 1))), ''),
             'UNKNOWN') AS k,
           min(d.transaction_date) AS first_seen
    FROM grid
    JOIN public.deliveries d ON d.batch_code = grid.batch_code
    WHERE d.transaction_date IS NOT NULL
    GROUP BY 1, 2, 3
  ),
  shaped AS (
    SELECT f.batch_id, f.batch_code,
           count(*)::int          AS supplier_count,
           max(f.first_seen)      AS newest_supplier_date,
           count(*) FILTER (WHERE f.first_seen < (SELECT max(f2.first_seen)
                                                    FROM firsts f2
                                                   WHERE f2.batch_id = f.batch_id))::int
                                  AS before_count
    FROM firsts f
    GROUP BY f.batch_id, f.batch_code
  )
  SELECT s.batch_id, s.newest_supplier_date - 1
    INTO v_flip_id, v_flip_cut
  FROM shaped s
  WHERE s.supplier_count > 1 AND s.before_count = 1
  ORDER BY s.newest_supplier_date DESC, s.batch_code
  LIMIT 1;

  IF v_flip_id IS NOT NULL THEN
    v_flip := jsonb_build_object(
      'batch_id', v_flip_id,
      'cut_date', v_flip_cut,
      'today',  (SELECT to_jsonb(f) FROM public.fn_blend_block_facts(ARRAY[v_flip_id]) f),
      'at_cut', (SELECT to_jsonb(f) FROM public.fn_blend_block_facts(ARRAY[v_flip_id], v_flip_cut) f));
  END IF;

  SELECT g.batch_id INTO v_one FROM public.view_blocking_grid g ORDER BY g.batch_code LIMIT 1;

  RETURN jsonb_build_object(
    'manila_today', v_as_of,
    'grid_batch_count', COALESCE(cardinality(v_ids), 0),

    'facts_today', COALESCE((
      SELECT jsonb_agg(to_jsonb(f) ORDER BY f.batch_code)
      FROM public.fn_blend_block_facts(v_ids) f), '[]'::jsonb),

    'view_rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'batch_id', v.batch_id,
               'supplier_key', v.supplier_key,
               'kg', v.kg,
               'supplier_count_in_block', v.supplier_count_in_block)
             ORDER BY v.batch_id, v.supplier_key)
      FROM public.view_blocking_block_suppliers v), '[]'::jsonb),

    'age_view_rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'batch_code', a.batch_code,
               'first_delivery_date', a.first_delivery_date,
               'last_delivery_date', a.last_delivery_date)
             ORDER BY a.batch_code)
      FROM public.view_batch_age_days a
      WHERE a.batch_code IN (SELECT b.batch_code FROM public.batches b
                              WHERE b.id = ANY (v_ids))), '[]'::jsonb),

    'out_of_window', (
      SELECT jsonb_build_object(
          'future_dated', count(*) FILTER (WHERE d.transaction_date > v_as_of)::int,
          'null_dated',   count(*) FILTER (WHERE d.transaction_date IS NULL)::int)
      FROM public.deliveries d
      JOIN public.batches b ON b.batch_code = d.batch_code
      WHERE b.id = ANY (v_ids)),

    'flip_candidate', v_flip,

    'undated_case', jsonb_build_object(
      'batch_id', v_one,
      'row', (SELECT to_jsonb(f) FROM public.fn_blend_block_facts(ARRAY[v_one], '2000-01-01'::date) f)),

    -- A syntactically valid uuid that is not a batch. It must yield NO ROW.
    'unknown_id_row_count', (
      SELECT count(*)::int FROM public.fn_blend_block_facts(
        ARRAY['00000000-0000-0000-0000-000000000000'::uuid]) f),
    'empty_input_row_count', (
      SELECT count(*)::int FROM public.fn_blend_block_facts(ARRAY[]::uuid[]) f),
    'null_input_row_count', (
      SELECT count(*)::int FROM public.fn_blend_block_facts(NULL::uuid[]) f),

    'posture', jsonb_build_object(
      'facts_authenticated', has_function_privilege('authenticated', 'public.fn_blend_block_facts(uuid[], date)', 'EXECUTE'),
      'facts_anon',          has_function_privilege('anon',          'public.fn_blend_block_facts(uuid[], date)', 'EXECUTE'),
      'facts_service_role',  has_function_privilege('service_role',  'public.fn_blend_block_facts(uuid[], date)', 'EXECUTE'),
      'probe_authenticated', has_function_privilege('authenticated', 'public.fn_blend_block_facts_probe()', 'EXECUTE'),
      'probe_anon',          has_function_privilege('anon',          'public.fn_blend_block_facts_probe()', 'EXECUTE'),
      'probe_service_role',  has_function_privilege('service_role',  'public.fn_blend_block_facts_probe()', 'EXECUTE'),
      'facts_invoker',       (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public' AND p.proname = 'fn_blend_block_facts'
                                 AND p.prosecdef = false),
      'stable_count',        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public'
                                 AND p.proname IN ('fn_blend_block_facts', 'fn_blend_block_facts_probe')
                                 AND p.provolatile = 's'),
      'search_path_pinned',  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public'
                                 AND p.proname IN ('fn_blend_block_facts', 'fn_blend_block_facts_probe')
                                 AND p.proconfig @> ARRAY['search_path=public']),
      'commented',           (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public' AND p.proname = 'fn_blend_block_facts'
                                 AND obj_description(p.oid, 'pg_proc') IS NOT NULL),
      -- Every published column name, read from the catalog, so the "no money column"
      -- assertion is measured rather than eyeballed off the migration text.
      'facts_columns',       (SELECT to_jsonb(p.proargnames) FROM pg_proc p
                               JOIN pg_namespace n ON n.oid = p.pronamespace
                              WHERE n.nspname = 'public' AND p.proname = 'fn_blend_block_facts')
    )
  );
END;
$$;

COMMENT ON FUNCTION public.fn_blend_block_facts_probe() IS
'Read-only ACCESS BRIDGE so scripts/verify-blend-block-facts.ts can exercise the authenticated-only fn_blend_block_facts with the service-role key it holds. It ASSERTS NOTHING — it calls the function a fixed number of times, reads view_blocking_block_suppliers and view_batch_age_days INDEPENDENTLY so the equality proofs are agreements rather than tautologies, discovers a REAL mixed block whose second supplier arrived later (so the as-of rule is proven on live data, not a fixture), and hands everything back so every assertion lives in the script where a human can read it. Deliberately NOT a whole-database verifier (the 2026-09-14 fn_ops_ledger_verify incident): every population is bounded by construction — one row per occupied block, one row per (block, supplier), one row per batch code with a delivery. Returns NO money value of any kind. SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blend_block_facts_probe() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blend_block_facts_probe() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blend_block_facts_probe() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blend_block_facts_probe() TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- §4  JOB 2 — A TYPED PRICE IS THE LINE ITSELF
--
-- `fn_blocking_price_lens` rounds the market price UP to `R = floor(market) + 1`. That
-- is RIGHT for a MEASURED market and the reasoning is unchanged: the operator's own
-- sentence is "if market is 40.23 then ₱41 and up is above market", and rounding up even
-- on an exactly-whole measured figure keeps the market price ITSELF inside the at-market
-- band `[R−1, R)` rather than promoting it to "above market".
--
-- It is WRONG for the `manual` basis. There the operator TYPES the line: they meant ₱41
-- and up to be above market, and got `R = floor(41) + 1 = 42`, i.e. a lens one peso
-- looser than the one they asked for. A typed 41 is not a measurement that happens to be
-- whole — it IS the cut line.
--
-- So the function gains an OPTIONAL third parameter. When given, it IS R. When NULL,
-- behaviour is BYTE-IDENTICAL to today (proven by comparing the two payloads key for
-- key in scripts/verify-blocking-price-lens.ts), so every existing caller, the four
-- computed bases and the whole stored UI configuration are unaffected.
--
--   fn_blocking_price_lens(40.23)                 R = 41   (unchanged)
--   fn_blocking_price_lens(41)                    R = 42   (unchanged)
--   fn_blocking_price_lens(41, ARRAY[-1,0], 41)   R = 41   -> bands cut at 40 and 41,
--                                                            so ₱41 IS above market
--
-- THE UI RULE, recorded here and in the CONTEXT: for the `manual` basis pass
-- `roundedUpPhp = ceil(typed price)` (41 -> 41, 40.5 -> 41); for EVERY measured basis
-- pass nothing. R is still computed in exactly one place for a measured market.
--
-- A SIGNATURE CHANGE MEANS DROP + CREATE, not CREATE OR REPLACE — Postgres will not
-- change a function's argument list in place. `DROP FUNCTION` takes its GRANTS and its
-- COMMENT with it, so both are re-applied in §5 of this same file (the
-- `cenapro_delete_rc_delivery` precedent: DROP + CREATE, never an overload, and the
-- grants re-applied in the same migration). An OVERLOAD was rejected deliberately: two
-- functions named `fn_blocking_price_lens` is two places for the band logic to live,
-- which is the very thing the original migration's two-function split exists to prevent.
-- ═════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.fn_blocking_price_lens(numeric, int[]);

CREATE FUNCTION public.fn_blocking_price_lens(
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

  -- ── R. A GIVEN cut line IS R — a typed price is the line itself (see §4). Otherwise
  -- the measured rule, written down exactly once: see the header of migration
  -- 20260919025729 for why it rounds up even on a whole number.
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


-- ═════════════════════════════════════════════════════════════════════════════
-- §5  The COMMENT and the GRANTS the DROP took with it, re-applied verbatim
--     plus one paragraph for the new parameter. `DROP FUNCTION` discards both, so
--     leaving either out of this file would silently un-posture a ₱-bearing function.
-- ═════════════════════════════════════════════════════════════════════════════
COMMENT ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) IS
'Classify every occupied Blocking block against a GIVEN market PHP/kg, for the Blocking page price lens. It takes the market price as an argument on purpose, so the four computed bases from fn_blocking_market_bases and a manually typed price share ONE classifier. R = floor(market) + 1 (40.23 -> 41, 39.8568 -> 40, and 40.00 -> 41 so the market price itself stays inside the at-market band). A TYPED PRICE IS THE LINE ITSELF, so p_rounded_up_php (2026-09-21) OVERRIDES R when given: the operator who types PHP 41 means PHP 41 and up is above market, and the measured rule would have given them 42. It must be a whole number of at least 1 (refusal invalid_rounded_up); NULL is not a refusal, it is the "compute R from the market price" signal, and with NULL the payload is BYTE-IDENTICAL to the pre-override function. THE UI RULE: for the manual basis pass ceil(typed price); for every measured basis pass nothing. p_edge_offsets is a list of whole-peso offsets from R, de-duplicated and sorted; k edges give k+1 half-open [lower, upper) bands with the first open below (lower_php null) and the last open above (upper_php null); default ARRAY[-1,0] gives below / at market / above market. The per-block price is view_blocking_grid.avg_php_kg, the same column the cell displays — never a second definition. A block with NO price (null or 0, the L-008 unpriced placeholder — NULL is never PHP 0) lands in "unpriced", in no band, and is excluded from both share denominators, so sum of band counts plus unpriced equals total and each share family sums to 100 over the priced population. Every business refusal is jsonb {ok:false, reason, message} written for a human, never a raise: no_market_price, invalid_market_price, invalid_rounded_up, invalid_edge, no_edges, too_many_edges. CARRIES MONEY EVEN WHERE IT LOOKS LIKE IT DOES NOT — band membership alone pins a block''s PHP/kg to within a peso, so there is no price-free half of this payload: the server action refuses a canViewPrices()-denied caller BEFORE calling rather than nulling fields after. authenticated only; anon revoked; service_role deliberately not granted.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- §6  fn_blocking_price_lens_probe — updated, because it names the OLD signature
--
-- The probe's `posture` block calls `has_function_privilege(role,
-- 'public.fn_blocking_price_lens(numeric, int[])', 'EXECUTE')`, and that form RESOLVES
-- the signature: after §4 no function with those argument types exists, so every call
-- of the probe would fail outright. This is therefore not an optional tidy-up — the
-- probe HAD to move in the same migration as the signature.
--
-- Everything else is unchanged; four keys are ADDED for the new parameter, and the
-- first of them is the byte-identity proof (override NULL against no override at all).
-- The age-lens probe and the new §3 probe are untouched.
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

    -- THE ROUNDED-UP OVERRIDE (2026-09-21). `override_null` must be byte-identical to
    -- `lens_live`, which is the whole compatibility claim; `override_41_market_41` is
    -- the typed-price case beside `r_41_no_override`, the measured rule on the same
    -- number, so the one-peso difference the owner reported is visible side by side.
    'override_null',          public.fn_blocking_price_lens(v_price, ARRAY[-1, 0], NULL),
    'override_41_market_41',  public.fn_blocking_price_lens(41, ARRAY[-1, 0], 41),
    'r_41_no_override',       public.fn_blocking_price_lens(41),
    'refusal_override_zero',  public.fn_blocking_price_lens(40, ARRAY[-1, 0], 0),
    'refusal_override_negative', public.fn_blocking_price_lens(40, ARRAY[-1, 0], -5),

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
      -- Exactly ONE fn_blocking_price_lens must exist: an OVERLOAD would be a second
      -- home for the band logic, which is what the DROP + CREATE avoided.
      'lens_overload_count', (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public' AND p.proname = 'fn_blocking_price_lens'),
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
'Read-only ACCESS BRIDGE so scripts/verify-blocking-price-lens.ts can exercise the authenticated-only price-lens functions with the service-role key it holds. It ASSERTS NOTHING — it calls them a fixed number of times, reads the same three statistics straight from view_analytics_rcin_monthly and the grid''s own totals independently, exercises the p_rounded_up_php override (including the byte-identity case where the override is NULL), and hands everything back so every assertion lives in the script where a human can read it. Deliberately NOT a whole-database verifier (the 2026-09-14 fn_ops_ledger_verify incident): both populations are bounded by construction — one row per occupied block, and a delivery window clamped to 400 days. SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) TO service_role;
