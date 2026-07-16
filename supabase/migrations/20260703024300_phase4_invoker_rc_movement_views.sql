-- Phase 4 · Step 2b — Convert the RC-Movement view family to security_invoker.
--
-- These depend only on batches / deliveries / rc_out / production_shifts /
-- production_runs, all of which have authenticated SELECT grant + a permissive SELECT
-- policy (production_* were granted policies in Step 1). Safe to run as invoker.

ALTER VIEW public.view_rc_movement                              SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_batch_price                  SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_day_price                    SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_month_price                  SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_production_daily             SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_production_daily_total       SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_production_monthly           SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_yield_monthly               SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_campaign_cells               SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_campaign_day_price           SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_campaign_options             SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_campaign_price               SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_campaign_production          SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_campaign_production_daily    SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_campaign_production_daily_total SET (security_invoker = true);
ALTER VIEW public.view_rc_movement_campaign_yield              SET (security_invoker = true);
