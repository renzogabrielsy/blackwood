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
| `edits.ts` | `mergeFieldEdit`, `isDirtyFieldEdits`, **`forgetRows`**, `countUnsavedWork` / `hasUnsavedWork` / `describeUnsavedWork`, the draft-row constants, and **`createJournal` / `invertStep`**. |
| `nav.ts` | **New.** `edgeJump` (Ctrl/Cmd+Arrow), `rowEdge` (Home/End), `sheetCorner` (Ctrl+Home/End), `pageJump` (PageUp/Down). |
| `grouping.ts` | `needsGroupSpacer`. |
| `selection.ts` | **New.** `rangeRowEdge` / `cellRangeEdges` / `NO_RANGE_EDGES` — which edges of the selection RECTANGLE each cell paints, so a swept block is one box with no inner borders. |
| `menu.ts` | **New.** `defaultTableMenu` — the built-in right-click menu as DATA, a pure function of "does this cell accept an edit" and "was there a row under the pointer". |
| `view.ts` | **New (2026-08-20).** The universal SORT and FILTER, as one pure transform. `applyTableView` · `nextSortDirection` · `isColumnFilterActive` · `activeFilterCount` · `columnSortable` / `columnFilterable` · `NO_FILTERS`. It decides the row order and the row set and holds none of the state that drives it. |
| `grid-param.ts` | **New.** `GRID_PARAM` / `GRID_V1` / `GRID_V2` / `parseGrid` / **`resolveGrid`** / `isGridV2` / `withGrid` / `gridHref` — the `?grid=` side-by-side axis, and the ONE definition of it. One axis with a **per-page default** since 2026-08-21. Temporary: deleted with the last old grid. |
| `paging.ts` | **New.** `shiftFirstItemIndex` + `DEFAULT_FIRST_ITEM_INDEX` — the bidirectional pager's PUBLIC index base, and the arithmetic that keeps a prepend from moving the viewport. |
| `index.ts` | Barrel. Import from `@/lib/table`, never from a file inside it. |
| `../../scripts/verify-table-core.ts` | **78 assertions, must stay green.** Covers what the first consumer structurally cannot produce: end-pinned columns, tiling paste, the journal, the jump keys, the row axis and its **three** predicates, the per-cell nav resolver, the chrome row, the pager's index base, the imperative handle, the per-cell `addressable` seam, the header slot, and slice 2's four (the partial-save projection, the journal-clearing `forget`, the per-cell verdict context, the canonical commit and the edited-value formatter) — plus the purity scan above and its counterpart over the React half. |

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

### `CellSlot.addressable` — "it renders here" is not "the caret may land here"

`occupies()` answered two questions with one value, and the first real migration slice is
what made that visible. A slot RENDERS *and* is a keyboard stop; `null` is neither. So a
column carrying a **row ordinal**, a **database-computed total** or a **derived status
badge** had exactly two settings, and both were wrong: marked occupied it painted its
content and bought a dead stop in every Tab run, and returning `null` skipped the stop and
blanked the cell. The consumer could pick which defect it preferred. On the RC Deliveries
sheet that was three columns — `#`, `TTL PRICE`, `PAID?` — and three dead stops per row
against a ledger whose caret lands on none of them.

`occupies()` may now return `{ field, editable, addressable?: boolean }`. The rules:

- **It DEFAULTS TO TRUE, and that is the whole additivity claim.** `cellAddressable` is
  `slot !== null && slot.addressable !== false` — never `=== true` — so a family that never
  mentions the field answers exactly as `cellExists` does. Asserted at every coordinate of
  the pre-existing fixtures, in bounds and out, and again through a nav resolver built on
  either predicate.
- **It NARROWS `cellExists`, it never widens it.** A lane the row does not have stays
  absent on both counts; there is no way to make the caret visit a cell that is not there.
- **One reader, and it is the caret.** `createTableNavResolver` is the only consumer of the
  predicate itself, and its geometry field is *named* `addressable` rather than `exists` —
  the two have identical signatures, so mis-wiring them is a silent behaviour change no
  type could catch, and the name is what makes it unwritable by accident. The **jump keys**
  and **`apiRef.goToRow`** read it for the same reason (below). Render, tint, selection,
  paste targeting, the aggregation pill and the copy all keep reading `cellExists`,
  unchanged.
- **The MOUSE deliberately does not.** `onCellMouseDown` and the context-menu gate stay on
  `cellExists`, so a click may park the caret on a non-addressable cell while no keyboard
  run ever walks onto one. That asymmetry is load-bearing rather than an oversight: a drag
  has to be able to START on a content-bearing, caret-free cell — a run of computed totals
  is the most useful thing on a sheet to sweep and add up — and gating the mousedown would
  take the whole selection with it. It also matches the ledger this came from, which parks
  the caret on `TTL PRICE` on click and never targets it from the keyboard.
- **It is the per-CELL member of a family of three, and they are different questions.**
  `RowKind.addressable` is per-ROW (a heading is not a coordinate at all),
  `ColumnSpec.selectable` is per-COLUMN (may a rectangle cover it), and this is per-CELL.
  `TTL PRICE` is `selectable: true` **and** `addressable: false` at the same time, which is
  precisely the combination that was inexpressible before.

**Which predicate feeds the jump keys' `exists` probe, and why.** `cellAddressable`. All
four gestures (`edgeJump`, `rowEdge`, `sheetCorner`, `pageJump` → `snapToExisting`) end in
`placeCaret(...)`, so the coordinate they return is a coordinate the caret is put on.
Feeding them the render predicate would let Ctrl+Arrow and Home/End land on a cell the
arrows and the Tab run both refuse — one stop reachable by one key and not another, which
is not a smaller bug than a dead stop but the same bug in two halves. `filled` is untouched:
it is only ever consulted where `exists` is already true, so narrowing one narrows both and
there is nothing left to decide. Same argument, same answer, for `goToRow`: an API that can
put the caret where no key can reach it is the dead stop wearing the other hat.

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

### `forgetRows` / `TableEdits.forget` — a save is PER ROW, so forgetting is too

A batch save returns one verdict per row, so "saved" is rarely all-or-nothing: three
receipts go up and one comes back `version_conflict`. `reset()` throws the refused row's
typing away; forgetting nothing leaves two saved rows lit forever and the next Save
re-posts them. `forget(rowIds)` is the missing third door.

Three properties, all asserted:

- **It is NOT `revertRow`.** That writes the stored value back *through the writer*, so it
  journals — correct for an operator discarding an edit, which is undoable. Landing an edit
  is the opposite: the stored value has just BECOME what was typed.
- **The journal is CLEARED, not filtered.** One gesture can touch a saved row and an unsaved
  one — a paste across three receipts is one step — so no step can survive a save. Same rule
  `reset` obeys, over a narrower map.
- **The pure projection returns the SAME object when it owes nothing**, so a save of a clean
  sheet does not re-render it, and it never mutates the map the caller is still holding
  while the save is in flight.

A consumer with CHILD rows must name them too: they are separate rows in the edit map, and
forgetting a parent alone leaves its children's edits as permanently unsaved work over
values that are now stored.

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

### `CellContext` — a column is not the same thing on every row family

`parse(text, ctx)` judged a lane. But `RowKind.occupies()` may hand back a **different
`field`** for the same column on a child row — and when it does, the two cells mean
different things and cannot share a verdict. On the first real consumer the SUPPLIER lane is
a trader on a receipt (resolved against a closed list of twelve) and a free-text **label** on
a moisture draw, so a column-level `parse` refused `NO MARK/SUNDRY` with a persistent toast
and no way to satisfy it: the operator was locked out of a cell.

