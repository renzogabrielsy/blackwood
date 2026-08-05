-- ─────────────────────────────────────────────────────────────────────────────────
-- Cenapro (Tenant #2) — an AUDIT TRAIL for RC DELIVERIES.
--
-- WHY THIS EXISTS
-- On 2026-08-04, 22 duplicate receipts were hard-DELETEd from cenapro.rc_delivery,
-- taking ₱17,185,938.70 of payable total with them. `public.audit_logs` contains
-- ZERO rows mentioning cenapro or rc_delivery, and cenapro.rc_delivery has never had
-- an audit trigger of its own. So there is NO trace of that deletion anywhere: not
-- which rows, not who, not when, not what they were worth. The only reason the story
-- is reconstructable at all is that a human happened to write the numbers down.
--
-- For reference data transcribed out of a workbook that can be re-read, that is
-- arguably survivable. Liquidation is about to point CHEQUES at these rows, and for a
-- cheque it is not: a supplier disagreement six months from now has to be answerable
-- from the system instead of from memory. `cenapro.production_event` got exactly this
-- treatment on 2026-08-03 (`production_event_audit`); this is its sibling, and this
-- migration is a line-for-line clone of that one's idiom.
--
-- WHY A DEDICATED cenapro TABLE, NOT `public.audit_logs`
-- `public.audit_logs` is ICTC's, and it is not an inert log: the ICTC audit UI reads
-- it, `audit_comments` / `notification_subscriptions` join it, and `_insert_notification`
-- fans out of it. Cenapro rows landing there would surface inside another tenant's
-- screens — the exact coupling CLAUDE.md forbids. A sibling table in `cenapro` keeps
-- the wall intact and costs one small relation.
--
-- WHY ONE TABLE FOR BOTH THE RECEIPT AND ITS SUB-SAMPLES
-- `cenapro.rc_delivery_sample` is a CASCADE child; a moisture draw has no meaning
-- apart from the receipt it was drawn from, and the question anyone will actually ask
-- is "what has happened to THIS receipt". So one table, discriminated by `entity`
-- ('delivery' | 'sample'), and ALWAYS keyed by `delivery_id` — a sample's audit row
-- carries the PARENT's id, never only its own. The per-receipt history is then a
-- single indexed query instead of a UNION over two trails.
--
-- WHY THE GENERATED MONEY COLUMNS ARE IN THE DIFF, NOT FILTERED OUT OF IT
-- `net_weight_kg`, `price_php_kg` and `total_price_php` are STORED GENERATED. They are
-- derived, but they are the numbers a cheque is cut against — a weight correction that
-- silently moves ₱40,000 of payable total is PRECISELY what someone comes looking for.
-- `to_jsonb(NEW)` carries all four generated columns (verified live: 41 keys), and the
-- trigger does not filter them, so `changed` shows the money moving beside its cause.
--
-- WHY AFTER, NOT BEFORE
-- Two reasons, and the second is the load-bearing one:
--   * `cenapro.fn_touch_rc_delivery` is a BEFORE trigger that bumps `row_version` /
--     `updated_at` / `updated_by`; only an AFTER trigger sees the values that were
--     actually stored.
--   * STORED GENERATED columns are computed AFTER all BEFORE triggers run. In a BEFORE
--     trigger, NEW.total_price_php is not the value the row is about to have — auditing
--     from there would record the money wrong, which is worse than not recording it.
--     (Same family of mistake as BUG-017, where tr_blackwood_delivery recomputed from a
--     table that did not yet agree with the write about to happen.)
--
-- WHY A TRIGGER, NOT AUDITING INSIDE THE RPCs
-- `rc_delivery` has TWO live write paths: the three `cenapro_save_rc_delivery*` RPCs
-- AND direct DML through the auto-updatable `public.cenapro_rc_deliveries` accessor
-- view (plus `scripts/cenapro/import-rc-deliveries.mjs`, which writes over REST as
-- service_role). An RPC-side audit would trail one and quietly miss the others, which
-- is worse than no trail because it looks complete. The trigger catches every writer,
-- including the importer and a manual SQL fix.
--
-- NO BACKFILL. NOTHING SYNTHETIC.
-- This migration writes not one historical row. The 22 deletions of 2026-08-04 left no
-- evidence and inventing a row for them would put a fabrication in the one table whose
-- entire value is that it is not fabricated. THE TRAIL STARTS NOW; everything before
-- this migration is simply unrecorded, and the docs say so.
--
-- SCOPE NOTE: this is strictly ADDITIVE. It adds no column to cenapro.rc_delivery and
-- writes nothing in it.
-- ─────────────────────────────────────────────────────────────────────────────────

-- ─── 1. The audit table ──────────────────────────────────────────────────────────
create table if not exists cenapro.rc_delivery_audit (
    id              bigint generated always as identity primary key,

    -- ALWAYS the parent receipt, for BOTH entities. This is the read key.
    delivery_id     uuid        not null,
    entity          text        not null
                    check (entity in ('delivery', 'sample')),
    -- Populated only for entity='sample'; the sub-sample's own identity.
    sample_id       uuid,
    sample_position integer,

    -- Denormalized identity, so the trail stays readable after the receipt is deleted
    -- — the same reason production_event_audit denormalizes unique_tag / recv_date.
    -- These three are what a human recognises a truck receipt by.
    delivery_date   date,
    supplier_code   text,
    truck_no        text,

    operation       text        not null
                    check (operation in ('INSERT', 'UPDATE', 'DELETE')),

    -- UPDATE only: {"gross_weight_kg": {"old": 27045, "new": 27000},
    --               "total_price_php": {"old": 916825.5, "new": 915300}} — ONLY the
    -- columns that actually moved. `updated_at` AND `row_version` are excluded: the
    -- BEFORE touch trigger bumps both on EVERY write, so they are noise, not change.
    -- The GENERATED money columns are deliberately NOT excluded (see the header).
    -- '{}' on INSERT/DELETE, where the whole row IS the change and `snapshot` has it.
    changed         jsonb       not null default '{}'::jsonb,

    -- The full row: NEW on INSERT/UPDATE, OLD on DELETE.
    snapshot        jsonb       not null,

    -- Which surface wrote it, when the writer says so (`cenapro.audit_source`, set
    -- transaction-locally by the caller). NULL = a write that did not name itself —
    -- which today is EVERY rc_delivery write, because the three save RPCs and the
    -- importer predate this trail and were not modified by this migration.
    source          text,

    changed_at      timestamptz not null default now(),

    -- auth.uid() — NULL for a service-role / psql / importer write, which is the
    -- honest answer. Deliberately NO foreign key to public.profiles (unlike
    -- cenapro.rc_delivery.created_by, which does FK with ON DELETE SET NULL): an audit
    -- row must outlive the account that wrote it, and ON DELETE SET NULL would erase
    -- the actor from history exactly when it matters.
    changed_by      uuid,
    -- The PostgREST role behind the write ('authenticated' / 'service_role' / …).
    changed_by_role text,

    -- Shape guard, in the spirit of cenapro_rc_delivery_provenance_shape: a sample row
    -- must name its sample, a delivery row must not pretend to have one.
    constraint cenapro_rc_delivery_audit_entity_shape
        check ((entity = 'sample'   and sample_id is not null)
            or (entity = 'delivery' and sample_id is null and sample_position is null))
);

comment on table cenapro.rc_delivery_audit is
    'Append-only trail of every INSERT/UPDATE/DELETE on cenapro.rc_delivery AND its CASCADE child cenapro.rc_delivery_sample, discriminated by `entity` and always keyed by the parent delivery_id. Written ONLY by the SECURITY DEFINER triggers cenapro.fn_audit_rc_delivery() / cenapro.fn_audit_rc_delivery_sample(); no role holds INSERT/UPDATE/DELETE on it. The trail starts 2026-08-05 — nothing before that date was ever recorded.';

comment on column cenapro.rc_delivery_audit.delivery_id is
    'The PARENT receipt id, for both entities — a sub-sample''s row carries its delivery''s id, never only its own. This is what makes a receipt''s whole history one indexed query.';
comment on column cenapro.rc_delivery_audit.entity is
    '''delivery'' = a cenapro.rc_delivery row; ''sample'' = a cenapro.rc_delivery_sample row.';
comment on column cenapro.rc_delivery_audit.delivery_date is
    'Denormalized receipt identity, kept so the trail is readable after the receipt is gone. On a CASCADE delete the parent row is already deleted when the child trigger fires, so the sample rows read these three back off the parent''s own DELETE audit row (which is written first — verified live).';
comment on column cenapro.rc_delivery_audit.changed is
    'UPDATE only: {column: {old, new}} for the columns that actually moved. Excludes updated_at and row_version (bumped by the touch trigger on every write). INCLUDES the STORED GENERATED money columns net_weight_kg / price_php_kg / total_price_php — a weight edit that moves the payable total is the whole point of this table.';
comment on column cenapro.rc_delivery_audit.snapshot is
    'The complete row as jsonb: NEW on INSERT/UPDATE, OLD on DELETE. Carries the generated money columns, so a deleted receipt''s payable total survives its deletion.';
comment on column cenapro.rc_delivery_audit.source is
    'The writing surface, from current_setting(''cenapro.audit_source''). NULL today for every rc_delivery write — no existing writer sets it.';
comment on column cenapro.rc_delivery_audit.changed_by is
    'auth.uid(), or NULL for a service-role / importer / psql write. NO FK to profiles on purpose: an audit row must outlive the account.';

-- The per-receipt history query, and the "what changed lately" feed.
create index if not exists idx_cenapro_rc_delivery_audit_delivery
    on cenapro.rc_delivery_audit (delivery_id, changed_at desc);

create index if not exists idx_cenapro_rc_delivery_audit_recent
    on cenapro.rc_delivery_audit (changed_at desc);

-- ─── 2. The trigger function — the receipt ───────────────────────────────────────
-- SECURITY DEFINER on purpose: combined with the REVOKEs below it means the trigger
-- is the ONLY thing that can write this table. A SECURITY INVOKER trigger would need
-- INSERT granted to `authenticated`, and a grant that lets the trigger write also
-- lets a client forge a row by hand — or erase one.
create or replace function cenapro.fn_audit_rc_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
DECLARE
    v_old         jsonb;
    v_new         jsonb;
    v_changed     jsonb := '{}'::jsonb;
    v_snapshot    jsonb;
    v_delivery_id uuid;
    v_date        date;
    v_supplier    text;
    v_truck       text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_old         := to_jsonb(OLD);
        v_snapshot    := v_old;
        v_delivery_id := OLD.id;
        v_date        := OLD.delivery_date;
        v_supplier    := OLD.supplier_code;
        v_truck       := OLD.truck_no;
    ELSE
        v_new         := to_jsonb(NEW);
        v_snapshot    := v_new;
        v_delivery_id := NEW.id;
        v_date        := NEW.delivery_date;
        v_supplier    := NEW.supplier_code;
        v_truck       := NEW.truck_no;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);

        -- `row_version` is excluded alongside `updated_at` because
        -- cenapro.fn_touch_rc_delivery bumps BOTH on every single update; a diff that
        -- reported them would never be empty and the skip below could never fire.
        SELECT coalesce(
                   jsonb_object_agg(k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k)),
                   '{}'::jsonb)
          INTO v_changed
          FROM jsonb_object_keys(v_new) AS k
         WHERE k <> 'updated_at'
           AND k <> 'row_version'
           AND (v_old -> k) IS DISTINCT FROM (v_new -> k);

        -- Nothing but the touch bookkeeping moved. An audit row here would be a lie.
        IF v_changed = '{}'::jsonb THEN
            RETURN NULL;
        END IF;
    END IF;

    INSERT INTO cenapro.rc_delivery_audit
        (delivery_id, entity, sample_id, sample_position,
         delivery_date, supplier_code, truck_no,
         operation, changed, snapshot,
         source, changed_by, changed_by_role)
    VALUES
        (v_delivery_id, 'delivery', NULL, NULL,
         v_date, v_supplier, v_truck,
         TG_OP, v_changed, v_snapshot,
         nullif(current_setting('cenapro.audit_source', true), ''),
         auth.uid(),
         auth.role());

    RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;

comment on function cenapro.fn_audit_rc_delivery() is
    'AFTER INSERT/UPDATE/DELETE trail for cenapro.rc_delivery. Skips an UPDATE whose only difference is updated_at / row_version. AFTER, not BEFORE, because STORED GENERATED money columns are not computed until after BEFORE triggers run. SECURITY DEFINER so the audit table needs no write grant to any client role.';

revoke all on function cenapro.fn_audit_rc_delivery() from public;

drop trigger if exists tr_cenapro_rc_delivery_audit on cenapro.rc_delivery;
create trigger tr_cenapro_rc_delivery_audit
    after insert or update or delete on cenapro.rc_delivery
    for each row execute function cenapro.fn_audit_rc_delivery();

-- ─── 3. The trigger function — the moisture sub-samples ──────────────────────────
-- Same shape, one extra problem: the child row does not carry the receipt's identity,
-- and on a CASCADE delete the parent is ALREADY GONE by the time any AFTER trigger
-- fires (verified live: the parent row is invisible to every AFTER trigger of its own
-- DELETE). Verified live too, and independent of trigger NAME: the parent's own AFTER
-- DELETE trigger fires BEFORE the RI cascade reaches the children. So when the live
-- lookup misses, the identity is read back off the parent's own DELETE audit row,
-- which is guaranteed to be sitting there already.
create or replace function cenapro.fn_audit_rc_delivery_sample()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
DECLARE
    v_old         jsonb;
    v_new         jsonb;
    v_changed     jsonb := '{}'::jsonb;
    v_snapshot    jsonb;
    v_delivery_id uuid;
    v_sample_id   uuid;
    v_position    integer;
    v_date        date;
    v_supplier    text;
    v_truck       text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_old         := to_jsonb(OLD);
        v_snapshot    := v_old;
        v_delivery_id := OLD.delivery_id;
        v_sample_id   := OLD.id;
        v_position    := OLD.position;
    ELSE
        v_new         := to_jsonb(NEW);
        v_snapshot    := v_new;
        v_delivery_id := NEW.delivery_id;
        v_sample_id   := NEW.id;
        v_position    := NEW.position;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);

        -- rc_delivery_sample has no touch trigger and no row_version, so nothing needs
        -- excluding here; the empty-diff skip below is the same rule all the same.
        SELECT coalesce(
                   jsonb_object_agg(k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k)),
                   '{}'::jsonb)
          INTO v_changed
          FROM jsonb_object_keys(v_new) AS k
         WHERE (v_old -> k) IS DISTINCT FROM (v_new -> k);

        IF v_changed = '{}'::jsonb THEN
            RETURN NULL;
        END IF;
    END IF;

    -- The receipt this sample belongs to, for the denormalized identity.
    SELECT d.delivery_date, d.supplier_code, d.truck_no
      INTO v_date, v_supplier, v_truck
      FROM cenapro.rc_delivery d
     WHERE d.id = v_delivery_id;

    IF NOT FOUND THEN
        -- CASCADE delete: the receipt is gone, but its own DELETE audit row was
        -- written first and already carries the identity. Read it back from there
        -- rather than leaving the trail unreadable.
        SELECT a.delivery_date, a.supplier_code, a.truck_no
          INTO v_date, v_supplier, v_truck
          FROM cenapro.rc_delivery_audit a
         WHERE a.delivery_id = v_delivery_id
           AND a.entity      = 'delivery'
         ORDER BY a.id DESC
         LIMIT 1;
    END IF;

    INSERT INTO cenapro.rc_delivery_audit
        (delivery_id, entity, sample_id, sample_position,
         delivery_date, supplier_code, truck_no,
         operation, changed, snapshot,
         source, changed_by, changed_by_role)
    VALUES
        (v_delivery_id, 'sample', v_sample_id, v_position,
         v_date, v_supplier, v_truck,
         TG_OP, v_changed, v_snapshot,
         nullif(current_setting('cenapro.audit_source', true), ''),
         auth.uid(),
         auth.role());

    RETURN NULL;
END;
$$;

comment on function cenapro.fn_audit_rc_delivery_sample() is
    'AFTER INSERT/UPDATE/DELETE trail for cenapro.rc_delivery_sample, written into the SAME table as the receipt trail and keyed by the PARENT delivery_id. Resolves the receipt identity from cenapro.rc_delivery, falling back to the parent''s own DELETE audit row on a CASCADE delete (the parent trigger fires first). SECURITY DEFINER, same reason as the receipt trigger.';

revoke all on function cenapro.fn_audit_rc_delivery_sample() from public;

drop trigger if exists tr_cenapro_rc_delivery_sample_audit on cenapro.rc_delivery_sample;
create trigger tr_cenapro_rc_delivery_sample_audit
    after insert or update or delete on cenapro.rc_delivery_sample
    for each row execute function cenapro.fn_audit_rc_delivery_sample();

-- ─── 4. Grants — the cenapro DEFAULT ACL trap ────────────────────────────────────
-- `pg_default_acl` for schema cenapro is {anon=r, authenticated=arwd,
-- service_role=arwd} (re-confirmed live 2026-08-05), so a table created here is BORN
-- readable by anon and WRITABLE by authenticated whatever the CREATE said. For an
-- append-only ledger that default is precisely the failure: it would ship a trail any
-- client could forge or erase. Revoke all three, then hand back read-only.
revoke all on cenapro.rc_delivery_audit from anon;
revoke all on cenapro.rc_delivery_audit from authenticated;
revoke all on cenapro.rc_delivery_audit from service_role;
grant select on cenapro.rc_delivery_audit to authenticated, service_role;

-- Second line of defence, and the one divergence from production_event_audit (which
-- has no RLS): RLS ON with a SELECT-only policy and NO insert/update/delete policy at
-- all. The grants above are already sufficient — but this table's whole value is that
-- it cannot be tampered with, and RLS means a future blanket `GRANT ... ON ALL TABLES
-- IN SCHEMA cenapro` (the kind of thing that created the DEFAULT ACL trap in the first
-- place) still cannot write a row. The SECURITY DEFINER triggers run as the table
-- owner, which bypasses RLS, so the trail keeps being written.
alter table cenapro.rc_delivery_audit enable row level security;

drop policy if exists cenapro_rc_delivery_audit_select on cenapro.rc_delivery_audit;
create policy cenapro_rc_delivery_audit_select
    on cenapro.rc_delivery_audit
    for select to authenticated
    using (true);

-- The identity sequence is born with the same default ACL. Nothing but the definer
-- triggers insert, so no client role needs it. Scoped by name, never a blanket "all
-- sequences in schema cenapro" — that would sweep up objects this migration knows
-- nothing about.
do $$
DECLARE
    v_seq text := pg_catalog.pg_get_serial_sequence('cenapro.rc_delivery_audit', 'id');
BEGIN
    IF v_seq IS NOT NULL THEN
        EXECUTE format('revoke all on sequence %s from anon, authenticated', v_seq);
    END IF;
END;
$$;

-- ─── 5. A read-only public accessor (the module's exposure pattern) ──────────────
-- `cenapro` is not exposed to PostgREST, so a trail nobody can read from the app is
-- only half a trail. SECURITY INVOKER + SELECT-only, same as every other accessor.
create or replace view public.cenapro_rc_delivery_audit
with (security_invoker = true) as
select a.id,
       a.delivery_id,
       a.entity,
       a.sample_id,
       a.sample_position,
       a.delivery_date,
       a.supplier_code,
       a.truck_no,
       a.operation,
       a.changed,
       a.snapshot,
       a.source,
       a.changed_at,
       a.changed_by,
       a.changed_by_role
  from cenapro.rc_delivery_audit a;

comment on view public.cenapro_rc_delivery_audit is
    'Read-only window onto cenapro.rc_delivery_audit — the per-receipt change history for Cenapro RC deliveries and their moisture sub-samples. SELECT only; the trail is written exclusively by cenapro.fn_audit_rc_delivery() / cenapro.fn_audit_rc_delivery_sample(). Filter by delivery_id for one receipt''s whole story. NOTE: `changed` and `snapshot` carry the ₱ columns, so any server action exposing this view is subject to the canViewPrices() gate.';

revoke all on public.cenapro_rc_delivery_audit from anon;
revoke all on public.cenapro_rc_delivery_audit from authenticated;
revoke all on public.cenapro_rc_delivery_audit from service_role;
grant select on public.cenapro_rc_delivery_audit to authenticated, service_role;
