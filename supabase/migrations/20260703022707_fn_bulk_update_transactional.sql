-- PERF-3: make bulk edit mutations transactional.
--
-- Previously `bulkUpdateDeliveries` (rc-in) and `bulkUpdateUsage` (rc-out) looped
-- in the server action, issuing 3-4 sequential PostgREST round trips PER ROW
-- (set_audit_comment RPC -> UPDATE -> audit_logs lookup -> audit_comments insert).
-- A failure mid-loop left earlier rows committed with no rollback. These two
-- SECURITY INVOKER functions perform the whole batch in ONE transaction, so
-- either every row lands or none does.
--
-- AUDIT-TRAIL FIDELITY (must stay byte-for-byte identical to the old per-row path):
--   * deliveries: the existing AFTER trigger `deliveries_audit_trigger`
--     (log_delivery_changes) still fires per UPDATE inside this transaction and
--     writes the audit_logs row EXACTLY as before (per-key diff, snapshot=NEW,
--     performed_by=auth.uid(), only when the diff is non-empty). We do NOT
--     reimplement it -- we just run the UPDATEs and let the trigger fire.
--   * rc_out has NO audit trigger; its audit_logs are written out-of-band (the
--     Python sync). The old action still (a) set the app.audit_comment GUC and
--     (b) after each update, looked up the LATEST audit_log for the record and
--     attached the edit remark as an audit_comments row. We reproduce that glue
--     verbatim so behaviour is unchanged.
--   * The per-row `set_audit_comment` GUC is preserved for parity (the deliveries
--     trigger ignores it today, but we keep the call so nothing observable shifts).
--   * The audit_comments insert (which fires fn_notify_audit_comment) is done for
--     rows that carry a non-null/non-empty comment AND for which a latest audit_log
--     exists -- identical to the app-layer `if (comment && user && latestLog)` guard.
--
-- The UPDATE itself merges the caller-supplied partial payload over the existing
-- row and repopulates -- the same partial-update semantics PostgREST's `.update()`
-- produced (only supplied keys change; everything else is preserved).
--
-- Row payload shape (jsonb array), matching the server action's per-row struct:
--   [{ "id": "<uuid>", "data": { <column>: <value>, ... }, "comment": "<text|null>" }, ...]

-- deliveries --------------------------------------------------------------------
create or replace function public.fn_bulk_update_deliveries(rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  elem        jsonb;
  v_id        uuid;
  v_data      jsonb;
  v_comment   text;
  v_user      uuid := auth.uid();
  v_log_id    uuid;
begin
  if rows is null or jsonb_typeof(rows) <> 'array' then
    raise exception 'fn_bulk_update_deliveries: rows must be a jsonb array';
  end if;

  for elem in select * from jsonb_array_elements(rows)
  loop
    v_id      := (elem->>'id')::uuid;
    v_data    := elem->'data';
    v_comment := elem->>'comment';  -- ->> yields NULL for jsonb null / missing key

    if v_id is null then
      raise exception 'fn_bulk_update_deliveries: every row needs an id';
    end if;

    -- Preserve the exact GUC set the old action did (deliveries trigger ignores it,
    -- kept only so nothing observable changes).
    perform set_config('app.audit_comment', v_comment, true);

    -- Partial-update merge: only the keys present in `data` change; the rest of the
    -- row is preserved -- identical to PostgREST `.update(payload)`. The AFTER trigger
    -- log_delivery_changes fires here and writes the audit_logs row as before.
    update public.deliveries d
    set (
      transaction_date, supplier, truck_plate, weight_kg, cost_basis,
      lab_results, created_at, batch_code, remarks, sacks, block_loc,
      true_weight_kg, deduction_note
    ) = (
      select
        p.transaction_date, p.supplier, p.truck_plate, p.weight_kg, p.cost_basis,
        p.lab_results, p.created_at, p.batch_code, p.remarks, p.sacks, p.block_loc,
        p.true_weight_kg, p.deduction_note
      from jsonb_populate_record(d, to_jsonb(d) || v_data) as p
    )
    where d.id = v_id;

    if not found then
      raise exception 'fn_bulk_update_deliveries: no delivery with id %', v_id;
    end if;

    -- Attach the edit remark as a discussion comment on the row's latest audit_log,
    -- exactly as the old action did (guarded on comment + user + a found log).
    if v_comment is not null and v_comment <> '' and v_user is not null then
      select id into v_log_id
      from public.audit_logs
      where record_id = v_id
      order by performed_at desc
      limit 1;

      if v_log_id is not null then
        insert into public.audit_comments (audit_log_id, user_id, body)
        values (v_log_id, v_user, v_comment);
      end if;
    end if;
  end loop;
end;
$$;

-- rc_out ------------------------------------------------------------------------
create or replace function public.fn_bulk_update_usage(rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  elem        jsonb;
  v_id        uuid;
  v_data      jsonb;
  v_comment   text;
  v_user      uuid := auth.uid();
  v_log_id    uuid;
begin
  if rows is null or jsonb_typeof(rows) <> 'array' then
    raise exception 'fn_bulk_update_usage: rows must be a jsonb array';
  end if;

  for elem in select * from jsonb_array_elements(rows)
  loop
    v_id      := (elem->>'id')::uuid;
    v_data    := elem->'data';
    v_comment := elem->>'comment';

    if v_id is null then
      raise exception 'fn_bulk_update_usage: every row needs an id';
    end if;

    perform set_config('app.audit_comment', v_comment, true);

    -- Partial-update merge over the rc_out row (state/weight trigger fires as before).
    update public.rc_out r
    set (
      transaction_date, batch_id, destination, weight_kg,
      remarks, block_loc, created_at, production_batch
    ) = (
      select
        p.transaction_date, p.batch_id, p.destination, p.weight_kg,
        p.remarks, p.block_loc, p.created_at, p.production_batch
      from jsonb_populate_record(r, to_jsonb(r) || v_data) as p
    )
    where r.id = v_id;

    if not found then
      raise exception 'fn_bulk_update_usage: no usage row with id %', v_id;
    end if;

    -- rc_out has no audit trigger; attach the remark to the record's LATEST existing
    -- audit_log (identical to the old action's post-update lookup + insert).
    if v_comment is not null and v_comment <> '' and v_user is not null then
      select id into v_log_id
      from public.audit_logs
      where record_id = v_id
      order by performed_at desc
      limit 1;

      if v_log_id is not null then
        insert into public.audit_comments (audit_log_id, user_id, body)
        values (v_log_id, v_user, v_comment);
      end if;
    end if;
  end loop;
end;
$$;

-- Lock down execution surface: no anon (matches advisor guidance to keep new
-- functions off the anon role). Authenticated callers only; RLS on the underlying
-- tables still applies because these are SECURITY INVOKER.
revoke execute on function public.fn_bulk_update_deliveries(jsonb) from anon;
revoke execute on function public.fn_bulk_update_usage(jsonb) from anon;
grant execute on function public.fn_bulk_update_deliveries(jsonb) to authenticated;
grant execute on function public.fn_bulk_update_usage(jsonb) to authenticated;
