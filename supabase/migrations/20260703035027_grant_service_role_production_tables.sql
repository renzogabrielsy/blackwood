-- Grant service_role table access on the 6 PRODUCTION tables so the sync backend
-- (sync_production.py orchestrator / the in-app Run Sync button) can read the DB window
-- and write via the service-role key over PostgREST.
--
-- Background (verified live 2026-07-03): deliveries, rc_out, and flecon_bag_movements all
-- carry full service_role grants — which is why sync_deliveries.py / sync_rc_out.py /
-- sync_flecon.py work. The 6 production tables were created with grants to `authenticated`
-- ONLY; service_role has NO grants, so a service-role read 403s with
-- `42501 permission denied for table production_shifts`. (This is a GRANT gap, not an RLS
-- policy denial — service_role bypasses RLS but still needs the table privilege.)
--
-- Scope: exactly the privileges the other sync targets already grant service_role
-- (SELECT/INSERT/UPDATE/DELETE). service_role is a trusted server-only key (never shipped to
-- the browser); it is the same key deliveries/rc_out/flecon already use. RLS on these tables
-- (Phase-4) is unaffected — service_role bypasses RLS regardless.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_shifts    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_runs      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_downtime  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_waste     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.electricity_readings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.truck_readings       TO service_role;
