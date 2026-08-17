# 2026-08-17 — Universal Table Module: the plan, and Phase 0 shipped to the branch

> Second session of 2026-08-17. The first one (see
> `2026-08-17-liquidation-step-4-sync-integrity-and-the-deploy-gap.md`) closed liquidation
> Step 4 and a week of sync bugs. This one starts a new initiative.

---

## TL;DR

Renzo asked for **one table module** every table in the app uses, modelled on the Cenapro
RC Deliveries ledger — *"I'd really like things to feel coherent so when I input data, I
don't have to feel like I'm adjusting based on what feature I'm using."*

Four read-only audits were run, a phased plan was written, and **Phase 0 is done**: the
three dangerous defects those audits found are fixed, plus a fourth. One of them was in a
**shared platform hook and therefore in all 8 grids at once**; one was a **security hole**;
one **wrote wrong data into real receipts and reported success**.

Everything is on **`feat/universal-table`** (`b4620a5`). **Nothing is merged to `main`.**

---

## What shipped

| Commit | Work |
|---|---|
| `22eaff5` | The plan + the research pack (`.agents/prompts/universal-table-module.md`, `docs/universal-table/`) |
| `b4620a5` | **Phase 0** — BUG-022 · BUG-023 · BUG-024 · BUG-025 |

### BUG-022 — typing over a range dragged UP or LEFT edited the wrong cell (ALL 8 GRIDS)
`lib/hooks/use-grid-keyboard-nav.ts`. The range branch moved the caret to the rectangle's
**top-left** and then fell through to a handler that still used the **pre-move** active
cell. `anchorId()` is the geometric top-left; `activeCell` is where the drag *started*.
They differ on every up/left drag — so the character went into one cell (dirty, no editor)
while the editor opened on another showing a different value. The branch now only clears
the range, which is symmetric with the nav branch beside it and matches Google Sheets.

### BUG-023 — clicking a read-only cell killed the keyboard
`deliveries-ledger.tsx` set the active cell to `null` for a non-addressable cell, and the
keyboard state machine returns on its first line when there is no active cell. Clicking
`TTL PRICE` cost you arrows, Tab, Escape, Delete and copy until you clicked elsewhere.

### BUG-024 — a multi-row paste scattered cells into moisture draws and said "Pasted 5 rows"
The block was mapped positionally (`anchor.row + r`), straight through the draws under a
receipt. New pure helper **`pasteRowTargets()`** resolves target rows **by family** first;
`planPaste` is reused verbatim for the overflow; the step-over is reported
(`· 2 draw rows skipped`); a draw-anchored block can no longer manufacture receipts.

### BUG-025 — receipt delete had no role gate and printed cheque numbers + ₱ to any role
`deleteDelivery` was the only action in that file never to call `canViewPrices()`, and
`/cenapro/**` has no route gate — so any signed-in user could read a receipt's cheques out
of the delete dialog and then delete it. New canonical **`isPrivileged()`** in
`lib/auth.ts` gates the action (Owner/Admin/Dev) and hides the menu item; the money is
redacted to a **count** for a gated viewer, with `pricesHidden` so the dialog says the
amounts are hidden rather than rendering a blank that would read as "no money here".

---

## ⚠️ OUTSTANDING — four browser repros nobody has run

The Chrome extension was not connected and the in-app browser has no session, so these
were **not** verified in a browser. The code-level evidence is strong (typecheck, build,
198 assertions incl. source scans that read the real branch bodies), but these four
gestures are the actual proof. **A dev server is already running on
`http://localhost:3000`.**

