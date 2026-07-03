-- Phase 4 · Step 4a (correction 2) — Re-grant EXECUTE on is_admin to authenticated.
--
-- KNOWN TRAP hit + fixed: RLS policy evaluation DOES require the invoking role to hold
-- EXECUTE on any function referenced in the policy, even a SECURITY DEFINER one.
-- `is_admin(auth.uid())` is used in the RLS policies on public.pending_review (UPDATE,
-- DELETE) and public.profiles ("Admins can update any profile"). After revoking EXECUTE
-- from PUBLIC, an authenticated admin's UPDATE failed with
--   ERROR: 42501: permission denied for function is_admin
-- So authenticated MUST retain EXECUTE on is_admin. anon stays revoked (anon can no
-- longer reach any of those tables anyway — all anon table grants were dropped).
--
-- Net effect: the advisor's authenticated_security_definer_function_executable warning
-- on is_admin is an ACCEPTED, load-bearing grant — it is required for admin RLS to work.
-- The other 13 functions remain revoked from PUBLIC (none are referenced by any policy).

GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;
