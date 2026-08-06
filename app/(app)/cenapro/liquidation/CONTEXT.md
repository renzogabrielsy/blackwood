# Liquidation (Cenapro RC) — supplier balances, payments, subgroups

## Purpose

`/cenapro/liquidation` answers the one question nothing in the system could answer before:
**"what do we owe BRIX right now."** `cenapro.rc_delivery` already knows what CI owes for every
truck; this is the **money going back out** — every cheque, bank transfer and write-off — plus the
running difference per trader.

It is **liquidation Steps 2, 3, 3b, 4 and 5's UI half** (`.agents/prompts/liquidation-feature.md`
§7a). The data layer shipped 2026-08-05/06 in five migrations and nothing consumed it until this
route. Five screens:

1. **Supplier balances** (`/cenapro/liquidation`) — one row per trader, both levels (a parent
   renders as a group row with its sub-suppliers nested beneath).
2. **Record a payment** (a dialog, opened from a trader's payments panel) + **the payments panel**
   itself, so a recorded payment is not write-only.
3. **Spread a payment across receipts** (`spread-panel.tsx`, opened from a payment's **Assign**
   button) — Step 4's cheque-first door and §7a screen 3. **The surface that earns the feature:**
   the median cheque covers four to eight receipts, so this is the working screen, not a detail
   panel.
4. **Supplier subgroups** (`/cenapro/liquidation/subgroups`) — the maintenance screen for
   "a cheque to the parent may settle a sub-supplier's deliveries".
5. **Banks & accounts** (`/cenapro/liquidation/banks`) — CI's own banks and the accounts cheques
   are drawn on. **Not optional polish:** the `rc_payment` shape CHECK requires a cheque to name an
   account, and the migration seeded four banks but **zero accounts** on purpose, so without this
   screen the dominant instrument in the business is unrecordable.

**Step 5 needed no screen at all**, which is the test that Step 4's shape is right: a cash advance
IS a payment whose allocations sum to less than its amount, so it is the payments panel's
`is_advance` filter plus a column on the balance table. No table, no flag, no route.

**Starting balances are what make the number TRUE (Step 3b, 2026-08-06).** Renzo: *"Since it's a bit
impossible to check all of the past history, we should be able to modify the starting balances of the
suppliers we have listed. I think that's imperative."* Step 3's balance summed EVERY receipt since
January — CI owes BRIX ₱212,669,462.50, the whole year's purchases — because no historic cheque was
ever entered and back-entering seven months of them is not realistic. So a trader's outstanding
figure can be **stated as of a date** and the balance counts forward from there. See "The opening
balance" below.

**ALLOCATION IS NOW BUILT (Step 4, 2026-08-06) — AND IT HAS TWO DOORS.** Renzo: *"cheque first or
delivery first should both be available… it differs per suppliers slightly so it's better to be open
to both options."* And: *"an add cheque button in deliveries page would be nice… right click on a
delivery and then assign a cheque to it… That would make the liquidations page more of a summary
page."*

**Both doors create the SAME `cenapro.rc_payment_allocation` rows through the SAME RPC, so the write
path, the validation and the vocabulary are built ONCE. Only the entry point differs.** That is not a
tidiness preference — it is what makes the two flows incapable of disagreeing about a peso.

| Door | Where | What it calls |
|---|---|---|
| **Cheque-first** | `spread-panel.tsx`, from a payment's **Assign** button | `cenapro_save_rc_payment_allocations` — the whole block, one atomic call |
| **Delivery-first** | `../deliveries/assign-cheque-dialog.tsx`, from the ledger's row context menu | `cenapro_allocate_delivery_to_payment`, which is implemented **in SQL on top of** the block RPC |
| **Delivery-first (new cheque)** | the deliveries ledger's **Add cheque** button + *"Record a cheque for this/these…"* | `savePayment` → `allocateOldestFirst` → the block RPC |

Consequently **the deliveries ledger now carries a `PAID?` settlement column**, and this module owns
the vocabulary it renders (`SETTLEMENT_LABEL`, `NOT_PRICED_TEXT`, `stillOwedText`) — imported, never
duplicated. See `../deliveries/CONTEXT.md` → "Liquidation from the receipt side".

**Still not built:** the balance close/restart (Step 6, `rc_balance_period`), the skipped-cheque-number
report (Step 7) and reporting (Step 8).

## Files

| File | Role |
|------|------|
| `types.ts` | **PURE module** (no `'use client'`, no React, no Supabase) — the shared vocabulary for the server page, the actions, every client screen **and the deliveries ledger**, which imports the settlement vocabulary from here rather than keeping a second copy. Step 4 added: `PaymentStateRow` / `DeliverySettlementRow` / `PaymentAllocationRow`; **`SettlementStatus` + `SETTLEMENT_LABEL` + `SETTLEMENT_NOTE` + `settlementStatus()`**; **`NOT_PRICED_TEXT` + `stillOwedText()`** (the ONE place a NULL `balance_php` becomes words instead of ₱0.00); the spread form (`AllocationDrafts`, `draftedTotal`, `draftedCount`, **`fillOldestFirst`**, `allocationsPayload`, `validateAllocations`); **`outstandingTotal`** and **`resolveSelectionPayee`** (what a multi-receipt selection is worth, and whether one cheque may cover it); `receiptLabel`; and `SPREAD_COLS` + `minSpreadTableWidth` + `spreadFrozenOffsets`. It also owns the row-type aliases (derived from the generated `types/supabase.ts`), `num`/`formatPeso`/`formatKg`/`formatCount`/`formatDate`/**`formatLongDate`**, **`balanceDirection` + `directionLabel` + `directionSentence` + `SIGN_NOTE`** (the sign, in words), **`unpricedPhrase` / `unpricedShort`** (the stage-naming warning), `UNASSIGNED_NOTE` / `UNASSIGNED_TITLE`, the `BALANCE_COLS` column table + `minBalanceTableWidth`, **`buildBalanceTree`** (a JOIN of the two balance views into render order — it never sums), the payment vocabularies (`METHOD_OPTIONS` / `TERM_OPTIONS` / `methodShort` / `isCheque`), the payment form shape + `validatePaymentForm` + `paymentPatchFrom`, the **opening-balance vocabulary** (`OpeningSide`, `OpeningBalanceFormState`, **`openingSignedAmount`** — the ONE place the sign is applied — **`openingSentence`**, `openingFormFrom`, `openingArgsFrom`, `validateOpeningBalanceForm`, `decimalPlaces`, `AS_OF_NOTE`, `APPEND_ONLY_NOTE`, **`carriedTitle`** / `carriedCountLabel`, **`groupAsOf`** / `groupAsOfLabel` / `groupAsOfTitle`, `BalanceLens` + `LENS_NOTE`), and the `LiquidationOutcome` / `LiquidationResult` RPC vocabulary. |
| `actions.ts` | **`'use server'`** — `fetchSupplierBalances`, `fetchPaymentDimensions`, `fetchSupplierPayments`, `fetchSupplierGroups`, **`fetchOpeningBalanceHistory`**, `savePayment`, `deletePayment`, `restorePayment`, `saveSupplierParent`, **`setOpeningBalance`**; Step 4 adds the reads **`fetchSpread`** / **`fetchAllocationTargets`** / **`fetchSettlementsFor`** / **`fetchDeliveryAllocations`** and the writes **`savePaymentAllocations`** / **`allocateDeliveryToPayment`** / **`allocateOldestFirst`** / **`restorePaymentAllocation`**. Enforces the ₱ gate on **every** read and write. |
| `page.tsx` | Server — the balances screen. Gate → fetch → hand off. Renders no title (navbar owns titles). |
| `price-gate-notice.tsx` | Server — what a price-denied role sees instead. A clean statement, not an error. |
| `liquidation-view.tsx` | Client — the balance table (frozen trader column, group nesting, the sign tag, the OPENING + STANDS IN FOR columns, the carry-forward marker, the unpriced column, the no-payee row, the **`LensSwitch`**) + the payments-panel and opening-balance-dialog hosts. |
| `opening-balance-dialog.tsx` | Client — state or revise one trader's **starting balance**. Positive amount + a two-way side choice in words, the echo-back sentence, the provenance note, the current revision and the full append-only history. Also owns `SideChoice` (a real `radiogroup`). |
| `payments-panel.tsx` | Client — a `Sheet` listing one trader's payments (voided rows included, struck through, with Restore), plus the void `AlertDialog`. Since Step 4 it reads **`cenapro_rc_payment_state`** (a strict superset of `cenapro_rc_payments`), carries an **ASSIGNED** column, an **Assign** action per row opening the spread screen, and the **`is_advance` filter** that is the whole of Step 5. Also exports **`InlineError`** (message + Copy button), reused by every other screen here. |
| `payment-dialog.tsx` | Client — the record/edit payment form. Reshapes itself around `method` so the fields the DB forbids are not on screen to be filled. Step 4 added three optional props so the **deliveries ledger can reuse it rather than fork it**: `initialAmountPhp` (pre-fill), `contextNote` (one line saying what the cheque is for) and an `onSaved(result)` that passes the RPC result through so the caller can point the new payment at the receipts it was written for. |
| `spread-panel.tsx` | Client — **§7a screen 3**, the cheque-first door. The cheque in the header with the **unassigned figure top-right** (it never scrolls away), the payee's group's receipts oldest-first, **two separate money columns** (STILL OWED / ASSIGN), `Fill oldest first`, and a whole-block atomic save. |
| `subgroups/page.tsx` | Server — the subgroups maintenance screen. Gated (see "Why subgroups is gated"). |
| `subgroups/subgroups-view.tsx` | Client — one row per trader with a "PAID FOR BY" picker; saves on change. |
| `banks/page.tsx` | Server — banks & accounts. Gated for the same reason as subgroups: an account is half a cheque's identity and this is the only way to create one. |
| `banks/banks-view.tsx` | Client — banks with their accounts nested beneath, plus the add/edit dialogs and one-click retire/restore. |

## Data

All read-only accessors, all written by migrations `20260805120000_cenapro_rc_payments.sql`,
`20260805110000_cenapro_rc_supplier_subgroups.sql` and
`20260805130000_cenapro_rc_supplier_opening_balance.sql`. **The `cenapro` schema is not exposed to
PostgREST** — everything goes through the `public.cenapro_*` accessors.

| Relation / RPC | Used by |
|---|---|
| `public.cenapro_rc_supplier_balances` | `fetchSupplierBalances` — one row per trader + the synthetic no-payee row. **57 columns** since allocation (30 → 53 → 57) |
| `public.cenapro_rc_supplier_group_balances` | `fetchSupplierBalances` — the SQL rollup that draws the parent rows. **53 columns** (27 → 49 → 53) |
| `public.cenapro_rc_payment_state` | `fetchSupplierPayments`, `fetchSpread`, `fetchAllocationTargets`, `allocateOldestFirst` — **every payment + `allocated_php` / `unallocated_php` / `allocation_count` / `is_advance`.** A strict superset of `cenapro_rc_payments`, which this module no longer reads at all |
| `public.cenapro_rc_delivery_settlement` | `fetchSpread`, `fetchAllocationTargets`, `fetchSettlementsFor`, `allocateOldestFirst` — **and the deliveries ledger's PAID? column**. One row per receipt: `total_price_php`, `allocated_php`, `balance_php` (**NULL, not 0, when unpriceable**), `allocation_count`, `is_priceable`, `is_allocatable`, `settlement_status` |
| `public.cenapro_rc_payment_allocations` | `fetchSpread`, `fetchDeliveryAllocations`, `allocateOldestFirst` — the edges, both ends folded in, soft-deleted ones INCLUDED |
| `public.cenapro_save_rc_payment_allocations(p_payment_id, p_expected_row_version, p_allocations)` | `savePaymentAllocations` and, underneath, `allocateOldestFirst` — replaces one payment's WHOLE live block **atomically**. Gated on the PARENT PAYMENT's version |
| `public.cenapro_allocate_delivery_to_payment(p_payment_id, p_expected_row_version, p_delivery_id, p_amount_php, p_note)` | `allocateDeliveryToPayment` — the delivery-first single edge. `p_amount_php` NULL ⇒ `LEAST(still owed, still unassigned)`, computed in SQL |
| `public.cenapro_restore_rc_payment_allocation(p_id, p_expected_row_version)` | `restorePaymentAllocation` — gated on the ALLOCATION's own version, not the payment's |
| `public.cenapro_rc_supplier_opening_balance_history` | `fetchOpeningBalanceHistory` — every revision ever stated, `is_current` marking the one in force |
| `public.cenapro_set_rc_supplier_opening_balance(p_supplier_code, p_as_of_date, p_opening_balance_php, p_note)` | `setOpeningBalance` — **INSERT-ONLY**; no expected row version, because an append cannot conflict |
| `public.cenapro_rc_payments` | `fetchSupplierPayments` — includes soft-deleted rows; carries `balance_effect_php` + `is_cash` + `is_deleted` |
| `public.cenapro_rc_supplier_groups` | the payee picker and the subgroups screen (`parent_code`, `is_parent`/`is_child`, `child_codes`, `row_version`) |
| `public.cenapro_rc_bank_accounts` | the "drawn on" picker (bank name front, `account_no` secondary) **and** the banks screen |
| `public.cenapro_rc_banks` | the banks screen — includes retired rows, which the pickers filter out |
| `public.cenapro_save_rc_bank(p_code, p_expected_row_version, p_patch)` | `saveBank` — allowlist `display_name, sort_order, active, notes`; `code` rides as `p_code` and is not editable |
| `public.cenapro_save_rc_bank_account(p_id, p_expected_row_version, p_patch)` | `saveBankAccount` — allowlist `bank_code, account_label, account_no, active, sort_order, notes` |
| `public.cenapro_save_rc_payment(p_id, p_expected_row_version, p_patch)` | `savePayment` |
| `public.cenapro_delete_rc_payment(p_id, p_expected_row_version)` | `deletePayment` — SOFT |
| `public.cenapro_restore_rc_payment(p_id, p_expected_row_version)` | `restorePayment` |
| `public.cenapro_save_rc_supplier(p_code, p_expected_row_version, p_patch)` | `saveSupplierParent` — patch carries `parent_code` and nothing else |

**Not consumed yet:** `public.cenapro_rc_payment_audit` and
`public.cenapro_rc_supplier_opening_balances` (the current-revision view — the balance row's own
`opening_*` columns already carry the same figure, so a second query would only create a second
source of truth). See "Known gaps".

### ⚠️ The projections are FULL, and "full" goes stale — TWICE now
`BALANCE_COLS` / `GROUP_BALANCE_COLS` in `actions.ts` list **every** column so the fetched shape *is*
the generated `Row` type. Opening balances widened both views (30→53 and 27→49) and the old lists kept
typechecking **only because `types/supabase.ts` was stale**; the moment it was regenerated both
assignments failed with "missing 22 properties". **It happened again on 2026-08-06:** allocation
appended `advance_php`, `advance_payment_count`, `unassigned_incoming_php` and `advance_php_window`
(53→57 and 49→53), and regenerating the types failed both assignments with "missing 4 properties"
before a line of UI was written. **Add a column to either view ⇒ add it here in the same changeset.**
`npx tsc --noEmit` is the check, and it is the FIRST thing to run after `supabase gen types`. Same trap caught `buildBalanceTree`'s defensive
`asGroup()`, which is now `{ ...member, <group-only columns> }` rather than a hand-listed literal — a
new *shared* column flows through automatically and a new *group-only* one is a compile error there.

## Key behaviours

### The sign is said in words, on the screen
`running_balance_php = payments − receipts`, so **NEGATIVE = WE OWE THEM**, positive = they owe us.
That is Renzo's convention (decision 5) and it is the **opposite** of the accounts-payable one, so a
reader with an accountant's reflexes reads every row backwards *and has no reason to suspect it*. A
tooltip cannot fix that — nobody hovers over something they are already sure of. So:
`SIGN_NOTE` ("Minus = we owe them. Plus = they owe us.") is printed in the header band, and every
balance carries a `we owe` / `they owe` / `square` tag beside the figure. **A bare minus never
appears alone anywhere on this screen.**

### A non-zero balance is never an error
Decision 8 killed the per-supplier rounding rule outright: traders deliberately carry remainders,
and 447 of 971 receipts are not a whole peso. **No red, no "unreconciled" badge, no warning icon, no
auto-close** — the balance column renders in plain foreground whatever its value, and the direction
tag is deliberately *not* colour-coded ("we owe them" is the ordinary state of every trader here;
painting it red would mark the whole screen as a problem). `formatPeso` keeps up to **4 decimals**
for the same reason — rounding ₱132.875 to ₱132.88 would show a number the ledger does not hold.
NEGROS renders `-69,297,652.0625` live, which is the proof.

### The load-bearing warning is invisible in pesos
`total_price_php` COALESCEs both factors to zero, so an unweighed receipt reads **₱0, not NULL**.
`SUM(total_price_php)` and `SUM(…) FILTER (priceable)` are therefore numerically **identical** on
every supplier, forever: the balance is *arithmetically correct* while silently carrying receipts
nobody can price, and **no amount anywhere reveals the gap**.

**SEVILLA is the live proof** — balance ₱0.00, `square`, and **2 not yet priced**. A screen showing
only the money would call SEVILLA settled. So `unpriced_receipt_count` is a first-class **column**,
never a hover, and it is the **only** emphasis on the row (amber, `text-amber-600
dark:text-amber-400`). `unpricedPhrase()` names the *stage* from the view's exhaustive partition
("2 receipts not yet priced — 2 awaiting weight") rather than guessing, and the wording is
**pending, never broken**: "priced but not yet weighed" is the normal state of a receipt entered
this morning and is exactly what the in-app INSERT path creates.

### Allocation — the five rules the spread screen exists to enforce (Step 4)

**1. The unassigned figure is TOP-RIGHT and never scrolls away.** §7a says so, and the reason is that
it is the number being steered to zero. It lives in the sticky `DialogHeader`, and it **tracks the
operator's typing** rather than the last fetch — the question it answers is *"what happens if I save
this"*, not *"what did the database say when this opened"*. It is the largest thing on the screen. The
only place this module colours a figure is when that number goes NEGATIVE, and even then it is not
"a balance is wrong" — it is "the database will refuse this save".

**2. Two separate money columns: STILL OWED and ASSIGN.** §7a asked for both by name. One column
doing both jobs would render a FACT and a PROPOSAL identically, on the one screen where telling them
apart is the entire task.

**3. `balance_php` is NULL, not 0, and it renders as "not priced yet".** `total_price_php` COALESCEs a
missing weight or price to exactly ₱0, so an unpriced receipt with no payments satisfies
"allocated >= total" and reads as **settled** under any naive comparison. `stillOwedText()` is the ONE
place that NULL becomes words, and it returns `{peso}` or `{text}` so a caller *cannot* accidentally
run the words through `formatPeso`. **Confirmed live 2026-08-06:** SEVILLA's two 2026-07-14 receipts
show `TTL PRICE ₱0.00` and `PAID? → "not priced yet"`, and so does the ALI UNGA pair from 2026-08-05
(priced ₱42.00/kg, no weight yet).

**4. Allocating to an unpriced receipt is ALLOWED, but never GUESSED — and the two source documents
disagreed about this.** §7a says unpriced receipts *cannot be selected*; the Step 4a migration decided
allocation to one *is* allowed, because a downpayment on a truck being weighed tomorrow is ordinary
business. **Both are right about different things, and the synthesis is what shipped:** an unpriced
receipt is never auto-filled, never swept by `Fill oldest first`, and never contributes to a
pre-filled selection total — but it can be assigned to by hand. `is_allocatable` is the affordance
flag, `fillOldestFirst()` skips on it, and `outstandingTotal()` reports what it skipped so the
operator is told rather than silently short-changed. The reason it matters: **an unpriced receipt is
an unknown, not a ₱0 debt, and any sweep that treats it as ₱0 marks it settled forever.**

**5. Over-allocating a RECEIPT is legal; over-allocating a PAYMENT is refused.** Decision 13, Renzo
verbatim — *"record it. It will be reflected in the running balance anyway."* So `over_allocated` gets
a plain word and no red, while the payment invariant is enforced twice (the RPC's friendly refusal
naming the overshoot in pesos, and a constraint trigger on **both** sides of the arithmetic). **No
client-side rule may refuse what the DB accepts** — `validateAllocations` deliberately checks neither.

**Saving is ONE atomic call and nothing is half-applied.** The RPC bumps the parent first (row-locking
it and firing the compare-and-set), soft-deletes the edges the new block no longer mentions, then
upserts the whole block in a SINGLE statement so the constraint trigger sees the final state exactly
once. A legal rearrangement — move ₱200k from receipt A to receipt B — would trip the invariant
halfway through if it were several statements. A receipt left blank is **released**, not destroyed,
and `cenapro_restore_rc_payment_allocation` puts it back.

**`Fill oldest first` REPLACES rather than tops up.** The helper means "spread it down the list"; a
version that added to whatever was already typed would mean something different every time it was
pressed.

**A sub-supplier's receipt appears in the parent's list, labelled `sub`.** The list is scoped by
**`group_code`** — read off `view_rc_supplier_group`, never re-derived from a name — because that is
exactly the set the RPC will accept (§5a). Scoping it any other way would either offer receipts the
database refuses or hide ones it accepts.

### A cash advance needed no feature (Step 5)
`view_rc_payment_state.is_advance` is `not deleted AND amount − allocated > 0`, so Step 5 reduced to
two controls: the payments panel's **"N with money left"** toggle, and the balance table's **NOT YET
ASSIGNED** column, whose figure links straight into that filtered list. No table, no flag, no route,
no drawdown screen — attaching an advance to a receipt is the ordinary spread screen.

`advance_php` is **ALL-TIME, never windowed** (the same deliberate asymmetry as the unpriced counts):
an unassigned remainder on a payment from before an opening-balance cutoff is still money nobody has
pointed at a receipt. And it is **not a balance term** — it is a subset of `payments_php`, so adding
it to anything double-counts. Stated in the column `title`, because a reader who assumes otherwise
would be out by the whole figure.

### The opening balance — four rules and one trap

**The AS-OF rule.** The stated figure covers everything **strictly before** `as_of_date`; receipts and
payments dated **on or after** it count **fresh** on top. A receipt dated exactly on the cutoff counts
fresh — the boundary is `>=`, never `>`. Printed beside the date field as `AS_OF_NOTE`, not in a
tooltip: a reader who assumes the other boundary has no reason to hover.

**THE TRAP — the sign.** Stored values are signed like `running_balance_php` (negative = we owe them).
A side chosen wrongly does not produce a visibly silly figure, it **DOUBLES the balance instead of
settling it**, and ₱425M looks no more obviously wrong than ₱212M. So the operator is **never asked
for a minus sign**: they type a **positive** amount and pick a side **in words** (`we owe them` /
`they owe us`), `openingSignedAmount()` is the ONE place the conversion happens, and
**`openingSentence()` reads the result back as a sentence before it can be saved** — *"Saving: we owe
BRIX ₱4,200,000.00 as of 3 Aug 2026."* A person catches "we owe BRIX" when they meant the reverse;
nobody catches a minus sign. A typed negative is **refused with the model explained**, never silently
flipped — flipping it would teach the operator that the minus carries the direction.

**Zero is a real answer.** "We are square as of this date" is a statement, not a blank, and the DB has
no CHECK excluding it. Nothing blocks it; the echo sentence just stops claiming a direction, and the
side control recedes (`muted`) because at zero there is none. `has_opening_balance` — never the amount
— is what distinguishes a stated ₱0 from "never stated".

**Append-only, said out loud.** The table holds no UPDATE/DELETE grant and no UPDATE/DELETE policy, so
"modify" means **append a revision**. There is therefore **no edit-in-place and no delete affordance**
anywhere here — either would fail with a permission error — and `setOpeningBalance` takes **no
`expectedRowVersion`**, because an append cannot conflict with anything. The dialog *says* the old
figure is kept (`APPEND_ONLY_NOTE`): without that line a second save looks like data loss. The full
history is in the same dialog, with `is_current` marked `in force`. The **note is deliberately not
carried forward** into a revision — a note says where *this* figure came from, so reusing it would
attribute the new number to a source that never mentioned it.

### A carried-forward row SAYS so, in three places
Once a trader has an opening balance its BALANCE / RECEIPTS / PAID / RCPTS figures cover only what is
dated on or after the as-of date — and such a row is otherwise **indistinguishable** from a
whole-history one, while differing from it by ₱200M on the biggest traders. So:

1. **OPENING** column — the stated figure (accounting ₱) with `as of yyyy-MM-dd` beneath it.
2. **STANDS IN FOR** column — `carried_receipt_count` over `carried_receipt_php`. **That pair is what
   makes a stated figure auditable later**; without it nobody can ever check the number. Verified
   read-only against live data: BRIX at a 2026-08-01 cutoff carries **275 receipts, ₱207,917,771.25**
   and its balance would read **−8,951,691.25** instead of −212,669,462.50. The `title` adds the
   payments half and the full-history figure, so the whole gap is explained on both sides.
3. **The marker in the FROZEN trader cell** — `carried forward from 2026-08-03`. Repeated there
   because the frozen column is **the only one that cannot scroll out of view**, and this is the
   qualifier that changes what every other cell on the row means.

A stated opening with nothing before its date renders `nothing before that date` rather than a bare
dash — legitimate (an opening dated before the first receipt states an outside balance) and better
than a dash the reader has to interpret.

### Both readings, without cluttering the row: the LENS
`receipts_all_php` / `payments_all_php` / `running_balance_all_php` are exposed as a **screen-level
switch** (`LensSwitch`: *As stated* / *Full history*), not as a second figure in every cell. One number
per cell, always; "what does the raw history say, and what did my stated figure change?" is one click
away instead of one more column wide. In the `all` lens the OPENING and STANDS IN FOR cells go
`opacity-50` with a re-worded `title` — they are still **facts**, just not applied — rather than
blanking, which would make the two lenses look like two different datasets. **Neither branch computes
anything**: the lens only chooses *which column* to read.

With no opening balance stated anywhere, the two lenses are **identical**, which is exactly the
migration's regression guarantee (`as_of_date IS NULL` collapses every window). Confirmed live: BRIX
−212,669,462.50 and SEVILLA 0.00 in both.

### The unpriced count stays ALL-TIME — the deliberate asymmetry
`unpriced_receipt_count` is **not** windowed, and `unpriced_receipt_count_window` never replaces it.
An unpriced receipt from *before* the cutoff **cannot** have been folded into the opening balance,
because nobody knows what it is worth. Had it been windowed, stating an opening balance would have
made **SEVILLA's two unpriceable receipts vanish** while they were still unpriceable and still covered
by nothing — the exact silent hole the module spends forty lines refusing to open. The windowed twin is
used **only** to extend the `title` ("N of them are dated before the starting balance, and it cannot
have covered them"), never to shrink the number.

### A group never prints a date that is only true for some members
`opening_as_of_date` on the rollup is NULL unless every member with an opening agrees, and
`groupAsOf()` reads the honest columns into four cases: `none`, `all` (a plain date), **`partial`**
(they agree but not all members have one → `as of 2026-08-03 · 2 of 3`) and **`range`** (they disagree
→ `2026-07-01 → 2026-08-03`, marker `carried forward from various dates`). `partial` exists because
`min`/`max` **ignore NULLs**, so a one-of-three agreement would otherwise masquerade as a group-wide
fact. A **group header carries no Set/Revise control** — an opening balance belongs to a
`cenapro.rc_supplier` row, so it is stated per member; the header says `per trader` instead of
offering a button that could do nothing. The no-payee row can never carry one at all (the FK is NOT
NULL), and says so on hover.

### The receipt that cannot be liquidated
The balance view emits a synthetic row (`is_unassigned = true`, `supplier_code IS NULL`) for the
2026-02-23 receipt worth ₱864,743.75 that has no payee. It renders **last**, italic, tinted, labelled
`(no payee recorded)` / "No payee — cannot be liquidated", is **not clickable** and is **not in the
tab order**. Its direction tag is replaced with a dashed `no payee` chip: the figure is genuinely
negative, but "we owe" invites a cheque and there is nobody to write it to. Rows are keyed on
`is_unassigned`, never on `supplier_code` (which is NULL here).

### Both levels, and the group total is never computed here
A parent renders as a group row (`group_display_name`, "N traders in this group") with its members
**nested and indented** beneath, each carrying its own number. **A group of one renders flat** — a
header plus one identical child is noise. Today all 12 traders are roots, so the flat case is what
is on screen; the nested path was verified by temporarily pairing PULVERA under BRIX, which produced
group `-222,633,381.70` = `-212,669,462.50` + `-9,963,919.20` exactly.

**`buildBalanceTree` joins, it never sums.** `cenapro.view_rc_supplier_group_balance` already rolled
the members up in SQL *on top of* the per-supplier view, so the group total and the sum of the
visible rows cannot disagree. Per `CLAUDE.md`: never calculate a balance in TypeScript. There is no
`reduce()` over payments anywhere in this module.

### The ₱ gate is a FETCH decision, not a render decision
This whole module is money. There is no useful redacted version of a balance screen — remove the
pesos and nothing is left — so **there is no `stripPrices()` analogue here and there must not be
one.** `canViewPrices()` is consulted *inside the fetchers* and a denied viewer's queries are
**never issued**. The payload is empty because there was nothing in it. The payment pickers are
fetched only after the gate passes, so a denied viewer does not even learn which bank accounts
exist. Every write action re-checks the same gate server-side and returns `outcome: 'forbidden'` —
a button that is never rendered is not a permission check. **Production is the only role denied.**

### Why subgroups is gated though it shows no money
`cenapro_rc_supplier_groups` carries no ₱ column at all. The gate there protects a **decision**, not
a figure: `parent_code` says who may be paid for whom, and re-pointing it retroactively changes
which past payments were legitimate. A role that may not see what CI owes a trader has no business
deciding whose cheques may settle whose deliveries.

### Refusals are quoted, never re-worded
Every RPC returns `{ok, outcome, message}` with `message` written for a toast, naming precisely
which of a dozen rules was broken. `actions.ts` passes it through verbatim and the UI shows it via
**`errorToast()`** (persistent + Copy, per the HARD RULE). Re-wording "…already has sub-supplier(s)
(LLANTO), so it cannot itself become one — move those sub-suppliers to X first" into "invalid
parent" would throw away the instruction it contains. Inline errors (`InlineError`, and the payment
form's per-field notes) follow the same rule; `InlineError` carries its own Copy button.

### The payment form mirrors the CHECK constraints so a refusal is rare
- **Cheque shape** — a cheque requires both a number and an account; anything else must carry
  neither. The form **reshapes** rather than merely validating: changing `method` clears the fields
  the new shape forbids, so a stale cheque number can never produce a refusal about an invisible
  field. `adjustment` hides the account picker entirely (no cash moved ⇒ no account it left from).
- **Always positive** — `min="0.0001"`, the sign lives in `direction`, and a typed negative is
  refused with the model explained rather than silently flipped.
- **No `cash`** — two instruments plus `adjustment`, which is *labelled* as a write-off where no
  money moved rather than offered as a third way of paying.
- **`stated_term` and `direction`** sit in a quiet strip at the foot with the note that the term is
  recorded intent and **no balance is ever computed from it**. `direction` defaults to `outgoing`
  and is reachable but out of the way.
- **One UI-only rule:** an `adjustment` requires a remark. The DB has no such CHECK, deliberately —
  the reason for forgiving ₱132.875 is a human fact SQL cannot verify, so refusing it in the
  database would only teach people to type a full stop. Refusing it in the form, where the person
  who knows the reason is standing, is where the rule is worth something.

### Banks and accounts are retired, never deleted
There is **no delete RPC** for either, so the screen could not offer one. `active = false` hides a
row from the pickers while every payment that already names it keeps working. The screen therefore
shows retired rows (struck with a dashed `retired` tag and a **Restore** action) rather than hiding
them — you cannot restore what you cannot see, the same reasoning as voided payments. Only the
pickers filter to active.

For a cheque this is structural, not conventional: `rc_payment.bank_account_id` is
`ON DELETE SET NULL`, and the cheque shape CHECK turns that SET NULL into an outright refusal — a
cheque's account is undeletable even from raw SQL.

A bank's `code` is fixed once created (it is not in the RPC's allowlist) because renaming it would
move every account underneath it. The screen disables the field and says why rather than leaving it
mysteriously read-only. **Nothing is seeded** — an account number is a real fact about a real cheque
book, and inventing one would put a fabrication in a ledger whose value is that it is not
fabricated.

When no account exists, the payment form's "Drawn on" picker is disabled and links to this screen —
*"No accounts have been set up yet. **Add one first** — a cheque has to name the account it was
drawn on."* It is derived from the loaded list, so it disappears by itself the moment an account
exists; nothing has to remember to take it down.

### Reverting is robust (§5c)
A payment is **soft**-deleted. Voided rows stay in the panel, struck through, with a **Restore**
button — a voided cheque that disappears cannot be restored by anyone who cannot see it. Every
balance still excludes them because the *view* does; this list is the one place the exclusion is
visible rather than silent. The restore refuses if the cheque number was re-used meanwhile, and says
so.

### Table conventions
`table-fixed` + explicit pixel widths whose **sum is the min-width** (the balance table is **1680px**
across 12 columns — measured live as `scrollWidth`), wrapped in `overflow-auto`
("never crush, always scroll") — no `1fr`, no unset column absorbing slack. `px-2 py-1`, `text-xs`,
`h-8` rows, `font-mono tabular-nums` right-aligned numerics, ₱ in **accounting format**
(`flex justify-between`, symbol left, figure right). The trader column is **frozen**
(`.frozen-col .frozen-edge left-0`) with a **fully opaque** `bg-background` base and the hover tint
layered over it; the header row is `.frozen-row` / `.frozen-corner` on solid `bg-muted` — **never
glass**, because a frozen surface sits on top of scrolling content and any alpha bleeds. **Row rules
are on the cells**, never on a `<tr>` (a `<tr>` border is not painted in the separated model).

**Every table here is `borderCollapse: 'separate'` + `borderSpacing: 0`, never `border-collapse`.**
Not cosmetic: under the collapsed-border model a border belongs to the *table* rather than the cell,
and a sticky cell's background stops painting reliably — **measured live on this screen**, with
scrolling figures visible straight through the frozen TRADER column. Same rule and same reasoning as
`rc-movement-matrix.tsx` and `production-ledger-grid.tsx`. It costs nothing here because the row
rules were already on the cells, which is precisely what the separated model paints.

**Frozen cells are fully opaque, and the class ORDER is what guarantees it.** `cn()` resolves two
`bg-*` utilities to the *last* one, so a translucent row tint listed after the opaque base
**replaces** it instead of layering over it. That is a bleed, not a style choice — the no-payee row
shipped at `alpha 0.2` and was visibly see-through. The opaque base is therefore listed **first** and
every row tint is a **solid** token (`bg-muted`, never `bg-muted/40` or `/20`); only `group-hover:`
tints may be translucent, because a variant class never replaces the base.
**No animation on rows** — hover only, `transition-all duration-150`. No `stagger-children`, no
`hover-lift`.

### Accessibility
A clickable balance row is a real control: `role="button"`, an `aria-label` ("Payments to BRIX"),
`tabIndex={0}` and Enter/Space. Group headers and the no-payee row are **not** clickable and stay
out of the tab order rather than presenting a control that does nothing. All autofocus goes through
**`focusNoScroll`** from `lib/utils.ts`, never React's `autoFocus` (react-dom's `commitMount` is a
bare `.focus()`, which scrolls with block *and* inline `"center"` through every scrolling ancestor).

Both two-way choices (`SideChoice`, `LensSwitch`) are real **`role="radiogroup"` + `role="radio"` +
`aria-checked`** with arrow-key movement and a single tab stop — not `aria-pressed` toggles, because
the options are mutually exclusive and a screen reader should say "1 of 2", not "not pressed".
The **Set/Revise opening** button sits inside a row that is itself a button, so its `onClick` and
`onKeyDown` both **`stopPropagation()`** — otherwise one activation would fire both controls.
The echo sentence is `aria-live="polite"`, so it is re-announced as the figure and the side change.

## Known gaps (stated, not hidden)

- **There are still zero bank accounts in the database**, so a cheque cannot be recorded *until
  someone adds one* — but that is now a one-screen task rather than a dead end
  (`/cenapro/liquidation/banks`). Nothing is seeded on purpose; Renzo types the real number.
- **No payment-history UI.** `public.cenapro_rc_payment_audit` is unread. Note the ₱ trap: `changed`
  and `snapshot` are free-form jsonb carrying `amount_php`, and a field-list redactor cannot reach
  inside a blob — any action exposing it must delete the ₱ keys **out of the jsonb**, exactly as
  `deliveries/actions.ts::redactAuditJson` does.
- **Not one opening balance has been stated yet.** All 12 traders read `has_opening_balance = false`,
  so the screen still shows the full-history figures it showed before Step 3b (BRIX
  −₱212,669,462.50). Nothing is seeded on purpose — every figure is a real fact Renzo has to get from
  a supplier statement or a confirmation call, and inventing one, even a zero, would be exactly the
  fabrication the audit discipline exists to prevent. **The write path was therefore verified in the
  UI up to but not including the save**, plus a read-only SQL simulation of the windowed arithmetic;
  the append-only table means a test revision could never be removed.
- **An opening balance is NOT a period boundary.** It is a stated fact with an as-of date; it closes
  nothing and never stops the full history being read back (that is Step 6,
  `cenapro.rc_balance_period`, and it is a different thing).
- **`public.cenapro_rc_supplier_opening_balances`** (the current-revision view) is unread — the
  balance row's own `opening_*` columns carry the same figure and a second query would only create a
  second source of truth.
- **`testuser@blackwood.local` cannot sign in.** GoTrue returns `Database error finding user` for
  both `magiclink` and `recovery` on that account (Renzo's own account works). Pre-existing, unrelated
  to this work, and it means that test account is unusable for local verification.
- **Steps 4 and 5 ARE built (2026-08-06).** Steps 6–8 are not, and must not be added piecemeal: no
  balance close/restart (`rc_balance_period`), no skipped-cheque-number report, no reporting.
- **THE ALLOCATION SURFACES HAVE NEVER BEEN EXERCISED AGAINST REAL DATA, because there is none.**
  There are still **zero bank accounts**, therefore **zero payments**, therefore **zero allocations** —
  the Step 4 migration seeded no allocation on purpose (*"inventing one would put a fabrication in the
  middle of the money"*). So the spread screen and the assign dialog were verified to **compile, gate
  and render their empty/complete states**, and the PAID? column was verified against 971 real
  receipts, but no cheque has been spread end-to-end. **First real run:** add an account at
  `/cenapro/liquidation/banks`, record a cheque, then press **Assign**.
- **`public.cenapro_rc_payment_audit` is still unread**, and it now trails allocations too
  (`entity = 'allocation'`, keyed by `payment_id` AND `delivery_id`). Same ₱ trap as before: `changed`
  and `snapshot` are free-form jsonb carrying money, and a field-list redactor cannot reach inside a
  blob — any action exposing it must delete the ₱ keys **out of the jsonb**, exactly as
  `deliveries/actions.ts::redactAuditJson` does.
- **A settlement read failure is deliberately NON-fatal to the deliveries ledger** (a samples failure
  still is). `loadChildren` returns the two errors separately, so 971 receipts still render and each
  PAID? cell says it could not load. See `../deliveries/CONTEXT.md` → "Liquidation from the receipt
  side".

## Dependencies

- `lib/auth.ts` → **`canViewPrices()`** — the ONE price gate, respects the impersonation cookie.
- `lib/toast.ts` → **`errorToast()`** — every error and every RPC refusal.
- `lib/utils.ts` → `cn`, **`focusNoScroll`**.
- `lib/supabase/server.ts` → the per-request client.
- `components/ui/` → `dialog`, `alert-dialog`, `sheet`, `select`, `input`, `textarea`, `label`,
  `button`.
- `types/supabase.ts` → every row shape (never hand-authored).
- `components/navbar.tsx` → `getBreadcrumb()` owns both page titles; **this module renders none**.

## See also

- `app/(app)/cenapro/CONTEXT.md` → "Supplier subgroups" and "Liquidation" for the schema, the views,
  the RPCs and the live verification.
- `app/(app)/cenapro/deliveries/CONTEXT.md` → the receipt ledger this attaches to. **Untouched by
  this work.**
- `.agents/prompts/liquidation-feature.md` → §5 (every settled decision), §7 (the eight steps),
  **§7a (the approved UI shape)**.
- `supabase/migrations/20260805110000_cenapro_rc_supplier_subgroups.sql`,
  `20260805120000_cenapro_rc_payments.sql` and
  **`20260805130000_cenapro_rc_supplier_opening_balance.sql`** → the contract, headers included. The
  last one's header is the authority on the as-of rule, the append-only lock, the four open decisions
  (preserve the full history / `carried_*` is what makes it defensible / the unpriced counts stay
  all-time / a dateless receipt counts fresh) and the regression guarantee.
