-- Fix: in-app delivery edits have failed since 2026-08-04 with
--   "permission denied for function fn_recompute_batch_state"
--
-- WHY. `tr_blackwood_delivery` on `public.deliveries` runs
-- `fn_update_blackwood_state()`, which is SECURITY INVOKER, so its body executes
-- as the writing role. Every branch of it calls `fn_recompute_batch_state(text)`,
-- which was granted to `service_role` ONLY. An authenticated user's INSERT /
-- UPDATE / DELETE therefore fired a trigger that immediately hit a function they
-- had no EXECUTE on, and the whole write rolled back.
--
-- The sync never noticed: it writes with the service-role key, which HAS EXECUTE.
-- A privileged writer masked a completely broken unprivileged path for 9 days.
--
-- THE FIX. `authenticated` genuinely IS a calling role of this helper -- via the
-- trigger -- so the project rule "grant back only the roles that call it" was
-- applied to an incomplete list of callers, not deliberately withheld. Grant it.
--
-- Safe to expose directly: the function takes a batch_code and RECOMPUTES
-- `batches.current_weight` and `avg_cost` from the base tables. It is idempotent
-- and derives everything it writes, so a client calling it by hand can only
-- restore truth, never introduce a value of its own. `authenticated` already
-- holds SELECT on deliveries/rc_out/batches and UPDATE on batches under
-- permissive `(true)` RLS, so it can already compute and write these figures the
-- long way; this grant adds no reach.
--
-- NOT changing: the function body, the trigger body, and `avg_cost`'s ONE
-- definition (delivery-weighted over PRICED rows only -- BUG-018 + the
-- 2026-08-07 L-039 narrowing). This migration is grants only.
--
-- REJECTED ALTERNATIVE: making `fn_update_blackwood_state()` SECURITY DEFINER.
-- That would keep the helper service-role-only, but it re-roots the privilege
-- context of EVERYTHING the trigger does -- including its writes to `batches` --
-- so that path would run as `postgres` and BYPASS RLS on `batches`. It trades a
-- narrow, auditable grant on a derive-only function for a permanent
-- RLS-bypassing hole on the main delivery write path. Strictly worse.

GRANT EXECUTE ON FUNCTION public.fn_recompute_batch_state(text) TO authenticated;

-- `anon` deliberately still has nothing (the base REVOKE FROM PUBLIC in
-- 20260804060000 stands): anon holds no table privileges, so it can neither fire
-- the trigger nor use the helper.

COMMENT ON FUNCTION public.fn_recompute_batch_state(text) IS
  'The ONE definition of a batch''s derived state: recomputes batches.current_weight '
  '(deliveries - rc_out) and batches.avg_cost (delivery-weighted over PRICED '
  'deliveries only, cost_basis > 0) from the base tables. Idempotent, so it doubles '
  'as the backfill. EXECUTE is granted to service_role AND authenticated: '
  'authenticated is a calling role via the SECURITY INVOKER trigger '
  'tr_blackwood_delivery on public.deliveries, and without the grant every in-app '
  'delivery write fails with "permission denied for function fn_recompute_batch_state".';
