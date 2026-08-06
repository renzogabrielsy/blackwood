-- ─────────────────────────────────────────────────────────────────────────────────
-- Cenapro (Tenant #2) — SUPPLIER OPENING BALANCES. Liquidation Step 3b.
--
-- WHY THIS EXISTS. Renzo, 2026-08-06: "Since it's a bit impossible to check all of the
-- past history, we should be able to modify the starting balances of the suppliers we
-- have listed. I think that's imperative."
--
-- Step 3 shipped an hour before this one and its balance sums EVERY receipt since
-- January, so it says CI owes BRIX ₱212,669,462.50 — the entire year's purchases —
-- because no historic cheque was ever entered and back-entering seven months of them is
-- not realistic. THE OPENING BALANCE IS HOW THAT NUMBER BECOMES TRUE: Renzo states what
-- is actually outstanding as of a date, and the system counts forward from there.
--
-- ═══ THE AS-OF RULE — stated once, and nothing may contradict it ══════════════════
--     THE OPENING BALANCE STANDS FOR EVERYTHING STRICTLY BEFORE `as_of_date`.
--     RECEIPTS AND PAYMENTS DATED ON OR AFTER `as_of_date` COUNT FRESH ON TOP OF IT.
-- That is the natural reading of "as of 1 August the balance was X": the 1 August truck
-- has not been paid for by a figure quoted on the morning of 1 August. The boundary is
-- therefore `>=` (fresh) / `<` (carried), never `>`; it is repeated verbatim in the
-- table COMMENT, the column COMMENTs and both balance views' COMMENTs.
--
-- ═══ APPEND-ONLY: "MODIFY" MEANS APPEND A REVISION ═══════════════════════════════
-- Cloned from cenapro.warehouse_opening_balance (20260601113342), which solved the same
-- problem for flec counts: every "set" is a NEW ROW and nothing is ever UPDATEd or
-- DELETEd. Renzo will revise these numbers as suppliers confirm them, and a money
-- history that can be silently rewritten is worth nothing. Enforced twice over — no
-- UPDATE/DELETE privilege for any client role, AND no UPDATE/DELETE policy under RLS —
-- so a future blanket `GRANT ... ON ALL TABLES IN SCHEMA cenapro` still cannot rewrite a
-- revision.
--
-- ONE DELIBERATE DIVERGENCE FROM THE FLEC PRECEDENT. warehouse_opening_balance resolves
-- "current" as the latest EFFECTIVE row (greatest period_start_date <= the date you are
-- asking about) because its consumer is a ledger scoped to an arbitrary start date.
-- Here the current opening balance is simply THE LATEST REVISION — greatest `id`, which
-- is a bigint identity and therefore both monotone and tie-free. That is what makes
-- "revising history downward" work: a correction whose as_of_date is EARLIER than the
-- revision it replaces must still win, because it is the newer statement of fact.
--
-- ═══ THE REGRESSION GUARANTEE ════════════════════════════════════════════════════
-- A SUPPLIER WITH NO OPENING BALANCE BEHAVES EXACTLY AS IT DID BEFORE THIS MIGRATION.
-- All 12 suppliers plus the synthetic no-payee row are in that state today, so the whole
-- 13-row balance read is byte-identical after the change — measured, not assumed:
-- md5 over the previous 30-column projection = 0e63751b7573b610146393928096f82f before
-- and after; the group view's 27-column projection = 698408774f75cc97303a4320cfac45dc.
-- Mechanically this holds because `as_of_date IS NULL` collapses every windowed
-- aggregate to its unwindowed form and every carried aggregate to zero.
--
-- ═══ FOUR DECISIONS THE BRIEF LEFT OPEN ══════════════════════════════════════════
--
-- 1. NOTHING THAT EXISTS TODAY LOSES ITS NAME OR ITS VALUE — the full-history figures
--    are PRESERVED beside the windowed ones as `receipts_all_php` / `payments_all_php` /
--    `running_balance_all_php` (+ the all-time counts and cash decomposition). Losing
--    them would make the opening balance UNAUDITABLE: you could never again ask "what
--    does the raw history say, and what did my stated figure change?" The identity that
--    ties the two together is checkable in one line, and is stated on the column:
--        running_balance_php - running_balance_all_php
--          = opening_balance_php + carried_receipt_php - carried_payment_php
--
-- 2. `carried_*` IS WHAT MAKES AN OPENING BALANCE DEFENSIBLE LATER. Without it nobody
--    can ever check the number: with it the screen can say "this ₱4.2M stands in for 268
--    receipts worth ₱198M and 12 payments worth ₱190M." The COUNT is every receipt
--    before the cutoff; the PESOS are the priceable ones only, exactly as
--    receipt_count / receipts_php relate. Two closed invariants fall out:
--        receipt_count_all = receipt_count + carried_receipt_count
--        receipts_all_php  = receipts_php  + carried_receipt_php
--    (and the same pair for payments). They are closed because `is_carried` is computed
--    ONCE PER ROW as a strict boolean — see decision 4.
--
-- 3. THE UNPRICED COUNTS STAY ALL-TIME UNDER THEIR EXISTING NAMES, and the windowed
--    ones are the NEW columns (`unpriced_receipt_count_window` / `_kg_window`). This is
--    a deliberate asymmetry with the money columns and it is the whole point:
--    AN UNPRICED RECEIPT FROM BEFORE THE CUTOFF CANNOT HAVE BEEN FOLDED INTO THE OPENING
--    BALANCE, BECAUSE NOBODY KNOWS WHAT IT IS WORTH. Had `unpriced_receipt_count` been
--    windowed, setting an opening balance would have made SEVILLA's two unpriceable
--    receipts vanish from the screen while they were still unpriceable and still not
--    covered by anything — the exact silent hole that Step 3's header spends forty lines
--    refusing to open. The three-way awaiting_weight / awaiting_price / awaiting_both
--    split stays on the all-time (primary) count.
--
-- 4. A RECEIPT WITH NO `delivery_date` COUNTS FRESH, NEVER CARRIED. rc_delivery.
--    delivery_date is nullable (an unparseable sheet date must be able to land; live
--    count today is 0). Written naively, `delivery_date >= as_of_date` and
--    `delivery_date < as_of_date` are BOTH NULL for such a row, so it would fall out of
--    the windowed AND the carried side and silently disappear from the balance
--    altogether. So `is_carried` is a single strict boolean with the NULL guard in it —
--    exhaustive and disjoint by construction — and a dateless receipt lands on the fresh
--    side, because a figure a human quoted for a date cannot have accounted for a receipt
--    that has no date at all. rc_payment.payment_date is NOT NULL, so its half has no
--    such case.
--
-- ═══ RLS: WHY THERE IS AN INSERT POLICY ══════════════════════════════════════════
-- The brief asked for "RLS on, SELECT-only policy", which is the posture of the three
-- audit tables — but those are written ONLY by SECURITY DEFINER triggers, whereas this
-- table is written by a SECURITY INVOKER rpc running as `authenticated` (the flec
-- precedent's model, kept). A SELECT-only policy would make every append fail. Resolved
-- by keeping the PROPERTY the brief was protecting rather than its letter: SELECT and
-- INSERT policies, and NO update or delete policy at all. Append-only is intact and now
-- has two independent locks instead of one.
--
-- STRICTLY ADDITIVE TO cenapro.rc_delivery: no column, no write, and
-- cenapro.view_rc_delivery is not touched (it has UI consumers and a 116-assertion
-- verify script). No rc_* table is FK'd to a production dimension. The existing public
-- accessors are WIDENED, never replaced.
--
-- NOT BUILT (Step 4+): rc_payment_allocation, view_rc_delivery_settlement,
-- view_rc_payment_state, advance_php, any period boundary, any cheque-gap report. An
-- opening balance is NOT a period boundary (Step 6, cenapro.rc_balance_period): it is a
-- stated fact about the past with an as-of date, it closes nothing, and it never stops
-- the full history from being read back.
-- ─────────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════════
-- 1. THE TABLE — cenapro.rc_supplier_opening_balance (APPEND-ONLY)
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cenapro.rc_supplier_opening_balance (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- ON UPDATE CASCADE so re-keying a trader never orphans its stated balance. No
  -- ON DELETE clause: the default NO ACTION refuses deleting a supplier that has one,
  -- which is correct — a retired trader is `active = false`, never a DELETE.
  supplier_code       text        NOT NULL
                      REFERENCES cenapro.rc_supplier(code) ON UPDATE CASCADE,

  as_of_date          date        NOT NULL,

  -- SIGNED exactly like running_balance_php. See the COMMENT below.
  opening_balance_php numeric     NOT NULL,

  -- Where the number came from. Not required; the UI encourages it.
  note                text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  -- auth.uid(), stamped by the trigger. NO foreign key to public.profiles, for the same
  -- reason the audit tables have none: this row must outlive the account that wrote it,
  -- and ON DELETE SET NULL would erase the author exactly when it matters.
  created_by          uuid
);

COMMENT ON TABLE cenapro.rc_supplier_opening_balance IS
  'APPEND-ONLY stated opening balances per RC supplier — the answer to "we cannot back-enter seven '
  'months of cheques, so let us state what is actually outstanding and count forward". Every '
  '"modify" is a NEW ROW; nothing is ever UPDATEd or DELETEd (no client role holds the privilege '
  'and there is no policy for it), so a money history can never be silently rewritten. THE CURRENT '
  'opening balance for a supplier is the LATEST REVISION — greatest id, which is a monotone '
  'identity and therefore tie-free — resolved ONCE in cenapro.view_rc_supplier_opening_balance and '
  'read from there by everything. A later revision may carry an EARLIER as_of_date: revising a '
  'stated figure downward or backward is exactly what this table is for. '
  'AS-OF RULE: THE OPENING BALANCE STANDS FOR EVERYTHING STRICTLY BEFORE as_of_date; RECEIPTS AND '
  'PAYMENTS DATED ON OR AFTER as_of_date COUNT FRESH ON TOP OF IT. Modelled on '
  'cenapro.warehouse_opening_balance (the flec-count precedent). Write through '
  'public.cenapro_set_rc_supplier_opening_balance() — there is no update and no delete rpc.';

COMMENT ON COLUMN cenapro.rc_supplier_opening_balance.supplier_code IS
  'The trader this stated balance belongs to. One supplier may have many revisions; the newest '
  '(greatest id) is the one every balance uses.';
COMMENT ON COLUMN cenapro.rc_supplier_opening_balance.as_of_date IS
  'The date the figure is stated AS OF. THE OPENING BALANCE STANDS FOR EVERYTHING STRICTLY BEFORE '
  'THIS DATE; receipts and payments dated ON OR AFTER it count fresh on top of it. So a receipt '
  'dated exactly on as_of_date is NOT covered by the opening balance — the boundary is >=, never >. '
  'Refused in the future by the write rpc; freely backdated, including earlier than an existing '
  'revision.';
COMMENT ON COLUMN cenapro.rc_supplier_opening_balance.opening_balance_php IS
  'What was outstanding as of as_of_date, SIGNED EXACTLY LIKE '
  'cenapro.view_rc_supplier_balance.running_balance_php: **NEGATIVE MEANS WE OWE THE SUPPLIER; '
  'POSITIVE MEANS THE SUPPLIER OWES US** (an advance CI has already paid). This is Renzo''s '
  'convention verbatim and it is the OPPOSITE of the accounts-payable sign — do not re-derive it '
  'backwards. ZERO IS LEGAL AND MEANINGFUL: it states "we are square with this trader as of this '
  'date", which is a real answer and not a blank, so no CHECK excludes it. Stored at centavo scale '
  '(the write rpc refuses more than 2 decimal places) even though individual receipts legitimately '
  'price to fractions of a centavo — this is the one figure a person states by hand.';
COMMENT ON COLUMN cenapro.rc_supplier_opening_balance.note IS
  'Where the number came from — a supplier statement, a confirmation call, a reconciled ledger '
  'page. Optional, but it is the only thing that will explain the figure in six months.';
COMMENT ON COLUMN cenapro.rc_supplier_opening_balance.created_by IS
  'auth.uid() of whoever stated it, forced by cenapro.fn_stamp_rc_supplier_opening_balance so a '
  'caller cannot attribute a figure to someone else. NULL for a service-role / psql write, which '
  'is the honest answer. No FK to public.profiles on purpose — this row outlives the account.';

-- The current-revision lookup (supplier_code, id DESC) AND, because supplier_code leads,
-- the ON UPDATE CASCADE referential scan. Plain, not partial, so the RI machinery's own
-- plans never have to prove a predicate.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_supplier_opening_balance_current
  ON cenapro.rc_supplier_opening_balance (supplier_code, id DESC);


-- ═════════════════════════════════════════════════════════════════════════════════
-- 2. STAMP TRIGGER — BEFORE INSERT only (there is no UPDATE path)
-- ═════════════════════════════════════════════════════════════════════════════════
-- trim_scale for the reason given on cenapro.fn_touch_rc_payment: numeric equality
-- ignores scale but rendering does not, so 4200000.00 and 4200000 would read as two
-- different figures on screen. created_at/created_by are forced rather than defaulted so
-- neither can be back-dated or mis-attributed by a caller.
CREATE OR REPLACE FUNCTION cenapro.fn_stamp_rc_supplier_opening_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  NEW.opening_balance_php := trim_scale(NEW.opening_balance_php);
  NEW.note                := nullif(btrim(NEW.note), '');
  NEW.created_at          := now();
  NEW.created_by          := coalesce(auth.uid(), NEW.created_by);
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION cenapro.fn_stamp_rc_supplier_opening_balance() IS
  'BEFORE INSERT on cenapro.rc_supplier_opening_balance: normalises opening_balance_php with '
  'trim_scale (so 4200000.00 and 4200000 cannot read as two different figures), blanks an empty '
  'note, and forces created_at = now() + created_by = auth.uid() so a revision cannot be '
  'back-dated or attributed to someone else. INSERT only — the table is append-only and no role '
  'holds UPDATE or DELETE on it.';

REVOKE EXECUTE ON FUNCTION cenapro.fn_stamp_rc_supplier_opening_balance() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cenapro.fn_stamp_rc_supplier_opening_balance()
  TO authenticated, service_role;

DROP TRIGGER IF EXISTS tr_cenapro_rc_supplier_opening_balance_stamp
  ON cenapro.rc_supplier_opening_balance;
CREATE TRIGGER tr_cenapro_rc_supplier_opening_balance_stamp
  BEFORE INSERT ON cenapro.rc_supplier_opening_balance
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_stamp_rc_supplier_opening_balance();


-- ═════════════════════════════════════════════════════════════════════════════════
-- 3. GRANTS + RLS — the cenapro DEFAULT ACL trap, and the append-only lock
-- ═════════════════════════════════════════════════════════════════════════════════
-- `pg_default_acl` for schema cenapro is {anon=r, authenticated=arwd,
-- service_role=arwd}, so a table created here is BORN readable by anon and WRITABLE
-- (including DELETE) by authenticated whatever the CREATE said. For an append-only
-- ledger that default is precisely the failure. Revoke all three, then hand back exactly
-- SELECT + INSERT.
REVOKE ALL ON cenapro.rc_supplier_opening_balance FROM anon;
REVOKE ALL ON cenapro.rc_supplier_opening_balance FROM authenticated;
REVOKE ALL ON cenapro.rc_supplier_opening_balance FROM service_role;
GRANT SELECT, INSERT ON cenapro.rc_supplier_opening_balance TO authenticated, service_role;

-- Second, independent lock: RLS on, with SELECT + INSERT policies and NO update or
-- delete policy at all, so even a future blanket
-- `GRANT ... ON ALL TABLES IN SCHEMA cenapro` cannot rewrite or erase a revision.
ALTER TABLE cenapro.rc_supplier_opening_balance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cenapro_rc_supplier_opening_balance_select
  ON cenapro.rc_supplier_opening_balance;
CREATE POLICY cenapro_rc_supplier_opening_balance_select
  ON cenapro.rc_supplier_opening_balance
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS cenapro_rc_supplier_opening_balance_insert
  ON cenapro.rc_supplier_opening_balance;
CREATE POLICY cenapro_rc_supplier_opening_balance_insert
  ON cenapro.rc_supplier_opening_balance
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- The identity sequence is born with the same default ACL. An IDENTITY column does not
-- consult the sequence's ACL when inserting (unlike a serial DEFAULT nextval), so no
-- client role needs it — verified by inserting as `authenticated` after this revoke.
-- Scoped by name, never a blanket "all sequences in schema cenapro".
DO $do$
DECLARE
  v_seq text := pg_catalog.pg_get_serial_sequence(
                  'cenapro.rc_supplier_opening_balance', 'id');
BEGIN
  IF v_seq IS NOT NULL THEN
    EXECUTE format('revoke all on sequence %s from anon, authenticated', v_seq);
  END IF;
END;
$do$;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 4. THE ONE DEFINITION OF "CURRENT" — cenapro.view_rc_supplier_opening_balance
-- ═════════════════════════════════════════════════════════════════════════════════
-- Same discipline as cenapro.view_rc_supplier_group owning group_code: the resolution
-- rule is written ONCE and every consumer — both balance views and the public accessor —
-- reads it from here rather than re-deriving "greatest id".
--
-- The revision_count window has NO ORDER BY, so its frame is the whole partition (the
-- default for an unordered window). That is deliberate: with an ORDER BY the default
-- frame would be a running count, which is a different and wrong number.
CREATE OR REPLACE VIEW cenapro.view_rc_supplier_opening_balance
WITH (security_invoker = true)
AS
SELECT
  x.supplier_code,
  x.as_of_date,
  x.opening_balance_php,
  x.note,
  x.revision_id,
  x.set_at,
  x.set_by,
  x.revision_count
FROM (
  SELECT
    o.supplier_code,
    o.as_of_date,
    trim_scale(o.opening_balance_php)                            AS opening_balance_php,
    o.note,
    o.id                                                         AS revision_id,
    o.created_at                                                 AS set_at,
    o.created_by                                                 AS set_by,
    (count(*) OVER (PARTITION BY o.supplier_code))::integer      AS revision_count,
    row_number() OVER (PARTITION BY o.supplier_code ORDER BY o.id DESC) AS rn
  FROM cenapro.rc_supplier_opening_balance o
) x
WHERE x.rn = 1;

COMMENT ON VIEW cenapro.view_rc_supplier_opening_balance IS
  'THE definition of a Cenapro RC supplier''s CURRENT stated opening balance: the LATEST REVISION '
  '(greatest id — a monotone identity, so no tiebreak is needed and none can be ambiguous), one '
  'row per supplier that has ever had one. Deliberately NOT the flec precedent''s '
  '"latest effective as-of date" rule: a correction whose as_of_date is EARLIER than the revision '
  'it replaces must still win, because it is the newer statement of fact. `revision_count` is how '
  'many revisions exist, so a screen can say "3rd revision" without a second query. Everything '
  'downstream reads the current value from HERE — cenapro.view_rc_supplier_balance, the group '
  'rollup and public.cenapro_rc_supplier_opening_balances — and never re-derives it. ₱-BEARING.';

REVOKE ALL ON cenapro.view_rc_supplier_opening_balance FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_supplier_opening_balance TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 5. THE BALANCE, REWORKED — cenapro.view_rc_supplier_balance
-- ═════════════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE, not DROP + CREATE: every pre-existing column keeps its name, type
-- AND POSITION and the new ones are appended, which is exactly what Postgres allows.
-- That is also why the two public accessors below can simply be re-replaced — their
-- `SELECT b.*` re-expands over the widened list without losing a grant.
--
-- Read Step 3's header (20260805120000) before touching the priceability filter. It has
-- NOT been inlined or weakened here: cenapro.rc_delivery_is_priceable() is still the ONE
-- definition, now evaluated once per row in the `x` subquery instead of five times per
-- aggregate.
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
    -- COUNT is every receipt before the cutoff; PESOS are the priceable ones only,
    -- exactly as receipt_count / receipts_php relate. An unpriced carried receipt is
    -- therefore counted but contributes ₱0 — it could not have been folded into the
    -- opening balance either, which is why the unpriced counts stay ALL-TIME.
    (count(*) FILTER (WHERE x.is_carried))::integer              AS carried_receipt_count,
    trim_scale(coalesce(sum(x.total_price_php)
      FILTER (WHERE x.is_priceable AND x.is_carried), 0))        AS carried_receipt_php,

    -- ── THE HONESTY COLUMNS — ALL-TIME on purpose (decision 3 in the header) ─────
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
    -- ...and the same two, restricted to the window, for a screen that wants to show
    -- "incomplete entries since the opening balance" beside the all-time figure.
    (count(*) FILTER (WHERE NOT x.is_priceable AND NOT x.is_carried))::integer
                                                                 AS unpriced_receipt_count_window,
    trim_scale(coalesce(sum(x.net_weight_kg)
      FILTER (WHERE NOT x.is_priceable AND NOT x.is_carried), 0)) AS unpriced_receipt_kg_window,

    -- Span of the WHOLE history, carried receipts included: "first receipt" means the
    -- first one, not the first one after a figure somebody quoted.
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
      -- THE ONE definition, evaluated once per row.
      cenapro.rc_delivery_is_priceable(d.gross_weight_kg, d.base_price_php_kg) AS is_priceable,
      -- THE AS-OF BOUNDARY, computed ONCE as a STRICT boolean: `>=` counts fresh, `<`
      -- is carried, and a receipt with NO delivery_date counts FRESH rather than
      -- falling out of both sides (header decision 4). Exhaustive and disjoint, which
      -- is what closes the receipt_count_all = receipt_count + carried_receipt_count
      -- invariant.
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
    -- The symmetric half of carried_receipt_*. Without it the gap between
    -- payments_all_php and payments_php would be unexplained, and the opening balance
    -- would be checkable on one side only.
    (count(*) FILTER (WHERE y.is_carried))::integer              AS carried_payment_count,
    trim_scale(coalesce(sum(y.balance_effect_php)
      FILTER (WHERE y.is_carried), 0))                           AS carried_payment_php,

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
      -- payment_date is NOT NULL, so this needs no NULL guard; same >= / < boundary.
      (ob.as_of_date IS NOT NULL AND v.payment_date < ob.as_of_date)           AS is_carried
    FROM cenapro.view_rc_payment v
    LEFT JOIN ob ON ob.supplier_code = v.supplier_code
    WHERE NOT v.is_deleted
  ) y
  GROUP BY y.supplier_code
)
SELECT
  -- ═══ the 30 columns this view had before opening balances existed, in order ═════
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

  -- THE NUMBER, now with the opening term. Negative = we owe them.
  trim_scale(coalesce(ob.opening_balance_php, 0)
             + coalesce(p.payments_php, 0)
             - coalesce(r.receipts_php, 0))     AS running_balance_php,

  -- ═══ NEW: the stated opening balance ═══════════════════════════════════════════
  coalesce(ob.opening_balance_php, 0)           AS opening_balance_php,
  ob.as_of_date                                 AS opening_as_of_date,
  (ob.supplier_code IS NOT NULL)                AS has_opening_balance,
  ob.note                                       AS opening_note,
  ob.set_at                                     AS opening_set_at,
  ob.revision_id                                AS opening_revision_id,
  coalesce(ob.revision_count, 0)                AS opening_revision_count,

  -- ═══ NEW: what the opening balance stands in for ═══════════════════════════════
  coalesce(r.carried_receipt_count, 0)          AS carried_receipt_count,
  coalesce(r.carried_receipt_php, 0)            AS carried_receipt_php,
  coalesce(p.carried_payment_count, 0)          AS carried_payment_count,
  coalesce(p.carried_payment_php, 0)            AS carried_payment_php,

  -- ═══ NEW: the full-history figures, preserved so the opening stays auditable ════
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

  -- ═══ NEW: the windowed twins of the two headline honesty columns ═══════════════
  coalesce(r.unpriced_receipt_count_window, 0)  AS unpriced_receipt_count_window,
  coalesce(r.unpriced_receipt_kg_window, 0)     AS unpriced_receipt_kg_window
