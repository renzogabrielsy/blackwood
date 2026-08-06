-- ─────────────────────────────────────────────────────────────────────────────────
-- Cenapro (Tenant #2) — ALLOCATION: assigning a payment to particular deliveries.
-- Liquidation Step 4.
--
-- WHAT THIS ANSWERS THAT STEP 3 COULD NOT: "which receipts did that cheque pay for",
-- and its mirror, "how much of this cheque is still unassigned". Step 3 already knows
-- what CI owes a trader in total; this is the join between the money going out and the
-- trucks that came in.
--
-- BOTH DOORS, ONE WRITE PATH (§7a). Renzo asked for cheque-first AND delivery-first
-- ("an add cheque button in deliveries page… right click on a delivery and then assign a
-- cheque to it"). Both doors create the SAME rows through the SAME function: the
-- delivery-first convenience RPC merges its one edge into the payment's block and
-- delegates to the block replace, so there is ONE code path and ONE set of invariants.
--
-- STRICTLY ADDITIVE TO cenapro.rc_delivery. No column is added to it, nothing is written
-- in it, and cenapro.view_rc_delivery is NOT altered (60 columns, UI consumers, a
-- 116-assertion verify script). Settlement lives in a VIEW: the moment a `paid` flag
-- appears on the receipt there are two truths about the same money.
--
-- ═══ WHY A JOIN TABLE WITH AN AMOUNT ON THE EDGE (§4.3) ══════════════════════════
-- A payment is not 1:1 with a receipt IN BOTH DIRECTIONS AT ONCE. One cheque routinely
-- settles several truckloads; one truckload is routinely settled by a downpayment now and
-- the balance later. `rc_delivery.paid_by_payment_id` fails the first case,
-- `rc_payment.delivery_id` fails the second. The amount on the edge is not decoration —
-- it IS the entire content of a partial payment, and it is what makes "how much of this
-- cheque is still unassigned" answerable at all.
--
-- ═══ THE TWO INVARIANTS — ONE ENFORCED, ONE DELIBERATELY NOT ═════════════════════
-- A CHECK constraint cannot express either; it sees only its own row.
--
--  1. ENFORCED — A PAYMENT'S LIVE ALLOCATIONS MAY NEVER EXCEED ITS `amount_php`.
--     Belt AND braces: the RPC returns a friendly refusal naming the overshoot, AND a
--     CONSTRAINT TRIGGER guarantees it against any path. NOT a generated column — this
--     schema already proved (20260804070000, decision 2) that a generated column cannot
--     reference a sibling generated column, let alone another table.
--     THE TRIGGER IS ON BOTH SIDES OF THE ARITHMETIC: on rc_payment_allocation (assign
--     too much) and on rc_payment (edit the cheque DOWN below what is already assigned).
--     The brief asked only for the first; the invariant is symmetric and the second hole
--     is the easier one to fall into. It raises with SQLSTATE 23514 and a human-readable
--     MESSAGE, so Step 3's existing `WHEN check_violation` handler in
--     cenapro_save_rc_payment returns it verbatim as a toast-ready `invalid` — that
--     function is not modified at all.
--
--  2. NOT ENFORCED — A RECEIPT'S ALLOCATIONS MAY EXCEED ITS `total_price_php`.
--     Decision 13, Renzo verbatim: "record it. It will be reflected in the running
--     balance anyway." No refusal, no CHECK, no threshold. It surfaces as
--     settlement_status = 'over_allocated'. Refusing to record something that actually
--     happened is how these systems start lying.
--
-- ═══ `unpriced` IS NOT `settled` — THE §3.4 TRAP, RESTATED ═══════════════════════
-- total_price_php COALESCEs a missing weight or price to exactly ₱0, so an unpriced
-- receipt with no allocations computes as "fully settled" under ANY naive comparison.
-- The status CASE therefore tests `unpriced` FIRST, and `balance_php` is NULL — not 0 —
-- on an unpriceable receipt, because the honest answer to "how much is still owed on
-- this" is *nobody knows yet*. Measured fact carried forward from Step 3: the
-- priceable-only sum and SUM(total_price_php) are IDENTICALLY EQUAL on every supplier,
-- forever — the hole is a COUNT gap, never a peso gap, so nothing but an explicit status
-- and an explicit NULL can reveal it.
--
-- ═══ SUB-SUPPLIER LEGALITY (§5a) ═════════════════════════════════════════════════
-- An allocation is legal when the payment's payee IS the delivery's supplier, OR the
-- delivery's supplier is in the payee's GROUP — resolved through
-- cenapro.view_rc_supplier_group.group_code, the ONE definition, never re-derived.
-- Renzo: "if a cheque is labeled Paquibot but is being assigned to a Llanto delivery,
-- then it should push through because it verified that Llanto is a sub-supplier of
-- Paquibot." Enforced in the RPC with a refusal that NAMES BOTH TRADERS. A receipt with
-- a NULL supplier_code can never be allocated — it has no payee — and is refused by name
-- (§6: the screen should say so, not guess).
--
-- ═══ SIX DECISIONS THE BRIEF LEFT TO ME, AND ONE PLACE IT IS WRONG ═══════════════
--
-- A. `payee_group_code` IS DERIVED AND FORCED BY A TRIGGER, NEVER ACCEPTED FROM A
--    CALLER, AND FROZEN ON UPDATE. group_code answers "may this payee be paid for this
--    receipt RIGHT NOW"; the question a dispute actually asks six months later is "WAS
--    that allocation legal when it was made" — and re-pointing a parent silently changes
--    today's answer. Recording the resolved group ON THE ROW makes the historical
--    question answerable from the row itself. Because it is the row's own evidence of its
--    legality, letting a caller type it would let a caller forge it: the BEFORE trigger
--    looks it up from the payment's payee and overwrites whatever was passed, and on
--    UPDATE it re-freezes OLD's value so an amount edit can never re-date the judgement.
--    It DOES carry an FK (ON UPDATE CASCADE, no ON DELETE clause) — matching
--    rc_payment.supplier_code — so re-KEYING a trader follows the money while a DELETE is
--    refused. Re-keying preserves the meaning exactly ("same trader, new code");
--    re-PARENTING does not touch this column at all, which is the entire point.
--
-- B. LEGALITY IS CHECKED AT WRITE TIME ONLY — NOT BY A CONSTRAINT TRIGGER. The rule
--    applied: ARITHMETIC invariants get a constraint trigger, POINT-IN-TIME JUDGEMENTS do
--    not. "Allocations ≤ amount" is true or false whenever you ask it. "This payee may be
--    paid for this receipt" is a judgement about a moment: a parent detached next March
--    would make a constraint trigger refuse an unrelated amount edit on an allocation
--    that WAS legal when it was made, and re-judging history on every write is precisely
--    what column A exists to avoid.
--
-- C. AN ALLOCATION TO AN UNPRICED RECEIPT IS ALLOWED. §7a greys those rows out on the
--    delivery-first door, and that is a UI rule which this migration supports
--    (`is_allocatable`). It is NOT a refusal, because "priced but not yet weighed" is a
--    NORMAL DAILY STAGE (§3.4) and a downpayment on a truck whose weight arrives tomorrow
--    is an ordinary business act. Recording it and surfacing it as `unpriced` with money
--    on it is honest; refusing it would make the system lie about what happened.
--
-- D. AN ALLOCATION AMOUNT IS *NOT* LIMITED TO TWO DECIMAL PLACES, unlike a stated
--    opening balance (20260805130000). 447 of 971 receipts are not a whole peso and 19
--    carry sub-centavo fractions, so "settle this receipt in full" must be able to assign
--    ₱1,027,132.875 exactly. A centavo rule here would make full settlement unreachable
--    on 19 receipts and leave a permanent phantom remainder.
--
-- E. THE INDEXES DEVIATE FROM THE BRIEF'S LIST, FOR TWO MEASURABLE REASONS. The brief
--    asked for `(payment_id) WHERE deleted_at IS NULL` and `(delivery_id) WHERE
--    deleted_at IS NULL`. The first is a strict prefix-subset of the partial UNIQUE
--    index and can never be chosen over it — dead weight on every write. The second
--    cannot serve the `ON DELETE RESTRICT` referential scan, which must see soft-deleted
--    children too, so a PLAIN (delivery_id) is required anyway and a partial twin buys
--    nothing at this table's size. Shipped: the partial UNIQUE pair index (the
--    invariant + the live per-payment path via its leading column), plus PLAIN
--    (delivery_id) and PLAIN (payment_id) for the two RI scans. Postgres indexes no
--    foreign key automatically.
--
-- F. ⚠ THE BRIEF IS WRONG ABOUT THE DELIVERY-DELETE RELEASE, AND THE FK IS WHY.
--    It says the release flag "makes it SOFT-DELETE those allocations in the same
--    transaction and then delete the receipt". That cannot work: `delivery_id` is
--    ON DELETE RESTRICT (which the brief also, correctly, calls load-bearing), and the
--    referential check does not know what `deleted_at` means — a soft-deleted edge STILL
--    references the row and STILL refuses the DELETE. Soft-delete-then-delete would fail
--    with a bare foreign-key error every single time.
--    RESOLVED by keeping the PROPERTY the brief was protecting rather than its letter,
--    and §5c already wrote the resolution: "Every mutation carries a full snapshot, so
--    anything can be reconstructed EVEN WHEN IT WAS HARD-REMOVED UPSTREAM."
--      * A user removing an edge from a cheque  → SOFT delete. Reversible, restorable.
--      * The RECEIPT ITSELF being destroyed     → the edge cannot survive it, so it is
--        HARD-removed, in the same transaction, with a full-snapshot DELETE audit row
--        whose `source` says exactly why. The money returns to the cheque's unassigned
--        pool automatically, because `unallocated_php` is derived.
--    ON DELETE RESTRICT keeps doing precisely its job: the ordinary ledger delete is
--    refused (`has_allocations`, with the real total and the real cheques), and even raw
--    DML cannot cascade money away. Only the explicit release path, which removes the
--    edges itself first, can proceed.
--
-- ═══ WHAT IS NOT BUILT HERE ══════════════════════════════════════════════════════
-- No UI (frontend pass). types/supabase.ts NOT regenerated (CLI only — the MCP generator
-- drops graphql_public). No rc_balance_period (Step 6), no cheque-gap report (Step 7), no
-- reporting (Step 8). No allocation row is seeded: there is no real allocation to record
-- and inventing one would put a fabrication in the middle of the money.
-- ─────────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════════
-- 1. THE FACT — cenapro.rc_payment_allocation
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cenapro.rc_payment_allocation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE: an allocation has no existence apart from its payment.
  payment_id       uuid        NOT NULL
                   REFERENCES cenapro.rc_payment(id) ON DELETE CASCADE,

  -- RESTRICT, and load-bearing (header F). Nothing may silently cascade money away;
  -- releasing it is a deliberate, trailed act through cenapro_delete_rc_delivery.
  delivery_id      uuid        NOT NULL
                   REFERENCES cenapro.rc_delivery(id) ON DELETE RESTRICT,

  amount_php       numeric     NOT NULL,

  -- The payee's resolved group AT THE TIME OF WRITING. Derived + forced + frozen by
  -- cenapro.fn_touch_rc_payment_allocation — see header A.
  payee_group_code text        NOT NULL
                   REFERENCES cenapro.rc_supplier(code) ON UPDATE CASCADE,

  note             text,

  -- ── soft delete (§5c) ──────────────────────────────────────────────────────────
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- ── concurrency / actor ────────────────────────────────────────────────────────
  row_version      integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- ── constraints ────────────────────────────────────────────────────────────────
  -- An edge of zero pesos is not a partial payment, it is a row that says nothing.
  CONSTRAINT cenapro_rc_payment_allocation_amount_positive
    CHECK (amount_php > 0),

  CONSTRAINT cenapro_rc_payment_allocation_group_nonblank
    CHECK (btrim(payee_group_code) <> ''),

  -- An actor without a deletion is a half-truth.
  CONSTRAINT cenapro_rc_payment_allocation_deleted_shape
    CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL)
);

COMMENT ON TABLE cenapro.rc_payment_allocation IS
  'Cenapro RC LIQUIDATION — the many-to-many edge between a payment and the receipts it settles, '
  'WITH THE AMOUNT ON THE EDGE. One cheque routinely covers several truckloads and one truckload is '
  'routinely settled by a downpayment now and the balance later, so neither a column on the receipt '
  'nor a column on the payment can express it (§4.3). The amount is the entire content of a partial '
  'payment and it is what makes "how much of this cheque is still unassigned" answerable. '
  'INVARIANT ENFORCED: a payment''s live allocations may never exceed its amount_php (constraint '
  'trigger, both sides). INVARIANT DELIBERATELY NOT ENFORCED: a receipt''s allocations MAY exceed '
  'its total_price_php — decision 13, "record it, it will be reflected in the running balance '
  'anyway" — and it reads as settlement_status = ''over_allocated''. A CASH ADVANCE NEEDS NO ROW '
  'HERE AT ALL: it is simply a payment whose allocations sum to less than its amount (§4.4). '
  'SOFT-deleted by a human (reversible via public.cenapro_restore_rc_payment_allocation); '
  'HARD-removed only when the receipt it points at is itself deleted, with a full-snapshot audit '
  'row (see public.cenapro_delete_rc_delivery). ENTIRELY ₱-BEARING — every consumer sits behind '
  'canViewPrices().';

COMMENT ON COLUMN cenapro.rc_payment_allocation.payment_id IS
  'The payment this edge spends. ON DELETE CASCADE: an allocation has no existence apart from its '
  'payment. Immutable — an edge cannot be moved to another cheque (the touch trigger refuses it); '
  'delete it and create a new one, so the trail says what actually happened.';
COMMENT ON COLUMN cenapro.rc_payment_allocation.delivery_id IS
  'The receipt this edge settles. ON DELETE RESTRICT, and load-bearing: money may never be '
  'cascaded away silently. Deleting a receipt that has money against it is REFUSED by '
  'public.cenapro_delete_rc_delivery (outcome has_allocations, with the real total and the real '
  'cheques) unless the caller passes p_release_allocations => true, which removes these edges in '
  'the same transaction and returns the money to each cheque''s unassigned pool. Immutable, same '
  'reason as payment_id.';
COMMENT ON COLUMN cenapro.rc_payment_allocation.amount_php IS
  'How much of the payment is assigned to this receipt. ALWAYS > 0. Deliberately NOT limited to '
  'two decimal places, unlike a hand-stated opening balance: 19 receipts price out to sub-centavo '
  'fractions, and "settle this receipt in full" has to be able to assign ₱1,027,132.875 exactly. '
  'Normalised with trim_scale by the touch trigger so 1000.00 and 1000 cannot read as two '
  'different figures in the audit diff.';
