-- Migration: Rewrite STATE Column — Derive from RC OUT Data
-- Phase 1a: Add SUNDRYING to batch_status enum (must be in separate transaction)

-- 1a. Add SUNDRYING to batch_status enum
ALTER TYPE batch_status ADD VALUE IF NOT EXISTS 'SUNDRYING';

-- Note: Subsequent operations moved to next migration due to PostgreSQL enum safety
-- (new enum values must be committed before they can be used in function definitions)
