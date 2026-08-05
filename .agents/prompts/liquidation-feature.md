# Liquidation — payments, cheques and the per-supplier running balance (Cenapro RC)

> **Status (updated 2026-08-05): STEP 1 IS BUILT AND APPLIED. Steps 2–8 are still brief-only.**
> The audit trail (§7 Step 1) shipped as migration `20260805100000_cenapro_rc_delivery_audit.sql`
> — `cenapro.rc_delivery_audit`, live and verified. **Nothing else** has been built: no banks, no
> payments, no allocations, no supplier subgroups, no balance view. Section 5 lists decisions that
> change the shape of those tables — they are prerequisites, not follow-ups. Section 3's facts were
> re-measured live on 2026-08-05; §3.1 and §3.3 are now RESOLVED and §3.4 has moved (see the notes
> in place). **Everything in §2 and §3 is a snapshot with a date on it — re-measure before relying
> on a number here.**

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

> **Re-measured 2026-08-05.** An earlier draft of this table said 969 receipts, all
> `sheet_import`, 0 app-created, and 0 sheet-total mismatches. All four were already drifting
> as it was written. Corrected below.

| Fact | Value (live 2026-08-05) |
|---|---|
| Receipts | **971** — **969** `provenance = 'sheet_import'` + **2 `app`-created** |
| Rows edited in the app (`row_version > 1`) | **13** |
| Date span | 2026-01-02 → **2026-08-05** |
| Total payable | **₱729,637,074.1125** over 17,566,712.65 net kg |
| Suppliers | 12, all active; 1 receipt still has no `supplier_code` |
| Destinations | 16; 0 unresolved receipts remaining |
| Moisture sub-samples | 244 |
| Receipts with import flags | 12 — but only **2** still describe a live problem |
| Receipts with a NULL date | 0 |
| Suspected duplicates / duplicate groups | **0** — the 22 copies were deleted 2026-08-04 (§3.1) |
| `total_price_php` != `sheet_total_php` | **7**, not 0 — see §3.9 |
| Receipts that cannot be priced yet | **5** (§3.4) |

**Concentration — three traders carry 68% of the money:**

| Supplier | Receipts | ₱ | Span |
|---|---|---|---|
| BRIX | 281 | 212,669,462.50 | Jan 3 → Aug 4 |
| ZAPANTA | 214 | 201,265,010.50 | Jan 2 → Aug 3 |
| DENCIO | 98 | 85,671,911.50 | Jan 5 → Aug 3 |
| ALI UNGA | 79 | 71,954,431.70 | Jan 7 → **Aug 5** |
| NEGROS | 89 | 69,297,652.0625 | Jan 8 → Aug 4 |
| PALAWAN | 126 | 55,280,642.50 | Jan 6 → Jul 23 |
| PULVERA | 21 | 9,963,919.20 | Jan 6 → Aug 4 |
| RAGMERD | 14 | 9,520,858.85 | Jan 13 → Apr 7 |
| ANDRAQUE | 26 | 8,352,225.70 | Jan 8 → Jul 30 |
| NOVAL | 17 | 3,486,215.15 | Jan 26 → Aug 4 |
| OBENZA | 3 | 1,310,000.70 | Mar 23 → Jul 17 |
| SEVILLA | 2 | 0.00 | Jul 14 (both "SAMPLE") |
| *(unmapped)* | 1 | 864,743.75 | Feb 23 |

*(Re-measured 2026-08-05. ALI UNGA gained the 2 app-created receipts; BRIX, NEGROS, PULVERA
and NOVAL gained value when the five weightless 2026-08-04 receipts were finally weighed.)*

**Shape of a month:** ~121 receipts and ~₱90.8M. Range: January 152 receipts / ₱129.7M down to
April 108 / ₱75.0M. 171 delivery days across seven months, ~5.7 receipts a day.

**Shape of the allocation problem:** 78 supplier-month cells (avg 12.4 receipts, ₱9.3M; max 64
receipts, ₱44.5M). 548 supplier-day cells (avg 1.77 receipts, max 7).

**Shape of a receipt:** p10 ₱278,357.50 · median ₱828,240 · p90 ₱1,057,920 · p99 ₱1,190,228.
**447 of 971 receipts are not a whole peso, and 19 carry sub-centavo fractions** (the
₱1,027,132.875 row is real). *(Re-measured 2026-08-05; was 444 of 969.)*

**What this sizes:** a full year is roughly 1,450 receipts. If a cheque typically covers a week
of one supplier's trucks, that is on the order of 500–800 payments and 1,500–2,500 allocations
a year. **These are small tables** — a plain SQL view needs no materialisation for years. It
also tells you what the feature *is*: **the median cheque will cover four to eight receipts, so
the allocation surface is the whole product**, not a detail.