FROM cenapro.view_rc_supplier_group g
LEFT JOIN r  ON r.supplier_code  = g.code
LEFT JOIN p  ON p.supplier_code  = g.code
LEFT JOIN ob ON ob.supplier_code = g.code

UNION ALL

-- The receipts with NO PAYEE. Unchanged in spirit from Step 3: they cannot be liquidated
-- (rc_payment.supplier_code is NOT NULL, so no cheque can ever point at them) and they
-- must not silently vanish from every total either. They can never carry an opening
-- balance either — rc_supplier_opening_balance.supplier_code is NOT NULL and FK'd — so
-- every new column here is the zero/NULL case and the _all figures equal the windowed
-- ones by construction. Emitted ONLY while such receipts exist.
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
  r.unpriced_receipt_kg_window
FROM r
WHERE r.supplier_code IS NULL;

COMMENT ON VIEW cenapro.view_rc_supplier_balance IS
  'THE Cenapro liquidation balance: one row per RC supplier — what CI owes for that trader''s '
  'PRICEABLE receipts, what CI has paid, the STATED OPENING BALANCE, and the running difference. '
  'AS-OF RULE (2026-08-06): the opening balance stands for everything STRICTLY BEFORE '
  'opening_as_of_date, and receipts/payments dated ON OR AFTER it count fresh on top of it — so '
  'receipts_php / payments_php and the whole cash_* decomposition are WINDOWED to >= that date, '
  'while the *_all_php columns keep the full-history figures so the stated balance stays auditable '
  'and carried_receipt_* / carried_payment_* say exactly what it stands in for. A SUPPLIER WITH NO '
  'OPENING BALANCE READS EXACTLY AS IT DID BEFORE that feature existed (as_of_date IS NULL '
  'collapses every window). Still NO period boundary — an opening balance is a stated fact with an '
  'as-of date, it closes nothing, and Step 6''s cenapro.rc_balance_period is a different thing. '
  'Group membership comes from cenapro.view_rc_supplier_group; the signed effect of a payment from '
  'cenapro.view_rc_payment; the current stated opening from '
  'cenapro.view_rc_supplier_opening_balance — none of the three is re-derived here. Carries ONE '
  'extra row where is_unassigned = true and supplier_code IS NULL, holding the receipts that have '
  'no payee and therefore cannot be liquidated at all (and can never carry an opening balance). NO '
  'rounds_to_php and NO within_rounding: A NON-ZERO BALANCE IS NEVER AN ERROR STATE. Entirely '
  '₱-bearing — every consumer is behind canViewPrices().';

