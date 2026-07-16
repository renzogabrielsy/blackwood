-- Register 8 additional FLECON bag types (columns Q–X of the operator's
-- FLECON BAG MOVEMENT sheet) that were previously omitted.
-- Additive only: the existing 14 types (C–P) are untouched.
--
-- Registering these with their source_column letters is what makes the
-- extractor scrape them: it matches sheet columns to flecon_bag_types by
-- normalized source_label, and its scan window extends to
-- max(P, registry source_columns).
--
-- No view change needed (view_flecon_bag_balance already joins all types +
-- openings). Table-level grants + RLS already cover new rows.

-- 1 + 2. Register the 8 new bag types (with source_label inline).
INSERT INTO flecon_bag_types (code, label, source_column, source_label, sort_order, active)
VALUES
  ('SMALL_MOUTH_LOCAL_WHITE', 'Small Mouth / Local (White)',       'Q', 'Small Mouth Local (White)',           15, true),
  ('KOREA_WHITE_SUNDRY',      'Korea White Sundry (Big Opening)',  'R', 'Korea White Sundry Big Opening',      16, true),
  ('KOREA_550_POWDER',        '550 Korea Beige & White (Powder)',  'S', '550 (Korea) Biege & white Powder',    17, true),
  ('BEIGE_BAG_SUNDRY',        'Beige Bag (Sundry)',                'T', 'Beige Bag Sundry',                    18, true),
  ('BW_SUNDRY_OLD_STOCK',     'Black/White Sundry (Old Stock)',    'U', 'Black/White Sundry Old Stock',        19, true),
  ('ZAMBOANGA_BAG',           'Zamboanga Bag',                     'V', 'Zamboanga Bag',                       20, true),
  ('OLD_STOCKS',              'From Old Stocks',                   'W', 'from Old Stocks',                     21, true),
  ('DAMAGED_BAGS',            'Damaged Bags',                      'X', 'Damaged Bags',                        22, true);

-- 3. 2026 opening balances for the 8 new types.
--    bag_type_id resolved by code (no hardcoded uuids).
INSERT INTO flecon_bag_opening_balances (bag_type_id, year, qty)
SELECT ft.id, 2026, v.qty
FROM (VALUES
  ('SMALL_MOUTH_LOCAL_WHITE', 385),
  ('KOREA_WHITE_SUNDRY',       89),
  ('KOREA_550_POWDER',          0),
  ('BEIGE_BAG_SUNDRY',         14),
  ('BW_SUNDRY_OLD_STOCK',       2),
  ('ZAMBOANGA_BAG',            98),
  ('OLD_STOCKS',               30),
  ('DAMAGED_BAGS',              0)
) AS v(code, qty)
JOIN flecon_bag_types ft ON ft.code = v.code;
