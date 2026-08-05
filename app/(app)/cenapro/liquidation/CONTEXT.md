# Liquidation (Cenapro RC) — supplier balances, payments, subgroups

## Purpose

`/cenapro/liquidation` answers the one question nothing in the system could answer before:
**"what do we owe BRIX right now."** `cenapro.rc_delivery` already knows what CI owes for every
truck; this is the **money going back out** — every cheque, bank transfer and write-off — plus the
running difference per trader.

It is **liquidation Steps 2 and 3's UI half** (`.agents/prompts/liquidation-feature.md` §7a). The
data layer shipped 2026-08-05 in three migrations and nothing consumed it until this route. Three
screens:

1. **Supplier balances** (`/cenapro/liquidation`) — one row per trader, both levels (a parent
   renders as a group row with its sub-suppliers nested beneath).
2. **Record a payment** (a dialog, opened from a trader's payments panel) + **the payments panel**
   itself, so a recorded payment is not write-only.
3. **Supplier subgroups** (`/cenapro/liquidation/subgroups`) — the maintenance screen for
   "a cheque to the parent may settle a sub-supplier's deliveries".
4. **Banks & accounts** (`/cenapro/liquidation/banks`) — CI's own banks and the accounts cheques
   are drawn on. **Not optional polish:** the `rc_payment` shape CHECK requires a cheque to name an
   account, and the migration seeded four banks but **zero accounts** on purpose, so without this
   screen the dominant instrument in the business is unrecordable.

**It ships a real balance BEFORE allocation exists.** Assigning a cheque to *particular receipts* is
Step 4 (`rc_payment_allocation`, `view_rc_delivery_settlement`) and is **deliberately not built**:
no allocation screen, no settlement column on the deliveries ledger, no cheque-gap report, no
`advance_php`. A payment reduces a supplier's balance without being assigned to specific receipts,
by design for this step — allocation *refines* the number, it does not enable it.

## Files

| File | Role |
|------|------|
| `types.ts` | **PURE module** (no `'use client'`, no React, no Supabase) — the shared vocabulary for the server page, the actions and every client screen. Owns the row-type aliases (derived from the generated `types/supabase.ts`), `num`/`formatPeso`/`formatKg`/`formatCount`/`formatDate`, **`balanceDirection` + `directionLabel` + `directionSentence` + `SIGN_NOTE`** (the sign, in words), **`unpricedPhrase` / `unpricedShort`** (the stage-naming warning), `UNASSIGNED_NOTE` / `UNASSIGNED_TITLE`, the `BALANCE_COLS` column table + `minBalanceTableWidth`, **`buildBalanceTree`** (a JOIN of the two balance views into render order — it never sums), the payment vocabularies (`METHOD_OPTIONS` / `TERM_OPTIONS` / `methodShort` / `isCheque`), the payment form shape + `validatePaymentForm` + `paymentPatchFrom`, and the `LiquidationOutcome` / `LiquidationResult` RPC vocabulary. |
| `actions.ts` | **`'use server'`** — `fetchSupplierBalances`, `fetchPaymentDimensions`, `fetchSupplierPayments`, `fetchSupplierGroups`, `savePayment`, `deletePayment`, `restorePayment`, `saveSupplierParent`. Enforces the ₱ gate on **every** read and write. |
| `page.tsx` | Server — the balances screen. Gate → fetch → hand off. Renders no title (navbar owns titles). |
| `price-gate-notice.tsx` | Server — what a price-denied role sees instead. A clean statement, not an error. |
| `liquidation-view.tsx` | Client — the balance table (frozen trader column, group nesting, the sign tag, the unpriced column, the no-payee row) + the payments-panel host. |
| `payments-panel.tsx` | Client — a `Sheet` listing one trader's payments (voided rows included, struck through, with Restore), plus the void `AlertDialog`. Also exports **`InlineError`** (message + Copy button), reused by the other two screens. |
| `payment-dialog.tsx` | Client — the record/edit payment form. Reshapes itself around `method` so the fields the DB forbids are not on screen to be filled. |
| `subgroups/page.tsx` | Server — the subgroups maintenance screen. Gated (see "Why subgroups is gated"). |
| `subgroups/subgroups-view.tsx` | Client — one row per trader with a "PAID FOR BY" picker; saves on change. |
| `banks/page.tsx` | Server — banks & accounts. Gated for the same reason as subgroups: an account is half a cheque's identity and this is the only way to create one. |
| `banks/banks-view.tsx` | Client — banks with their accounts nested beneath, plus the add/edit dialogs and one-click retire/restore. |

## Data

All read-only accessors, all written by migration `20260805120000_cenapro_rc_payments.sql` and
`20260805110000_cenapro_rc_supplier_subgroups.sql`. **The `cenapro` schema is not exposed to
PostgREST** — everything goes through the `public.cenapro_*` accessors.

| Relation / RPC | Used by |
|---|---|
| `public.cenapro_rc_supplier_balances` | `fetchSupplierBalances` — one row per trader + the synthetic no-payee row |
| `public.cenapro_rc_supplier_group_balances` | `fetchSupplierBalances` — the SQL rollup that draws the parent rows |
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

**Not consumed yet:** `public.cenapro_rc_payment_audit` only — there is no payment-history UI. See
"Known gaps".

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
`table-fixed` + explicit pixel widths whose **sum is the min-width**, wrapped in `overflow-auto`
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

## Known gaps (stated, not hidden)

- **There are still zero bank accounts in the database**, so a cheque cannot be recorded *until
  someone adds one* — but that is now a one-screen task rather than a dead end
  (`/cenapro/liquidation/banks`). Nothing is seeded on purpose; Renzo types the real number.
- **No payment-history UI.** `public.cenapro_rc_payment_audit` is unread. Note the ₱ trap: `changed`
  and `snapshot` are free-form jsonb carrying `amount_php`, and a field-list redactor cannot reach
  inside a blob — any action exposing it must delete the ₱ keys **out of the jsonb**, exactly as
  `deliveries/actions.ts::redactAuditJson` does.
- **Step 4+ is not built** and must not be added here piecemeal: no allocations, no settlement
  column on the deliveries ledger, no cash-advance drawdown, no balance close/restart, no
  skipped-cheque-number report.

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
- `supabase/migrations/20260805110000_cenapro_rc_supplier_subgroups.sql` and
  `20260805120000_cenapro_rc_payments.sql` → the contract, headers included.
