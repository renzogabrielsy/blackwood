-- FLECON Bag Inventory — DB foundation (charcoal tenant, Bagging Manager v1)
-- ADDITIVE ONLY. No changes to any existing object.
-- Design: .claude/skills/sync-ictc/FLECON_BAGGING_DESIGN.md §2.1, §3, §8
--
-- Three tables + one balance view + seeds (14 bag types, 2026 openings).
-- RLS mirrors the sibling inventory tables (rc_out): TO authenticated,
-- SELECT/INSERT/UPDATE/DELETE with USING (true) / WITH CHECK (true).
-- Balance is SQL-computed (HARD RULE) — the UI never recomputes it in TS.

-- ============================================================
-- 1. flecon_bag_types (dimension — seeded once)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.flecon_bag_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text UNIQUE NOT NULL,
  label         text NOT NULL,
  source_column char(1),
  sort_order    int,
  active        boolean NOT NULL DEFAULT true,
  capacity_kls  int,
  material      text,
  color         text,
  notes         text
);

COMMENT ON TABLE public.flecon_bag_types IS
  'FLECON packaging-material (empty jumbo/flecon bag) SKU dimension. 14 SKUs mapped to source workbook columns C..P. Seeded once.';

-- ============================================================
-- 2. flecon_bag_opening_balances (per-year forwarded balance)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.flecon_bag_opening_balances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bag_type_id uuid NOT NULL REFERENCES public.flecon_bag_types(id),
  year        int NOT NULL,
  qty         int NOT NULL DEFAULT 0,
  UNIQUE (bag_type_id, year)
);

COMMENT ON TABLE public.flecon_bag_opening_balances IS
  'Per-year opening ("Forwarded Balance" row) per bag type. The 2026 opening folds in all pre-2026 stock; balance = opening(year) + SUM(that year''s movements).';

-- ============================================================
-- 3. flecon_bag_movements (fact — replace-by-date idempotency)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.flecon_bag_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_date date NOT NULL,
  particular       text,
  bag_type_id      uuid NOT NULL REFERENCES public.flecon_bag_types(id),
  qty_delta        int NOT NULL,
  source_row       int,
  remarks          text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.flecon_bag_movements IS
  'Signed bag movements (negative = OUT/consumed, positive = IN/received). No natural-key UNIQUE — sync uses replace-by-date idempotency (DELETE the date, re-INSERT the sheet''s current rows for that date), bounded to the tail window.';

CREATE INDEX IF NOT EXISTS idx_flecon_bag_movements_date
  ON public.flecon_bag_movements (transaction_date);
CREATE INDEX IF NOT EXISTS idx_flecon_bag_movements_bag_type
  ON public.flecon_bag_movements (bag_type_id);

-- ============================================================
-- RLS — mirror sibling inventory table (rc_out) exactly
-- ============================================================
ALTER TABLE public.flecon_bag_types           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flecon_bag_opening_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flecon_bag_movements        ENABLE ROW LEVEL SECURITY;

-- flecon_bag_types
DROP POLICY IF EXISTS "Authenticated SELECT flecon_bag_types" ON public.flecon_bag_types;
DROP POLICY IF EXISTS "Authenticated INSERT flecon_bag_types" ON public.flecon_bag_types;
DROP POLICY IF EXISTS "Authenticated UPDATE flecon_bag_types" ON public.flecon_bag_types;
DROP POLICY IF EXISTS "Authenticated DELETE flecon_bag_types" ON public.flecon_bag_types;
CREATE POLICY "Authenticated SELECT flecon_bag_types" ON public.flecon_bag_types FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated INSERT flecon_bag_types" ON public.flecon_bag_types FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated UPDATE flecon_bag_types" ON public.flecon_bag_types FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated DELETE flecon_bag_types" ON public.flecon_bag_types FOR DELETE TO authenticated USING (true);

-- flecon_bag_opening_balances
DROP POLICY IF EXISTS "Authenticated SELECT flecon_bag_opening_balances" ON public.flecon_bag_opening_balances;
DROP POLICY IF EXISTS "Authenticated INSERT flecon_bag_opening_balances" ON public.flecon_bag_opening_balances;
DROP POLICY IF EXISTS "Authenticated UPDATE flecon_bag_opening_balances" ON public.flecon_bag_opening_balances;
DROP POLICY IF EXISTS "Authenticated DELETE flecon_bag_opening_balances" ON public.flecon_bag_opening_balances;
CREATE POLICY "Authenticated SELECT flecon_bag_opening_balances" ON public.flecon_bag_opening_balances FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated INSERT flecon_bag_opening_balances" ON public.flecon_bag_opening_balances FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated UPDATE flecon_bag_opening_balances" ON public.flecon_bag_opening_balances FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated DELETE flecon_bag_opening_balances" ON public.flecon_bag_opening_balances FOR DELETE TO authenticated USING (true);

