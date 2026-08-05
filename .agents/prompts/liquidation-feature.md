# Liquidation — payments, cheques and the per-supplier running balance (Cenapro RC)

> **Status: BRIEF ONLY. No code, no migration, nothing applied.** This document exists to be
> read and corrected by Renzo before anything is built. Section 5 lists decisions that change
> the shape of the tables — they are prerequisites, not follow-ups.

## Read first, in this order

1. `TIMELINE.md` — current sprint and recent completions.
2. `CLAUDE.md` — Platform Philosophy, the tenant/platform layer rule, **Price gating (`canViewPrices()`)**, **Database Rules** ("never calculate weighted averages or inventory balances in TypeScript — trust the DB"), the RLS/grants posture, Agent Prompts, the Excel Standard.
3. `app/(app)/cenapro/CONTEXT.md` → **"RC Deliveries — DATA LAYER"** in full, plus "Price gating" and "Data path (public `cenapro_*` accessors)".
4. `app/(app)/cenapro/deliveries/CONTEXT.md` in full — this is the screen liquidation attaches to.
5. `supabase/migrations/20260804070000_cenapro_rc_deliveries.sql` — the whole file, especially the three-decision header and section 8 (the write path).
6. `supabase/migrations/20260804071000_cenapro_rc_delivery_sheet_total_witness.sql` and `20260804072000_cenapro_rc_delivery_duplicate_groups.sql`.
7. `handoffs/2026-08-04-cenapro-rc-deliveries-context-and-liquidation-direction.md` — the existing direction of travel. **Note it is now partly stale; see section 3.**
8. Skim `app/(app)/cenapro/deliveries/{actions.ts,types.ts}` for the read model and the ₱ boundary (`stripPrices()`).

**Enter plan mode first. Present the plan and get explicit approval before writing a single line of SQL or TypeScript.** No migration is applied, no `supabase db push`, no schema change of any kind until Renzo says go.

---

## 1. What liquidation actually is, in plain business language

Cenapro buys raw charcoal by the truckload. Every truck that tips becomes one row in
`cenapro.rc_delivery`, and that row already knows exactly what CI owes for it —
`total_price_php`, computed by the database from the scale weight, the quality deduction and
the agreed price. **Liquidation is the other half of that story: the money going back out.**
It is the record of every cheque written and every bank transfer sent to a trader, and —
crucially — of *which receipts each of those payments was meant to settle*.

Because payment and delivery do not line up neatly (one cheque commonly covers a week of a
supplier's trucks; one big truck may be paid with a downpayment now and the balance later; and
sometimes CI pays a trader in advance before a single truck has arrived), liquidation also has
to answer the standing question underneath all of it: **for each supplier, right now, who is
ahead — do we owe them, or do they owe us, and by how much.** That number is not a report that
gets closed out at month end. It runs continuously, and it is often deliberately not zero.

---

## 2. Facts on the ground — real numbers, queried read-only 2026-08-05

| Fact | Value |
|---|---|
| Receipts | **969** (all `provenance = 'sheet_import'`; 0 app-created rows) |
| Date span | 2026-01-02 → 2026-08-04 |
| Total payable | **₱726,664,785.5625** over 17,472,782.65 net kg |
| Suppliers | 12, all active; 1 receipt still has no `supplier_code` |
| Destinations | 16; 0 unresolved receipts remaining |
| Moisture sub-samples | 244 |
| Receipts with import flags | 12 |
| Receipts with a NULL date | 0 |
| `total_price_php` != `sheet_total_php` | 0 |

**Concentration — three traders carry 68% of the money:**

