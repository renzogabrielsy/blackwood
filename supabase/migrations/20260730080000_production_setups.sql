-- production_setups — the SETUP LIBRARY for the production plan  (2026-07-30)
--
-- WHY
-- ---
-- `production_schedule.setup` is free text today, and every operator who plots a day
-- retypes the same handful of strings and then hand-computes the tonnage that goes with
-- them. The relationship is not folklore — it is exact, and it is visible in every row of
-- the table's own history:
--
--   1. A SETUP IS A PER-SHIFT GRADE MIX.  "3X50 / 6X50" means 20 t of 3X50 + 6 t of 6X50
--      produced in one shift.
--   2. IT SCALES LINEARLY WITH `shifts`.  "SOLID 3X50" is 25 t at one shift and 50 t at
--      two — the same setup, run twice.
--   3. `projected_tons` IS THE SUM OF THE GRADE VALUES.  20+6=26, 21+5=26, 10+15=25,
--      25=25, 50=50. No row in the table's history violates this.
--
-- This table makes rule 1 a stored fact so the editor can offer a setup picker, and
-- `lib/production/setup-projection.ts` turns (grade_mix, shifts) into (grades,
-- projected_tons) via rules 2 and 3. See that module for why the arithmetic lives in TS
-- and NOT in SQL.
--
-- WHAT THIS TABLE IS NOT
-- ----------------------
-- It is NOT a constraint on `production_schedule`. There is deliberately **no foreign key**
-- from `production_schedule.setup` to `production_setups.code`:
--
--   * `setup` is NULL on the 56 rest-day rows and is written by the sync straight from
--     Joseph's email / Renzo's PROD SCHED tab. A new setup name appearing upstream must
--     land as data, not blow up Stage 3c — the sync's contract is that a schedule failure
--     can never fail the daily sync (workers/sync/specs/prod_schedule.md §0).
--   * A setup retired from the library must not invalidate the history that used it.
--
-- The library is a CONVENIENCE for the human editor and a record of intent. The plan row
-- keeps storing its own literal `setup`, `grades` and `projected_tons`, exactly as today.
--
-- PER-DAY OVERRIDES REMAIN NORMAL AND LEGAL. The projection fills the fields; the operator
-- may then change any of them. History proves this is routine: SOLID 3X50 runs 25 t on 127
-- days and 30 t on 2 days (a one-off 4X8 side-run), and 3X50 / 4X8 runs 26 t on 16 days
-- and 24 t on 2. Those are day facts, not setup definitions — which is why nothing here
-- validates a plan row against this table.
--
-- SEED PROVENANCE (verified against the live table on 2026-07-30, 273 rows)
-- ------------------------------------------------------------------------
-- Five distinct setups exist in all of history (plus NULL on 56 rest days). Each row below
-- carries the MODAL per-shift grade mix — the mix the setup actually ran on most days —
-- with the dissenting rows named in `notes` so nothing is quietly averaged away:
--
--   setup         shifts  grade mix                    days  verdict
--   SOLID 3X50      1     {"3X50":25}                   127  MODAL      -> seeded
--   SOLID 3X50      1     {"3X50":25,"4X8":5}  (30 t)     2  day override
--   SOLID 3X50      2     {"3X50":50}                    14  CORROBORATES rule 2: 50/2 = 25
--   3X50 / 6X50     1     {"3X50":20,"6X50":6}           39  UNANIMOUS  -> seeded
--   3X50 / 4X8      1     {"3X50":21,"4X8":5}            16  MODAL      -> seeded
--   3X50 / 4X8      1     {"3X50":21,"4X8":3}  (24 t)     2  day override
--   3X50 / 2X6      1     {"3X50":10,"2X6":15}           10  MODAL      -> seeded
--   3X50 / 2X6      1     {"3X50":25}                     1  see below
--   3X50 / 8X50     1     {"3X50":20,"8X50":6}            6  UNANIMOUS  -> seeded
--
-- "SOLID 3X50 at 1 shift" and "at 2 shifts" are ONE setup at two shift counts, not two
-- setups — which is exactly what rule 2 says. Hence FIVE library rows, not six.
--
-- THE `3X50 / 2X6` "MISSING 2X6" IS NOT AN ANOMALY — it is one in-app edit.
-- The single `{"3X50":25}` row is plan_date 2026-07-30: `owner='human'`,
-- `row_version=3`, `human_edited_at=2026-07-30 03:28:36Z` — i.e. a day somebody edited
-- through the Phase B editor hours before this migration was written, which dropped the
-- 2X6 key. The setup's real per-shift mix is `{"3X50":10,"2X6":15}` (10 of 11 rows), and
-- it satisfies rule 3 exactly: 10 + 15 = 25 = `projected_tons` on all 11 rows, INCLUDING
-- the edited one. Nothing is invented here and no operator decision is pending: the
-- library records what the data says, and the edited day keeps its override, because
-- overrides are a first-class outcome (see above).
--
-- Idempotent throughout (IF NOT EXISTS, DO-block for the policy/constraints, ON CONFLICT
-- DO NOTHING on the seed) so a re-apply is safe and never re-stamps an operator's edits.

