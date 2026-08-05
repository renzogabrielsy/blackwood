# 2026-08-05 — Cenapro grid hardening, a platform sweep, and the liquidation design

> **Read `2026-08-04-cenapro-rc-deliveries-context-and-liquidation-direction.md` first** for how
> RC Deliveries came to exist. **Several of its "state facts" are now stale** — corrected below.

---

## TL;DR

The Cenapro RC Deliveries ledger went from *built but never used* to *used all day by Renzo*, and
that first real session found eight bugs, three of which had been invisible because nothing ever
exercised the keyboard or the clipboard. All eight are fixed and live. Three of them turned out to
be **platform-wide**, not Cenapro-specific, so the fixes swept nine files across five modules.

Two schema changes landed (**typable PLANT**, **derived flag resolution**) plus one from the day
before that shipped today (**duplicate pairing**).

**The liquidation feature is fully designed and not started.** All sixteen open questions are
answered, the build plan is eight steps, and Steps 3–5 are wireframed and approved. `Step 1 needs
no further input and is ready to build.`

**Everything is on `main` at `aff9bdb` and deployed.** `feat/cenapro-deliveries-qol` is one
memory-only commit ahead.

---

## What shipped — 13 promotions to `main`

| Merge | Work |
|---|---|
| `c8ffc53` | The eleven QOL items (below) |
| `82ae4f7` | Tab/caret no longer scrolls the page; horizontal caret-follow past the frozen block |
| `98805ff` | **The virtuoso index bug** — Tab/Enter jumped to the last row |
| `2d6e422` | Escape reverts a cleared cell; two-stage Escape |
| `7aff668` | Platform `focus()` fixes + Cenapro drag auto-scroll + derived summary spans |
| `a0a6bfb` | QC add-draw: every cell editable, Excel dates, a real Cancel |
| `d4741ca` | **PLANT is typable** (migration + UI) |
| `c502b40` | Horizontal cell borders restored |
| `e5523f3` | Grid rules darkened |
| `0d0a61d` | Day spacer rows |
| `53b01e2` | Real empty spacer row; paste/copy/range-delete repairs; liquidation brief |
| `32f1623` | **The paste focus sink** — paste reaching the grid at all |
| `aff9bdb` | Derived flag resolution (SQL + UI); the autofocus/border sweep; liquidation questions |

**Migrations applied:** `20260804072000_cenapro_rc_delivery_duplicate_groups.sql` ·
`20260804080000_cenapro_partner_draw_optional_plant.sql` ·
`20260805090000_cenapro_rc_delivery_flag_resolution.sql`

**Verification:** `verify-rc-deliveries-cells.ts` **20 → 116** · `verify-qc-draw-cells.ts`
**NEW, 36** · `verify-rc-formula.ts` 22 unchanged. Lint held at its exact baseline
(166 problems / 28 errors, all pre-existing in `blocking-detail-panel.tsx` and
`workers/sync/test/*`) through every promotion.

### The eleven QOL items (Renzo's original list)

Cell-ring geometry · draft rows for new receipts (20 blanks + "add more") · select-vs-edit ·
empty REMARKS editable · Escape genuinely cancelling · month badge removed · per-column filtering
on twelve columns · Excel-style dates · duplicate peers visible · the floating selection-stats
pill · and the unsaved-work guard that was added because the filters made an existing data-loss
path twelve times more reachable.

---

## ⚠️ Corrections to the 2026-08-04 handoff

1. **"All 991 rows are `sheet_import`. Not one row has been created or edited in the app."**
   False on both counts now. Renzo **deleted the 22 duplicates** (hard DELETE, no audit trail),
   **edited 8 rows** (two `5/262026` dates → 2026-05-06, five destinations mapped), and the row
   count has since risen to **971**, meaning **two receipts appear to have been created in-app**.
   *Verify `provenance = 'app'` at the start of the next session — it was 0 when measured at 969.*
2. **"The ₱17.2M duplicate decision has not been made."** It has. 969 receipts /
   ₱726,664,785.5625 was measured immediately after; the deletion reconciled **to the peso**.
3. **`0 duplicate groups` remain.** The pairing columns still exist and still work; nothing pairs.

---

## Critical learnings — the expensive ones

**1. Clipboard events and keydown events do NOT follow the same rule. This cost three rounds.**
Delete, Escape, arrows and Ctrl/Cmd+C all worked on a focused non-editable `<div>` because
**keydown goes to whatever has focus.** `paste` does not — the browser dispatches it at an element
that can *accept* a paste, so it went to `document.body`, an **ancestor of React's root
container**, where React's listener can never see it. Silent by construction. The fix is a **hidden
focus sink** (a real `<textarea>`, `opacity-0`/`size-px`, never `display:none`/`sr-only` which are
unfocusable, never `readOnly`) plus a bubble-phase `document` fallback.
*Corollary trap:* `isGridChrome` returns true for any `TEXTAREA`, and `onGridKeyDown` bails on
chrome — the sink had to be **exempted before the tag test** or it would have silently killed
Delete, Escape, copy and type-to-edit.