| Supplier | Receipts | ₱ | Span |
|---|---|---|---|
| BRIX | 281 | 211,101,728.75 | Jan 3 → Aug 4 |
| ZAPANTA | 214 | 201,265,010.50 | Jan 2 → Aug 3 |
| DENCIO | 98 | 85,671,911.50 | Jan 5 → Aug 3 |
| ALI UNGA | 77 | 71,954,431.70 | Jan 7 → Aug 1 |
| NEGROS | 89 | 68,627,017.06 | Jan 8 → Aug 4 |
| PALAWAN | 126 | 55,280,642.50 | Jan 6 → Jul 23 |
| RAGMERD | 14 | 9,520,858.85 | Jan 13 → Apr 7 |
| PULVERA | 21 | 9,517,989.20 | Jan 6 → Aug 4 |
| ANDRAQUE | 26 | 8,352,225.70 | Jan 8 → Jul 30 |
| NOVAL | 17 | 3,198,225.35 | Jan 26 → Aug 4 |
| OBENZA | 3 | 1,310,000.70 | Mar 23 → Jul 17 |
| SEVILLA | 2 | 0.00 | Jul 14 (both "SAMPLE") |
| *(unmapped)* | 1 | 864,743.75 | Feb 23 |

**Shape of a month:** ~121 receipts and ~₱90.8M. Range: January 152 receipts / ₱129.7M down to
April 108 / ₱75.0M. 171 delivery days across seven months, ~5.7 receipts a day.

**Shape of the allocation problem:** 78 supplier-month cells (avg 12.4 receipts, ₱9.3M; max 64
receipts, ₱44.5M). 548 supplier-day cells (avg 1.77 receipts, max 7).

**Shape of a receipt:** p10 ₱278,357.50 · median ₱828,240 · p90 ₱1,057,920 · p99 ₱1,190,228.
**444 of 969 receipts are not a whole peso, and 19 carry sub-centavo fractions** (the
₱1,027,132.875 row is real).

**What this sizes:** a full year is roughly 1,450 receipts. If a cheque typically covers a week
of one supplier's trucks, that is on the order of 500–800 payments and 1,500–2,500 allocations
a year. **These are small tables** — a plain SQL view needs no materialisation for years. It
also tells you what the feature *is*: **the median cheque will cover four to eight receipts, so
the allocation surface is the whole product**, not a detail.

---

## 3. Facts that contradict the notes or the docs — read this before anything else

Each was checked live. Each is load-bearing.

**3.1 — The 22 duplicate receipts are gone, and every document still says otherwise.**
`CLAUDE.md`, both `CONTEXT.md` files and the 2026-08-04 handoff all describe 991 receipts, 22
flagged suspected duplicates, 22 unflagged twins, and a ₱17,185,939 keep-or-drop decision "not
yet made". Live: **969 receipts, 0 rows with `is_suspected_duplicate`, 0 rows with a
`duplicate_group_key`**, and the total dropped by exactly ₱17,185,938.70. The decision was made
and executed as a hard DELETE. Fix the docs in the same changeset as any liquidation work.

**3.2 — That deletion left no trace anywhere.** `public.audit_logs` contains **zero** rows
mentioning `cenapro` or `rc_delivery`, and `cenapro.rc_delivery` has no audit table (unlike
`cenapro.production_event`, which has the trigger-written append-only `production_event_audit`).
Defensible for reference data transcribed from a workbook nobody can re-interview. **For a
cheque it is not.**

**3.3 — The handoff's "single most important state fact" is stale.** It reads: *"All 991 rows
are `provenance = 'sheet_import'`. Not one row has been created or edited in the app."* Live:
**8 rows sit at `row_version = 2`**, each with a non-null `updated_by`, edited 2026-08-04
between 05:50 and 08:20 UTC. The UPDATE path has been exercised for real. The INSERT path still
has not: **0 rows with `provenance = 'app'`.**

**3.4 — The biggest technical conflict: `total_price_php = 0` does not mean "₱0 owed".**
The generated column `COALESCE`s both factors to zero, deliberately, so a receipt with no
weight or no price reads ₱0 rather than NULL — which is what the workbook prints and what a SUM
needs. **Eight receipts read ₱0 today and none of them is genuinely free charcoal:**

