-- ─────────────────────────────────────────────────────────────────────────────────
-- Cenapro (Tenant #2) — BANKS, ACCOUNTS, PAYMENTS and the PER-SUPPLIER RUNNING
-- BALANCE. Liquidation Step 3.
--
-- WHAT THIS ANSWERS, THAT NOTHING TODAY CAN: "what do we owe BRIX right now."
-- cenapro.rc_delivery already knows what CI owes for every truck. This migration is
-- the other half — the money going back out — and the one object Renzo actually
-- asked for: cenapro.view_rc_supplier_balance.
--
-- IT DELIBERATELY SHIPS A REAL BALANCE **BEFORE** ALLOCATION EXISTS. Assigning a
-- cheque to particular receipts (rc_payment_allocation, view_rc_delivery_settlement,
-- view_rc_payment_state) is Step 4. Allocation REFINES this number; it does not
-- enable it. Consequently `advance_php` is NOT here: without allocations every peso
-- of every payment is unallocated, so the column would read 100% on every row and
-- teach the UI something false.
--
-- STRICTLY ADDITIVE TO cenapro.rc_delivery. No column is added to it, nothing is
-- written in it, cenapro.view_rc_delivery is not altered (it has UI consumers and a
-- 116-assertion verify script). The moment a `paid` flag appears on the receipt there
-- are two truths about the same money.
--
-- ═══ THE ONE LINE THAT MATTERS MOST ══════════════════════════════════════════════
-- `receipts_php` SUMs over PRICEABLE receipts only:
--       gross_weight_kg IS NOT NULL AND base_price_php_kg IS NOT NULL
-- (named once, as cenapro.rc_delivery_is_priceable(), so Step 4 reuses it).
--
-- WHY, precisely — and this is subtler than the brief that asked for it assumed.
-- `total_price_php` is a STORED GENERATED column that COALESCEs BOTH factors to 0,
-- so an unweighed or unpriced receipt reads ₱0, not NULL. Therefore:
--
--     SUM(total_price_php)  ==  SUM(total_price_php) FILTER (priceable)
--
-- IDENTICALLY, on every supplier, forever. The naive balance does not produce a
-- WRONG PESO NUMBER — it produces the RIGHT peso number with a SILENT HOLE in it,
-- and marks every unpriced receipt fully settled the instant it exists. There is no
-- amount anywhere that reveals the gap. That is worse than a discrepancy, not better.
--
-- So the predicate earns its place twice over:
--   1. it is the ONE definition that also produces `unpriced_receipt_count` /
--      `unpriced_receipt_kg` / the three awaiting_* counts — the only columns on this
--      view that can tell the screen its own number is incomplete;
--   2. it makes `receipts_php` immune to a future change that lets total_price_php
--      be NULL instead of 0, which would otherwise NULL-poison a whole supplier.
--
-- Renzo (decision 10): these are INCOMPLETE ENTRIES, not ₱0 payable. And "priced but
-- not yet weighed" is a NORMAL DAILY STAGE in a receipt's life — the two ALI UNGA
-- receipts entered at ₱42/kg on 2026-08-05 with no weight are exactly what the in-app
-- INSERT path creates — so this count will never sit at zero for long. Permanent
-- infrastructure, not a migration-era workaround.
--
-- ═══ THE SIGN ════════════════════════════════════════════════════════════════════
--     running_balance_php = payments_php − receipts_php
--     NEGATIVE = WE OWE THE SUPPLIER.  POSITIVE = THE SUPPLIER OWES US.
-- Renzo's convention verbatim (decision 5), the OPPOSITE of the accounts-payable one.
-- Stated in the column COMMENT so nobody re-derives it backwards.
-- A NON-ZERO BALANCE IS NEVER AN ERROR STATE (decision 8): no badge, no red, no
-- auto-close, no nightly job, and NO rounds_to_php / within_rounding — the rounding
-- habit is real but not stable enough to encode, and a rule that is right most of the
-- time would license the UI to call a genuine shortfall "expected".
--
-- ═══ EIGHT DECISIONS, EACH WITH ITS REASON ═══════════════════════════════════════
--
-- 1. AMOUNT IS ALWAYS POSITIVE; DIRECTION IS A SEPARATE COLUMN.
--    CHECK (amount_php > 0) with `direction` in (outgoing, incoming). Never the sign,
--    so a careless SUM can never net two opposite movements to zero. 99.99% outgoing
--    (decision 3) — modelled, and kept out of the way.
--
-- 2. THE SIGNED CONTRIBUTION IS DEFINED ONCE, IN cenapro.view_rc_payment.
--    `balance_effect_php` = +amount for outgoing, −amount for incoming; the balance
--    view AGGREGATES THAT VIEW rather than the base table, so the row list and the
--    balance can never disagree about what a refund does. `adjustment` (a write-off —
--    no cash moved) participates identically: forgiving ₱132.875 we owe is an
--    OUTGOING adjustment and moves the balance to zero; forgiving an overpayment is an
--    INCOMING one. The decomposition is exposed so the UI never works it out:
--        payments_php = cash_out_php − cash_in_php + adjustment_php
--    and cash_net_php = cash_out_php − cash_in_php.
--
-- 3. NO `status` COLUMN. Decision 14 declined the cheque lifecycle outright. Shipping
--    a column nobody sets is how a schema starts lying. A bounced cheque is handled by
--    editing the payment or recording a reversing `adjustment`.
--
-- 4. CHEQUE UNIQUENESS IS PER ACCOUNT, AND SOFT DELETES DO NOT BLOCK RE-USE.
--    Two banks will happily issue cheque #001234 (§3.7), so the key is
--    (bank_account_id, cheque_no) — and strictly per ACCOUNT, not per bank, because a
--    cheque book belongs to an account. That is also what makes Step 7's skipped-
--    number detection possible at all (decision 5d), and it is why rc_bank_account
--    exists as a real record rather than the label-only field §4.2 proposed.
--    PARTIAL: WHERE method = 'cheque' AND deleted_at IS NULL.
--
-- 5. PAYMENTS ARE SOFT-DELETED (decision 5c). They are money records, not transcribed
--    reference data. `deleted_at` / `deleted_by`, plus a RESTORE rpc — a soft delete
--    you cannot undo is not reversibility, and §5c asked for reverting to be robust
--    throughout the feature. The audit trail and `deleted_at` answer DIFFERENT
--    questions and both are needed: the trail records that a void happened and by
--    whom; the column is what every balance filters on.
--
-- 6. THE AUDIT TRAIL COVERS rc_payment ONLY — NOT rc_bank / rc_bank_account.
--    THE TEST APPLIED: *does changing this row alter the meaning of an already-
--    recorded money fact?*
--      * rc_supplier.parent_code — YES (it decides which allocations were legal), so
--        Step 2 audited it.
--      * rc_payment — YES, obviously; it IS the money fact.
--      * rc_bank_account — NO. A payment reaches its account by immutable `id`, so
--        renaming the account, editing its number, or re-pointing its bank_code
--        changes a LABEL, never which cheques belong to which book. Step 7's gap
--        detection groups by bank_account_id and is unaffected.
--    Both dimension tables still get `row_version` + a touch trigger + a compare-and-
--    set RPC, so the SAFETY half is present; only the HISTORY half is deferred. If
--    Step 7 ever needs "was this account under BDO in March", adding the trail then is
--    a cheap additive migration whose trail starts from a truthful date — far better
--    than a backfill, which is forbidden.
--    RESIDUAL GAP, STATED: a hard DELETE of an account SET NULLs bank_account_id on
--    its non-cheque payments and leaves no record of what it was. Mitigated
--    structurally, not by hope: there is NO delete RPC for accounts (retire with
--    active = false, exactly as rc_supplier does), and for a CHEQUE the shape CHECK
--    below refuses the SET NULL outright, so a cheque's account is undeletable.
--
-- 7. EVERY NEW PUBLIC ACCESSOR IS READ-ONLY. `public.cenapro_rc_suppliers` is
--    auto-updatable for historical reasons; nothing here is. The RPCs (allowlisted
--    patch + compare-and-set) are the ONLY write door, which also means a future REST
--    importer cannot exist without someone noticing.
--
-- 8. NO PERIOD BOUNDARY. The balance aggregates from the beginning of time. Closing
--    and restarting a balance is a HUMAN-INITIATED MARKER (decision 6) and it is
--    Step 6 — cenapro.rc_balance_period — not a calendar reset and not this migration.
--
-- ═══ THE RECEIPT THAT CANNOT BE LIQUIDATED ═══════════════════════════════════════
-- One receipt (2026-02-23, ₱864,743.75) has NO supplier_code. It has no payee, so no
-- cheque can ever point at it — rc_payment.supplier_code is NOT NULL by design
-- (decision 1: a cheque is always to a single supplier). §6 says the screen should say
-- so, not guess.
-- CHOSEN: a SYNTHETIC ROW, not a documented exclusion. An exclusion is something a UI
-- can forget to render; a row is not. cenapro.view_rc_supplier_balance emits ONE extra
-- row with supplier_code IS NULL, group_code IS NULL, is_unassigned = true, and it is
-- emitted ONLY WHILE such receipts exist — assign the payee and the row disappears by
-- itself. It carries receipts but can never carry payments, so its balance is exactly
-- −₱864,743.75 and it is visibly not a trader.
-- ─────────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════════
-- 1. DIMENSION — cenapro.rc_bank (CI's own banks)
-- ═════════════════════════════════════════════════════════════════════════════════
-- Modelled on cenapro.rc_supplier line for line, and for the same reason: the list can
-- grow or shrink, so it is DATA, never a CHECK constraint and never an enum. Adding a
-- bank is an INSERT; retiring one is `active = false`, NEVER a DELETE — historic
-- payments must keep naming it.
CREATE TABLE IF NOT EXISTS cenapro.rc_bank (
  code          text PRIMARY KEY,
  display_name  text        NOT NULL,
  sort_order    integer     NOT NULL DEFAULT 0,
  active        boolean     NOT NULL DEFAULT true,
  notes         text,
  row_version   integer     NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cenapro_rc_bank_code_nonblank CHECK (btrim(code) <> ''),
  CONSTRAINT cenapro_rc_bank_name_nonblank CHECK (btrim(display_name) <> '')
);

COMMENT ON TABLE cenapro.rc_bank IS
  'CI''s OWN banks (BDO / CHINABANK / METROBANK / AUB), the dimension a cheque or transfer is '
  'drawn on. Data, not an enum — the list grows and shrinks. NOT the supplier''s bank: this hangs '
  'off cenapro.rc_bank_account, never off cenapro.rc_supplier (§3.8). Retire with active = false; '
  'a DELETE is refused by rc_bank_account''s foreign key.';


-- ═════════════════════════════════════════════════════════════════════════════════
-- 2. DIMENSION — cenapro.rc_bank_account (the cheque book's home)
-- ═════════════════════════════════════════════════════════════════════════════════
-- Renzo (decision 4): "store bank name AND account number, but they are not
-- front-of-screen." Bank name reads primarily; the account number is secondary detail.
-- STRUCTURALLY NECESSARY, not nice-to-have (decision 5d): a cheque-number sequence
-- belongs to a cheque BOOK, and a cheque book belongs to an ACCOUNT — so skipped-number
-- detection (Step 7) is per account. Step 3's job is to make that possible.
CREATE TABLE IF NOT EXISTS cenapro.rc_bank_account (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NOT NULL: an account always belongs to a bank. No ON DELETE clause, so the default
  -- NO ACTION refuses deleting a bank that still has accounts — the intended answer.
  bank_code      text        NOT NULL REFERENCES cenapro.rc_bank(code) ON UPDATE CASCADE,

  -- The human name: "current - Cebu". This is what a person picks from.
  account_label  text        NOT NULL,
  -- Secondary detail, deliberately not front-of-screen. NULLable: the account can be
  -- useful before somebody digs the number out.
  account_no     text,

  active         boolean     NOT NULL DEFAULT true,
  sort_order     integer     NOT NULL DEFAULT 0,
  notes          text,

  row_version    integer     NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cenapro_rc_bank_account_label_nonblank CHECK (btrim(account_label) <> ''),
  CONSTRAINT cenapro_rc_bank_account_label_key      UNIQUE (bank_code, account_label)
);

COMMENT ON TABLE cenapro.rc_bank_account IS
  'One of CI''s bank accounts — the home of a cheque book. Exists because a cheque NUMBER is '
  'unique only per ACCOUNT (§3.7) and because Step 7 detects skipped cheque numbers per book '
  '(decision 5d). Bank name reads primarily, account_no is secondary detail (decision 4). Retire '
  'with active = false — there is deliberately no delete RPC.';
COMMENT ON COLUMN cenapro.rc_bank_account.account_no IS
  'The actual account number. Secondary detail, never front-of-screen. NULL is allowed so an '
  'account can be usable before someone looks the number up.';

-- Two accounts at one bank must not share a number. Partial, because account_no is
-- NULLable and NULLs are distinct anyway.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cenapro_rc_bank_account_no
  ON cenapro.rc_bank_account (bank_code, account_no)
  WHERE account_no IS NOT NULL;

-- Postgres does NOT index a foreign key automatically. This one carries the ON UPDATE
-- CASCADE referential scan and the read view's join.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_bank_account_bank
  ON cenapro.rc_bank_account (bank_code);


-- ═════════════════════════════════════════════════════════════════════════════════
-- 3. TOUCH TRIGGER for both dimension tables — row_version / updated_at
-- ═════════════════════════════════════════════════════════════════════════════════
-- ONE function, because rc_bank and rc_bank_account carry exactly the same bookkeeping
-- columns and neither has actor columns (WHO changed a bank is not a money fact — see
-- decision 6). In a TRIGGER, not in the RPC, for the reason stated on
-- cenapro.fn_touch_rc_delivery: any raw DML must advance the concurrency token too, or
-- a write that skips the RPC silently defeats its compare-and-set.
CREATE OR REPLACE FUNCTION cenapro.fn_touch_rc_bank_row()
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

COMMENT ON FUNCTION cenapro.fn_touch_rc_bank_row() IS
  'BEFORE INSERT/UPDATE on cenapro.rc_bank AND cenapro.rc_bank_account: on UPDATE bumps '
  'row_version + updated_at and freezes created_at. Shared by both because their bookkeeping '
  'columns are identical.';

REVOKE EXECUTE ON FUNCTION cenapro.fn_touch_rc_bank_row() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cenapro.fn_touch_rc_bank_row() TO authenticated, service_role;

DROP TRIGGER IF EXISTS tr_cenapro_rc_bank_touch ON cenapro.rc_bank;
CREATE TRIGGER tr_cenapro_rc_bank_touch
  BEFORE INSERT OR UPDATE ON cenapro.rc_bank
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_touch_rc_bank_row();

DROP TRIGGER IF EXISTS tr_cenapro_rc_bank_account_touch ON cenapro.rc_bank_account;
CREATE TRIGGER tr_cenapro_rc_bank_account_touch
  BEFORE INSERT OR UPDATE ON cenapro.rc_bank_account
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_touch_rc_bank_row();


-- ═════════════════════════════════════════════════════════════════════════════════
-- 4. FACT — cenapro.rc_payment (one row per money movement)
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cenapro.rc_payment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NOT NULL (decision 1): a cheque is always to a single supplier, and the running
  -- balance is per supplier — a payment with no payee has no home in it. It may cover
  -- many deliveries of that supplier, and (Step 4) of that supplier's SUBGROUP.
  -- ON UPDATE CASCADE so re-keying a trader never orphans money.
  supplier_code    text        NOT NULL REFERENCES cenapro.rc_supplier(code) ON UPDATE CASCADE,

  -- The day the money was released.
  payment_date     date        NOT NULL,

  method           text        NOT NULL,
  amount_php       numeric     NOT NULL,
  direction        text        NOT NULL DEFAULT 'outgoing',
  stated_term      text,

  -- Which of OUR accounts. ON DELETE SET NULL matches rc_delivery.supplier_code's
  -- idiom; see decision 6 for why that is safe here (no delete RPC, and the cheque
  -- shape CHECK below turns the SET NULL into a refusal for a cheque).
  bank_account_id  uuid REFERENCES cenapro.rc_bank_account(id) ON DELETE SET NULL,

  cheque_no        text,
  -- In PH trade the date WRITTEN ON the cheque is routinely not payment_date.
  cheque_date      date,
  -- The transfer / OR reference.
  reference_no     text,

  remarks          text,

  -- ── soft delete (decision 5) ───────────────────────────────────────────────────
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- ── concurrency / actor ────────────────────────────────────────────────────────
  row_version      integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- ── constraints ────────────────────────────────────────────────────────────────
  -- 'cash' is DROPPED (decision 2 — cheque and bank transfer only). 'adjustment'
  -- means NO CASH MOVED: it is the write-off mechanism (decision 9), not something an
  -- operator picks as a way of paying.
  CONSTRAINT cenapro_rc_payment_method_ck
    CHECK (method IN ('cheque', 'bank_transfer', 'adjustment')),

  CONSTRAINT cenapro_rc_payment_direction_ck
    CHECK (direction IN ('outgoing', 'incoming')),

  CONSTRAINT cenapro_rc_payment_term_ck
    CHECK (stated_term IS NULL
           OR stated_term IN ('downpayment', 'full', 'straight', 'cash_advance')),

  -- ALWAYS POSITIVE. Direction carries the sign, never the amount (decision 1).
  CONSTRAINT cenapro_rc_payment_amount_positive
    CHECK (amount_php > 0),

  -- Shape guard, in the spirit of cenapro_rc_delivery_provenance_shape:
  --   cheque      => a number AND an account (the account is half its identity);
  --   non-cheque  => no cheque number and no cheque date.
  CONSTRAINT cenapro_rc_payment_cheque_shape
    CHECK ((method =  'cheque'
            AND btrim(COALESCE(cheque_no, '')) <> ''
            AND bank_account_id IS NOT NULL)
        OR (method <> 'cheque'
            AND cheque_no IS NULL
            AND cheque_date IS NULL)),

  -- An actor without a deletion is a half-truth.
  CONSTRAINT cenapro_rc_payment_deleted_shape
    CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL)
);

COMMENT ON TABLE cenapro.rc_payment IS
  'Cenapro RC LIQUIDATION — one row per money movement to (or back from) a raw-charcoal trader: '
  'a cheque, a bank transfer, or an `adjustment` (a write-off, where no cash moved). Always to '
  'ONE supplier (decision 1), always a POSITIVE amount with the sign carried by `direction`. '
  'SOFT-deleted, never hard-deleted — it is a money record. Assigning a payment to particular '
  'receipts is Step 4 (cenapro.rc_payment_allocation); this table stands alone and already '
  'produces cenapro.view_rc_supplier_balance.';

COMMENT ON COLUMN cenapro.rc_payment.supplier_code IS
  'The PAYEE. NOT NULL: the running balance is per supplier and a payment with no payee has no '
  'home in it. One payment may settle many of that supplier''s deliveries — and, from Step 4, '
  'deliveries of its sub-suppliers, resolved through cenapro.view_rc_supplier_group.';
COMMENT ON COLUMN cenapro.rc_payment.payment_date IS
  'The day the money was released. NOT the date written on the cheque — that is cheque_date.';
COMMENT ON COLUMN cenapro.rc_payment.method IS
  'cheque | bank_transfer | adjustment. There is no ''cash'' (decision 2). `adjustment` means NO '
  'CASH MOVED: it is the write-off instrument (decision 9) — an explicit, remarked human act that '
  'forgives a remainder — and it is excluded from the cash_* columns of the balance while still '
  'counting toward it.';
COMMENT ON COLUMN cenapro.rc_payment.amount_php IS
  'ALWAYS POSITIVE (CHECK amount_php > 0). Direction is a separate column and is never folded '
  'into the sign, so a careless SUM can never silently net two opposite movements to zero.';
COMMENT ON COLUMN cenapro.rc_payment.direction IS
  'outgoing (99.99% of rows) = CI paid the trader. incoming = money came back — a refund or a '
  'returned overpayment. Modelled because it is not 100% (decision 3), and deliberately kept out '
  'of the way in the UI. The signed contribution to the balance is defined ONCE, as '
  'cenapro.view_rc_payment.balance_effect_php.';
COMMENT ON COLUMN cenapro.rc_payment.stated_term IS
  'RECORDED HUMAN INTENT ONLY — downpayment | full | straight | cash_advance, as written on the '
  'cheque voucher. **NO BALANCE IS EVER COMPUTED FROM THIS COLUMN, and none ever may be.** '
  '"Downpayment vs full" is not a property of the payment at all: it describes how much of a '
  'RECEIPT an allocation covers, and a cash advance is simply a payment that has no allocation '
  'yet. Stored as an enum that drove arithmetic, these four values would disagree with the '
  'allocations the first time a "downpayment" happened to cover the whole amount, or the first '
  'time a cash advance was drawn down. WHEN THE LABEL AND THE ALLOCATIONS DISAGREE, THE '
  'ALLOCATIONS ARE RIGHT. Keep it because it matches the paper voucher and reads back usefully.';
COMMENT ON COLUMN cenapro.rc_payment.bank_account_id IS
  'Which of CI''s accounts the money left. Required for a cheque (it is half the cheque''s '
  'identity — see uq_cenapro_rc_payment_cheque), optional for a transfer. The BANK is reached '
  'through the account, never denormalized here, so the two can never disagree.';
COMMENT ON COLUMN cenapro.rc_payment.cheque_no IS
  'The number printed on the cheque. NOT unique on its own — two banks will happily issue #001234 '
  '(§3.7). Uniqueness is per ACCOUNT, enforced by the partial index uq_cenapro_rc_payment_cheque, '
  'which also ignores soft-deleted rows so a voided number can be re-used.';
COMMENT ON COLUMN cenapro.rc_payment.cheque_date IS
  'The date WRITTEN ON the cheque, which in PH trade is routinely not payment_date (post-dating). '
  'Refused on a non-cheque by cenapro_rc_payment_cheque_shape.';
COMMENT ON COLUMN cenapro.rc_payment.deleted_at IS
  'SOFT delete (decision 5c: payments are money records, not transcribed reference data). Every '
  'balance filters on deleted_at IS NULL. Undo with public.cenapro_restore_rc_payment(). This and '
  'cenapro.rc_payment_audit answer DIFFERENT questions — the trail says a void happened and who '
  'did it, this column is what the arithmetic reads — and both are needed.';
COMMENT ON COLUMN cenapro.rc_payment.row_version IS
  'Optimistic-concurrency token, bumped by cenapro.fn_touch_rc_payment on EVERY update, so no '
  'write path can silently defeat the save/delete RPCs'' compare-and-set.';

-- ── Indexes ──────────────────────────────────────────────────────────────────────
-- THE cheque identity, and the exact set Step 7's gap detection walks. Partial on
-- method so transfers do not collide on a NULL cheque_no, and on deleted_at so a
-- soft-deleted row never blocks re-use of its number.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cenapro_rc_payment_cheque
  ON cenapro.rc_payment (bank_account_id, cheque_no)
  WHERE method = 'cheque' AND deleted_at IS NULL;

-- The balance view's driving access path. PLAIN, not partial: it also carries the
-- supplier_code ON UPDATE CASCADE referential scan, and the RI machinery's own plans
-- should never have to prove a partial index's predicate.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_payment_supplier
  ON cenapro.rc_payment (supplier_code, payment_date DESC);

-- A chronological keyset pager, the same shape the deliveries ledger uses.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_payment_date
  ON cenapro.rc_payment (payment_date DESC, id);

-- The other foreign key. Carries the ON DELETE SET NULL scan for ALL methods, which
-- the partial cheque index above cannot serve.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_payment_bank_account
  ON cenapro.rc_payment (bank_account_id);


-- ═════════════════════════════════════════════════════════════════════════════════
-- 5. TOUCH TRIGGER — cenapro.rc_payment
-- ═════════════════════════════════════════════════════════════════════════════════
-- Cloned from cenapro.fn_touch_rc_delivery, plus one addition: trim_scale() on the
-- amount. Numeric equality already ignores scale, but `to_jsonb` does not — without
-- it, retyping 1000.00 over 1000 would render as a change and put a phantom row in the
-- audit trail. trim_scale strips only trailing zeros and changes no value; it is the
-- same normalisation the generated money columns use.
CREATE OR REPLACE FUNCTION cenapro.fn_touch_rc_payment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  NEW.amount_php := trim_scale(NEW.amount_php);

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := coalesce(NEW.created_by, auth.uid());
    NEW.updated_by := coalesce(NEW.updated_by, NEW.created_by);
    RETURN NEW;
  END IF;

  NEW.updated_at  := now();
  NEW.row_version := OLD.row_version + 1;
  NEW.created_at  := OLD.created_at;
  NEW.created_by  := OLD.created_by;
  -- Attribute the write when there is a logged-in user; a service-role write has no
  -- auth.uid() and must not blank out whoever last touched the row.
  NEW.updated_by  := coalesce(auth.uid(), NEW.updated_by);
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION cenapro.fn_touch_rc_payment() IS
  'BEFORE INSERT/UPDATE on cenapro.rc_payment: normalises amount_php with trim_scale, stamps '
  'created_by/updated_by from auth.uid(), and on UPDATE bumps row_version + updated_at while '
  'freezing created_at/created_by. In a trigger so EVERY write path advances the concurrency '
  'token, not just the RPCs.';

REVOKE EXECUTE ON FUNCTION cenapro.fn_touch_rc_payment() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cenapro.fn_touch_rc_payment() TO authenticated, service_role;

DROP TRIGGER IF EXISTS tr_cenapro_rc_payment_touch ON cenapro.rc_payment;
CREATE TRIGGER tr_cenapro_rc_payment_touch
  BEFORE INSERT OR UPDATE ON cenapro.rc_payment
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_touch_rc_payment();


-- ═════════════════════════════════════════════════════════════════════════════════
-- 6. THE AUDIT TRAIL — cenapro.rc_payment_audit
-- ═════════════════════════════════════════════════════════════════════════════════
-- A line-for-line clone of cenapro.rc_delivery_audit / cenapro.rc_supplier_audit
-- (2026-08-05). Built IN THE SAME MIGRATION that creates the table it trails, per §5e:
-- retrofitting an audit onto a system already writing money is the expensive version,
-- and the 22 untraced duplicate deletions of 2026-08-04 are what this discipline costs
-- when it is skipped.
CREATE TABLE IF NOT EXISTS cenapro.rc_payment_audit (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The read key, denormalized and WITHOUT an FK: the trail must outlive the payment.
  payment_id      uuid        NOT NULL,

  -- Denormalized identity, so the trail stays readable after the row is gone. These
  -- five are what a human recognises a payment by.
  supplier_code   text,
  payment_date    date,
  method          text,
  amount_php      numeric,
  cheque_no       text,

  operation       text        NOT NULL
                  CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),

  -- UPDATE only: {"amount_php": {"old": 1000000, "new": 1027000}} — ONLY the columns
  -- that actually moved. `updated_at` AND `row_version` are excluded because
  -- fn_touch_rc_payment bumps both on EVERY write: miss one and the diff is never
  -- empty, the no-op skip can never fire, and the trail fills with phantoms.
  -- A SOFT DELETE therefore appears here as an UPDATE carrying `deleted_at`, which is
  -- exactly right: the row is still there, and `changed ? 'deleted_at'` finds voids.
  changed         jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- The full row: NEW on INSERT/UPDATE, OLD on DELETE.
  snapshot        jsonb       NOT NULL,

  -- Which surface wrote it, from the transaction-local GUC `cenapro.audit_source`.
  source          text,

  changed_at      timestamptz NOT NULL DEFAULT now(),

  -- auth.uid() — NULL for a service-role / psql write, the honest answer. Deliberately
  -- NO foreign key to public.profiles: an audit row must outlive the account that
  -- wrote it, and ON DELETE SET NULL would erase the actor exactly when it matters.
  changed_by      uuid,
  changed_by_role text
);

