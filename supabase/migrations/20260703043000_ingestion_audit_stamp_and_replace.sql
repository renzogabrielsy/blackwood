-- Sync-button hotfixes surfaced by the first real "Run Sync" click (2026-07-03).
--
-- ① stamp_ingestion_audit — the UPDATE counterpart to write_ingestion_audit.
--    The `deliveries` audit row is written by the AFTER-insert trigger
--    (log_delivery_changes, SECURITY DEFINER). The sync writer then UPDATEs that
--    row's comment to stamp provenance (L-001 — never a 2nd row). That UPDATE went
--    direct to audit_logs over PostgREST as service_role, which has NO grant on
--    audit_logs → 403 (42501). Same L-009 class as the INSERT path; this is its
--    UPDATE sibling. SECURITY DEFINER, owner postgres, service_role-only EXECUTE.
--
-- ② audit_logs_operation_check — allow 'REPLACE'. The flecon REPLACE-BY-DATE apply
--    logs one audit row per replaced day with operation='REPLACE', but the check
--    constraint only permitted INSERT/UPDATE/DELETE → 400 (23514). REPLACE is a
--    real, honest operation for the whole-day replace model, so it joins the list.

-- ① ------------------------------------------------------------------------
create or replace function public.stamp_ingestion_audit(
  p_table_name text,
  p_record_id  uuid,
  p_operation  text,
  p_comment    text,
  p_snapshot   jsonb default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- Stamp provenance onto the trigger-written audit row(s) for this record+operation.
  -- Mirrors the prior direct PATCH: comment always set; snapshot only when supplied.
  update public.audit_logs
     set comment  = p_comment,
         snapshot = coalesce(p_snapshot, snapshot)
   where table_name = p_table_name
     and record_id  = p_record_id
     and operation  = p_operation;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.stamp_ingestion_audit(text, uuid, text, text, jsonb) from public;
revoke all on function public.stamp_ingestion_audit(text, uuid, text, text, jsonb) from anon;
revoke all on function public.stamp_ingestion_audit(text, uuid, text, text, jsonb) from authenticated;
grant execute on function public.stamp_ingestion_audit(text, uuid, text, text, jsonb) to service_role;

-- ② ------------------------------------------------------------------------
alter table public.audit_logs drop constraint if exists audit_logs_operation_check;
alter table public.audit_logs add constraint audit_logs_operation_check
  check (operation = any (array['INSERT', 'UPDATE', 'DELETE', 'REPLACE']));