**2. `HTMLElement.focus()` scrolls with block AND inline `"center"`, through every scrolling
ancestor, even when the element is already fully visible.** React's `autoFocus` calls it bare.
This was jogging the page on **69 sites across 9 files**. One shared `focusNoScroll` helper now
lives in `lib/utils.ts`.

**3. Under `border-collapse: separate`, a border on a `<tr>` is ignored outright** — the spec
paints cell borders only. Five grids were drawing row rules that never rendered. **Never flip to
`collapse`** to fix it: sticky frozen columns lose their borders under `collapse`, which is worse.

**4. react-virtuoso's `scrollToIndex` / `scrollIntoView` take the RAW ARRAY INDEX and clamp to
`totalCount - 1`.** `firstItemIndex` offsets only the index reported OUT to
`itemContent`/`computeItemKey`. Passing `firstItemIndex + i` (seeded at 100,000) clamped every
call to the last row — Tab and Enter slammed the sheet to the bottom. The clamp being measured
against `totalCount`, not `firstItemIndex + totalCount`, is the proof.

**5. `h-full` on a child of an unsized `<td>` collapses to text height.** One root cause for two
symptoms: the active ring traced the *text box* instead of the cell, and an **empty** cell had
zero clickable area (which is why empty REMARKS could not be edited).

**6. Dirty-state bookkeeping bit twice.** Escape restored the value but left the field in the
edits map; then Backspace wrote an empty value with no snapshot at all. Both are now general:
*any* edit returning a field to its stored value clears its dirty state, and Escape outside edit
mode reverts the selection. **Over-test this area** — it has the highest defect rate in the module.

**7. `total_price_php = 0` does NOT mean ₱0 owed.** The generated column `COALESCE`s both factors,
deliberately. Eight receipts read ₱0 and none is free charcoal. **Any balance built as
`SUM(total_price_php) − SUM(payments)` silently under-states the payable and marks all eight
settled.** Liquidation must carry an explicit priceability predicate.

**8. The duplicate signature needed the FULL lab panel, destination side and remarks.** The
obvious tuple (date + truck + supplier + weight + price) produced **three false pairs** — two
SEVILLA lab samples differing only in moisture, one PALAWAN load split across WHSE A's left and
right sides, and one BRIX pair differing only in destination. Empirical beat plausible.

**9. `useCellSelection` synced its anchor/focus refs only at render**, so
`seedFromActive()` → `extend()` in one handler saw no anchor and started every shift+arrow range
at **(0,0)**. Every grid on the platform had it; drag-select was unaffected, which is why it
looked intermittent.

**10. The 22-duplicate deletion left ZERO trace.** `audit_logs` has no row mentioning `cenapro` or
`rc_delivery`, and unlike `production_event` that table has no audit child. Renzo has since asked
for the ICTC audit feature on **both deliveries and payments** — Step 1 of liquidation.

---

## Current state

**RC Deliveries (`/cenapro/deliveries`)** — 971 receipts, 2026-01-02 → 2026-08-04. Twelve filter
columns, both scopes, duplicate peers, day spacers, full clipboard, draft rows, the unsaved guard.
116 assertions. **Its `CONTEXT.md` is long and current — read it before touching the grid.**

**Data quality:** 12 receipts carry an import flag; **only 2 are genuinely unresolved** —
`source_row` 343 (`supplier_unmapped`, `HILONGOS - BRIX`, written backwards: every other row is
trader-first) and `source_row` 928 (`bd_out_of_range` — the extractor **refused to store** `23995`,
so that receipt has **no BD reading at all**; the raw value survives only inside the flag).
Flags are **never mutated** — resolution is derived in SQL.

**QC (`/cenapro/qc`)** — every add-draw cell editable including the four lab metrics (applied to
the sample group the draw creates, conflicting readings refused naming both values). PLANT is a
real dropdown; blank means "follow the source", never "no plant". Both dates are free text and
start blank. 36 assertions where there were none.

**Platform** — `focusNoScroll` in `lib/utils.ts`; `EditInput`, `GridCell`, `DatePickerCell` and
`AutocompletePopover` all guarded; `use-cell-selection.ts` publishes its refs synchronously.

---

## Liquidation — designed, not started