COMMENT ON TABLE cenapro.rc_payment_audit IS
  'Append-only trail of every INSERT/UPDATE/DELETE on cenapro.rc_payment. Written ONLY by the '
  'SECURITY DEFINER trigger cenapro.fn_audit_rc_payment(); no role holds INSERT/UPDATE/DELETE on '
  'it. A SOFT delete lands here as an UPDATE carrying `deleted_at` in `changed`; a DELETE row '
  'means somebody really removed it. The trail starts with the table — nothing was backfilled '
  'because there was nothing to backfill.';
COMMENT ON COLUMN cenapro.rc_payment_audit.payment_id IS
  'The payment''s id. No FK on purpose — the trail outlives the row.';
COMMENT ON COLUMN cenapro.rc_payment_audit.amount_php IS
  'The amount AT THE TIME OF THE CHANGE, promoted out of `snapshot` because "what was this cheque '
  'worth when it was voided" is the question this table exists to answer. ₱-BEARING: any server '
  'action exposing this trail is subject to the canViewPrices() gate, and `changed` / `snapshot` '
  'are free-form jsonb that stripPrices() cannot reach inside.';
COMMENT ON COLUMN cenapro.rc_payment_audit.changed IS
  'UPDATE only: {column: {old, new}} for the columns that actually moved. Excludes updated_at and '
  'row_version (bumped by the touch trigger on every write).';