COMMENT ON COLUMN cenapro.view_rc_supplier_balance.running_balance_php IS
  'opening_balance_php + payments_php - receipts_php, where the payment and receipt terms cover '
  'ONLY what is dated ON OR AFTER opening_as_of_date (everything, when there is no opening '
  'balance). **NEGATIVE MEANS WE OWE THE SUPPLIER; POSITIVE MEANS THE SUPPLIER OWES US.** Renzo''s '
  'convention verbatim, the OPPOSITE of the accounts-payable sign an accountant would write — do '
  'not re-derive it backwards. It is routinely and legitimately non-zero and that is NEVER an '
  'error state. Cross-check against the untouched full history in one line: '
  'running_balance_php - running_balance_all_php = opening_balance_php + carried_receipt_php '
  '- carried_payment_php.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.opening_balance_php IS
  'The CURRENT stated opening balance (latest revision, from '
  'cenapro.view_rc_supplier_opening_balance), or 0 when none has been stated — 0 is also a legal '
  'STATED value, so read has_opening_balance to tell "square as of that date" from "never '
  'stated". Signed like running_balance_php: negative = we owe them. Exists because back-entering '
  'seven months of historic cheques is not realistic, so the outstanding figure is stated and '
  'counted forward from.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.opening_as_of_date IS
  'The date the opening balance is stated as of; NULL when none. THE OPENING COVERS EVERYTHING '
  'STRICTLY BEFORE THIS DATE — a receipt dated exactly on it counts FRESH, not carried.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.has_opening_balance IS
  'TRUE when this supplier has a stated opening balance. The ONLY way to tell a stated ₱0 ("we are '
  'square as of that date") from "nothing has ever been stated" — both read opening_balance_php = '
  '0. Key any UI on this flag, never on the amount.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.receipts_php IS
  'SUM of total_price_php over PRICEABLE receipts (cenapro.rc_delivery_is_priceable) dated ON OR '
  'AFTER opening_as_of_date — unwindowed when there is no opening balance. An unweighed or '
  'unpriced receipt is an INCOMPLETE ENTRY, not ₱0 payable: numerically this equals the unfiltered '
  'sum today because the generated column COALESCEs a missing factor to 0, so the hole a naive '
  'balance opens is invisible in pesos and shows up ONLY as unpriced_receipt_count. Never drop the '
  'filter as redundant. The full-history figure is receipts_all_php; the part the opening balance '
  'stands in for is carried_receipt_php.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.payments_php IS
  'The SIGNED net entering the balance from payments dated ON OR AFTER opening_as_of_date '
  '(unwindowed when there is no opening balance): outgoing counts +, incoming counts -, and an '
  '`adjustment` write-off participates exactly like a payment because forgiving a remainder does '
  'settle it. Invariant: payments_php = cash_out_php - cash_in_php + adjustment_php, i.e. '
  'cash_net_php + adjustment_php. Full history: payments_all_php.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.carried_receipt_count IS
  'How many receipts the opening balance STANDS IN FOR — every receipt dated strictly BEFORE '
  'opening_as_of_date, priceable or not. This is what makes a stated figure defensible later: '
  '"this ₱4.2M stands in for 268 receipts worth ₱198M." 0 when there is no opening balance. '
  'Invariant: receipt_count_all = receipt_count + carried_receipt_count (a receipt with no '
  'delivery_date counts on the FRESH side, never carried).';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.carried_receipt_php IS
  'The PRICEABLE pesos dated strictly before opening_as_of_date — what the stated figure replaced. '
  'Invariant: receipts_all_php = receipts_php + carried_receipt_php. Unpriceable carried receipts '
  'are in carried_receipt_count but contribute ₱0 here, because nobody knows what they are worth — '
  'which is exactly why the unpriced counts below are ALL-TIME.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.carried_payment_php IS
  'The signed payment effect dated strictly before opening_as_of_date — the symmetric half of '
  'carried_receipt_php, so the gap between payments_all_php and payments_php is never unexplained. '
  'Invariant: payments_all_php = payments_php + carried_payment_php.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.running_balance_all_php IS
  'payments_all_php - receipts_all_php: THE FULL-HISTORY BALANCE, with NO opening term, i.e. '
  'exactly the number this view produced before opening balances existed. Preserved because '
  'without it a stated opening balance would be unauditable — you could never ask "what does the '
  'raw history say, and what did my stated figure change?" Same sign convention.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.unpriced_receipt_count IS
  'Receipts this balance COULD NOT PRICE, over the WHOLE history — NOT windowed, on purpose. An '
  'unpriced receipt from before the cutoff CANNOT have been folded into the opening balance, '
  'because nobody knows what it is worth, so it is still an outstanding unknown and windowing it '
  'away would hide it. Partitioned exhaustively by unpriced_awaiting_weight_count (priced, not yet '
  'weighed — the normal daily state of a fresh in-app receipt), unpriced_awaiting_price_count '
  '(weighed, no price agreed) and unpriced_awaiting_both_count, all likewise all-time. '
  'unpriced_receipt_count_window is the windowed twin, for a screen that wants both.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.unpriced_receipt_count_window IS
  'The windowed twin of unpriced_receipt_count: incomplete entries dated ON OR AFTER '
  'opening_as_of_date only. Equal to the all-time count when there is no opening balance. The '
  'all-time one is the PRIMARY figure — see its COMMENT for why.';
