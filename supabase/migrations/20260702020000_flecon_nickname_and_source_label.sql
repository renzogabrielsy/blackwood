-- FLECON Bag Inventory — nickname + source_label (charcoal tenant, Bagging Manager)
-- ADDITIVE ONLY. Two nullable columns on flecon_bag_types + recreate balance view.
-- Design: .claude/skills/sync-ictc/FLECON_BAGGING_DESIGN.md §2.1
--
-- Supports two new FLECON features:
--   (a) user-editable per-column nicknames (display override for the header)
--   (b) header-signature-based column matching (resilient extractor mapping)
--
-- The existing table-level grants (mirror rc_out: all 3 roles full CRUD) already
-- cover the new columns automatically — no table re-grant needed. RLS unchanged.

-- ============================================================
-- 1. Two nullable columns on flecon_bag_types
-- ============================================================
ALTER TABLE public.flecon_bag_types
  ADD COLUMN IF NOT EXISTS nickname     text NULL,
  ADD COLUMN IF NOT EXISTS source_label text NULL;

COMMENT ON COLUMN public.flecon_bag_types.nickname IS
  'User display override for the column header. NULL/'''' => UI falls back to label.';
COMMENT ON COLUMN public.flecon_bag_types.source_label IS
  'Canonical sheet HEADER SIGNATURE this bag type matches during extraction (the operator''s FLECON BAG MOVEMENT sheet has a multi-row header; this is the combined text). The extractor normalizes (lowercase, strip non-alphanumeric) both this and the live sheet header to match by TEXT, not column position.';

-- ============================================================
-- 2. Seed source_label per code (SELECT by code — no hardcoded uuids)
--    nickname left NULL for all (falls back to label).
-- ============================================================
UPDATE public.flecon_bag_types SET source_label = '590 kls (Kuraray)'          WHERE code = 'KURARAY_590';
UPDATE public.flecon_bag_types SET source_label = 'Un-usable bag'              WHERE code = 'UNUSABLE';
UPDATE public.flecon_bag_types SET source_label = '550 kls (Futamura)'         WHERE code = 'FUTAMURA_550';
UPDATE public.flecon_bag_types SET source_label = '550 kls (Korea) Beige'      WHERE code = 'KOREA_550_BEIGE';
UPDATE public.flecon_bag_types SET source_label = '500 kls (Korea)'            WHERE code = 'KOREA_500';
UPDATE public.flecon_bag_types SET source_label = '590 kls (Kuraray) brandnew' WHERE code = 'KURARAY_590_NEW';
UPDATE public.flecon_bag_types SET source_label = 'kuraray (Re-turn bag)'      WHERE code = 'KURARAY_RETURN';
UPDATE public.flecon_bag_types SET source_label = 'Plastic Liner 78x130x15 mm' WHERE code = 'PLASTIC_LINER';
UPDATE public.flecon_bag_types SET source_label = 'Ecopack Beige 90x90x125'    WHERE code = 'ECOPACK_BEIGE';
UPDATE public.flecon_bag_types SET source_label = 'Ecopack Beige Tunner Bag'   WHERE code = 'TUNNER_BAG';
UPDATE public.flecon_bag_types SET source_label = '6X50 FG w/ Black Sling'     WHERE code = 'FG_BLACK_SLING_6X50';
UPDATE public.flecon_bag_types SET source_label = 'FG All Black'               WHERE code = 'FG_ALL_BLACK';
UPDATE public.flecon_bag_types SET source_label = 'Korea (White)'              WHERE code = 'KOREA_WHITE';
UPDATE public.flecon_bag_types SET source_label = '8X50 580 kls (Maehata)'     WHERE code = 'MAEHATA_580';

-- ============================================================
-- 3. Recreate view_flecon_bag_balance — now also exposes nickname.
--    SECURITY INVOKER (inherits RLS from base tables).
--    DROP then CREATE (not CREATE OR REPLACE): inserting `nickname` after
--    `label` changes the column order, which CREATE OR REPLACE forbids.
--    Recreate drops grants -> re-GRANT SELECT below.
-- ============================================================
DROP VIEW IF EXISTS public.view_flecon_bag_balance;

CREATE VIEW public.view_flecon_bag_balance AS
SELECT
  t.id                                                          AS bag_type_id,
  t.code,
  t.label,
  t.nickname,
  t.sort_order,
  COALESCE(ob.qty, 0)                                           AS opening,
  COALESCE(SUM(m.qty_delta) FILTER (WHERE m.qty_delta > 0), 0)  AS total_in,
  COALESCE(SUM(-m.qty_delta) FILTER (WHERE m.qty_delta < 0), 0) AS total_out,
  COALESCE(ob.qty, 0) + COALESCE(SUM(m.qty_delta), 0)           AS balance,
  MAX(m.transaction_date)                                       AS last_movement_date
FROM public.flecon_bag_types t
LEFT JOIN public.flecon_bag_opening_balances ob
  ON ob.bag_type_id = t.id
 AND ob.year = EXTRACT(YEAR FROM CURRENT_DATE)::int
LEFT JOIN public.flecon_bag_movements m
  ON m.bag_type_id = t.id
GROUP BY t.id, t.code, t.label, t.nickname, t.sort_order, ob.qty;

COMMENT ON VIEW public.view_flecon_bag_balance IS
  'SQL-computed per-bag-type running balance (HARD RULE — UI never recomputes in TS). balance = current-year opening + SUM(qty_delta). Exposes nickname (display override). SECURITY INVOKER — inherits RLS from base tables.';

GRANT SELECT ON public.view_flecon_bag_balance TO anon, authenticated, service_role;