---

## 3. Facts that contradict the notes or the docs — read this before anything else

Each was checked live. Each is load-bearing.

**3.1 — ✅ RESOLVED 2026-08-05. The 22 duplicate receipts are gone, and the documents said otherwise.**
`CLAUDE.md`, both `CONTEXT.md` files and the 2026-08-04 handoff all described 991 receipts, 22
flagged suspected duplicates, 22 unflagged twins, and a ₱17,185,939 keep-or-drop decision "not
yet made". Live: **971 receipts (969 imported + 2 app-created), 0 rows with
`is_suspected_duplicate`, 0 rows with a `duplicate_group_key`**, and the total dropped by exactly
₱17,185,938.70. The decision was made and executed as a hard DELETE.

**Corrected in `CLAUDE.md`, `app/(app)/cenapro/CONTEXT.md`, `app/(app)/cenapro/deliveries/CONTEXT.md`
and `TIMELINE.md` on 2026-08-05**, alongside Step 1. Three further errors surfaced while checking,
each now fixed: the docs said **20** receipts were deleted (991 − 971 = 20 only because 2 app rows
were created afterwards — it was 22, cross-checked by 34 − 22 = 12 surviving flags);
`destination_unresolved` was claimed at 5 (live **0**); and `sheet_total_matches` was claimed
false on 0 rows (live **7** — see §3.9). **The duplicate-pairing columns still EXIST and still
WORK** — `duplicate_group_key` / `_size` / `_ordinal` / `duplicate_peer_ids` are derived on every
read and will pair on sight the next time a receipt is pasted twice. They are not removed, not
disabled, not deprecated. They simply match nothing today, and the docs now say exactly that.

**3.2 — ✅ RESOLVED 2026-08-05 (this became Step 1). That deletion left no trace anywhere.**
`public.audit_logs` contains **zero** rows mentioning `cenapro` or `rc_delivery`, and
`cenapro.rc_delivery` had no audit table (unlike `cenapro.production_event`, which has the
trigger-written append-only `production_event_audit`). Defensible for reference data transcribed
from a workbook nobody can re-interview. **For a cheque it is not.**

**Fixed by `supabase/migrations/20260805100000_cenapro_rc_delivery_audit.sql`** —
`cenapro.rc_delivery_audit`, ONE append-only table covering `rc_delivery` **and** its CASCADE
child `rc_delivery_sample`, discriminated by `entity` and always keyed by the parent
`delivery_id`. Read through `public.cenapro_rc_delivery_audit`. Written only by SECURITY DEFINER
triggers; `authenticated` proved unable to forge, erase or rewrite a row. **The trail starts
2026-08-05 and nothing was backfilled** — the 22 deletions are unrecoverable, and inventing rows
for them would put a fabrication in the one table whose value is that it is not fabricated.
Full rationale in `app/(app)/cenapro/CONTEXT.md` → "Audit trail".

**Two consequences for the steps that follow.** (a) `rc_payment` / `rc_payment_allocation` should
get the same treatment **in their own migration, at creation time** — §4.7's "audit trail, from
day one" is now a pattern to copy, not a thing to design. (b) The audit view is **₱-bearing** and
`stripPrices()` cannot protect it: `changed` and `snapshot` are free-form jsonb carrying
`total_price_php`, and `stripPrices()` nulls named fields on a row shape, never inside a blob.
Any action reading it must delete the ₱ keys **out of the jsonb** before returning.

**3.3 — ✅ RESOLVED 2026-08-05. The handoff's "single most important state fact" was stale, and
has since gone further out of date.** It reads: *"All 991 rows are `provenance = 'sheet_import'`.
Not one row has been created or edited in the app."* **Both halves are now false.** Live:
**13 rows sit at `row_version > 1`** (it was 8 when this section was first written), and
**2 rows carry `provenance = 'app'`** — so the INSERT path has now been exercised too, which it
had not been a day earlier. Corrected in the same doc pass as §3.1.

The design consequence is unchanged but now concrete: **`rc_delivery` is a live, human-edited
table, not a frozen import.** Liquidation must not assume a receipt's weight or price is stable
once a cheque points at it — which is what decisions 11 and 12 in section 5 are about, and why
§5c's release-and-warn rule matters more than it looked.

**3.4 — The biggest technical conflict: `total_price_php = 0` does not mean "₱0 owed".**
The generated column `COALESCE`s both factors to zero, deliberately, so a receipt with no
weight or no price reads ₱0 rather than NULL — which is what the workbook prints and what a SUM
needs. **Five receipts read ₱0 today and none of them is genuinely free charcoal** *(re-measured
2026-08-05; it was eight, and the change is the most instructive fact in this section — see below)*:

- 2026-08-05 — **two ALI UNGA receipts, both `provenance = 'app'`**, entered with an agreed
  `base_price_php_kg` of ₱42.00 and **no `gross_weight_kg` yet**.
- 2026-05-19 — one PALAWAN receipt, truck 8951, **11,010 kg and no price at all**, remarks `BLK1`.
- 2026-07-14 — two SEVILLA rows marked `SAMPLE`, neither weight nor price.

> **The five 2026-08-04 receipts that used to be here have been WEIGHED and are now priced**
> (NOVAL, BRIX ×2, NEGROS, PULVERA — ₱2.97M between them). **And two brand-new ones took their
> place the same way**: priced on arrival, weight to follow. That is the finding. *"Priced but not
> yet weighed"* is not an import artefact that will drain away — **it is a normal daily stage in
> the life of a receipt**, it recurs, and it is exactly the state the in-app INSERT path creates.
> The priceability predicate is therefore permanent infrastructure, not a migration-era
> workaround, and the count of unpriceable receipts will never settle at zero for long.

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

**3.9 — NEW 2026-08-05: `sheet_total_matches` is now FALSE on 7 receipts, and 2 of those are a
false alarm the view creates itself.** The read model defines it as
`NOT (total_price_php IS DISTINCT FROM sheet_total_php)`. Two different things now trip it:

- **5 imported rows — correct, and must NOT be "fixed".** The 2026-08-04 receipts
  (`source_row` 1421–1425) arrived with a price and no weight, so the workbook printed
  `TTL PRICE` = 0 and that 0 is faithfully preserved in `sheet_total_php`. They were weighed in
  the app on 2026-08-05, so the DB-computed total is now right and the frozen workbook witness is
  simply behind. `sheet_total_php` records **what the sheet said**, not a second opinion on what
  is owed. Anyone who "repairs" it to clear the flag destroys the only independent witness.
- **2 app-created rows — a genuine wart.** An `app` receipt has `sheet_total_php IS NULL` and a
  non-NULL total, so `IS DISTINCT FROM` is true and it reads "doesn't match the sheet". It never
  came from a sheet. **The witness is only meaningful for `provenance = 'sheet_import'`**, and the
  column does not say so.

**Consequence for liquidation:** do not use `sheet_total_matches` as a data-quality gate on
anything payable — it will reject good rows for two unrelated reasons, neither of them "the money
is wrong". If a UI wants to show it, scope it to imported rows. Fixing the view is a one-line
change (`provenance = 'sheet_import' AND …`) but it is **not** in Step 1's scope and was
deliberately left alone: it is a read-model change with UI consumers, and this pass was additive
only.

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

The live data explains why this happens at all: **447 of 971 receipts are not a whole peso, and
19 carry sub-centavo fractions** (re-measured 2026-08-05). The awkward remainder is generated by the receipts themselves,
not by the payment. A supplier who insists on a ₱1,027,000 cheque against a ₱1,027,132.875
receipt is not being paid short — they are choosing to carry ₱132.875.

**Two different things must be modelled differently, and neither may be inferred from the size of
the number:**

- **A carried remainder (the normal case) is recorded by recording nothing.** The balance is
  simply non-zero and stays that way. The design requirement is *the deliberate absence of an
  error state*: no "unreconciled" badge, no auto-close, no nightly job that zeroes small
  balances, no red.

  > **DECIDED 2026-08-05 — do NOT build a per-supplier rounding rule.** An earlier draft proposed
  > `rc_supplier.rounds_to_php` plus a `within_rounding` column so the UI could say *"within
  > ZAPANTA's stated rounding"*. Renzo: *"the rounding off is a habit for some but to which
  > decimal point we're rounding off is not the same all the time so just leave it alone."*
  > The habit is real but not stable enough to encode, and a rule that is right most of the time
  > is worse than no rule — it would license the UI to call a genuine shortfall "expected".
  > **Drop the column and the concept.** The requirement is simply that a non-zero balance is
  > never treated as an error.
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
- **Not a materialised view.** At 971 receipts, 12 suppliers and a projected few thousand
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

## 5. ANSWERED by Renzo, 2026-08-05 — these are decisions now, not questions

**Treat every line below as settled unless it says OPEN.** The original questions are kept for
context; Renzo's answer follows each in bold, with the design consequence underneath.

