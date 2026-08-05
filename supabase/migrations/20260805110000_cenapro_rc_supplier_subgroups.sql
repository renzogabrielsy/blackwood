-- ─────────────────────────────────────────────────────────────────────────────────
-- Cenapro (Tenant #2) — SUPPLIER SUBGROUPS. Liquidation Step 2.
--
-- WHY THIS EXISTS — Renzo, 2026-08-05:
--   "Paquibot would have a subgroup of suppliers like Llanto. The system should be
--    able to understand that if a cheque is labeled Paquibot but is being assigned
--    to a Llanto delivery, then it should push through because it verified that
--    Llanto is a sub-supplier of Paquibot. And yes, this would mean we would need a
--    way to setup subgroups."
--
-- THE GROUP IS A PAYMENT FACT, NOT A DELIVERY FACT. It says WHO MAY BE PAID FOR
-- WHOM. It therefore lives on the cheque-payee dimension (cenapro.rc_supplier) and
-- nowhere near cenapro.rc_delivery: this migration adds no column to the fact table,
-- changes none of its views, and touches none of its RPCs. Strictly additive.
--
-- ─── FIVE DECISIONS, EACH WITH ITS REASON ────────────────────────────────────────
--
-- 1. ONE LEVEL, ENFORCED — not merely documented.
--    A supplier that HAS children may not itself have a parent, and a supplier that
--    HAS a parent may not acquire children. That is a CROSS-ROW invariant, so a CHECK
--    (which sees only its own row) cannot express it. It is enforced by the
--    DEFERRABLE INITIALLY IMMEDIATE CONSTRAINT TRIGGER below, which fires on the row
--    being pointed at a parent and refuses BOTH directions with one rule — because
--    "give Y a parent while Y has children" is the same statement, evaluated on Y.
--    DEFERRABLE so a legal reorganisation ("X stops being Y's child in the same
--    transaction that makes Y a child of Z") can be done with SET CONSTRAINTS
--    DEFERRED; INITIALLY IMMEDIATE so an ordinary edit still fails at the statement,
--    where the RPC can catch it and hand back a readable message.
--
-- 2. NOTHING IS SEEDED, NOTHING IS INFERRED.
--    All 12 suppliers keep `parent_code IS NULL`. This migration contains no UPDATE
--    of rc_supplier at all. A grouping guessed from name similarity ("PALAWAN" looks
--    like "PALAWAN BROOKE'S") would be a machine's opinion about who may be paid for
--    whom — and it would be silently wrong the first time two unrelated traders share
--    a syllable. Renzo sets these up by hand, and that act is audited.
--
-- 3. GROUP MEMBERSHIP IS RESOLVED IN SQL, ONCE.
--    `cenapro.view_rc_supplier_group` is the ONE definition of `group_code`
--    (= coalesce(parent_code, code)). The Step-3 balance rollup and the Step-4
--    allocation legality check read it and never re-derive it. Same rule CLAUDE.md
--    states for balances: trust the DB, never recompute in TypeScript.
--
-- 4. THE GROUPING IS AUDITED, IN ITS OWN TABLE.
--    Re-pointing a parent RETROACTIVELY changes which past payments were legitimate:
--    a cheque to PAQUIBOT that legally settled a LLANTO receipt yesterday becomes an
--    illegal allocation the moment LLANTO leaves the group — with no record that the
--    rule changed rather than the cheque. `cenapro.rc_supplier_audit` is the
--    line-for-line clone of `cenapro.rc_delivery_audit`'s idiom (2026-08-05).
--    SEPARATE TABLE, not an `entity`-discriminated extension of rc_delivery_audit:
--    that table's read key is `delivery_id uuid NOT NULL` and the whole point of its
--    shape is that a receipt's history is one indexed lookup on it. A supplier has no
--    delivery_id; folding it in would mean making the key nullable, adding a second
--    text key beside it, and giving every per-receipt query a discriminator it did
--    not need — paying in the hot read path to save one small relation. The read
--    surfaces are different too (a per-receipt history panel vs a "when did this
--    grouping change" log). One idiom, two tables.
--
-- 5. `row_version` IS ADDED, rather than compare-and-set on a supplied value.
--    `cenapro_update_event_weight` can CAS on the value itself because it guards
--    exactly ONE field and that field is the whole payload. This RPC is patch-shaped
--    over five columns, so a value CAS would guard one and let the rest clobber. And
--    `parent_code` has an ABA hazard a value token cannot see (A → B → A): with money
--    legality hanging off the grouping, "it is back to what I expected" is not the
--    same fact as "nobody changed it". The token is bumped by a TRIGGER, not by the
--    RPC, for the reason stated on `fn_touch_rc_delivery`: `rc_supplier` has a second
--    live writer — the auto-updatable `public.cenapro_rc_suppliers` accessor, granted
--    UPDATE to `authenticated`, plus the REST importer — and RPC-side bookkeeping
--    would let a raw write silently defeat the lock. The touch trigger also fixes a
--    latent bug: `updated_at` has never moved on an UPDATE (the DEFAULT only applies
--    at INSERT), and all 12 rows still read updated_at = created_at.
--
-- WHAT IS DELIBERATELY NOT HERE
--   * No DELETE rpc. A retired trader is `active = false`, never a DELETE — historic
--     payments must keep naming it, and a DELETE would SET NULL the supplier_code of
--     every receipt it ever sold (see the liquidation brief §4.1).
--   * `code` is NOT in the RPC's patch allowlist. Re-keying a supplier cascades
--     through rc_delivery AND splits this audit trail (which keys on the code); it is
--     a data-migration act, not a cell edit.
--   * `public.cenapro_rc_suppliers` is left BYTE-IDENTICAL. It is the WRITABLE
--     dimension accessor: putting `parent_code` on it would open a second write path
--     into the field that decides which cheques were legal, one that skips every
--     readable refusal below. It also means a re-run of
--     scripts/cenapro/import-rc-deliveries.mjs — which upserts through that view —
--     can never reach, and therefore never wipe, a hand-set parent.
--   * No Step 3+. No banks, no rc_payment, no allocations, no balance view.
-- ─────────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════════
-- 1. THE PARENT LINK
-- ═════════════════════════════════════════════════════════════════════════════════

ALTER TABLE cenapro.rc_supplier
  ADD COLUMN IF NOT EXISTS parent_code text,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

-- Self-referencing FK. ON UPDATE CASCADE ON DELETE SET NULL is exactly
-- rc_delivery.supplier_code's idiom, and for the same reason: re-pointing or renaming
-- a trader must never orphan a row, and retiring one must never take its children
-- with it (they simply become roots again).
ALTER TABLE cenapro.rc_supplier DROP CONSTRAINT IF EXISTS cenapro_rc_supplier_parent_fk;
ALTER TABLE cenapro.rc_supplier
  ADD CONSTRAINT cenapro_rc_supplier_parent_fk
      FOREIGN KEY (parent_code) REFERENCES cenapro.rc_supplier(code)
      ON UPDATE CASCADE ON DELETE SET NULL;

-- The one part of the hierarchy rule a CHECK *can* see: its own row.
ALTER TABLE cenapro.rc_supplier DROP CONSTRAINT IF EXISTS cenapro_rc_supplier_parent_not_self;
ALTER TABLE cenapro.rc_supplier
  ADD CONSTRAINT cenapro_rc_supplier_parent_not_self
      CHECK (parent_code IS DISTINCT FROM code);

-- Postgres does NOT index a foreign key automatically. This one carries the ON
-- UPDATE CASCADE / ON DELETE SET NULL referential scans AND the child rollup in
-- view_rc_supplier_group. A plain (not partial) index on purpose — the RI machinery's
-- own plans should never have to prove a partial index's predicate.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_supplier_parent
  ON cenapro.rc_supplier (parent_code);

COMMENT ON COLUMN cenapro.rc_supplier.parent_code IS
  'THE CHEQUE-PAYEE GROUPING. When set, this trader is a SUB-SUPPLIER of parent_code: a payment '
  'made out to the parent may legitimately settle THIS trader''s deliveries. It is a PAYMENT fact, '
  'not a delivery fact — it says who may be paid for whom, and changes nothing about the receipts '
  'themselves. EXPLICITLY MAINTAINED, never inferred from name similarity. ONE LEVEL DEEP: a '
  'supplier with children may not have a parent and vice versa, enforced by the constraint trigger '
  'tr_cenapro_rc_supplier_one_level. Re-pointing it retroactively changes which past payments were '
  'legitimate, which is why every change is trailed in cenapro.rc_supplier_audit.';

COMMENT ON COLUMN cenapro.rc_supplier.row_version IS
  'Optimistic-concurrency token, bumped by cenapro.fn_touch_rc_supplier on EVERY update (including '
  'raw DML through public.cenapro_rc_suppliers), so a write through the accessor view cannot '
  'silently defeat public.cenapro_save_rc_supplier''s compare-and-set.';


-- ═════════════════════════════════════════════════════════════════════════════════
-- 2. TOUCH TRIGGER — row_version / updated_at
-- ═════════════════════════════════════════════════════════════════════════════════
-- Shape cloned from cenapro.fn_touch_rc_delivery, minus created_by/updated_by:
-- rc_supplier has no actor columns and does not need them — WHO changed a grouping is
-- answered by rc_supplier_audit.changed_by, which is the record that has to survive
-- the account being deleted.
CREATE OR REPLACE FUNCTION cenapro.fn_touch_rc_supplier()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  NEW.updated_at  := now();
  NEW.row_version := OLD.row_version + 1;
  NEW.created_at  := OLD.created_at;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION cenapro.fn_touch_rc_supplier() IS
  'BEFORE INSERT/UPDATE on cenapro.rc_supplier: on UPDATE bumps row_version + updated_at and '
  'freezes created_at. In a trigger so EVERY write path — the save RPC or raw DML through '
  'public.cenapro_rc_suppliers — advances the concurrency token.';

REVOKE EXECUTE ON FUNCTION cenapro.fn_touch_rc_supplier() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cenapro.fn_touch_rc_supplier() TO authenticated, service_role;

DROP TRIGGER IF EXISTS tr_cenapro_rc_supplier_touch ON cenapro.rc_supplier;
CREATE TRIGGER tr_cenapro_rc_supplier_touch
  BEFORE INSERT OR UPDATE ON cenapro.rc_supplier
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_touch_rc_supplier();


-- ═════════════════════════════════════════════════════════════════════════════════
-- 3. THE ONE-LEVEL RULE — a CONSTRAINT TRIGGER, because a CHECK cannot see two rows
-- ═════════════════════════════════════════════════════════════════════════════════
-- ONE rule covers BOTH directions, and that is worth stating because it looks like it
-- should need two:
--   (a) "the parent I am pointing at must not itself have a parent"  → refuses a
--       GRANDCHILD;
--   (b) "I must not already have children"                           → refuses giving
--       a parent to a supplier that is already one.
-- A supplier Y that already has children can only acquire a parent through an UPDATE
-- OF Y, and that UPDATE fires this same trigger on Y, where (b) refuses it. So there
-- is no separate "parent side" check to write.
--
-- CONCURRENCY. Two transactions racing (T1: X.parent := Y; T2: Y.parent := Z) could
-- each pass against a snapshot taken before the other committed, producing a chain.
-- Two things close that:
--   * a transaction-level ADVISORY LOCK on a fixed key, so all parent-setting writes
--     serialise — this is what makes the "do I have children?" scan sound, since a
--     row that only just became my child is not in my snapshot at all;
--   * FOR SHARE on the parent row, which in READ COMMITTED re-reads the LATEST
--     committed version rather than the snapshot version.
-- The table has 12 rows and is hand-edited, so the lock costs nothing.
CREATE OR REPLACE FUNCTION cenapro.fn_rc_supplier_one_level()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_grandparent text;
  v_children    text[];
BEGIN
  -- Clearing a parent can only ever REDUCE depth, so nothing to check. (The WHEN
  -- clause on the trigger already filters these out; this is the belt.)
  IF NEW.parent_code IS NULL THEN
    RETURN NULL;
  END IF;

  -- Serialise every parent-setting write in the database. Key = this migration's own
  -- version number, so it is greppable and cannot collide by accident.
  PERFORM pg_advisory_xact_lock(20260805110000);

  -- (a) No grandparents. FOR SHARE so this sees the parent's CURRENT committed
  --     parent_code, not a possibly-stale snapshot of it.
  SELECT p.parent_code INTO v_grandparent
    FROM cenapro.rc_supplier p
   WHERE p.code = NEW.parent_code
     FOR SHARE;

  IF v_grandparent IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('"%s" is already a sub-supplier of "%s", so it cannot also be a parent. '
                    || 'Supplier subgroups are one level deep — point "%s" at "%s" instead.',
                       NEW.parent_code, v_grandparent, NEW.code, v_grandparent),
      CONSTRAINT = 'cenapro_rc_supplier_one_level';
  END IF;

  -- (b) A supplier that already has sub-suppliers cannot itself become one.
  SELECT array_agg(k.code ORDER BY k.code) INTO v_children
    FROM cenapro.rc_supplier k
   WHERE k.parent_code = NEW.code;

  IF v_children IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('"%s" already has sub-supplier(s) (%s), so it cannot itself become one. '
                    || 'Supplier subgroups are one level deep — move those sub-suppliers to "%s" '
                    || 'first.',
                       NEW.code, array_to_string(v_children, ', '), NEW.parent_code),
      CONSTRAINT = 'cenapro_rc_supplier_one_level';
  END IF;

  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION cenapro.fn_rc_supplier_one_level() IS
  'Enforces the ONE-LEVEL supplier subgroup rule across rows, which a CHECK constraint cannot do. '
  'Refuses a grandchild (the parent already has a parent) AND refuses giving a parent to a supplier '
  'that already has children — both from the single statement that sets parent_code. Serialises on '
  'a transaction advisory lock so a concurrent pair of writes cannot build a chain between snapshots.';

REVOKE EXECUTE ON FUNCTION cenapro.fn_rc_supplier_one_level() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cenapro.fn_rc_supplier_one_level() TO authenticated, service_role;

DROP TRIGGER IF EXISTS tr_cenapro_rc_supplier_one_level ON cenapro.rc_supplier;
CREATE CONSTRAINT TRIGGER tr_cenapro_rc_supplier_one_level
  AFTER INSERT OR UPDATE ON cenapro.rc_supplier
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW
  WHEN (NEW.parent_code IS NOT NULL)
  EXECUTE FUNCTION cenapro.fn_rc_supplier_one_level();


-- ═════════════════════════════════════════════════════════════════════════════════
-- 4. THE AUDIT TRAIL — cenapro.rc_supplier_audit
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cenapro.rc_supplier_audit (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The natural key, denormalized and WITHOUT an FK: the trail must outlive the
  -- supplier row, exactly as rc_delivery_audit.delivery_id outlives its receipt.
  supplier_code   text        NOT NULL,
  -- Denormalized identity so the trail reads after the row is gone.
  display_name    text,
  -- The grouping AT THE TIME OF THE CHANGE, promoted out of `snapshot` into a plain
  -- column because it is the one question this table exists to answer: "was LLANTO
  -- under PAQUIBOT when that cheque was written?" A jsonb dig would work; an indexed
  -- column is what a Step-4 legality review will actually run.
  parent_code     text,

  operation       text        NOT NULL
                  CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),

  -- UPDATE only: {"parent_code": {"old": null, "new": "PAQUIBOT"}} — ONLY the columns
  -- that actually moved. `updated_at` AND `row_version` are excluded because
  -- fn_touch_rc_supplier bumps both on EVERY write: miss one and the diff is never
  -- empty, so the no-op skip below can never fire and the trail fills with phantoms.
  -- '{}' on INSERT/DELETE, where the whole row IS the change and `snapshot` has it.
  changed         jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- The full row: NEW on INSERT/UPDATE, OLD on DELETE.
  snapshot        jsonb       NOT NULL,

  -- Which surface wrote it, from the transaction-local GUC `cenapro.audit_source`.
  -- NULL = a write that did not name itself.
  source          text,

  changed_at      timestamptz NOT NULL DEFAULT now(),

  -- auth.uid() — NULL for a service-role / psql / importer write, the honest answer.
  -- Deliberately NO foreign key to public.profiles: an audit row must outlive the
  -- account that wrote it, and ON DELETE SET NULL would erase the actor from history
  -- exactly when it matters.
  changed_by      uuid,
  changed_by_role text
);

COMMENT ON TABLE cenapro.rc_supplier_audit IS
  'Append-only trail of every INSERT/UPDATE/DELETE on cenapro.rc_supplier — the cheque-payee '
  'dimension and, since 2026-08-05, the supplier SUBGROUP. It exists because re-pointing '
  'parent_code retroactively changes which past payments were legitimate. Written ONLY by the '
  'SECURITY DEFINER trigger cenapro.fn_audit_rc_supplier(); no role holds INSERT/UPDATE/DELETE on '
  'it. The trail starts 2026-08-05 — nothing before that date was ever recorded, and nothing was '
  'backfilled.';

COMMENT ON COLUMN cenapro.rc_supplier_audit.supplier_code IS
  'The supplier''s code at the time of the change. No FK on purpose — the trail outlives the row. '
  'NOTE a code rename cascades to rc_delivery but NOT here, so it splits this trail; that is one '
  'reason `code` is not in cenapro_save_rc_supplier''s patch allowlist.';
COMMENT ON COLUMN cenapro.rc_supplier_audit.parent_code IS
  'The parent AT THE TIME OF THE CHANGE — who could legitimately be paid for this trader then. '
  'Also present inside `snapshot`; promoted to a column because it is the indexed question.';
COMMENT ON COLUMN cenapro.rc_supplier_audit.changed IS
  'UPDATE only: {column: {old, new}} for the columns that actually moved. Excludes updated_at and '
  'row_version (bumped by the touch trigger on every write).';
COMMENT ON COLUMN cenapro.rc_supplier_audit.changed_by IS
  'auth.uid(), or NULL for a service-role / importer / psql write. NO FK to profiles on purpose.';

-- The per-supplier history query, and the "what changed lately" feed.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_supplier_audit_supplier
  ON cenapro.rc_supplier_audit (supplier_code, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_supplier_audit_recent
  ON cenapro.rc_supplier_audit (changed_at DESC);

-- SECURITY DEFINER on purpose: combined with the REVOKEs below it means the trigger
-- is the ONLY thing that can write this table. A SECURITY INVOKER trigger would need
-- INSERT granted to `authenticated`, and a grant that lets the trigger write also
-- lets a client forge a row by hand — or erase one.
--
-- AFTER, not BEFORE: rc_supplier has no generated columns, but fn_touch_rc_supplier is
-- a BEFORE trigger that rewrites row_version / updated_at, and only an AFTER trigger
-- sees the values that were actually stored.
CREATE OR REPLACE FUNCTION cenapro.fn_audit_rc_supplier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_old      jsonb;
  v_new      jsonb;
  v_changed  jsonb := '{}'::jsonb;
  v_snapshot jsonb;
  v_code     text;
  v_name     text;
  v_parent   text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old      := to_jsonb(OLD);
    v_snapshot := v_old;
    v_code     := OLD.code;
    v_name     := OLD.display_name;
    v_parent   := OLD.parent_code;
  ELSE
    v_new      := to_jsonb(NEW);
    v_snapshot := v_new;
    v_code     := NEW.code;
    v_name     := NEW.display_name;
    v_parent   := NEW.parent_code;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);

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

  INSERT INTO cenapro.rc_supplier_audit
    (supplier_code, display_name, parent_code,
     operation, changed, snapshot,
     source, changed_by, changed_by_role)
  VALUES
    (v_code, v_name, v_parent,
     TG_OP, v_changed, v_snapshot,
     nullif(current_setting('cenapro.audit_source', true), ''),
     auth.uid(),
     auth.role());

  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$fn$;

COMMENT ON FUNCTION cenapro.fn_audit_rc_supplier() IS
  'AFTER INSERT/UPDATE/DELETE trail for cenapro.rc_supplier. Skips an UPDATE whose only difference '
  'is updated_at / row_version. SECURITY DEFINER so the audit table needs no write grant to any '
  'client role. Catches EVERY writer — the save RPC, raw DML through '
  'public.cenapro_rc_suppliers, and the REST importer.';

REVOKE ALL ON FUNCTION cenapro.fn_audit_rc_supplier() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_cenapro_rc_supplier_audit ON cenapro.rc_supplier;
CREATE TRIGGER tr_cenapro_rc_supplier_audit
  AFTER INSERT OR UPDATE OR DELETE ON cenapro.rc_supplier
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_audit_rc_supplier();

-- ── Grants — the cenapro DEFAULT ACL trap ────────────────────────────────────────
-- `pg_default_acl` for schema cenapro is {anon=r, authenticated=arwd,
-- service_role=arwd}, so a table created here is BORN readable by anon and WRITABLE
-- by authenticated whatever the CREATE said. For an append-only ledger that default
-- is precisely the failure. Revoke all three, then hand back read-only.
REVOKE ALL ON cenapro.rc_supplier_audit FROM anon;
REVOKE ALL ON cenapro.rc_supplier_audit FROM authenticated;
REVOKE ALL ON cenapro.rc_supplier_audit FROM service_role;
GRANT SELECT ON cenapro.rc_supplier_audit TO authenticated, service_role;

-- Second line of defence: RLS ON with a SELECT-only policy and NO
-- insert/update/delete policy at all, so a future blanket
-- `GRANT ... ON ALL TABLES IN SCHEMA cenapro` still cannot write a row. The SECURITY
-- DEFINER trigger runs as the table owner, which bypasses RLS, so the trail keeps
-- being written.
ALTER TABLE cenapro.rc_supplier_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cenapro_rc_supplier_audit_select ON cenapro.rc_supplier_audit;
CREATE POLICY cenapro_rc_supplier_audit_select
  ON cenapro.rc_supplier_audit
  FOR SELECT TO authenticated
  USING (true);

-- The identity sequence is born with the same default ACL. Nothing but the definer
-- trigger inserts, so no client role needs it. Scoped by name, never a blanket "all
-- sequences in schema cenapro".
DO $do$
DECLARE
  v_seq text := pg_catalog.pg_get_serial_sequence('cenapro.rc_supplier_audit', 'id');
BEGIN
  IF v_seq IS NOT NULL THEN
    EXECUTE format('revoke all on sequence %s from anon, authenticated', v_seq);
  END IF;
END;
$do$;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 5. GROUP RESOLUTION — the ONE definition of `group_code`
-- ═════════════════════════════════════════════════════════════════════════════════
-- Everything downstream reads group_code from HERE and nowhere else: the Step-3
-- balance rollup, and the Step-4 allocation legality check ("payee == the delivery's
-- supplier OR they share a group_code"). CLAUDE.md forbids computing balances in
-- TypeScript; the same applies to group membership, which is the input to one.
CREATE OR REPLACE VIEW cenapro.view_rc_supplier_group
WITH (security_invoker = true)
AS
SELECT
  s.code,
  s.display_name,
  s.sort_order,
  s.active,
  s.notes,

  s.parent_code,
  p.display_name                                   AS parent_display_name,

  -- THE definition. A root trader is its own group.
  coalesce(s.parent_code, s.code)                  AS group_code,
  coalesce(p.display_name, s.display_name)         AS group_display_name,
  -- So a balance screen can sort children under their parent without re-deriving it.
  coalesce(p.sort_order, s.sort_order)             AS group_sort_order,

  (k.child_count > 0)                              AS is_parent,
  (s.parent_code IS NOT NULL)                      AS is_child,
  k.child_count,
  k.child_codes,

  s.row_version,
  s.created_at,
  s.updated_at
FROM cenapro.rc_supplier s
LEFT JOIN cenapro.rc_supplier p ON p.code = s.parent_code
LEFT JOIN LATERAL (
  SELECT count(*)::integer                          AS child_count,
         array_agg(c.code ORDER BY c.sort_order, c.code) AS child_codes
    FROM cenapro.rc_supplier c
   WHERE c.parent_code = s.code
) k ON true;

COMMENT ON VIEW cenapro.view_rc_supplier_group IS
  'The ONE definition of Cenapro supplier-subgroup membership. One row per supplier: its parent, '
  'its group (group_code = coalesce(parent_code, code) — a root trader is its own group), whether '
  'it is a parent or a child, and its children. Because the hierarchy is enforced ONE LEVEL deep, '
  'is_parent and is_child are mutually exclusive and group_code needs no recursion. Every '
  'downstream consumer — the Step-3 supplier balance rollup, the Step-4 allocation legality check '
  '— reads group_code from here and never re-derives it.';

REVOKE ALL ON cenapro.view_rc_supplier_group FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_supplier_group TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 6. PUBLIC ACCESSORS — `cenapro` is not exposed to PostgREST
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.cenapro_rc_supplier_groups
WITH (security_invoker = true) AS
SELECT g.code,
       g.display_name,
       g.sort_order,
       g.active,
       g.notes,
       g.parent_code,
       g.parent_display_name,
       g.group_code,
       g.group_display_name,
       g.group_sort_order,
       g.is_parent,
       g.is_child,
       g.child_count,
       g.child_codes,
       g.row_version,
       g.created_at,
       g.updated_at
  FROM cenapro.view_rc_supplier_group g;

COMMENT ON VIEW public.cenapro_rc_supplier_groups IS
  'Public READ-ONLY accessor for cenapro.view_rc_supplier_group — every Cenapro supplier with its '
  'subgroup resolution (parent_code, group_code, is_parent/is_child, child_codes) and its '
  'row_version for the save RPC''s compare-and-set. Write through '
  'public.cenapro_save_rc_supplier(); this view is not writable.';

REVOKE ALL ON public.cenapro_rc_supplier_groups FROM anon, authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_supplier_groups TO authenticated, service_role;

CREATE OR REPLACE VIEW public.cenapro_rc_supplier_audit
WITH (security_invoker = true) AS
SELECT a.id,
       a.supplier_code,
       a.display_name,
       a.parent_code,
       a.operation,
       a.changed,
       a.snapshot,
       a.source,
       a.changed_at,
       a.changed_by,
       a.changed_by_role
  FROM cenapro.rc_supplier_audit a;

COMMENT ON VIEW public.cenapro_rc_supplier_audit IS
  'Read-only window onto cenapro.rc_supplier_audit — the change history of the Cenapro cheque-payee '
  'dimension and its subgroups. SELECT only; the trail is written exclusively by '
  'cenapro.fn_audit_rc_supplier(). Filter by supplier_code for one trader''s whole story. Carries '
  'NO ₱ columns (rc_supplier has none), unlike public.cenapro_rc_delivery_audit.';

REVOKE ALL ON public.cenapro_rc_supplier_audit FROM anon, authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_supplier_audit TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 7. THE WRITE PATH — public.cenapro_save_rc_supplier
-- ═════════════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER, `SET search_path = ''` with everything schema-qualified, EXECUTE
-- revoked from PUBLIC and anon then granted to authenticated + service_role. The
-- local cenapro idiom, and the same outcome vocabulary as the other three RPCs:
--   inserted | updated | version_conflict | not_found | unsupported_field | invalid
--
-- CONCURRENCY. p_expected_row_version IS NULL → INSERT a supplier with code p_code.
--              p_expected_row_version = n     → UPDATE ... AND row_version = n, the
--              check in the SAME statement as the write. A blind update is refused.
--
-- WHY THE HIERARCHY RULE IS CHECKED IN plpgsql AND NOT FOLDED INTO THE UPDATE'S WHERE:
-- it could be — but then a one-level violation would come back indistinguishable from
-- a version conflict, and "Someone else changed this while you were editing" is the
-- wrong thing to tell someone who just tried to build a three-level chain. So: a
-- pre-check here produces the READABLE refusal, and the constraint trigger is the
-- guarantee that holds for every other write path. Belt and braces, the same split
-- the module already uses for the ₱ gate (strip server-side AND refuse in the RPC).
-- The race between the pre-check and the write is caught by the trigger and comes
-- back through the check_violation handler with the trigger's own message.
CREATE OR REPLACE FUNCTION public.cenapro_save_rc_supplier(
  p_code                 text,
  p_expected_row_version integer DEFAULT NULL,
  p_patch                jsonb   DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  -- `code` is deliberately absent: re-keying a supplier cascades through
  -- cenapro.rc_delivery and splits cenapro.rc_supplier_audit (which keys on the
  -- code). That is a data-migration act, not a cell edit.
  c_allowed constant text[] := ARRAY['display_name', 'parent_code', 'sort_order', 'active', 'notes'];
  v_bad      text[];
  v_cur      cenapro.rc_supplier;
  v_new      cenapro.rc_supplier;
  v_parent   text;
  v_gparent  text;
  v_children text[];
  v_code     text;
  v_version  integer;
  v_current  integer;
BEGIN
  IF p_code IS NULL OR pg_catalog.btrim(p_code) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'A supplier code is required.');
  END IF;

  IF p_patch IS NULL OR pg_catalog.jsonb_typeof(p_patch) <> 'object' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'p_patch must be a JSON object of column -> value.');
  END IF;

  SELECT pg_catalog.array_agg(k)
    INTO v_bad
    FROM pg_catalog.jsonb_object_keys(p_patch) AS k
   WHERE k <> ALL (c_allowed);

  IF v_bad IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'unsupported_field', 'fields', pg_catalog.to_jsonb(v_bad),
      'message', 'Refused: ' || pg_catalog.array_to_string(v_bad, ', ')
                 || ' is not an editable supplier field. Editable: '
                 || pg_catalog.array_to_string(c_allowed, ', ')
                 || '. The supplier code itself cannot be changed here — renaming a code moves '
                 || 'every receipt that names it and splits its audit trail.');
  END IF;

  -- display_name is NOT NULL. An explicit null/blank in the patch is a refusal, not a
  -- value we quietly substitute for — the module's discipline is refuse, never
  -- silently do something else. (An OMITTED display_name is fine: on INSERT it
  -- defaults to the code, on UPDATE it keeps the current name.)
  IF p_patch ? 'display_name'
     AND pg_catalog.btrim(coalesce(p_patch ->> 'display_name', '')) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'A supplier needs a display name — it cannot be blank.');
  END IF;

  -- ── The one-level pre-check, for a readable refusal ────────────────────────────
  IF p_patch ? 'parent_code' AND (p_patch ->> 'parent_code') IS NOT NULL THEN
    v_parent := p_patch ->> 'parent_code';

    IF v_parent = p_code THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', format('"%s" cannot be its own parent.', p_code));
    END IF;

    SELECT s.parent_code INTO v_gparent
      FROM cenapro.rc_supplier s WHERE s.code = v_parent;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', format('There is no supplier with the code "%s". Add that trader first, then '
                       || 'point "%s" at it.', v_parent, p_code));
    END IF;

    IF v_gparent IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', format('"%s" is already a sub-supplier of "%s", so it cannot also be a parent. '
                       || 'Supplier subgroups are one level deep — point "%s" at "%s" instead.',
                          v_parent, v_gparent, p_code, v_gparent));
    END IF;

    SELECT pg_catalog.array_agg(k.code ORDER BY k.code) INTO v_children
      FROM cenapro.rc_supplier k WHERE k.parent_code = p_code;

    IF v_children IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', format('"%s" already has sub-supplier(s) (%s), so it cannot itself become one. '
                       || 'Supplier subgroups are one level deep — move those sub-suppliers to '
                       || '"%s" first.',
                          p_code, pg_catalog.array_to_string(v_children, ', '), v_parent));
    END IF;
  END IF;

  -- ── INSERT ─────────────────────────────────────────────────────────────────────
  IF p_expected_row_version IS NULL THEN
    v_new := pg_catalog.jsonb_populate_record(NULL::cenapro.rc_supplier, p_patch);

    BEGIN
      INSERT INTO cenapro.rc_supplier AS t
        (code, display_name, parent_code, sort_order, active, notes)
      VALUES
        (p_code,
         -- display_name is NOT NULL; the seed set it equal to the code, so an omitted
         -- name means "same as the code" rather than a refusal.
         coalesce(v_new.display_name, p_code),
         v_new.parent_code,
         coalesce(v_new.sort_order, 0),
         coalesce(v_new.active, true),
         v_new.notes)
      RETURNING t.code, t.row_version INTO v_code, v_version;
    EXCEPTION
      WHEN unique_violation THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'invalid',
          'message', format('A supplier with the code "%s" already exists. Edit that one instead.',
                            p_code));
      WHEN foreign_key_violation THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'invalid',
          'message', format('There is no supplier with the code "%s" to be the parent.',
                            v_new.parent_code));
      WHEN check_violation THEN
        -- Includes the one-level constraint trigger, whose message is already written
        -- for a human, and the non-blank code CHECK.
        RETURN pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'invalid', 'message', SQLERRM);
    END;

    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'inserted', 'code', v_code, 'row_version', v_version);
  END IF;

  -- ── UPDATE ─────────────────────────────────────────────────────────────────────
  SELECT * INTO v_cur FROM cenapro.rc_supplier s WHERE s.code = p_code;
  IF v_cur.code IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found',
      'message', format('There is no supplier with the code "%s" — it may have been removed. '
                     || 'Reload the supplier list.', p_code));
  END IF;

  -- Merge the patch over the current row, then assign the allowlisted columns.
  -- jsonb_populate_record does the text -> integer / boolean coercion, so a malformed
  -- value fails loudly here instead of landing as NULL. The read-then-write is safe
  -- BECAUSE the version check lives in the UPDATE's own WHERE: any concurrent commit
  -- bumped row_version, so the merged UPDATE then matches nothing.
  v_new := pg_catalog.jsonb_populate_record(v_cur, p_patch);

  BEGIN
    UPDATE cenapro.rc_supplier AS t
       SET display_name = v_new.display_name,
           parent_code  = v_new.parent_code,
           sort_order   = coalesce(v_new.sort_order, 0),
           active       = coalesce(v_new.active, true),
           notes        = v_new.notes
     WHERE t.code        = p_code
       AND t.row_version = p_expected_row_version
    RETURNING t.code, t.row_version INTO v_code, v_version;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', format('There is no supplier with the code "%s" to be the parent.',
                          v_new.parent_code));
    WHEN check_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid', 'message', SQLERRM);
  END;

  IF v_code IS NULL THEN
    SELECT s.row_version INTO v_current FROM cenapro.rc_supplier s WHERE s.code = p_code;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found',
        'message', format('"%s" no longer exists — it was removed while you were editing.', p_code));
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', format('Someone else changed "%s" while you were editing. Reload to see their '
                     || 'values.', p_code));
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'updated', 'code', v_code, 'row_version', v_version);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_save_rc_supplier(text, integer, jsonb) IS
  'Save one Cenapro RC supplier (the cheque-payee dimension, including its SUBGROUP). '
  'p_expected_row_version NULL => INSERT with code p_code; otherwise UPDATE gated on that version '
  'in the same statement as the write — a blind update is refused. Patch keys are allowlisted '
  '(display_name, parent_code, sort_order, active, notes); an unknown key refuses the whole call, '
  'and `code` is deliberately not editable. Setting parent_code is checked against the ONE-LEVEL '
  'subgroup rule with a human-readable refusal, and guaranteed by the constraint trigger '
  'tr_cenapro_rc_supplier_one_level whichever path writes. Pass parent_code: null to clear a '
  'grouping. Outcomes: inserted | updated | version_conflict | not_found | unsupported_field | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_save_rc_supplier(text, integer, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_save_rc_supplier(text, integer, jsonb) TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 8. NO SEED. NO BACKFILL. NOTHING INFERRED.
-- ═════════════════════════════════════════════════════════════════════════════════
-- All 12 suppliers keep parent_code IS NULL. There is no UPDATE of cenapro.rc_supplier
-- anywhere above, and the audit trail starts empty — the same discipline as
-- rc_delivery_audit: a fabricated row in the one table whose value is that it is not
-- fabricated destroys the table. Renzo sets the subgroups up himself, and that act is
-- the first thing this trail will record.