CREATE INDEX IF NOT EXISTS idx_cenapro_rc_payment_audit_payment
  ON cenapro.rc_payment_audit (payment_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_payment_audit_recent
  ON cenapro.rc_payment_audit (changed_at DESC);

-- SECURITY DEFINER on purpose: combined with the REVOKEs below it means the trigger is
-- the ONLY thing that can write this table. A SECURITY INVOKER trigger would need
-- INSERT granted to `authenticated`, and a grant that lets the trigger write also lets
-- a client forge a row by hand — or erase one.
--
-- AFTER, not BEFORE: fn_touch_rc_payment is a BEFORE trigger that rewrites
-- row_version / updated_at / updated_by / amount_php, and only an AFTER trigger sees
-- the values that were actually stored. (rc_payment has no generated columns, but the
-- rule that forced AFTER on rc_delivery holds here for the touch reason alone.)
CREATE OR REPLACE FUNCTION cenapro.fn_audit_rc_payment()
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
  v_id       uuid;
  v_supplier text;
  v_date     date;
  v_method   text;
  v_amount   numeric;
  v_cheque   text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old      := to_jsonb(OLD);
    v_snapshot := v_old;
    v_id       := OLD.id;
    v_supplier := OLD.supplier_code;
    v_date     := OLD.payment_date;
    v_method   := OLD.method;
    v_amount   := OLD.amount_php;
    v_cheque   := OLD.cheque_no;
  ELSE
    v_new      := to_jsonb(NEW);
    v_snapshot := v_new;
    v_id       := NEW.id;
    v_supplier := NEW.supplier_code;
    v_date     := NEW.payment_date;
    v_method   := NEW.method;
    v_amount   := NEW.amount_php;
    v_cheque   := NEW.cheque_no;
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

  INSERT INTO cenapro.rc_payment_audit
    (payment_id, supplier_code, payment_date, method, amount_php, cheque_no,
     operation, changed, snapshot,
     source, changed_by, changed_by_role)
  VALUES
    (v_id, v_supplier, v_date, v_method, v_amount, v_cheque,
     TG_OP, v_changed, v_snapshot,
     nullif(current_setting('cenapro.audit_source', true), ''),
     auth.uid(),
     auth.role());

  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$fn$;

COMMENT ON FUNCTION cenapro.fn_audit_rc_payment() IS
  'AFTER INSERT/UPDATE/DELETE trail for cenapro.rc_payment. Skips an UPDATE whose only difference '
  'is updated_at / row_version. SECURITY DEFINER so the audit table needs no write grant to any '
  'client role. Catches EVERY writer, not just the RPCs.';

REVOKE ALL ON FUNCTION cenapro.fn_audit_rc_payment() FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_cenapro_rc_payment_audit ON cenapro.rc_payment;
CREATE TRIGGER tr_cenapro_rc_payment_audit
  AFTER INSERT OR UPDATE OR DELETE ON cenapro.rc_payment
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_audit_rc_payment();

-- ── Grants — the cenapro DEFAULT ACL trap ────────────────────────────────────────
-- `pg_default_acl` for schema cenapro is {anon=r, authenticated=arwd,
-- service_role=arwd}, so a table created here is BORN readable by anon and WRITABLE by
-- authenticated whatever the CREATE said. For an append-only ledger that default is
-- precisely the failure. Revoke all three, then hand back read-only.
REVOKE ALL ON cenapro.rc_payment_audit FROM anon;
REVOKE ALL ON cenapro.rc_payment_audit FROM authenticated;
REVOKE ALL ON cenapro.rc_payment_audit FROM service_role;
GRANT SELECT ON cenapro.rc_payment_audit TO authenticated, service_role;

-- Second line of defence: RLS ON with a SELECT-only policy and NO
-- insert/update/delete policy at all, so a future blanket
-- `GRANT ... ON ALL TABLES IN SCHEMA cenapro` still cannot write a row. The SECURITY
-- DEFINER trigger runs as the table owner, which bypasses RLS, so the trail keeps
-- being written.
ALTER TABLE cenapro.rc_payment_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cenapro_rc_payment_audit_select ON cenapro.rc_payment_audit;
CREATE POLICY cenapro_rc_payment_audit_select
  ON cenapro.rc_payment_audit
  FOR SELECT TO authenticated
  USING (true);

-- The identity sequence is born with the same default ACL. Nothing but the definer
-- trigger inserts, so no client role needs it. Scoped by name, never a blanket "all
-- sequences in schema cenapro".
DO $do$
DECLARE
  v_seq text := pg_catalog.pg_get_serial_sequence('cenapro.rc_payment_audit', 'id');
BEGIN
  IF v_seq IS NOT NULL THEN
    EXECUTE format('revoke all on sequence %s from anon, authenticated', v_seq);
  END IF;
END;
$do$;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 7. RLS + GRANTS on the three new fact/dimension tables
-- ═════════════════════════════════════════════════════════════════════════════════
-- Posture per CLAUDE.md: single-org, so authenticated = org member = broad read+write,
-- enforcement lives in the server-action layer (canViewPrices() — the WHOLE of this
-- module is money), anon gets nothing, service_role bypasses RLS.
-- The base-table write grants exist because the RPCs are SECURITY INVOKER. They are
-- not a second write door from the app: the `cenapro` schema is not exposed to
-- PostgREST, and every public accessor this migration creates is READ-ONLY.
ALTER TABLE cenapro.rc_bank         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cenapro.rc_bank_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE cenapro.rc_payment      ENABLE ROW LEVEL SECURITY;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rc_bank', 'rc_bank_account', 'rc_payment']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS cenapro_%1$s_select ON cenapro.%1$I', t);
    EXECUTE format('CREATE POLICY cenapro_%1$s_select ON cenapro.%1$I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS cenapro_%1$s_insert ON cenapro.%1$I', t);
    EXECUTE format('CREATE POLICY cenapro_%1$s_insert ON cenapro.%1$I FOR INSERT TO authenticated WITH CHECK (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS cenapro_%1$s_update ON cenapro.%1$I', t);
    EXECUTE format('CREATE POLICY cenapro_%1$s_update ON cenapro.%1$I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS cenapro_%1$s_delete ON cenapro.%1$I', t);
    EXECUTE format('CREATE POLICY cenapro_%1$s_delete ON cenapro.%1$I FOR DELETE TO authenticated USING (true)', t);

    EXECUTE format('REVOKE ALL ON cenapro.%1$I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON cenapro.%1$I TO authenticated, service_role', t);
  END LOOP;