| # | Decision |
|---|---|
| 1 | Cheque is **always to a single supplier**, may cover **many deliveries** of that supplier. `supplier_code` stays **NOT NULL**; no payment grouping needed. **OPEN sub-question — see 5a.** |
| 2 | **Cheque and bank transfer only.** Drop `'cash'` from the method CHECK. `'adjustment'` stays (it is a write-off mechanism, not a payment method the operator picks). |
| 3 | **99.99% outgoing** — but not 100%, so `direction` stays. Model it; keep it out of the way in the UI. |
| 4 | **Store bank name AND account number**, but they are **not front-of-screen**. Bank name reads primarily; account number is secondary detail. `bank_account_label` becomes a real account record rather than a label-only field. |
| 5 | **Sign confirmed: negative = we owe the supplier.** Renzo's convention, verbatim, stated in the column COMMENT. |
| 6 | **A balance can be closed and restarted whenever the human chooses.** Not a calendar reset. "Most of the time balances zero out because we pay out the remaining balances." **This is a new first-class concept — see 5b.** |
| 7 | **Per-delivery breakdown is needed**, just not for every supplier. "Not for BRIX but this happens with other suppliers, it depends." So the drill-down is real, not optional polish. |
| 8 | **Do NOT build a per-supplier rounding rule.** "The rounding off is a habit for some but to which decimal point we're rounding off is not the same all the time so just leave it alone." **Drop `rc_supplier.rounds_to_php` and the `within_rounding` column entirely.** The requirement reduces to: *a non-zero balance is never an error state* — no badge, no red, no auto-close, no nightly job. |
| 9 | **Both carrying and writing off must be possible.** "I would like the choice to do either." Confirms the `method = 'adjustment'` write-off path alongside doing nothing. |
| 10 | The eight ₱0 receipts are **incomplete entries, not ₱0 payable.** So the priceability predicate is REQUIRED — an unpriced receipt must never read as settled. |
| 11 | Receipt EDITED with money against it → **warn the user.** Not silent, not refused. |
| 12 | Receipt DELETED with money against it → **warn the user.** Not refused. **OPEN — see 5c.** |
| 13 | Over-allocation → **record it.** "It will be reflected in the running balance anyway." No refusal, no CHECK against `total_price_php`. The per-*payment* invariant (allocations ≤ amount) still holds; the per-*receipt* one does not. |
| 14 | **No cheque status lifecycle.** But: **detect and highlight SKIPPED CHEQUE NUMBERS** in reports. New requirement — see 5d. |
| 15 | **Admins / everyone** may record a payment. No permission narrower than `canViewPrices()`. |
| 16 | Renzo asked what "payment change" meant — answered as an ICTC-style edit history. **OPEN pending his confirmation — see 5e.** |

### 5a-RESOLVED / 5c-RESOLVED / 5e-RESOLVED — Renzo, second pass 2026-08-05

**5e — the ICTC audit feature is CONFIRMED for Cenapro, on BOTH deliveries and payments.**
Model it on `public.audit_logs` (diff + snapshot + actor + timestamp) and on
`cenapro.production_event_audit` (append-only, trigger-written, no UPDATE/DELETE grant).
`cenapro.rc_delivery` gets one too — it currently has none, which is why the 22 duplicate
deletions left no trace. **This is independently valuable and does not depend on liquidation; it
can ship first.**

> **✅ The DELIVERIES half is BUILT (2026-08-05)** — `cenapro.rc_delivery_audit`, covering the
> receipt and its sub-samples. The **PAYMENTS half is not**, because `rc_payment` /
> `rc_payment_allocation` do not exist yet; build their trail **in the same migration that
> creates them**, cloning `20260805100000_cenapro_rc_delivery_audit.sql`. Two things that
> migration settled and the payment version should reuse verbatim: a soft-deleted payment
> (§5c) still fires DELETE-shaped audit rows only on a real DELETE, so the trail and
> `deleted_at` answer different questions and both are needed; and the diff must exclude
> whatever the touch trigger bumps, or the no-op skip can never fire.

**5a — supplier subgroups, auto-verified.** Renzo: *"Paquibot would have a subgroup of suppliers
like Llanto. The system should be able to understand that if a cheque is labeled Paquibot but is
being assigned to a Llanto delivery, then it should push through because it verified that Llanto
is a sub-supplier of Paquibot. And yes, this would mean we would need a way to setup subgroups."*

So `rc_supplier` gains a parent/child relationship and a small UI to maintain it, and the
allocation path checks **payee == delivery's supplier OR delivery's supplier is a descendant of
the payee**. Two design notes:
- **The group is a PAYMENT fact, not a delivery fact** — it says who may be paid for whom. Keep it
  on the supplier dimension, make it explicitly maintained (never inferred from name similarity),
  and audit changes to it: re-pointing a parent silently changes which allocations were legal.