- 2026-08-04 — five receipts (NOVAL, BRIX x2, NEGROS, PULVERA) have an agreed
  `base_price_php_kg` (₱28.25–₱38.20) and **no `gross_weight_kg` yet**.
- 2026-05-19 — one PALAWAN receipt, truck 8951, **11,010 kg and no price at all**, remarks `BLK1`.
- 2026-07-14 — two SEVILLA rows marked `SAMPLE`, neither weight nor price.

**A per-supplier balance computed as `SUM(total_price_php) − SUM(payments)` therefore silently
under-states what CI owes, and shows every one of those receipts as fully settled the instant it
exists.** Liquidation must carry an explicit *priceability* predicate —
`gross_weight_kg IS NOT NULL AND base_price_php_kg IS NOT NULL` — and an unpriceable receipt must
surface as a **pending line the balance is honest about**, never as ₱0 settled. This is the
single most important design consequence of the existing money model, and it is not mentioned in
the raw notes.

**3.5 — The four terms and the two instruments are two independent axes, and one of them isn't
a payment type at all.** Instrument (how the money moved) and term (what the payment was *meant*
to be) are orthogonal — a cash advance can be a cheque or a transfer. More importantly:
**Downpayment vs Full payment is not a property of the payment, it is a description of how much
of a receipt the allocation covers**, and **a Cash Advance is simply a payment that has no
allocation yet**. Stored as an enum that *drives* the balance, those four values will disagree
with the allocations the first time a "downpayment" happens to cover the whole amount, or the
first time a CA gets drawn down. Keep the term as **stated human intent** (it matches the cheque
voucher and is useful to read back) and say so in the column comment — but let the arithmetic
come only from the allocation sums.

**3.6 — The sign convention in the notes is the opposite of the accounting one.** Renzo wrote:
negative = we owe the supplier; positive = the supplier owes us. In an accounts-payable ledger
the natural sign is the reverse. Neither is wrong; it must be chosen once and stated in the SQL
column comment. **Recommendation: adopt Renzo's convention verbatim** — the screen serves his
mental model — and name it explicitly in the view so nobody re-derives it backwards.

**3.7 — A cheque number is not unique on its own.** Two banks will happily issue cheque #001234.
Uniqueness is per bank (strictly, per account).

**3.8 — `rc_supplier` is a payee *dimension*, not a payee *record*.** It carries `code`,
`display_name`, `sort_order`, `active`, `notes` and nothing else. It is exactly the right place
to hang a supplier's stated rounding habit; it is exactly the wrong place to hang a bank,
because the banks in the notes (BDO, Chinabank, Metrobank, AUB) are **CI's** banks, not the
supplier's.

---

## 4. The proposed schema — a design, not a migration

Everything below lives in the `cenapro` schema, `rc_`-prefixed, joining the existing
raw-charcoal island. **Never FK any of it to a production dimension** (`warehouse` /
`source_location` / `plant`) — migration decision 1, non-negotiable.

### 4.1 Dimension — `cenapro.rc_bank`

Modelled on `rc_supplier` line for line, and for the same reason: the notes say *"the list can
grow or shrink"*, so it must be data, not a CHECK constraint or an enum.

Columns: `code` text PRIMARY KEY · `display_name` text NOT NULL · `sort_order` integer NOT NULL
DEFAULT 0 · `active` boolean NOT NULL DEFAULT true · `notes` text · `created_at` / `updated_at`
timestamptz. One CHECK that the code is non-blank. Seed BDO, CHINABANK, METROBANK, AUB
idempotently with ON CONFLICT DO NOTHING, exactly as the supplier and destination seeds do.

Adding a bank is an INSERT. Retiring one is `active = false`, never a DELETE — historic payments
must keep naming it. The FK from `rc_payment` is ON UPDATE CASCADE ON DELETE SET NULL, matching
`rc_delivery.supplier_code`.

### 4.2 Fact — `cenapro.rc_payment`

