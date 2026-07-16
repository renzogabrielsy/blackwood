INSERT INTO cenapro.warehouse_opening_balance (warehouse_code,grade_code,side,period_start_date,opening_flec_count) VALUES
('WHSE 7','3X50','RS','2026-03-10',53),
('WHSE 7','2X6','LS','2026-03-10',26)
ON CONFLICT (warehouse_code,grade_code,side,period_start_date) DO UPDATE SET opening_flec_count=EXCLUDED.opening_flec_count;