- **Show both levels.** Assume the balance screen lists each trader with its own running number
  AND a group total for the parent. Renzo did not state a preference; this is the assumption to
  confirm on first sight of the screen rather than a further blocking question.
- Depth: assume **one level** (parent → children), not arbitrary nesting, until proven otherwise.

> ⚠️ **Renzo used ICTC names deliberately: *"we will be eventually including ictc anyway."***
> That is a real architectural fork and it has a **prerequisite nobody has costed**. ICTC's
> `public.deliveries.supplier` is **free text** with a `canonical_supplier()` helper — there is no
> supplier dimension at all. Cenapro's `rc_supplier` is a proper dimension. So "include ICTC
> later" means giving ICTC a supplier dimension first, which is its own migration and its own
> reconciliation of historic free-text values.
> **Recommendation: build liquidation in the `cenapro` schema now, in a shape that ports, and do
> NOT genericise it yet.** `CLAUDE.md` forbids Cenapro↔ICTC coupling; a shared *pattern* is
> correct, shared *tables* are not. Revisit only when ICTC actually needs it.

**5c — reversibility instead of a block.** Renzo: *"I said warn because I didn't want to feel like
I was locked up to one choice — what if an entry was a duplicate and it was already assigned
money. Maybe the best thing to do would be to ensure reverting is robust throughout this
feature?"*

Agreed, and it replaces the block-vs-warn argument entirely. The rules:
- **Deleting a delivery that has money against it warns, then RELEASES the allocation** — the
  amount returns to the cheque's unassigned pool. It is never silently destroyed, because the
  cheque would otherwise still exist carrying money that no longer adds up.
- **Payments and allocations are SOFT-deleted** (`deleted_at`), not hard-deleted. They are money
  records, not transcribed reference data.
- **Every mutation carries a full snapshot**, so anything can be reconstructed even when it was
  hard-removed upstream.
- Renzo's own example — a duplicate receipt that already had money assigned — is exactly the case
  release-and-warn serves: the receipt goes, the cheque keeps its value, and the money is
  re-assignable rather than stranded.

**5d — confirmed.** Skipped cheque numbers are detected per cheque book, which makes the bank
ACCOUNT structurally necessary (still not front-of-screen).

---

### 5a. (original) OPEN — sub-suppliers

Renzo: *"can be for multiple deliveries of that one supplier (and maybe their sub supplier with a
different name from them)."*

The schema already anticipated this — `rc_supplier` exists as the **cheque-payee** dimension
precisely so PALAWAN can be split into RANDY / BROOKE'S without a migration. What is not yet
decided is whether a sub-supplier is a **separate `rc_supplier` row that rolls up to a parent
payee**, or an **origin under one payee** (`supplier_origin` already exists on the receipt).

**Ask:** when a cheque to BRIX covers deliveries booked under a different trading name — is the
running balance you want to see **one number for BRIX including that name**, or **two separate
balances**? That decides whether `rc_supplier` needs a `parent_code` and whether the balance view
groups by payee or by trader.

### 5b. NEW — closing and restarting a balance

Renzo: *"we should be able to start a new running balance whenever we choose to do so, but most of
the time balances zero out because we pay out the remaining balances."*

Not a period boundary and not automatic — a **human-initiated closing point** per supplier. The
model needs a small table, roughly `cenapro.rc_balance_period(supplier_code, opened_on,
closed_on, closing_note, closed_by)`, and the balance view reports **since the current open
point** while remaining able to show the whole history. Nothing is deleted at a close; it is a
marker, not a truncation.

**Do not confuse this with rounding (8).** A balance that zeroes out because it was paid off is
the normal case; a balance carrying a small remainder forever is also normal. Neither is an error.

### 5c. OPEN — what happens to the money when a receipt is deleted

Renzo said **warn**, not refuse (12). But a warning alone leaves a question the model must answer:
once the receipt is gone, **what happens to the payment that was assigned to it?**

**Ask:** should that amount go back to being unassigned on the cheque — free to point at another
delivery — or should the deletion be blocked after all once money is involved? Warning and then
silently destroying an allocation is the one option that must not ship, because the cheque would
still exist with money that no longer adds up.

### 5d. NEW — skipped cheque numbers

Renzo: *"it would be nice to have a skipped cheque number highlighted in reports and stuff."*