One row per money movement. **This is where the instrument lives.**

- `id` uuid PK default `gen_random_uuid()`.
- `supplier_code` text **NOT NULL** REFERENCES `cenapro.rc_supplier(code)` ON UPDATE CASCADE.
  Not null because the running balance is per supplier and a payment with no payee has no home
  in it. Depends on open question 1 — if one cheque can genuinely span suppliers, the answer is
  one payment row per supplier plus a shared `payment_group_id`, not a nullable payee.
- `payment_date` date NOT NULL — the day the money was released.
- `method` text NOT NULL CHECK IN (`cheque`, `bank_transfer`, `cash`, `adjustment`).
- `amount_php` numeric NOT NULL CHECK (> 0) — **always positive**. Direction is a separate
  column, never the sign, so a careless SUM can never silently net two opposite movements to zero.
- `direction` text NOT NULL DEFAULT `outgoing` CHECK IN (`outgoing`, `incoming`) — only if
  question 13 says it is real.
- `stated_term` text NULL CHECK IN (`downpayment`, `full`, `straight`, `cash_advance`) — Renzo's
  four terms, recorded as intent. **The column comment must say, in words, that this is
  descriptive and that no balance is ever computed from it** (section 3.5).
- `bank_code` text REFERENCES `cenapro.rc_bank(code)` ON UPDATE CASCADE ON DELETE SET NULL —
  which of *our* banks. Used by both cheque and transfer.
- `bank_account_label` text — a human label ("BDO current – Cebu"), deliberately not an account
  number (see question 11).
- `cheque_no` text · `cheque_date` date — the number on the cheque and the date written on it,
  which in PH trade is routinely *not* `payment_date`. NULL unless the method is cheque.
- `reference_no` text — the transfer/OR reference.
- `status` text NOT NULL DEFAULT `issued` CHECK IN (`issued`, `cleared`, `bounced`, `cancelled`,
  `void`) — **only if question 10 says the lifecycle is real**; otherwise omit it entirely in
  phase 1 rather than shipping a column nobody sets.
- `remarks` text.
- `row_version` integer NOT NULL DEFAULT 1 · `created_at` / `created_by` · `updated_at` /
  `updated_by` — byte-identical in shape to `rc_delivery`, with its own BEFORE INSERT/UPDATE
  trigger cloned from `fn_touch_rc_delivery`. **In a trigger, not in the RPC**, so a raw write
  through the auto-updatable accessor view still advances the concurrency token.

Constraints worth stating explicitly:

- cheque ⇒ `cheque_no` and `bank_code` present; non-cheque ⇒ `cheque_no` NULL. A shape guard, in
  the spirit of the existing `cenapro_rc_delivery_provenance_shape`.
- A partial UNIQUE index on `(bank_code, cheque_no)` where the method is cheque. Per 3.7 the key
  is *(bank, number)*, never the number alone.
- `adjustment` means **no cash moved** (see rounding, 4.5). A cash-flow view filters it out with
  one predicate; the balance keeps it.

Indexes: `(supplier_code, payment_date DESC)` — the balance view's driving access path;
`(payment_date DESC, id)` for a chronological keyset pager in the same shape the deliveries
ledger uses; and if `status` ships, a partial index on the un-cleared ones.

### 4.3 Fact — `cenapro.rc_payment_allocation`, and why an allocation model is the only honest shape

**A payment is not 1:1 with a receipt, in both directions at once.** One cheque routinely
settles several truckloads. One truckload is routinely settled by a downpayment now and a
balance later. Modelling this as `rc_delivery.paid_by_payment_id` fails the first case;
modelling it as `rc_payment.delivery_id` fails the second. **The relationship is many-to-many
with an amount on the edge, which is precisely a join table.** The amount on the edge is not
decoration — it is the entire content of a partial payment, and it is what makes "how much of
this cheque is still unassigned" answerable at all.