-- ===========================================================================
-- 1. Table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.production_setups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The literal string that goes into `production_schedule.setup`. UNIQUE — this is the
  -- natural key the editor and the plan row agree on.
  code        text        NOT NULL UNIQUE,

  -- Short human display name for the picker. Optional; the UI falls back to `code`.
  label       text,

  -- THE DEFINITION: per-shift tonnage keyed by grade, e.g. {"3X50": 20, "6X50": 6}.
  -- PER SHIFT, not per day — `shifts` multiplies it (rule 2).
  grade_mix   jsonb       NOT NULL,

  -- Soft retirement. Prefer flipping this to false over DELETE: history keeps referencing
  -- the code as free text, and an inactive setup should still render legibly.
  active      boolean     NOT NULL DEFAULT true,

  -- Picker order. Seeded by historical usage frequency (most-used first).
  sort_order  integer     NOT NULL DEFAULT 100,

  -- Free-form operator memo / provenance.
  notes       text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.production_setups'::regclass
       AND conname  = 'production_setups_created_by_fkey'
  ) THEN
    ALTER TABLE public.production_setups
      ADD CONSTRAINT production_setups_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;

  -- grade_mix must be a NON-EMPTY JSON OBJECT. A null/array/scalar mix would make the
  -- projection meaningless, and an empty object would silently project 0 tons for a
  -- working day. Value sanity (positive numbers) is left to the writer — the check below
  -- is about SHAPE, which is what the projection actually depends on.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.production_setups'::regclass
       AND conname  = 'production_setups_grade_mix_object_check'
  ) THEN
    ALTER TABLE public.production_setups
      ADD CONSTRAINT production_setups_grade_mix_object_check
      CHECK (jsonb_typeof(grade_mix) = 'object' AND grade_mix <> '{}'::jsonb);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.production_setups'::regclass
       AND conname  = 'production_setups_code_not_blank_check'
  ) THEN
    ALTER TABLE public.production_setups
      ADD CONSTRAINT production_setups_code_not_blank_check
      CHECK (btrim(code) <> '');
  END IF;
END
$$;

COMMENT ON TABLE public.production_setups IS
  'Setup library for the production plan: one row per named per-shift grade mix. Reference data the operator maintains. Deliberately NOT foreign-keyed from production_schedule.setup (that column stays free text so a new upstream setup name can never fail the sync, and retiring a setup can never invalidate history). Consumed with lib/production/setup-projection.ts, which applies shifts and sums the mix.';
COMMENT ON COLUMN public.production_setups.code IS
  'The literal string written into production_schedule.setup. The natural key.';
COMMENT ON COLUMN public.production_setups.grade_mix IS
  'PER-SHIFT tonnage by grade, e.g. {"3X50": 20, "6X50": 6}. Multiply by production_schedule.shifts to get the day''s grades; the sum of the scaled values is projected_tons. Both steps live in lib/production/setup-projection.ts::projectSetup — the ONE implementation.';
COMMENT ON COLUMN public.production_setups.active IS
  'Soft retirement for the picker. Prefer active=false over DELETE — history references the code as free text.';
