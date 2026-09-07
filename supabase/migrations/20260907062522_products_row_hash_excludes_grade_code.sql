-- ============================================================================
-- products_row_hash_excludes_grade_code
-- ============================================================================
-- A CORRECTION, caught by a test the same day `products_inventory` landed, recorded as
-- its own migration because the reasoning matters more than the comment text.
--
-- `product_movements.row_hash` was specified as
--     sha256(grade code | date | stage | flec | kg | remarks | source_row)
-- and the grade code has been REMOVED from it. With the code in the hash, every row hash
-- changes the instant a tab is renamed, and two things follow:
--
--  1. A rename REWRITES THE WHOLE LEDGER. Renaming `Kuraray 3x50` deleted and re-inserted
--     all 127 of its movements and reported that to the operator as 127 added / 127
--     removed — motion where nothing moved.
--  2. Far worse: RUNG 2 OF THE RENAME LADDER COULD NEVER FIRE. That rung asks "do >= 80%
--     of this tab's movements already exist under a grade whose tab has gone?" — and the
--     two sides were hashed under two different codes, so the overlap was structurally
--     always zero. The rung that exists to catch a tab renamed AND edited at the same time
--     was dead code from the moment it was written.
--
-- The hash never needed the code: `product_movements` is UNIQUE on (grade_id, row_hash),
-- so the grade already scopes it. Two different products sharing a row hash is harmless
-- and cannot collide; a renamed product NOT sharing its own is the bug.
--
-- NO DATA CHANGE. `product_movements` was empty when this was applied.
comment on column public.product_movements.row_hash is
  'sha256 hex of date|stage|flec|kg|remarks|source_row — THE replace-by-grade idempotency '
  'key. A row whose hash is already present under this grade is left untouched (no UPDATE), '
  'so a re-run of an unchanged tab writes literally nothing. The GRADE CODE is deliberately '
  'NOT in it: the UNIQUE (grade_id, row_hash) already scopes the hash to one product, and '
  'including the code made every rename rewrite the whole ledger AND made the rename '
  'ladder''s row-overlap rung structurally incapable of firing. `source_row` IS in it, '
  'because the sheet legitimately repeats byte-identical movements and without it two real '
  'rows would collapse into one.';