- `id` uuid PK.
- `payment_id` uuid NOT NULL REFERENCES `cenapro.rc_payment(id)` **ON DELETE CASCADE** — an
  allocation belongs to its payment and has no independent existence.
- `delivery_id` uuid NOT NULL REFERENCES `cenapro.rc_delivery(id)` **ON DELETE RESTRICT** —
  **load-bearing.** Deleting a receipt that has money assigned against it must be refused, not
  silently cascaded. Contrast the sibling `rc_delivery_sample`, which is correctly CASCADE: a
  moisture draw is not money. See question 9; 3.2 is the precedent that makes this worth arguing
  about.
- `amount_php` numeric NOT NULL CHECK (> 0).
- `note` text · `created_at` / `created_by`.
- UNIQUE `(payment_id, delivery_id)` — one edge per pair; two partial payments from the *same*
  cheque to the *same* receipt is a single larger edge, not two rows.

**The two invariants a CHECK constraint cannot express**, because a CHECK sees only its own row:

1. A payment's allocations must not exceed its `amount_php`.
2. A receipt's allocations must not exceed its `total_price_php` — *if* Renzo wants that refused
   at all (question 7).

Enforce (1) in **two** places: the allocate RPC returns a friendly refusal, and a CONSTRAINT
TRIGGER guarantees it against any path. Same belt-and-braces discipline the module already uses
for the ₱ gate (server-side strip *and* a refusal in the save RPC). Do **not** try to express it
as a generated column: the schema already proved (migration header, decision 2) that a generated
column cannot even reference a sibling generated column, let alone another table.

### 4.4 A cash advance is an allocation that does not exist yet

The notes describe CA as *"we pay up front in advance a certain amount of money"* — before any
receipt exists. **The model handles this with no special case, which is the test that the shape
is right:**

- `rc_payment` requires a supplier and an amount. It does **not** require an allocation.
- `rc_payment_allocation` requires a receipt — but the row simply is not written yet.
- The unallocated portion of a payment (amount minus the sum of its allocations) **is** the
  outstanding advance. It needs no column of its own, no flag, and no separate table.
- Later, when a truck arrives, the advance is drawn down by inserting allocation rows against the
  new receipts. Nothing about the payment row changes.

If the `stated_term` label and the allocations ever disagree, **the allocations are right** — say
so in the column comment.

### 4.5 Rounding is a first-class business fact, not drift

The notes: *"some suppliers prefer rounded numbers so some suppliers will have an existing
running balance just because they don't want us liquidating to the decimal."*

The live data explains why this happens at all: **444 of 969 receipts are not a whole peso, and
19 carry sub-centavo fractions.** The awkward remainder is generated by the receipts themselves,
not by the payment. A supplier who insists on a ₱1,027,000 cheque against a ₱1,027,132.875
receipt is not being paid short — they are choosing to carry ₱132.875.

**Two different things must be modelled differently, and neither may be inferred from the size of
the number:**

- **A carried remainder (the normal case) is recorded by recording nothing.** The balance is
  simply non-zero and stays that way. The design requirement is *the deliberate absence of an
  error state*: no "unreconciled" badge, no auto-close, no nightly job that zeroes small
  balances, no red. To distinguish "expected" from "unpaid" without guessing, put the habit on
  the dimension: **`rc_supplier.rounds_to_php` numeric NULL DEFAULT 0** — 0 = pays to the
  centavo, 1 = to the peso, 1000 = to the thousand. The balance view then exposes
  `within_rounding`, and the UI can say *"₱132.88 — within ZAPANTA's stated rounding"* instead of
  flagging it. A **stated business fact living as data on a re-pointable dimension**, exactly the
  pattern `rc_supplier` was created to serve, changeable in the app without a migration.
- **A genuine write-off (rare, permanent forgiveness) is an explicit human act with a record.**
  Model it as a payment with method `adjustment`, an amount equal to the remainder, a required
  remark, plus its allocation. That keeps ONE invariant across the whole ledger — *every peso
  allocated came from a payment row* — instead of introducing a second, allocation-only,
  money-from-nowhere shape.