COMMENT ON COLUMN cenapro.view_rc_supplier_balance.is_unassigned IS
  'TRUE on the single synthetic row that holds receipts with no supplier_code. Those receipts have '
  'no payee, so no payment can ever point at them and no opening balance can ever cover them '
  '(rc_supplier_opening_balance.supplier_code is NOT NULL and FK''d); their balance is simply minus '
  'what they are worth. Render it as "cannot be liquidated - no payee recorded", never as a '
  'trader. Key rows on this flag, not on supplier_code, which is NULL here.';

REVOKE ALL ON cenapro.view_rc_supplier_balance FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_supplier_balance TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 6. THE GROUP ROLLUP — cenapro.view_rc_supplier_group_balance
-- ═════════════════════════════════════════════════════════════════════════════════
-- Still built ON TOP of the per-supplier view, so the two levels can never disagree, and
-- still in SQL rather than a TypeScript reduce(). Every measure including the opening
-- term is linear, so summing the rows is exactly summing the underlying facts and the
-- documented invariant survives: THE GROUP TOTAL EQUALS THE SUM OF ITS MEMBERS'
-- running_balance_php, EXACTLY.
CREATE OR REPLACE VIEW cenapro.view_rc_supplier_group_balance
WITH (security_invoker = true)
AS
SELECT
  -- ═══ the 27 columns this view had before opening balances existed, in order ════
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

  -- Identical to sum(opening) + sum(payments) - sum(receipts) by linearity; written as
  -- the sum of the member rows so "the group total is the sum of what is on screen" is
  -- literally true.
  trim_scale(sum(b.running_balance_php))        AS running_balance_php,

  -- ═══ NEW: the group's stated opening position ══════════════════════════════════
  trim_scale(sum(b.opening_balance_php))        AS opening_balance_php,
  bool_or(b.has_opening_balance)                AS has_opening_balance,
  (count(*) FILTER (WHERE b.has_opening_balance))::integer
                                                AS opening_supplier_count,
  -- A group's members may legitimately be stated as of DIFFERENT dates, so there is no
  -- single group as-of date in general. Expose the honest three: the one date when they
  -- all agree (NULL when they do not, so a UI cannot print a date that is only true for
  -- some members), plus the range.
  CASE WHEN min(b.opening_as_of_date) = max(b.opening_as_of_date)
       THEN min(b.opening_as_of_date) END       AS opening_as_of_date,
  min(b.opening_as_of_date)                     AS opening_as_of_date_min,
  max(b.opening_as_of_date)                     AS opening_as_of_date_max,

  -- ═══ NEW: what the group's openings stand in for ═══════════════════════════════
  sum(b.carried_receipt_count)                  AS carried_receipt_count,
  trim_scale(sum(b.carried_receipt_php))        AS carried_receipt_php,
  sum(b.carried_payment_count)                  AS carried_payment_count,
  trim_scale(sum(b.carried_payment_php))        AS carried_payment_php,

  -- ═══ NEW: the full-history figures ════════════════════════════════════════════
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

  -- ═══ NEW: the windowed honesty twins ══════════════════════════════════════════
  sum(b.unpriced_receipt_count_window)          AS unpriced_receipt_count_window,
  trim_scale(sum(b.unpriced_receipt_kg_window)) AS unpriced_receipt_kg_window