Cheque books are sequential, so a gap means a cheque was voided, lost, or never recorded — a real
control. This is a **reporting/derived concern, not a column**: given `(bank_account, cheque_no)`
it is a SQL gap-detection query over the recorded numbers per book. It does NOT require the cheque
status lifecycle Renzo declined in (14) — a gap is detectable without knowing *why*.

Note this makes the bank ACCOUNT load-bearing after all (4): a sequence belongs to a cheque book,
which belongs to an account, not merely to a bank.

### 5e. OPEN — what "a record of every payment change" means

Renzo asked: *"define payment change. What exactly is that? are you talking about a running log
for change history for the edits? similar to the ictc feature?"*

**Yes — exactly the ICTC feature.** On the ICTC side, `public.audit_logs` records every insert,
edit and delete with a before/after diff, who did it and when, and the app surfaces it as an
activity trail with comments and resolve requests. Cenapro's `production_event` already has a
smaller version of the same idea (`production_event_audit`, append-only, written by a trigger).
`cenapro.rc_delivery` has **none** — which is why the 22 duplicate deletions left no trace.

For payments this would mean: every cheque recorded, amended, re-assigned or deleted leaves a row
saying what changed, from what to what, and who did it — so that a disagreement with a supplier
six months later can be answered from the system instead of from memory.

**Ask:** confirm you want that on payments, and say whether you also want it retrofitted to
deliveries.

---

*(Original questions retained below for context.)*

### How you pay

1. **When you write one cheque, is it ever for more than one supplier at once — or is a cheque
   always to a single trader?**
   *Decides whether a payment belongs to exactly one supplier, or needs to be splittable.*

2. **Do you ever pay in cash, or is it always a cheque or a bank transfer?**
   *Decides whether cash is a third method or a case that never happens.*

3. **Does money ever come back the other way — a supplier refunding you, or returning an
   overpayment — or does it only ever go out?**
   *Decides whether payments need a direction at all.*

4. **When you write a cheque, do you need to record which of your accounts it came from, or is
   knowing it was BDO enough?** And if you do need the account, is a name like "BDO current –
   Cebu" enough, or does the actual account number have to be stored?
   *Decides how far the bank detail goes. Cheque numbers are only unique per account, so this
   also decides how we stop the same cheque being entered twice.*

### How you track what's owed

5. **We'll show one number per supplier. You said a minus means you owe them — confirming that's
   how you want to read it.** It's the opposite of how an accountant would write it, and we'd
   rather the screen match how you think than match the textbook.
   *Decides the sign convention everywhere — the colour, the wording, and how a cash advance reads.*

6. **Does that number start fresh each January, or does it just keep running from whenever you
   started with that trader?**
   *Decides whether the balance has a period boundary at all.*

7. **When you look at BRIX, is one running number enough — or do you also need to see which
   individual deliveries are still unpaid?**
   *Decides whether the first screen is a summary or a working list.*

### Rounding

8. **Is a supplier's rounding a standing habit — "Zapanta always rounds to the nearest thousand"
   — or is it decided cheque by cheque?**
   *If it's standing, we record it once per trader and the system never again flags that leftover
   as unpaid. If it's ad hoc, we can't tell a deliberate remainder from a real one by looking.*

9. **When a few pesos are left over and are never going to be paid, does it just sit there
   forever — or does someone eventually say "write that off"?**
   *These are two different things. Carrying it needs no record at all; writing it off is a
   decision someone made and should be able to point at later.*

### Deliveries that don't have a price yet

10. **Eight receipts currently show zero pesos, for three different reasons — and I don't think
    any of them are genuinely free:**
    - Five trucks from **4 Aug** have an agreed price but **no weight recorded yet**.
    - One **Palawan** load on **19 May** (truck 8951) has **11,010 kg but no price at all**.
    - Two **Sevilla** rows from **14 Jul** are marked `SAMPLE` and have neither.

    **For each: is that "nothing is owed", or "something is owed, we just can't say how much
    yet"?** And when a supplier's balance includes receipts like these, should the screen warn
    you the number is incomplete?
    *This is the one that will quietly break the feature if we get it wrong — the obvious way to
    build a balance would treat all eight as fully paid the moment they exist.*

### When things change, or go wrong

11. **Once you've paid against a delivery and someone then corrects that delivery's weight or
    price — what should happen?** Quietly adjust what's still owed, warn whoever's editing, or
    refuse the edit until the payment is sorted out?
    *Today the grid will happily edit it and nothing knows a payment exists.*

12. **Same question for deleting. If a delivery already has money against it, should the system
    stop someone deleting it?**
    *My proposal is yes, refuse outright — but it's your call.*

13. **Can you ever pay a supplier more than a delivery is worth, by mistake or on purpose?**
    Should the system refuse to record that, or record it and show the delivery as overpaid?
    *Refusing to record something that actually happened is usually how these systems start lying.*

