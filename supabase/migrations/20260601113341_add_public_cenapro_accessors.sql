-- Migration: add_public_cenapro_accessors
-- =====================================================================================
-- Surfaces the Cenapro (Tenant #2) data the app needs through THIN, READ-ONLY
-- look-through accessors that live in the already-PostgREST-served `public` schema —
-- WITHOUT moving any data out of `cenapro` and WITHOUT exposing the `cenapro` schema
-- to PostgREST directly.
--
-- WHY THIS EXISTS
--   supabase-js + `supabase gen types` can only see schemas in PostgREST's exposed-schemas
--   list. On managed Supabase that list is the dashboard toggle (Settings -> API ->
--   Exposed schemas); it is NOT settable from a migration (ALTER ROLE authenticator ...
--   is denied for our role — verified: the `authenticator` role has no pgrst.db_schemas
--   rolconfig at all). Rather than depend on a manual dashboard step, we expose ONLY the
--   handful of read shapes the Cenapro UI consumes as `public.cenapro_*` windows. `cenapro`
--   remains the sole home of the data + ALL business logic; `public` gains read-only views
--   into it. Tenant separation is preserved — these are windows, not copies.
--
-- WHAT THIS ADDS (in `public` ONLY):
--   1. VIEW     public.cenapro_production_events     -> SELECT of cenapro.production_event cols
--   2. FUNCTION public.cenapro_flec_balance(text,date) -> 1:1 passthrough of cenapro.flec_balance
--   3. FUNCTION public.cenapro_flec_ledger(text,date)  -> 1:1 passthrough of cenapro.flec_ledger
--
-- SECURITY MODEL — SECURITY INVOKER (verified, not DEFINER):
--   The `authenticated` role ALREADY holds everything a cross-schema invoker call needs,
--   set when the cenapro schema was built:
--     has_schema_privilege('authenticated','cenapro','USAGE')                      = true
--     has_table_privilege('authenticated','cenapro.production_event','SELECT')     = true
--     has_function_privilege('authenticated','cenapro.flec_ledger(text,date)','EXECUTE')  = true
--     has_function_privilege('authenticated','cenapro.flec_balance(text,date)','EXECUTE') = true
--   Proven by impersonation (SET LOCAL ROLE authenticated): direct reads of
--   cenapro.production_event / flec_ledger / flec_balance all succeed. Therefore an INVOKER
--   path works with zero privilege escalation: the caller reads cenapro strictly with its
--   OWN grants. We deliberately AVOID SECURITY DEFINER — no ambient authority, no owner
--   bypass, nothing to lock down with a pinned search_path. The cenapro functions are
--   themselves SECURITY INVOKER, so the whole chain stays invoker end-to-end.
--   search_path note: these public functions reference fully schema-qualified cenapro
--   objects, so they are immune to search_path hijacking; we still pin `SET search_path = ''`
--   to clear the function_search_path_mutable advisor (parity with the cenapro functions).
--
-- ISOLATION GUARANTEE
--   This migration creates objects in `public` only. It does NOT alter `cenapro` tables,
--   data, functions, the view, grants, or any ICTC `public` object. The accessors are
--   read-only (no INSERT/UPDATE/DELETE surface). Dropping them later leaves cenapro intact.
-- =====================================================================================

-- =====================================================================================
-- 1. public.cenapro_production_events — read-only window onto cenapro.production_event.
--    Exposes exactly the columns the UI consumes (NOT the full provenance/audit footprint).
--    SECURITY INVOKER: the SELECT runs as the calling role, which already has SELECT on
--    cenapro.production_event. PostgREST serves this from `public`, so supabase-js can read
--    it as `from('cenapro_production_events')` and gen-types will emit it.
-- =====================================================================================
DROP VIEW IF EXISTS public.cenapro_production_events;

CREATE VIEW public.cenapro_production_events
WITH (security_invoker = true)
AS
SELECT
  pe.id,
  pe.recv_date,
  pe.prod_date,
  pe.batch,
  pe.batch_year,
  pe.shift_code,
  pe.grade_code,
  pe.plant_code,
  pe.warehouse_code,
  pe.source_location_code,
  pe.weight_kg,
  pe.disposition_kind,
  pe.partner_equipment_code,
  pe.flec_count,
  pe.whse_side,
  pe.unique_tag
FROM cenapro.production_event pe;

COMMENT ON VIEW public.cenapro_production_events IS
  'Read-only PostgREST window onto cenapro.production_event (Tenant #2). SECURITY INVOKER — '
  'the caller reads with its own cenapro SELECT grant; no data is copied out of cenapro. '
  'Exists so supabase-js / gen-types can reach Cenapro production without exposing the '
  'cenapro schema to PostgREST. Surfaces only UI-consumed columns; cenapro remains the '
  'sole home of the data + business logic.';

-- =====================================================================================
-- 2. public.cenapro_flec_balance(text, date) — 1:1 passthrough of cenapro.flec_balance.
--    Returns the identical TABLE shape. SECURITY INVOKER: resolves to the cenapro function
--    which the caller already has EXECUTE on (and which is itself INVOKER).
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.cenapro_flec_balance(
  p_warehouse_code text,
  p_start_date     date
)
RETURNS TABLE (
  warehouse_code text,
  grade_code     text,
  side           text,
  current_flec   bigint,
  opening_seed   integer,
  as_of          date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT b.warehouse_code, b.grade_code, b.side, b.current_flec, b.opening_seed, b.as_of
  FROM cenapro.flec_balance(p_warehouse_code, p_start_date) AS b;
$$;

COMMENT ON FUNCTION public.cenapro_flec_balance(text, date) IS
  'Read-only PostgREST passthrough of cenapro.flec_balance(p_warehouse_code, p_start_date) '
  '(Tenant #2). SECURITY INVOKER — runs the underlying cenapro function with the caller''s '
  'own EXECUTE grant; identical TABLE shape, no logic duplicated here. Exists only so '
  'supabase-js rpc() / gen-types can reach the flec closing-balance summary without exposing '
  'the cenapro schema to PostgREST.';

-- =====================================================================================
-- 3. public.cenapro_flec_ledger(text, date) — 1:1 passthrough of cenapro.flec_ledger.
--    Returns the identical TABLE shape. SECURITY INVOKER (same rationale as #2).
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.cenapro_flec_ledger(
  p_warehouse_code text,
  p_start_date     date
)
RETURNS TABLE (
  id                     uuid,
  warehouse_code         text,
  grade_code             text,
  side                   text,
  recv_date              date,
  prod_date              date,
  source_location_code   text,
  disposition_kind       text,
  partner_equipment_code text,
  kg_moved               numeric,
  flec_in                integer,
  flec_out               integer,
  opening_seed           integer,
  flec_in_to_date        bigint,
  flec_out_to_date       bigint,
  running_balance        bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    l.id, l.warehouse_code, l.grade_code, l.side, l.recv_date, l.prod_date,
    l.source_location_code, l.disposition_kind, l.partner_equipment_code,
    l.kg_moved, l.flec_in, l.flec_out, l.opening_seed,
    l.flec_in_to_date, l.flec_out_to_date, l.running_balance
  FROM cenapro.flec_ledger(p_warehouse_code, p_start_date) AS l;
$$;

COMMENT ON FUNCTION public.cenapro_flec_ledger(text, date) IS
  'Read-only PostgREST passthrough of cenapro.flec_ledger(p_warehouse_code, p_start_date) '
  '(Tenant #2). SECURITY INVOKER — runs the underlying cenapro function with the caller''s '
  'own EXECUTE grant; identical TABLE shape, no logic duplicated here. Exists only so '
  'supabase-js rpc() / gen-types can reach the per-row flec ledger without exposing the '
  'cenapro schema to PostgREST.';

-- =====================================================================================
-- 4. Grants — match ICTC's existing public pattern: authenticated + anon + service_role.
--    (anon SELECT mirrors how every ICTC public table/view is granted; the cenapro tables
--    themselves were also granted SELECT to anon. App-layer auth still gates real access.)
-- =====================================================================================
GRANT SELECT ON public.cenapro_production_events TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cenapro_flec_balance(text, date) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cenapro_flec_ledger(text, date)  TO authenticated, anon, service_role;

-- Nudge PostgREST to pick up the new public objects immediately.
NOTIFY pgrst, 'reload schema';
