-- production_schedule: one row per calendar day, sourced from the Google
-- Sheet's "PROD SCHED" tab. The planned production plan that lets the Home
-- Digest resolve operational-day STATES (reported/awaiting/rest/stale/idle)
-- and a plant-status + this-week plan. This is a PLAN, not price data — no
-- price gating.
CREATE TABLE IF NOT EXISTS public.production_schedule (
  plan_date      date PRIMARY KEY,
  year           int NOT NULL,
  month          int NOT NULL,
  dow            text,
  shifts         int NOT NULL DEFAULT 0,   -- 0 = planned rest/holiday, 1 = normal, 2 = double
  setup          text,                     -- planned line setup, null on rest days
  projected_tons numeric,                  -- planned TTL tons for the day
  grades         jsonb,                    -- per-grade projected tons, e.g. {"3X50":21,"4X8":5}
  remarks        text,
  source         text NOT NULL DEFAULT 'gsheet:PROD SCHED',
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.production_schedule IS
  'Daily production PLAN sourced from the Google Sheet "PROD SCHED" tab (one row per calendar day). Feeds the Home Digest operational-day states + plant-status + week plan. Written by the sync worker / scripts/sync-prod-schedule.ts (service role, replace-by-plan_date). Not price data — no gating.';
COMMENT ON COLUMN public.production_schedule.shifts IS '0 = planned rest/holiday, 1 = normal shift, 2 = double shift';
COMMENT ON COLUMN public.production_schedule.projected_tons IS 'Planned TTL tons for the day (sheet col S "TTL KG", which is actually tons).';
COMMENT ON COLUMN public.production_schedule.grades IS 'Per-grade projected tons jsonb, zeros/nulls dropped, e.g. {"3X50":21,"4X8":5}.';

-- Index for month-window scans (week/month plan lookups by year+month).
CREATE INDEX IF NOT EXISTS idx_production_schedule_year_month
  ON public.production_schedule (year, month);

-- RLS: single-org posture — authenticated = org member = broad read.
-- Writes go through the service-role key (bypasses RLS), so no write policy.
ALTER TABLE public.production_schedule ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "production_schedule_select_authenticated" ON public.production_schedule;
CREATE POLICY "production_schedule_select_authenticated"
  ON public.production_schedule
  FOR SELECT
  TO authenticated
  USING (true);

GRANT SELECT ON public.production_schedule TO authenticated;
-- The sync worker / scripts write with the service-role key. RLS bypass is NOT
-- grant bypass, so service_role needs explicit table privileges.
GRANT ALL ON public.production_schedule TO service_role;
REVOKE ALL ON public.production_schedule FROM anon;