FROM cenapro.view_rc_supplier_balance b
GROUP BY b.group_code, b.is_unassigned;

COMMENT ON VIEW cenapro.view_rc_supplier_group_balance IS
  'cenapro.view_rc_supplier_balance rolled up by group_code — one row per cheque-payee GROUP, so a '
  'parent trader shows a single number covering its sub-suppliers while each child keeps its own '
  'row in the per-supplier view. A root trader is its own group of one. Carries the opening-balance '
  'columns too: opening_balance_php is the SUM of its members'' stated openings, and because '
  'members may be stated as of DIFFERENT dates, opening_as_of_date is NULL unless they all agree — '
  'read opening_as_of_date_min / _max for the range and opening_supplier_count for how many '
  'members have one at all. The unassigned bucket appears here too, with group_code IS NULL and '
  'is_unassigned = true. Same sign convention: NEGATIVE = we owe the group.';
COMMENT ON COLUMN cenapro.view_rc_supplier_group_balance.running_balance_php IS
  'The GROUP total, opening balances included. NEGATIVE = we owe the group; POSITIVE = the group '
  'owes us. Equals the sum of its members'' running_balance_php EXACTLY — every term including the '
  'opening is linear — so a screen showing both levels always adds up.';
COMMENT ON COLUMN cenapro.view_rc_supplier_group_balance.opening_as_of_date IS
  'The group''s as-of date when EVERY member with an opening balance agrees on it, otherwise NULL '
  'so a UI can never print a date that is only true for some of them. Use opening_as_of_date_min / '
  '_max for the range.';