END $do$;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 8. THE PRICEABILITY PREDICATE — named ONCE (see the header)
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION cenapro.rc_delivery_is_priceable(
  p_gross_weight_kg   numeric,
  p_base_price_php_kg numeric
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $fn$
  SELECT p_gross_weight_kg IS NOT NULL AND p_base_price_php_kg IS NOT NULL;
$fn$;

COMMENT ON FUNCTION cenapro.rc_delivery_is_priceable(numeric, numeric) IS
  'THE definition of a PRICEABLE Cenapro RC receipt: it has both a scale weight and an agreed '
  'base price, so cenapro.rc_delivery.total_price_php is a real payable rather than the ₱0 that '
  'the generated column''s COALESCE produces when a factor is missing. Every liquidation surface '
  'reads this and never re-types the predicate — the Step-4 settlement view included. NOTE that '
  'SUM(total_price_php) and SUM(total_price_php) FILTER (this) are numerically IDENTICAL today, '
  'because an unpriceable receipt contributes exactly 0: the gap a naive balance opens is a '
  'COUNT gap, not a peso gap, which is why unpriced_receipt_count / _kg exist beside it and why '
  'nothing may quietly drop this filter as "redundant".';

REVOKE EXECUTE ON FUNCTION cenapro.rc_delivery_is_priceable(numeric, numeric) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cenapro.rc_delivery_is_priceable(numeric, numeric) TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 9. READ MODEL — cenapro.view_rc_bank_account
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW cenapro.view_rc_bank_account
WITH (security_invoker = true)
AS
SELECT
  a.id,
  a.bank_code,
  b.display_name                         AS bank_display_name,
  b.active                               AS bank_active,
  b.sort_order                           AS bank_sort_order,
  a.account_label,
  a.account_no,
  -- What the UI puts in a picker: bank name first (decision 4), account label after.
  (b.display_name || ' - ' || a.account_label) AS display_label,
  a.active,
  a.sort_order,
  a.notes,
  a.row_version,
  a.created_at,
  a.updated_at
FROM cenapro.rc_bank_account a
JOIN cenapro.rc_bank b ON b.code = a.bank_code;

COMMENT ON VIEW cenapro.view_rc_bank_account IS
  'CI bank accounts with their bank''s display name folded in — the picker read model for '
  'recording a cheque. Bank name reads primarily, account_no is secondary detail (decision 4).';

REVOKE ALL ON cenapro.view_rc_bank_account FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_bank_account TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 10. READ MODEL — cenapro.view_rc_payment
-- ═════════════════════════════════════════════════════════════════════════════════
-- The payment list, and — load-bearing — the ONE definition of what a payment
-- contributes to a balance. cenapro.view_rc_supplier_balance aggregates THIS VIEW
-- rather than the base table, so the list and the balance cannot disagree about what
-- an `incoming` refund or an `adjustment` does. Same discipline as
-- cenapro.view_rc_supplier_group being the one definition of group_code.
--
-- It does NOT filter soft-deleted rows: a voided cheque still belongs on a history
-- screen. Consumers that do arithmetic filter `NOT is_deleted` themselves.
-- It carries NO allocation columns — that is Step 4's view_rc_payment_state.
CREATE OR REPLACE VIEW cenapro.view_rc_payment
WITH (security_invoker = true)
AS
SELECT
  p.id,
  p.supplier_code,
  s.display_name                                     AS supplier_name,
  g.group_code,
  g.group_display_name,
  p.payment_date,
  p.method,
  p.amount_php,
  p.direction,
  p.stated_term,

  p.bank_account_id,
  ba.bank_code,
  ba.bank_display_name,
  ba.account_label,
  ba.account_no,
  ba.display_label                                   AS bank_account_label,

  p.cheque_no,
  p.cheque_date,
  p.reference_no,
  p.remarks,

  -- THE signed contribution to every balance. Defined here and nowhere else.
  trim_scale(CASE WHEN p.direction = 'outgoing' THEN p.amount_php
                  ELSE -p.amount_php END)            AS balance_effect_php,
  -- FALSE only for `adjustment`, where no cash moved. Lets a cash-flow report exclude
  -- write-offs with one predicate while the balance keeps them.
  (p.method <> 'adjustment')                         AS is_cash,

  (p.deleted_at IS NOT NULL)                         AS is_deleted,
  p.deleted_at,
  p.deleted_by,

  p.row_version,
  p.created_at,
  p.created_by,
  p.updated_at,
  p.updated_by
FROM cenapro.rc_payment p
JOIN      cenapro.rc_supplier            s  ON s.code = p.supplier_code
LEFT JOIN cenapro.view_rc_supplier_group g  ON g.code = p.supplier_code
LEFT JOIN cenapro.view_rc_bank_account   ba ON ba.id  = p.bank_account_id;

COMMENT ON VIEW cenapro.view_rc_payment IS
  'Cenapro RC payment read model: the payment + payee name + subgroup (group_code, read from '
  'cenapro.view_rc_supplier_group, never re-derived) + bank/account display + `balance_effect_php` '
  '(the SIGNED contribution: +amount outgoing, -amount incoming) + `is_cash` (false only for an '
  'adjustment write-off) + `is_deleted`. Soft-deleted rows ARE included — filter NOT is_deleted '
  'for anything numeric. ENTIRELY ₱-BEARING: every consumer is behind canViewPrices().';

REVOKE ALL ON cenapro.view_rc_payment FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_payment TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 11. THE BALANCE — cenapro.view_rc_supplier_balance
-- ═════════════════════════════════════════════════════════════════════════════════
-- THE object Renzo asked for. One row per supplier, plus the synthetic unassigned row
-- described in the header. A plain view, deliberately not a materialised one and
-- deliberately not a maintained table: at 971 receipts, 12 traders and a projected few
-- hundred payments a year a plain aggregate is microseconds, and a table would need
-- triggers on three relations to stay honest — the exact staleness surface BUG-017 was.
--
-- CLAUDE.md: "Never calculate weighted averages or inventory balances in TypeScript."
-- Everything the screen needs is a column here, including the honesty columns.
CREATE OR REPLACE VIEW cenapro.view_rc_supplier_balance
WITH (security_invoker = true)
AS
WITH r AS (
  SELECT
    d.supplier_code,
    (count(*))::integer                                       AS receipt_count,

    -- PRICEABLE ONLY. Read the header before touching this line.
    trim_scale(coalesce(sum(d.total_price_php) FILTER (
      WHERE cenapro.rc_delivery_is_priceable(d.gross_weight_kg, d.base_price_php_kg)), 0))
                                                              AS receipts_php,

    (count(*) FILTER (
      WHERE NOT cenapro.rc_delivery_is_priceable(d.gross_weight_kg, d.base_price_php_kg)
    ))::integer                                               AS unpriced_receipt_count,

    -- The payable weight we DO know among the unpriced receipts. A receipt with no
    -- weight at all contributes nothing, because there is nothing to report — which is
    -- why the three awaiting_* counts below exist beside it.
    trim_scale(coalesce(sum(d.net_weight_kg) FILTER (
      WHERE NOT cenapro.rc_delivery_is_priceable(d.gross_weight_kg, d.base_price_php_kg)), 0))
                                                              AS unpriced_receipt_kg,

    -- An exhaustive partition of unpriced_receipt_count, so the screen can name the
    -- state instead of guessing: these are genuinely different operational stages.
    (count(*) FILTER (WHERE d.gross_weight_kg IS NULL
                        AND d.base_price_php_kg IS NOT NULL))::integer
                                                              AS unpriced_awaiting_weight_count,
    (count(*) FILTER (WHERE d.gross_weight_kg IS NOT NULL
                        AND d.base_price_php_kg IS NULL))::integer
                                                              AS unpriced_awaiting_price_count,
    (count(*) FILTER (WHERE d.gross_weight_kg IS NULL
                        AND d.base_price_php_kg IS NULL))::integer
                                                              AS unpriced_awaiting_both_count,

    min(d.delivery_date)                                      AS first_receipt_date,
    max(d.delivery_date)                                      AS last_receipt_date
  FROM cenapro.rc_delivery d
  GROUP BY d.supplier_code
),
p AS (
  SELECT
    v.supplier_code,
    (count(*))::integer                                       AS payment_count,
    -- The signed net, straight off view_rc_payment's ONE definition.
    trim_scale(coalesce(sum(v.balance_effect_php), 0))        AS payments_php,
    trim_scale(coalesce(sum(v.amount_php) FILTER (
      WHERE v.is_cash AND v.direction = 'outgoing'), 0))      AS cash_out_php,
    trim_scale(coalesce(sum(v.amount_php) FILTER (
      WHERE v.is_cash AND v.direction = 'incoming'), 0))      AS cash_in_php,
    trim_scale(coalesce(sum(v.balance_effect_php) FILTER (
      WHERE NOT v.is_cash), 0))                               AS adjustment_php,
    (count(*) FILTER (WHERE NOT v.is_cash))::integer          AS adjustment_count,
    min(v.payment_date)                                       AS first_payment_date,
    max(v.payment_date)                                       AS last_payment_date
  FROM cenapro.view_rc_payment v
  WHERE NOT v.is_deleted
  GROUP BY v.supplier_code
)
SELECT
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

  -- THE NUMBER. Negative = we owe them. See the COMMENT below and the header.
  trim_scale(coalesce(p.payments_php, 0) - coalesce(r.receipts_php, 0))
                                                AS running_balance_php
FROM cenapro.view_rc_supplier_group g
LEFT JOIN r ON r.supplier_code = g.code
LEFT JOIN p ON p.supplier_code = g.code

UNION ALL

-- The receipts with NO PAYEE. They cannot be liquidated — rc_payment.supplier_code is
-- NOT NULL, so no cheque can ever point at them — but they must not silently vanish
-- from every total either (§6: the screen should say so, not guess). Emitted ONLY
-- while such receipts exist; assign the payee and this row disappears by itself.
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

  trim_scale(-r.receipts_php)                   AS running_balance_php
FROM r
WHERE r.supplier_code IS NULL;

COMMENT ON VIEW cenapro.view_rc_supplier_balance IS
  'THE Cenapro liquidation balance: one row per RC supplier — what CI owes for that trader''s '
  'PRICEABLE receipts, what CI has paid, and the running difference. Aggregates from the '
  'beginning of time and has NO period boundary at all (closing a balance is a human-initiated '
  'marker — Step 6, cenapro.rc_balance_period). Group membership comes from '
  'cenapro.view_rc_supplier_group; the signed effect of each payment comes from '
  'cenapro.view_rc_payment. Carries ONE extra row where is_unassigned = true and supplier_code IS '
  'NULL, holding the receipts that have no payee and therefore cannot be liquidated at all — it '
  'exists only while such receipts do. NO rounds_to_php and NO within_rounding: decision 8 killed '
  'the per-supplier rounding rule, and A NON-ZERO BALANCE IS NEVER AN ERROR STATE. Entirely '
  '₱-bearing — every consumer is behind canViewPrices().';

COMMENT ON COLUMN cenapro.view_rc_supplier_balance.running_balance_php IS
  'payments_php - receipts_php. **NEGATIVE MEANS WE OWE THE SUPPLIER; POSITIVE MEANS THE SUPPLIER '
  'OWES US.** This is Renzo''s convention verbatim (decision 5) and it is the OPPOSITE of the '
  'accounts-payable sign an accountant would write — the screen serves his mental model. Do not '
  're-derive it backwards. It is routinely and legitimately non-zero: a trader who takes a round '
  'cheque against an odd receipt is CARRYING the remainder, not being paid short, and that is '
  'never an error state.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.receipts_php IS
  'SUM of total_price_php over PRICEABLE receipts only (cenapro.rc_delivery_is_priceable). An '
  'unweighed or unpriced receipt is an INCOMPLETE ENTRY, not ₱0 payable (decision 10). Numerically '
  'this equals SUM(total_price_php) today, because the generated column COALESCEs a missing factor '
  'to 0 — so the hole a naive balance opens is invisible in pesos and shows up ONLY as '
  'unpriced_receipt_count. Never drop the filter as redundant.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.payments_php IS
  'The SIGNED net that enters the balance: outgoing counts +, incoming counts -, and an '
  '`adjustment` write-off participates exactly like a payment because forgiving a remainder does '
  'settle it. Invariant: payments_php = cash_out_php - cash_in_php + adjustment_php, i.e. '
  'cash_net_php + adjustment_php. The cash_* columns exist so a cash-flow screen never has to '
  'work out which movements were real money.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.unpriced_receipt_count IS
  'Receipts this balance COULD NOT PRICE, so the screen can say its own number is incomplete. '
  'Partitioned exhaustively by unpriced_awaiting_weight_count (priced, not yet weighed — the '
  'normal daily state of a fresh in-app receipt), unpriced_awaiting_price_count (weighed, no price '
  'agreed) and unpriced_awaiting_both_count. This will never sit at zero for long.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.unpriced_receipt_kg IS
  'Payable (net) kilos among the unpriced receipts. A receipt with no weight at all contributes 0 '
  'because there is nothing to report — read it together with unpriced_awaiting_weight_count.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.is_unassigned IS
  'TRUE on the single synthetic row that holds receipts with no supplier_code. Those receipts have '
  'no payee, so no payment can ever point at them and their balance is simply minus what they are '
  'worth. Render it as "cannot be liquidated - no payee recorded", never as a trader. Key rows on '
  'this flag, not on supplier_code, which is NULL here.';

REVOKE ALL ON cenapro.view_rc_supplier_balance FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_supplier_balance TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 12. THE GROUP ROLLUP — cenapro.view_rc_supplier_group_balance
-- ═════════════════════════════════════════════════════════════════════════════════
-- Renzo's screen shows BOTH levels: each trader's own number AND a group total for the
-- parent (§5a). Built ON TOP of the per-supplier view rather than beside it, so the two
-- can never disagree — and in SQL rather than a TypeScript reduce(), per CLAUDE.md.
-- Every measure is linear, so summing the rows is exactly summing the underlying facts.
CREATE OR REPLACE VIEW cenapro.view_rc_supplier_group_balance
WITH (security_invoker = true)
AS
SELECT
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

  -- Identical to sum(payments) - sum(receipts) by linearity; written as the sum of the
  -- member rows so "the group total is the sum of what is on screen" is literally true.
  trim_scale(sum(b.running_balance_php))        AS running_balance_php
FROM cenapro.view_rc_supplier_balance b
GROUP BY b.group_code, b.is_unassigned;

COMMENT ON VIEW cenapro.view_rc_supplier_group_balance IS
  'cenapro.view_rc_supplier_balance rolled up by group_code — one row per cheque-payee GROUP, so a '
  'parent trader shows a single number covering its sub-suppliers while each child keeps its own '
  'row in the per-supplier view. A root trader is its own group of one. The unassigned bucket '
  'appears here too, with group_code IS NULL and is_unassigned = true. Same sign convention: '
  'NEGATIVE = we owe the group.';
COMMENT ON COLUMN cenapro.view_rc_supplier_group_balance.running_balance_php IS
  'The GROUP total. NEGATIVE = we owe the group; POSITIVE = the group owes us (decision 5). Equals '
  'the sum of its members'' running_balance_php exactly, so a screen showing both levels always '
  'adds up.';

REVOKE ALL ON cenapro.view_rc_supplier_group_balance FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_supplier_group_balance TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 13. PUBLIC ACCESSORS — `cenapro` is not exposed to PostgREST
-- ═════════════════════════════════════════════════════════════════════════════════
-- ALL READ-ONLY (decision 7). Unlike public.cenapro_rc_suppliers, none of these is a
-- write door: every mutation goes through the RPCs in section 14, which allowlist the
-- patch and compare-and-set the row_version in the same statement as the write.
CREATE OR REPLACE VIEW public.cenapro_rc_banks
WITH (security_invoker = true) AS
SELECT b.code, b.display_name, b.sort_order, b.active, b.notes,
       b.row_version, b.created_at, b.updated_at
  FROM cenapro.rc_bank b;

COMMENT ON VIEW public.cenapro_rc_banks IS
  'Public READ-ONLY accessor for cenapro.rc_bank (CI''s own banks). Write through '
  'public.cenapro_save_rc_bank(); retire a bank with active = false, never a DELETE.';

CREATE OR REPLACE VIEW public.cenapro_rc_bank_accounts
WITH (security_invoker = true) AS
SELECT a.id, a.bank_code, a.bank_display_name, a.bank_active, a.bank_sort_order,
       a.account_label, a.account_no, a.display_label,
       a.active, a.sort_order, a.notes,
       a.row_version, a.created_at, a.updated_at
  FROM cenapro.view_rc_bank_account a;

COMMENT ON VIEW public.cenapro_rc_bank_accounts IS
  'Public READ-ONLY accessor for cenapro.view_rc_bank_account — CI bank accounts with their bank '
  'name. Write through public.cenapro_save_rc_bank_account(). There is deliberately no delete '
  'path: an account is a cheque book''s home and historic cheques must keep naming it.';

CREATE OR REPLACE VIEW public.cenapro_rc_payments
WITH (security_invoker = true) AS
SELECT v.* FROM cenapro.view_rc_payment v;

COMMENT ON VIEW public.cenapro_rc_payments IS
  'Public READ-ONLY accessor for cenapro.view_rc_payment. Soft-deleted rows are INCLUDED — filter '
  'NOT is_deleted for anything numeric. Write through public.cenapro_save_rc_payment() / '
  'cenapro_delete_rc_payment() / cenapro_restore_rc_payment(). ENTIRELY ₱-BEARING: gate every '
  'server action on canViewPrices().';

CREATE OR REPLACE VIEW public.cenapro_rc_payment_audit
WITH (security_invoker = true) AS
SELECT a.id, a.payment_id, a.supplier_code, a.payment_date, a.method, a.amount_php,
       a.cheque_no, a.operation, a.changed, a.snapshot, a.source,
       a.changed_at, a.changed_by, a.changed_by_role
  FROM cenapro.rc_payment_audit a;

COMMENT ON VIEW public.cenapro_rc_payment_audit IS
  'Read-only window onto cenapro.rc_payment_audit — the per-payment change history. Filter by '
  'payment_id for one cheque''s whole story; `changed ? ''deleted_at''` finds voids and restores. '
  'NOTE the ₱ trap (§3.2): `changed` and `snapshot` are free-form jsonb carrying amount_php, and '
  'stripPrices() nulls named fields on a row shape — it can never reach inside a blob. Any action '
  'exposing this must delete the ₱ keys OUT OF THE JSONB when !canViewPrices().';

CREATE OR REPLACE VIEW public.cenapro_rc_supplier_balances
WITH (security_invoker = true) AS
SELECT b.* FROM cenapro.view_rc_supplier_balance b;

COMMENT ON VIEW public.cenapro_rc_supplier_balances IS
  'Public READ-ONLY accessor for cenapro.view_rc_supplier_balance — "what do we owe this trader". '
  'running_balance_php NEGATIVE = we owe them. Includes the is_unassigned row for receipts with no '
  'payee. Entirely ₱-bearing.';

CREATE OR REPLACE VIEW public.cenapro_rc_supplier_group_balances
WITH (security_invoker = true) AS
SELECT b.* FROM cenapro.view_rc_supplier_group_balance b;

COMMENT ON VIEW public.cenapro_rc_supplier_group_balances IS
  'Public READ-ONLY accessor for cenapro.view_rc_supplier_group_balance — the same measures rolled '
  'up per cheque-payee group, for the parent rows of the balance screen. Entirely ₱-bearing.';

REVOKE ALL ON public.cenapro_rc_banks                   FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_bank_accounts           FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_payments                FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_payment_audit           FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_supplier_balances       FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_supplier_group_balances FROM anon, authenticated, service_role;

GRANT SELECT ON public.cenapro_rc_banks                   TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_bank_accounts           TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_payments                TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_payment_audit           TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_supplier_balances       TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_supplier_group_balances TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 14. THE WRITE PATH
-- ═════════════════════════════════════════════════════════════════════════════════
-- All: SECURITY INVOKER, `SET search_path = ''` with everything schema-qualified,
-- EXECUTE revoked from PUBLIC and anon then granted to authenticated + service_role.
-- Patch-shaped with an ALLOWLIST THAT REFUSES THE WHOLE CALL ON AN UNKNOWN KEY — never
-- ignore a key, never silently drop one. Compare-and-set on row_version IN THE SAME
-- STATEMENT AS THE WRITE; a blind write is refused. Same outcome vocabulary as the rest
-- of the module, so a caller learns one language:
--     inserted | updated | deleted | restored | version_conflict | not_found |
--     unsupported_field | invalid
-- EVERY refusal carries a human-readable `message` — these land straight in a toast.

-- ── 14a. Banks ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cenapro_save_rc_bank(
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
  -- `code` is absent on purpose: re-keying a bank cascades into every account under it.
  -- That is a data-migration act, not a cell edit.
  c_allowed constant text[] := ARRAY['display_name', 'sort_order', 'active', 'notes'];
  v_bad     text[];
  v_cur     cenapro.rc_bank;
  v_new     cenapro.rc_bank;
  v_code    text;
  v_version integer;
  v_current integer;
BEGIN
  IF p_code IS NULL OR pg_catalog.btrim(p_code) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid', 'message', 'A bank code is required.');
  END IF;

  IF p_patch IS NULL OR pg_catalog.jsonb_typeof(p_patch) <> 'object' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'p_patch must be a JSON object of column -> value.');
  END IF;

  SELECT pg_catalog.array_agg(k) INTO v_bad
    FROM pg_catalog.jsonb_object_keys(p_patch) AS k
   WHERE k <> ALL (c_allowed);

  IF v_bad IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'unsupported_field', 'fields', pg_catalog.to_jsonb(v_bad),
      'message', 'Refused: ' || pg_catalog.array_to_string(v_bad, ', ')
                 || ' is not an editable bank field. Editable: '
                 || pg_catalog.array_to_string(c_allowed, ', ')
                 || '. The bank code itself cannot be changed here.');
  END IF;

  IF p_patch ? 'display_name'
     AND pg_catalog.btrim(coalesce(p_patch ->> 'display_name', '')) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'A bank needs a display name - it cannot be blank.');
  END IF;

  IF p_expected_row_version IS NULL THEN
    v_new := pg_catalog.jsonb_populate_record(NULL::cenapro.rc_bank, p_patch);
    BEGIN
      INSERT INTO cenapro.rc_bank AS t (code, display_name, sort_order, active, notes)
      VALUES (p_code, coalesce(v_new.display_name, p_code),
              coalesce(v_new.sort_order, 0), coalesce(v_new.active, true), v_new.notes)
      RETURNING t.code, t.row_version INTO v_code, v_version;
    EXCEPTION
      WHEN unique_violation THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'invalid',
          'message', pg_catalog.format(
            'A bank with the code "%s" already exists. Edit that one instead.', p_code));
      WHEN check_violation THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'invalid', 'message', SQLERRM);
    END;

    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'inserted', 'code', v_code, 'row_version', v_version);
  END IF;

  SELECT * INTO v_cur FROM cenapro.rc_bank b WHERE b.code = p_code;
  IF v_cur.code IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found',
      'message', pg_catalog.format('There is no bank with the code "%s". Reload the bank list.',
                                   p_code));
  END IF;

  v_new := pg_catalog.jsonb_populate_record(v_cur, p_patch);

  BEGIN
    UPDATE cenapro.rc_bank AS t
       SET display_name = v_new.display_name,
           sort_order   = coalesce(v_new.sort_order, 0),
           active       = coalesce(v_new.active, true),
           notes        = v_new.notes
     WHERE t.code        = p_code
       AND t.row_version = p_expected_row_version
    RETURNING t.code, t.row_version INTO v_code, v_version;
  EXCEPTION
    WHEN check_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid', 'message', SQLERRM);
  END;

  IF v_code IS NULL THEN
    SELECT b.row_version INTO v_current FROM cenapro.rc_bank b WHERE b.code = p_code;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found',
        'message', pg_catalog.format('"%s" no longer exists.', p_code));
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', pg_catalog.format(
        'Someone else changed "%s" while you were editing. Reload to see their values.', p_code));
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'updated', 'code', v_code, 'row_version', v_version);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_save_rc_bank(text, integer, jsonb) IS
  'Save one of CI''s banks. p_expected_row_version NULL => INSERT with code p_code; otherwise '
  'UPDATE gated on that version in the same statement as the write. Allowlist: display_name, '
  'sort_order, active, notes — an unknown key refuses the whole call, and `code` is not editable. '
  'There is no delete: retire a bank with active = false. Outcomes: inserted | updated | '
  'version_conflict | not_found | unsupported_field | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_save_rc_bank(text, integer, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_save_rc_bank(text, integer, jsonb) TO authenticated, service_role;


