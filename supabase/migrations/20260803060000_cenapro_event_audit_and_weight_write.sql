-- ─────────────────────────────────────────────────────────────────────────────────
-- Cenapro (Tenant #2) — an AUDIT TRAIL for production_event, and a guarded
-- weight write path for the QC Ledger.
--
-- WHY THIS EXISTS
-- `cenapro.production_event` carries the partner-receipt weights CCC's lab results
-- are weighted by. Until now it had exactly ONE trigger (`tr_cenapro_pe_unique_tag`)
-- and NO audit of any kind: the production ledger already let an operator edit
-- `weight_kg` in place and nothing recorded who changed what. The QC Ledger is about
-- to make that edit far more convenient (typo fixes at the point of reading), so the
-- trail has to exist first.
--
-- WHY A DEDICATED cenapro TABLE, NOT `public.audit_logs`
-- `public.audit_logs` is ICTC's. Cenapro's hard requirement is zero coupling to the
-- ICTC tenant — and `audit_logs` is not an inert log: it is read by the ICTC audit
-- UI, joined by `audit_comments` / `notification_subscriptions`, and fed into the
-- `_insert_notification` fan-out. Cenapro rows landing there would surface inside
-- another tenant's screens. A sibling table in `cenapro` keeps the wall intact and
-- costs one small relation.
--
-- WHY NOT `cenapro.drift_log`
-- drift_log is INGEST telemetry: "this workbook row was parked / excluded / had a
-- colliding unique_tag". It has no old→new pair and no actor, and mixing "the loader
-- skipped this" with "a human retyped a weight" would make both harder to read.
--
-- WHY A TRIGGER, NOT AUDITING INSIDE THE RPC
-- `weight_kg` has TWO live write paths — the new QC RPC below AND the production
-- ledger's direct UPDATE through the auto-updatable `public.cenapro_production_events`
-- view. An RPC-side audit would trail one of them and quietly miss the other, which
-- is worse than no trail because it looks complete. The trigger catches every writer,
-- including a future sync or a manual SQL fix.
-- ─────────────────────────────────────────────────────────────────────────────────

-- ─── 1. The audit table ──────────────────────────────────────────────────────────
create table if not exists cenapro.production_event_audit (
    id          bigint generated always as identity primary key,

    -- Denormalized identity, so the trail stays readable after the event is deleted.
    event_id    uuid        not null,
    unique_tag  text,
    recv_date   date,

    operation   text        not null
                check (operation in ('INSERT', 'UPDATE', 'DELETE')),

    -- UPDATE only: {"weight_kg": {"old": 40437.0, "new": 40000.0}, ...} — ONLY the
    -- columns that actually moved, `updated_at` excluded (the unique_tag trigger
    -- bumps it on every write, so it is noise, not a change). '{}' on INSERT/DELETE,
    -- where the whole row IS the change and `snapshot` already carries it.
    changed     jsonb       not null default '{}'::jsonb,

    -- The full row: NEW on INSERT/UPDATE, OLD on DELETE.
    snapshot    jsonb       not null,

    -- Which surface wrote it, when the writer says so (`cenapro.audit_source`, set
    -- transaction-locally by the RPC below). NULL = a direct write through the view
    -- (today: the production ledger grid).
    source      text,

    changed_at  timestamptz not null default now(),

    -- auth.uid() — NULL for a service-role / psql write, which is the honest answer.
    -- Deliberately NO foreign key to public.profiles (unlike cenapro.analysis_sample):
    -- an audit row must outlive the account that wrote it, and ON DELETE SET NULL
    -- would erase the actor from history.
    changed_by  uuid,
    -- The PostgREST role behind the write ('authenticated' / 'service_role' / …).
    changed_by_role text
);

comment on table cenapro.production_event_audit is
    'Append-only trail of every INSERT/UPDATE/DELETE on cenapro.production_event. Written ONLY by the SECURITY DEFINER trigger cenapro.fn_audit_production_event(); no role holds INSERT/UPDATE/DELETE on it.';

create index if not exists idx_cenapro_pe_audit_event
    on cenapro.production_event_audit (event_id, changed_at desc);

create index if not exists idx_cenapro_pe_audit_recent
    on cenapro.production_event_audit (changed_at desc);

-- ─── 2. The trigger function ─────────────────────────────────────────────────────
-- SECURITY DEFINER on purpose: combined with the REVOKEs below it means the trigger
-- is the ONLY thing that can write this table. A SECURITY INVOKER trigger would need
-- INSERT granted to `authenticated`, and a grant that lets the trigger write also
-- lets a client forge a row by hand.
create or replace function cenapro.fn_audit_production_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
DECLARE
    v_old      jsonb;
    v_new      jsonb;
    v_changed  jsonb := '{}'::jsonb;
    v_snapshot jsonb;
    v_event_id uuid;
    v_tag      text;
    v_recv     date;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_old      := to_jsonb(OLD);
        v_snapshot := v_old;
        v_event_id := OLD.id;
        v_tag      := OLD.unique_tag;
        v_recv     := OLD.recv_date;
    ELSE
        v_new      := to_jsonb(NEW);
        v_snapshot := v_new;
        v_event_id := NEW.id;
        v_tag      := NEW.unique_tag;
        v_recv     := NEW.recv_date;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);

        SELECT coalesce(
                   jsonb_object_agg(k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k)),
                   '{}'::jsonb)
          INTO v_changed
          FROM jsonb_object_keys(v_new) AS k
         WHERE k <> 'updated_at'
           AND (v_old -> k) IS DISTINCT FROM (v_new -> k);

        -- Nothing but the touch timestamp moved. An audit row here would be a lie.
        IF v_changed = '{}'::jsonb THEN
            RETURN NULL;
        END IF;
    END IF;

    INSERT INTO cenapro.production_event_audit
        (event_id, unique_tag, recv_date, operation, changed, snapshot,
         source, changed_by, changed_by_role)
    VALUES
        (v_event_id, v_tag, v_recv, TG_OP, v_changed, v_snapshot,
         nullif(current_setting('cenapro.audit_source', true), ''),
         auth.uid(),
         auth.role());

    RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;

