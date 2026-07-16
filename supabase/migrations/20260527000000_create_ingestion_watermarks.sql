-- ============================================================
-- Ingestion Watermarks — tracks Gmail poll state per report type.
-- Phase B (Gmail integration) writes here; Phase A just creates the table.
-- No RLS needed — this is system state, not user data.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ingestion_watermarks (
  report_type             text PRIMARY KEY,
  last_email_id           text,
  last_email_received_at  timestamptz,
  last_run_at             timestamptz NOT NULL DEFAULT now()
);

-- Grant to all Supabase roles — same pattern as other system tables.
-- RLS is not enabled; service role bypasses it anyway, and this is
-- never read by user-facing queries.
GRANT ALL ON TABLE public.ingestion_watermarks TO anon, authenticated, service_role;
