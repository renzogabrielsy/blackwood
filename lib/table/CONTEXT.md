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
| `paging.ts` | **New.** `shiftFirstItemIndex` + `DEFAULT_FIRST_ITEM_INDEX` — the bidirectional pager's PUBLIC index base, and the arithmetic that keeps a prepend from moving the viewport. |
| `index.ts` | Barrel. Import from `@/lib/table`, never from a file inside it. |
| `../../scripts/verify-table-core.ts` | **32 assertions, must stay green.** Covers what the first consumer structurally cannot produce: end-pinned columns, tiling paste, the journal, the jump keys, the row axis and its two predicates, the per-cell nav resolver, the chrome row, the pager's index base — plus the purity scan above and its counterpart over the React half. |

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

### `firstItemIndex` — the two index spaces a bidirectional pager lives in

A virtualiser that can PREPEND reports a **PUBLIC** index out (array position +
`firstItemIndex`) and takes a **RAW** one in. Prepending shifts every raw position, so a
row keeps its public index — and the viewport keeps its place — only if `firstItemIndex`
is decremented by exactly the number of rows added.

Three rules, and each of them is a way this goes wrong:

- **Decrement by the ITEMS prepended, never by the RECORDS fetched.** One fetched record
  can add several items — its child sub-rows, the group spacer above it, a heading. In the
  playground, 10 older records add **12** items; rebasing by 10 leaves the sheet two rows
  out. `shiftFirstItemIndex` therefore takes the flat array's length either side and does
  the subtraction itself: measure the array, do not count what you asked for.
- **The prepend and the new base land in ONE state batch.** Two updates render the list
  once with every row shifted and jump it back on the next commit. The playground keeps
  both halves in a single `useState` so they *cannot* be committed separately.
- **It rebases what comes OUT and nothing that goes IN.** `scrollIntoView` and
  `initialTopMostItemIndex` still take RAW array positions — both clamp against
  `totalCount`, so a rebased index resolves to the last row every time. `computeItemKey`
  reads the item and ignores the index entirely, which makes it immune by construction.

Two clamps in the helper, both deliberate: a list that got SHORTER shifts nothing (the
property is specified for inverse infinite scrolling and is only ever decreased), and the
result never goes negative (the virtualiser requires a positive base).

**A prepend that lands mid-scroll legitimately drifts by a row.** The virtualiser
suppresses its upward-scroll compensation while a scroll is in progress, so the parity
spec waits for the scroller to come to rest before pressing "load older" — which is also
what an operator does. Settled, the anchor row does not move by a pixel across two pages.

### `renderChromeRow` — a lane-spanning row INSIDE the body

`summaryRows` reaches the footer only (`fixedFooterContent` in the endless scope, `<tfoot>`
in focus), and every item in `items` goes through `TableCells`, which emits exactly one
`<td>` per column with no `colSpan`. So a group HEADING or a per-group rule-off interleaved
with the data was inexpressible. `renderChromeRow(item, api)` fills that seam:

- **Consulted only for items whose `RowKind.addressable` is false.** Returning `null`, or
  omitting the prop, is byte-identical with the behaviour before it existed. An addressable
  row can never be replaced by chrome, so the caret can never be pointed at one.
- **It returns the row's CELLS, not a `<tr>`.** The container wraps them in its own row
  element in both scopes, and that is load-bearing: `TableVirtuoso` owns the `<tr>` (it puts
  `data-index` / `data-known-size` / its own `style` there and measures rows off `<tbody>`'s
  children), so a renderer emitting its own row element would lose measurement — the defect
  already fixed once in `Row.tsx`, and the reason `TableCells` and `TableRowShell` are
  separate to begin with.
