# 2026-08-17 — Universal Table: Phase 1 module built, and the method for landing Stage 1D

> Continues `2026-08-17-universal-table-plan-and-phase-0.md`. That session planned the work and
> shipped Phase 0 to `main`. This one built the module — and learned, twice, why Stage 1D cannot
> be done the way it was specified.

---

## TL;DR

**The universal table module is built, tested and committed.** `lib/table/` (pure) +
`components/shared/table/` (React) + four `lib/hooks/use-table-*`, with a dev playground and
**33 Playwright specs that drive the real component with no login and no database**.

**Stage 1D — rewiring the Cenapro RC Deliveries screen onto it — has NOT landed**, across two
serious attempts. Neither wrote a line of the rewire, and `app/(app)/cenapro/` is byte-identical
to `main`. Both attempts were right to stop, and both spent their budget productively: between
them they found **three seams the module was missing**, all now built and proven.

**The blocker is the METHOD, not the module and not the agents.** The brief demanded
*"every gate green, or revert"*, which makes 1D a single atomic ~3,000-line change with no room
for the iteration a file that size needs. Atomic **and** oversized means it can never land.

**The fix is to build the new grid BESIDE the old one behind a URL flag** — the strangler-fig
pattern. Detailed below; that is the next session's job.

---

## What shipped (all on `feat/universal-table`, none merged)

| Commit | Work |
|---|---|
| `1b88c04` | **Stage 1A** — `lib/table/`, the pure core, extracted from the ledger's `types.ts` (−403 lines there) |
| `b766ced` | **1B pt 1** — the memoized `Row`, the cached cell-class table, the single journalled writer, the paste sink |
| `9f5bb71` | **1B pt 2 + 1C** — `BlackwoodTable`, `use-table-{rows,interaction}`, `HeaderCell`, the dev playground, Playwright |
| `e131aef` | **Seams 1 & 2** — `firstItemIndex`, `renderChromeRow` |
| `154717d` | **Seam 3** — `apiRef` (`focus` / `goToRow` / `scrollToRow` / `setActiveCell`) |

**Read `lib/table/CONTEXT.md` first — it is the module's spec and it is current.**

### What the module gives a consumer

Three contracts: a **`ColumnSpec`** (what a column is — width, pin, format, parse, editable,
visible, clipboard value, filter, summary lane), a **`RowKind`** with **`occupies(colKey)`** (what
shape a row is — the per-row answer whose absence was BUG-024), and a **`DataSource`**.

Behaviours it owns: select≠edit, Enter/F2/double-click, Tab runs with the Enter-anchor, the
two-stage Escape, Delete that keeps the selection, rectangular ranges with edge auto-scroll,
frozen panes at **both** ends, group spacers, summary lanes, draft rows, the caret-follow, the
paste sink + document fallback — plus four things the old ledger never had: **undo/redo**,
**paste one value into a range**, **Ctrl+Arrow / Home / End / PageUp / PageDown**, and column
resize.

---

## Critical learnings

**1. "Green or reverted" makes a large rewire impossible, not safe.** The constraint is correct
for a live payment ledger, but combined with a 3,000-line scope it produced two attempts that
correctly refused to start. Safety has to come from **isolation**, not from atomicity.

**2. Attempting the migration was the only way to find the missing seams.** Three were invisible
until a real consumer needed them, and no amount of designing found them first:
- `firstItemIndex` existed **only in comments** — never a prop, never reaching the virtualiser.
  The endless keyset pager needs it or scrolling up jumps the sheet.
- `summaryRows` reached **only the footer**, so the focus scope's day heading and `Σ DAY TOTAL`
  rule-off — both *inside* the body — were inexpressible.