14. **Do cheques bounce, get cancelled, or get voided often enough that it needs tracking as its
    own thing — or is "just fix the entry" good enough for now?**
    *Decides whether cheque status ships in the first version or later.*

### Who does what

15. **Who in the office should be allowed to record a payment?** Everyone who can already see
    prices, or only you and the admins?
    *Seeing money and moving money are different permissions.*

16. **One about process rather than the feature.** When you deleted those 22 duplicate
    deliveries, **nothing anywhere recorded that it happened** — no log, no trace. For deliveries
    copied out of a workbook that's arguably fine. For cheques it wouldn't be. **Do you want a
    permanent record of every change to a payment — and should deliveries get one too?**
    *Decides whether an audit trail is in the first version. It's much cheaper to build in than
    to add afterwards.*

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

## 7. Build plan — REVISED 2026-08-05, after Renzo answered every question

Eight steps. Each ships something usable on its own and nothing is built twice. Ordering rule:
**foundations that are expensive to retrofit first, then the smallest thing that answers "what do
we owe this trader", then the surface that earns the feature.**

### Step 1 — ✅ SHIPPED 2026-08-05 (data layer) — Correct the docs, and give Cenapro the ICTC audit trail
`cenapro.rc_delivery_audit` — append-only, trigger-written, no UPDATE/DELETE grant to anyone —
modelled on `cenapro.production_event_audit` and `public.audit_logs` (diff + snapshot + actor +
timestamp). Surface it in the deliveries ledger as a per-row history. Also correct the stale
counts everywhere (971 receipts; duplicates resolved by deletion; the write path now exercised).
*Ships alone, independently valuable, and exactly what was missing when the 22 duplicates
vanished. Doing it first means every later step is recorded from day one — retrofitting an audit
onto a system already writing money is the expensive version.*

**DONE:** migration `supabase/migrations/20260805100000_cenapro_rc_delivery_audit.sql`, applied
and verified live. ONE table for the receipt **and** its sub-samples, discriminated by `entity`,
always keyed by the parent `delivery_id`; the STORED GENERATED money columns are deliberately kept
**in** the diff; `updated_at`/`row_version` excluded so a no-op write records nothing; **AFTER**
triggers because generated columns are not computed until BEFORE triggers finish; RLS on with a
SELECT-only policy so a future blanket grant still cannot forge a row. Docs corrected across
`CLAUDE.md`, both `CONTEXT.md`s and `TIMELINE.md` (§3.1). Full write-up:
`app/(app)/cenapro/CONTEXT.md` → "Audit trail".

**STILL TO DO in this step:**
- **The per-row history UI** — nothing reads `public.cenapro_rc_delivery_audit` yet. Note the
  ₱ trap in §3.2: `stripPrices()` cannot reach inside `changed`/`snapshot` jsonb.
- **`types/supabase.ts` regeneration** for the new view (skipped: parallel writer in the module).
  Use the CLI, never the MCP type generator — it drops `graphql_public`.
- **Optional:** have the three `cenapro_save_rc_delivery*` RPCs set
  `cenapro.audit_source` so `source` stops being NULL. Clear it immediately after the statement
  it describes — the GUC is transaction-local, and a half-true provenance column is worse than
  none.

### Step 2 — Supplier subgroups
`rc_supplier` gains a parent/child link (**one level**, not chains) plus a small screen to
maintain it. Changes to the grouping are audited — re-pointing a parent retroactively changes
which past payments were legitimate. **Explicitly maintained, never inferred from name similarity.**
*Small. Needed by Steps 3 and 4; useless to defer past them.*

### Step 3 — Banks, accounts, payments, and the running balance
`rc_bank` + `rc_bank_account` (name to the front, account number as secondary detail),
`rc_payment` (cheque | bank_transfer | adjustment; always-positive amount with a separate
`direction`; `stated_term` as intent only), soft delete, audit trigger, the write RPCs, and
`view_rc_supplier_balance` — **payments minus PRICEABLE receipts, signed Renzo's way**, rolled up
across a supplier's subgroup.
*The first step that answers "what do we owe BRIX", which nothing can answer today. Note it
delivers a real balance **before allocation exists** — allocation refines the number, it does not
enable it.*