COMMENT ON COLUMN public.production_setups.sort_order IS
  'Picker order, ascending. Seeded by historical usage frequency (most-used first).';

-- The picker reads active setups in order; five rows today, but the index keeps the
-- ordered read index-only as the operator adds more.
CREATE INDEX IF NOT EXISTS idx_production_setups_active_sort
  ON public.production_setups (sort_order, code)
  WHERE active;

-- Keep updated_at honest for writes that come straight from PostgREST (the operator
-- editing the library in-app), which cannot be trusted to set it. Reuses the existing
-- generic public.handle_updated_at() — the same trigger function `profiles` uses.
DROP TRIGGER IF EXISTS production_setups_set_updated_at ON public.production_setups;
CREATE TRIGGER production_setups_set_updated_at
  BEFORE UPDATE ON public.production_setups
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ===========================================================================
-- 2. Seed — the five setups the plan has actually used (see SEED PROVENANCE above)
-- ===========================================================================
-- Literal values on purpose, NOT an INSERT…SELECT derived from production_schedule: a
-- data-derived seed would bake today's row distribution into the migration and produce a
-- different library if replayed later against a changed table. These numbers are reviewed
-- constants with their provenance recorded in the header and in `notes`.
--
-- ON CONFLICT (code) DO NOTHING — re-applying must never overwrite an operator's edit.

INSERT INTO public.production_setups (code, label, grade_mix, sort_order, notes) VALUES
  ('SOLID 3X50', 'Solid 3X50',
   '{"3X50": 25}'::jsonb, 10,
   'Modal mix, 127 of 129 one-shift days. Corroborated by rule 2: the 14 two-shift days all read {"3X50": 50} = 25 x 2. Two one-shift days ran 30 t as {"3X50":25,"4X8":5} — a day override, not this setup.'),

  ('3X50 / 6X50', '3X50 with 6X50 split',
   '{"3X50": 20, "6X50": 6}'::jsonb, 20,
   'Unanimous across all 39 days that used it. 20 + 6 = 26 t.'),

  ('3X50 / 4X8', '3X50 with 4X8 split',
   '{"3X50": 21, "4X8": 5}'::jsonb, 30,
   'Modal mix, 16 of 18 days (26 t). Two days ran {"3X50":21,"4X8":3} = 24 t — a day override.'),

  ('3X50 / 2X6', '3X50 with 2X6 split',
   '{"3X50": 10, "2X6": 15}'::jsonb, 40,
   'Modal mix, 10 of 11 days. 10 + 15 = 25 t. The 11th day (2026-07-30) reads {"3X50":25} because it was edited in-app that morning (owner=human, row_version=3) — a per-day override, not a second definition of the setup.'),

  ('3X50 / 8X50', '3X50 with 8X50 split',
   '{"3X50": 20, "8X50": 6}'::jsonb, 50,
   'Unanimous across all 6 days that used it. 20 + 6 = 26 t.')
ON CONFLICT (code) DO NOTHING;

-- ===========================================================================
-- 3. RLS / grants — single-org posture
-- ===========================================================================
-- authenticated = org member = broad read + write; this is reference data the operator
-- maintains in-app, so unlike production_schedule (whose writes must go through the
-- guarded RPCs) plain PostgREST writes are the intended path here — there is no
-- concurrency or ownership model to protect, only five rows of vocabulary.
-- anon gets nothing. Server actions + role gates remain the enforcement layer
-- (CLAUDE.md RLS posture); no per-role row predicates.

ALTER TABLE public.production_setups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "production_setups_select_authenticated" ON public.production_setups;
CREATE POLICY "production_setups_select_authenticated"
  ON public.production_setups FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "production_setups_insert_authenticated" ON public.production_setups;
CREATE POLICY "production_setups_insert_authenticated"
  ON public.production_setups FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "production_setups_update_authenticated" ON public.production_setups;
CREATE POLICY "production_setups_update_authenticated"
  ON public.production_setups FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "production_setups_delete_authenticated" ON public.production_setups;
CREATE POLICY "production_setups_delete_authenticated"
  ON public.production_setups FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_setups TO authenticated;
GRANT ALL    ON public.production_setups TO service_role;
REVOKE ALL   ON public.production_setups FROM anon;