REVOKE ALL ON cenapro.view_rc_supplier_group_balance FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_supplier_group_balance TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 7. PUBLIC ACCESSORS — `cenapro` is not exposed to PostgREST
-- ═════════════════════════════════════════════════════════════════════════════════
-- The two EXISTING balance accessors are WIDENED, not replaced: they are `SELECT b.*`,
-- so re-issuing CREATE OR REPLACE re-expands them over the new column list while keeping
-- their name, their grants and every consumer that already reads them.
CREATE OR REPLACE VIEW public.cenapro_rc_supplier_balances
WITH (security_invoker = true) AS
SELECT b.* FROM cenapro.view_rc_supplier_balance b;

COMMENT ON VIEW public.cenapro_rc_supplier_balances IS
  'Public READ-ONLY accessor for cenapro.view_rc_supplier_balance — "what do we owe this trader". '
  'running_balance_php NEGATIVE = we owe them, and it now includes the STATED OPENING BALANCE: the '
  'receipt/payment terms cover only what is dated ON OR AFTER opening_as_of_date, with the '
  'full-history figures kept beside them as *_all_php and what the opening stands in for as '
  'carried_*. A supplier with no opening balance reads exactly as it did before. Includes the '
  'is_unassigned row for receipts with no payee. Entirely ₱-bearing. Write an opening balance with '
  'public.cenapro_set_rc_supplier_opening_balance().';