-- ── 14b. Bank accounts ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cenapro_save_rc_bank_account(
  p_id                   uuid    DEFAULT NULL,
  p_expected_row_version integer DEFAULT NULL,
  p_patch                jsonb   DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  c_allowed constant text[] := ARRAY[
    'bank_code', 'account_label', 'account_no', 'active', 'sort_order', 'notes'];
  v_bad     text[];
  v_cur     cenapro.rc_bank_account;
  v_new     cenapro.rc_bank_account;
  v_id      uuid;
  v_version integer;
  v_current integer;
  v_ok      boolean;
BEGIN
  IF p_patch IS NULL OR pg_catalog.jsonb_typeof(p_patch) <> 'object' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'p_patch must be a JSON object of column -> value.');
  END IF;

  SELECT pg_catalog.array_agg(k) INTO v_bad
    FROM pg_catalog.jsonb_object_keys(p_patch) AS k
   WHERE k <> ALL (c_allowed);

  IF v_bad IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'unsupported_field', 'fields', pg_catalog.to_jsonb(v_bad),
      'message', 'Refused: ' || pg_catalog.array_to_string(v_bad, ', ')
                 || ' is not an editable bank-account field. Editable: '
                 || pg_catalog.array_to_string(c_allowed, ', ') || '.');
  END IF;

  IF p_id IS NULL THEN
    IF p_expected_row_version IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'p_expected_row_version must be NULL when creating a bank account.');
    END IF;
    v_new := pg_catalog.jsonb_populate_record(NULL::cenapro.rc_bank_account, p_patch);
  ELSE
    IF p_expected_row_version IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'p_expected_row_version is required when updating - a blind write is refused.');
    END IF;

    SELECT * INTO v_cur FROM cenapro.rc_bank_account a WHERE a.id = p_id;
    IF v_cur.id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found',
        'message', 'That bank account no longer exists. Reload the account list.');
    END IF;
    v_new := pg_catalog.jsonb_populate_record(v_cur, p_patch);
  END IF;

  IF v_new.bank_code IS NULL OR pg_catalog.btrim(v_new.bank_code) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'A bank account must name the bank it belongs to.');
  END IF;

  SELECT true INTO v_ok FROM cenapro.rc_bank b WHERE b.code = v_new.bank_code;
  IF v_ok IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format('There is no bank with the code "%s". Add that bank first.',
                                   v_new.bank_code));
  END IF;

  IF v_new.account_label IS NULL OR pg_catalog.btrim(v_new.account_label) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'A bank account needs a label, e.g. "current - Cebu".');
  END IF;

  IF p_id IS NULL THEN
    BEGIN
      INSERT INTO cenapro.rc_bank_account AS t
        (bank_code, account_label, account_no, active, sort_order, notes)
      VALUES
        (v_new.bank_code, v_new.account_label, v_new.account_no,
         coalesce(v_new.active, true), coalesce(v_new.sort_order, 0), v_new.notes)
      RETURNING t.id, t.row_version INTO v_id, v_version;
    EXCEPTION
      WHEN unique_violation THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'invalid',
          'message', pg_catalog.format(
            'There is already an account like that under "%s" - the label and the account number '
            || 'each have to be unique within a bank.', v_new.bank_code));
      WHEN check_violation THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'invalid', 'message', SQLERRM);
    END;

    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'inserted', 'id', v_id, 'row_version', v_version);
  END IF;

  BEGIN
    UPDATE cenapro.rc_bank_account AS t
       SET bank_code     = v_new.bank_code,
           account_label = v_new.account_label,
           account_no    = v_new.account_no,
           active        = coalesce(v_new.active, true),
           sort_order    = coalesce(v_new.sort_order, 0),
           notes         = v_new.notes
     WHERE t.id          = p_id
       AND t.row_version = p_expected_row_version
    RETURNING t.id, t.row_version INTO v_id, v_version;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', pg_catalog.format(
          'There is already an account like that under "%s" - the label and the account number '
          || 'each have to be unique within a bank.', v_new.bank_code));
    WHEN check_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid', 'message', SQLERRM);
  END;

  IF v_id IS NULL THEN
    SELECT a.row_version INTO v_current FROM cenapro.rc_bank_account a WHERE a.id = p_id;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found',
        'message', 'That bank account no longer exists.');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this bank account while you were editing. Reload to see '
                 || 'their values.');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'updated', 'id', v_id, 'row_version', v_version);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_save_rc_bank_account(uuid, integer, jsonb) IS
  'Save one CI bank account (a cheque book''s home). p_id NULL => INSERT; otherwise UPDATE gated '
  'on p_expected_row_version in the same statement as the write. Allowlist: bank_code, '
  'account_label, account_no, active, sort_order, notes — an unknown key refuses the whole call. '
  'There is no delete path on purpose: historic cheques must keep naming their account, so retire '
  'with active = false. Outcomes: inserted | updated | version_conflict | not_found | '
  'unsupported_field | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_save_rc_bank_account(uuid, integer, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_save_rc_bank_account(uuid, integer, jsonb) TO authenticated, service_role;


