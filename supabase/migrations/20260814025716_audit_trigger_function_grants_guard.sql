-- REGRESSION GUARD for the class of bug fixed in 20260814025344.
--
-- THE CLASS. A SECURITY INVOKER trigger function runs as whoever wrote the row.
-- If its body calls another function that the writing role has no EXECUTE on, the
-- write dies with "permission denied for function <callee>" and rolls back --
-- even though the role has every table privilege and passes every RLS policy.
--
-- WHY IT IS INVISIBLE. The sync writes with the service-role key, which holds
-- EXECUTE on essentially everything, so the privileged path stays green while the
-- unprivileged one is 100% broken. Nothing alarms. The only symptom is a human
-- hitting an error in the UI -- which is how `fn_recompute_batch_state` stayed
-- broken for 9 days. A grant gap that bites exactly one role is precisely what a
-- test suite that runs as an admin cannot see.
--
-- WHAT THIS CHECKS. For every non-internal trigger on a table `p_role` can write
-- (so `p_role` can make the trigger fire), walk the SECURITY INVOKER call graph
-- outward from the trigger function and report any reachable function `p_role`
-- cannot EXECUTE. The walk stops at SECURITY DEFINER callees on purpose: those
-- re-root the privilege context to their owner, so what they call is not the
-- caller's problem.
--
-- HEURISTIC, AND WHY THAT IS THE RIGHT TRADE. Postgres records no function ->
-- function call dependency, so edges are found by word-boundary matching callee
-- names against `prosrc`. That can over-report (a column named like a function) but
-- cannot under-report a plain call. Over-reporting is the safe direction: a false
-- positive costs one look, a false negative costs another nine-day outage. If this
-- ever fires on something benign, DEMOTE it with a documented reason -- do not
-- widen the predicate until it goes quiet.
--
-- Read-only. Grants nothing, changes nothing. `service_role` only (the verify
-- script runs with the service-role key).

CREATE OR REPLACE FUNCTION public.fn_audit_trigger_function_grants(
  p_role name DEFAULT 'authenticated'
)
RETURNS TABLE (
  trigger_name        text,
  on_table            text,
  trigger_function    text,
  unexecutable_callee text,
  callee_is_secdef    boolean,
  hops                integer
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $fn$
  WITH RECURSIVE
  trg AS (
    SELECT DISTINCT t.tgname, n.nspname || '.' || c.relname AS tbl, p.oid AS fn_oid
    FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p      ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND (   has_table_privilege(p_role, c.oid, 'INSERT')
           OR has_table_privilege(p_role, c.oid, 'UPDATE')
           OR has_table_privilege(p_role, c.oid, 'DELETE'))
  ),
  cand AS (
    SELECT p.oid, p.proname, p.prosecdef, p.prosrc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'cenapro', 'auth', 'storage', 'extensions')
      AND p.proname ~ '^[a-z][a-z0-9_]*$'
  ),
  reach AS (
    SELECT t.tgname, t.tbl, s.oid AS src_oid, s.prosrc, 0 AS depth
    FROM trg t JOIN cand s ON s.oid = t.fn_oid
    WHERE s.prosecdef = false
    UNION
    SELECT r.tgname, r.tbl, c2.oid, c2.prosrc, r.depth + 1
    FROM reach r
    JOIN cand c2 ON c2.oid <> r.src_oid AND r.prosrc ~ ('\m' || c2.proname || '\M')
    WHERE r.depth < 4 AND c2.prosecdef = false
  )
  SELECT DISTINCT
         r.tgname::text,
         r.tbl::text,
         r.src_oid::regprocedure::text,
         c.oid::regprocedure::text,
         c.prosecdef,
         r.depth
  FROM reach r
  JOIN cand c ON c.oid <> r.src_oid AND r.prosrc ~ ('\m' || c.proname || '\M')
  WHERE NOT has_function_privilege(p_role, c.oid, 'EXECUTE')
  ORDER BY 2, 1, 4;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_audit_trigger_function_grants(name) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_audit_trigger_function_grants(name) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_audit_trigger_function_grants(name) TO service_role;

COMMENT ON FUNCTION public.fn_audit_trigger_function_grants(name) IS
  'Regression guard for the 2026-08-14 class of bug: a SECURITY INVOKER trigger '
  'function, fireable by p_role, that calls a function p_role cannot EXECUTE -- '
  'which kills the write with "permission denied for function <callee>" while the '
  'service-role sync path stays green. Returns one row per hole; ZERO ROWS IS THE '
  'PASSING STATE. Driven by scripts/verify-trigger-grants.ts.';