comment on function cenapro.fn_audit_production_event() is
    'AFTER INSERT/UPDATE/DELETE trail for cenapro.production_event. Skips an UPDATE whose only difference is updated_at. SECURITY DEFINER so the audit table needs no write grant to any client role.';

-- A function is born with EXECUTE granted to PUBLIC. This one is SECURITY DEFINER, so
-- leave nothing callable that does not need to be — PostgreSQL checks EXECUTE when the
-- TRIGGER IS CREATED, not each time it fires, so firing is unaffected. (It is a
-- `returns trigger` function, which PostgREST cannot expose as an RPC either; this is
-- belt AND braces, and the CLAUDE.md rule for every new function.)
revoke all on function cenapro.fn_audit_production_event() from public;

drop trigger if exists tr_cenapro_pe_audit on cenapro.production_event;
create trigger tr_cenapro_pe_audit
    after insert or update or delete on cenapro.production_event
    for each row execute function cenapro.fn_audit_production_event();

-- ─── 3. Grants — the cenapro DEFAULT ACL trap ────────────────────────────────────
-- The `cenapro` schema carries a default ACL of {anon=r, authenticated=arwd,
-- service_role=arwd}, so a table created here is BORN readable by anon and writable
-- by authenticated whatever the CREATE said. Revoke both, then hand back read-only.
revoke all on cenapro.production_event_audit from anon;
revoke all on cenapro.production_event_audit from authenticated;
revoke all on cenapro.production_event_audit from service_role;
grant select on cenapro.production_event_audit to authenticated, service_role;

-- The identity sequence is born with the same default ACL. Nothing but the definer
-- trigger inserts, so no client role needs it. Scoped by name, never a blanket
-- "all sequences in schema cenapro" — that would sweep up objects this migration
-- knows nothing about.
do $$
DECLARE
    v_seq text := pg_catalog.pg_get_serial_sequence('cenapro.production_event_audit', 'id');
BEGIN
    IF v_seq IS NOT NULL THEN
        EXECUTE format('revoke all on sequence %s from anon, authenticated', v_seq);
    END IF;
END;
$$;