-- ── 14c. Payments ────────────────────────────────────────────────────────────────
-- The merged row is validated ONCE, after the patch is folded over the current values,
-- so a patch that changes only `method` still has its cheque shape checked against the
-- fields it did not mention. Validating the patch alone is how a half-shaped row gets
-- through.
CREATE OR REPLACE FUNCTION public.cenapro_save_rc_payment(
  p_id                   uuid    DEFAULT NULL,
  p_expected_row_version integer DEFAULT NULL,
  p_patch                jsonb   DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  -- deleted_at / deleted_by are ABSENT: voiding a payment is its own RPC, so a patch
  -- can never forge or silently undo a deletion. row_version and the actor/timestamp
  -- columns belong to the touch trigger.
  c_allowed constant text[] := ARRAY[
    'supplier_code', 'payment_date', 'method', 'amount_php', 'direction', 'stated_term',
    'bank_account_id', 'cheque_no', 'cheque_date', 'reference_no', 'remarks'];
  v_bad        text[];
  v_cur        cenapro.rc_payment;
  v_new        cenapro.rc_payment;
  v_id         uuid;
  v_version    integer;
  v_current    integer;
  v_ok         boolean;
  v_constraint text;
BEGIN
  IF p_patch IS NULL OR pg_catalog.jsonb_typeof(p_patch) <> 'object' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'p_patch must be a JSON object of column -> value.');
  END IF;

  SELECT pg_catalog.array_agg(k) INTO v_bad
    FROM pg_catalog.jsonb_object_keys(p_patch) AS k
   WHERE k <> ALL (c_allowed);

  IF v_bad IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'unsupported_field', 'fields', pg_catalog.to_jsonb(v_bad),
      'message', 'Refused: ' || pg_catalog.array_to_string(v_bad, ', ')
                 || ' is not an editable payment field. Editable: '
                 || pg_catalog.array_to_string(c_allowed, ', ')
                 || '. Voiding a payment is done with cenapro_delete_rc_payment().');
  END IF;

  -- ── build the merged row ───────────────────────────────────────────────────────
  IF p_id IS NULL THEN
    IF p_expected_row_version IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'p_expected_row_version must be NULL when recording a new payment.');
    END IF;
    v_new           := pg_catalog.jsonb_populate_record(NULL::cenapro.rc_payment, p_patch);
    v_new.direction := coalesce(v_new.direction, 'outgoing');
  ELSE
    IF p_expected_row_version IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'p_expected_row_version is required when updating - a blind write is refused.');
    END IF;

    SELECT * INTO v_cur FROM cenapro.rc_payment x WHERE x.id = p_id;
    IF v_cur.id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found',
        'message', 'That payment no longer exists. Reload the payment list.');
    END IF;
    IF v_cur.deleted_at IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', pg_catalog.format(
          'That payment was deleted on %s. Restore it before editing.',
          pg_catalog.to_char(v_cur.deleted_at, 'YYYY-MM-DD HH24:MI')));
    END IF;
    v_new := pg_catalog.jsonb_populate_record(v_cur, p_patch);
  END IF;

  -- ── validate the MERGED row ────────────────────────────────────────────────────
  IF v_new.supplier_code IS NULL OR pg_catalog.btrim(v_new.supplier_code) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'A payment must name the supplier it was made out to - the running balance is '
                 || 'per supplier, so a payment with no payee has nowhere to go.');
  END IF;

  SELECT true INTO v_ok FROM cenapro.rc_supplier s WHERE s.code = v_new.supplier_code;
  IF v_ok IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format(
        'There is no supplier with the code "%s". Add that trader first, then record the payment.',
        v_new.supplier_code));
  END IF;

  IF v_new.payment_date IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'A payment needs the date the money was released.');
  END IF;

  IF v_new.method IS NULL OR v_new.method NOT IN ('cheque', 'bank_transfer', 'adjustment') THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Method must be cheque, bank_transfer or adjustment. There is no cash method, '
                 || 'and "adjustment" means no cash moved - it is how a remainder is written off.');
  END IF;

  IF v_new.direction IS NULL OR v_new.direction NOT IN ('outgoing', 'incoming') THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Direction must be outgoing (we paid them) or incoming (money came back).');
  END IF;

  IF v_new.stated_term IS NOT NULL
     AND v_new.stated_term NOT IN ('downpayment', 'full', 'straight', 'cash_advance') THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Stated term must be downpayment, full, straight or cash_advance - or left '
                 || 'empty. It records intent only; no balance is computed from it.');
  END IF;

  IF v_new.amount_php IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid', 'message', 'A payment needs an amount.');
  END IF;

  IF v_new.amount_php <= 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'The amount must be greater than zero. Money coming back is recorded by setting '
                 || 'direction to "incoming", never by a negative amount.');
  END IF;

  IF v_new.method = 'cheque' THEN
    IF pg_catalog.btrim(coalesce(v_new.cheque_no, '')) = '' THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'A cheque needs its cheque number - it is half of how the cheque is '
                   || 'identified.');
    END IF;
    IF v_new.bank_account_id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'A cheque needs the account it was drawn on. A cheque number is only unique '
                   || 'within one account, and skipped-number checks are per cheque book.');
    END IF;
  ELSE
    IF v_new.cheque_no IS NOT NULL OR v_new.cheque_date IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', pg_catalog.format(
          'A %s carries no cheque number or cheque date. Clear them, or change the method to '
          || 'cheque.', v_new.method));
    END IF;
  END IF;

  IF v_new.bank_account_id IS NOT NULL THEN
    SELECT true INTO v_ok FROM cenapro.rc_bank_account a WHERE a.id = v_new.bank_account_id;
    IF v_ok IS NOT TRUE THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'That bank account does not exist. Reload the account list.');
    END IF;
  END IF;

  -- ── write ──────────────────────────────────────────────────────────────────────
  IF p_id IS NULL THEN
    BEGIN
      INSERT INTO cenapro.rc_payment AS t (
        supplier_code, payment_date, method, amount_php, direction, stated_term,
        bank_account_id, cheque_no, cheque_date, reference_no, remarks
      ) VALUES (
        v_new.supplier_code, v_new.payment_date, v_new.method, v_new.amount_php,
        v_new.direction, v_new.stated_term,
        v_new.bank_account_id, v_new.cheque_no, v_new.cheque_date, v_new.reference_no,
        v_new.remarks
      )
      RETURNING t.id, t.row_version INTO v_id, v_version;
    EXCEPTION
      WHEN unique_violation THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'invalid',
          'message', pg_catalog.format(
            'Cheque #%s has already been recorded against that account. A cheque number is unique '
            || 'per account - check whether this cheque is already in the list.', v_new.cheque_no));
      WHEN foreign_key_violation THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'invalid',
          'message', 'The supplier or bank account named on this payment no longer exists. '
                     || 'Reload and try again.');
      WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        RETURN pg_catalog.jsonb_build_object(
          'ok', false, 'outcome', 'invalid', 'constraint', v_constraint, 'message', SQLERRM);
    END;

    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'inserted', 'id', v_id, 'row_version', v_version);
  END IF;

  BEGIN
    UPDATE cenapro.rc_payment AS t
       SET supplier_code   = v_new.supplier_code,
           payment_date    = v_new.payment_date,
           method          = v_new.method,
           amount_php      = v_new.amount_php,
           direction       = v_new.direction,
           stated_term     = v_new.stated_term,
           bank_account_id = v_new.bank_account_id,
           cheque_no       = v_new.cheque_no,
           cheque_date     = v_new.cheque_date,
           reference_no    = v_new.reference_no,
           remarks         = v_new.remarks
     WHERE t.id          = p_id
       AND t.row_version = p_expected_row_version
       AND t.deleted_at IS NULL
    RETURNING t.id, t.row_version INTO v_id, v_version;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', pg_catalog.format(
          'Cheque #%s has already been recorded against that account. A cheque number is unique '
          || 'per account.', v_new.cheque_no));
    WHEN foreign_key_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'The supplier or bank account named on this payment no longer exists. '
                   || 'Reload and try again.');
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid', 'constraint', v_constraint, 'message', SQLERRM);
  END;

  IF v_id IS NULL THEN
    SELECT x.row_version INTO v_current FROM cenapro.rc_payment x WHERE x.id = p_id;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found', 'message', 'That payment no longer exists.');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this payment while you were editing. Reload to see their '
                 || 'values.');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'updated', 'id', v_id, 'row_version', v_version);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_save_rc_payment(uuid, integer, jsonb) IS
  'Save one Cenapro RC payment. p_id NULL => INSERT; otherwise UPDATE gated on '
  'p_expected_row_version in the same statement as the write (and refused outright on a '
  'soft-deleted row). The MERGED row is validated, not the patch, so changing only `method` still '
  're-checks the cheque shape. Patch keys are allowlisted; deleted_at/deleted_by are deliberately '
  'absent — voiding is cenapro_delete_rc_payment(). Outcomes: inserted | updated | '
  'version_conflict | not_found | unsupported_field | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_save_rc_payment(uuid, integer, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_save_rc_payment(uuid, integer, jsonb) TO authenticated, service_role;