- **The row still gets its family's declared `height`, and never enters `navRows`.**
- The `api` carries `cols`, `spans` and `colCount` so a consumer can OBEY the layout rules
  rather than guess at them: **a lane of span 0 renders NO cell** (`colSpan={0}` is "to the
  end of the column group" in HTML, the opposite of nothing), and **a cell over a pinned
  column stays OPAQUE** — a solid token, never glass, or the scrolling rows bleed through.
- Must be referentially stable (`useCallback`): it is a dependency of every row's content.

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

**Stages 1B and 1C are complete** (2026-08-17). The React half is built, the dev playground
mounts it on an in-memory data source, and **33 Playwright specs drive the real component**
with no login and no database. See the two sections at the end of this file.

**Two additive seams were added afterwards** (2026-08-17), both found by a migration attempt
that correctly refused to proceed without them: **`firstItemIndex`** (a bidirectional keyset
pager needs the virtualiser's public index base) and **`renderChromeRow`** (a group heading
or per-group rule-off inside the BODY, which `summaryRows` reaches only in the footer).
Purely additive — a consumer that passes neither behaves exactly as before.

**Stage 1D — migrating the Cenapro RC Deliveries ledger onto the module — has NOT started.**
Nothing under `app/(app)/**` was touched.

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

## Stage 1B — the React half

`components/shared/table/` and the `lib/hooks/use-table-*` hooks.

| File | Role |
|---|---|
| `lib/hooks/use-table-columns.ts` | `resolveColumns` (pure) + `useTableColumns`. Visibility → order → widths, then every measurement taken off the result, so the sticky offsets, the caret-follow, the drag wall and a footer corner cannot disagree about where a pinned block ends. **A saved order is re-grouped by pin**, which makes "reorder within a pin group only" structural rather than a rule to remember. |
| `lib/hooks/use-table-rows.ts` | **New.** `resolveRows` (pure) + `useTableRows`, plus `columnAcceptsEdit`, `columnSelectable` and `createTableNavResolver`. The ROW axis: which rows the caret may land on, how tall every rendered row is, and the two predicates the whole module runs on — `cellExists` / `cellEditable`. |
| `lib/hooks/use-table-edits.ts` | **THE single journalled writer.** Every mutation — commit, clear, paste, fill, clear-row, revert, and undo/redo themselves — goes through `applyEdits`. One `setState` per GESTURE, not per cell. Undo re-enters the same writer with `record: false`, so there is no separate inverse implementation to drift. |
| `lib/hooks/use-table-interaction.ts` | **New.** Every gesture, composed once over `useGridKeyboardNav` × `useGridEditSession` × `useCellSelection` × `useCellAggregation` and the pure helpers. Keyboard, jumps, undo/redo, clipboard in and out, caret-follow, drag auto-scroll, the paste sink and its document fallback. |
| `components/shared/table/cell-classes.ts` | The memoized class table. A cell's classes are a pure function of ten enums, so they are built once per distinct combination instead of via two `twMerge` calls per cell per render (~8,500 of those per keystroke on a busy month). Bakes in the ONE-background precedence and the opaque-pinned-cell rule. |
| `components/shared/table/Row.tsx` | `TableCells` (**the memo boundary**, with the `NO_EDITS` / `NO_INVALID` singletons), `TableRowShell` (the `<tr>` and the four handlers, dispatching by `data-col`) and `TableRow` (their composition). Split 2026-08-17 — see below. |
| `components/shared/table/HeaderCell.tsx` | **New.** Label + `title`, column-selection on the label, a `data-grid-chrome` filter slot, and a resize handle that reports a new width on POINTERUP (a per-frame report re-resolves the column table and re-renders every mounted row). Opaque, never glass. |
| `components/shared/table/BlackwoodTable.tsx` | **New.** The container: `<colgroup>`, sticky header, `TableVirtuoso` (endless) or a plain `<table>` (focus), summary rows on declared lanes, the draft pool's `Add N more rows` control, the context menu, the paste sink. Owns the four performance rules, and the two seams above — `firstItemIndex` (endless only) and `renderChromeRow` + `TableChromeRowApi`. |
| `components/shared/table/PasteSink.tsx` | The hidden `<textarea>`, `isGridChrome` (with the sink exempted FIRST) and `focusGrid` (always `preventScroll`). Carries the full explanation of why a `paste` handler on a non-editable div can never fire. |

### Three defects found in the pieces 1B inherited

1. **`TableRow` owned the `<tr>`, and so does `TableVirtuoso`.** The virtualiser puts
   `data-index` / `data-known-size` / its own `style` on the row element and measures the
   rows by reading them back off `<tbody>`'s children, so a component that renders its own
   `<tr>` cannot receive them — the endless scope would have lost measurement or grown a
   second copy of the cell markup. Split into `TableCells` + `TableRowShell`, with
   `TableRow` keeping the original API. Nothing else changed.
2. **A cell showed its STORED value while carrying an unsaved one.** `format(row, ctx)`
   renders the stored row, so a committed edit left the old figure on screen and the amber
   dirty tint was the only sign anything had been typed. `TableCells` already received
   `rowEdits` (it used them for the dirty flag); it now renders the unsaved text when there
   is one.
3. **`useCellSelection` rebuilds its `range` object every render**, so anything memoized
   against it re-runs whether or not the selection moved — including the aggregation over
   the whole rectangle. The range is rebuilt here from four primitives instead.

### The one structural rule that runs through the React half

Every hook this composes returns a **fresh object each render** while its individual
members are `useCallback`'d and stable. So the module destructures the members and never
depends on the container — `edits.cellText`, not `edits`. Depending on the object gives
every derived callback a new identity per render, `renderEditor` with it, and the row memo
compares unequal for every row on every keystroke: a memo that is a lie, costing a
comparison and saving nothing. It is invisible unless you look for it.

### An edit session is ONE gesture

The open editor owns its own text and publishes it to a ref on each keystroke; the grid
learns it once, at COMMIT. The obvious wiring (`onChange` → `applyEdits`) makes every
character a separate Ctrl+Z — undo after typing `newvalue` takes back the `e` — and
rewrites the whole edit map and re-renders the sheet per character. Escape needs no
special case under this: nothing was ever written, so restoring the pre-edit snapshot is a
no-op that journals nothing.

### Two things the shared nav hook could not express, added here

- **The jumps are resolved BEFORE delegation.** `useGridKeyboardNav` tests
  `NAV_KEYS.includes(e.key)` before it looks at any modifier, so a Ctrl+Arrow reaching it
  is handled as a plain Arrow. Ctrl/Cmd+Arrow, Home/End, Ctrl+Home/End and PageUp/PageDown
  are therefore matched first, and each is consumed even when it owes nothing.
- **Enter OPENS the cell.** The shared hook reads a plain Enter as "move down". Enter
  *while editing* still commits and moves, which is what keeps the Tab-run → Enter lane
  return working.

**Not built (chrome, deferred with Stage 1D):** `PeriodPicker`, `ScopeToggle`, `AxisGuard`,
`ColumnFilterPopover`, `TableSettingsMenu`. `BlackwoodTable` exposes the seams they need —
`onSettingsChange`, `onStateChange`, `onSelectionChange`, `HeaderCell.filterSlot`.

---

## Stage 1C — the playground and the parity suite

| File | Role |
|---|---|
| `app/dev/table-playground/page.tsx` | Dev-only route. `notFound()` in production unless `TABLE_PLAYGROUND` is set. |
| `app/dev/table-playground/playground-grid.tsx` | The fixture: ~120 deterministic records, every 7th carrying 2 child sub-rows, a 2-column `pin: 'start'` block, a `pin: 'end'` actions column, a numeric column, a column hidden by a `ctx` flag, group spacers, a **group heading through `renderChromeRow`**, a draft pool, a **`Load older` pager** that prepends a page and rebases `firstItemIndex`, and a debug strip the suite asserts against. |
| `playwright.config.ts` · `e2e/table/parity.spec.ts` | **33 specs, all passing.** `npm run test:e2e`. |

**The playground lives OUTSIDE the `(app)` route group, deliberately.** That group's layout
calls `supabase.auth.getUser()` and redirects to `/login`, and `middleware.ts` does the same
before the layout is reached — so a playground inside it could only be driven by a suite
holding real credentials, which is the one thing this page exists to avoid. It is gated
twice and the locks are independent: the page 404s, and `middleware.ts` only adds the path
to `PUBLIC_PATHS` under the identical condition. It reads nothing, writes nothing, and
imports no tenant code.

**Two things the suite taught us about testing this grid.** Paste is the one gesture the
grid does not implement on keydown — the browser must dispatch a real `paste` event, and it
only does that for the platform's own accelerator, so the spec presses **Cmd+V on macOS**
(Ctrl+V produces a keydown and no clipboard event at all). And the endless scope is
virtualised, so a spec that scrolls to the far end cannot then click a row at the top:
`Ctrl+Home` first.