COMMENT ON COLUMN cenapro.rc_payment_allocation.payee_group_code IS
  'THE PAYEE''S RESOLVED GROUP AT THE TIME OF WRITING (cenapro.view_rc_supplier_group.group_code, '
  'read from its one definition, never re-derived). WHY IT IS STORED: group_code answers "may this '
  'payee be paid for this receipt RIGHT NOW", but the question a dispute asks six months later is '
  '"WAS that allocation legal when it was made" — and re-pointing a parent silently changes '
  'today''s answer. Recording the resolved group on the row makes the historical question '
  'answerable from the row itself. DERIVED, FORCED AND FROZEN by '
  'cenapro.fn_touch_rc_payment_allocation: a caller cannot set it (that would let a caller forge '
  'the evidence of its own legality) and an UPDATE cannot move it (that would re-date the '
  'judgement). It DOES follow a supplier re-KEY, via ON UPDATE CASCADE — same trader, new code — '
  'but it never follows a re-PARENT, which is the entire point.';
COMMENT ON COLUMN cenapro.rc_payment_allocation.deleted_at IS
  'SOFT delete (§5c: allocations are money records). Every sum filters deleted_at IS NULL, and the '
  'partial UNIQUE index ignores these rows so the same pair can be re-created. Undo with '
  'public.cenapro_restore_rc_payment_allocation(). NOTE the one case that is NOT soft: when the '
  'RECEIPT is deleted, the edge cannot survive the foreign key, so it is hard-removed with a '
  'full-snapshot DELETE audit row whose `source` says why.';
COMMENT ON COLUMN cenapro.rc_payment_allocation.row_version IS
  'Optimistic-concurrency token for the restore RPC, bumped by the touch trigger on EVERY update. '
  'NOTE that the block-replace RPC gates on the PARENT PAYMENT''s row_version, not this one: a '
  'cheque''s allocations are edited as one block, and locking the parent also catches "someone '
  'edited the cheque while I was spreading it".';

-- ── Indexes (header E) ───────────────────────────────────────────────────────────
-- THE INVARIANT: one LIVE edge per (payment, receipt) pair. Two partial payments from
-- the same cheque to the same receipt is ONE LARGER EDGE, not two rows. Partial on
-- deleted_at so a released edge never blocks re-creating the pair — and this exact
-- predicate is what the block RPC's ON CONFLICT clause infers.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cenapro_rc_payment_allocation_pair
  ON cenapro.rc_payment_allocation (payment_id, delivery_id)
  WHERE deleted_at IS NULL;

-- The settlement view's driving path AND the ON DELETE RESTRICT referential scan.
-- PLAIN, not partial: the RI check must see soft-deleted children too, so it could never
-- use a `WHERE deleted_at IS NULL` index.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_payment_allocation_delivery
  ON cenapro.rc_payment_allocation (delivery_id);

-- The ON DELETE CASCADE referential scan from rc_payment. Same reasoning: a cascade must
-- find soft-deleted children as well, and the unique index above is partial.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_payment_allocation_payment
  ON cenapro.rc_payment_allocation (payment_id);


-- ═════════════════════════════════════════════════════════════════════════════════
-- 2. TOUCH TRIGGER — cenapro.fn_touch_rc_payment_allocation
-- ═════════════════════════════════════════════════════════════════════════════════
-- Cloned from cenapro.fn_touch_rc_payment, plus the two things that make this table
-- honest: it DERIVES payee_group_code on INSERT and FREEZES it on UPDATE (header A), and
-- it REFUSES a change of (payment_id, delivery_id) rather than silently reverting it —
-- an edge that could be re-pointed would make the audit trail unreadable, and silently
-- ignoring a caller's write is worse than refusing it out loud.
-- In a TRIGGER, not in the RPC, for the reason stated on cenapro.fn_touch_rc_delivery:
-- any raw DML must normalise identically and must advance the concurrency token too.
CREATE OR REPLACE FUNCTION cenapro.fn_touch_rc_payment_allocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_group text;
BEGIN
  NEW.amount_php := trim_scale(NEW.amount_php);
  NEW.note       := nullif(btrim(NEW.note), '');

  IF TG_OP = 'INSERT' THEN
    -- The payee's group, resolved from its ONE definition. Whatever the caller passed is
    -- overwritten: this column is the row's own evidence of its legality.
    SELECT g.group_code
      INTO v_group
      FROM cenapro.rc_payment p
      JOIN cenapro.view_rc_supplier_group g ON g.code = p.supplier_code
     WHERE p.id = NEW.payment_id;

    -- NULL only if the payment vanished between statements; the NOT NULL then refuses the
    -- row, which is the correct answer.
    NEW.payee_group_code := v_group;

    NEW.created_by := coalesce(NEW.created_by, auth.uid());
    NEW.updated_by := coalesce(NEW.updated_by, NEW.created_by);
    RETURN NEW;
  END IF;

  IF NEW.payment_id  IS DISTINCT FROM OLD.payment_id
     OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id THEN
    RAISE EXCEPTION USING
      ERRCODE    = '23514',
      CONSTRAINT = 'cenapro_rc_payment_allocation_pair_immutable',
      MESSAGE    = 'An allocation cannot be moved to a different payment or a different receipt. '
                   || 'Remove this one and create the allocation you want, so the history says '
                   || 'what actually happened.';
  END IF;

  NEW.updated_at       := now();
  NEW.row_version      := OLD.row_version + 1;
  NEW.created_at       := OLD.created_at;
  NEW.created_by       := OLD.created_by;
  -- FROZEN: the group that legalised this edge is a fact about the moment it was made.
  NEW.payee_group_code := OLD.payee_group_code;
  -- Attribute the write when there is a logged-in user; a service-role write has no
  -- auth.uid() and must not blank out whoever last touched the row.
  NEW.updated_by       := coalesce(auth.uid(), NEW.updated_by);
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION cenapro.fn_touch_rc_payment_allocation() IS
  'BEFORE INSERT/UPDATE on cenapro.rc_payment_allocation: normalises amount_php (trim_scale) and '
  'note, stamps created_by/updated_by from auth.uid(), bumps row_version + updated_at on UPDATE, '
  'DERIVES payee_group_code from the payment''s payee on INSERT and FREEZES it on UPDATE, and '
  'REFUSES any attempt to move an edge to another payment or another receipt (SQLSTATE 23514, so '
  'the RPCs report it as a readable `invalid`). In a trigger so every write path — including raw '
  'DML — behaves identically.';

REVOKE EXECUTE ON FUNCTION cenapro.fn_touch_rc_payment_allocation() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cenapro.fn_touch_rc_payment_allocation() TO authenticated, service_role;

DROP TRIGGER IF EXISTS tr_cenapro_rc_payment_allocation_touch ON cenapro.rc_payment_allocation;
CREATE TRIGGER tr_cenapro_rc_payment_allocation_touch
  BEFORE INSERT OR UPDATE ON cenapro.rc_payment_allocation
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_touch_rc_payment_allocation();