`parse` and `normalize` therefore take an optional third argument, `CellContext<Row>` —
`{ field, kind, rowId, row }`. **`field` is the load-bearing member**: it is the SLOT's own
answer, the same key every edit is filed under, and it is what distinguishes the families.
It is built in exactly one place (`cellContextOf`, from `slotAt`), so a verdict can never be
handed a different answer than the writer uses.

This is `occupies()`'s insight one level further in, and the same shape as
`CellSlot.addressable`: two questions being answered with one value. **Additive** — an
implementation written before it existed ignores the parameter and behaves identically.

### `normalize` — the committed text is CANONICALISED, once, inside the writer

Excel's habit, and every operator's expectation: a date cell holds `6/27` while you type and
`2026-06-27` from the moment you leave it, so what is on screen is what will be stored. The
grid had nowhere to express that. Three near-misses, and each fails differently:

- **In the editor's `onBlur`** — a click on another cell `preventDefault`s the mousedown so
  the editor never blurs; the commit happens with the raw text and the editor unmounts.
- **In the editor's `onKeyDown`** — catches Enter and Tab and misses click-away entirely.
- **After the write, from `parse`** — a second write, therefore a second journal step, so
  one Ctrl+Z would leave the cell half-corrected.

So it runs inside `commitEdit`, **before** the single write, where every commit path already
funnels: Enter, Tab, a click on another cell, a blur out of the grid, an arrow that commits
and moves. It **may not refuse** — `parse` runs immediately afterwards on whatever it
returned, which is what keeps an unreadable value both KEPT VERBATIM and REFUSED BY NAME.

Without it a sheet holds two spellings of one value: `cleanPasted` already produces the
canonical form for the same text arriving on the clipboard, so a typed `6/27` and a pasted
`6/27` would be stored differently — and a shorthand equal to the stored value could never
stop counting as dirty, because `mergeFieldEdit` compares text.

### `formatEdited` — an unsaved value that is a DERIVATION, not a string

A dirty cell cannot render through `format`, which reads the STORED row (that was the defect
fixed in `Row.tsx`); the fix renders the raw text. Raw text is right for most columns and
wrong for any lane whose stored form is derived from what is typed: `=27045*88%` sitting in
a right-aligned figure column loses the lane's alignment, and a blank row being typed reads
nothing like the receipt above it.

It receives the text and the ctx and **deliberately no cell context** — it runs on the row
render path, and an object per dirty cell per render would buy an answer no derivation needs
(a lane's derivation does not change with the row family). Omit it and the raw text renders,
byte-identical with before.

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

### `renderHeaderSlot` — the wire to a seam that already existed

`HeaderCell` has carried a `filterSlot` since it was written, and `BlackwoodTable` builds
`headerRow` internally and passed it nothing — so a consumer holding twelve column-filter
popovers had somewhere to put them in the markup and no way to reach it. A seam nobody can
address is not a seam. One prop closes it:

```ts
renderHeaderSlot?(spec: ColumnSpec<Row, Ctx>, index: number): React.ReactNode
```

- **The platform still renders no filter UI and holds no filter state.** It has no opinion
  about the grammar either — that stays in the consumer's URL module. This is the hook, and
  deliberately nothing else.
- `spec` is the **RESOLVED** column (saved width applied, hidden columns already gone) and
  `index` is its **DISPLAY** position — the same index a column-selection click addresses,
  so a consumer can key popover state off either without deriving a second column axis.
- The node is wrapped in `data-grid-chrome`, so a keystroke or a paste aimed at the control
  is that control's business and never a grid gesture.
- **Omitting it is byte-identical with the behaviour before it existed**: `filterSlot`
  resolves to `undefined` and `HeaderCell` renders no slot element at all — not an empty
  wrapper, which would still occupy the gap beside every label.
- Must be referentially stable (`useCallback`), for the same reason as `renderChromeRow`:
  it is a dependency of every header cell, so a fresh identity per render rebuilds the whole
  header row — and a consumer's popover state would be frozen at the identity it had on
  first render.

### `apiRef` — the seam for ACTING on the grid, not merely reacting to it

`onStateChange` and `onSelectionChange` let a surface outside the grid **react**; nothing
let one **act**. Two behaviours a real consumer cannot express without that, and both live
entirely inside `BlackwoodTable`:

- **"Go to row N"** — a duplicate-peer popover, a search hit, a link from a summary. It is
  three things at once (move the caret · scroll the row into view · take focus), and every
  one of them is internal.
- **Giving the caret back when a dialog closes.** Radix restores focus to the TRIGGER, and
  a context-menu item has already unmounted by then — so focus lands on `<body>` and the
  next keystroke goes nowhere. The fix is
  `onCloseAutoFocus={e => { e.preventDefault(); api.current?.focus(); }}`, which needs the
  grid's own paste sink, and no consumer holds a ref to it.

`BlackwoodTableApi` is `focus` · `goToRow(rowId, colKey?)` · `scrollToRow(rowId)` ·
`setActiveCell`. Three rules, each asserted:

- **Addressed by ROW ID, never by a nav-row index.** The consumer builds `items` but does
  NOT own `navRows` — that axis is resolved inside `useTableRows`, and a consumer deriving
  an index from `items` would be a second definition of it. `placeById` already answers it.
  (Same class of bug as the `firstItemIndex` rebase: the wrong index space, silently.)
- **`goToRow` can never park the caret on a cell the row does not occupy.** The lane is the
  one asked for, else the one the caret is already in, else the first this row occupies —
  every candidate tested through **`rows.cellAddressable`**, because a child row is narrower
  than its parent *and* because a lane that renders content without being a coordinate is
  refused for the same reason the keyboard refuses it. No lane ⇒ it refuses rather than
  moving the caret nowhere.
- **A row outside the loaded window returns `false`,** so a caller can say so instead of
  appearing to do nothing.

Purely additive: a consumer that omits `apiRef` behaves exactly as it did before it existed.

### The jump keys read two probes, never the DOM

`edgeJump` implements Sheets' actual rule (run to the end of a block · skip a gap from a
block edge · from a blank, land on the next filled cell · else the far edge) over injected
`exists(row,col)` and `filled(row,col)`. `exists` is what lets a vertical run **step over**
coordinates a child row does not have. Every jump returns `null` when the caret is already
there, so a key that owes nothing is a no-op rather than a re-render. `pageJump` accumulates
**real row heights** — rows are not uniform, so a page cannot be a row count.

---

## The side-by-side toggle (`?grid=`) — how a screen gets one

Every screen migrated onto this module builds its new grid **beside** the existing one and
picks between them on a query param, so the rewire can land half-finished and be compared
row-for-row on the same real data (the strangler-fig method —
`handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`). This section
is the recipe for making that switch a **button** instead of an edit to the address bar.

**Two pieces, both platform-layer, both temporary:**

| Piece | Path | What it is |
|---|---|---|
| The param | `lib/table/grid-param.ts` (barrelled from `@/lib/table`) | Pure. `GRID_PARAM` (`'grid'`), `GRID_V2` (`'v2'`), `GRID_V1` (`'v1'`), `parseGrid`, `resolveGrid`, `isGridV2`, `withGrid`, `gridHref`. |
| The control | `components/shared/table/GridVersionToggle.tsx` (barrelled from `@/components/shared/table`) | `GridVersionToggle` (the segmented control) and `GridVersionBar` (a `shrink-0` strip that carries it). Both take `defaultVersion` / `currentLabel` / `newLabel`. |

### The recipe — three edits to one file, and neither table is touched

The server `page.tsx` is the ONLY file that changes. Both table components are left alone
— which is the point: the current table is production and the migration may not edit it.

**1. Import the bar and the param helpers.**

```tsx
import { GridVersionBar } from '@/components/shared/table';
import { GRID_V2, parseGrid } from '@/lib/table';
```

**2. Read the param and build the bar** (the page already reads `searchParams`):

```tsx
const v2 = parseGrid(params.grid) === GRID_V2;
const gridBar = <GridVersionBar note="Same rows, same filters — this switches only which table renders them." />;
```