CREATE OR REPLACE VIEW public.cenapro_rc_supplier_group_balances
WITH (security_invoker = true) AS
SELECT b.* FROM cenapro.view_rc_supplier_group_balance b;

COMMENT ON VIEW public.cenapro_rc_supplier_group_balances IS
  'Public READ-ONLY accessor for cenapro.view_rc_supplier_group_balance — the same measures rolled '
  'up per cheque-payee group, for the parent rows of the balance screen. The group total equals the '
  'sum of its member rows exactly, opening balances included. opening_as_of_date is NULL when the '
  'members do not all agree on one. Entirely ₱-bearing.';

-- NEW: the current stated opening per supplier, and the full append-only history. Named
-- after the flec precedent's pair (public.cenapro_opening_balances /
-- cenapro_opening_balance_history) but shipped as VIEWS rather than functions, because
-- neither needs a parameter and every other object in Steps 1-3 is a `cenapro_rc_*`
-- view. Both are READ-ONLY; the appender rpc is the only write door.
CREATE OR REPLACE VIEW public.cenapro_rc_supplier_opening_balances
WITH (security_invoker = true) AS
SELECT
  o.supplier_code,
  s.display_name                AS supplier_display_name,
  s.group_code,
  s.group_display_name,
  o.as_of_date,
  o.opening_balance_php,
  o.note,
  o.revision_id,
  o.revision_count,
  o.set_at,
  o.set_by
FROM cenapro.view_rc_supplier_opening_balance o
JOIN cenapro.view_rc_supplier_group s ON s.code = o.supplier_code;

COMMENT ON VIEW public.cenapro_rc_supplier_opening_balances IS
  'Public READ-ONLY accessor for the CURRENT stated opening balance of every Cenapro RC supplier '
  'that has one (latest revision by id — see cenapro.view_rc_supplier_opening_balance). One row '
  'per supplier; a supplier that has never had one is ABSENT, so join or read '
  'has_opening_balance on public.cenapro_rc_supplier_balances rather than assuming a row. The '
  'figure covers everything STRICTLY BEFORE as_of_date. History in '
  'public.cenapro_rc_supplier_opening_balance_history; write with '
  'public.cenapro_set_rc_supplier_opening_balance(). ₱-BEARING — gate on canViewPrices().';

CREATE OR REPLACE VIEW public.cenapro_rc_supplier_opening_balance_history
WITH (security_invoker = true) AS
SELECT
  o.id,
  o.supplier_code,
  s.display_name                AS supplier_display_name,
  o.as_of_date,
  trim_scale(o.opening_balance_php) AS opening_balance_php,
  o.note,
  (o.id = cur.revision_id)      AS is_current,
  o.created_at,
  o.created_by
FROM cenapro.rc_supplier_opening_balance o
JOIN cenapro.rc_supplier s ON s.code = o.supplier_code
LEFT JOIN cenapro.view_rc_supplier_opening_balance cur ON cur.supplier_code = o.supplier_code;

COMMENT ON VIEW public.cenapro_rc_supplier_opening_balance_history IS
  'Public READ-ONLY accessor for the FULL append-only history of Cenapro RC supplier opening '
  'balances — every revision ever stated, with is_current marking the one in force (the greatest '
  'id per supplier). Nothing here can be edited or removed by any client role: the table holds no '
  'UPDATE/DELETE grant and no UPDATE/DELETE policy. A correction is a NEW revision, and it may '
  'legitimately carry an EARLIER as_of_date than the row it supersedes. ₱-BEARING — gate on '
  'canViewPrices().';

REVOKE ALL ON public.cenapro_rc_supplier_balances                 FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_supplier_group_balances           FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_supplier_opening_balances         FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_supplier_opening_balance_history  FROM anon, authenticated, service_role;