-- ─── 4. A read-only public accessor (the module's exposure pattern) ──────────────
-- `cenapro` is not exposed to PostgREST, so a trail nobody can read from the app is
-- only half a trail. SECURITY INVOKER + SELECT-only, same as every other accessor.
create or replace view public.cenapro_production_event_audit
with (security_invoker = true) as
select a.id,
       a.event_id,
       a.unique_tag,
       a.recv_date,
       a.operation,
       a.changed,
       a.snapshot,
       a.source,
       a.changed_at,
       a.changed_by,
       a.changed_by_role
  from cenapro.production_event_audit a;

comment on view public.cenapro_production_event_audit is
    'Read-only window onto cenapro.production_event_audit. SELECT only — the trail is written exclusively by cenapro.fn_audit_production_event().';

revoke all on public.cenapro_production_event_audit from anon;
revoke all on public.cenapro_production_event_audit from authenticated;
revoke all on public.cenapro_production_event_audit from service_role;
grant select on public.cenapro_production_event_audit to authenticated, service_role;

-- ─── 5. The weight write path ────────────────────────────────────────────────────
-- COMPARE-AND-SET, not a row_version. `production_event` has no version column, and
-- adding one would force the production ledger's bulk upsert to respect it too — a
-- much wider change than a typo fix warrants. Instead the caller passes the weight it
-- is looking at, and the UPDATE only fires when the stored value still equals it, IN
-- THE SAME STATEMENT as the write (the fn_save_schedule_day / cenapro_save_analysis_
-- sample idiom — never read-then-write, never blind-write). Zero rows matched means
-- somebody else moved it, and that is a human's problem, not something to retry.
--
-- Four outcomes, all reported verbatim: updated / conflict / not_found / invalid.
create or replace function public.cenapro_update_event_weight(
    p_event_id            uuid,
    p_expected_weight_kg  numeric,
    p_weight_kg           numeric
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
DECLARE
    v_current numeric;
BEGIN
    IF p_event_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'No receipt row was identified. Reload the ledger and try again.');
    END IF;

    -- A NULL expected value cannot be compared, so it would be a blind write.
    IF p_expected_weight_kg IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'The weight currently on screen was not supplied, so this edit could not be checked against it. Reload the ledger.');
    END IF;

    IF p_weight_kg IS NULL OR NOT (p_weight_kg > 0) THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'A weight must be a positive number of kilograms.');
    END IF;

    -- Unit sanity only, deliberately far above the heaviest draw on record
    -- (139,917 kg) — a bound tuned to observed data would reject the first genuinely
    -- large receipt. This catches a mistyped extra digit run, not a big day.
    IF p_weight_kg > 10000000 THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'That weight is over 10,000,000 kg — check for a mistyped digit.');
    END IF;

    IF pg_catalog.scale(p_weight_kg) > 3 THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'invalid',
            'message', 'A weight carries at most 3 decimal places.');
    END IF;

    -- Tell the audit trigger which surface this came from, and CLEAR IT AGAIN the
    -- moment the statement it describes is over. `set_config(…, true)` is
    -- transaction-local, not statement-local: leave it set and any later write in the
    -- same transaction — a direct UPDATE through the auto-updatable view, say — would
    -- be trailed as `qc_ledger` when it was nothing of the sort. Each PostgREST request
    -- is its own transaction so it would not bite today, but a `source` column that is
    -- only conditionally true is worse than no `source` column.
    PERFORM pg_catalog.set_config('cenapro.audit_source', 'qc_ledger', true);

    UPDATE cenapro.production_event AS e
       SET weight_kg = p_weight_kg
     WHERE e.id        = p_event_id
       AND e.weight_kg = p_expected_weight_kg;

    PERFORM pg_catalog.set_config('cenapro.audit_source', '', true);

    IF FOUND THEN
        RETURN jsonb_build_object(
            'ok', true, 'outcome', 'updated',
            'id', p_event_id, 'weight_kg', p_weight_kg);
    END IF;

    SELECT e.weight_kg INTO v_current
      FROM cenapro.production_event e
     WHERE e.id = p_event_id;

    IF v_current IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false, 'outcome', 'not_found',
            'message', 'That receipt row no longer exists - it was deleted. Reload the ledger.');
    END IF;

    -- `trim_scale` so a stored 16434.0 reads "16434", not "16434." — to_char's FM
    -- mask leaves a dangling decimal point whenever the fraction is zero, and 751 of
    -- the 1,108 rows on record are stored at scale 1.
    RETURN jsonb_build_object(
        'ok', false, 'outcome', 'conflict',
        'weight_kg', v_current,
        'message', 'The stored weight is now ' ||
                   pg_catalog.trim_scale(v_current)::text ||
                   ' kg, not the ' ||
                   pg_catalog.trim_scale(p_expected_weight_kg)::text ||
                   ' kg on your screen. Someone changed it while you were editing - reload to see the current value.');
END;
$$;

comment on function public.cenapro_update_event_weight(uuid, numeric, numeric) is
    'Change ONE cenapro production event''s weight_kg, compare-and-set against the value the caller is looking at. Returns jsonb {ok, outcome: updated|conflict|not_found|invalid, ...}. Audited by tr_cenapro_pe_audit.';

revoke all on function public.cenapro_update_event_weight(uuid, numeric, numeric) from public;
grant execute on function public.cenapro_update_event_weight(uuid, numeric, numeric)
    to authenticated, service_role;