**3. Render the bar ABOVE whichever grid the flag selected**, at every `return` in the file:

```tsx
return (
    <>
        {gridBar}
        {v2 ? <ThingGridV2 {...props} /> : <ThingTable {...props} />}
    </>
);
```

That is the whole change. A page with an early `return` per scope gets the fragment at each
one — hence `gridBar` as a variable rather than the element inline.

### The five rules this obeys, and why each one is not optional

1. **EVERY OTHER PARAM SURVIVES THE FLIP.** A screen's URL carries its scope, month,
   search, lens and per-column filters; a toggle that dropped one would put two different
   sets of rows on the two sides and make the comparison worthless. `withGrid` copies the
   query exhaustively, `append`s (so a legitimately repeated param stays a repeat) and
   touches only its own key. **Never build the query string by hand in a caller** — that is
   how a filter goes missing. Verified live in both directions on a URL carrying
   `scope`, `year`, `month`, `issue`, `q` and two `f_<column>` filters.
2. **ONE definition of the param, in the platform layer.** The first migrated screen
   defined `GRID_V2` / `parseGrid` in its own tenant module; `app/(app)/cenapro/deliveries/ledger-url.ts`
   now **re-exports them from `@/lib/table`** rather than keeping a second copy. A screen
   that needs them locally re-exports the same way. Three copies of a string literal is
   three chances to disagree about which URL means what.
3. **The bar carries its own layout.** `GridVersionBar` is `shrink-0` with the strip's
   padding and border baked in, because a page that forgets `shrink-0` squeezes the sheet
   below it instead of the strip — the exact failure "never crush, always scroll" exists to
   prevent. Mount the bar; do not re-type its classes.
4. **The Suspense boundary ships with the control.** `useSearchParams()` opts its subtree
   out of static prerendering and fails the production build on any page that has not
   opted out itself. `GridVersionToggle` wraps its own internals, so the recipe works on a
   `force-dynamic` page and a static one alike and no caller has to remember.
5. **An unrecognised value always means the page's DEFAULT.** `?grid=V2`, `?grid=3`,
   `?grid=` and absence are all the same answer, so there is no way to type a URL that
   half-selects a version. The param is an axis of the CLIENT, never of the data: both
   components read the identical server payload, and nothing here reaches a query, an
   action or a role gate.

### When a screen FLIPS its default (2026-08-21) — RC IN / RC OUT

The migration's second phase does not delete the old table; it stops landing on it. Renzo,
having driven the two ICTC ledgers for days: *"I'm satisfied with ICTC Deliveries and Usage
table so we can start to make grid v2 as our current table now for those 2."*

**One axis, a per-page default — NOT a second param.** An operator comparing two screens in
two tabs still has one spelling to remember. What changes is which side is the paramless
URL.

| `?grid=` | on a v1-default page (nine screens) | on a v2-default page (`/inventory`) |
|---|---|---|
| absent | **v1** — the classic table | **v2** — the Blackwood Table |
| `v2` | v2 | v2 (the default, spelt out) |
| `v1` | v1 (the default, spelt out) | **v1** — the classic table |
| `V2` · `3` · `` · junk | v1 (the default) | v2 (the default) |

**Three edits, and the shape of each is the point:**

```tsx
// the page states its default ONCE, where it reads the param
const v2 = resolveGrid(params.grid, GRID_V2) === GRID_V2;

// and the control is told the same thing, so it lights the side the page rendered
<GridVersionBar defaultVersion={GRID_V2} currentLabel="Classic" newLabel="Table (new)" note="…" />
```

- **`resolveGrid(value, default)` is the ONE place the two halves of the question are
  combined.** `parseGrid` now reports only what the URL *said* (`'v1' | 'v2' | null`) —
  `null` stopped meaning "the current grid" the moment two pages disagreed about which grid
  that is. A page that does not flip keeps `parseGrid(...) === GRID_V2` and is unchanged.
- **The default reaches `withGrid` / `gridHref` too, or the URL stops being canonical.** The
  param is written only when it says something the page does not already say, so the default
  side of the toggle is always the CLEAN url. Without it every plain link into `/inventory`
  would read as the non-default state. `defaultVersion` is the third argument and defaults
  to `GRID_V1`, so every existing caller is byte-identical.
- **The labels are PROPS, not a branch on the version.** "Current" is a claim about one
  page's state, not a fact about the module: on a flipped screen the current table IS the
  new one, so `/inventory` reads **`Classic` · `Table (new)`**. The control never learns what
  any screen is. The **segment order and the amber accent do not move** — an operator with
  two tabs open should not find the buttons swapped, and a screenshot must still say which
  grid produced it without anyone reading the URL.
- **Flipping the default is not cutting over.** The old table stays mounted, reachable and
  fully functional; on `/inventory` it is where Add/Edit lives until the v2 editing pass
  lands, and the bar's note says so. Deletion is a separate, later decision.

Six assertions in `scripts/verify-table-core.ts` pin all of it — including an explicit
v1-default case over every input, a round-trip that proves a flip preserves every other
param under both defaults, and a scan of every `page.tsx` mounting the bar asserting that
only the flipped screens pass a default.

### Where the control goes when the new grid has its own toolbar

Prefer the page-level bar — one mount, both sides, neither component edited. Drop the bare
`<GridVersionToggle />` into a toolbar only when that toolbar is in a file this migration
owns (a `*-v2.tsx`), and then do **not** also render the bar for that branch, or the screen
grows two toggles. The control already carries `data-grid-chrome`, so it is safe inside a
Blackwood Table toolbar: Enter/Space activate the button instead of opening the caret cell.

### At cutover

The param, `grid-param.ts`, `GridVersionToggle.tsx` and the page's three edits are deleted
together with the last old grid. A permanent escape hatch is a second grid nobody maintains.

---

## Status

**Stage 1A of Phase 1 is complete** (2026-08-17). The pure core exists and the Cenapro RC
Deliveries module is its first consumer: `app/(app)/cenapro/deliveries/types.ts` re-exports
these helpers under its own names, so the grid, the server page and that module's
**120 assertions run through this code unchanged** — which is what proves the extraction
was behaviour-preserving.

**Stages 1B and 1C are complete** (2026-08-17). The React half is built, the dev playground
mounts it on an in-memory data source, and **47 Playwright specs drive the real component**
with no login and no database. See the two sections at the end of this file.

**Nine additive seams were added afterwards** (2026-08-17), each found the same way — by a
migration that correctly refused to proceed without it. **This is the only way seams in
this module get found**: every one of them was invisible until a consumer needed it, and
not one was predicted by the plan.

| Seam | What the consumer could not say without it |
|---|---|
| `firstItemIndex` | A bidirectional keyset pager needs the virtualiser's PUBLIC index base. |
| `renderChromeRow` | A group heading or per-group rule-off inside the BODY; `summaryRows` reaches the footer only. |
| `apiRef` / `BlackwoodTableApi` | The imperative half — "go to row N", and handing the caret back after a dialog closes. |
| `CellSlot.addressable` | *"This cell renders content and the caret must never stop on it."* Found by the first real migration slice, which had three such columns and no way to say so. |
| `renderHeaderSlot` | *"Hang this popover off that column's header."* `HeaderCell.filterSlot` existed from the start with no wire to it. |
| `forgetRows` / `TableEdits.forget` | *"These rows LANDED; that one was refused for a stale version."* A batch save's outcome is per row, and `reset` is all-or-nothing. |
| `CellContext` on `parse` / `normalize` | *"This lane is a trader on a receipt and a free-text label on its child."* A column-level verdict blind to the slot's field locks the operator out of the child cell. |
| `ColumnSpec.normalize` | *"`6/27` IS `2026-06-27` from the moment you leave the cell."* Every other place it could run misses at least one commit path or costs a second journal step. |
| `ColumnSpec.formatEdited` | *"This unsaved value is an EXPRESSION; show me the figure."* A dirty cell renders raw text, which breaks a numeric lane's alignment. |
| `ColumnSpec.rowCopy` *(2026-08-20)* | *"This column is a status rail, not part of the record."* `Copy row` had no way to be told what the row IS. |
| `ColumnSpec.onHeaderClick` *(2026-08-20)* | *"Clicking this header opens the block, it does not sweep 400 cells."* The label's click was hard-wired to column-selection. |
| `ColumnSpec.subLabel` *(2026-08-20)* | *"`C-8B`, and under it `JAN-26-BLK22`."* `labelNode` could draw it; nothing declared it, so every consumer would draw it differently. |
| `BlackwoodTableProps.sizing` *(2026-08-20)* | *"Use the whole monitor without moving my frozen columns."* The stretch bug, closed at the platform layer instead of by N consumer clamps. |

