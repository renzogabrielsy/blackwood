# 2026-08-05 (later) — Liquidation Steps 1–3: the audit trail, subgroups, and the running balance

> Continues `2026-08-05-cenapro-grid-hardening-and-liquidation-design.md`, which ended with the
> liquidation feature **fully designed and not started**. It is now started, and the first three
> steps are live.

---

## TL;DR

**Steps 1, 2 and 3 of the eight-step liquidation plan are built, verified and deployed to `main`.**
That covers everything up to and including Renzo's own stated stopping point — the system can now
answer *"what do we owe BRIX right now"*, which nothing could answer this morning.

Three migrations, one new UI module (`/cenapro/liquidation`, three screens), and a per-receipt
history dialog on the deliveries ledger. **Merge commit `a86643a` on `main`.** All three migrations
were already applied to production Supabase before the merge, so the deploy is code-only.

**Not built, deliberately: Steps 4–8.** No allocations. A payment reduces a supplier's balance
without being assigned to specific receipts — by design for this step.

---

## What shipped

| Commit | Work |
|---|---|
| `6a84e9a` | **Step 1** — `cenapro.rc_delivery_audit` + the per-receipt history dialog + doc corrections |
| `edcfea1` | **Steps 2 + 3** — supplier subgroups, banks/accounts/payments, the running balance, three screens |
| `a86643a` | Merge to `main` |

**Migrations applied:** `20260805100000_cenapro_rc_delivery_audit.sql` ·
`20260805110000_cenapro_rc_supplier_subgroups.sql` · `20260805120000_cenapro_rc_payments.sql`

**Verification held throughout:** `tsc` clean · `npm run build` green with all three new routes ·
`npm run lint` at its **exact 166 problems / 28 errors** baseline through every promotion ·
`verify-rc-deliveries-cells.ts` 116 · `verify-rc-formula.ts` 22.

### Step 1 — the audit trail
ONE append-only table trailing both `rc_delivery` and its CASCADE child `rc_delivery_sample`,
discriminated by `entity` and **always keyed by the parent `delivery_id`**, so a receipt's whole
history is one indexed query. SECURITY DEFINER triggers; no role holds INSERT/UPDATE/DELETE.
Surfaced as "View history" on the ledger's row context menu.
**No backfill — the trail starts now.** It existed because 22 duplicate receipts were hard-deleted
on 2026-08-04 and left zero trace anywhere.

### Step 2 — supplier subgroups
`rc_supplier.parent_code`, **one level deep, enforced by a deferrable constraint trigger** (not
merely documented), audited, and **seeded with nothing** — all 12 suppliers are still roots.
`view_rc_supplier_group.group_code` is now the single definition of group membership; Steps 3 and 4
read it and never re-derive `coalesce(parent_code, code)`.