-- flecon_bag_movements
DROP POLICY IF EXISTS "Authenticated SELECT flecon_bag_movements" ON public.flecon_bag_movements;
DROP POLICY IF EXISTS "Authenticated INSERT flecon_bag_movements" ON public.flecon_bag_movements;
DROP POLICY IF EXISTS "Authenticated UPDATE flecon_bag_movements" ON public.flecon_bag_movements;
DROP POLICY IF EXISTS "Authenticated DELETE flecon_bag_movements" ON public.flecon_bag_movements;
CREATE POLICY "Authenticated SELECT flecon_bag_movements" ON public.flecon_bag_movements FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated INSERT flecon_bag_movements" ON public.flecon_bag_movements FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated UPDATE flecon_bag_movements" ON public.flecon_bag_movements FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated DELETE flecon_bag_movements" ON public.flecon_bag_movements FOR DELETE TO authenticated USING (true);

-- ============================================================
-- Seed 1 — 14 bag types (code | label | source_column | sort_order)
-- ============================================================
INSERT INTO public.flecon_bag_types (code, label, source_column, sort_order) VALUES
  ('KURARAY_590',         '590 kls (Kuraray)',                        'C', 1),
  ('UNUSABLE',            'Un-usable bag',                            'D', 2),
  ('FUTAMURA_550',        '550 kls (Futamura)',                       'E', 3),
  ('KOREA_550_BEIGE',     '550 kls (Korea) Beige',                    'F', 4),
  ('KOREA_500',           '500 kls (Korea)',                          'G', 5),
  ('KURARAY_590_NEW',     '590 kls (Kuraray) brand-new',              'H', 6),
  ('KURARAY_RETURN',      'Kuraray (return bag)',                     'I', 7),
  ('PLASTIC_LINER',       'Plastic Liner (78x130x15mm)',              'J', 8),
  ('ECOPACK_BEIGE',       'Ecopack Beige (90x90x125)',                'K', 9),
  ('TUNNER_BAG',          'Ecopack Beige / Tunner Bag (UN markings)', 'L', 10),
  ('FG_BLACK_SLING_6X50', 'FG w/ Black Sling (6X50)',                 'M', 11),
  ('FG_ALL_BLACK',        'FG All Black (4X8)',                       'N', 12),
  ('KOREA_WHITE',         'Korea (White)',                            'O', 13),
  ('MAEHATA_580',         '580 kls (Maehata) (8X50)',                 'P', 14)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- Seed 2 — 2026 opening balances (all 14 codes; non-listed = 0)
-- SELECT-from-types so no uuids are hardcoded.
-- ============================================================
INSERT INTO public.flecon_bag_opening_balances (bag_type_id, year, qty)
SELECT t.id, 2026,
  CASE t.code
    WHEN 'KURARAY_590_NEW'     THEN 20
    WHEN 'KURARAY_RETURN'      THEN 340
    WHEN 'FG_BLACK_SLING_6X50' THEN 207
    WHEN 'FG_ALL_BLACK'        THEN 108
    WHEN 'KOREA_WHITE'         THEN 25
    WHEN 'MAEHATA_580'         THEN 507
    ELSE 0
  END
FROM public.flecon_bag_types t
ON CONFLICT (bag_type_id, year) DO NOTHING;

-- ============================================================
-- 4. view_flecon_bag_balance — SQL-computed running balance (HARD RULE)
--    One row per bag type. Opening = CURRENT-year opening (0 if none).
--    LEFT JOIN movements so a type with no movements still shows opening.
-- ============================================================
CREATE OR REPLACE VIEW public.view_flecon_bag_balance AS
SELECT
  t.id                                                          AS bag_type_id,
  t.code,
  t.label,
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
GROUP BY t.id, t.code, t.label, t.sort_order, ob.qty;

COMMENT ON VIEW public.view_flecon_bag_balance IS
  'SQL-computed per-bag-type running balance (HARD RULE — UI never recomputes in TS). balance = current-year opening + SUM(qty_delta). SECURITY INVOKER — inherits RLS from base tables.';

GRANT SELECT ON public.view_flecon_bag_balance TO authenticated;