Purely additive — a consumer that passes none of them, and a `RowKind` whose `occupies()`
never mentions `addressable`, behaves exactly as before.

**Stage 1D — migrating the Cenapro RC Deliveries ledger onto the module — is UNDER WAY.**
It lives at `app/(app)/cenapro/deliveries/deliveries-grid-v2.tsx`, reachable only at
`?grid=v2` and built BESIDE the live ledger, which is not edited by one character.
**Slice 1** (read-only: column specs, row families, the flatten, both scopes) found
`CellSlot.addressable` and `renderHeaderSlot`. **Slice 2** (editing, undo/redo, paste, the
blank-row pool and the save) found the last four in the table above. Slice 3 is the toolbar,
the filters, the row menu and the dialogs. See
`app/(app)/cenapro/deliveries/CONTEXT.md` → "The `?grid=v2` rewire".

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
| `lib/hooks/use-table-columns.ts` | `resolveColumns` (pure) + `useTableColumns`. Visibility → order → widths → **fill**, then every measurement taken off the result, so the sticky offsets, the caret-follow, the drag wall and a footer corner cannot disagree about where a pinned block ends. **A saved order is re-grouped by pin**, which makes "reorder within a pin group only" structural rather than a rule to remember. `distributeFill` is `sizing: 'fill'`'s half — it runs LAST, over the widths the operator's own layout produced, so a resize wins over the distribution for that column. |
| `lib/hooks/use-table-rows.ts` | **New.** `resolveRows` (pure) + `useTableRows`, plus `columnAcceptsEdit`, `columnSelectable` and `createTableNavResolver`. The ROW axis: which rows the caret may land on, how tall every rendered row is, and the three predicates the whole module runs on — `cellExists` (render) / `cellAddressable` (the caret) / `cellEditable`. |
| `lib/hooks/use-table-edits.ts` | **THE single journalled writer.** Every mutation — commit, clear, paste, fill, clear-row, revert, and undo/redo themselves — goes through `applyEdits`. One `setState` per GESTURE, not per cell. Undo re-enters the same writer with `record: false`, so there is no separate inverse implementation to drift. Three doors OUT, and they mean different things: `revertRow` (journalled — discarding an edit is undoable), **`forget(rowIds)`** (the rows a save LANDED, journal cleared) and `reset` (everything). |
| `lib/hooks/use-table-interaction.ts` | **New.** Every gesture, composed once over `useGridKeyboardNav` × `useGridEditSession` × `useCellSelection` × `useCellAggregation` and the pure helpers. Keyboard, jumps, undo/redo, clipboard in and out, caret-follow, drag auto-scroll, the paste sink and its document fallback. Also the two verdict seams: `commitEdit` applies `ColumnSpec.normalize` before the single write, and `cellContextOf` hands both `normalize` and `parse` the SLOT's own field. |
| `components/shared/table/cell-classes.ts` | The memoized class table. A cell's classes are a pure function of fourteen enums (ten, plus the selection box's four edges), so they are built once per distinct combination instead of via two `twMerge` calls per cell per render (~8,500 of those per keystroke on a busy month). Bakes in the ONE-background precedence and the opaque-pinned-cell rule. |
| `components/shared/table/Row.tsx` | `TableCells` (**the memo boundary**, with the `NO_EDITS` / `NO_INVALID` singletons), `TableRowShell` (the `<tr>` and the four handlers, dispatching by `data-col`) and `TableRow` (their composition). Split 2026-08-17 — see below. |
| `components/shared/table/HeaderCell.tsx` | **New.** Label + `title` + `subLabel`, column-selection on the label (or `ColumnSpec.onHeaderClick` instead of it), the built-in sort caret and filter trigger, a `data-grid-chrome` consumer filter slot, and a resize handle that reports a new width on POINTERUP (a per-frame report re-resolves the column table and re-renders every mounted row). Opaque, never glass. |
| `components/shared/table/HeaderFilterPopover.tsx` | **New (2026-08-20).** The built-in per-column filter panel: a `contains` box, plus MIN/MAX on a column with a `numericValue`. NOT Radix and `position: fixed` — the header lives inside the horizontally scrolling scrollport, so an absolutely-positioned panel is clipped on every column past the fold. |
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
`onSettingsChange`, `onStateChange`, `onSelectionChange`, `apiRef`, and (since 2026-08-17)
`renderHeaderSlot`, which is the wire to `HeaderCell.filterSlot` that was missing.

---

## Stage 1C — the playground and the parity suite

| File | Role |
|---|---|
| `app/dev/table-playground/page.tsx` | Dev-only route. `notFound()` in production unless `TABLE_PLAYGROUND` is set. |
| `app/dev/table-playground/playground-grid.tsx` | The fixture: ~120 deterministic records, every 7th carrying 2 child sub-rows, a 2-column `pin: 'start'` block, a `pin: 'end'` actions column, a numeric column, a column hidden by a `ctx` flag, group spacers, a **group heading through `renderChromeRow`**, a draft pool, a **`Load older` pager** that prepends a page and rebases `firstItemIndex`, and a debug strip the suite asserts against. Since 2026-08-20 it also carries two `rowCopy: false` columns, a `subLabel`, an `onHeaderClick` column, and toggles for `enableSort`/`enableFilter` and `sizing`. |
| `playwright.config.ts` · `e2e/table/parity.spec.ts` | **57 specs, all passing.** `npm run test:e2e`. Specs 34–47 are the platform pass — the selection box, the pill, the built-in menu, unmanaged resize, the wrapped header and the tinted cell. Specs 48–57 are the 2026-08-20 pass below: the anchor's ring, `rowCopy`, the sort and filter, `onHeaderClick` / `subLabel`, and `sizing: 'fill'`. |

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

---

## Stage 1D at scale — eight consumers in one night (2026-08-19)

Renzo asked for a v2 of **every** editable grid in the app, each built beside the one in
production and reachable on `?grid=v2`, so he could compare before authorising a migration.
**Blocking was excluded on his instruction and is byte-identical.** Screens covered: ICTC
RC IN · RC OUT · Production Daily / Electricity / Trucks · Flecon Bags · RC Movement ·
Cenapro Production (both scopes), on top of Cenapro Deliveries from the day before.

**Every one is READ-ONLY, and structurally so.** No `ColumnSpec` in any of them declares a
`parse`, and `columnAcceptsEdit` falls back to `spec.parse !== undefined` — so the editor,
Delete/Backspace and the paste loop's per-cell guard all refuse at every coordinate. That
one absence removes the whole write surface at once, which is what made an unattended
overnight build safe. The row families still declare each slot's **honest** `editable` flag:
that is the row's half of the verdict, the two halves are ANDed, and it is what a later
editing pass builds on. Setting `editable: () => true` on a *spec* would have opened real
edit sessions — do not.

### The measured layout bug — a stretched table moves its own frozen columns

