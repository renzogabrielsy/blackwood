-- Weight Deductions / True-Weight feature — SCHEMA layer (piece 1 of 3)
-- Locked design: DEDUCTIONS_DESIGN.md (2026-06-25).
--
-- Adds two PURELY ADDITIVE, DISPLAY-ONLY, NULLABLE annotation columns to
-- public.deliveries. NOTHING computational uses them: no triggers, no views,
-- no balance/closing/blend logic. weight_kg stays the Sheet-DEDUCTED weight
-- (the only value the sync compares) and cost_basis stays the FULL price —
-- both unchanged in type, nullability, and semantics. These two columns are
-- extra informational tags the sync populates and the UI reads.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No backfill, no defaults, no
-- constraints, no RLS changes (existing authenticated policies on deliveries
-- already cover every column).

ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS true_weight_kg numeric;
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS deduction_note text;

COMMENT ON COLUMN public.deliveries.true_weight_kg IS
  'Display-only / informational. Physical (gross) weight BEFORE both ASH and wet deductions. NULL = ordinary load with no deduction; "tagged" = true_weight_kg IS NOT NULL. NEVER used in any balance, closing, blend, or computation — weight_kg (the Sheet-deducted weight) remains the sole value every balance uses.';

COMMENT ON COLUMN public.deliveries.deduction_note IS
  'Display-only / informational. Short human-readable note explaining the deduction, e.g. ''-5.86% ASH; -1,009 wet''. NULL = no deduction. Never parsed for or used in any computation.';
