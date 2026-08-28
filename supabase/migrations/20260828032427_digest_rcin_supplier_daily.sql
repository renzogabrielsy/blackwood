-- =====================================================================
-- view_digest_rcin_supplier_daily — supplier identity for the RC IN drill-down
-- =====================================================================
-- THE BUG THIS FIXES
-- ------------------
-- The RC IN drill-down modal (`components/digest/drilldown/rc-in-drilldown.tsx`,
-- fed by `getRcInDrilldown` in `app/(app)/drilldown-actions.ts`) ranked its
-- "By supplier" rail by grouping RAW `deliveries.supplier` strings in
-- TypeScript. Raw strings are not an identity — measured over the full table:
--
--     ORNALES   ← "Ornales" 405 rows / 6,132,881 kg
--                 "ORNALES"  22 rows /   325,652 kg   (June 2026)
--                 "Mercado / Ornales"  7 rows / 80,390 kg
--                 "Arbelera/Mercado"   2 rows / 22,580 kg
--                 "Mercado/Paquibot"   1 row  / 18,500 kg
--                 "Nazarte/ Arbelera"  1 row  /  2,279 kg
--     PAQUIBOT  ← "Paquibot" 392 / "PAQUIBOT" 14 / "paquibot" 13 + 5 joint spellings
--     TAG-AT    ← "Tag-at" 141 / "TAG-AT" 5
--     LLANTO    ← "Llanto"  72 / "LLANTO" 2
--     NAZARENO  ← "Nazarino" 6 / "Nazareno" 5 / "NAZARINO - FEB-26-BLK15" 3
--     BAGUIO, BAGUIO/TIPALAN — 2 and 5 spellings respectively
--
-- so one supplier ranked as up to six, and the joint-vendor misdeclares that
-- `canonical_supplier()` exists to fold did not fold at all.
--
-- WHY A VIEW AND NOT TYPESCRIPT
-- -----------------------------
-- `public.canonical_supplier(text)` is the ONE definition of supplier identity
-- (migrations 20260616062408 + 20260616063514) and every other supplier
-- surface — `view_delivery_supplier_monthly_analytics`,
-- `view_delivery_supplier_yearly_analytics`,
-- `view_delivery_supplier_subgroup_yearly_analytics` — reads it there. A
-- TypeScript port of those ILIKE clauses would be a SECOND definition that
-- drifts the first time a new spelling is added to the function; the digest
-- rail would then rank differently from Summaries with nothing to say why.
-- The grouping has to happen where the function lives, and PostgREST aggregate
-- functions are DISABLED on this project (a `weight_kg.sum()` select returns
-- PGRST123), so a view is the only door.
--
-- THE WINDOW — 400 TRAILING DAYS, AND WHY NOT date_trunc('year')
-- ---------------------------------------------------------------
-- The digest windowing contract (header of `lib/digest/queries.ts`) forbids an
-- unwindowed daily view: PostgREST silently truncates a response at 1000 rows
-- ASCENDING, so an unwindowed daily view loses its most recent days — the
-- 2026-06-04 incident that flatlined every KPI.
--
-- The drill-down resolves THREE ranges against the operational date: 30d, 90d
-- and "This year" (Jan 1 → operational date). A year-anchored floor —
-- `date_trunc('year', now Manila) - 7 days` — serves only the third of those.
-- On 5 January that floor is 25 December, but the 90-day range still reaches
-- back to ~7 October: two thirds of the 90d window would fall outside the view
-- and the ranking would silently understate, which is exactly the failure mode
-- this whole change exists to remove. A fixed trailing window has to cover
-- max(365, 90) = 365 days, so 400 days is that plus five weeks of headroom, and
-- it covers the young-January "This year" case for free.
--
-- ROW BUDGET (measured 2026-08-28): 820 rows over the 400-day window; the
-- widest full year on record (2025) is 609. The grain is (date × canonical
-- supplier), so the view can never return more rows than the raw `deliveries`
-- read the adapter already performs over the same range (2025: 609 vs 719) —
-- this read is strictly cheaper than the one it replaces. The adapter always
-- reads it range-bounded (`.gte`/`.lte`), never whole, so the widest wire
-- response is a full-year YTD, ~600 rows, well under the 1000-row cap.
--
-- ANCHORED TO THE MANILA CALENDAR, NOT `view_digest_operational_days`, for two
-- reasons: `operational_date <= today` always, so a today-anchored floor is a
-- superset of an operational-date-anchored one and can only ever cover MORE of
-- a requested range; and it keeps this view's security_invoker dependency
-- closure to exactly one relation (`public.deliveries`), which is what has to
-- be readable for the view to be readable (L-044). There is deliberately NO
-- upper bound, so a future-dated delivery is never invisible.
--
-- NO ₱ COLUMNS. kg, sacks and counts only. `cost_basis` is not selected and no
-- price is derivable from what is, so this view is safe for EVERY role
-- including Production and needs no `canViewPrices()` gate at the server
-- action. Keep it that way: adding a ₱ column here turns an ungated surface
-- into a leak.
--
-- NOT GRANTED TO service_role. The sync worker does not read it. L-044's arrow
-- direction: the worker's grants belong to the views the worker reads and to
-- their dependencies, not to every consumer that happens to sit downstream of
-- the same table. `scripts/verify-worker-view-grants.ts` must still report 4
-- views / 0 findings after this migration.
-- =====================================================================

CREATE OR REPLACE VIEW public.view_digest_rcin_supplier_daily
WITH (security_invoker = true) AS
SELECT
  d.transaction_date                          AS transaction_date,
  public.canonical_supplier(d.supplier)       AS supplier_canonical,
  sum(d.weight_kg)::numeric                   AS kg,
  count(*)::int                               AS delivery_count,
  COALESCE(sum(d.sacks), 0)::int              AS sack_count
FROM public.deliveries d
WHERE d.transaction_date IS NOT NULL
  AND d.transaction_date >= ((now() AT TIME ZONE 'Asia/Manila')::date - INTERVAL '400 days')::date
GROUP BY d.transaction_date, public.canonical_supplier(d.supplier);

COMMENT ON VIEW public.view_digest_rcin_supplier_daily IS
  'One row per (transaction_date, canonical supplier) over public.deliveries, windowed to a '
  'trailing 400 days from the Asia/Manila calendar date. THE by-supplier grain behind the RC IN '
  'drill-down rail. supplier_canonical = public.canonical_supplier(supplier) — the ONE definition '
  'of supplier identity, shared with the Summaries by-supplier views; never re-implement that '
  'folding in TypeScript. Unfiltered otherwise: sum(kg) over any range equals '
  'view_digest_daily_flow.in_kg over the same range, by construction (both are plain sums over '
  'deliveries with no exclusion). 400 days covers the drill-down''s widest range (a full-year '
  '"This year") plus headroom, and unlike a date_trunc(''year'') floor it still covers the 90-day '
  'range in early January. Carries NO price column and none is derivable — safe for every role, '
  'including Production. Not granted to service_role: the sync worker does not read it.';

GRANT SELECT ON public.view_digest_rcin_supplier_daily TO authenticated;
REVOKE ALL ON public.view_digest_rcin_supplier_daily FROM anon;