Confirm with questions 5 and 6 before building either.

### 4.6 Where the running balance lives: a VIEW, and specifically not the alternatives

`CLAUDE.md` is unambiguous — *"Never calculate weighted averages or inventory balances in
TypeScript."* Within SQL there are still three candidates, and only one is right here:

- **Not a generated column.** It may reference only other columns of its own row; it cannot
  aggregate across `rc_payment_allocation`. This schema already hit the weaker version of that
  wall — `total_price_php` had to repeat the full arithmetic over base columns because it could
  not reference the sibling generated `net_weight_kg`.
- **Not a materialised balance table.** Keeping one honest needs triggers on three tables, and
  this project has already paid for that lesson once: BUG-017, where `tr_blackwood_delivery`
  fired BEFORE and recomputed from a table that did not yet agree with the write about to happen.
  A view has no staleness surface to get wrong.
- **Not a materialised view.** At 969 receipts, 12 suppliers and a projected few thousand
  allocations a year, a plain aggregate is microseconds. Revisit at tens of thousands of rows —
  and the existing note about the per-row LATERAL sample rollup in `view_rc_delivery` is the
  place to look first if it ever comes to that.

**So: three plain views, each `security_invoker = true`, each mirrored by a `public.cenapro_*`
accessor** (the `cenapro` schema is not exposed to PostgREST, and its DEFAULT ACL means every
new relation is *born* readable by `anon` — REVOKE explicitly, then GRANT SELECT back to
`authenticated` + `service_role`).

**`cenapro.view_rc_delivery_settlement`** — one row per receipt: `delivery_id` ·
`supplier_code` · `delivery_date` · `total_price_php` · `allocated_php` · `balance_php` ·
`is_priceable` (the 3.4 predicate) · `settlement_status` in {`unpriced`, `unpaid`, `partial`,
`settled`, `over_allocated`}. `unpriced` is its own status and does **not** collapse into
`settled`.

**`cenapro.view_rc_payment_state`** — one row per payment: the payment row + `allocated_php` +
`unallocated_php` + `allocation_count` + `is_advance`. This is the cash-advance list, for free.

**`cenapro.view_rc_supplier_balance`** — **the object Renzo actually asked for.** One row per
supplier: `receipts_php` (SUM over **priceable** receipts only) · `payments_php` · `advance_php` ·
**`running_balance_php`**, signed Renzo's way as `payments_php − receipts_php` so **negative = we
owe the supplier, positive = the supplier owes us** (stated in the column COMMENT, per 3.6) ·
`unpriced_receipt_count` and `unpriced_receipt_kg` so the screen is honest about what it could
not price · `rounds_to_php` and `within_rounding` per 4.5 · `last_receipt_date` and
`last_payment_date`. It aggregates from the beginning of time and **has no period boundary at
all** (see question 3).

### 4.7 The write path — clone the existing idiom exactly

All SECURITY INVOKER, `SET search_path = ''` with everything schema-qualified, EXECUTE revoked
from PUBLIC and `anon`, granted to `authenticated` + `service_role`. Same outcome vocabulary as
the existing three RPCs so a caller learns one language: `inserted | updated | version_conflict |
not_found | unsupported_field | invalid` (+ `forbidden` at the server-action layer for the ₱ gate).

- **`cenapro_save_rc_payment(p_id, p_expected_row_version, p_patch)`** — patch-shaped with an
  **allowlist that refuses the whole call on an unknown key**, compare-and-set on `row_version`
  **in the same statement as the write**, blind write refused.
- **`cenapro_save_rc_payment_allocations(p_payment_id, p_expected_row_version, p_allocations)`** —
  replaces one payment's WHOLE allocation block in a single call, gated on the **parent
  payment's** `row_version`, parent UPDATE first so it row-locks before any child row moves.
  This is `cenapro_save_rc_delivery_samples` note for note, and it is exactly what "apply this
  cheque across four receipts" needs to be: one atomic call, no half-applied cheque.
