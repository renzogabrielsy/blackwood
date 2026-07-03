-- flecon_grants
--
-- Fixes "permission denied for table flecon_bag_movements" hit when loading the
-- Bag Inventory page. The prior migration (20260702000000_flecon_bag_inventory.sql)
-- created the flecon tables WITH RLS policies but never granted table-level
-- privileges to the app roles. RLS only *filters* rows AFTER the base GRANT check
-- passes; with zero grants, PostgreSQL rejects the query before RLS is even
-- consulted. view_flecon_bag_balance is SECURITY INVOKER, so reading it needs
-- SELECT on the base tables for the invoking role -> hence the error.
--
-- This migration is ADDITIVE ONLY: it grants the SAME table-privilege set that
-- public.rc_out already has (SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER,
-- TRUNCATE for anon / authenticated / service_role), mirroring rc_out exactly, and
-- grants SELECT on the balance view to all three roles. No structural changes.
--
-- RLS policies are NOT touched: the flecon tables' policies already target
-- {authenticated} only, identical to rc_out's policies. rc_out's anon/service_role
-- table grants are still gated by RLS (no anon policy exists), so mirroring the
-- grant set does not widen row access -- it only makes behavior identical to rc_out.

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE
  ON public.flecon_bag_types,
     public.flecon_bag_opening_balances,
     public.flecon_bag_movements
  TO anon, authenticated, service_role;

GRANT SELECT
  ON public.view_flecon_bag_balance
  TO anon, authenticated, service_role;