`BlackwoodTable` renders `width: 100%` **plus** `minWidth: Σ widths` **plus** an explicit
`<col width>` per column. Under `table-layout: fixed`, a table wider than its columns scales
**all** of them proportionally: measured in headless Chrome at a 1600px container, a declared
**76px column rendered 94.703px** and a declared **200px one rendered 249.219px** (both exact
at 800px). The sticky `left` offsets come from the **declared** widths, so on a wide monitor
the frozen block **overlaps itself** — Flecon's columns sum to only 1284px, so this was
reachable on any normal screen.

Mitigated consumer-side for now: each grid clamps its wrapper `maxWidth` to
`useTableColumns(...).minWidth` — the module's own resolved sum, so it tracks a column resize
and a role-hidden column instead of drifting from a hand-written formula. **The cost is
visible**: a screen that deliberately let `table-fixed` hand slack to its columns (Flecon)
now sizes to content and leaves the page empty to its right.

**This wants a platform decision, not N consumer clamps.** Either `BlackwoodTable` takes a
`sizing: 'fill' | 'content'` prop (`width: 'max-content'` for the latter), or
`useTableColumns` gains a fill mode that distributes slack into named columns **so the
offsets stay derived from the widths actually rendered**. The invariant to restore is that
one number describes both the layout and the sticky arithmetic.

### Six seams the eight consumers proved were missing

Each is additive — omit it and behaviour is byte-identical — and each was invisible until a
real screen could not be expressed. That remains this module's dominant development mechanic.

> **~~1~~, ~~2~~ and ~~6~~ are BUILT** (2026-08-19, the platform pass below). 1 and 6 are
> both closed by **`ColumnSpec.cellClass`**; 2 by **`onSelectionChange`'s second argument**
> *and* by the table publishing the pill itself. **3 is half-built** — `labelNode` +
> `headerWrap` cover the two-line label; the spanning BAND row is still missing.
> **4 and 5 remain open** as written.

1. ~~**A row tint cannot reach a pinned cell.**~~ **BUILT — `ColumnSpec.cellClass`.** `rowClassFor` lands on the `<tr>`, and every
   pinned `<td>` is opaque by design (a frozen cell sits over scrolling content; any alpha
   bleeds through). So a row-status wash paints on the scrolling columns and is covered on
   exactly the frozen ones — a half-painted row that reads as a bug. Two routes were proven:
   **drop the pin** (RC OUT, whose live table has none either), or **paint inside the pinned
   cell's `format`** with `absolute inset-0 -z-10` (Cenapro Production). The `-z-10` is
   load-bearing and was verified in a browser across four cases: without it the wash covers
   the selection tint **and** the active-cell ring, so a selected pinned cell stops looking
   selected. Proper seam: `rowTint?(item): string` layered by `cell-classes.ts` into the
   pinned cell's background as well as the row's — the module's own Frozen Panes rule already
   says row state "must be applied to the frozen cells too", and there is no wire for it.
2. ~~**The selection aggregates never leave the table.**~~ **BUILT — and it went further than
   the seam proposed: the table publishes them to the status bar ITSELF, so a consumer
   wires nothing.** `useTableInteraction` computes
   `sum`/`average`/`count`/`min`/`max`/`recommendedCalcType`; `BlackwoodTable` forwards only
   the `CellRange` through `onSelectionChange`, and `TableState` carries no aggregates. A
   consumer **cannot** recompute them: the range is in **nav-row** coordinates and `navRows`
   is resolved inside `useTableRows`, so deriving it from `items` would be a second
   definition of that axis — the same class of bug as rebasing `firstItemIndex`. Every v2
   therefore shows a cell **count** where the live grids show a total; none fakes a number.
   Seam: add `aggregates: CellAggregates | null` to `TableState`, or a second optional
   argument to `onSelectionChange`.
3. **A two-level column header is inexpressible** — *half built:* `ColumnSpec.labelNode`
   and `ColumnSpec.headerWrap` now cover the two-line label, so `JAN-26-BLK22` no longer
   truncates. The spanning BAND row is still missing. `headerRow` is one `<tr>` of `HeaderCell`s
   and `ColumnSpec.label` is typed `string`; `renderHeaderSlot` hangs a node *beside* a label
   inside one cell and cannot span. Trucks lost its plate band over four sub-columns (the
   plate now rides in each label, `AAV START`, with the full name on the tooltip) and is the
   most visible difference of the night. Seam: `ColumnSpec.group?: string` plus an optional
   band row tiled `summarySpans`-style over consecutive equal groups. `label: React.ReactNode`
   separately covers a two-line label.
4. **A summary row cannot carry a figure per COLUMN.** `TableSummaryRow` tiles six declared
   lanes (`label · frozen · spacer · figure · note · total · trailing`), so a footer with a
   different number under every column is impossible. Flecon's Forwarded / Current Balance
   and RC Movement's whole footer are therefore `renderChromeRow` **as the last body row**,
   which loses the bottom pin (mitigated with `initialTopMostItemIndex`). Seam:
   `TableSummaryRow.cells?(api: TableChromeRowApi)` — the escape hatch `renderChromeRow`
   already is, in the footer slot.
5. **A sticky summary row cannot put its `figure` lane inside the pinned block.** The sticky
   form is `frozen + spacer + weight + note + total + trailing`; with `figIdx < pinnedCount`
   the spacer clamps at 0 and the row **over-tiles** the column table — a `figure` on column
   6 of an 8-column pinned block emitted 25 cells for a 23-column table. Worked around by
   moving the lane. A one-line guard (`hasWeight && figIdx >= frozen`, degrading to no figure
   lane) would make it unwritable by accident.
6. ~~**A consumer cannot paint a cell or header border.**~~ **BUILT for the CELL —
   `ColumnSpec.cellClass`. The HEADER border is still unreachable** (`ColumnSpec.groupStart`
   would be the seam). `cell-classes.ts` owns every
   `<td>`/`<th>` className, so "give this column a left rule in all three sections" has no
   expression. Worked around inside the paint (the cell's own `absolute inset-0` inner span;
   an `inset-y-0 left-0 w-0.5` sliver through `renderHeaderSlot`). Wants
   `ColumnSpec.groupStart?: boolean`.

### The pivot views, and why they were NOT attempted

Cenapro's `?view=daily-w6|daily-w7` (`production-daily-block.tsx`,
`production-endless-pivots.tsx`) got no v2, deliberately. Three of the four things a pivot
needs already exist — `renderChromeRow` for arbitrary cells, `occupies()` for differing lanes
per family, `pin` for the frozen block. The missing one is **vertical cell merging**:
`TableCells` emits exactly one `<td>` per column per row with no `rowSpan`, and a day-block
pivot's whole grammar is one DATE cell spanning its five grade rows.

**`rowSpan` is not the seam to add.** It breaks the invariant the module rests on — that a
row's cells are a function of that row alone. `TableVirtuoso` measures rows off `<tbody>`'s
children and recycles them independently, so a cell owned by row *n* but painted across
*n…n+4* cannot be measured, cannot recycle, and is destroyed when row *n* leaves the window.
The additive seam worth proposing instead is a per-family **`renderRowCells`** escape hatch
plus expressing the merge as **first-cell-only + borderless continuation rows** — visually
identical, still one `<td>` per row, and `occupies()` already lets the continuation rows
return `null` for the merged lane so the caret behaviour falls out.

### Two consumer-side notes for the cutover

- **`firstItemIndex` is corrected at the call site in two grids independently.** The pager
  hooks (`use-deliveries-window.ts`, `use-ledger-window.ts`) decrement their base by
  **records**, which is short whenever the flat array carries chrome — measured, 4 records
  prepended add **6** items. Not a module gap; the correction belongs in the pager hook once
  one grid remains.