- **`cenapro_delete_rc_payment(p_id, p_expected_row_version)`** — same gate; allocations cascade,
  receipts untouched, and the freed amount reappears in every balance immediately because the
  balance is a view.

**Audit trail, from day one.** Mirror `cenapro.production_event_audit`: an append-only child
written by a trigger, with no UPDATE or DELETE grant to anyone. Section 3.2 is the argument.

---

## 5. Open decisions — only Renzo can answer these

**Do not let an agent answer them.**

1. **Can one cheque span more than one supplier?** If yes, `supplier_code` cannot be NOT NULL and
   we need one payment row per supplier under a shared group id.
2. **Confirm the sign.** Negative = we owe the supplier (your notes) — the reverse of the usual
   payables ledger. Should the screens read your way, or the accountant's way?
3. **Does the balance reset at year end, or run forever?** "Never closes" — does that also mean
   "never restarts on January 1"?
4. **The eight ₱0 receipts.** Five on 2026-08-04 have a price but no weight; one PALAWAN receipt
   on 2026-05-19 has 11,010 kg and no price; two SEVILLA "SAMPLE" rows have neither. Which are
   genuinely ₱0 payable, and which are just "not priced yet"? Should an unpriced receipt show as
   a pending line, be excluded, or mark the supplier's balance provisional?
5. **Is the rounding habit stated per supplier** ("ZAPANTA always rounds to the nearest ₱1,000")
   **or decided ad hoc per cheque?**
6. **Can a remainder ever be written off — permanently forgiven — or is it always carried?**
7. **Can a receipt be over-allocated?** Refuse it, or record it and show the receipt as negative?
   (Refusing to record something that really happened is how a ledger starts lying.)
8. **What happens when a receipt with money against it is EDITED** and its total moves? Silently
   re-balance, warn, or refuse the edit? Today the grid will happily edit it and nothing knows
   allocations exist.
9. **What happens when a receipt with money against it is DELETED?** Proposal: refuse the delete
   outright while any allocation points at it — confirm.
10. **Do bounced / cancelled / voided cheques need modelling now,** or is "edit the payment"
    enough?
11. **Do you need the bank ACCOUNT, or is the bank name enough?** And do you want a real account
    number stored at all, or is a label enough?
12. **Is 'cash' a real method here,** or is it always cheque or transfer?
13. **Does money ever flow the other way** — a supplier refunding CI?
14. **Who may RECORD a payment?** `canViewPrices()` decides who can *see* money. Is recording it
    Owner/Admin only, or anyone who can see prices?
15. **The 22 duplicates.** Docs say 991 and open; the database says 969 and closed. Correct the
    docs to "resolved by deletion" — and is a hard delete with no audit row the pattern you want
    repeated for the next correction?

---

## 6. What already exists that liquidation must not break

- **The ₱ boundary.** `canViewPrices()` in `lib/auth.ts` is the ONE helper and it respects the
  impersonation cookie. `stripPrices()` in `deliveries/types.ts` is the ONE place a row crosses
  that line, and it nulls **server-side, before the payload returns** — the network response is
  the leak. **The entire liquidation module is money**, so the whole route is behind the gate;
  any new field on the deliveries read model (`allocated_php`, `balance_php`,
  `settlement_status`) joins the seven already in `stripPrices()`. Note the deliberate contrast
  with the four duplicate columns, which are *not* gated because "this receipt is duplicated" is
  an operational fact — payment status is not in that category (question 14).
- **The generated money columns and their CHECK.** `net_weight_kg`, `price_php_kg`,
  `total_price_php` are STORED GENERATED and unwritable; `cenapro_rc_delivery_total_consistent`
  asserts the two forms agree on every row. **Liquidation reads `total_price_php` and never
  re-derives it.**