-- ═════════════════════════════════════════════════════════════════════════════════
-- 3. THE ENFORCED INVARIANT — allocations ≤ the payment's amount
-- ═════════════════════════════════════════════════════════════════════════════════
-- ONE function, TWO constraint triggers, because the invariant has two sides and a CHECK
-- can see neither: assign too much (rc_payment_allocation), or edit the cheque DOWN
-- below what is already assigned (rc_payment).
--
-- DEFERRABLE INITIALLY IMMEDIATE, exactly like tr_cenapro_rc_supplier_one_level: the
-- deferral exists so a future multi-statement rearrangement can happen in one
-- transaction, while IMMEDIATE means the exception fires INSIDE the calling statement and
-- the RPCs' EXCEPTION blocks can turn it into a readable refusal.
--
-- It raises SQLSTATE 23514 (check_violation) with a fully human-readable MESSAGE on
-- purpose: Step 3's cenapro_save_rc_payment already has `WHEN check_violation THEN …
-- 'message', SQLERRM`, so the cheque-edit refusal reads properly in a toast WITHOUT
-- modifying that function.
--
-- WHY THE SUM IS RECOMPUTED RATHER THAN MAINTAINED: an AFTER ROW trigger fires at the END
-- of its statement, so the block-replace RPC's single upsert statement is checked once
-- against its FINAL state and no legal intermediate ordering can trip it.
CREATE OR REPLACE FUNCTION cenapro.fn_check_rc_payment_allocation_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_payment_id uuid;
  v_amount     numeric;
  v_allocated  numeric;
  v_method     text;
  v_cheque     text;
  v_date       date;
  v_payee      text;
  v_label      text;
BEGIN
  IF TG_TABLE_NAME = 'rc_payment' THEN
    -- Nothing that can break the invariant moved.
    IF NEW.amount_php = OLD.amount_php THEN
      RETURN NULL;
    END IF;
    v_payment_id := NEW.id;
  ELSE
    v_payment_id := NEW.payment_id;
  END IF;

  SELECT p.amount_php, p.method, p.cheque_no, p.payment_date,
         coalesce(s.display_name, p.supplier_code)
    INTO v_amount, v_method, v_cheque, v_date, v_payee
    FROM cenapro.rc_payment p
    LEFT JOIN cenapro.rc_supplier s ON s.code = p.supplier_code
   WHERE p.id = v_payment_id;

  -- The payment is gone (a hard DELETE cascading into its edges). There is no amount left
  -- to exceed, and the cascade is not the place to complain.
  IF v_amount IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(a.amount_php), 0)
    INTO v_allocated
    FROM cenapro.rc_payment_allocation a
   WHERE a.payment_id  = v_payment_id
     AND a.deleted_at IS NULL;

  IF v_allocated > v_amount THEN
    v_label := CASE
      WHEN v_method = 'cheque' THEN format('cheque #%s to %s', v_cheque, v_payee)
      ELSE format('%s of %s to %s', v_method, to_char(v_date, 'YYYY-MM-DD'), v_payee)
    END;

    RAISE EXCEPTION USING
      ERRCODE    = '23514',
      CONSTRAINT = 'cenapro_rc_payment_allocations_within_amount',
      MESSAGE    = format(
        'That would assign %s of the %s, which is only worth %s - over by %s. A payment cannot '
        || 'have more money assigned to receipts than it is worth.',
        to_char(v_allocated, 'FM999,999,999,990.00'),
        v_label,
        to_char(v_amount,    'FM999,999,999,990.00'),
        to_char(v_allocated - v_amount, 'FM999,999,999,990.00')),
      HINT       = 'Lower one of the assigned amounts, or raise the payment''s amount first.';
  END IF;

  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION cenapro.fn_check_rc_payment_allocation_total() IS
  'THE enforced liquidation invariant: a payment''s LIVE allocations may never exceed its '
  'amount_php. Shared by two DEFERRABLE INITIALLY IMMEDIATE constraint triggers — one on '
  'cenapro.rc_payment_allocation (assigning too much) and one on cenapro.rc_payment (editing the '
  'cheque down below what is already assigned), because the invariant is symmetric and a CHECK can '
  'express neither. Raises SQLSTATE 23514 with a toast-ready MESSAGE, so the existing '
  'check_violation handlers in the save RPCs report it verbatim. Says nothing about a RECEIPT being '
  'over-allocated: that is deliberately legal (decision 13).';

REVOKE EXECUTE ON FUNCTION cenapro.fn_check_rc_payment_allocation_total() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cenapro.fn_check_rc_payment_allocation_total()
  TO authenticated, service_role;

-- A DELETE can only lower the sum, so the allocation-side trigger is INSERT/UPDATE only.
DROP TRIGGER IF EXISTS tr_cenapro_rc_payment_allocation_within_amount
  ON cenapro.rc_payment_allocation;
CREATE CONSTRAINT TRIGGER tr_cenapro_rc_payment_allocation_within_amount
  AFTER INSERT OR UPDATE ON cenapro.rc_payment_allocation
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_check_rc_payment_allocation_total();

-- A brand-new payment has no allocations, so the payment-side trigger is UPDATE only.
DROP TRIGGER IF EXISTS tr_cenapro_rc_payment_allocations_fit ON cenapro.rc_payment;
CREATE CONSTRAINT TRIGGER tr_cenapro_rc_payment_allocations_fit
  AFTER UPDATE ON cenapro.rc_payment
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_check_rc_payment_allocation_total();


-- ═════════════════════════════════════════════════════════════════════════════════
-- 4. RLS + GRANTS — the cenapro DEFAULT ACL trap
-- ═════════════════════════════════════════════════════════════════════════════════
-- `pg_default_acl` for schema cenapro is {anon=r, authenticated=arwd, service_role=arwd},
-- so a table created here is BORN readable by anon whatever the CREATE said. Revoke, then
-- hand back exactly what the SECURITY INVOKER RPCs need: SELECT + INSERT + UPDATE (soft
-- delete) + DELETE (the release path, when a receipt is destroyed). The `cenapro` schema
-- is not exposed to PostgREST and every public accessor below is READ-ONLY, so the RPCs
-- remain the only door.
ALTER TABLE cenapro.rc_payment_allocation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cenapro_rc_payment_allocation_select ON cenapro.rc_payment_allocation;
CREATE POLICY cenapro_rc_payment_allocation_select
  ON cenapro.rc_payment_allocation FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cenapro_rc_payment_allocation_insert ON cenapro.rc_payment_allocation;
CREATE POLICY cenapro_rc_payment_allocation_insert
  ON cenapro.rc_payment_allocation FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS cenapro_rc_payment_allocation_update ON cenapro.rc_payment_allocation;
CREATE POLICY cenapro_rc_payment_allocation_update
  ON cenapro.rc_payment_allocation FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS cenapro_rc_payment_allocation_delete ON cenapro.rc_payment_allocation;
CREATE POLICY cenapro_rc_payment_allocation_delete
  ON cenapro.rc_payment_allocation FOR DELETE TO authenticated USING (true);

REVOKE ALL ON cenapro.rc_payment_allocation FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON cenapro.rc_payment_allocation
  TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 5. THE AUDIT TRAIL — cenapro.rc_payment_audit gains an `entity` discriminator
-- ═════════════════════════════════════════════════════════════════════════════════
-- ONE table for the payment AND its allocations, discriminated by `entity` and ALWAYS
-- KEYED BY payment_id — so one cheque's whole history, including every re-assignment, is
-- a single indexed query. This is exactly the cenapro.rc_delivery_audit shape (entity,
-- keyed by the parent delivery_id) and it is the reason that shape was chosen.
--
-- A SEPARATE TABLE WAS CONSIDERED AND REJECTED: it would answer "what happened to this
-- allocation" but would need a UNION to answer "what happened to this cheque", which is
-- the question anybody actually asks — and a UNION of two append-only tables is where the
-- two schemas quietly drift apart.
--
-- The new columns are APPENDED, and cenapro.fn_audit_rc_payment is NOT modified: `entity`
-- defaults to 'payment', so every existing writer keeps working untouched.
ALTER TABLE cenapro.rc_payment_audit
  ADD COLUMN IF NOT EXISTS entity        text NOT NULL DEFAULT 'payment',
  ADD COLUMN IF NOT EXISTS allocation_id uuid,
  ADD COLUMN IF NOT EXISTS delivery_id   uuid;

ALTER TABLE cenapro.rc_payment_audit
  DROP CONSTRAINT IF EXISTS cenapro_rc_payment_audit_entity_ck;
ALTER TABLE cenapro.rc_payment_audit
  ADD  CONSTRAINT cenapro_rc_payment_audit_entity_ck
       CHECK (entity IN ('payment', 'allocation'));

-- Shape guard, in the spirit of cenapro_rc_delivery_audit_entity_shape: an allocation row
-- must name its allocation, a payment row must not pretend to have one.
ALTER TABLE cenapro.rc_payment_audit
  DROP CONSTRAINT IF EXISTS cenapro_rc_payment_audit_entity_shape;
ALTER TABLE cenapro.rc_payment_audit
  ADD  CONSTRAINT cenapro_rc_payment_audit_entity_shape
       CHECK ((entity = 'allocation' AND allocation_id IS NOT NULL)
           OR (entity = 'payment'    AND allocation_id IS NULL AND delivery_id IS NULL));

COMMENT ON COLUMN cenapro.rc_payment_audit.entity IS
  '''payment'' = a cenapro.rc_payment row; ''allocation'' = a cenapro.rc_payment_allocation row. '
  'BOTH are keyed by payment_id, so one cheque''s whole history — including every re-assignment of '
  'its money — is a single indexed query. Defaults to ''payment'' so the pre-existing trigger did '
  'not have to change.';
COMMENT ON COLUMN cenapro.rc_payment_audit.allocation_id IS
  'The allocation row''s own id, on entity = ''allocation'' only. No FK — the trail outlives the '
  'row, and an allocation is hard-removed when its receipt is deleted.';
COMMENT ON COLUMN cenapro.rc_payment_audit.delivery_id IS
  'WHICH RECEIPT the allocation pointed at, recorded on the row so the trail is readable without a '
  'join — including after the receipt itself has been deleted, which is precisely when somebody '
  'comes looking. NULL on a payment entry.';
COMMENT ON COLUMN cenapro.rc_payment_audit.amount_php IS
  'The amount AT THE TIME OF THE CHANGE: on entity = ''payment'' the PAYMENT''s amount, on entity = '
  '''allocation'' the ALLOCATION''s amount (read `entity` before reading this). Promoted out of '
  '`snapshot` because "what was this worth when it was voided / re-assigned" is the question this '
  'table exists to answer. ₱-BEARING: any server action exposing this trail is subject to the '
  'canViewPrices() gate, and `changed` / `snapshot` are free-form jsonb that stripPrices() cannot '
  'reach inside.';

-- "What money history touched this receipt" — the delivery-first door's history panel, and
-- the only way to see an allocation that was released when its receipt was deleted.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_payment_audit_delivery
  ON cenapro.rc_payment_audit (delivery_id, changed_at DESC)
  WHERE delivery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cenapro_rc_payment_audit_allocation
  ON cenapro.rc_payment_audit (allocation_id, changed_at DESC)
  WHERE allocation_id IS NOT NULL;

-- ── The allocation trigger ───────────────────────────────────────────────────────
-- SECURITY DEFINER for the reason given on every other trail in this schema: combined
-- with the REVOKEs on the table it means the trigger is the ONLY thing that can write it.
-- AFTER, not BEFORE: cenapro.fn_touch_rc_payment_allocation rewrites amount_php,
-- row_version, updated_at and payee_group_code, and only an AFTER trigger sees what was
-- actually stored.
CREATE OR REPLACE FUNCTION cenapro.fn_audit_rc_payment_allocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_old        jsonb;
  v_new        jsonb;
  v_changed    jsonb := '{}'::jsonb;
  v_snapshot   jsonb;
  v_alloc_id   uuid;
  v_payment_id uuid;
  v_delivery   uuid;
  v_amount     numeric;
  v_supplier   text;
  v_date       date;
  v_method     text;
  v_cheque     text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old        := to_jsonb(OLD);
    v_snapshot   := v_old;
    v_alloc_id   := OLD.id;
    v_payment_id := OLD.payment_id;
    v_delivery   := OLD.delivery_id;
    v_amount     := OLD.amount_php;
  ELSE
    v_new        := to_jsonb(NEW);
    v_snapshot   := v_new;
    v_alloc_id   := NEW.id;
    v_payment_id := NEW.payment_id;
    v_delivery   := NEW.delivery_id;
    v_amount     := NEW.amount_php;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);

    -- `updated_at` AND `row_version` are excluded because the touch trigger bumps both on
    -- EVERY write: miss one and the diff is never empty, the no-op skip can never fire,
    -- and the trail fills with phantoms. A SOFT DELETE therefore lands here as an UPDATE
    -- carrying `deleted_at`, which is exactly right — the row is still there, and
    -- `changed ? 'deleted_at'` finds releases and restores.
    SELECT coalesce(
             jsonb_object_agg(k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k)),
             '{}'::jsonb)
      INTO v_changed
      FROM jsonb_object_keys(v_new) AS k
     WHERE k <> 'updated_at'
       AND k <> 'row_version'
       AND (v_old -> k) IS DISTINCT FROM (v_new -> k);

    IF v_changed = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
  END IF;

  -- Denormalized PAYMENT identity, so the trail reads without a join.
  SELECT p.supplier_code, p.payment_date, p.method, p.cheque_no
    INTO v_supplier, v_date, v_method, v_cheque
    FROM cenapro.rc_payment p
   WHERE p.id = v_payment_id;

  IF NOT FOUND THEN
    -- A hard DELETE of the payment cascading into its edges: the parent's AFTER DELETE
    -- trigger fires BEFORE the referential cascade, so its own DELETE audit row already
    -- carries the identity. Read it back from there rather than leaving the trail blank.
    SELECT a.supplier_code, a.payment_date, a.method, a.cheque_no
      INTO v_supplier, v_date, v_method, v_cheque
      FROM cenapro.rc_payment_audit a
     WHERE a.payment_id = v_payment_id
       AND a.entity     = 'payment'
     ORDER BY a.id DESC
     LIMIT 1;
  END IF;

  INSERT INTO cenapro.rc_payment_audit
    (payment_id, entity, allocation_id, delivery_id,
     supplier_code, payment_date, method, amount_php, cheque_no,
     operation, changed, snapshot,
     source, changed_by, changed_by_role)
  VALUES
    (v_payment_id, 'allocation', v_alloc_id, v_delivery,
     v_supplier, v_date, v_method, v_amount, v_cheque,
     TG_OP, v_changed, v_snapshot,
     nullif(current_setting('cenapro.audit_source', true), ''),
     auth.uid(),
     auth.role());

  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$fn$;

COMMENT ON FUNCTION cenapro.fn_audit_rc_payment_allocation() IS
  'AFTER INSERT/UPDATE/DELETE trail for cenapro.rc_payment_allocation, written into the SAME table '
  'as the payment trail (cenapro.rc_payment_audit, entity = ''allocation'') and keyed by the PARENT '
  'payment_id, so one cheque''s whole history is one indexed query. Records delivery_id on the row '
  'so the trail is readable after the receipt is gone. Resolves the payment identity from '
  'cenapro.rc_payment, falling back to the payment''s own DELETE audit row on a CASCADE delete (the '
  'parent trigger fires first). Skips an UPDATE whose only difference is updated_at / row_version. '
  'SECURITY DEFINER so the audit table needs no write grant to any client role — it catches EVERY '
  'writer, not just the RPCs.';

REVOKE ALL ON FUNCTION cenapro.fn_audit_rc_payment_allocation() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_cenapro_rc_payment_allocation_audit ON cenapro.rc_payment_allocation;
CREATE TRIGGER tr_cenapro_rc_payment_allocation_audit
  AFTER INSERT OR UPDATE OR DELETE ON cenapro.rc_payment_allocation
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_audit_rc_payment_allocation();


-- ═════════════════════════════════════════════════════════════════════════════════
-- 6. READ MODEL — cenapro.view_rc_payment_allocation (the edge list, with both ends)
-- ═════════════════════════════════════════════════════════════════════════════════
-- One row per edge with enough of the payment and the receipt folded in that neither door
-- needs a second query: the cheque-first screen lists a payment's edges, the
-- delivery-first screen lists a receipt's. Soft-deleted edges ARE included, exactly like
-- cenapro.view_rc_payment includes voided payments — a released assignment belongs on a
-- history panel. Consumers doing arithmetic filter `NOT is_deleted` themselves.
CREATE OR REPLACE VIEW cenapro.view_rc_payment_allocation
WITH (security_invoker = true)
AS
SELECT
  a.id,
  a.payment_id,
  a.delivery_id,
  a.amount_php,
  a.payee_group_code,
  a.note,

  -- ── which cheque ───────────────────────────────────────────────────────────────
  p.supplier_code                                    AS payment_supplier_code,
  coalesce(ps.display_name, p.supplier_code)         AS payment_supplier_name,
  p.payment_date,
  p.method,
  p.cheque_no,
  p.amount_php                                       AS payment_amount_php,
  (p.deleted_at IS NOT NULL)                         AS payment_is_deleted,

  -- ── which receipt ──────────────────────────────────────────────────────────────
  d.supplier_code                                    AS delivery_supplier_code,
  coalesce(ds.display_name, d.supplier_code)         AS delivery_supplier_name,
  d.delivery_date,
  d.truck_no,
  d.total_price_php                                  AS delivery_total_php,

  -- TRUE when the cheque's payee is not the receipt's own trader — i.e. this edge is
  -- legal only because of the subgroup. §7a wants that labelled on screen ("a
  -- sub-supplier's delivery appears in the parent's list with a small trader label").
  (d.supplier_code IS DISTINCT FROM p.supplier_code)  AS is_subgroup_allocation,

  (a.deleted_at IS NOT NULL)                         AS is_deleted,
  a.deleted_at,
  a.deleted_by,

  a.row_version,
  a.created_at,
  a.created_by,
  a.updated_at,
  a.updated_by
FROM cenapro.rc_payment_allocation a
JOIN      cenapro.rc_payment  p  ON p.id   = a.payment_id
JOIN      cenapro.rc_delivery d  ON d.id   = a.delivery_id
LEFT JOIN cenapro.rc_supplier ps ON ps.code = p.supplier_code
LEFT JOIN cenapro.rc_supplier ds ON ds.code = d.supplier_code;

COMMENT ON VIEW cenapro.view_rc_payment_allocation IS
  'Cenapro RC allocation read model: each payment→receipt edge with its amount, plus both ends '
  'folded in (cheque no / payee / date, and the receipt''s date, truck and payable total) so neither '
  'the cheque-first nor the delivery-first door needs a second query. `is_subgroup_allocation` '
  'flags an edge that is legal only through the payee''s subgroup. SOFT-DELETED EDGES ARE INCLUDED '
  '— filter NOT is_deleted for anything numeric, and note that an edge whose PAYMENT is voided '
  '(payment_is_deleted) counts toward nothing either. ENTIRELY ₱-BEARING.';

REVOKE ALL ON cenapro.view_rc_payment_allocation FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_payment_allocation TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 7. READ MODEL — cenapro.view_rc_payment_state (the cash-advance list, for free)
-- ═════════════════════════════════════════════════════════════════════════════════
-- cenapro.view_rc_payment plus what has been assigned out of it. §4.4: a cash advance
-- needs no column, no flag and no separate table — it simply IS a payment whose
-- allocations sum to less than its amount, so Step 5's "list of payments carrying an
-- unallocated remainder" is `WHERE is_advance` and nothing else.
--
-- THE ONE DEFINITION of `unallocated_php`, and cenapro.view_rc_supplier_balance aggregates
-- THIS VIEW rather than re-deriving it — the same discipline that makes
-- view_rc_payment.balance_effect_php the one definition of a payment's signed effect.
--
-- Allocations of a SOFT-DELETED payment are still counted here (this row is history and
-- says so via is_deleted), but they settle NOTHING: view_rc_delivery_settlement joins live
-- payments only. That asymmetry is deliberate and is why is_advance folds in the
-- not-deleted test.
CREATE OR REPLACE VIEW cenapro.view_rc_payment_state
WITH (security_invoker = true)
AS
SELECT
  v.*,
  coalesce(al.allocated_php, 0)                                       AS allocated_php,
  trim_scale(v.amount_php - coalesce(al.allocated_php, 0))             AS unallocated_php,
  coalesce(al.allocation_count, 0)                                    AS allocation_count,
  (v.deleted_at IS NULL
   AND v.amount_php - coalesce(al.allocated_php, 0) > 0)              AS is_advance
FROM cenapro.view_rc_payment v
LEFT JOIN LATERAL (
  SELECT trim_scale(sum(a.amount_php)) AS allocated_php,
         (count(*))::integer           AS allocation_count
    FROM cenapro.rc_payment_allocation a
   WHERE a.payment_id  = v.id
     AND a.deleted_at IS NULL
) al ON true;

COMMENT ON VIEW cenapro.view_rc_payment_state IS
  'cenapro.view_rc_payment + how much of each payment has been assigned to receipts: '
  '`allocated_php`, `unallocated_php` (THE definition — the balance view reads it from here), '
  '`allocation_count` and `is_advance`. §4.4: A CASH ADVANCE IS AN ALLOCATION THAT DOES NOT EXIST '
  'YET — a payment whose allocations sum to less than its amount — so this view IS the cash-advance '
  'list and Step 5 needs no table, no column and no flag of its own. `is_advance` also requires the '
  'payment not to be voided, because a deleted cheque is not an outstanding advance. Soft-deleted '
  'payments are INCLUDED (filter NOT is_deleted for arithmetic) and their allocations settle '
  'nothing — cenapro.view_rc_delivery_settlement counts live payments only. ENTIRELY ₱-BEARING.';

REVOKE ALL ON cenapro.view_rc_payment_state FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_payment_state TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 8. READ MODEL — cenapro.view_rc_delivery_settlement (one row per receipt)
-- ═════════════════════════════════════════════════════════════════════════════════
-- Settlement state lives HERE and never on cenapro.rc_delivery: "the moment a `paid` flag
-- appears on the receipt, there are two truths about the same money." Strictly additive —
-- cenapro.view_rc_delivery is not touched.
--
-- TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT:
--
--  * `settlement_status` TESTS `unpriced` FIRST. total_price_php COALESCEs a missing weight
--    or price to exactly ₱0, so an unpriced receipt with no allocations satisfies
--    "allocated >= total" and would read `settled` under any naive ordering. That is the
--    whole §3.4 trap and it is invisible in pesos.
--  * `balance_php` IS NULL, NOT 0, ON AN UNPRICEABLE RECEIPT. The honest answer to "how
--    much is still owed on this" is *nobody knows yet*; a 0 there is a claim that nothing
--    is owed. The peso total of a SUM is the same either way — which is exactly why the
--    difference has to be visible in the column, where a screen renders it as "—".
--
-- Only LIVE allocations of LIVE payments count: a voided cheque settles nothing.
CREATE OR REPLACE VIEW cenapro.view_rc_delivery_settlement
WITH (security_invoker = true)
AS
SELECT
  d.id                                               AS delivery_id,
  d.supplier_code,
  s.display_name                                     AS supplier_display_name,
  g.group_code,
  g.group_display_name,
  d.delivery_date,
  d.truck_no,
  d.destination_code,
  d.net_weight_kg,
  d.total_price_php,

  -- THE ONE definition, never inlined or weakened.
  cenapro.rc_delivery_is_priceable(d.gross_weight_kg, d.base_price_php_kg) AS is_priceable,

  -- What the delivery-first door greys out (§7a): a receipt with no price yet has no
  -- known amount to settle, and a receipt with no payee has nobody to be paid for it.
  -- NOTE this is a UI affordance, not a refusal — the RPC deliberately still records an
  -- allocation to an unpriced receipt (header C).
  (d.supplier_code IS NOT NULL
   AND cenapro.rc_delivery_is_priceable(d.gross_weight_kg, d.base_price_php_kg))
                                                     AS is_allocatable,

  coalesce(al.allocated_php, 0)                      AS allocated_php,

  -- NULL when unpriceable. See the header of this section.
  CASE WHEN cenapro.rc_delivery_is_priceable(d.gross_weight_kg, d.base_price_php_kg)
       THEN trim_scale(d.total_price_php - coalesce(al.allocated_php, 0))
  END                                                AS balance_php,

  coalesce(al.allocation_count, 0)                   AS allocation_count,
  al.payment_ids,
  al.last_allocated_at,

  CASE
    WHEN NOT cenapro.rc_delivery_is_priceable(d.gross_weight_kg, d.base_price_php_kg)
      THEN 'unpriced'
    WHEN coalesce(al.allocated_php, 0) > d.total_price_php
      THEN 'over_allocated'
    WHEN coalesce(al.allocated_php, 0) = 0 AND d.total_price_php > 0
      THEN 'unpaid'
    WHEN coalesce(al.allocated_php, 0) >= d.total_price_php
      THEN 'settled'
    ELSE 'partial'
  END                                                AS settlement_status,

  d.row_version
FROM cenapro.rc_delivery d
LEFT JOIN cenapro.rc_supplier            s ON s.code = d.supplier_code
LEFT JOIN cenapro.view_rc_supplier_group g ON g.code = d.supplier_code
LEFT JOIN LATERAL (
  SELECT trim_scale(sum(a.amount_php))                                AS allocated_php,
         (count(*))::integer                                          AS allocation_count,
         array_agg(a.payment_id ORDER BY p.payment_date, p.id)        AS payment_ids,
         max(a.created_at)                                            AS last_allocated_at
    FROM cenapro.rc_payment_allocation a
    JOIN cenapro.rc_payment p ON p.id = a.payment_id
                            AND p.deleted_at IS NULL
   WHERE a.delivery_id  = d.id
     AND a.deleted_at  IS NULL
) al ON true;

COMMENT ON VIEW cenapro.view_rc_delivery_settlement IS
  'One row per Cenapro RC receipt: what it is worth, how much of it has been assigned from '
  'payments, what is still owed, and its settlement_status in {unpriced, unpaid, partial, settled, '
  'over_allocated}. SETTLEMENT LIVES HERE AND NEVER ON cenapro.rc_delivery — a `paid` flag on the '
  'receipt would be a second truth about the same money — and cenapro.view_rc_delivery is not '
  'touched. Counts LIVE allocations of LIVE payments only: a voided cheque settles nothing. '
  '`over_allocated` is a legal, recorded state (decision 13), never an error. ENTIRELY ₱-BEARING.';

COMMENT ON COLUMN cenapro.view_rc_delivery_settlement.settlement_status IS
  '`unpriced` IS TESTED FIRST AND DOES NOT COLLAPSE INTO `settled`. total_price_php COALESCEs a '
  'missing weight or price to exactly ₱0, so an unpriced receipt with no allocations satisfies '
  '"allocated >= total" and reads as fully settled under any naive ordering — the §3.4 trap, and it '
  'is invisible in pesos because the priceable-only sum and SUM(total_price_php) are identically '
  'equal on every supplier. `unpaid` = priced, worth something, nothing assigned. `partial` = some '
  'assigned. `settled` = assigned >= worth (a genuinely ₱0 priceable receipt is settled by '
  'definition). `over_allocated` = more assigned than it is worth, which is RECORDED, not refused.';
COMMENT ON COLUMN cenapro.view_rc_delivery_settlement.balance_php IS
  'What is still owed on this receipt: total_price_php - allocated_php. NULL — NOT 0 — when the '
  'receipt is not priceable, because the honest answer is *nobody knows yet* and a 0 would claim '
  'nothing is owed. A SUM produces the same peso figure either way, which is precisely why the '
  'difference has to be visible in the column. NEGATIVE when over-allocated, which is legal.';
COMMENT ON COLUMN cenapro.view_rc_delivery_settlement.is_allocatable IS
  'FALSE when the receipt has no supplier_code (nobody can be paid for it — '
  'rc_payment.supplier_code is NOT NULL) or no agreed price yet. §7a''s greying rule for the '
  'delivery-first door. It is a UI affordance, NOT a refusal: the allocate RPCs deliberately still '
  'record an allocation to an unpriced receipt, because "priced but not yet weighed" is a normal '
  'daily stage and a downpayment on a truck weighed tomorrow is an ordinary act. An allocation to a '
  'receipt with NO PAYEE is the one case that IS refused.';
COMMENT ON COLUMN cenapro.view_rc_delivery_settlement.payment_ids IS
  'The live payments assigned to this receipt, oldest first. NULL when there are none. Read the '
  'edges themselves through cenapro.view_rc_payment_allocation / '
  'public.cenapro_rc_payment_allocations.';

REVOKE ALL ON cenapro.view_rc_delivery_settlement FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_delivery_settlement TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 9. THE BALANCE GAINS `advance_php` — cenapro.view_rc_supplier_balance
-- ═════════════════════════════════════════════════════════════════════════════════
-- Step 3 deliberately OMITTED advance_php: with no allocations, every peso of every
-- payment is unallocated, so the column would have read 100% on every row and taught the
-- UI something false. It is computable now.
--
-- CREATE OR REPLACE, not DROP + CREATE: every pre-existing column keeps its name, type AND
-- POSITION and the new ones are appended in one block, which is what Postgres allows. That
-- is also why the public accessors below can simply be re-replaced — their `SELECT b.*`
-- re-expands over the widened list without losing a grant, a policy or a consumer.
--
-- FOUR THINGS THIS DOES NOT DO, ON PURPOSE:
--
--  * IT DOES NOT CHANGE `running_balance_php`. Allocation REFINES the picture of what a
--    payment was FOR; it does not change what is owed. opening + payments - receipts is
--    untouched, and every one of the 13 live rows is byte-identical after this migration.
--  * IT DOES NOT DISTURB THE AS-OF WINDOWING (20260805130000). The `is_carried` strict
--    boolean, the *_all_php twins and the carried_* columns are transcribed unchanged.
--  * `advance_php` IS ALL-TIME, NOT WINDOWED — the same deliberate asymmetry as
--    unpriced_receipt_count, and for the same reason: an unassigned remainder on a payment
--    from BEFORE the cutoff is still money nobody has pointed at a receipt. Windowing it
--    away would hide a live operational fact. `advance_php_window` is the windowed twin
--    for a screen that wants both; the all-time one is primary.
--  * `advance_php` IS NOT A BALANCE TERM. It is a subset of payments already counted in
--    payments_php, so adding it to anything double-counts.
--
-- The `p` CTE now aggregates cenapro.view_rc_payment_state instead of
-- cenapro.view_rc_payment: same rows, same values, plus unallocated_php read from its ONE
-- definition rather than re-derived here.
CREATE OR REPLACE VIEW cenapro.view_rc_supplier_balance
WITH (security_invoker = true)
AS
WITH ob AS (
  -- The current stated opening balance per supplier, read from its one definition.
  SELECT o.supplier_code, o.as_of_date, o.opening_balance_php, o.note,
         o.revision_id, o.set_at, o.revision_count
    FROM cenapro.view_rc_supplier_opening_balance o
),
r AS (
  SELECT
    x.supplier_code,

    -- ── FULL HISTORY — what this view reported before opening balances existed ────
    (count(*))::integer                                          AS receipt_count_all,
    trim_scale(coalesce(sum(x.total_price_php)
      FILTER (WHERE x.is_priceable), 0))                         AS receipts_all_php,

    -- ── WINDOWED (>= as_of_date; everything when there is no opening balance) ────
    (count(*) FILTER (WHERE NOT x.is_carried))::integer          AS receipt_count,
    trim_scale(coalesce(sum(x.total_price_php)
      FILTER (WHERE x.is_priceable AND NOT x.is_carried), 0))    AS receipts_php,

    -- ── CARRIED (< as_of_date) — what the opening balance stands in for ──────────
    (count(*) FILTER (WHERE x.is_carried))::integer              AS carried_receipt_count,
    trim_scale(coalesce(sum(x.total_price_php)
      FILTER (WHERE x.is_priceable AND x.is_carried), 0))        AS carried_receipt_php,

    -- ── THE HONESTY COLUMNS — ALL-TIME on purpose ────────────────────────────────
    (count(*) FILTER (WHERE NOT x.is_priceable))::integer        AS unpriced_receipt_count,
    trim_scale(coalesce(sum(x.net_weight_kg)
      FILTER (WHERE NOT x.is_priceable), 0))                     AS unpriced_receipt_kg,
    (count(*) FILTER (WHERE x.gross_weight_kg IS NULL
                        AND x.base_price_php_kg IS NOT NULL))::integer
                                                                 AS unpriced_awaiting_weight_count,
    (count(*) FILTER (WHERE x.gross_weight_kg IS NOT NULL
                        AND x.base_price_php_kg IS NULL))::integer
                                                                 AS unpriced_awaiting_price_count,
    (count(*) FILTER (WHERE x.gross_weight_kg IS NULL
                        AND x.base_price_php_kg IS NULL))::integer
                                                                 AS unpriced_awaiting_both_count,
    (count(*) FILTER (WHERE NOT x.is_priceable AND NOT x.is_carried))::integer
                                                                 AS unpriced_receipt_count_window,
    trim_scale(coalesce(sum(x.net_weight_kg)
      FILTER (WHERE NOT x.is_priceable AND NOT x.is_carried), 0)) AS unpriced_receipt_kg_window,

    min(x.delivery_date)                                         AS first_receipt_date,
    max(x.delivery_date)                                         AS last_receipt_date
  FROM (
    SELECT
      d.supplier_code,
      d.delivery_date,
      d.total_price_php,
      d.net_weight_kg,
      d.gross_weight_kg,
      d.base_price_php_kg,
      cenapro.rc_delivery_is_priceable(d.gross_weight_kg, d.base_price_php_kg) AS is_priceable,
      (ob.as_of_date IS NOT NULL
       AND d.delivery_date IS NOT NULL
       AND d.delivery_date < ob.as_of_date)                                    AS is_carried
    FROM cenapro.rc_delivery d
    LEFT JOIN ob ON ob.supplier_code = d.supplier_code
  ) x
  GROUP BY x.supplier_code
),
p AS (
  SELECT
    y.supplier_code,

    -- ── FULL HISTORY ─────────────────────────────────────────────────────────────
    (count(*))::integer                                          AS payment_count_all,
    trim_scale(coalesce(sum(y.balance_effect_php), 0))            AS payments_all_php,
    trim_scale(coalesce(sum(y.amount_php)
      FILTER (WHERE y.is_cash AND y.direction = 'outgoing'), 0))  AS cash_out_all_php,
    trim_scale(coalesce(sum(y.amount_php)
      FILTER (WHERE y.is_cash AND y.direction = 'incoming'), 0))  AS cash_in_all_php,
    trim_scale(coalesce(sum(y.balance_effect_php)
      FILTER (WHERE NOT y.is_cash), 0))                          AS adjustment_all_php,
    (count(*) FILTER (WHERE NOT y.is_cash))::integer             AS adjustment_count_all,

    -- ── WINDOWED (>= as_of_date) ─────────────────────────────────────────────────
    (count(*) FILTER (WHERE NOT y.is_carried))::integer          AS payment_count,
    trim_scale(coalesce(sum(y.balance_effect_php)
      FILTER (WHERE NOT y.is_carried), 0))                       AS payments_php,
    trim_scale(coalesce(sum(y.amount_php) FILTER (
      WHERE y.is_cash AND y.direction = 'outgoing' AND NOT y.is_carried), 0))
                                                                 AS cash_out_php,
    trim_scale(coalesce(sum(y.amount_php) FILTER (
      WHERE y.is_cash AND y.direction = 'incoming' AND NOT y.is_carried), 0))
                                                                 AS cash_in_php,
    trim_scale(coalesce(sum(y.balance_effect_php)
      FILTER (WHERE NOT y.is_cash AND NOT y.is_carried), 0))     AS adjustment_php,
    (count(*) FILTER (WHERE NOT y.is_cash AND NOT y.is_carried))::integer
                                                                 AS adjustment_count,

    -- ── CARRIED (< as_of_date) ───────────────────────────────────────────────────
    (count(*) FILTER (WHERE y.is_carried))::integer              AS carried_payment_count,
    trim_scale(coalesce(sum(y.balance_effect_php)
      FILTER (WHERE y.is_carried), 0))                           AS carried_payment_php,

    -- ── NEW (Step 4): THE OUTSTANDING ADVANCE — money paid, not yet pointed at a
    -- receipt. ALL-TIME on purpose (see this section's header), and NOT a balance term:
    -- it is a subset of payments already inside payments_php.
    trim_scale(coalesce(sum(y.unallocated_php)
      FILTER (WHERE y.direction = 'outgoing'), 0))               AS advance_php,
    (count(*) FILTER (WHERE y.direction = 'outgoing'
                        AND y.unallocated_php > 0))::integer     AS advance_payment_count,
    -- The 0.01% mirror: money that came BACK and has not been matched to a receipt.
    -- Separated rather than netted, so a careless reader cannot cancel the two, and
    -- present rather than filtered away so it can never vanish silently.
    trim_scale(coalesce(sum(y.unallocated_php)
      FILTER (WHERE y.direction = 'incoming'), 0))               AS unassigned_incoming_php,
    trim_scale(coalesce(sum(y.unallocated_php)
      FILTER (WHERE y.direction = 'outgoing' AND NOT y.is_carried), 0))
                                                                 AS advance_php_window,

    min(y.payment_date)                                          AS first_payment_date,
    max(y.payment_date)                                          AS last_payment_date
  FROM (
    SELECT
      v.supplier_code,
      v.payment_date,
      v.amount_php,
      v.balance_effect_php,
      v.is_cash,
      v.direction,
      -- Read from cenapro.view_rc_payment_state's ONE definition, never re-derived.
      v.unallocated_php,
      (ob.as_of_date IS NOT NULL AND v.payment_date < ob.as_of_date)           AS is_carried
    FROM cenapro.view_rc_payment_state v
    LEFT JOIN ob ON ob.supplier_code = v.supplier_code
    WHERE NOT v.is_deleted
  ) y
  GROUP BY y.supplier_code
)
SELECT
  -- ═══ the 53 columns this view had before allocation existed, in order ══════════
  g.code                                        AS supplier_code,
  g.display_name,
  g.active,
  g.sort_order,
  false                                         AS is_unassigned,

  g.parent_code,
  g.group_code,
  g.group_display_name,
  g.group_sort_order,
  g.is_parent,
  g.is_child,

  coalesce(r.receipt_count, 0)                  AS receipt_count,
  coalesce(r.receipts_php, 0)                   AS receipts_php,
  r.first_receipt_date,
  r.last_receipt_date,

  coalesce(r.unpriced_receipt_count, 0)         AS unpriced_receipt_count,
  coalesce(r.unpriced_receipt_kg, 0)            AS unpriced_receipt_kg,
  coalesce(r.unpriced_awaiting_weight_count, 0) AS unpriced_awaiting_weight_count,
  coalesce(r.unpriced_awaiting_price_count, 0)  AS unpriced_awaiting_price_count,
  coalesce(r.unpriced_awaiting_both_count, 0)   AS unpriced_awaiting_both_count,

  coalesce(p.payment_count, 0)                  AS payment_count,
  coalesce(p.payments_php, 0)                   AS payments_php,
  coalesce(p.cash_out_php, 0)                   AS cash_out_php,
  coalesce(p.cash_in_php, 0)                    AS cash_in_php,
  trim_scale(coalesce(p.cash_out_php, 0) - coalesce(p.cash_in_php, 0))
                                                AS cash_net_php,
  coalesce(p.adjustment_php, 0)                 AS adjustment_php,
  coalesce(p.adjustment_count, 0)               AS adjustment_count,
  p.first_payment_date,
  p.last_payment_date,

  trim_scale(coalesce(ob.opening_balance_php, 0)
             + coalesce(p.payments_php, 0)
             - coalesce(r.receipts_php, 0))     AS running_balance_php,

  coalesce(ob.opening_balance_php, 0)           AS opening_balance_php,
  ob.as_of_date                                 AS opening_as_of_date,
  (ob.supplier_code IS NOT NULL)                AS has_opening_balance,
  ob.note                                       AS opening_note,
  ob.set_at                                     AS opening_set_at,
  ob.revision_id                                AS opening_revision_id,
  coalesce(ob.revision_count, 0)                AS opening_revision_count,

  coalesce(r.carried_receipt_count, 0)          AS carried_receipt_count,
  coalesce(r.carried_receipt_php, 0)            AS carried_receipt_php,
  coalesce(p.carried_payment_count, 0)          AS carried_payment_count,
  coalesce(p.carried_payment_php, 0)            AS carried_payment_php,

  coalesce(r.receipt_count_all, 0)              AS receipt_count_all,
  coalesce(r.receipts_all_php, 0)               AS receipts_all_php,
  coalesce(p.payment_count_all, 0)              AS payment_count_all,
  coalesce(p.payments_all_php, 0)               AS payments_all_php,
  coalesce(p.cash_out_all_php, 0)               AS cash_out_all_php,
  coalesce(p.cash_in_all_php, 0)                AS cash_in_all_php,
  trim_scale(coalesce(p.cash_out_all_php, 0) - coalesce(p.cash_in_all_php, 0))
                                                AS cash_net_all_php,
  coalesce(p.adjustment_all_php, 0)             AS adjustment_all_php,
  coalesce(p.adjustment_count_all, 0)           AS adjustment_count_all,
  trim_scale(coalesce(p.payments_all_php, 0)
             - coalesce(r.receipts_all_php, 0)) AS running_balance_all_php,

  coalesce(r.unpriced_receipt_count_window, 0)  AS unpriced_receipt_count_window,
  coalesce(r.unpriced_receipt_kg_window, 0)     AS unpriced_receipt_kg_window,

  -- ═══ NEW (Step 4): the outstanding advance. NOT a balance term. ════════════════
  coalesce(p.advance_php, 0)                    AS advance_php,
  coalesce(p.advance_payment_count, 0)          AS advance_payment_count,
  coalesce(p.unassigned_incoming_php, 0)        AS unassigned_incoming_php,
  coalesce(p.advance_php_window, 0)             AS advance_php_window
FROM cenapro.view_rc_supplier_group g
LEFT JOIN r  ON r.supplier_code  = g.code
LEFT JOIN p  ON p.supplier_code  = g.code
LEFT JOIN ob ON ob.supplier_code = g.code

UNION ALL

-- The receipts with NO PAYEE. They cannot be liquidated (rc_payment.supplier_code is NOT
-- NULL, so no cheque can ever point at them and no allocation can ever exist for them),
-- and they must not silently vanish from every total either. Every Step-4 column here is
-- therefore the zero case, by construction rather than by omission. Emitted ONLY while
-- such receipts exist.
SELECT
  NULL::text                                    AS supplier_code,
  '(no payee recorded)'::text                   AS display_name,
  true                                          AS active,
  2147483647                                    AS sort_order,
  true                                          AS is_unassigned,

  NULL::text                                    AS parent_code,
  NULL::text                                    AS group_code,
  '(no payee recorded)'::text                   AS group_display_name,
  2147483647                                    AS group_sort_order,
  false                                         AS is_parent,
  false                                         AS is_child,

  r.receipt_count,
  r.receipts_php,
  r.first_receipt_date,
  r.last_receipt_date,

  r.unpriced_receipt_count,
  r.unpriced_receipt_kg,
  r.unpriced_awaiting_weight_count,
  r.unpriced_awaiting_price_count,
  r.unpriced_awaiting_both_count,

  0                                             AS payment_count,
  0::numeric                                    AS payments_php,
  0::numeric                                    AS cash_out_php,
  0::numeric                                    AS cash_in_php,
  0::numeric                                    AS cash_net_php,
  0::numeric                                    AS adjustment_php,
  0                                             AS adjustment_count,
  NULL::date                                    AS first_payment_date,
  NULL::date                                    AS last_payment_date,

  trim_scale(-r.receipts_php)                   AS running_balance_php,

  0::numeric                                    AS opening_balance_php,
  NULL::date                                    AS opening_as_of_date,
  false                                         AS has_opening_balance,
  NULL::text                                    AS opening_note,
  NULL::timestamptz                             AS opening_set_at,
  NULL::bigint                                  AS opening_revision_id,
  0                                             AS opening_revision_count,

  0                                             AS carried_receipt_count,
  0::numeric                                    AS carried_receipt_php,
  0                                             AS carried_payment_count,
  0::numeric                                    AS carried_payment_php,

  r.receipt_count_all,
  r.receipts_all_php,
  0                                             AS payment_count_all,
  0::numeric                                    AS payments_all_php,
  0::numeric                                    AS cash_out_all_php,
  0::numeric                                    AS cash_in_all_php,
  0::numeric                                    AS cash_net_all_php,
  0::numeric                                    AS adjustment_all_php,
  0                                             AS adjustment_count_all,
  trim_scale(-r.receipts_all_php)               AS running_balance_all_php,

  r.unpriced_receipt_count_window,
  r.unpriced_receipt_kg_window,

  0::numeric                                    AS advance_php,
  0                                             AS advance_payment_count,
  0::numeric                                    AS unassigned_incoming_php,
  0::numeric                                    AS advance_php_window
FROM r
WHERE r.supplier_code IS NULL;

COMMENT ON COLUMN cenapro.view_rc_supplier_balance.advance_php IS
  'MONEY CI HAS PAID THAT IS NOT YET POINTED AT ANY RECEIPT — the outstanding advance, summed from '
  'cenapro.view_rc_payment_state.unallocated_php over this supplier''s LIVE OUTGOING payments. §4.4: '
  'a cash advance needs no column of its own on the payment, no flag and no table; it simply IS the '
  'unallocated remainder. **NOT A BALANCE TERM** — every peso here is already inside payments_php, '
  'so adding it to anything double-counts. ALL-TIME, NOT WINDOWED, the same deliberate asymmetry as '
  'unpriced_receipt_count: an unassigned remainder on a payment from before opening_as_of_date is '
  'still money nobody has pointed at a receipt, and windowing it away would hide a live fact. '
  'advance_php_window is the windowed twin; this one is primary. Incoming payments are excluded — '
  'see unassigned_incoming_php.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.advance_payment_count IS
  'How many LIVE OUTGOING payments carry an unassigned remainder — the length of the cash-advance '
  'list for this trader (cenapro.view_rc_payment_state WHERE is_advance).';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.unassigned_incoming_php IS
  'The 0.01% mirror of advance_php: money that came BACK from this trader (a refund or a returned '
  'overpayment) and has not been matched to a receipt. Kept SEPARATE rather than netted into '
  'advance_php so a careless reader cannot cancel two opposite facts, and kept PRESENT rather than '
  'filtered out so it can never vanish silently. Normally 0.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.advance_php_window IS
  'The windowed twin of advance_php — unassigned remainders on outgoing payments dated ON OR AFTER '
  'opening_as_of_date only. Equal to advance_php when there is no opening balance. The all-time one '
  'is the PRIMARY figure; see its COMMENT for why.';

REVOKE ALL ON cenapro.view_rc_supplier_balance FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_supplier_balance TO authenticated, service_role;


-- ── The group rollup, widened the same way ───────────────────────────────────────
-- Still built ON TOP of the per-supplier view so the two levels can never disagree. Every
-- new measure is linear, so summing the member rows is exactly summing the underlying
-- facts — and the documented invariant survives untouched: THE GROUP TOTAL EQUALS THE SUM
-- OF ITS MEMBERS' running_balance_php, EXACTLY.
CREATE OR REPLACE VIEW cenapro.view_rc_supplier_group_balance
WITH (security_invoker = true)
AS
SELECT
  -- ═══ the 49 columns this view had before allocation existed, in order ══════════
  b.group_code,
  min(b.group_display_name)                     AS group_display_name,
  min(b.group_sort_order)                       AS group_sort_order,
  b.is_unassigned,

  (count(*))::integer                           AS supplier_count,
  (count(*) FILTER (WHERE b.is_child))::integer AS child_count,
  array_agg(b.supplier_code ORDER BY b.sort_order, b.supplier_code)
    FILTER (WHERE b.supplier_code IS NOT NULL)  AS supplier_codes,
  bool_or(b.active)                             AS any_active,

  sum(b.receipt_count)                          AS receipt_count,
  trim_scale(sum(b.receipts_php))               AS receipts_php,
  min(b.first_receipt_date)                     AS first_receipt_date,
  max(b.last_receipt_date)                      AS last_receipt_date,

  sum(b.unpriced_receipt_count)                 AS unpriced_receipt_count,
  trim_scale(sum(b.unpriced_receipt_kg))        AS unpriced_receipt_kg,
  sum(b.unpriced_awaiting_weight_count)         AS unpriced_awaiting_weight_count,
  sum(b.unpriced_awaiting_price_count)          AS unpriced_awaiting_price_count,
  sum(b.unpriced_awaiting_both_count)           AS unpriced_awaiting_both_count,

  sum(b.payment_count)                          AS payment_count,
  trim_scale(sum(b.payments_php))               AS payments_php,
  trim_scale(sum(b.cash_out_php))               AS cash_out_php,
  trim_scale(sum(b.cash_in_php))                AS cash_in_php,
  trim_scale(sum(b.cash_net_php))               AS cash_net_php,
  trim_scale(sum(b.adjustment_php))             AS adjustment_php,
  sum(b.adjustment_count)                       AS adjustment_count,
  min(b.first_payment_date)                     AS first_payment_date,
  max(b.last_payment_date)                      AS last_payment_date,

  trim_scale(sum(b.running_balance_php))        AS running_balance_php,

  trim_scale(sum(b.opening_balance_php))        AS opening_balance_php,
  bool_or(b.has_opening_balance)                AS has_opening_balance,
  (count(*) FILTER (WHERE b.has_opening_balance))::integer
                                                AS opening_supplier_count,
  CASE WHEN min(b.opening_as_of_date) = max(b.opening_as_of_date)
       THEN min(b.opening_as_of_date) END       AS opening_as_of_date,
  min(b.opening_as_of_date)                     AS opening_as_of_date_min,
  max(b.opening_as_of_date)                     AS opening_as_of_date_max,

  sum(b.carried_receipt_count)                  AS carried_receipt_count,
  trim_scale(sum(b.carried_receipt_php))        AS carried_receipt_php,
  sum(b.carried_payment_count)                  AS carried_payment_count,
  trim_scale(sum(b.carried_payment_php))        AS carried_payment_php,

  sum(b.receipt_count_all)                      AS receipt_count_all,
  trim_scale(sum(b.receipts_all_php))           AS receipts_all_php,
  sum(b.payment_count_all)                      AS payment_count_all,
  trim_scale(sum(b.payments_all_php))           AS payments_all_php,
  trim_scale(sum(b.cash_out_all_php))           AS cash_out_all_php,
  trim_scale(sum(b.cash_in_all_php))            AS cash_in_all_php,
  trim_scale(sum(b.cash_net_all_php))           AS cash_net_all_php,
  trim_scale(sum(b.adjustment_all_php))         AS adjustment_all_php,
  sum(b.adjustment_count_all)                   AS adjustment_count_all,
  trim_scale(sum(b.running_balance_all_php))    AS running_balance_all_php,

  sum(b.unpriced_receipt_count_window)          AS unpriced_receipt_count_window,
  trim_scale(sum(b.unpriced_receipt_kg_window)) AS unpriced_receipt_kg_window,

  -- ═══ NEW (Step 4): the group's outstanding advance ═════════════════════════════
  trim_scale(sum(b.advance_php))                AS advance_php,
  sum(b.advance_payment_count)                  AS advance_payment_count,
  trim_scale(sum(b.unassigned_incoming_php))    AS unassigned_incoming_php,
  trim_scale(sum(b.advance_php_window))         AS advance_php_window
FROM cenapro.view_rc_supplier_balance b
GROUP BY b.group_code, b.is_unassigned;

COMMENT ON COLUMN cenapro.view_rc_supplier_group_balance.advance_php IS
  'The GROUP''s outstanding advance — money paid to any member of the payee group that is not yet '
  'pointed at a receipt. Sum of the members'' advance_php (linear). NOT a balance term: it is '
  'already inside payments_php. All-time, not windowed — see the per-supplier column''s COMMENT.';

REVOKE ALL ON cenapro.view_rc_supplier_group_balance FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_supplier_group_balance TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 10. PUBLIC ACCESSORS — `cenapro` is not exposed to PostgREST
-- ═════════════════════════════════════════════════════════════════════════════════
-- ALL READ-ONLY, like every liquidation accessor: the RPCs in section 11 are the only
-- write door, which also means a future REST importer cannot exist without someone
-- noticing.
CREATE OR REPLACE VIEW public.cenapro_rc_payment_allocations
WITH (security_invoker = true) AS
SELECT a.* FROM cenapro.view_rc_payment_allocation a;

COMMENT ON VIEW public.cenapro_rc_payment_allocations IS
  'Public READ-ONLY accessor for cenapro.view_rc_payment_allocation — every payment→receipt edge '
  'with both ends folded in. Soft-deleted edges are INCLUDED (filter NOT is_deleted), and so are '
  'edges whose payment is voided (payment_is_deleted) — neither settles anything. Write through '
  'public.cenapro_save_rc_payment_allocations() / cenapro_allocate_delivery_to_payment() / '
  'cenapro_restore_rc_payment_allocation(). ENTIRELY ₱-BEARING: gate every server action on '
  'canViewPrices().';

CREATE OR REPLACE VIEW public.cenapro_rc_delivery_settlement
WITH (security_invoker = true) AS
SELECT s.* FROM cenapro.view_rc_delivery_settlement s;

COMMENT ON VIEW public.cenapro_rc_delivery_settlement IS
  'Public READ-ONLY accessor for cenapro.view_rc_delivery_settlement — one row per receipt with '
  'allocated_php, balance_php and settlement_status in {unpriced, unpaid, partial, settled, '
  'over_allocated}. `unpriced` NEVER collapses into `settled`, and balance_php is NULL (not 0) on an '
  'unpriceable receipt. This is where the deliveries ledger reads a receipt''s payment state from — '
  'cenapro.rc_delivery carries no `paid` flag and never will. ENTIRELY ₱-BEARING.';

CREATE OR REPLACE VIEW public.cenapro_rc_payment_state
WITH (security_invoker = true) AS
SELECT v.* FROM cenapro.view_rc_payment_state v;

COMMENT ON VIEW public.cenapro_rc_payment_state IS
  'Public READ-ONLY accessor for cenapro.view_rc_payment_state — every payment plus allocated_php / '
  'unallocated_php / allocation_count / is_advance. `WHERE is_advance` IS the cash-advance list '
  '(Step 5 needs no new object). ENTIRELY ₱-BEARING.';

-- The audit accessor is WIDENED: its column list is explicit, so the three new columns are
-- APPENDED (a CREATE OR REPLACE VIEW may only add columns at the end, keeping every
-- existing one at its name, type and position). `entity` therefore reads last rather than
-- second — an ordering imposed by Postgres, not a preference.
CREATE OR REPLACE VIEW public.cenapro_rc_payment_audit
WITH (security_invoker = true) AS
SELECT a.id, a.payment_id, a.supplier_code, a.payment_date, a.method, a.amount_php,
       a.cheque_no, a.operation, a.changed, a.snapshot, a.source,
       a.changed_at, a.changed_by, a.changed_by_role,
       a.entity, a.allocation_id, a.delivery_id
  FROM cenapro.rc_payment_audit a;

COMMENT ON VIEW public.cenapro_rc_payment_audit IS
  'Read-only window onto cenapro.rc_payment_audit — ONE cheque''s whole history in ONE indexed '
  'query: filter by payment_id and you get the payment''s own INSERT/UPDATE/DELETE rows AND every '
  'allocation ever made, changed or released against it, discriminated by `entity` '
  '(payment | allocation). `changed ? ''deleted_at''` finds voids, releases and restores; '
  'delivery_id says which receipt an allocation pointed at, so the trail stays readable after the '
  'receipt is deleted. READ `entity` BEFORE READING `amount_php`: on a payment row it is the '
  'cheque''s amount, on an allocation row the edge''s. NOTE the ₱ trap (§3.2): `changed` and '
  '`snapshot` are free-form jsonb carrying money, and stripPrices() nulls named fields on a row '
  'shape — it can never reach inside a blob. Any action exposing this must delete the ₱ keys OUT OF '
  'THE JSONB when !canViewPrices().';

-- The two balance accessors are `SELECT b.*`, so re-issuing them re-expands over the
-- widened views while keeping their name, their grants and every consumer.
CREATE OR REPLACE VIEW public.cenapro_rc_supplier_balances
WITH (security_invoker = true) AS
SELECT b.* FROM cenapro.view_rc_supplier_balance b;

CREATE OR REPLACE VIEW public.cenapro_rc_supplier_group_balances
WITH (security_invoker = true) AS
SELECT b.* FROM cenapro.view_rc_supplier_group_balance b;

REVOKE ALL ON public.cenapro_rc_payment_allocations      FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_delivery_settlement      FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_payment_state            FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_payment_audit            FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_supplier_balances        FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_supplier_group_balances  FROM anon, authenticated, service_role;

GRANT SELECT ON public.cenapro_rc_payment_allocations     TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_delivery_settlement     TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_payment_state           TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_payment_audit           TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_supplier_balances       TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_supplier_group_balances TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 11. THE WRITE PATH
-- ═════════════════════════════════════════════════════════════════════════════════
-- All: SECURITY INVOKER, `SET search_path = ''` with everything schema-qualified, EXECUTE
-- revoked from PUBLIC and anon then granted to authenticated + service_role. Same outcome
-- vocabulary as the rest of the module so a caller learns one language:
--     saved | restored | version_conflict | not_found | unsupported_field | invalid
-- EVERY refusal carries a human-readable `message` — these land straight in a toast.

-- ── 11a. Replace one payment's WHOLE live allocation block ────────────────────────
-- cenapro_save_rc_delivery_samples note for note, and exactly what "apply this cheque
-- across four receipts" has to be: ONE ATOMIC CALL, NO HALF-APPLIED CHEQUE.
--
-- THE PARENT UPDATE COMES FIRST, so the payment is row-locked and its compare-and-set has
-- already fired before a single child row moves. Edges absent from p_allocations are
-- SOFT-deleted, never hard-deleted (§5c).
--
-- THE WRITE IS TWO STATEMENTS, IN THIS ORDER, AND THE ORDER IS LOAD-BEARING: the
-- soft-delete can only LOWER the assigned total, and the upsert is a SINGLE statement whose
-- AFTER-ROW constraint trigger therefore fires once against the FINAL state. Spread across
-- several statements, a legal rearrangement (move ₱200k from receipt A to receipt B) would
-- trip the invariant halfway through depending on which row was written first.
CREATE OR REPLACE FUNCTION public.cenapro_save_rc_payment_allocations(
  p_payment_id           uuid,
  p_expected_row_version integer DEFAULT NULL,
  p_allocations          jsonb   DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  c_allowed constant text[] := ARRAY['delivery_id', 'amount_php', 'note'];
  v_bad         text[];
  v_pay         cenapro.rc_payment;
  v_group       text;
  v_group_name  text;
  v_payee_name  text;
  v_n           integer;
  v_distinct    integer;
  v_total       numeric;
  v_existing    integer;
  v_touched     integer;
  v_removed     integer;
  v_inserted    integer;
  v_updated     integer;
  v_id          uuid;
  v_version     integer;
  v_current     integer;
  v_label       text;
  v_other       text;
  v_amount      numeric;
  v_allocated   numeric;
  v_unallocated numeric;
  v_count       integer;
BEGIN
  IF p_payment_id IS NULL OR p_expected_row_version IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Both p_payment_id and p_expected_row_version are required - a blind write is '
                 || 'refused.');
  END IF;

  IF p_allocations IS NULL OR pg_catalog.jsonb_typeof(p_allocations) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'p_allocations must be a JSON array (pass [] to un-assign this payment '
                 || 'completely).');
  END IF;

  IF pg_catalog.jsonb_typeof(p_allocations) = 'array'
     AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_allocations) AS e
                  WHERE pg_catalog.jsonb_typeof(e) <> 'object') THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Every line in p_allocations must be an object like '
                 || '{"delivery_id": "...", "amount_php": 100000}.');
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT k)
    INTO v_bad
    FROM pg_catalog.jsonb_array_elements(p_allocations) AS e,
         pg_catalog.jsonb_object_keys(e) AS k
   WHERE k <> ALL (c_allowed);

  IF v_bad IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'unsupported_field', 'fields', pg_catalog.to_jsonb(v_bad),
      'message', 'Refused: ' || pg_catalog.array_to_string(v_bad, ', ')
                 || ' is not part of an allocation. Each line takes only: '
                 || pg_catalog.array_to_string(c_allowed, ', ') || '.');
  END IF;

  -- ── the payment ────────────────────────────────────────────────────────────────
  SELECT * INTO v_pay FROM cenapro.rc_payment x WHERE x.id = p_payment_id;
  IF v_pay.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found',
      'message', 'That payment no longer exists. Reload the payment list.');
  END IF;

  IF v_pay.deleted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format(
        'That payment was deleted on %s, so nothing can be assigned from it. Restore it first.',
        pg_catalog.to_char(v_pay.deleted_at, 'YYYY-MM-DD HH24:MI')));
  END IF;

  -- The payee's GROUP, from its ONE definition. This is what decides legality, and the
  -- same value the touch trigger stamps onto each edge.
  SELECT g.group_code, g.group_display_name, coalesce(s.display_name, g.code)
    INTO v_group, v_group_name, v_payee_name
    FROM cenapro.view_rc_supplier_group g
    LEFT JOIN cenapro.rc_supplier s ON s.code = g.code
   WHERE g.code = v_pay.supplier_code;

  -- ── the payload: cast once, so every later query is safe ───────────────────────
  BEGIN
    SELECT count(*)::integer,
           count(DISTINCT r.delivery_id)::integer,
           trim_scale(coalesce(sum(r.amount_php), 0))
      INTO v_n, v_distinct, v_total
      FROM pg_catalog.jsonb_to_recordset(p_allocations)
             AS r(delivery_id uuid, amount_php numeric, note text);
  EXCEPTION
    WHEN invalid_text_representation OR invalid_datetime_format OR numeric_value_out_of_range THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'One of the allocation lines is not readable: delivery_id must be a receipt id '
                   || 'and amount_php a number. ' || SQLERRM);
  END;

  IF v_n <> v_distinct THEN
    SELECT coalesce(pg_catalog.to_char(d.delivery_date, 'YYYY-MM-DD'), 'undated')
           || ' receipt (truck ' || coalesce(d.truck_no, '?') || ')'
      INTO v_label
      FROM pg_catalog.jsonb_to_recordset(p_allocations)
             AS r(delivery_id uuid, amount_php numeric, note text)
      JOIN cenapro.rc_delivery d ON d.id = r.delivery_id
     GROUP BY d.id, d.delivery_date, d.truck_no
    HAVING count(*) > 1
     LIMIT 1;

    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format(
        'The %s appears more than once in this cheque''s allocations. Two partial payments from the '
        || 'SAME cheque to the SAME receipt is one larger amount, not two lines - add them '
        || 'together.', coalesce(v_label, 'same receipt')));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(p_allocations)
                        AS r(delivery_id uuid, amount_php numeric, note text)
              WHERE r.delivery_id IS NULL) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Every allocation line has to name the receipt it settles (delivery_id).');
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(p_allocations)
                        AS r(delivery_id uuid, amount_php numeric, note text)
              WHERE r.amount_php IS NULL
                 OR r.amount_php = 'NaN'::numeric
                 OR r.amount_php = 'Infinity'::numeric
                 OR r.amount_php = '-Infinity'::numeric) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Every allocation line needs an ordinary peso amount. Leave a receipt OUT of the '
                 || 'list instead of assigning it nothing.');
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(p_allocations)
                        AS r(delivery_id uuid, amount_php numeric, note text)
              WHERE r.amount_php <= 0) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'An assigned amount must be greater than zero. To take money back off a receipt, '
                 || 'leave it out of the list - that releases it to the cheque''s unassigned pool.');
  END IF;

  -- Unknown receipt.
  SELECT r.delivery_id::text INTO v_label
    FROM pg_catalog.jsonb_to_recordset(p_allocations)
           AS r(delivery_id uuid, amount_php numeric, note text)
   WHERE NOT EXISTS (SELECT 1 FROM cenapro.rc_delivery d WHERE d.id = r.delivery_id)
   LIMIT 1;

  IF v_label IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid', 'delivery_id', v_label,
      'message', 'One of those receipts no longer exists - it may have been deleted while you were '
                 || 'working. Reload the receipt list.');
  END IF;

  -- A receipt with NO PAYEE can never be liquidated (§6: the screen should say so, not
  -- guess). rc_payment.supplier_code is NOT NULL, so no cheque can legitimately point at it.
  SELECT coalesce(pg_catalog.to_char(d.delivery_date, 'YYYY-MM-DD'), 'undated')
         || ' receipt (truck ' || coalesce(d.truck_no, '?') || ')'
    INTO v_label
    FROM pg_catalog.jsonb_to_recordset(p_allocations)
           AS r(delivery_id uuid, amount_php numeric, note text)
    JOIN cenapro.rc_delivery d ON d.id = r.delivery_id
   WHERE d.supplier_code IS NULL
   LIMIT 1;

  IF v_label IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format(
        'The %s has no supplier recorded, so there is nobody it can be paid to and no cheque can '
        || 'settle it. Set its supplier first.', v_label));
  END IF;

  -- SUB-SUPPLIER LEGALITY: the payee IS the receipt's trader, or they share a group.
  SELECT coalesce(pg_catalog.to_char(d.delivery_date, 'YYYY-MM-DD'), 'undated')
         || ' receipt (truck ' || coalesce(d.truck_no, '?') || ')',
         coalesce(ds.display_name, d.supplier_code)
    INTO v_label, v_other
    FROM pg_catalog.jsonb_to_recordset(p_allocations)
           AS r(delivery_id uuid, amount_php numeric, note text)
    JOIN cenapro.rc_delivery d ON d.id = r.delivery_id
    LEFT JOIN cenapro.view_rc_supplier_group dg ON dg.code = d.supplier_code
    LEFT JOIN cenapro.rc_supplier ds ON ds.code = d.supplier_code
   WHERE dg.group_code IS DISTINCT FROM v_group
   LIMIT 1;

  IF v_label IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format(
        'This payment is made out to %s, but the %s belongs to %s, which is not in %s''s group. '
        || 'Either make %s a sub-supplier of %s, or pay that receipt with a payment made out to %s.',
        v_payee_name, v_label, v_other, v_group_name, v_other, v_group_name, v_other));
  END IF;

  -- THE ENFORCED INVARIANT, as a friendly refusal. The constraint trigger guarantees it
  -- against any path; this is what an operator actually reads.
  IF v_total > v_pay.amount_php THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'requested_php', v_total, 'amount_php', v_pay.amount_php,
      'over_by_php', trim_scale(v_total - v_pay.amount_php),
      'message', pg_catalog.format(
        'That assigns %s across %s receipt(s), but this payment is only worth %s - over by %s. '
        || 'Lower one of the amounts, or raise the payment first.',
        pg_catalog.to_char(v_total, 'FM999,999,999,990.00'), v_n::text,
        pg_catalog.to_char(v_pay.amount_php, 'FM999,999,999,990.00'),
        pg_catalog.to_char(v_total - v_pay.amount_php, 'FM999,999,999,990.00')));
  END IF;

  -- ── THE GATE: parent first, so it row-locks before any child row moves ─────────
  UPDATE cenapro.rc_payment AS t
     SET updated_by = coalesce(auth.uid(), t.updated_by)
   WHERE t.id          = p_payment_id
     AND t.row_version = p_expected_row_version
     AND t.deleted_at IS NULL
  RETURNING t.id, t.row_version INTO v_id, v_version;

  IF v_id IS NULL THEN
    SELECT x.row_version INTO v_current FROM cenapro.rc_payment x WHERE x.id = p_payment_id;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found', 'message', 'That payment no longer exists.');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this payment while you were spreading it. Reload to see '
                 || 'their values before saving.');
  END IF;

  -- How many of the requested pairs already exist LIVE, measured before the upsert so
  -- inserted / updated can be reported exactly.
  SELECT count(*)::integer INTO v_existing
    FROM cenapro.rc_payment_allocation a
   WHERE a.payment_id  = p_payment_id
     AND a.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(p_allocations)
                             AS r(delivery_id uuid, amount_php numeric, note text)
                  WHERE r.delivery_id = a.delivery_id);

  BEGIN
    -- (1) Release what the new block no longer mentions. SOFT (§5c) - reversible, and it
    -- can only LOWER the assigned total, so no intermediate state can overshoot.
    UPDATE cenapro.rc_payment_allocation AS t
       SET deleted_at = now(),
           deleted_by = auth.uid()
     WHERE t.payment_id  = p_payment_id
       AND t.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(p_allocations)
                                   AS r(delivery_id uuid, amount_php numeric, note text)
                        WHERE r.delivery_id = t.delivery_id);
    GET DIAGNOSTICS v_removed = ROW_COUNT;

    -- (2) The whole new block in ONE statement, so the constraint trigger sees the FINAL
    -- state exactly once. The DO UPDATE ... WHERE skips lines that did not move, so a
    -- re-save churns no row_version and writes no audit row. A soft-deleted row for the
    -- same pair does not conflict (the unique index is partial), which is what lets a
    -- released edge be re-created.
    INSERT INTO cenapro.rc_payment_allocation AS t
      (payment_id, delivery_id, amount_php, note)
    SELECT p_payment_id, r.delivery_id, r.amount_php, r.note
      FROM pg_catalog.jsonb_to_recordset(p_allocations)
             AS r(delivery_id uuid, amount_php numeric, note text)
    ON CONFLICT (payment_id, delivery_id) WHERE deleted_at IS NULL
    DO UPDATE
       SET amount_php = EXCLUDED.amount_php,
           note       = EXCLUDED.note
     WHERE t.amount_php IS DISTINCT FROM trim_scale(EXCLUDED.amount_php)
        OR t.note       IS DISTINCT FROM nullif(btrim(EXCLUDED.note), '');
    GET DIAGNOSTICS v_touched = ROW_COUNT;
  EXCEPTION
    -- The constraint trigger, or the pair-immutability guard. Both raise 23514 with a
    -- message written to be read by a person.
    WHEN check_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid', 'message', SQLERRM);
    WHEN foreign_key_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'A receipt or the payment named in this block no longer exists. Reload and try '
                   || 'again.');
  END;

  v_inserted := v_n - v_existing;
  v_updated  := greatest(v_touched - v_inserted, 0);

  SELECT (count(*))::integer, trim_scale(coalesce(sum(a.amount_php), 0))
    INTO v_count, v_allocated
    FROM cenapro.rc_payment_allocation a
   WHERE a.payment_id  = p_payment_id
     AND a.deleted_at IS NULL;

  v_amount      := v_pay.amount_php;
  v_unallocated := trim_scale(v_amount - v_allocated);

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'saved',
    'payment_id', p_payment_id,
    'row_version', v_version,
    'allocation_count', v_count,
    'inserted', v_inserted,
    'updated', v_updated,
    'unchanged', v_n - v_inserted - v_updated,
    'released', v_removed,
    'allocated_php', v_allocated,
    'unallocated_php', v_unallocated,
    'message', CASE
      WHEN v_count = 0 THEN
        pg_catalog.format('Nothing is assigned from this payment now - all %s of it is unassigned.',
                          pg_catalog.to_char(v_amount, 'FM999,999,999,990.00'))
      WHEN v_unallocated = 0 THEN
        pg_catalog.format('Assigned %s across %s receipt(s). This payment is now fully assigned.',
                          pg_catalog.to_char(v_allocated, 'FM999,999,999,990.00'), v_count::text)
      ELSE
        pg_catalog.format('Assigned %s across %s receipt(s). %s of this payment is still '
                          || 'unassigned.',
                          pg_catalog.to_char(v_allocated, 'FM999,999,999,990.00'), v_count::text,
                          pg_catalog.to_char(v_unallocated, 'FM999,999,999,990.00'))
    END);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_save_rc_payment_allocations(uuid, integer, jsonb) IS
  'Replace ONE payment''s WHOLE live allocation block in a single atomic call — "apply this cheque '
  'across four receipts" with no half-applied cheque. Gated on the PARENT PAYMENT''s row_version, '
  'compare-and-set in the same statement as the parent bump, which also row-locks it before any '
  'child row moves. Each line takes delivery_id, amount_php, note; an unknown key refuses the whole '
  'call. Pass [] to un-assign the payment completely. Edges absent from p_allocations are '
  'SOFT-deleted (reversible), never hard-deleted. REFUSES, each with a toast-ready message: a blind '
  'write, a deleted payment, a duplicated receipt, a missing/zero/non-finite amount, an unknown '
  'receipt, a receipt with NO PAYEE, a receipt whose trader is outside the payee''s subgroup (naming '
  'both traders), and a block whose total exceeds the payment. DOES NOT refuse: an allocation to an '
  'UNPRICED receipt (a downpayment on a truck weighed tomorrow is ordinary), an amount with more '
  'than 2 decimal places (receipts price to sub-centavo fractions), or a receipt ending up '
  'OVER-allocated (decision 13 — recorded, not refused). Outcomes: saved | version_conflict | '
  'not_found | unsupported_field | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_save_rc_payment_allocations(uuid, integer, jsonb)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_save_rc_payment_allocations(uuid, integer, jsonb)
  TO authenticated, service_role;


-- ── 11b. THE DELIVERY-FIRST DOOR — assign ONE receipt to a payment ────────────────
-- Renzo: "right click on a delivery and then assign a cheque to it". §7a: both doors
-- create the same rows, so the write path, the RPC and the validation are built ONCE.
-- This function therefore does NOT re-implement a single check: it merges its one edge
-- into the payment's current live block and delegates to 11a, which is the only place
-- allocations are ever written and the only place legality lives.
--
-- IT SETS, IT DOES NOT ADD. Calling it twice with ₱300,000 leaves ₱300,000 assigned, not
-- ₱600,000 — the block RPC underneath is a replace, and an "add" would make the same call
-- twice mean two different things. The previous amount comes back in the response so a UI
-- can say "was ₱400,000, now ₱300,000".
--
-- p_amount_php NULL means "as much as is needed and as much as is available":
-- LEAST(what is still owed on the receipt, what is still unassigned on the payment),
-- computed in SQL because that is where money arithmetic belongs. It refuses when the
-- receipt has no price yet (there is no "still owed" to fill) and when nothing is left.
CREATE OR REPLACE FUNCTION public.cenapro_allocate_delivery_to_payment(
  p_payment_id           uuid,
  p_expected_row_version integer DEFAULT NULL,
  p_delivery_id          uuid    DEFAULT NULL,
  p_amount_php           numeric DEFAULT NULL,
  p_note                 text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_prev     numeric;
  v_prev_note text;
  v_free     numeric;
  v_owed     numeric;
  v_amount   numeric;
  v_label    text;
  v_priceable boolean;
  v_rows     jsonb;
  v_res      jsonb;
BEGIN
  IF p_payment_id IS NULL OR p_expected_row_version IS NULL OR p_delivery_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'p_payment_id, p_expected_row_version and p_delivery_id are all required - a '
                 || 'blind write is refused.');
  END IF;

  -- The edge as it stands, if it stands at all.
  SELECT a.amount_php, a.note
    INTO v_prev, v_prev_note
    FROM cenapro.rc_payment_allocation a
   WHERE a.payment_id  = p_payment_id
     AND a.delivery_id = p_delivery_id
     AND a.deleted_at IS NULL;

  v_amount := p_amount_php;

  IF v_amount IS NULL THEN
    -- What the payment has left, ignoring this edge (it is about to be re-set).
    SELECT trim_scale(v.unallocated_php + coalesce(v_prev, 0))
      INTO v_free
      FROM cenapro.view_rc_payment_state v
     WHERE v.id = p_payment_id
       AND NOT v.is_deleted;

    IF v_free IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found',
        'message', 'That payment no longer exists, or it has been deleted. Reload the payment '
                   || 'list.');
    END IF;

    -- What the receipt still owes, ignoring this edge. NULL when it has no price yet.
    SELECT s.is_priceable,
           trim_scale(s.balance_php + coalesce(v_prev, 0)),
           coalesce(pg_catalog.to_char(s.delivery_date, 'YYYY-MM-DD'), 'undated')
             || ' receipt (truck ' || coalesce(s.truck_no, '?') || ')'
      INTO v_priceable, v_owed, v_label
      FROM cenapro.view_rc_delivery_settlement s
     WHERE s.delivery_id = p_delivery_id;

    IF v_label IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'That receipt no longer exists. Reload the receipt list.');
    END IF;

    IF v_priceable IS NOT TRUE THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', pg_catalog.format(
          'The %s has no weight or no agreed price yet, so there is no outstanding amount to fill '
          || 'in for you. Type the amount you want to assign to it.', v_label));
    END IF;

    v_amount := least(v_owed, v_free);

    IF v_amount IS NULL OR v_amount <= 0 THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'owed_php', v_owed, 'unassigned_php', v_free,
        'message', CASE
          WHEN v_free <= 0 THEN
            'Every peso of this payment is already assigned to other receipts. Release some of it '
            || 'first, or record another payment.'
          ELSE pg_catalog.format(
            'The %s is already fully settled, so there is nothing left to assign to it. Type an '
            || 'amount if you mean to over-assign it deliberately.', v_label)
        END);
    END IF;
  END IF;

  -- The payment's live block, with this receipt replaced or added. A note is only
  -- overwritten when one is supplied, so a re-assignment does not silently wipe it.
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'delivery_id', x.delivery_id, 'amount_php', x.amount_php, 'note', x.note)), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT a.delivery_id, a.amount_php, a.note
        FROM cenapro.rc_payment_allocation a
       WHERE a.payment_id   = p_payment_id
         AND a.deleted_at  IS NULL
         AND a.delivery_id <> p_delivery_id
      UNION ALL
      SELECT p_delivery_id, v_amount, coalesce(p_note, v_prev_note)
    ) x;

  v_res := public.cenapro_save_rc_payment_allocations(
             p_payment_id, p_expected_row_version, v_rows);

  IF coalesce((v_res -> 'ok')::boolean, false) THEN
    IF v_label IS NULL THEN
      SELECT coalesce(pg_catalog.to_char(d.delivery_date, 'YYYY-MM-DD'), 'undated')
             || ' receipt (truck ' || coalesce(d.truck_no, '?') || ')'
        INTO v_label
        FROM cenapro.rc_delivery d WHERE d.id = p_delivery_id;
    END IF;

    v_res := v_res
      || pg_catalog.jsonb_build_object(
           'delivery_id', p_delivery_id,
           'amount_php', v_amount,
           'previous_amount_php', v_prev,
           'message', pg_catalog.format(
             '%s %s to the %s. %s of this payment is %s.',
             CASE WHEN v_prev IS NULL THEN 'Assigned' ELSE 'Changed the assignment to' END,
             pg_catalog.to_char(v_amount, 'FM999,999,999,990.00'),
             v_label,
             pg_catalog.to_char((v_res ->> 'unallocated_php')::numeric,
                                'FM999,999,999,990.00'),
             CASE WHEN (v_res ->> 'unallocated_php')::numeric = 0
                  THEN 'now fully assigned' ELSE 'still unassigned' END));
  END IF;

  RETURN v_res;
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_allocate_delivery_to_payment(uuid, integer, uuid, numeric, text) IS
  'THE DELIVERY-FIRST DOOR: assign ONE receipt to an existing payment ("right click a delivery, '
  'assign a cheque to it"). Implemented ON TOP of public.cenapro_save_rc_payment_allocations — it '
  'merges this one edge into the payment''s live block and delegates — so there is ONE write path, '
  'ONE set of invariants and ZERO duplicated validation; every refusal listed on that function '
  'applies here unchanged. It SETS the edge rather than adding to it (the block RPC is a replace, so '
  'calling it twice with the same amount must not mean two different things); the previous amount '
  'comes back as previous_amount_php. p_amount_php NULL means LEAST(what the receipt still owes, '
  'what the payment still has unassigned), computed in SQL — refused when the receipt has no price '
  'yet or nothing is left. Outcomes: saved | version_conflict | not_found | unsupported_field | '
  'invalid.';

REVOKE EXECUTE ON FUNCTION
  public.cenapro_allocate_delivery_to_payment(uuid, integer, uuid, numeric, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION
  public.cenapro_allocate_delivery_to_payment(uuid, integer, uuid, numeric, text)
  TO authenticated, service_role;


-- ── 11c. Un-release one allocation ───────────────────────────────────────────────
-- §5c asked for reverting to be robust THROUGHOUT the feature, and a soft delete you
-- cannot undo is not reversibility. Gated on the ALLOCATION's own row_version (not the
-- payment's): this is a single-row act on a row the block editor is not holding, and the
-- enforced invariant is guaranteed by the constraint trigger regardless.
CREATE OR REPLACE FUNCTION public.cenapro_restore_rc_payment_allocation(
  p_id                   uuid,
  p_expected_row_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_cur      cenapro.rc_payment_allocation;
  v_pay      cenapro.rc_payment;
  v_id       uuid;
  v_version  integer;
  v_current  integer;
  v_allocated numeric;
  v_label    text;
BEGIN
  IF p_id IS NULL OR p_expected_row_version IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Both p_id and p_expected_row_version are required - a blind restore is refused.');
  END IF;

  SELECT * INTO v_cur FROM cenapro.rc_payment_allocation a WHERE a.id = p_id;
  IF v_cur.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found',
      'message', 'That allocation no longer exists. If its receipt was deleted, the allocation was '
                 || 'removed with it and only the history remains - assign the money again '
                 || 'instead.');
  END IF;

  IF v_cur.deleted_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'That allocation is not released, so there is nothing to restore.');
  END IF;

  SELECT * INTO v_pay FROM cenapro.rc_payment x WHERE x.id = v_cur.payment_id;
  IF v_pay.deleted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'The payment this allocation belongs to is deleted. Restore the payment first.');
  END IF;

  -- The pair was re-created while this one sat released. Refuse rather than resurrect a
  -- second live edge for the same pair — that is what the partial unique index means.
  IF EXISTS (SELECT 1 FROM cenapro.rc_payment_allocation a
              WHERE a.payment_id  = v_cur.payment_id
                AND a.delivery_id = v_cur.delivery_id
                AND a.deleted_at IS NULL) THEN
    SELECT coalesce(pg_catalog.to_char(d.delivery_date, 'YYYY-MM-DD'), 'undated')
           || ' receipt (truck ' || coalesce(d.truck_no, '?') || ')'
      INTO v_label
      FROM cenapro.rc_delivery d WHERE d.id = v_cur.delivery_id;

    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format(
        'This payment was assigned to the %s again after this allocation was released, so restoring '
        || 'it would assign the same receipt twice from one payment. Edit the live allocation '
        || 'instead.', coalesce(v_label, 'same receipt')));
  END IF;

  -- The friendly half of the enforced invariant; the constraint trigger is the guarantee.
  SELECT coalesce(sum(a.amount_php), 0) INTO v_allocated
    FROM cenapro.rc_payment_allocation a
   WHERE a.payment_id  = v_cur.payment_id
     AND a.deleted_at IS NULL;

  IF v_allocated + v_cur.amount_php > v_pay.amount_php THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format(
        'Restoring %s would bring this payment''s assignments to %s, but it is only worth %s. '
        || 'Release or lower another allocation first.',
        pg_catalog.to_char(v_cur.amount_php, 'FM999,999,999,990.00'),
        pg_catalog.to_char(v_allocated + v_cur.amount_php, 'FM999,999,999,990.00'),
        pg_catalog.to_char(v_pay.amount_php, 'FM999,999,999,990.00')));
  END IF;

  BEGIN
    UPDATE cenapro.rc_payment_allocation AS t
       SET deleted_at = NULL,
           deleted_by = NULL
     WHERE t.id          = p_id
       AND t.row_version = p_expected_row_version
       AND t.deleted_at IS NOT NULL
    RETURNING t.id, t.row_version INTO v_id, v_version;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'This payment has been assigned to that receipt again, so restoring this '
                   || 'allocation would assign it twice. Edit the live allocation instead.');
    WHEN check_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid', 'message', SQLERRM);
  END;

  IF v_id IS NULL THEN
    SELECT a.row_version INTO v_current FROM cenapro.rc_payment_allocation a WHERE a.id = p_id;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found', 'message', 'That allocation no longer exists.');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this allocation while you were looking at it. Reload before '
                 || 'restoring.');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'restored', 'id', v_id, 'row_version', v_version,
    'payment_id', v_cur.payment_id, 'delivery_id', v_cur.delivery_id,
    'amount_php', v_cur.amount_php,
    'message', pg_catalog.format('Put %s back onto that receipt.',
                                 pg_catalog.to_char(v_cur.amount_php, 'FM999,999,999,990.00')));
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_restore_rc_payment_allocation(uuid, integer) IS
  'Un-release a soft-deleted allocation, gated on the ALLOCATION''s own row_version in the same '
  'statement as the write. Exists because §5c asked for reverting to be robust throughout the '
  'feature. REFUSES: a blind restore, an allocation that is not released, one whose payment is '
  'deleted, one whose (payment, receipt) pair has since been re-created (restoring would assign the '
  'same receipt twice from one payment), and one that would push the payment over its amount. An '
  'allocation whose RECEIPT was deleted cannot be restored at all - it was hard-removed with the '
  'receipt and only the audit trail remains, by design. Outcomes: restored | version_conflict | '
  'not_found | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_restore_rc_payment_allocation(uuid, integer)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_restore_rc_payment_allocation(uuid, integer)
  TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 12. DELETING A RECEIPT THAT HAS MONEY AGAINST IT — WARN, THEN RELEASE
-- ═════════════════════════════════════════════════════════════════════════════════
-- Renzo (§5c): "I said warn because I didn't want to feel like I was locked up to one
-- choice - what if an entry was a duplicate and it was already assigned money." And the
-- rule: deleting such a receipt WARNS, then RELEASES the allocation — the amount returns to
-- the cheque's unassigned pool, and is never silently destroyed, because the cheque would
-- otherwise still exist carrying money that no longer adds up.
--
-- SO: by DEFAULT this REFUSES with outcome `has_allocations`, carrying the real total and
-- the real cheques so the UI can warn with numbers instead of a generic scare. Passing
-- p_release_allocations => true removes those edges in the SAME TRANSACTION and then
-- deletes the receipt. The money reappears on every cheque immediately, because
-- `unallocated_php` is derived, not stored.
--
-- WHY THE EDGES ARE HARD-REMOVED AND NOT SOFT-DELETED (header F): delivery_id is
-- ON DELETE RESTRICT, and the referential check does not know what `deleted_at` means — a
-- soft-deleted edge still references the receipt and still refuses the DELETE. §5c's own
-- answer applies: "every mutation carries a full snapshot, so anything can be reconstructed
-- even when it was hard-removed upstream." Each removal writes a DELETE row into
-- cenapro.rc_payment_audit with the whole edge in `snapshot` and a `source` saying exactly
-- why, keyed by payment_id AND delivery_id, so it is findable from either end afterwards.
--
-- ADDING A PARAMETER MEANS DROP + CREATE, NEVER CREATE OR REPLACE: replacing with a
-- different signature would leave the 2-argument version in place as an OVERLOAD, and
-- PostgREST cannot choose between two candidates. The new argument DEFAULTS to false, so
-- the existing caller (app/(app)/cenapro/deliveries/actions.ts::deleteDelivery, which sends
-- p_id and p_expected_row_version only) keeps working byte-for-byte, and the return payload
-- keeps every key it had — the new ones are additive.
DROP FUNCTION IF EXISTS public.cenapro_delete_rc_delivery(uuid, integer);

CREATE OR REPLACE FUNCTION public.cenapro_delete_rc_delivery(
  p_id                   uuid,
  p_expected_row_version integer,
  p_release_allocations  boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_id        uuid;
  v_current   integer;
  v_samples   integer;
  v_live_n    integer;
  v_live_php  numeric;
  v_inert_n   integer;
  v_removed   integer;
  v_payments  jsonb;
  v_labels    text;
BEGIN
  IF p_id IS NULL OR p_expected_row_version IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Both p_id and p_expected_row_version are required — a blind delete is refused.');
  END IF;

  -- Lock the receipt and check its version BEFORE anything is removed. Without this the
  -- allocations could be deleted and the version check then fail, leaving the money gone
  -- and the receipt intact. The gated DELETE below still repeats the version test in the
  -- same statement as the write; under this lock the two cannot disagree, and the nested
  -- block rolls everything back if they somehow do.
  SELECT d.row_version INTO v_current
    FROM cenapro.rc_delivery d
   WHERE d.id = p_id
     FOR UPDATE;

  IF v_current IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found',
      'message', 'That receipt is already gone.');
  END IF;

  IF v_current <> p_expected_row_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this receipt while you were looking at it. Reload before '
                 || 'deleting.');
  END IF;

  SELECT count(*)::integer INTO v_samples
    FROM cenapro.rc_delivery_sample x WHERE x.delivery_id = p_id;

  -- MONEY THAT WOULD ACTUALLY MOVE: live edges on live payments.
  SELECT count(*)::integer, trim_scale(coalesce(sum(a.amount_php), 0))
    INTO v_live_n, v_live_php
    FROM cenapro.rc_payment_allocation a
    JOIN cenapro.rc_payment p ON p.id = a.payment_id
                             AND p.deleted_at IS NULL
   WHERE a.delivery_id = p_id
     AND a.deleted_at IS NULL;

  -- Everything else attached to this receipt: already-released edges, and edges whose
  -- cheque has itself been voided. They hold no live money — nobody's balance changes when
  -- they go — but they DO still reference the receipt, so the foreign key would refuse the
  -- delete with a bare error unless they are removed too. Removed in every path and
  -- REPORTED, never silent.
  SELECT count(*)::integer INTO v_inert_n
    FROM cenapro.rc_payment_allocation a
   WHERE a.delivery_id = p_id
     AND NOT (a.deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM cenapro.rc_payment p
                           WHERE p.id = a.payment_id AND p.deleted_at IS NULL));

  IF v_live_n > 0 AND NOT coalesce(p_release_allocations, false) THEN
    SELECT pg_catalog.jsonb_agg(x.j ORDER BY x.payment_date, x.payment_id),
           pg_catalog.string_agg(x.label, ', ' ORDER BY x.payment_date, x.payment_id)
      INTO v_payments, v_labels
      FROM (
        SELECT p.id AS payment_id, p.payment_date,
               CASE WHEN p.method = 'cheque' THEN 'cheque #' || p.cheque_no
                    ELSE p.method || ' of ' || pg_catalog.to_char(p.payment_date, 'YYYY-MM-DD')
               END AS label,
               pg_catalog.jsonb_build_object(
                 'payment_id',    p.id,
                 'supplier_code', p.supplier_code,
                 'payment_date',  p.payment_date,
                 'method',        p.method,
                 'cheque_no',     p.cheque_no,
                 'amount_php',    p.amount_php,
                 'row_version',   p.row_version,
                 'allocated_php', trim_scale(sum(a.amount_php))) AS j
          FROM cenapro.rc_payment_allocation a
          JOIN cenapro.rc_payment p ON p.id = a.payment_id
                                   AND p.deleted_at IS NULL
         WHERE a.delivery_id = p_id
           AND a.deleted_at IS NULL
         GROUP BY p.id, p.supplier_code, p.payment_date, p.method, p.cheque_no,
                  p.amount_php, p.row_version
      ) x;

    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'has_allocations',
      'allocation_count', v_live_n,
      'allocated_php', v_live_php,
      'inert_allocation_count', v_inert_n,
      'payments', coalesce(v_payments, '[]'::jsonb),
      'message', pg_catalog.format(
        'This receipt has %s assigned to it from %s payment(s) (%s). Deleting it will RELEASE that '
        || 'money back to those payments, where it can be assigned to another receipt - it is never '
        || 'destroyed. Confirm to go ahead.',
        pg_catalog.to_char(v_live_php, 'FM999,999,999,990.00'), v_live_n::text,
        coalesce(v_labels, 'unknown')));
  END IF;

  BEGIN
    -- The allocations first: the foreign key is ON DELETE RESTRICT, so nothing may cascade
    -- money away implicitly. `source` names the reason on every audit row it writes; the
    -- GUC is transaction-local and is cleared immediately after the statement it describes,
    -- because a half-true provenance column is worse than an empty one.
    IF v_live_n + v_inert_n > 0 THEN
      PERFORM pg_catalog.set_config(
        'cenapro.audit_source',
        CASE WHEN v_live_n > 0 THEN 'cenapro_delete_rc_delivery:release'
             ELSE 'cenapro_delete_rc_delivery:already_released' END,
        true);

      DELETE FROM cenapro.rc_payment_allocation a WHERE a.delivery_id = p_id;
      GET DIAGNOSTICS v_removed = ROW_COUNT;

      PERFORM pg_catalog.set_config('cenapro.audit_source', '', true);
    ELSE
      v_removed := 0;
    END IF;

    PERFORM pg_catalog.set_config('cenapro.audit_source', 'cenapro_delete_rc_delivery', true);

    DELETE FROM cenapro.rc_delivery AS t
     WHERE t.id          = p_id
       AND t.row_version = p_expected_row_version
    RETURNING t.id INTO v_id;

    PERFORM pg_catalog.set_config('cenapro.audit_source', '', true);

    IF v_id IS NULL THEN
      -- Unreachable while the FOR UPDATE lock above is held. Raising rather than returning
      -- rolls the released allocations back with the subtransaction, so a race can never
      -- destroy the money and leave the receipt standing.
      RAISE EXCEPTION 'row_version changed under the lock'
        USING ERRCODE = 'serialization_failure';
    END IF;
  EXCEPTION
    WHEN serialization_failure THEN
      SELECT d.row_version INTO v_current FROM cenapro.rc_delivery d WHERE d.id = p_id;
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
        'message', 'Someone else changed this receipt while it was being deleted. Nothing was '
                   || 'changed - reload and try again.');
  END;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'deleted', 'id', v_id,
    'samples_deleted', v_samples,
    'allocations_released', v_live_n,
    'allocations_released_php', v_live_php,
    'inert_allocations_removed', v_inert_n,
    'allocation_rows_removed', v_removed,
    'message', CASE
      WHEN v_live_n > 0 THEN pg_catalog.format(
        'Receipt deleted. %s was released back to %s payment(s) and can be assigned to another '
        || 'receipt.', pg_catalog.to_char(v_live_php, 'FM999,999,999,990.00'), v_live_n::text)
      ELSE 'Receipt deleted.'
    END);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_delete_rc_delivery(uuid, integer, boolean) IS
  'Delete one Cenapro RC receipt, gated on p_expected_row_version (the row is locked FOR UPDATE '
  'first, and the version is re-checked in the same statement as the DELETE). Child sub-samples '
  'cascade and the count comes back as samples_deleted, exactly as before. NEW (Step 4): if the '
  'receipt has money assigned to it, the delete is REFUSED with outcome `has_allocations`, the real '
  'allocated total and the real payments involved, so the UI can warn with numbers. Passing '
  'p_release_allocations => true RELEASES that money in the same transaction — the amounts return to '
  'each payment''s unassigned pool automatically, because unallocated_php is derived — and then '
  'deletes the receipt. The allocation rows are HARD-removed rather than soft-deleted, because '
  'delivery_id is ON DELETE RESTRICT and a soft-deleted row still refuses the delete; each removal '
  'leaves a full-snapshot DELETE row in cenapro.rc_payment_audit whose `source` says why, keyed by '
  'both payment_id and delivery_id (§5c: anything can be reconstructed even when it was hard-removed '
  'upstream). Already-released edges and edges on a voided payment hold no live money, do not gate '
  'anything, and are removed in every path and reported as inert_allocations_removed. WITH NO '
  'ALLOCATIONS AT ALL, THE BEHAVIOUR AND THE RETURN PAYLOAD ARE UNCHANGED. Outcomes: deleted | '
  'has_allocations | version_conflict | not_found | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_delete_rc_delivery(uuid, integer, boolean)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_delete_rc_delivery(uuid, integer, boolean)
  TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 13. NOTHING IS SEEDED
-- ═════════════════════════════════════════════════════════════════════════════════
-- Not one allocation is inserted here. There is no real cheque in the system yet, so there
-- is no real assignment to record, and inventing one would put a fabrication in the middle
-- of the money — the exact thing the audit discipline exists to prevent.

NOTIFY pgrst, 'reload schema';
