-- fn_flecon_replace_date — ATOMIC flecon REPLACE-BY-DATE (BUG-015 defect C3, 2026-07-27)
--
-- WHY
-- ---
-- The flecon sync's write model is REPLACE-BY-DATE: for each changed day it DELETEs that
-- date's `flecon_bag_movements` rows and re-INSERTs the workbook's current movements. The
-- worker did that as TWO independent PostgREST calls (`deleteByDate` then `insert`), which
-- is NOT transactional: a failure, a network drop, or a run Stop between them left the day
-- DELETED with nothing inserted. Worse, the manual audit row was only written when the
-- insert came back with rows, so a delete-to-empty outcome left NO audit trail at all.
-- That combination wiped 2026-07-22 in production (run of 2026-07-23 06:43) and only
-- self-healed because the date happened to fall inside the next run's 3-day window. A
-- wiped MIDDLE date would have been gone permanently, silently.
--
-- This RPC makes the pair all-or-nothing and returns a marker id from EITHER side so the
-- caller can ALWAYS write its audit row (including a delete-only outcome).
--
-- Mirrors the existing transactional bulk RPCs (`fn_bulk_update_deliveries` /
-- `fn_bulk_update_usage`): SECURITY INVOKER, `search_path` pinned, EXECUTE revoked from
-- PUBLIC and granted only to the roles that call it. `flecon_bag_movements` has NO audit
-- trigger, so the worker keeps writing its own `write_ingestion_audit` row afterwards.
--
-- CONTRACT
-- --------
--   p_date  date   — the transaction_date to replace (the whole day).
--   p_rows  jsonb  — a JSON ARRAY of movement objects. Each element supplies
--                    transaction_date, particular, bag_type_id, qty_delta, source_row,
--                    remarks. `transaction_date` is FORCED to p_date so a payload can
--                    never smuggle rows onto another day.
--   returns jsonb  — {deleted, deleted_first_id, inserted, first_id}
--
-- An EMPTY p_rows array is accepted (it deletes the day) — the SYNC layer, not the DB, is
-- what refuses a delete-to-empty (apply.ts `delete_to_empty_blocked`). Keeping the RPC
-- mechanical means a deliberate human-driven clear stays possible.

create or replace function public.fn_flecon_replace_date(
  p_date date,
  p_rows jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_deleted_ids   uuid[];
  v_inserted_ids  uuid[];
begin
  if p_date is null then
    raise exception 'fn_flecon_replace_date: p_date is required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'fn_flecon_replace_date: p_rows must be a JSON array (got %)',
      coalesce(jsonb_typeof(p_rows), 'null');
  end if;

  -- 1. DELETE the whole day, capturing the removed ids (audit marker fallback).
  with removed as (
    delete from public.flecon_bag_movements
    where transaction_date = p_date
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_deleted_ids from removed;

  -- 2. INSERT the replacement rows in the SAME transaction. transaction_date is forced
  --    to p_date so the payload can never write outside the day it claims to replace.
  with added as (
    insert into public.flecon_bag_movements
      (transaction_date, particular, bag_type_id, qty_delta, source_row, remarks)
    select
      p_date,
      nullif(r->>'particular', ''),
      (r->>'bag_type_id')::uuid,
      (r->>'qty_delta')::int,
      nullif(r->>'source_row', '')::int,
      nullif(r->>'remarks', '')
    from jsonb_array_elements(p_rows) as r
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_inserted_ids from added;

  return jsonb_build_object(
    'deleted', coalesce(array_length(v_deleted_ids, 1), 0),
    'deleted_first_id', v_deleted_ids[1],
    'inserted', coalesce(array_length(v_inserted_ids, 1), 0),
    'first_id', v_inserted_ids[1]
  );
end;
$$;

comment on function public.fn_flecon_replace_date(date, jsonb) is
  'ATOMIC flecon REPLACE-BY-DATE: DELETE + INSERT one transaction_date of '
  'flecon_bag_movements in ONE transaction. Returns {deleted, deleted_first_id, '
  'inserted, first_id}. Called by the sync worker (service_role). See BUG-015.';

revoke execute on function public.fn_flecon_replace_date(date, jsonb) from public;
revoke execute on function public.fn_flecon_replace_date(date, jsonb) from anon;
grant execute on function public.fn_flecon_replace_date(date, jsonb) to service_role;
