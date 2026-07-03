-- L-009 fix: give the app's service-role key a locked-down path to write ingestion
-- audit rows, WITHOUT granting broad INSERT on audit_logs.
--
-- Background (verified live 2026-07-03, SYNC_EFFICIENCY_AUDIT §5A):
--   * audit_logs grants: authenticated = SELECT/UPDATE; postgres = ALL.
--     service_role and anon have NO grants — nobody but postgres can INSERT.
--   * The sync employees only avoid the 403 today because the Supabase MCP connects
--     as `postgres` (superuser). The service-role key over PostgREST genuinely 403s
--     on a manual audit_logs INSERT (403 permission denied for table audit_logs, 42501).
--   * `deliveries` INSERTs still produce audit rows because log_delivery_changes() is
--     SECURITY DEFINER owned by postgres. rc_out / production_* / flecon have no such
--     trigger — their audit rows are manual INSERTs the service role cannot make.
--
-- Fix (preferred over a broad table grant): a SECURITY DEFINER RPC owned by postgres,
-- mirroring the existing set_audit_comment() pattern. The audit table stays locked down;
-- only this one narrow, purpose-built function can insert an ingestion audit row, and
-- only service_role may call it. The app side and lib/db.py both call this RPC.
--
-- performed_by is forced to NULL (sync-provenance convention: provenance lives in the
-- comment string, not a user id).

CREATE OR REPLACE FUNCTION public.write_ingestion_audit(
  p_table_name text,
  p_record_id  uuid,
  p_operation  text,
  p_diff       jsonb DEFAULT NULL,
  p_snapshot   jsonb DEFAULT NULL,
  p_comment    text  DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_table_name IS NULL OR btrim(p_table_name) = '' THEN
    RAISE EXCEPTION 'write_ingestion_audit: p_table_name is required';
  END IF;
  IF p_record_id IS NULL THEN
    RAISE EXCEPTION 'write_ingestion_audit: p_record_id is required';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'write_ingestion_audit: p_operation is required';
  END IF;

  INSERT INTO public.audit_logs (
    table_name, record_id, operation, diff, snapshot, comment, performed_by
  )
  VALUES (
    p_table_name, p_record_id, p_operation, p_diff, p_snapshot, p_comment, NULL
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

ALTER FUNCTION public.write_ingestion_audit(text, uuid, text, jsonb, jsonb, text)
  OWNER TO postgres;

-- Lock the door: no PUBLIC/anon/authenticated access. Only service_role may call it.
REVOKE ALL ON FUNCTION public.write_ingestion_audit(text, uuid, text, jsonb, jsonb, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.write_ingestion_audit(text, uuid, text, jsonb, jsonb, text)
  FROM anon;
REVOKE ALL ON FUNCTION public.write_ingestion_audit(text, uuid, text, jsonb, jsonb, text)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.write_ingestion_audit(text, uuid, text, jsonb, jsonb, text)
  TO service_role;

COMMENT ON FUNCTION public.write_ingestion_audit(text, uuid, text, jsonb, jsonb, text) IS
  'SECURITY DEFINER (owner postgres) ingestion audit writer for the sync employees / '
  'in-app Run Sync button. Inserts one audit_logs row with performed_by=NULL and returns '
  'its id. service_role-only; closes the L-009 grant gap without granting broad INSERT on '
  'audit_logs. Mirrors set_audit_comment. Use for tables with NO audit trigger '
  '(rc_out, production_*, electricity_readings, truck_readings, flecon_bag_movements). '
  'deliveries still relies on its SECURITY DEFINER audit trigger — UPDATE that row for '
  'provenance (L-001), do not call this for a deliveries INSERT.';
