-- =====================================================================
-- user_table_settings — THE GRANT THAT WAS NEVER THERE (2026-09-03)
-- =====================================================================
-- Measured before writing this: `pg_class.relacl` on
-- `public.user_table_settings` is NULL, i.e. NO role other than the owner
-- holds any privilege on it, and
--   has_table_privilege('authenticated', 'public.user_table_settings', 'SELECT'
--                       / 'INSERT' / 'UPDATE')
-- returns FALSE for all three. The table has THREE RLS policies
-- ("Users read/insert/update own settings", each `auth.uid() = user_id`) and
-- RLS enabled — and the table holds ZERO rows.
--
-- That combination is the whole story: a POLICY IS NOT A GRANT. A policy can
-- only narrow a privilege that exists; with no GRANT behind it, every read and
-- every write from the app has been failing with SQLSTATE 42501,
-- `permission denied for table user_table_settings`, since the table was
-- created — which is why it is empty. `saveTableSettings` returns the error and
-- `components/providers/table-settings.tsx` logs it to the console, so the RC
-- IN per-user table settings have silently never persisted to the database.
-- localStorage carried them, so nobody noticed.
--
-- This is L-043 / L-044 in a third costume, and the same rule applies: the
-- instrument is a plain GRANT, and it is proven by ASSUMING THE VICTIM'S ROLE
-- rather than by reading the grant table (see the DO block at the end).
--
-- WHY THESE THREE AND NOT MORE:
--   • SELECT / INSERT / UPDATE are exactly what the two server actions do
--     (`getUserModuleSettings` reads, `saveUserModuleSettings` upserts). RLS
--     confines all three to the caller's own row.
--   • **No DELETE.** Nothing in the app deletes a settings row — "reset to
--     defaults" writes an empty document, which is a different and reversible
--     thing. Granting a DELETE nothing calls would only widen what a stolen
--     anon-key session could reach if a policy were ever loosened.
--   • **`anon` gets nothing** (it already has nothing, and the project's RLS
--     posture is that `anon` has no data access at all).
--   • **`service_role` gets nothing.** No worker reads or writes this table;
--     L-044's arrow direction — a role that does not call it is not a
--     dependency of it.
-- =====================================================================

GRANT SELECT, INSERT, UPDATE ON TABLE public.user_table_settings TO authenticated;

COMMENT ON TABLE public.user_table_settings IS
  'Per-user, per-module UI preferences as a jsonb bag, keyed (user_id, module). '
  'Modules in use: ''rc_in'' (the RC IN grid''s density/columns/lab highlights) and '
  '''analytics'' (the /analytics reader settings — year colours and strokes, expand-chart '
  'toggles, compare mode, per-working-day, Definitions, row order). `module` deliberately '
  'carries NO check constraint or enum: a new screen that wants to remember something is '
  'not a schema change, and a bad value can only ever produce a row nothing reads. '
  'RLS confines every statement to auth.uid() = user_id; `authenticated` holds '
  'SELECT/INSERT/UPDATE and nothing else — no DELETE (reset writes an empty document), '
  'no anon, no service_role.';

-- The L-043 proof: a permission fix is proven by becoming the victim, never by
-- inspecting the catalogue. Raises if the grant did not actually take.
DO $$
DECLARE ok boolean;
BEGIN
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM 1 FROM public.user_table_settings LIMIT 1;
    ok := true;
  EXCEPTION WHEN insufficient_privilege THEN
    ok := false;
  END;
  RESET ROLE;
  IF NOT ok THEN
    RAISE EXCEPTION 'user_table_settings is still unreadable as authenticated';
  END IF;
END $$;