### Step 4 — Allocation: assigning a payment to deliveries
`rc_payment_allocation` (many-to-many, amount on the edge, `UNIQUE(payment_id, delivery_id)`), the
whole-block replace RPC gated on the payment's `row_version`, sub-supplier validation on the
allocation path, `view_rc_delivery_settlement`, and the working screen: pick a supplier, see
unsettled deliveries oldest-first with a running remainder, fill amounts, save atomically.
Over-allocation is **recorded, not refused**. Deleting a delivery **warns and RELEASES** its
allocation back to the cheque's unassigned pool.
*The phase that earns the feature — the median cheque covers four to eight receipts.*

### Step 5 — Cash advances, drawn down
A list of payments carrying an unallocated remainder, and the ability to attach one to a delivery
after the fact. **UI only — the data model has supported this since Step 4** (an advance is simply
a payment whose allocations sum to less than its amount).

### Step 6 — Closing and restarting a balance
`cenapro.rc_balance_period(supplier_code, opened_on, closed_on, closing_note, closed_by)`. A
human-initiated marker, never automatic, never a calendar reset; nothing is deleted at a close.
The balance reports since the current open point while retaining full history.

### Step 7 — Cheque books and skipped numbers
Sequence-gap detection per cheque book, surfaced in reports. Needs no cheque status lifecycle — a
gap is detectable without knowing why it exists.

### Step 8 — Reporting
Per-supplier statements, aging, month-end payables. **Genuinely deferrable** — a live balance
already answers the daily question, and the balance deliberately never has to close.

### 7a. The UI shape — wireframed with Renzo 2026-08-05, approved "alright as a start"

Steps 3–5 are the only steps that are mostly screen; 1, 2, 6 and 7 are database work with a thin
form on top. Three screens cover all three steps:

1. **Supplier balances** (step 3) — one row per trader: name, signed running balance, last paid,
   and a count of unpriced receipts. A parent trader renders as a group row with its children
   nested and indented beneath, each carrying its own number as well as the group total.
   Minus = we owe them; plus = they owe us. Stated on the screen, not just in a column comment.
2. **Record a payment** (step 3) — supplier · date · method · amount · bank (name to the front,
   account as small secondary text) · cheque no. Two exits: `Save`, and `Save and assign →` which
   goes straight to screen 3. Stated term sits quietly at the edge — it is intent, not arithmetic.
3. **Spread a cheque across deliveries** (steps 4 **and 5**) — the cheque and its total in the
   header, **unassigned amount top-right** (it is the number being steered to zero, so it must not
   require scrolling). Below it, that supplier's deliveries oldest-first with **two separate
   money columns — "still owed" and "assign"** — plus a `Fill oldest first` helper. A
   sub-supplier's delivery appears in the parent's list with a small trader label.

**Step 5 needs no screen of its own.** A cash advance is screen 3 with nothing assigned yet — same
table, different entry point. This removes a build step: step 5 becomes a filter, not a feature.

**Direction: BOTH. Two doors onto one screen.** An earlier draft picked cheque-first. Renzo:
*"cheque first or delivery first should both be available… it differs per suppliers slightly so
it's better to be open to both options."* Correct, and cheap — **both doors create the same
allocation rows, so the write path, the RPC and the validation are built once.** Only the entry
point differs.

- **Cheque-first** — start from a payment, spread it across that supplier's deliveries. Leftover
  money stays as an advance. This is the **downpayment / bulk-settlement** rhythm.
- **Delivery-first** — start from a supplier's unsettled deliveries, tick some, then either
  `Use an existing cheque…` (any payment with unassigned money) or `Record a payment for this`
  pre-filled with the selected total. Creating a payment for exactly the selected total **is** the
  `straight` term Renzo described — pay the exact amount upon delivery.

So the two doors are not arbitrary UI taste; they mirror the payment terms the business already
uses. Build both in step 4.

> **Reuse note.** The RC Deliveries ledger already has range selection and a floating status bar
> that totals the selection (`lib/hooks/use-cell-selection.ts`, `use-cell-aggregation.ts`,
> `components/floating-status-bar.tsx`). Delivery-first is that selection plus one action, so it
> may be a **mode on the ledger operators already use** rather than a new screen. Evaluate that
> before building a second grid.

**Unpriced deliveries cannot be selected** on the delivery-first door — shown greyed with "not
priced" where the money would be. This is the section 3.4 priceability rule surfacing as UI: a
receipt with no weight or no price is not a ₱0 debt that can be settled, it is an unknown.

**Deliberately not designed yet:** where liquidation sits in the nav; the payment history shown
from the deliveries ledger side; and the close-a-balance action (step 6).

### Superseded
The five-phase plan below predates Renzo's answers. Its Phase 4 (cheque status lifecycle) was
**declined outright** — do not build it. Retained only for its reasoning about what is deferrable.

---

## 7b. The original phased order (SUPERSEDED — see 7 above)

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
