# Blackwood Table — the pure core (`lib/table/`) — CONTEXT.md

## Purpose

The **platform-layer**, tenant-neutral core of the universal table module: one Excel-style
grid every editable ledger in the app is built on, so *"when I input data, I don't have to
feel like I'm adjusting based on what feature I'm using"* (Renzo, 2026-08-17).

**This half is PURE** — no React, no Supabase, no `'use client'`, no tenant knowledge.
It is the geometry, the clipboard exchange, the dirty rules, the undo journal and the jump
maths, all expressed as functions over plain data so they can be asserted without a
browser. The React half (`components/shared/table/`) imports from here; nothing here
imports from there, from `app/**`, or from any tenant module. **`scripts/verify-table-core.ts`
enforces exactly that** — a scan refuses any import that is not a sibling, any mention of
React in code, and any tenant word (`charcoal`, `supplier`, `batch_code`, `peso`,
`cenapro`, `moisture`) in code.

Plan of record: `.agents/prompts/universal-table-module.md`. Audits behind it:
`docs/universal-table/`.

---

## Files

| File | Role |
|---|---|
| `types.ts` | **The PORT.** `ColumnSpec` (what a column IS), `RowKind` (what shape a row is — above all `occupies(colKey)`), `DataSource` (where rows come from), plus `GridRow`, `CellAddress`, `FieldEdits`, `TableSettings`, `SaveVerdict`. |
| `geometry.ts` | `pinnedCounts` / `pinnedOffsets` / `pinnedEndOffsets` / `pinnedWidth` / `isPinned`, `columnOffsets`, `minTableWidth`, `columnScrollLeft` (the caret-follow), `dragAutoScrollDelta`, `summarySpans`. |
| `clipboard.ts` | `parseClipboardTable`, `tsvEscape`, `clipboardNumber`, `planPaste`, `pasteRowTargets` + `pasteKindsCompatible`, and **`tilePaste`** (new). |
| `edits.ts` | `mergeFieldEdit`, `isDirtyFieldEdits`, `countUnsavedWork` / `hasUnsavedWork` / `describeUnsavedWork`, the draft-row constants, and **`createJournal` / `invertStep`** (new). |
| `nav.ts` | **New.** `edgeJump` (Ctrl/Cmd+Arrow), `rowEdge` (Home/End), `sheetCorner` (Ctrl+Home/End), `pageJump` (PageUp/Down). |
| `grouping.ts` | `needsGroupSpacer`. |
| `index.ts` | Barrel. Import from `@/lib/table`, never from a file inside it. |
| `../../scripts/verify-table-core.ts` | **25 assertions, must stay green.** Covers what the first consumer structurally cannot produce: end-pinned columns, tiling paste, the journal, the jump keys — plus the purity scan above. |

---

## Key behaviours

### `occupies()` — the question the old code never asked

A sheet with more than one **row family** (a receipt and its lab sub-rows; a shift and its
runs) has rows that disagree about which columns they have. `RowKind.occupies(colKey, row)`
returns the field and editability, or **`null` meaning "this row has no cell there"** — and
that one answer drives the keyboard (step over it), the paste (do not land on it), the
selection pill (do not total it) and the tint (do not paint it).

Its absence was **BUG-024**: a paste mapped block rows onto nav rows by arithmetic, wrote a
receipt's data into its moisture sub-rows, and reported success.

### A pinned column is `pin: 'start' | 'end'`, never `frozen: boolean`

The boolean could only ever describe a **prefix** — every helper walked from index 0 and
stopped at the first unfrozen column — so a right-pinned actions column was inexpressible,
and four consumers (caret-follow, drag auto-scroll, footer corner, summary spans) each read
that assumption. A pinned **run** still has to be contiguous at its end, because that is
what `position: sticky` can paint; a stray `pin` in the middle ends the run and lays out as
an ordinary column (asserted).

### Summary lanes are declared, not looked up by key

`summarySpans` used to find its lanes with `key === 'wt'` / `key === 'ttl'`. It now reads
`summaryLane` off the spec, so inserting a column widens the lane containing it and hiding
one removes its lane. **Both forms tile exactly** — `label + weight + note + total +
trailing` and `frozen + spacer + weight + note + total + trailing` each equal `cols.length`
for ANY column table (asserted over four mutations). **A span of 0 renders no cell at all**:
`colSpan={0}` means "to the end of the column group" in HTML, the opposite of nothing.

### One journalled writer, or there is no undo

`createJournal()` is a bounded (200) undo/redo stack over `CellMutation`s. It is
deliberately ignorant of how edits are stored — it hands a step back and the caller applies
`before` (undo) or `after` (redo) **through the same single writer every other mutation
uses**. That is the whole design constraint: undo could not be retrofitted onto the ledger
this came from because five separate code paths wrote cell state directly, so a journal
would have been a second definition of "how a cell changes".

- **A gesture is one step.** A 300-cell paste is one Ctrl+Z, because that is what the
  operator did.
- **A step that moved nothing is not a step** — a commit that re-typed the same value must
  not eat a Ctrl+Z.
- **`draftsAdded` rides on the step**, so undoing a paste that ran past the end also removes
  the blank rows it created.