GRANT SELECT ON public.cenapro_rc_supplier_balances                TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_supplier_group_balances          TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_supplier_opening_balances        TO authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_supplier_opening_balance_history TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 8. THE WRITER — public.cenapro_set_rc_supplier_opening_balance (INSERT ONLY)
-- ═════════════════════════════════════════════════════════════════════════════════
-- Cloned from public.cenapro_set_opening_balance's idiom (append a revision, never
-- update), but returning jsonb in the module's outcome vocabulary rather than the
-- inserted row, because a RETURNS TABLE cannot carry a refusal message and every refusal
-- here lands straight in a toast.
--
-- WHAT IT REFUSES: an unknown supplier; a missing amount or date; a non-finite amount;
-- more than 2 decimal places; an as_of_date in the future.
-- WHAT IT DOES NOT REFUSE, DELIBERATELY: a ZERO amount ("we are square as of that date"
-- is a real answer); a POSITIVE amount (the supplier owes us — an advance); a
-- re-statement of exactly the same numbers; and an as_of_date EARLIER than an existing
-- revision. Revising a stated figure downward or backward is precisely what this table
-- is for, so refusing it would defeat the feature.
CREATE OR REPLACE FUNCTION public.cenapro_set_rc_supplier_opening_balance(
  p_supplier_code       text,
  p_as_of_date          date,
  p_opening_balance_php numeric,
  p_note                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_today      date;
  v_amount     numeric;
  v_name       text;
  v_supersedes bigint;
  v_prev_as_of date;
  v_prev_php   numeric;
  v_id         bigint;
  v_created    timestamptz;
  v_count      integer;
BEGIN
  IF p_supplier_code IS NULL OR pg_catalog.btrim(p_supplier_code) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'An opening balance has to name the supplier it belongs to.');
  END IF;

  SELECT s.display_name INTO v_name
    FROM cenapro.rc_supplier s
   WHERE s.code = p_supplier_code;

  IF v_name IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format(
        'There is no supplier with the code "%s". Add that trader first, then state its opening '
        || 'balance.', p_supplier_code));
  END IF;

  IF p_as_of_date IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'An opening balance needs the date it is stated as of. The figure covers '
                 || 'everything before that date, and receipts and payments from that date onward '
                 || 'are counted on top of it.');
  END IF;

  -- The operator's own today, not the server's. PH is UTC+8, so between midnight and
  -- 8am in Cebu the UTC date is still yesterday and current_date would refuse a figure
  -- stated for the day it actually is.
  v_today := (pg_catalog.now() AT TIME ZONE 'Asia/Manila')::date;

  IF p_as_of_date > v_today THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format(
        'An opening balance cannot be stated as of a future date - %s is after today (%s). It is a '
        || 'statement about what was already outstanding.',
        pg_catalog.to_char(p_as_of_date, 'YYYY-MM-DD'),
        pg_catalog.to_char(v_today, 'YYYY-MM-DD')));
  END IF;

  IF p_opening_balance_php IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'An opening balance needs an amount. Enter 0 if this supplier is square as of '
                 || 'that date - zero is a real answer, not a blank.');
  END IF;

  -- numeric accepts NaN and (since PG14) ±Infinity, and NaN = NaN is TRUE for numeric,
  -- so this comparison is the reliable finite test.
  IF p_opening_balance_php = 'NaN'::numeric
     OR p_opening_balance_php = 'Infinity'::numeric
     OR p_opening_balance_php = '-Infinity'::numeric THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'The opening balance has to be an ordinary number of pesos.');
  END IF;

  v_amount := pg_catalog.trim_scale(p_opening_balance_php);

  IF pg_catalog.scale(v_amount) > 2 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', pg_catalog.format(
        'An opening balance is a stated peso figure, so it can carry at most two decimal places '
        || '(centavos) - you entered %s. Individual receipts DO price out to fractions of a '
        || 'centavo and there is nothing wrong with those; this is the one number a person states '
        || 'by hand, so round it to centavos.', v_amount::text));
  END IF;

  -- What this revision supersedes, for the response. Read, not written: there is nothing
  -- to lock, because an append cannot conflict with anything.
  SELECT o.id, o.as_of_date, o.opening_balance_php
    INTO v_supersedes, v_prev_as_of, v_prev_php
    FROM cenapro.rc_supplier_opening_balance o
   WHERE o.supplier_code = p_supplier_code
   ORDER BY o.id DESC
   LIMIT 1;

  BEGIN
    -- `note` is passed through RAW: blanking an empty one is the stamp trigger's job and
    -- is defined there ONCE, so a direct service-role insert normalises identically.
    -- (NULLIF/COALESCE are SQL constructs, not pg_catalog functions — they cannot be
    -- schema-qualified, and `pg_catalog.nullif(...)` here was a real 42883 at runtime.)
    INSERT INTO cenapro.rc_supplier_opening_balance AS t
      (supplier_code, as_of_date, opening_balance_php, note)
    VALUES
      (p_supplier_code, p_as_of_date, v_amount, p_note)
    RETURNING t.id, t.created_at INTO v_id, v_created;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', pg_catalog.format(
          'The supplier "%s" no longer exists. Reload the supplier list.', p_supplier_code));
    WHEN insufficient_privilege THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'You do not have permission to state an opening balance.');
  END;

  SELECT o.revision_count INTO v_count
    FROM cenapro.view_rc_supplier_opening_balance o
   WHERE o.supplier_code = p_supplier_code;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'inserted',
    'id', v_id,
    'supplier_code', p_supplier_code,
    'as_of_date', p_as_of_date,
    'opening_balance_php', v_amount,
    'created_at', v_created,
    'revision_count', v_count,
    'supersedes_id', v_supersedes,
    'message', CASE
      WHEN v_supersedes IS NULL THEN pg_catalog.format(
        'Opening balance for %s recorded as of %s. Receipts and payments from that date onward are '
        || 'counted on top of it.', v_name, pg_catalog.to_char(p_as_of_date, 'YYYY-MM-DD'))
      ELSE pg_catalog.format(
        'Opening balance for %s revised (revision %s). The previous figure, stated as of %s, is '
        || 'kept in the history - nothing was overwritten.',
        v_name, v_count::text, pg_catalog.to_char(v_prev_as_of, 'YYYY-MM-DD'))
    END);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_set_rc_supplier_opening_balance(text, date, numeric, text) IS
  'APPEND a stated opening balance for one Cenapro RC supplier. INSERT-ONLY: "modifying" an '
  'opening balance means appending a NEW REVISION, and the newest revision (greatest id) is the one '
  'every balance uses. THERE IS DELIBERATELY NO UPDATE AND NO DELETE RPC — to correct a figure, '
  'append a corrected revision; the superseded one stays readable in '
  'public.cenapro_rc_supplier_opening_balance_history, because a money history that can be '
  'silently rewritten is worth nothing. The amount is SIGNED like running_balance_php (negative = '
  'we owe the supplier). REFUSES, each with a toast-ready message: an unknown supplier, a missing '
  'amount or date, a non-finite amount, more than 2 decimal places, and an as_of_date in the '
  'future (measured in Asia/Manila, not UTC). DOES NOT refuse a zero amount, a positive amount, a '
  're-statement of the same numbers, or an as_of_date earlier than an existing revision - revising '
  'downward or backward is exactly what this is for. Outcomes: inserted | invalid.';

REVOKE EXECUTE ON FUNCTION
  public.cenapro_set_rc_supplier_opening_balance(text, date, numeric, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION
  public.cenapro_set_rc_supplier_opening_balance(text, date, numeric, text)
  TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 9. NOTHING IS SEEDED
-- ═════════════════════════════════════════════════════════════════════════════════
-- Not one opening balance is inserted here. Every figure is a real fact Renzo has to get
-- from a supplier statement or a confirmation call, and inventing one — even a zero —
-- would be exactly the fabrication the audit discipline exists to prevent. Until he
-- states them, all 12 suppliers read has_opening_balance = false and the balance screen
-- shows the same full-history numbers it showed before this migration.

NOTIFY pgrst, 'reload schema';