**`.agents/prompts/liquidation-feature.md` is the working document.** It carries the schema
proposal, all 16 answered questions, the three follow-ups Renzo answered second-pass, the
eight-step build plan and the approved UI shape.

**Answered and settled:** cheque always to one supplier (may cover its sub-suppliers) · cheque and
bank transfer only · 99.99% outgoing but keep `direction` · store bank + account, not
front-of-screen · **negative = we owe them** · human-initiated balance close/restart · **no
per-supplier rounding rule** ("just leave it alone") · both carry and write-off · ₱0 receipts are
incomplete not settled · edit and delete both **warn** · over-allocation is **recorded** · no
cheque status lifecycle but **do detect skipped cheque numbers** · admins/everyone may record ·
**ICTC-style audit on deliveries AND payments** · supplier subgroups auto-verified
(Paquibot → Llanto) · **both cheque-first and delivery-first entry**, two doors onto one screen.

**The eight steps:** 1 audit trail + doc corrections · 2 supplier subgroups · 3 banks, payments,
running balance · 4 allocation (both doors) · 5 advances (UI only, no new tables) · 6 close and
restart a balance · 7 cheque books and gaps · 8 reporting.

**Renzo's own stopping point: after Step 3.** That is the first moment the system answers "what do
we owe BRIX", and using it for real will sharpen Step 4 more than planning will.

> ⚠️ **The ICTC generalisation has an uncosted prerequisite.** Renzo used ICTC names deliberately
> ("we will be eventually including ictc anyway"). But `public.deliveries.supplier` is **free
> text** with a `canonical_supplier()` helper — ICTC has **no supplier dimension at all**.
> Extending liquidation there means building one first and reconciling years of free-text values.
> **Recommendation: build in `cenapro` now, in a shape that ports, and do not genericise.**

---

## Next concrete actions

1. **Verify `provenance = 'app'`** and the current receipt count. Two rows appeared today; if the
   in-app INSERT path has now been used for real, that closes the last untested write path.
2. **Start liquidation Step 1** — the audit trail. Needs no further design input.
3. **Finish the focus sweep.** Deliberately left, all real: the RC Deliveries **column-filter
   popover inputs** (4 sites — that file was locked to a concurrent agent), and
   `components/shared/grid/RemarksCellAdaptor.tsx:81`. Also `flecon-bags-view.tsx:274`.
4. **The dirty-row stripe on Production Daily and Trucks has never been visible.** `border-l-2` on
   a `<tr>` is inert for the same reason as the row rules. The fix is to move it to the first cell
   only (as the Cenapro ledger does) — a row-state rendering change, deliberately out of the sweep.
5. **Resolve the last 2 flagged receipts** — `HILONGOS - BRIX` needs a payee; `source_row` 928
   needs a BD reading or an explicit "there is none".
6. **Confirm on sight, do not ask again:** that the balance screen showing each trader's own number
   *plus* a group total for the parent is what Renzo wants, and that the resolved-flag clock glyph
   reads as history rather than as an alert (especially in dark mode).

---

## Traps worth carrying forward

1. **Never trust `onPaste` on a non-editable element.** The focus sink is load-bearing; simplifying
   it back to a handler on the container silently breaks paste with no error.
2. **Never re-add a border to a `<tr>`** in a `border-collapse: separate` table, and never flip to
   `collapse`.
3. **Never pass `firstItemIndex + i` to a virtuoso scroll API.**
4. **Never use React's `autoFocus` on a grid cell editor** — use `focusNoScroll`.
5. **Money is never computed in TypeScript here.** Three generated columns and a CHECK exist so it
   is unnecessary; the stale-italic TTL PRICE is the deliberate cost of honouring that.
6. **The import's tolerance is not the app's tolerance.** Imported rows may carry NULL
   supplier/destination; app writes may not.
7. **`stripPrices()` is the ONE ₱ boundary** and it nulls server-side, before the payload returns.
   The four duplicate columns and the four flag-resolution columns are deliberately **not** gated —
   "this receipt is duplicated" is an operational fact, not a money fact.
8. **Parallel agents in one module collide.** Today two agents edited
   `deliveries/{types.ts,actions.ts}` simultaneously and the tree was briefly red with errors
   belonging to neither. It resolved, but **schedule at most one writer per module**, and when a
   schema change widens a row type, remember `actions.ts` selects an **explicit column list** that
   must be widened in the same breath.
9. **Verify subagent claims on disk.** Every promotion today was re-verified independently
   (verify scripts + `tsc` + `build` + `lint`) before shipping. Two agents corrected the brief they
   were given — one showed a "controlled experiment" in my reasoning was not real evidence, another
   found the true unresolved-flag count was 2, not 1. **Both were right.**