- **Liquidation is strictly ADDITIVE to `rc_delivery`.** It adds no column to that table and
  writes nothing in it. Settlement state is derived in a view. The moment a `paid` flag appears
  on the receipt, there are two truths about the same money.
- **`row_version` compare-and-set** on all three existing RPCs, with the check in the same
  statement as the write. Every new fact table gets its own touch trigger (not RPC-side
  bookkeeping).
- **The patch allowlist discipline.** An unknown key REFUSES the whole call.
- **"Flagged, never fixed."** Liquidation must not "fix" an unpriced or unmapped receipt to make
  a balance tidy. The one receipt with a NULL `supplier_code` (2026-02-23, ₱864,743.75) simply
  cannot be liquidated — the screen should say so, not guess a payee.
- **RLS and grants.** Every new relation is born readable by `anon` in this schema. Enable RLS
  with the single-org posture, REVOKE from `anon` explicitly, then GRANT back. Every view
  `security_invoker = true` with a `public.cenapro_*` accessor.
- **`rc_supplier` is the cheque-payee dimension — build on it, do not duplicate it.** It exists
  precisely so PALAWAN can be split into RANDY / BROOKE'S without a migration. Payments FK to it
  ON UPDATE CASCADE so a re-point never orphans money.
- **Never FK an `rc_*` table to a production dimension.**
- **UI rules** for any new grid: the Excel Standard, "never crush, always scroll", frozen panes
  fully opaque, `errorToast()` for every error, no animation on rows or cells, accounting-format ₱.
- **The deliveries grid's own invariants** if you add a settlement column: `summarySpans` derives
  every `colSpan` from the column table, `buildColumns()` omits the ₱ columns when gated, and
  `scripts/verify-rc-deliveries-cells.ts` plus `scripts/verify-rc-formula.ts` must stay green.
- **The CONTEXT.md Update Rule is STRICT** — including the stale 991/22-duplicates facts.

---

## 7. Phased build order

**Phase 0 — decisions and cleanup. No code.** Answer section 5. Correct the stale docs. Roughly
an hour, and it prevents building the wrong tables.

**Phase 1 — payments exist and a supplier balance is visible.** `rc_bank` (+ seed) ·
`rc_payment` · `rc_payment_allocation` · the three views · the `public.cenapro_*` accessors ·
the three RPCs · the touch trigger · the append-only audit child · RLS/grants · regenerate
`types/supabase.ts`. UI: one read-only per-supplier balance screen, and a "record a payment" form
with a receipt picker scoped to that supplier. **This alone answers "what do we owe BRIX", which
nothing can answer today.** Non-deferrable within this phase because they cannot be retrofitted
cheaply: the `is_priceable` predicate, the signed balance convention, the allocation FK delete
rules, and the audit trail.

**Phase 2 — allocation as a real working surface.** The cheque-to-receipts screen: pick a
supplier, see unsettled receipts oldest-first with a running remainder, fill amounts (with a
"consume oldest first" helper), save the whole block in one RPC call. Plus a settlement column on
the deliveries ledger. This is the phase that earns the feature.

**Phase 3 — cash advances, drawn down.** A list of payments with an unallocated remainder, and
the ability to attach one to a receipt after the fact. **The data model already supports this
from phase 1**, so this phase is UI only.

**Phase 4 — instrument lifecycle.** Cheque status transitions, bank accounts, a cheque register,
a post-dated-cheque calendar. *Looks* essential; is not. Until then a bounced cheque is handled
by editing the payment or adding a reversing adjustment.

**Phase 5 — reporting.** Aging buckets, per-supplier statements, month-end payables. Deferrable
because a live per-supplier balance already answers the daily question.

**Honestly deferrable despite looking urgent:** bank *accounts*, cheque *status*, cross-supplier
payment grouping, aging buckets, and any notion of "closing" a period.

---

## 8. When you are done

Give a summary of what was built, every file changed, and every decision made — including any of
the section 5 questions that got answered along the way and what the answer was.