-- ── 14d. Void a payment (SOFT delete) ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cenapro_delete_rc_payment(
  p_id                   uuid,
  p_expected_row_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_cur     cenapro.rc_payment;
  v_id      uuid;
  v_version integer;
  v_current integer;
BEGIN
  IF p_id IS NULL OR p_expected_row_version IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Both p_id and p_expected_row_version are required - a blind delete is refused.');
  END IF;

  SELECT * INTO v_cur FROM cenapro.rc_payment x WHERE x.id = p_id;
  IF v_cur.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found', 'message', 'That payment is already gone.');
  END IF;

  IF v_cur.deleted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format('That payment was already deleted on %s.',
                                   pg_catalog.to_char(v_cur.deleted_at, 'YYYY-MM-DD HH24:MI')));
  END IF;

  -- SOFT. A payment is a money record (decision 5c), so the row stays and every balance
  -- filters deleted_at IS NULL. Undo with cenapro_restore_rc_payment().
  UPDATE cenapro.rc_payment AS t
     SET deleted_at = now(),
         deleted_by = auth.uid()
   WHERE t.id          = p_id
     AND t.row_version = p_expected_row_version
     AND t.deleted_at IS NULL
  RETURNING t.id, t.row_version INTO v_id, v_version;

  IF v_id IS NULL THEN
    SELECT x.row_version INTO v_current FROM cenapro.rc_payment x WHERE x.id = p_id;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found', 'message', 'That payment is already gone.');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this payment while you were looking at it. Reload before '
                 || 'deleting.');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'deleted', 'id', v_id, 'row_version', v_version, 'soft', true);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_delete_rc_payment(uuid, integer) IS
  'SOFT-delete one Cenapro RC payment: stamps deleted_at/deleted_by, gated on '
  'p_expected_row_version in the same statement as the write. The row stays — it is a money '
  'record, not transcribed reference data (decision 5c) — and every balance filters it out. The '
  'freed cheque number becomes re-usable, because the cheque unique index is partial on '
  'deleted_at IS NULL. Reversible with cenapro_restore_rc_payment(). Outcomes: deleted | '
  'version_conflict | not_found | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_delete_rc_payment(uuid, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_delete_rc_payment(uuid, integer) TO authenticated, service_role;