1. **`/cenapro/deliveries`** — drag-select from a row ~20 `WT` cell **up and left** to a
   row ~15 `SKS` cell, then type `5`. ✅ = the `5` appears in the row-20 WT cell with its
   editor open, and nothing else changed. (Press Escape after; don't Save.)
2. Click any **`TTL PRICE`** cell, then press ArrowDown / Tab. ✅ = the caret moves.
3. Navbar shield → **view as Production** → right-click a receipt. ✅ = no
   *"Delete receipt…"* item. Switch back to Owner → it returns.
4. Copy 5 receipt rows out of Google Sheets, paste onto a receipt that **has moisture
   draws**. ✅ = 5 receipts change, the draws do not, toast reads
   `Pasted 5 rows · 2 draw rows skipped`. (Escape / reload after; don't Save.)

These become Playwright specs **T02** and **T21** in Phase 1, so this is the last time
they need a human.

---

## The plan (read this before continuing)

**`.agents/prompts/universal-table-module.md`** is the plan of record — decisions,
the port contracts, a 33-item Google-Sheets parity checklist (T01–T33), phases 0–5 with a
Definition of Done each, traps, and open questions. **`docs/universal-table/`** holds the
four audits behind it.

**Renzo's decisions (2026-08-17):** editable ledgers only · Cenapro-style inline editing
everywhere, **no add/edit dialogs** · RC IN → `/inventory/rc-in`, RC OUT →
`/inventory/rc-out`, tab bar + footer strip deleted, Year + Month picker + Endless/Focus ·
**Blocking untouched** · v1 must-haves: undo/redo, paste-one-value-fills-range,
Ctrl+Arrow/Home/End/PgUp/PgDn, row/column selection, right-click insert/delete/clear row,
column resize+reorder+hide per user · Playwright as the parity harness · order: module →
RC IN → RC OUT → ICTC Production → Flecon → Cenapro prod/QC → liquidation.

**Phase 1 is next:** build `lib/table/` + `components/shared/table/`, migrate the Cenapro
ledger onto it as the first consumer, add the Playwright harness against a dev-only mock
playground route. The perf audit is a hard gate: the ledger today has **no render boundary
at all** (one 3,780-line component, zero `React.memo`), so a keystroke re-renders every
visible cell — ~4,200 of them in a busy focus month. The module must be memoized by
construction, not patched afterwards.

---

## Critical learnings

1. **A shared hook's bug is every grid's bug.** BUG-022 sat in `use-grid-keyboard-nav.ts`
   and reached RC IN, RC OUT, Production ×3, Cenapro ×2, QC, the schedule grid and the
   deliveries ledger. Before extracting anything into a universal module, fix what is
   already shared — the extraction would have multiplied it, not exposed it.
2. **An "anchor" and an "active cell" are different things, and mixing them corrupts
   data silently.** The anchor is geometry (top-left); the active cell is intent (where
   the operator started). Google Sheets types into the second one.
3. **The action nobody thinks of as a READ is where the price boundary leaks.**
   `deleteDelivery` returns money. Every fetcher in that file was gated; the delete was
   not, because it is filed mentally under "writes".
4. **A gate that is copied is a gate that gets forgotten.** The privileged-role check was
   retyped inline in four RC IN actions and simply never written in Cenapro. It is now
   one predicate, `isPrivileged()`.
5. **A redacted figure must still announce itself.** Blanking the ₱ in the delete dialog
   without saying so would read as *"nothing is assigned to this receipt"* — the one
   message that would make a gated viewer delete it confidently and wrongly. Same rule
   `redactAuditJson` already follows.
6. **Positional row arithmetic is a bug the moment a sheet has more than one row family.**
   `anchor.row + r` was correct until moisture draws existed. The universal module asks
   `occupies(colKey)` per row instead — `pasteRowTargets()` is the seed of that.
7. **Anchor a source-scan's vacuous-pass guard on CODE, not a comment.** The first version
   of `verify-grid-keyboard-nav.ts` guarded on a section header that `stripComments`
   removes, so it failed on a perfectly healthy file.

---

## Current state

- **Branch:** `feat/universal-table` @ `b4620a5`, pushed. `main` (`b392e90`) and `dev`
  (`6447df5`) untouched.
- **Gates:** `tsc` clean · `npm run build` clean · `npm run lint` unchanged from baseline
  (166 problems / 28 errors, **all pre-existing** in `workers/sync/test/**`) ·
  `verify-rc-deliveries-cells` **120** · `verify-grid-keyboard-nav` **6** (new) ·
  `verify-rc-formula` 19 · `verify-qc-draw-cells` 36 · `verify-case-grouping` 17 ·
  `verify-trigger-grants` pass.
- **No DB change, no migration, no sync-worker change** — so `main` → Vercel is the whole
  deploy when it ships.
- A dev server is running on port 3000 (started via `preview_start`, config
  `.claude/launch.json`).

## Open decisions

1. **Ship Phase 0 to `main`?** The approved plan defers the merge to Renzo's word. The
   browser repros above are the only thing standing between here and shipping.
2. **The commit subject on `b4620a5` says "three dangerous grid defects" while its body
   enumerates four.** Harmless on a feature branch; fix the wording at merge time.
3. Phase 1's own open questions are listed in §7 of the prompt (RC IN edit-reason,
   expanded-mode annotations, RC OUT history viewer, Closed Blocks, production tabs,
   Cenapro pivots, liquidation scope, column reorder across a pin boundary, whether undo
   survives Save).

## Next concrete action

Run the four browser repros above, then say ship — or go straight into **Phase 1** and let
the Playwright harness prove them instead.