- There was **no imperative handle at all**: a consumer could react to the grid but never act on
  it. That blocks "go to row N", and blocks returning focus after a dialog closes (Radix restores
  focus to a context-menu item that has already unmounted, so the caret lands on `<body>` and the
  next keystroke goes nowhere — the fix needs the grid's internal paste sink).

**3. A seam must address the caller's index space, never the module's.** `apiRef.goToRow` takes a
**row id**, not a nav-row index: the consumer builds `items` but does not own `navRows`, and
letting it derive an index would be a second definition of that axis. Same class of bug as
rebasing `firstItemIndex` — the wrong index space, silently.

**4. Count ITEMS, not records.** `shiftFirstItemIndex` takes the two array *lengths* and does the
subtraction itself, because the rendered array grows by more than the record count (children,
spacers). Counting records is a pre-existing bug in `use-deliveries-window.ts`.

**5. React-virtuoso owns the `<tr>`.** It sets `data-index`/`data-known-size`/`style` there and
measures rows off `<tbody>`'s children, so a component rendering its own `<tr>` inside it loses
measurement. Hence `TableRowShell` (the row) and `TableCells` (the memo boundary) are separate,
and `renderChromeRow` returns **cells, not a row**.

---

## THE METHOD for Stage 1D — build it beside, not in place

The existing `deliveries-ledger.tsx` stays **untouched and in production** for the whole of this
work. The new implementation lands next to it and is reachable only on request.

### The shape

1. **New file** `app/(app)/cenapro/deliveries/deliveries-grid-v2.tsx` — the adapter over
   `<BlackwoodTable>`. The old `deliveries-ledger.tsx` is not edited at all.
2. **`page.tsx` picks between them on a URL param**, defaulting to the old one:
   `const v2 = params.grid === 'v2'` → render `<DeliveriesGridV2 …/>` or `<DeliveriesLedger …/>`
   with **the same props**. Both read the same server data; no action, RPC or query changes.
3. `?grid=v2` joins `axesKey(...)` so switching remounts cleanly.
4. **Nothing else changes.** `types.ts` keeps its alias layer until the old ledger is deleted —
   both consumers use it. The 16 source-scan assertions in `verify-rc-deliveries-cells.ts` keep
   passing **because the old file they scan is still there**; they are re-pointed in the final
   cutover commit, not before.

### Why this works where the atomic version did not

- **The rewire can land half-finished.** Session one might do columns + row kinds + read-only
  render; session two the edits and save; session three the dialogs. Every one of those is
  committable and green, because the production path is the old file and it never moved.
- **Comparison is direct.** Open `/cenapro/deliveries` and `/cenapro/deliveries?grid=v2` side by
  side on the same real receipts and diff them by eye.
- **Reverting is deleting one file**, not unpicking a rewrite.

### The cutover, when v2 is proven

One small commit: flip the default (or drop the param), delete `deliveries-ledger.tsx`, delete
the alias layer in `types.ts`, re-point the 16 source scans at the module, update the CONTEXT
files. That commit is small enough to review properly — which the atomic version never was.

### Suggested order inside v2

Column specs + row kinds → flatten (`items`, chrome rows, day spacer) → read-only render → edits
+ the save path → toolbar / filters / dialogs / menu → the aggregate pill and the axis guard.

### The sharpest remaining edge, from the second attempt's recon

**The moisture sub-row model.** `useTableEdits` is per-cell keyed, but the ledger's dirty state
today is *"a `sampleDrafts` entry exists"*, with `sameDrafts()` comparing the whole draw block and
`toSamplePayload` sending **every** draw including untouched ones. Keying draws
`${deliveryId}#${index}` gets you the cells, but you still need the receipt's dirty set to union
its draws' rows, and the save to reassemble the full block. **Add/remove of a draw stays
structural state** — and note `addSample` inserts *after* an index, so it renumbers every
`#index` key below it.

---

## Current state

- Branch `feat/universal-table` @ `154717d`, pushed. `main` @ `ff8b583` — Phase 0 only, live.
- `app/(app)/cenapro/**` and `app/(app)/inventory/**`: **untouched by all of Phase 1.**
- **No database work anywhere in this effort** — no SQL, no migration, no `types/supabase.ts`.
  Verified: `git diff --name-only main...HEAD` matches nothing under `supabase/` or `*.sql`.
- Gates, all re-run independently after each commit: `tsc` clean · `npm run build` clean ·
  `npm run lint` at its exact **166 problems / 28 errors** baseline (all pre-existing in
  `workers/sync/test/**`) · `verify-table-core` **34** · `verify-rc-deliveries-cells` **120**
  (replays all 991 real receipts) · `verify-grid-keyboard-nav` **6** · `verify-rc-formula` **19** ·
  `verify-qc-draw-cells` **36** · **33/33** Playwright.

## Open decisions

1. **Before this branch reaches `main`, confirm `TABLE_PLAYGROUND` is NOT set in Vercel
   production.** `/dev/table-playground` has two independent locks (the page 404s; middleware only
   makes the path public outside production) but both read that variable, and it lives in the
   dashboard, not the repo.
2. Phase 1's §7 questions in `.agents/prompts/universal-table-module.md` are still open, but none
   of them block v2.
3. Whether to keep `?grid=v2` as a permanent escape hatch after cutover. Recommendation: no —
   delete it, or it becomes a second grid nobody maintains.

## Next concrete action

Start a fresh session with:

> Read `lib/table/CONTEXT.md` and `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`,
> then build `deliveries-grid-v2.tsx` beside the existing ledger per the method in that handoff.
> Do not edit `deliveries-ledger.tsx`.

`app/dev/table-playground/playground-grid.tsx` is a complete worked example of wiring a consumer —
column specs, row kinds with `occupies()`, chrome rows, drafts, a hidden-by-role column, the
editor contract. Follow its shape.
