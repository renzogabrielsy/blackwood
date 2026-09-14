-- ALREADY APPLIED (2026-09-14) — this file RECORDS a migration that was run
-- through the Supabase MCP during the incident; do NOT re-apply it by hand.
-- WHY: fn_ops_ledger_verify() count(*)'d and cross-checked every view_ops_ledger_*
-- view over the WHOLE of history in ONE call, hung the instance (OOM) and took
-- the live site down until a dashboard restart. Its replacement is per-campaign.
DROP FUNCTION IF EXISTS public.fn_ops_ledger_verify();
