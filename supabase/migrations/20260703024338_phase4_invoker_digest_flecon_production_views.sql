-- Phase 4 · Step 2c — Convert the remaining flagged DEFINER views to security_invoker.
--
-- view_digest_grades      → production_runs, production_shifts, view_digest_operational_days
--                           (the child view is ALREADY invoker, so the chain resolves
--                            fully under the querying user's RLS).
-- view_flecon_bag_balance → flecon_bag_movements / _opening_balances / _types (all granted+policied)
-- view_production_daily    → production_downtime/runs/shifts/waste (granted+policied in Step 1)
-- view_rc_out_closed_blocks→ batches / deliveries / rc_out (granted+policied)
-- view_trucks_monthly      → truck_readings (granted+policied in Step 1). Documented dead
--                            (no app query) — converted for consistency, NOT dropped.

ALTER VIEW public.view_digest_grades       SET (security_invoker = true);
ALTER VIEW public.view_flecon_bag_balance  SET (security_invoker = true);
ALTER VIEW public.view_production_daily    SET (security_invoker = true);
ALTER VIEW public.view_rc_out_closed_blocks SET (security_invoker = true);
ALTER VIEW public.view_trucks_monthly      SET (security_invoker = true);