- **`daily-grid-v2.tsx` imports `buildGridRows` from `daily-ledger-grid.tsx`** — a value
  import, not a copy, which is what guarantees both sides assign the same PRIMARY row. That
  import must move somewhere neutral before the live ledger is deleted.

### The side-by-side toggle is now the pattern for all of them

One recipe, applied nine times: read `parseGrid(params.grid)` in the server `page.tsx`, mount
`<GridVersionBar>`, and pick the component. Never build the query string by hand —
`withGrid` is what preserves scope, period, lens, search, `?campaign=`, `?m=` and every
`f_<column>` filter, and losing a filter on a flip makes comparison useless. Two structural
exceptions were needed and are worth knowing: the **Production tabs are one page** switching
via localStorage, so the flag is read once and threaded down as a prop (a `useSearchParams`
per view would opt three subtrees out of static prerendering); and **RC Movement's page owns
no data**, so its v2 branch awaits the same existing read action rather than adding a prop to
the client host.

---

## The platform pass (2026-08-19) — "a mini product we're shipping for us to use internally"

Renzo, having driven the ten v2 grids: *"every part of the app that uses the table should
also universally use the following features as well: the right click menu and the hover
summary (the one on the bottom right where it shows the summation/average/count of the
highlighted cells)"* · *"Width adjustment also doesn't exist on every table used."*

**The finding behind all three is one finding, and it is worth stating plainly: a
capability reachable only through a prop most consumers do not pass is, from the
operator's chair, indistinguishable from a capability that does not exist.** The menu, the
pill and the resize handle were all *in* the module. Nine of ten screens had none of them.
So this pass moved four things from *prop-gated* to **default-ON**, and added three genuine
seams. Everything below is additive in the sense that matters — a consumer that passes none
of the new props compiles and behaves identically — but the four default-on behaviours are
deliberately visible on every grid at once, because that was the request.

### The register

| What | What the consumer needed | Why the old API could not say it | The rule that keeps it additive |
|---|---|---|---|
| **A cell CLIPS** (`cell-classes.ts`) | *"A value wider than its column must stay inside its column."* | The interactive layer was `absolute inset-0 flex` with **no `overflow`**, so a long value painted straight over the neighbouring cell and a two-word one wrapped inside a row whose height its family had declared. Measured on the QC sheet: a `yyyy-MM-dd` in a 62px column, and `WHSE 3` on two lines. | No prop at all — it is a correctness fix, not a capability. `overflow-hidden whitespace-nowrap` on the layer, plus `[&>*]:text-ellipsis` so the element children a `format` returns get a true ellipsis. A `format` returning a **bare string** still clips but shows no ellipsis (a flex container is not a block container, so `text-overflow` on it does nothing for anonymous items) — wrap it in a `<span>`, which nearly every truncating column already does. |
| **Header wrap / rich label** (`ColumnSpec.headerWrap`, `ColumnSpec.labelNode`) | *"`JAN-26-BLK22` must not read as `JAN-26-B…`."* | `label` is typed `string` and `HeaderCell` truncated it unconditionally. | Both optional; absent ⇒ one line, truncated, byte-identical. **`label` stays a required plain string** — the header's `title`, the resize handle's `aria-label` and `Copy with headers` all read it as TEXT and none of them can render a node, so `labelNode` adds a rendering and never replaces the name. Wrapping is bounded at two lines (`line-clamp-2`), because the whole header row grows to its tallest cell. |
| **The selection is ONE box** (`lib/table/selection.ts`) | *"Grow it into one big box surrounding the selected cells WITHOUT inner borders."* | `cell-classes.ts` had exactly two selection states — `active` (a ring on one cell) and `selected` (a tint) — so a swept block was a wash with a ring in the corner it started from. | No prop. `rangeRowEdge` + `cellRangeEdges` are pure and decide, **per cell**, which of the four sides it paints; interior cells return the shared `NO_RANGE_EDGES` and paint nothing. **A 1×1 selection paints no box at all** — a plain click seeds one, so that case has to stay byte-identical with the ring. The four flags are in the class cache key. |
| **The summary pill is universal** (`BlackwoodTable` → `useOptionalStatusBar`) | *"The hover summary, on every table."* | `useTableInteraction` computed `sum`/`average`/`count`/`min`/`max` on every gesture and **discarded them**; `onSelectionChange` handed out the rectangle alone, and a consumer **cannot** re-total it — the range is in NAV-ROW coordinates resolved inside `useTableRows`, so deriving it from `items` would be a second definition of the row axis (the `firstItemIndex` bug in another costume). | The table publishes to the app's status bar **itself**, so zero wiring. The provider is read through **`useOptionalStatusBar`**, which returns null instead of throwing — the grid mounts outside the app shell (the playground does) and a shared primitive that crashes a page over a missing ambient provider is not shared. `onSelectionChange` also gained an optional second argument `{ size, aggregates }` for a consumer that wants the numbers somewhere else. |
| **A built-in right-click menu** (`lib/table/menu.ts`) | *"The right click menu, on every table."* | `contextMenuItems` was the ONLY menu there was, and `onContextMenu` returned early without it — so nine of ten grids had the browser's menu. | The item LIST is `defaultTableMenu`, a **pure function of `editable` and `hasRow`**, and every action maps onto the interaction hook's own callback (menu "Copy" *is* Ctrl/Cmd+C). The three mutating items are **ABSENT, not disabled**, wherever the cell does not accept an edit — which is every cell of every read-only grid, so switching the menu on everywhere cannot offer an action that would silently do nothing. `contextMenuItems` now renders **above** the built-ins with a separator; `disableDefaultContextMenu` is the opt-out. |
| **Resize without persistence** (`BlackwoodTable` local widths) | *"Every table can be widened."* | The handle rendered only when `onSettingsChange` was supplied (`HeaderCell.resizable` is `spec.resizable !== false && onResize !== undefined`). | Delegate when there is somewhere to delegate to; keep the width in component state otherwise. The local map is **`undefined` until something is dragged**, so an unmanaged grid resolves its columns from exactly the object identity it did before — which is what `useTableColumns` memoizes on. `resizable: false` on the spec is still the opt-out. The handle is now **visible on header hover**, which is the half that made it feel absent. |
| **`ColumnSpec.cellClass`** | *"Tint the ENTIRE cell"* (RC IN's out-of-band GRIT read as a small red pill inside the cell), and *"a row wash that reaches a PINNED cell"*. | `cell-classes.ts` owns every `<td>`/`<div>` className, so the only place a consumer could paint was inside `format` — a badge, or an `absolute inset-0 -z-10` layer with the `-z-10` load-bearing. And a class on the `<tr>` is covered on exactly the pinned columns, because a frozen cell is opaque by design. | Merged **UNDER** the cached string (`cn(extra, cls.inner)`), so `invalid` / `selected` / `dirty` and the active ring all win — a consumer cannot hide the states the operator navigates by, however loud its tint. Never asked for a cell the row does not occupy. **Cost:** one `twMerge` per cell that returns a string; a column that returns `undefined` — nearly every cell of nearly every column — pays nothing, because the cached string is used directly. |

### The three things a consumer writes — verbatim, for the migration pass

**(i) Extra right-click items.** Unchanged prop, new meaning: these render ABOVE the
built-in Copy / Copy row / Select column block, with a separator drawn between them.

```tsx
<BlackwoodTable
    contextMenuItems={(target) => (
        <button
            type="button"
            className="flex w-full items-center px-2.5 py-1.5 text-xs hover:bg-accent"
            onClick={() => { openEditDialog(target.row); target.close(); }}
        >
            Edit this receipt
        </button>
    )}
/>
```

`target` is `TableContextTarget<Row>` — `{ cell, rowId, row, kind, close }`. Return `null`
(or omit the prop entirely) and the built-in menu is all that shows. Pass
`disableDefaultContextMenu` to suppress the built-ins.

**(ii) Tint a whole cell.** A field on the COLUMN, not a prop on the table:

```ts
{
    key: 'grit', label: 'GRIT', width: 72, align: 'right',
    format: (row) => fmt2(row.lab_results?.grit),
    cellClass: (row, ctx) =>
        row && isOutOfBand(row.lab_results?.grit) ? 'bg-destructive/15 text-destructive' : undefined,
}
```

Return `undefined` for the ordinary case — that is the branch that costs nothing. `row` is
`Row | null` (null on a blank draft row). Do **not** put a background here expecting it to
beat the selection tint: it deliberately loses to `selected`, `active`, `invalid` and
`dirty`.

**(iii) Wrap a header.** Two fields on the COLUMN, both optional:

```ts
{
    key: 'jan26blk22', label: 'JAN-26-BLK22', width: 96,
    headerWrap: true,                       // two lines instead of `JAN-26-B…`
    labelNode: <span className="leading-tight">JAN-26<br />BLK22</span>,  // optional
    format: (row) => fmt0(row.kg),
}
```

`headerWrap` alone is usually enough. `labelNode` is for a genuinely rich label (a unit
under a name, a small icon); **keep `label` as the plain string** — it is what the tooltip,
the resize handle's `aria-label` and `Copy with headers` read.

### Two things in the brief for this pass that turned out to be wrong

- **`GridContextMenu` is not Radix.** The brief said to reuse it *"(Radix)"* and to work
  around Radix's focus restoration with `onCloseAutoFocus`. Its own header says the
  opposite in capitals — *"NO shadcn / Radix (avoids focus-steal inside grids)"* — and it
  is a plain `position: fixed` div. So there is no `onCloseAutoFocus` to set. **The
  underlying hazard is real anyway**, for a different reason: a menu ITEM has unmounted by
  the time the click finishes, so focus is orphaned regardless of who owns the popover.
  `dismissMenu` therefore calls `closeMenu()` and then the grid's own `focus()`, and the
  suite proves it by pressing an arrow key straight after clicking Copy.
- **The selection border could not go on an overlay or a box-shadow.** A `box-shadow` on
  the cell layer competes with the active cell's `ring-*` (Tailwind composes both into one
  `box-shadow`), and an inset shadow on the `<td>` is painted over by the layer's own
  background tint. It is a real 1px `border` on the layer instead — with **all four sides
  declared `transparent` on every cell in the table**, so only the COLOUR changes when a
  sweep arrives. That is what buys zero layout shift: a border added only to the cells that
  happen to be on an edge would move their text by a pixel as the drag reached them, a
  shimmer running along the perimeter of every selection.

