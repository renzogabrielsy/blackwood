-- ─────────────────────────────────────────────────────────────────────────────
-- view_blocking_block_suppliers — WHO filled each block on the Blocking grid
--
-- Built for the Blocking page's supplier search: the operator types a supplier and
-- every active block lights GREEN when ALL of its charcoal came from that supplier,
-- ORANGE when only SOME did. That ALL-vs-SOME test is `supplier_count_in_block = 1`,
-- which is why the count is a COLUMN here and is never re-derived by a caller.
--
-- One row per (block_loc, batch_id, supplier_key) over exactly the blocks
-- `view_blocking_grid` shows — this view SELECTs from that view rather than
-- re-deriving the "which batch occupies which slot" rule (the grid resolves it with
-- DISTINCT ON (location_ref)), so the two can never disagree about what is on screen.
-- Deliveries are joined on `batch_code`, the same join and the same grain the grid's
-- own `total_in` is summed over, so Σ kg per block equals `total_in` exactly.
--
-- SUPPLIER IDENTITY is `public.canonical_supplier()`, the ONE definition — never a
-- TypeScript port. The argument is the P3 origin-stripped form
-- `canonical_supplier(split_part(supplier, ' - ', 1))`, so a sundry re-entry booked as
-- 'Layupan - JAN-26-BLK9' attributes to LAYUPAN rather than inventing a phantom
-- supplier. MEASURED on this view's own population (2026-09-02): 0 of 600 joined
-- delivery rows carry a ' - ' suffix at all, so the strip is a no-op here today and
-- can only ever fold a suffixed spelling back onto the seller it names.
--
-- NO ₱ COLUMN AND NONE DERIVABLE — kg, counts and shares only. Safe for every role
-- including Production; needs no canViewPrices() gate and no server-side nulling.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.view_blocking_block_suppliers
WITH (security_invoker = true) AS
WITH grid AS (
  SELECT g.block_loc,
         g.batch_id,
         g.batch_code
  FROM public.view_blocking_grid g
),
src AS (
  SELECT grid.block_loc,
         grid.batch_id,
         grid.batch_code,
         -- canonical_supplier() already collapses NULL/blank to 'UNKNOWN'; the
         -- COALESCE/NULLIF is a belt-and-braces guard, not a second identity rule.
         COALESCE(
           NULLIF(btrim(public.canonical_supplier(split_part(d.supplier, ' - ', 1))), ''),
           'UNKNOWN'
         ) AS supplier_key,
         d.supplier AS supplier_raw,
         COALESCE(d.weight_kg, 0::numeric) AS weight_kg
  FROM grid
  JOIN public.deliveries d ON d.batch_code = grid.batch_code
),
agg AS (
  SELECT src.block_loc,
         src.batch_id,
         src.batch_code,
         src.supplier_key,
         mode() WITHIN GROUP (ORDER BY src.supplier_raw) AS supplier_display,
         sum(src.weight_kg)                              AS kg,
         count(*)::integer                               AS delivery_count
  FROM src
  GROUP BY src.block_loc, src.batch_id, src.batch_code, src.supplier_key
)
SELECT agg.block_loc,
       agg.batch_id,
       agg.batch_code,
       agg.supplier_key,
       agg.supplier_display,
       agg.kg,
       agg.delivery_count,
       CASE
         WHEN sum(agg.kg) OVER (PARTITION BY agg.block_loc) > 0
         THEN agg.kg * 100.0 / sum(agg.kg) OVER (PARTITION BY agg.block_loc)
       END                                                  AS share_pct,
       count(*) OVER (PARTITION BY agg.block_loc)::integer   AS supplier_count_in_block,
       sum(agg.kg) OVER (PARTITION BY agg.block_loc)         AS block_total_in_kg
FROM agg;

COMMENT ON VIEW public.view_blocking_block_suppliers IS
'One row per (block_loc, batch_id, supplier) over exactly the blocks the Blocking grid shows (view_blocking_grid), saying how many kilograms in that block came from that supplier. Feeds the Blocking page supplier search: a block is ALL that supplier when supplier_count_in_block = 1 (highlight green) and only SOME of it when supplier_count_in_block > 1 (highlight orange) — read that column, never re-derive the test. Supplier identity is public.canonical_supplier() applied to the origin-stripped spelling (split_part(supplier, '' - '', 1)), the one definition of who a supplier is, so folded spellings and sundry re-entries attribute to the real seller; a key that still resolves to nothing is grouped under the literal UNKNOWN. Sum of kg per block equals the grid''s own total_in and sum of share_pct per block is 100. Carries NO peso column and none derivable, so it is safe for every role including Production and needs no price gate.';

COMMENT ON COLUMN public.view_blocking_block_suppliers.block_loc               IS 'Block slot on the Blocking grid, e.g. A-12B — the same key view_blocking_grid emits.';
COMMENT ON COLUMN public.view_blocking_block_suppliers.batch_id                IS 'The batch currently occupying that slot, as resolved by view_blocking_grid.';
COMMENT ON COLUMN public.view_blocking_block_suppliers.batch_code              IS 'That batch''s text code — the column deliveries are joined on.';
COMMENT ON COLUMN public.view_blocking_block_suppliers.supplier_key            IS 'Canonical supplier identity from public.canonical_supplier(split_part(supplier, '' - '', 1)); the literal UNKNOWN when it resolves to nothing. Match the operator''s search against this.';
COMMENT ON COLUMN public.view_blocking_block_suppliers.supplier_display        IS 'A representative raw spelling of that supplier as typed on the deliveries (the most common one in this block) — for display only, never for matching.';
COMMENT ON COLUMN public.view_blocking_block_suppliers.kg                      IS 'Kilograms delivered into this block by this supplier.';
COMMENT ON COLUMN public.view_blocking_block_suppliers.delivery_count          IS 'How many delivery rows those kilograms came in on.';
COMMENT ON COLUMN public.view_blocking_block_suppliers.share_pct               IS 'This supplier''s share of the block''s delivered kilograms, 0-100 (a PERCENT, not a fraction). Sums to 100 across the block.';
COMMENT ON COLUMN public.view_blocking_block_suppliers.supplier_count_in_block IS 'How many distinct suppliers filled this block. 1 = the whole block is one supplier (ALL / green); more than 1 = mixed (SOME / orange).';
COMMENT ON COLUMN public.view_blocking_block_suppliers.block_total_in_kg       IS 'Total kilograms ever delivered into this block — equals view_blocking_grid.total_in for the same block.';

-- Posture: same as the analytics views. Readable by the app; never by anon; the sync
-- worker does not read it, so service_role is deliberately NOT granted (L-044's arrow
-- direction — a consumer is not a dependency).
REVOKE ALL ON public.view_blocking_block_suppliers FROM PUBLIC;
REVOKE ALL ON public.view_blocking_block_suppliers FROM anon;
GRANT SELECT ON public.view_blocking_block_suppliers TO authenticated;