- **Cleared on a successful save** and on an axis remount. An undo reaching back past a save
  would have to un-write the database.

### `tilePaste` — one copied value fills a selection

Sheets' habit, and the gesture the old paste could not do at all. Tiles when the selection
is a whole-number multiple of the block in **both** dimensions and larger than it — which
makes the 1×1 "fill the range with this value" case fall out for free rather than being a
special case. Anything else pastes once from the anchor, exactly as before.

### Dirty state: an edit that undoes itself is not an edit

`mergeFieldEdit` DROPS a field when the text is back to the stored value. Not a nicety:
`revertChanges` cancels an Escape by writing the pre-edit snapshot back, which is a correct
VALUE and a wrong DIRTY STATE, so the row stayed dirty and Save stayed lit with nothing to
write. Note the deliberate asymmetry — **clearing** a stored value IS an edit.

`describeUnsavedWork` takes its **nouns as a parameter** so each consumer names its own rows
("3 edited receipts and 8 typed new rows") without a second copy of the counting.

### The jump keys read two probes, never the DOM

`edgeJump` implements Sheets' actual rule (run to the end of a block · skip a gap from a
block edge · from a blank, land on the next filled cell · else the far edge) over injected
`exists(row,col)` and `filled(row,col)`. `exists` is what lets a vertical run **step over**
coordinates a child row does not have. Every jump returns `null` when the caret is already
there, so a key that owes nothing is a no-op rather than a re-render. `pageJump` accumulates
**real row heights** — rows are not uniform, so a page cannot be a row count.

---

## Status

**Stage 1A of Phase 1 is complete** (2026-08-17). The pure core exists and the Cenapro RC
Deliveries module is its first consumer: `app/(app)/cenapro/deliveries/types.ts` re-exports
these helpers under its own names, so the grid, the server page and that module's
**120 assertions run through this code unchanged** — which is what proves the extraction
was behaviour-preserving.

**Stage 1B is under way** — see the section at the end of this file for what has landed and
what has not. The dev playground and the Playwright parity suite are Stages 1C–1E.

**The alias layer in the Cenapro module is temporary.** `frozenOffsets` / `frozenBlockWidth`
/ its `DragScrollInput` / its `UnsavedWork` exist so the extraction changed nothing; they
are deleted when that ledger moves onto the React module in Stage 1D.

## Dependencies

None. That is the point — this module imports nothing outside itself.

## See Also

- `.agents/prompts/universal-table-module.md` — the plan, the parity checklist T01–T33.
- `docs/universal-table/` — the four audits (code, perf, RC IN/OUT features, table inventory).
- `components/shared/grid/CONTEXT.md` — the earlier primitives this supersedes; they stay
  until their last consumer migrates.
- `app/(app)/cenapro/deliveries/CONTEXT.md` — the first consumer, and the source of every
  decision re-expressed here.
- Project `CLAUDE.md` — Excel Standard, "never crush always scroll", Frozen Panes, Motion,
  the Error Toast HARD RULE, price gating.

---

## Stage 1B (in progress) — the React half

`components/shared/table/` and the `lib/hooks/use-table-*` hooks. Landed so far:

| File | Role |
|---|---|
| `lib/hooks/use-table-columns.ts` | `resolveColumns` (pure) + `useTableColumns`. Visibility → order → widths, then every measurement taken off the result, so the sticky offsets, the caret-follow, the drag wall and a footer corner cannot disagree about where a pinned block ends. **A saved order is re-grouped by pin**, which makes "reorder within a pin group only" structural rather than a rule to remember. |
| `lib/hooks/use-table-edits.ts` | **THE single journalled writer.** Every mutation — commit, clear, paste, fill, clear-row, revert, and undo/redo themselves — goes through `applyEdits`. One `setState` per GESTURE, not per cell. Undo re-enters the same writer with `record: false`, so there is no separate inverse implementation to drift. |
| `components/shared/table/cell-classes.ts` | The memoized class table. A cell's classes are a pure function of ten enums, so they are built once per distinct combination instead of via two `twMerge` calls per cell per render (~8,500 of those per keystroke on a busy month). Bakes in the ONE-background precedence and the opaque-pinned-cell rule. |
| `components/shared/table/Row.tsx` | **The render boundary** — `React.memo`'d, with `NO_EDITS` / `NO_INVALID` singletons so an untouched row's props are referentially equal. Handlers live on the `<tr>` and dispatch by `data-col`: 3 closures per row instead of 4 per cell. |
| `components/shared/table/PasteSink.tsx` | The hidden `<textarea>`, `isGridChrome` (with the sink exempted FIRST) and `focusGrid` (always `preventScroll`). Carries the full explanation of why a `paste` handler on a non-editable div can never fire. |

**Still to build in 1B:** `BlackwoodTable` (the container — colgroup, header, virtuoso/plain
body, summary rows, draft pool), `use-table-rows`, `use-table-interaction` (keyboard +
selection + clipboard + caret-follow + drag auto-scroll), `HeaderCell`, and the chrome
(`PeriodPicker`, `ScopeToggle`, `AxisGuard`, `ColumnFilterPopover`, `TableSettingsMenu`).
