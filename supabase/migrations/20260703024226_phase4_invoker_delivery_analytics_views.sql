-- Phase 4 · Step 2a — Convert the delivery-analytics view family to security_invoker.
--
-- All five depend only on public.deliveries, which has authenticated SELECT grant +
-- a permissive SELECT policy, so an invoker query as `authenticated` resolves fine.
-- Converting DEFINER→INVOKER means the view now enforces the querying user's RLS,
-- which for this single-org app is the intended org-boundary posture.

ALTER VIEW public.view_delivery_monthly_analytics                  SET (security_invoker = true);
ALTER VIEW public.view_delivery_yearly_analytics                   SET (security_invoker = true);
ALTER VIEW public.view_delivery_supplier_monthly_analytics         SET (security_invoker = true);
ALTER VIEW public.view_delivery_supplier_yearly_analytics          SET (security_invoker = true);
ALTER VIEW public.view_delivery_supplier_subgroup_yearly_analytics SET (security_invoker = true);