### What this pass did NOT build

- **The spanning header BAND row** (seam 3's other half) — Trucks still carries its plate
  in each sub-column's label. *(The two-line label it also wanted is now covered from the
  other direction by `ColumnSpec.subLabel`, below.)*
- **`TableSummaryRow.cells?(api)`** (seam 4) and the sticky-summary **`figure`-inside-the-
  pinned-block guard** (seam 5). Both unchanged.
- ~~**The `width: 100%` + `minWidth` stretch bug**~~ — **BUILT, 2026-08-20:
  `sizing: 'fill'`.** See the section below. The note that mattered stays true: the
  session-local resize flows through `resolveColumns`, so `minWidth` and the sticky offsets
  move together — which is now the mechanism the fix is built on rather than the property a
  mitigation rested on. `'content'` (the default) is unchanged, stretch bug included, and
  the consumer-side `maxWidth` clamps still work exactly as before.

---

## The review pass (2026-08-20) — five things Renzo found by driving the live grids

One bug, two seams, one feature and one platform decision. Everything is additive except
the first, which is a correctness fix nobody would want opted out of.

### 1. A multi-cell selection has exactly ONE rectangle

**The defect.** Sweep a range and the perimeter box painted correctly — and the cell the
sweep started from still carried its own full `ring-2`, so the selection read as **two
nested boxes a pixel apart**. Renzo: *"not intended behavior."*

**The rule, and it is one statement in two halves:** *there is always exactly one rectangle
on screen.* A 1×1 selection paints no box (`cellRangeEdges` declines it) and the caret's
ring is the whole answer; a selection wider or taller than one cell paints the box and the
anchor's ring is suppressed. Those two clauses are the same test, which is why the row
derives it from the geometry it already holds rather than from a new prop:

```ts
const boxedSelection =
    selectionBand !== null &&
    !(selectionRowEdge === 'both' && selectionBand[0] === selectionBand[1]);
```

Three details that are load-bearing:

- **`CellClassKey.boxed` is in the cache key.** It changes the class string, so omitting it
  would serve the first combination the cache ever saw to every cell after it — the anchor
  would keep or lose its ring at random. Same reasoning as the four edge flags.
- **It is `selected && boxedSelection`, never merely "a multi-cell selection exists".** A
  caret parked OUTSIDE the rectangle — which is what a header click's column sweep leaves
  behind — keeps its ring, so the operator can still see where the keyboard is.
- **Suppressing the ring does not cost the tint.** The anchor still reads as selected, and
  still paints its corner of the perimeter. Asserted in both the unit suite and the browser.

No prop, no opt-out, nothing for a consumer to write.

### 2. `ColumnSpec.rowCopy` — a column that is not part of the record

RC IN's STATE column is a status rail, not data, and it landed in front of every row a
`Copy row` produced. The seam is one optional field, **defaulting to true**:

```ts
{ key: 'state', label: 'STATE', width: 64, rowCopy: false, format: (row) => <StateRail row={row} /> }
```

**It narrows the ROW-COPY path and nothing else.** `lib/table/clipboard.ts::rowCopyColumns`
is the one definition of the covered set, and `tsvOf` — the rectangle copy behind
Ctrl/Cmd+C, `Copy` and `Copy with headers` — builds its column list from the selection's
own bounds and never consults it. If the operator swept the column deliberately, they asked
for it; only "the whole row", which names no columns at all, has to decide for itself what
the whole row is. (Asserted both ways.)

`TableMenuActions.copyRow` gained an options bag so the headers form covers the identical
columns — one list, so the header line can never name different columns than the values
under it:

```ts
copyRow(navRow: number, opts?: { headers?: boolean }): void
```

### 3. The universal sort and filter

Renzo: *"tables don't have a universal filter/sort feature. Would be nice to have this for
all columns on the universal table."* It is `lib/table/view.ts` — one pure transform — plus
two affordances in `HeaderCell` and the state in `BlackwoodTable`. **It is VIEW state: it
never mutates a row, never touches the URL and never reaches a query.** A consumer whose
filters already live in search params keeps them, and `renderHeaderSlot` still hangs that
consumer's own control beside the built-in ones.

**THE CHROME-ROWS RULE, as implemented.** *While a sort **or** a filter is active, the
chrome rows and the group spacers are HIDDEN and the plain data rows render flat. Clearing
both restores the consumer's own flatten exactly — `applyTableView` returns the ORIGINAL
ARRAY IDENTITY when neither axis is on.* A group heading, a per-group rule-off and a day
total are all claims about a RUN of adjacent rows: a sort destroys the run, and a filter can
empty it. Re-tiling them would need to know what they MEAN, which is precisely the tenant
knowledge the platform layer may not have. The brief asked for this under sort; it is
applied to filter too, deliberately, because a heading standing over a group whose every row
was filtered out is a heading over nothing.

The other four rules:

- **A CHILD is glued to its parent.** The unit of sorting is a data row plus the child rows
  that follow it, so a receipt and its sub-rows move together and a child is never sorted
  against its parent's peers. It is `occupies()`'s insight applied to ordering: a child is
  not a small parent, so it has no sort key of its own to be judged by.
- **A DRAFT never sorts and never filters out.** A blank row being typed must not jump to
  the top, and must not vanish because it does not match yet. Drafts pass through untouched
  and stay at the end. (`draftKind` is how the transform knows.)