### Step 3 — banks, accounts, payments, balance
`rc_bank` (BDO/CHINABANK/METROBANK/AUB seeded) · `rc_bank_account` · `rc_payment`
(cheque | bank_transfer | adjustment; always-positive amount with a **separate `direction`** so a
careless SUM can never net two opposite movements to zero; `stated_term` as recorded intent only;
soft delete; audited) · `view_rc_supplier_balance` + `view_rc_supplier_group_balance` · the
save/delete/**restore** RPCs.
UI: supplier balances, record-a-payment + payment list, bank/account maintenance, subgroups.
Whole route behind `canViewPrices()` — **the query is not even run when denied.**

---

## Critical learnings

**1. The unpriceable-receipt trap produces NO peso discrepancy. Ever.** This is the single most
important thing learned today, and it corrects an assumption in the brief. `total_price_php` is
`COALESCE(gross,0) * COALESCE(base+adj,0)`, so it is **exactly 0** whenever a receipt is
unpriceable — which means `SUM(total_price_php)` and `receipts_php` (priceable only) are
**identically equal on every supplier, forever**. Measured: gap of ₱0.00 across all 971 rows.
So a naive balance does not return a *wrong* number. It returns the **right number with a silent
hole**, and marks every unpriced receipt settled the instant it exists. **SEVILLA is the live
proof: 2 receipts, balance ₱0.00, perfectly square, while carrying two receipts nobody can price.**
The gap is a **count gap, never a money gap** — which is strictly worse, because no amount anywhere
reveals it. That is why `unpriced_receipt_count` is on the row and not behind a hover.

**2. "Priced but not yet weighed" is a normal daily stage, not a migration artefact.** The five
weightless 2026-08-04 receipts got their weights — and two brand-new app-created receipts
immediately took their place, priced at ₱42/kg with no weight. The priceability predicate is
permanent infrastructure; the unpriced count will never sit at zero for long.

**3. `border-collapse: collapse` under sticky columns silently drops the `.frozen-edge` shadow.**
All three new tables shipped with it; pixel profiles across the seam proved the 1px inset divider
survived but the soft outward shadow — CLAUDE.md's "kill the seam" — **was not painting at all**.
Honest counter-finding from the same measurement: the *border-dropping* failure mode CLAUDE.md
warns about **did not reproduce in this Chromium**. The rule is still right; the reason it bites
here is the shadow, not the borders.

**4. `cn()` resolves two `bg-*` utilities to the last one — so a row tint REPLACES the opaque
base.** `isUnassigned && 'bg-muted/20'` made a frozen cell translucent (computed alpha 0.2) and
scrolling content bled straight through the trader name. Fix: opaque base listed **first**, every
row tint a **solid** token. Only `group-hover:` variants may stay translucent — a variant class
never replaces the base.

**5. A boolean patch column will not accept `1`/`0`.** `jsonb_populate_record` casts a JSON number
into a boolean column as a hard error, so `activePatch` sending `1` would have failed at the first
real click. Caught by a **refusal-only contract test** run against the live DB — the right way to
exercise a write path you cannot authenticate against.

**6. The parent's AFTER DELETE trigger fires BEFORE the RI cascade**, and this is not trigger-name
dependent. The parent row is invisible to every AFTER trigger of its own DELETE, so a child's live
lookup always misses — the sample trigger reads its identity back off the parent's own audit row,
which is provably already there.

---

## Current state

**`/cenapro/liquidation`** — supplier balances, both levels (a parent renders as a group row with
children nested beneath, each carrying its own number plus the group total). All 12 suppliers are
roots today, so the flat case is what you will see. Sign is stated **on screen**: *"Minus = we owe
them. Plus = they owe us."* Every row carries a `we owe` / `square` tag; no bare minus stands alone.

**Balances at ship time** (zero payments recorded, so every number is the full payable):
BRIX −₱212,669,462.50 · ZAPANTA −₱201,265,010.50 · DENCIO −₱85,671,911.50 ·
ALI UNGA −₱71,954,431.70 (2 unpriced) · NEGROS −₱69,297,652.06 · PALAWAN −₱55,280,642.50
(1 unpriced, 11,010 kg) · SEVILLA ₱0.00 with **2 unpriced** · plus a synthetic
**"no payee — cannot be liquidated"** row for the 2026-02-23 receipt worth ₱864,743.75.

**`/cenapro/liquidation/banks`** — 4 banks seeded, **0 accounts**. Nothing was invented; an account
number is a real fact about a real cheque book.
**`/cenapro/liquidation/subgroups`** — 12 roots, no parents set.

**RC Deliveries** — 971 receipts, 2026-01-02 → 2026-08-05, ₱729,637,074.1125, untouched by all of
this. Liquidation is strictly additive: it adds no column to `rc_delivery` and writes nothing in it.

---

## Next concrete actions

1. **Record one real cheque, end to end.** Add a bank account first (the DB requires one for a
   cheque; a bank transfer does not). **This is the only untested path** — writes go through
   `canViewPrices()`, which needs a real session, so no agent could exercise them. The RPCs were
   contract-tested with refusal-only payloads (8/8 refused cleanly, nothing written), but a
   successful write has never happened.
2. **Set up the real subgroups** if any exist among the 12 traders. The Paquibot → Llanto shape is
   an ICTC example; whether Cenapro has one is unknown.
3. **Step 4 — allocation.** The phase that earns the feature: the median cheque covers four to
   eight receipts. Both doors (cheque-first and delivery-first) create the same allocation rows, so
   the write path is built once.
4. **Decide Step 4's legality question, which the design does not yet answer:** is an allocation
   validated against the supplier grouping **at write time and frozen**, or **re-derived on read**?
   Re-pointing a parent silently changes today's answer to *"was that allocation legal"*.
   `rc_supplier_audit.parent_code` is indexed precisely so the historical question is answerable.
5. **Resolve the last 2 flagged receipts** — `HILONGOS - BRIX` needs a payee (it is the ₱864,743.75
   row that now shows as unliquidatable); `source_row` 928 needs a BD reading or an explicit
   "there is none".
6. **Carried over, still real, still not done:** the focus sweep's last sites (the RC Deliveries
   column-filter popover inputs, `RemarksCellAdaptor.tsx:81`, `flecon-bags-view.tsx:274`), and the
   dirty-row stripe on Production Daily and Trucks (`border-l-2` on a `<tr>` is inert — move it to
   the first cell, as the Cenapro ledger does).

---

## Traps worth carrying forward

1. **Never build a balance as `SUM(total_price_php) − SUM(payments)`.** Use
   `cenapro.rc_delivery_is_priceable()` — it exists so there is one greppable name.
2. **A non-zero balance is NEVER an error state.** Decision 8 killed the per-supplier rounding rule
   outright: suppliers deliberately carry remainders. No red, no badge, no auto-close, no nightly
   job that zeroes small balances.
3. **The sign is Renzo's, not the accountant's** — negative = we owe them. Stated in the column
   COMMENT *and* on screen.
4. **`stated_term` is recorded intent. No balance is ever computed from it.** When the label and the
   allocations disagree, the allocations are right.
5. **Cheque numbers are unique per ACCOUNT, not globally** — two banks will happily issue #001234.
6. **Payments are soft-deleted, never hard.** They are money records, not transcribed reference
   data. `cenapro_restore_rc_payment` exists because a soft delete you cannot undo is not
   reversibility.
7. **Re-running the RC importer today would re-insert the 22 deleted duplicates.** Their
   `(source_sheet, source_row)` keys are free again and it has no memory of a human deletion.
8. **`supabase gen types typescript --linked` via the CLI, never the MCP generator** — the MCP one
   drops `graphql_public`.
9. **One writer per module.** Every step here ran serially for that reason, and nothing collided.