-- ── 14e. Un-void a payment ───────────────────────────────────────────────────────
-- §5c asked for reverting to be robust THROUGHOUT this feature. A soft delete you
-- cannot undo is not reversibility, so the restore is part of Step 3, not a follow-up.
-- Its own function rather than a third argument on the delete, so the delete keeps the
-- signature the brief specified and neither call can be mistaken for the other.
CREATE OR REPLACE FUNCTION public.cenapro_restore_rc_payment(
  p_id                   uuid,
  p_expected_row_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_cur     cenapro.rc_payment;
  v_id      uuid;
  v_version integer;
  v_current integer;
BEGIN
  IF p_id IS NULL OR p_expected_row_version IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Both p_id and p_expected_row_version are required - a blind restore is refused.');
  END IF;

  SELECT * INTO v_cur FROM cenapro.rc_payment x WHERE x.id = p_id;
  IF v_cur.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found',
      'message', 'That payment no longer exists - it was removed permanently, not just deleted.');
  END IF;

  IF v_cur.deleted_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'That payment is not deleted, so there is nothing to restore.');
  END IF;

  BEGIN
    UPDATE cenapro.rc_payment AS t
       SET deleted_at = NULL,
           deleted_by = NULL
     WHERE t.id          = p_id
       AND t.row_version = p_expected_row_version
       AND t.deleted_at IS NOT NULL
    RETURNING t.id, t.row_version INTO v_id, v_version;
  EXCEPTION
    -- The cheque number was re-used while this one sat deleted. Refuse rather than
    -- resurrect a second live cheque with the same number on the same account.
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', pg_catalog.format(
          'Cheque #%s was recorded again on that account after this one was deleted, so restoring '
          || 'it would duplicate the number. Change the number on one of them first.',
          v_cur.cheque_no));
  END;

  IF v_id IS NULL THEN
    SELECT x.row_version INTO v_current FROM cenapro.rc_payment x WHERE x.id = p_id;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found', 'message', 'That payment no longer exists.');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this payment while you were looking at it. Reload before '
                 || 'restoring.');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'restored', 'id', v_id, 'row_version', v_version);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_restore_rc_payment(uuid, integer) IS
  'Un-void a soft-deleted Cenapro RC payment, gated on p_expected_row_version in the same '
  'statement as the write. Refuses if the cheque number was re-used on the same account while '
  'this one sat deleted. Exists because §5c asked for reverting to be robust throughout the '
  'feature - a soft delete that cannot be undone is not reversibility. Outcomes: restored | '
  'version_conflict | not_found | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_restore_rc_payment(uuid, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_restore_rc_payment(uuid, integer) TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 15. BANK SEED — the four banks in Renzo's notes
-- ═════════════════════════════════════════════════════════════════════════════════
-- Idempotent: ON CONFLICT DO NOTHING, so a re-run never overwrites a display name or an
-- active flag a human has since edited — the same discipline as the supplier and
-- destination seeds. NO accounts are seeded: an account number is a real fact about a
-- real cheque book and inventing one would be exactly the kind of fabrication the audit
-- discipline exists to prevent. NO payments are seeded either; the ledger starts empty.
INSERT INTO cenapro.rc_bank (code, display_name, sort_order) VALUES
  ('BDO',       'BDO',        10),
  ('CHINABANK', 'CHINABANK',  20),
  ('METROBANK', 'METROBANK',  30),
  ('AUB',       'AUB',        40)
ON CONFLICT (code) DO NOTHING;