- **Blanks sort LAST in both directions**, and ties keep the consumer's own order — an
  operator sorting descending is looking for the big numbers, not the empty cells.
- **The comparison** uses `numericValue` where a column has one, else `clipboardValue` (else
  `storedText`), with `localeCompare(…, { numeric: true, sensitivity: 'base' })` — which is
  what puts `R-2` before `R-10`.

**SCOPE DEFAULTS, and why the split is not a preference.**

| scope | sort | filter |
|---|---|---|
| `focus` | ON | ON |
| `endless` | **OFF** | **OFF** |

An endless grid's row order and its window are the SERVER's keyset. A client-side sort
would reorder only the rows currently loaded, and `hasOlder` / `hasNewer` — which mean
"there are older/newer rows beyond this window **in the server's order**" — would become
claims about an order that no longer exists. The Cenapro endless ledger already declined a
sort for exactly this reason. Two overrides:

```tsx
<BlackwoodTable enableSort enableFilter … />   // endless, accepting the caveat
```
```ts
{ key: 'num', label: '#', width: 48, sortable: false, filterable: false, … }
```

`sortable` / `filterable` default to true except on `cellKind: 'derived'` — the same
default and the same reasoning as `selectable`.

**Selection correctness.** Sorting or filtering is exactly the operation that changes which
row each nav-row coordinate names, so the selection and the caret are DROPPED on any change
to either axis. Leaving them would give the operator a rectangle that looks untouched while
pointing at four different rows — and a Delete or a Fill down aimed at it would land on rows
nobody chose. Nothing re-derives a row index: the transform hands `useTableRows` a different
`items` array and the one row axis is resolved from that, as always.

**What it looks like.** A caret button per header (asc → desc → off) and a funnel button
that opens `HeaderFilterPopover` — a text `contains` box, plus MIN/MAX bounds on any column
that declares a `numericValue`. Both are faint until the column is actually sorted or
filtered, on the same `group-hover/th` reveal as the resize handle. A small strip under the
sheet shows `214 of 991 rows`, what it is sorted by, and one **Clear** for both axes.

The popover is **not Radix** — the same decision `GridContextMenu` records in capitals — and
it is `position: fixed`, because the header lives inside the horizontally scrolling
scrollport and an absolutely-positioned panel would be clipped by it on every column past
the fold.

**One caveat worth stating plainly:** the filter's bounds EXCLUDE a row with no number
rather than reading it as 0. `min: 0` sweeping in every unpriced row would be the L-008
placeholder bug in a new costume.

### 4. `ColumnSpec.onHeaderClick` and `ColumnSpec.subLabel`

```ts
{
    key: 'C-8B', label: 'C-8B', width: 96,
    subLabel: 'JAN-26-BLK22',                       // a real second line, muted, always one line
    onHeaderClick: (spec) => openBlockDrawer(spec.key),  // INSTEAD of sweeping the column
    format: (row) => fmt0(row.kg),
}
```

- **`onHeaderClick` replaces the label's click entirely.** Column-selection is the right
  default and the wrong behaviour for a header that names a *thing* rather than a lane — RC
  Movement's block headers open a detail drawer, and sweeping 400 cells behind that drawer
  is not what was asked for. **The sort caret and the filter trigger beside it stay
  separately clickable**: they are their own buttons with their own handlers, and both stop
  propagation, so a column may have an override AND a sort. Proven in the browser.
- **`subLabel` is rendered whenever present, independent of `headerWrap`.** They answer
  different questions — `headerWrap` is *"may the NAME take a second line"*, this is *"the
  name has a subtitle"* — and a column may want either, both or neither. It is **always one
  truncated line**, which is what keeps the header row's growth bounded at two: the row
  grows to its tallest cell, and a subtitle free to wrap would grow it without limit.
  Measured in the browser, not assumed: the two-line header is taller than a one-line one.
- **Its TYPE is `text-[10px] leading-tight text-muted-foreground`, matched to the one real
  usage** *(corrected 2026-08-20; it shipped as `text-[9px] text-muted-foreground/70`)*. The
  first screen to declare a `subLabel` — RC Movement's block headers — mirrors a live table
  whose sub-line is `text-[10px] text-muted-foreground`, and against the shipped default it
  could only have matched by abandoning `subLabel` for a hand-built `labelNode`. **A default
  every consumer has to work around is the wrong default**: this seam exists so a two-line
  header is DECLARED rather than drawn differently by each screen, and a size nothing asked
  for defeats that. Pinned by an assertion in `verify-table-core.ts`, so the type is a
  decision rather than an accident.
- Both are plain strings/callbacks on the SPEC, so `label` still stays the required plain
  string the tooltip, the resize handle's `aria-label` and `Copy with headers` all read.

### 5. `sizing: 'content' | 'fill'` — one number for the layout AND the sticky arithmetic

The bug this closes is the one measured in "Stage 1D at scale": under `table-layout: fixed`
a table wider than its `<col>`s scales **all** of them proportionally (a declared 76px column
rendered **94.703px** at a 1600px container) while the sticky `left` offsets came from the
**declared** widths — so on a wide monitor the frozen block **overlapped itself**, and ten
consumers clamped their wrapper's `maxWidth` and left dead space to avoid it.

```tsx
<BlackwoodTable sizing="fill" … />   // default is 'content'
```

- **`'content'` is byte-identical with what shipped** — `width: 100%` + `minWidth: Σ`,
  stretch bug included. The existing consumer clamps keep working unchanged.
- **`'fill'` distributes the container's slack inside `useTableColumns`' resolution**, and
  the table is then rendered at that exact pixel width. So every offset, drag wall, footer
  corner and min-width is derived from the widths **actually painted**, and `table-fixed`
  has no slack left to scale into. The invariant, asserted in `verify-table-core.ts`: **Σ
  resolved widths === the container width, and every pinned offset is a prefix sum of the
  resolved widths.**
- **Three exclusions from the distribution, each a way the naive version is wrong.** A
  PINNED column never grows (its width is a wall the caret-follow and the drag auto-scroll
  measure from, and widening it hides *more* of the sheet). A column the operator DRAGGED
  never grows — a width they dragged is an instruction, and a distribution that overrode it
  would make the drag look broken. `resizable: false` never grows.
- **It degrades rather than overlapping.** No candidates (every column pinned or hand-sized)
  ⇒ nothing is distributed and the table sizes to content, leaving honest dead space. A
  container NARROWER than the columns distributes nothing at all — "never crush, always
  scroll" is not negotiable, and a negative slack is a scrollbar rather than a squeeze.
- **The measurement.** A rAF-throttled `ResizeObserver` on the grid's outer wrapper, reading
  the SCROLLER's `clientWidth` when it exists (the wrapper's is wider by the vertical
  scrollbar, which would buy a permanent horizontal one). The width enters `useTableColumns`
  as a PRIMITIVE, so the column memo compares by `===` and a resize that moved nothing
  re-resolves nothing.

### Where each of the five is asserted

| # | `verify-table-core.ts` | `e2e/table/parity.spec.ts` |
|---|---|---|
| 1 anchor ring | the class table + the row's derivation | ring absent in a 3×3 sweep, present on a click |
| 2 `rowCopy` | `rowCopyColumns`, and `tsvOf` never mentioning it | six fields out of eight columns |
| 3 sort / filter | 8 checks over `applyTableView` + the scope defaults | endless offers neither; cycle; chrome; counts; bounds; selection dropped |
| 4 header click / sub-label | the source's `instead of` branch, the sub-label's own line | override fires, caret still sorts, header measurably taller |
| 5 `sizing: 'fill'` | Σ widths === container, offsets are prefix sums, the three exclusions | `content` stretches, `fill` renders 48px as 48px and overflows by 0 |

