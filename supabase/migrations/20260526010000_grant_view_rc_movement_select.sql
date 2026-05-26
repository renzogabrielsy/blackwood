-- Grant SELECT on view_rc_movement to anon and authenticated roles,
-- matching the pattern used by view_blocking_grid.
-- Without this, server actions querying the view through the Supabase
-- authenticated client get "permission denied for view view_rc_movement".
GRANT SELECT ON public.view_rc_movement TO anon, authenticated;
