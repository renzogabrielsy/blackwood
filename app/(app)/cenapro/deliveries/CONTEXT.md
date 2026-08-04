# RC Deliveries (`/cenapro/deliveries`) — CONTEXT.md

## Purpose

Cenapro's **raw-charcoal receipt ledger** — the operators' "RC 2026" Excel sheet as a
live grid. It is the Cenapro analogue of ICTC's RC IN (`public.deliveries`), built to
the **QC Ledger's interaction standard** on the platform's **Blackwood Table**
primitives.

991 receipts + 244 moisture sub-samples are already imported and reconciled to the
centavo against the source workbook (see the parent `../CONTEXT.md` → "RC Deliveries").
This module is the UI on top of that.

**The feature this exists to support is liquidation** (assigning cheques and payments to
receipts). That is why the money columns are decomposed rather than opaque, why an
unresolvable supplier is refused rather than stored, and why `TTL PRICE` is never
computed in the browser.

**Tenant/Domain layer** — Cebu-specific, zero ICTC coupling.

---

## Files

| File | Role |
|---|---|
| `page.tsx` | **Server component.** Resolves the URL axes, fetches, hands off. Runs `fetchDeliveryMonthKeys()` + `fetchDeliveryDimensions()` in parallel, then either `fetchDeliveryMonth()` (focus) or `fetchDeliveryPage({mode:'anchor'})` (endless). Keys the client by `axesKey(...)` so a scope / lens / search change remounts with the server-prefetched window for the NEW axes — one deterministic seeding path, and it resets `firstItemIndex` by construction. **Renders no title** (the navbar owns titles). `export const dynamic = 'force-dynamic'`. |
| `types.ts` | **PURE module** (no `'use client'`, no server tag) — the shared vocabulary, imported by the server page, the server actions, the client grid AND the verify script. Owns: the generated-type-derived row shapes; `stripPrices()` (the ONE ₱ boundary); the column table + `buildColumns` / `frozenOffsets` / `minTableWidth` / `isSelectableColumn` / `columnCalcType`; **`parseSupplierCell` / `formatSupplierCell`** and **`parseDestinationCell` / `formatDestinationCell`** (the single-column ⇄ multi-field pairs); `weightEditText` / `priceEditText` (the formula round-trip); **`parseDeliveryDate` / `isIsoDate`** (the DATE cell's free-text ⇄ `yyyy-MM-dd` verdict); **`mergeFieldEdit` / `isDirtyFieldEdits`** (when unsaved text stops being unsaved) and **`countUnsavedWork` / `hasUnsavedWork` / `describeUnsavedWork`** (the ONE number the unsaved chip, the Save button and the axis guard all read); `sampleFieldFor` (which columns a sub-row occupies); **`columnOffsets` / `frozenBlockWidth` / `columnScrollLeft`** (where the caret-follow may scroll sideways to, given the pinned block); the draft-row constants (`DEFAULT_DRAFT_ROWS`, `clampDraftAdd`); the display formatters; `rowIssues` / `readImportFlags`; and the save-payload contracts. |
| `ledger-url.ts` | **PURE module** — the URL axes: `parseScope`, `resolvePeriod` / `periodBounds` / `periodLabel`, `parseIssueLens` (+ `ISSUE_LABELS` / `ISSUE_HINTS`), `parseQuery`, `axesKey`, **and the per-column filter grammar** (`parseColumnFilters` / `serializeColumnFilter` / `withColumnFilter` / `filtersKey` / `describeFilter` / `buildFilterPredicates` / `dateFilterMissesPeriod`). No React, no Next imports, so the server page and the client toolbar share one contract without a boundary hazard (same discipline as `production/ledger-url.ts`). It imports the column table from `types.ts` — column metadata lives with the columns, URL/SQL translation lives here. |
| `actions.ts` | **`'use server'`** — reads AND writes. `fetchDeliveryPage` (bidirectional keyset pager, plus the duplicate worklist branch), `fetchDeliveryMonth` (focus), `fetchDeliveryDimensions`, `fetchDeliveryMonthKeys`, `saveDeliveries`, `deleteDelivery`. Enforces the ₱ gate on every read and every write, applies the issue lens + per-column filters + search in **one** `buildRowQuery`, and sequences a combined field+samples save. |
| `use-deliveries-window.ts` | **Client hook** — `useDeliveriesWindow(initial, lens)`: the endless sheet's self-contained bidirectional keyset pager (no TanStack Query, mirroring `production/use-ledger-window.ts`). Owns react-virtuoso's `firstItemIndex` so a prepend and its index decrement land in one state batch, and holds the server's `totalCount`. Exposes `fetchOlder` / `fetchNewer` / `reset` / `refreshWindow` / `dropRecord`. |
| `deliveries-ledger.tsx` | **Client** — the grid. Both scopes, one set of closures. Custom `NavResolver`, edit state, cell renderers, toolbar, per-column filter popovers, the duplicate-peer popover, context menu, save, delete. Also owns **`requestAxisChange`**, the single guarded path every URL write goes through, and the unsaved-work prompt it raises, plus the **caret-follow** (`scrollTo` / `scrollToCol` / `scrollerEl`), whose every scroll is contained to the table's own scroller. |
| `../../../../scripts/verify-rc-deliveries-cells.ts` | Framework-free assertions over the two single-column pairs, the DATE parse, the dirty-clearing rule, the draft-row rules, the column/selection geometry, **the horizontal caret-follow's frozen-block arithmetic**, **the virtuoso index space** (`jn`'s clamp modelled verbatim, plus a source scan of `deliveries-ledger.tsx` refusing any `firstItemIndex` rebase at a scroll call site), **the filter grammar + predicate builder, the duplicate-badge logic and the axis guard's firing condition** (what counts as unsaved work, and which URL writes actually move the axes key), **the clear ⇄ Escape-revert round trip** (single cell, range, draft row, and Escape's two-stage verdict — plus a source scan that the wiring is still there and that clearing does not drop the selection), ending in a **replay over all 991 real receipts**. `npx tsx scripts/verify-rc-deliveries-cells.ts` — **73 assertions**, must stay green. |

Engine (pre-existing, not owned here): **`lib/cenapro/rc-formula.ts`** + its verifier
`scripts/verify-rc-formula.ts` (22 assertions).

---

## Data

- **Read model:** `public.cenapro_rc_delivery_rows` (read-only accessor over the
  enriched `cenapro.view_rc_delivery`). One row per receipt, already joined to the
  supplier / destination names and carrying `sample_count`, `sample_avg_moisture_pct`
  and the data-quality surface.
- **Children:** `public.cenapro_rc_delivery_samples` — the `#1 / #2 / BLUE SACKS /
  NO MARK/SUNDRY` moisture draws, 1–6 per receipt, fetched for a whole page in one
  `.in('delivery_id', ids)` round trip.
- **Dimensions:** `public.cenapro_rc_suppliers` (12 traders), `public.cenapro_rc_destinations`
  (16 yards).
- **Write RPCs:** `cenapro_save_rc_delivery`, `cenapro_save_rc_delivery_samples`,
  `cenapro_delete_rc_delivery` — all compare-and-set on `row_version`.

---

## Key Behaviors

### The columns — the sheet's own order

`# · DATE · TRK# · SUPPLIER · SKS · WT · BD · MOIST · GRIT · ASH · DUST · VM · FC ·
WAREHOUSE · REMARKS · PHP/KG · TTL PRICE`

Explicit pixel widths; their sum is the table's `minWidth` and the wrapper scrolls
horizontally ("never crush, always scroll" — no `1fr` column anywhere). BD renders to 3
decimals, the other lab values to 2, dates as `yyyy-MM-dd`, numerics `font-mono
tabular-nums` right-aligned, ₱ in accounting format (symbol pinned left, figure pinned
right), remarks `max-w-[200px] truncate` with the full text in the cell `title`.

`#` and `TTL PRICE` carry `field: null`, which is what makes them unaddressable.
`isSelectableColumn()` is one column WIDER than that: a range may cover `TTL PRICE`
(the pill is a reader, and a run of receipt totals is the most useful thing on the sheet
to add up) but never `#` (a row ordinal has no arithmetic meaning).

`DeliveryCol` carries **pure column metadata and nothing else** — `field`,
`isSelectableColumn()`, `columnCalcType()` and (2026-08-04) `filterKind` /
`filterColumn`. Everything the filter feature needs is therefore decidable from the
column table alone, which is why the whole grammar is testable from the verify script
without touching the grid.

### Cell geometry — the interactive layer fills the `<td>`, always

Each `<td>` is `p-0` with an explicit `height` (32px receipt / draft, 26px draw) and the
interactive layer inside it is **`absolute inset-0`**, not `h-full`.

That is a correctness rule, not a styling preference. `h-full` is a percentage height
against a table cell the browser has not committed to, so it collapsed onto the cell's
own TEXT — and two apparently separate complaints were the same bug: the active ring
(`ring-inset`) traced the text box rather than the cell, so a selected cell looked like a
small rectangle floating inside its own borders; and an **empty** cell's layer had zero
height and therefore **no hit area at all**, which is why an empty REMARKS cell could not
be clicked, let alone edited. `inset-0` fills the box whether the cell holds text or
nothing.

Consequences worth keeping in mind when editing this file:
- the `<td>` needs a containing block. Non-frozen cells get `relative`; frozen cells
  already have one (`.frozen-col` is `position: sticky`), and must NOT be given a second.
- cell content no longer contributes to row height, so the row height comes entirely
  from the `<tr>`/`<td>` height — never delete it.
- **exactly ONE `bg-*` class** is applied to the layer, chosen by an explicit ternary
  (`invalid` › `selected` › `dirty`). Stacking Tailwind background utilities and hoping
  is not a rule: they are emitted in Tailwind's order, not the order they are written.
- every tint rides on this inner layer, ABOVE the frozen cell's opaque `bg-background` —
  which is what keeps the frozen-pane rule intact (opaque base, translucent state on top,
  no bleed-through).

### SUPPLIER and WAREHOUSE — one Excel cell, several DB fields

The sheet has ONE supplier column (`BRIX - SOUTH HILONGOS`, `PALAWAN RANDY PSAU
282509-8`) and ONE warehouse column (`WHSE A- LFT`). The database, correctly, does not:
`supplier_code` + `supplier_origin` + `permit_no`, and `destination_code` +
`destination_side`.

Solved exactly the way the production ledger solved CCC/FLEC: a canonical **parse/format
pair** in `types.ts`, and only a parse/format pair. `formatSupplierCell` renders the
fields as the sheet writes them; `parseSupplierCell` takes them back apart against the
KNOWN codes. Both the grid's inline save and the paste path go through it, so the split
cannot be expressed a second way and drift.

Mechanics worth knowing:
- The permit is peeled off the **tail** first (`/\s+([A-Z]{2,6}\s*\d{4,}\s*-\s*\d{1,3})$/`),
  because the origin is free text and could contain anything. `SEVILLA SPECIAL #1 RED`
  is therefore an origin, not a permit.
- Codes are matched **longest-first on a word boundary**, not split at the first
  separator — `ALI UNGA` is one code, not `ALI` + origin `UNGA`.
- The side alternation is `LFT|LEFT|LT|L|RT|RIGHT|R`. `LT` is in it because the workbook
  contains `WHSE 3A LT`; everything normalises to the two values the DB CHECK accepts.
- **A value that does not resolve is REFUSED**, at commit (inline `errorToast` + a
  destructive cell tint) and again at save (the whole batch is blocked and every
  offending receipt is named). The import was allowed to leave `supplier_code` NULL
  because it was transcribing a workbook nobody can go back and ask about; a human typing
  today can be asked, so the app never writes an unresolved row.
- An unresolved IMPORTED row still shows its `supplier_raw` / `destination_raw` and wears
  a `MAP?` badge, so nothing is hidden.

### WT and PHP/KG — the formula cells

On focus the cell shows the FORMULA (`=27045*88%`); on blur it shows the computed value.
The engine is `lib/cenapro/rc-formula.ts` (recursive-descent, **no `eval`**); the
round-trip is `weightEditText` / `priceEditText`.

- Typing `=27045*88%` into WT stores `gross_weight_kg = 27045`, `deduction_pct = 12` and
  the formula text. **The DB computes `net_weight_kg`** — it is a generated column and
  cannot be written to.
- `=39.5+2.7` into PHP/KG stores base `39.5` + adjustment `2.7`.
- For an imported row with no stored formula, the formula is **REBUILT** from the stored
  parts (`weightFormulaFrom` / `priceFormulaFrom`), so an imported row and one typed this
  morning are indistinguishable. Verified over all 142 deduction rows.
- A parse error raises a **persistent `errorToast`** and leaves the cell dirty with the
  operator's text intact. It never writes a silent zero.
- While a row's WT or PHP/KG is dirty, the cell shows the value the typed formula
  evaluates to — but **TTL PRICE shows the STALE stored figure, italic + dimmed**, with a
  title saying so. It is a stored generated column (`net × ₱/kg`, exact decimal, verified
  991/991 against the workbook); reproducing that in floating-point JavaScript is
  precisely how a payment ledger goes wrong.

### DATE is a text cell that parses itself (Excel's habit)

There is no `<input type="date">` anywhere in this grid. DATE is a plain text cell on the
**same edit path as every other column** — type-over, F2, double-click, Escape — and the
loose text an operator types is transcribed on commit, exactly the way Excel transcribes
a date cell when you tab out of it.

- `parseDeliveryDate(text, contextYear)` in `types.ts` is the single verdict. It reuses
  the shared `normalizeTypedDate` from `lib/paste-utils` (`6/27`, `6/27/26`, `2026-06-27`,
  `27 Jun 26`, an Excel serial) — deliberately **not extended**, because that helper is
  shared with the production ledger and the paste paths.
- What this module adds on top is a **refusal**. `normalizeTypedDate` hands the operator's
  text back unchanged when it cannot read it, so `2026-02-30` comes out still looking like
  an ISO date; `isIsoDate()` therefore checks the day EXISTS (UTC round-trip), not merely
  that it is ISO-shaped. A shape test alone would post February 30th to Postgres and
  surface a raw cast error about a cell the UI had just called fine.
- **The context year** is what a bare `6/27` means: the focused month's year in the focus
  scope; otherwise the year of the receipt being edited; otherwise the newest dated row in
  the window; finally today's year. The paste path uses the same year, so a pasted `6/27`
  and a typed `6/27` can never land on different years.
- Unreadable text raises a persistent `errorToast()` and the cell **keeps the operator's
  text and stays dirty**. `buildPatch` re-checks with `isIsoDate` as the last gate before
  the RPC, so a cell left in that state blocks the save rather than posting.
- Display stays `yyyy-MM-dd`, `font-mono`. The amber `AlertTriangle` still marks an
  imported row whose `delivery_date_raw` never parsed.

### Select ≠ edit

The shared state machine (`useGridKeyboardNav`) already separates the two; this grid adds
two opinions on top, both because the operators live in Google Sheets:

| Gesture | Result |
|---|---|
| Click / arrows / Tab | SELECT only — never enters edit mode |
| Printable character | EDIT, seeded with that character (replaces the old value) |
| **Enter** / F2 / double-click | EDIT, preserving the value |
| Enter *while editing* | COMMIT + move down (still honouring the Tab-run lane anchor) |
| Shift+Enter | move up |
| Esc *while editing* | REVERT the editor + close it (see "Dirty state" below) |
| **Esc *not* editing** | UNDO the unsaved edits under the selection; deselect once there is nothing left to undo (see "Escape" below) |
| **Delete / Backspace** | CLEAR the cell — or the whole range — outright, no editor. **The selection survives.** |
| Shift+click, Shift+Arrow, drag | extend a rectangular range |
| Ctrl/Cmd+A · Ctrl/Cmd+C | select all · copy the range as TSV |

Enter-opens-the-cell and Delete-clears-outright are the two departures from Excel; Enter
*while editing* still commits and moves, so the Tab-run → Enter lane return survives.

This holds for EVERY editable column — the DATE cell included (item 8 removed the reason
it was special-cased), empty cells (the geometry fix gave them a hit area), REMARKS, the
sample sub-rows and the draft rows.

The grid's own `onGridKeyDown`/`onGridPaste` wrappers hold one further guard: a keystroke
or paste aimed at a real form control inside the grid (the "add rows" counter) is not a
grid gesture and is left alone.

### Escape means two different things, because there are two modes (2026-08-04)

Renzo: *"when backspacing a cell, app correctly thinks something is changed but when i
press esc, nothing happens. It doesnt revert to before i pressed backspace."*

| Mode | What Escape does | Who |
|---|---|---|
| **Editing** (an editor is mounted) | Restores `useGridEditSession`'s pre-edit snapshot and closes the editor. Keeps `stopImmediatePropagation` so Radix cannot swallow it. **Unchanged.** | `useGridKeyboardNav` (platform) |
| **Not editing**, something unsaved under the selection | **UNDOES** it — the active cell, or every addressable cell of the range — back to the stored value | `revertSelectedCells()` in `deliveries-ledger.tsx` |
| **Not editing**, nothing unsaved under the selection | Falls through to the shared hook, which clears the range (deselect) | `useGridKeyboardNav` (platform) |

**Why the second row had to exist at all.** Delete / Backspace clears a cell **without
opening an editor** (this grid's own opinion, and it stays) — so no edit session is ever
started, `preEditValueRef` never snapshots the old value, and the editing-mode Escape is
never reached. A backspaced cell was therefore *unundoable*: correctly marked dirty, with
no path anywhere in the module that could put the value back.

- **The undo is the existing dirty machinery, not a new undo stack.** `storedCellText(id)`
  is `getCellText(id)` with the unsaved layer taken off (`canonicalEditText` for a
  receipt, `draftCanonical` for a draft, the STORED draw block for a sample); writing it
  back through `setCellText` drops the field via `mergeFieldEdit` exactly as typing the
  old value by hand would. There is no second definition of "revert" and no second
  definition of "dirty". It also clears the cell's `invalidCells` mark — the stored value
  is valid by definition.
- **Two-stage, and never a no-op with work on screen.** `revertSelectedCells()` returns
  whether it actually undid anything; only `true` consumes the event. So the first Escape
  undoes and the second deselects. Propagation is deliberately **not** stopped on this
  branch (unlike the editing one) — an Escape the grid declines is one a Radix layer above
  may want.
- **Which is why the clear KEEPS the selection.** Delete / Backspace is handled in the
  ledger's own `onGridKeyDown`, not by the shared hook's range branch (which does
  `onDelete` then `clear()`), so the block just blanked is still the block the undo is
  aimed at — what Excel does. That branch also sits OUTSIDE the `activeRef.current` guard,
  because a range dragged from a read-only cell (TTL PRICE is selectable, never active)
  has no active cell and must still clear, and stay.
- **Scope is the selection, nothing wider.** An edit on a row the operator is not pointing
  at is untouched — this is an undo of the current gesture, not a "discard all changes"
  (that lives in the axis guard's *Discard N changes*).
- **Draft rows behave the same because they are stored nowhere.** A draft's canonical text
  is empty, except its **seeded date** — so reverting a cleared draft cell leaves it empty
  and not dirty, and reverting its cleared date puts the seed back. Clearing an
  already-blank draft cell was never an edit, so Escape reports nothing to undo and
  deselects instead.
- **The platform hook `lib/hooks/use-grid-keyboard-nav.ts` was NOT touched.** It is shared
  with RC IN, RC OUT, Production Daily and QC; the whole behaviour is expressed in this
  module's wrapper, so those grids keep their existing Escape and Delete semantics
  verbatim.

### Following the caret — scrolling that never moves the page (2026-08-04)

Renzo: *"pressing tab while a cell is selected appropriately goes to the next [cell] but
it also cause the page to jump down."*

Moving the caret has to keep it on screen, and **that is all it may do**. Both offenders
were the same mistake — a browser API that scrolls *every* scrollable ancestor, used to
move one table.

- **`focus()` is not a neutral call.** `HTMLElement.focus()` is specified to scroll the
  element into view with block AND inline **`"center"`**, in every scrolling box up to
  the document — and an `overflow-hidden` ancestor is still programmatically scrollable,
  so it counts. `onAfterMove` re-focused the full-height grid wrapper on *every* caret
  move, so every Tab re-centred that wrapper and dragged the page with it. All three
  sites now pass **`{ preventScroll: true }`** (`onAfterMove`, `goToReceipt`, the cell's
  `onMouseDown` — clicking a cell jolted the page for the same reason). Focus still
  moves; only the scroll is refused.
- **`Element.scrollIntoView` is gone from the focus scope.** It walked the same ancestor
  chain, and `block:'center'` re-centres a row *even when it is already fully visible* —
  so a purely horizontal Tab paid for a vertical scroll. The row is now brought into view
  by arithmetic on the table scroller's own `scrollTop`: minimum nudge, instant, and
  measured against the band **between the sticky `<thead>` and the sticky month
  `<tfoot>`**, so a row is never parked underneath either.
- **The endless scope needed no containing.** `virtuosoRef.scrollIntoView({index})` is
  virtuoso's own `scrollTo` on its own scroller — it never touches an ancestor — and its
  default `calculateViewLocation` returns null for an already-visible row, so it is
  already a no-op on a horizontal move.
- **…but it was handed the wrong index. See "The virtuoso index space" below** — the
  endless scope scrolled to the very bottom on every Tab and Enter until 2026-08-04.
- **Tab is horizontal, so horizontal scrolling had to exist at all.** The table is
  ~1608px inside an `overflow-x-auto` wrapper; Tab could walk clean off the right edge
  with nothing following it. `columnScrollLeft()` in `types.ts` decides the offset, and
  the load-bearing term is **the frozen block**: `# · DATE · TRK# · SUPPLIER` are pinned
  over the first **424px** of the scrollport, so a target scrolled to its own `left`
  lands *underneath* them and reads as "Tab went somewhere invisible". The target is
  therefore scrolled to `left − frozenBlockWidth(cols)`, clamped to the scroller. A
  frozen column asks for nothing (it is visible at every offset); so does a column
  already inside the window, which is what keeps a vertical move from shifting the sheet
  sideways.
- **The two axes are independent and each is a no-op when it owes nothing** — a Tab moves
  the sheet sideways and not a pixel down; an Arrow does the reverse.
- **Every scroll is instant** (`scrollTop`/`scrollLeft` assignment, `behavior:'auto'`).
  A smooth scroll under fast Tab entry is its own bug.
- The endless scope's scroll container is virtuoso's own div, so `LedgerScroller` hands
  the element back through `LedgerCtx.onScroller` — merged with virtuoso's ref, never
  replacing it. A **callback**, not a ref object: a component may not write through a ref
  it received as a prop. Reaching for virtuoso's private `[data-virtuoso-scroller]`
  attribute instead would break silently on a version bump.
- `columnScrollLeft` / `columnOffsets` / `frozenBlockWidth` are pure and asserted in
  `verify-rc-deliveries-cells.ts` (9 assertions, including a whole left-to-right Tab run:
  it never scrolls backwards, never overshoots, and the caret's column ends up clear of
  the pinned block at every step).

Still unfixed and deliberately out of this changeset: `EditInput`'s `autoFocus` (platform
code, `components/shared/grid/`) focuses through React's own `.focus()` call, which has
no `preventScroll`, so *starting an edit* can still centre the row. Same for
`GridCell.tsx:131`, which other modules' grids use.

### The virtuoso index space — RAW in, PUBLIC out (2026-08-04)

Renzo: *"hitting tab and enter takes me to the very bottom of the page… It enters and
tabs correctly, it just sends me straight to the bottom when i hit those things."*
Navigation was correct; only the scroll was wrong, and it went to the LAST row every
time. Always the last row, never a near miss — that signature is a **clamp**.

**The rule, and it runs in exactly one direction:**

| Direction | Index space | Who |
|---|---|---|
| Virtuoso reports an index **OUT** to you | **PUBLIC** = array position + `firstItemIndex` | `itemContent`, `computeItemKey` |
| You hand an index **IN** to virtuoso | **RAW** array position, `[0, items.length)` | `scrollToIndex`, `scrollIntoView`, `initialTopMostItemIndex` |

`firstItemIndex` offsets **only the outbound direction**. Verified in
`react-virtuoso@4.18.11/dist/index.mjs`:

- `:1492` — `t.map(d => ({ ...d, index: d.index + firstItemIndex, originalIndex: d.index }))`.
  That `+ firstItemIndex` is the *entire* extent of the prop's reach: `originalIndex` is
  the array position, `index` is the public one, and `:2782` is where the table renderer
  hands `computeItemKey` `originalIndex + firstItemIndex`.
- `:1775` (`scrollIntoView`) and `:1123` (`scrollToIndex`) both resolve their target with
  `jn(location, sizes, totalCount - 1)`.
- `:668` — `jn` ends with **`Math.max(0, Math.min(totalCount - 1, index))`**. It clamps
  against **`totalCount`**, not `firstItemIndex + totalCount`, and never subtracts
  `firstItemIndex`. **That clamp is the proof** that the inbound APIs take the raw index.
- `initialTopMostItemIndex` goes through the same clamp — `qe(value, totalCount)` at
  `:1169`, then published verbatim into `scrollToIndex` at `:1210`. Raw, like the rest.

**What went wrong.** `scrollTo`'s endless branch passed
`firstItemIndexRef.current + index`. With `FIRST_ITEM_BASE = 100_000` and ~1,000 loaded
rows, every call asked for index ~100,00N against a `totalCount` of ~1,000, so `jn`
clamped **every** target to the last row. The rebase was not merely wrong at the seed
value — a prepend moves `firstItemIndex` by one page, so it is wrong at every value the
seed ever takes. **Pre-existing since `12fb533`**, not a regression from the caret-follow
work in `82ae4f7`. The old in-code comment asserted the opposite ("the array position has
to be rebased before it can be scrolled to"); it has been replaced with the clamp
citation, because the rebase reads as the obvious fix and is exactly backwards.

**Call-site audit** (the whole surface — there are no others in this module):

| Call site | Space | Verdict |
|---|---|---|
| `scrollTo` → `virtuosoRef.scrollIntoView({index})` | RAW in | **Was the bug — fixed.** Passes the bare `items.findIndex(...)` position. |
| `goToReceipt` (duplicate-peer "Go to row N") | — | **Correct, and fixed with it.** It owns no index of its own; it calls `scrollTo(navRow)`. |
| `initialTopMostItemIndex={initialTop.current}` | RAW in | **Correct.** Walks `items` backwards for the newest receipt — an array position by construction, and read once at mount when nothing has been prepended anyway. |
| `firstItemIndex={win.firstItemIndex}` | — | **Correct.** The prop itself. Load-bearing (a prepend and its index decrement must land in one state batch) — do not touch it or the anchoring in `use-deliveries-window.ts`. |
| `computeItemKey={(_i, item) => item.key}` | PUBLIC out | **Immune.** Ignores the index argument entirely and keys off `item.key`. |
| `itemContent={(_i, item) => …}` | PUBLIC out | **Immune.** Same — ignores the index. |
| `startReached` / `endReached` | mixed out | **Immune.** Both ignore their argument. Worth knowing if that ever changes: virtuoso hands `startReached` a PUBLIC index (`:1679`) and `endReached` a RAW `totalCount - 1` (`:1670`) — the two disagree. |
| `scrollTo`'s **focus** branch | none | **Correct.** No index at all: it finds the row by `data-item-key` and nudges the scroller's own `scrollTop`. |
| `scrollToCol` / `columnScrollLeft` | none | **Correct.** Column geometry, unrelated axis. |

`firstItemIndexRef` existed only to perform the rebase and has been **removed**, so there
is nothing left lying around to reach for.

**Pinned by two assertions** in `verify-rc-deliveries-cells.ts`, because this survived a
full build, a lint pass and 65 assertions: one models `jn`'s clamp verbatim and shows a
raw index resolving to itself while a rebased one collapses onto the last row for all 991
rows; the other scans `deliveries-ledger.tsx` itself (comments stripped, with a guard
against a vacuous pass) and refuses any arithmetic on the `scrollIntoView` index,
`FIRST_ITEM_BASE` anywhere in the grid, the return of `firstItemIndexRef`, or any mention
of `firstItemIndex` outside the one `<TableVirtuoso>` prop.

### Dirty state — an edit that undoes itself is not an edit

`setCellText` routes through **`mergeFieldEdit`**, which DROPS the field from the edit map
when the new text equals the value already stored (and drops the row entirely when its
last field goes). The sample equivalent compares the whole draw block and drops it when
it matches the stored one, draw for draw.

This exists because `useGridEditSession.revertChanges` cancels an Escape by calling the
same setter with the pre-edit snapshot — a perfectly correct VALUE and a perfectly wrong
DIRTY STATE. The field stayed in `edits`, so the row stayed in `dirtyIds`, the "N unsaved"
chip kept counting it and Save stayed lit with nothing to write. Fixing it as a general
rule rather than an Escape special case means typing a value back by hand is just as
clean as pressing Escape.

Note the asymmetry that is deliberate: **clearing** a stored value is still an edit
(`remarks: ''` must reach the patch as `null`), so only an exact match to the stored text
clears the flag.

`invalidCells` is keyed by `<rowKey>:<colKey>`, never by row INDEX — the row axis moves
under the selection (a page loads, a lens changes, blank rows appear), and a positional
key would silently re-point a "this cell is invalid" mark at somebody else's cell.

### Blank rows at the bottom (draft receipts)

Google Sheets keeps a run of blank rows under the last real one plus an
`Add [N] more rows at the bottom` control; so does this ledger. **20** by default, and the
control's count defaults to 20 (clamped 1–500 by `clampDraftAdd`).

- A draft is a fully addressable, fully editable nav row — it just has no `id` yet. It
  renders muted with a `+` in the `#` lane and a faint left rail. No animation.
- **An untouched draft is not unsaved work.** `isDirtyFieldEdits` requires a non-blank
  value, so the Save button and the unsaved-count chip ignore the pool entirely.
- Its DATE cell is **seeded** (not edited) with the newest date in view — the focused
  month's first day when that month is empty. It shows muted until the operator makes it
  theirs, and re-typing the same date does not make the row dirty.
- Saving goes through the SAME path as everything else: `cenapro_save_rc_delivery` INSERTs
  when `p_id IS NULL` (and refuses the call if an expected version rides along, so both
  travel as null). `saveDeliveries` omits both params rather than sending null, threads the
  new `id` + `row_version` back on the result, and each input carries a client `key` so a
  verdict can be matched to a row that had no id when it was sent.
- Two requirements are checked CLIENT-SIDE first so the operator meets them as a sentence
  rather than a database error: a date, and a supplier that resolves. The existing rule is
  unchanged — validation runs first and **one bad cell blocks the WHOLE batch**.
- Drafts render only where a blank row means something: never under an issue lens or a
  search (those views are a CUT of history), and in `endless` only when the window is at
  the true newest end — otherwise blanks would sit in the MIDDLE of history.
- They are appended AFTER everything and never counted in any total, so react-virtuoso's
  `firstItemIndex` anchoring is untouched (it only ever shifts on a PREPEND).
  `initialTopMostItemIndex` opens on the newest RECEIPT, not on the last blank row.
- After an insert the endless window **re-anchors on `latest`** rather than refreshing in
  place: the new receipt did not exist when the window was read, and its date decides where
  it belongs. That is also what keeps the blank rows on screen.

### The floating selection pill

Rectangular selection feeds the platform's `FloatingStatusBar` (mounted once in
`app-shell.tsx`, fed through `status-bar-context`) via `useCellSelection` +
`useCellAggregation` — the same instruments as RC IN.

- Defaults per column: SKS / WT / TTL PRICE → **SUM**; the seven lab values and **PHP/KG →
  AVERAGE**, because PHP/KG is a RATE and a column of summed rates means nothing. The
  operator can override in the pill.
- **It sums STORED values only.** `net_weight_kg`, `price_php_kg` and `total_price_php` are
  DB-generated exact decimals; a pill that re-derived them in floating-point JavaScript
  would quietly disagree with the ledger it is summarising. An unsaved edit does not move
  the total, and a draft row (nothing stored) contributes nothing.
- **Price gating:** the two ₱ columns are ABSENT from `buildColumns()` for a gated viewer,
  so they are not in the selection space at all; the aggregator additionally guards on
  `canViewPrices`. A gated viewer can never surface a ₱ figure in the pill.
- **The row-shape asymmetry is honoured.** A rectangle can cover coordinates where no cell
  exists (a draw has no weight, no sacks, no price). The tint is painted only where a cell
  exists and `getNumericCellValue` returns `null` there, so the pill totals only what is
  really on screen — the selection counterpart of the per-CELL `NavResolver` below.

### Sample sub-rows, and why the grid needs its own `NavResolver`

A receipt's moisture draws render as indented CHILD rows directly beneath it. A draw is
not a small receipt — it has no date, no truck, no weight, no warehouse, no price. It has
a free-text label (rendered in the SUPPLIER lane, the widest frozen column) and up to
seven lab readings.

So the two row families disagree about which columns they occupy, and
`createCoordinateNavResolver`'s `columnMap` is per-COLUMN, which cannot express that.
`createDeliveryNavResolver` (local, modelled on the QC ledger's) asks **per CELL**: every
branch answers "is there an addressable cell that way?" and returns `null` (stay put)
when there is not, so the selection can never come to rest on a cell that does not exist.

The behavioural consequence is the asymmetry the data already has: **ArrowDown in the WT
lane walks receipt-to-receipt**, stepping over the draws in between, while **ArrowDown in
the MOIST lane walks through every draw** — which is what a QC operator reading down a
moisture column wants.

Draws are added / removed via the row context menu and saved with
`cenapro_save_rc_delivery_samples`, which **replaces the whole block** (so the client
always sends the full list).

### MOIST is offered, never auto-filled

The receipt's own MOIST stays independently editable. The context menu offers **"Fill
MOIST from N draws"** using `sample_avg_moisture_pct` (computed in SQL, not TypeScript).
It is never automatic: the receipt's reading is what the lab signed off, and a six-draw
mean is a different measurement with a different meaning.

### Two scopes (`?scope=endless|focus`)

- **endless** (default, omits the param) — `react-virtuoso`'s `TableVirtuoso` with
  `firstItemIndex` prepend anchoring, bidirectional keyset paging over
  `(delivery_date, id)`, server-prefetched first window. *(A month-start badge used to
  ride on the first date cell of each month; it was removed 2026-08-04 — it read as a
  row highlight rather than a marker, and the sheet is already in date order.)*
  - **NULL dates are handled explicitly.** Canonical order is `delivery_date ASC NULLS
    FIRST, id ASC`, and a plain `delivery_date.gt.X` never matches a NULL — so the two
    undated receipts would sit at the head of history and be permanently unreachable.
    `keysetPredicate()` names the NULL group in both directions. Verified live against
    PostgREST.
- **focus** — month-scoped (`?year=&month=`), day-grouped, with `Σ DAY TOTAL` rule-off
  rows and a **sticky month footer**.

Column filters and the search work in BOTH scopes; the duplicate lens is the one view
that pages in neither (see "Duplicate pairing" above).

### Frozen panes

`# · DATE · TRK# · SUPPLIER` are frozen with cumulative `left` offsets. Every frozen cell
is **fully OPAQUE** (`bg-background` body / `bg-muted` header — never glass, no alpha, no
`backdrop-blur`), `.frozen-edge` sits on the last frozen column, and the **active-cell
ring is at `z-20`** so it clears `.frozen-col` (z-10). The month footer's bottom-left
corner is `.frozen-corner-bottom` + `.frozen-edge` and spans **exactly** the frozen block
— no further, or it would overhang into scrolling territory.

The block's 424px total is not only a paint concern: it is subtracted by the horizontal
caret-follow, or Tab would scroll a column to a position where the pinned columns cover
it. See "Following the caret" above.

### Data-quality surfacing

The import deliberately kept bad rows visible rather than fixing them, so the UI surfaces
them rather than smoothing them over:

| State | Treatment |
|---|---|
| `is_suspected_duplicate` (22 rows) | Rose inset rail on the frozen block + a **`DUP n/N` badge opening the peer popover** + a rose row wash. **THREE consecutive days are pasted twice, ₱17,185,939 in total** — 2026-04-06 (9 rows, ₱6.94M), 04-07 (7 rows, ₱5.32M), 04-08 (6 rows, ₱4.93M). *(An earlier draft of this note said "the 2026-04-06 block, roughly ₱7M"; that is only the largest of the three — corrected 2026-08-04 from live counts.)* Every day total and the month footer carry an explicit "includes … from suspected duplicates" line, so nothing is silently double-counted — but **the human decision to keep or drop them has not been made.** |
| `duplicate_group_key IS NOT NULL`, unflagged (22 rows) | The ORIGINALS the flagged rows were pasted from — see "Duplicate pairing" below. A **thinner, 40%-opacity rose rail, no row wash**, and an OUTLINE `TWIN n/N` badge onto the same popover. |
| `has_import_flags` (34 rows) | Sky rail + a warning icon opening a **popover** with each flag's `kind` / `detail` / the workbook's original `raw` text. |
| `supplier_unresolved` / `destination_unresolved` (1 / 5 rows) | Amber rail + a `MAP?` badge; the cell shows the raw text; a save is refused until it resolves. |
| unparseable date | Amber triangle in the date cell, with `delivery_date_raw` in the title. **Currently 0 rows** — the two `5/262026` receipts (`source_row` 1020/1021) were dated to 2026-05-06 in the app and keep their raw text, so `?issue=undated` is empty today (verified live 2026-08-04). The lens and the trap it guards both stay: `delivery_date` is still nullable for `sheet_import` rows. |

Each is also a **URL lens** (`?issue=duplicate|unmapped|flagged|undated`), pushed into the
SQL query rather than filtering after the fact, so a link to the duplicate worklist is
shareable.

### Duplicate pairing — which row is this a copy OF? (2026-08-04)

Renzo: *"for suspected duplicates, it would be nice to see which rows it is duping. So
that we know its actually a dupe with an exact copy of a row."*

The read model gained four columns (`duplicate_group_key` / `_size` / `_ordinal` /
`duplicate_peer_ids`, migration `20260804072000` — see `../CONTEXT.md` → "Duplicate
pairing"), and this module uses them in three places.

**BEHAVIOUR CHANGE: `?issue=duplicate` now returns 44 rows, not 22.** It filtered on
`is_suspected_duplicate`, and the importer flagged only the SECOND copy of each pasted
receipt — so the lens returned 22 orphans with their 22 originals invisible, which is
exactly the shape that cannot answer "is it really an exact copy of that row?". It now
filters `duplicate_group_key IS NOT NULL`: **22 groups × 2 = 44 rows, on exactly
2026-04-06 / 04-07 / 04-08** (verified live over PostgREST, `content-range 0-43/44`).

- **The two members of a pair are ADJACENT**, which needs the ordering
  `(delivery_date, duplicate_group_key, duplicate_group_ordinal, id)` — and that is NOT
  the `(delivery_date, id)` the keyset cursor is expressed in. A cursor in one ordering
  walking a result in another silently skips and repeats rows, so **the duplicate lens
  does not page at all**: `duplicatePairs()` in `actions.ts` returns the whole worklist
  in ONE window with `hasOlder`/`hasNewer` false, so nothing ever asks for a cursor page.
  Honest because the set is an arbitration queue, not history; the cap
  (`DUPLICATE_WORKLIST_MAX = 600`) is explicit and, if reached, said out loud in the
  page's `notice` rather than silently truncating. The focus scope reorders the same way
  and has no cursor to keep in step. *(Ordering by `source_row`, which focus normally
  uses, is the one thing that would NOT work — `source_row` is precisely what differs
  between an original and its paste, 639 vs 664.)*
- **Flagged ≠ paired, and the UI never conflates them.** `duplicateBadge(row)` in
  `types.ts` is the ONE verdict: `DUP n/N` (filled rose) on the importer's accusation,
  `TWIN n/N` (outline rose, thinner rail, **no row wash** — the wash IS the accusation)
  on an original, and a bare `DUP` with no peer when a human has edited one copy and the
  group has dissolved. A receipt with neither wears nothing.
- **The badge opens a popover naming the peer** — date · truck · supplier · net kg · ₱
  total, its row number in the current view, and "Go to row N" which selects it and
  scrolls to it (virtuoso `scrollIntoView` in endless; `data-item-key` + `scrollIntoView`
  in focus). A peer outside the loaded window says so plainly and offers the lens that is
  guaranteed to load both, rather than fetching behind the operator's back.
- **Price gating:** the popover's ₱ line renders only when `canViewPrices` — and the peer
  row was already `stripPrices()`-nulled server-side, so it is belt and braces. The four
  duplicate columns themselves are **NOT** in `stripPrices()` and must not be: the group
  key is a one-way md5 that discloses only that two rows are equal, and "this receipt is
  duplicated" is an operational fact every role needs.
- **Nothing here changes data.** No dedup, no delete, no clearing of flags. The
  ₱17.2M keep-or-drop call is Renzo's; this is the instrument, not the decision.

### Per-column filters (`?f_<column>=…`, 2026-08-04)

**Filterable:** DATE · TRK# · SUPPLIER · BD · MOIST · GRIT · ASH · DUST · VM · FC ·
WAREHOUSE · REMARKS. **Not filterable:** SKS · WT · PHP/KG · TTL PRICE (Renzo's own
exclusion list).

**Every filter is pushed into the SQL query.** The endless scope is a keyset pager
holding a ~120-row window, not the 991 rows, so a filter applied to the loaded window
would filter what happens to be in memory and lie about the rest — the same class of
error the totals rule guards against. `buildRowQuery()` in `actions.ts` is the one place
the lens, the filters and the search are applied, and `countRows()` reuses it verbatim
for the match count.

**The grammar** — one param per column, named `f_` + the column KEY:

| Kind | Columns | Param | Predicate |
|---|---|---|---|
| `set` | SUPPLIER, WAREHOUSE | `?f_supplier=BRIX,PALAWAN` | `.in('supplier_code', …)` |
| `text` | TRK#, REMARKS | `?f_remarks=czarina` | `.ilike(col, '*czarina*')` |
| `range` | BD MOIST GRIT ASH DUST VM FC | `?f_moist=8..12` | `.gte` + `.lte` (either side may be empty) |
| `dateRange` | DATE | `?f_date=2026-04-01..2026-04-30` | `.gte` + `.lte` |

- **`filterKind` / `filterColumn` live on `DeliveryCol`** and `FILTER_COLUMNS` is derived
  from `BASE_COLS` — never from `buildColumns(canViewPrices)`. `PRICE_COLS` is therefore
  never consulted when a URL is parsed, so **a forged `?f_php_kg=30..40` has nowhere to
  land**: a filter can never become a price oracle (a binary search on the match count
  would otherwise read out the number the ₱ boundary exists to hide). Asserted.
- **Keyset paging survives a filter** because every predicate is a plain conjunct on the
  **unchanged** `ORDER BY (delivery_date, id)` — the cursor still names a unique position
  in the filtered set and the walk just steps over a sparser one. What breaks it is a
  page that *forgets* the filters, so the bundle is threaded through `DeliveryPageInput`
  and the hook's `lensRef` into every single fetch. Verified live: two consecutive
  filtered keyset pages, zero overlap, strictly monotonic, every row still matching.
- **NULL dates.** `.gte`/`.lte` on `delivery_date` never match NULL, which is the correct
  answer (an undated receipt is inside no date range) — but note it is the mirror of the
  trap next door in `keysetPredicate()`, where the NULL group MUST be named explicitly.
- **Focus scope + DATE filter AND together.** A filter that misses the focused month is a
  legal query returning nothing, so `dateFilterMissesPeriod()` drives an empty-state line
  saying which of the two to widen.
- **State lives in the URL** and participates in `axesKey(...)`, so a filter change
  remounts the client against a window the server prefetched WITH the filter, and a
  filtered view is shareable. Each popover edits a DRAFT and applies on Apply/Enter — a
  control that wrote per keystroke would be a server round trip per keystroke.
- **Dimension values come from `fetchDeliveryDimensions()`** (12 traders, 16 yards), never
  from the loaded rows — deriving them from what is on screen would offer only the values
  the pager happened to have fetched.
- **Text is sanitised before it reaches PostgREST**: `*` `%` are its `ilike` wildcards and
  `,` `(` `)` separate an `or()` list, so all of them are stripped. An inverted range
  (`12..8`) is swapped rather than honoured — as typed it matches nothing, and nothing is
  not what the operator meant.
- **UI.** A `ListFilter` trigger in each filterable header — on the LEFT of a numeric
  column (whose label hugs the right edge) and on the RIGHT of a text one, so it never
  covers the label; the header stays **fully opaque** with an inset bottom bar marking an
  active filter (frozen-pane rule — the popovers get glass, the sticky header does not).
  A chip row under the toolbar spells out every active filter with its own X plus a
  single **Clear all**, and the toolbar shows the SERVER's match count (`count: 'exact'`
  on anchor fetches only, never `records.length`, which is just the loaded window).
  The seven lab columns were widened 62→64 / 66→72 to fit the trigger without crushing
  the label; `minTableWidth` sums the same table, so the geometry stays honest.
- **Header controls never swallow grid keystrokes.** `isGridChrome()` extends the
  previous `isFormField` guard with a `[data-grid-chrome]` marker, carried by the filter
  triggers and the two in-cell popover triggers — Enter on one opens the popover instead
  of opening the selected cell for editing.

### Totals

Day totals and the month footer are **SUMS OF STORED COLUMNS** (`net_weight_kg`,
`total_price_php` — both DB-generated, exact decimal), not arithmetic re-derived from
gross × deduction × rate. A rule-off line adds up the numbers already on screen; it does
not recompute them.

### Save

One Save button, batching every dirty row — stored receipts (UPDATE) and filled-in blank
rows (INSERT) alike. **Validation runs first and a single bad cell blocks the WHOLE
batch** — half-committing a sheet an operator is midway through is worse than refusing it,
because they would then have to work out which rows landed. The error toast names every
offending row.

A receipt with both field edits and sample edits is **sequenced server-side**: the field
patch runs first (bumping `row_version` via the `fn_touch_rc_delivery` trigger) and its
returned version is threaded into the samples call. Firing both with the same expected
version would make the second conflict with the first. Nothing retries and nothing
force-writes — a genuine `version_conflict` means another human moved.

`handleSave` **returns a verdict** (`Promise<boolean>`) — `true` only when nothing was
refused by validation, nothing came back `version_conflict` / `forbidden` / `invalid`, and
no dirty row was left out of the batch. It exists for the guard below, which may not
navigate away from work that did not land. It also takes `{ requery }` (default `true`):
the guard passes `false` to suppress the post-save `win.reset` / `router.refresh`, because
the URL write it is holding re-renders the page on the server anyway.

### Changing the view destroys unsaved work — so it is guarded (2026-08-04)

Every axis lives in the URL, and writing one changes `axesKey(...)`, which **remounts** the
client against a server-prefetched window for the new axes. All edit state is local, so all
of it goes. That was survivable when a search box and four lenses were the only triggers;
with twelve filter popovers, twelve chip X's and a Clear all it is not — and the blank rows
now hold hand-typed receipts. Eight typed, one filter narrowed to check something, eight
gone.

- **One choke point.** `requestAxisChange(mutate, {onApplied, onCancelled})` in
  `deliveries-ledger.tsx` is the ONLY code that writes the URL. Everything routes through
  it: the scope toggle, the month dropdown, the four issue lenses, the search commit
  (Enter + blur), the search X, each filter popover's Apply, each active-filter chip's X,
  and Clear all (toolbar **and** empty state). There is no `router.replace` anywhere else,
  and a new control that writes params outside it is a bug, not a variation.
- **It fires on the REMOUNT condition, not on "the URL changed".** Two questions come
  before the operator is asked anything: does the query string change at all (clicking the
  scope you are already on, re-applying the same filter, blurring an unchanged search box →
  no), and does `axesKey` change (making an implicit month explicit tidies the URL without
  moving the key → React keeps the instance, every edit survives, so navigate straight
  through). It predicts the key with the **same pure parsers `page.tsx` uses**, against the
  same `monthKeys`, so client and server cannot disagree. **A guard that cries wolf is the
  failure mode that gets guards ignored**, which is why both questions are asked first.
- **Dirty is not redefined.** `countUnsavedWork(dirtyIds, dirtyDraftIds)` in `types.ts`
  counts the two sets the grid already derives from `mergeFieldEdit` / `isDirtyFieldEdits`,
  and its `total` is what the "N unsaved" chip shows, what the Save button's `disabled`
  reads, and what the guard fires on — ONE number, so "the guard prompted while Save was
  greyed out" is not a state the code can express. An untouched draft and a cell typed back
  to its stored value stay invisible to it, exactly as before.
- **The prompt names both kinds of loss separately** (`describeUnsavedWork`) — *"3 edited
  receipts and 8 typed new rows"* — because they are different: an edited receipt still
  exists in the database with its old values, a typed blank row exists nowhere at all.
  Three outcomes:
  - **Save and continue** — `await handleSave({requery:false})`, then navigate **only if it
    returned true**. Sequenced, never fired in parallel with the axis write; a refusal of
    any kind keeps the prompt open over the work, with the existing persistent `errorToast`
    naming it.
  - **Discard N changes** — clears the edit maps explicitly (rather than relying on the
    remount to do it) and navigates.
  - **Cancel** — nothing is written. Every control is URL-derived, so the header triggers,
    the chips and the toggles are unchanged by construction, and the filter popover
    re-seeds from the URL on its next open — an abandoned draft never looks applied. The
    search box is the one control holding local text, and it is put back to the query
    actually running (`onCancelled`) rather than left claiming a search it did not apply.
- **`beforeunload` covers the other exit** — tab close, reload, a link out of the app —
  registered only while dirty. It does **NOT** cover a client-side route change to another
  Blackwood module: the App Router exposes no cancellable navigation event, and faking one
  (patching history, intercepting every anchor) is global surgery that breaks on a version
  bump. The gap is known and deliberate.
- Styling is the primitive's: `AlertDialogContent` already carries
  `bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80` and
  `animate-modal-enter`. Nothing in the grid beneath animates.

### PRICE GATING (security boundary)

**This module introduces ₱ to Cenapro for the first time.** Seven fields are money or
derived from money: `base_price_php_kg`, `price_adjustment_php_kg`, `price_php_kg`,
`price_formula`, `total_price_php`, `sheet_total_php`, `sheet_total_matches`.
(`price_formula` is in the list because `=39.5+2.7` states the price as plainly as the
number does.)

- `canViewPrices()` from `lib/auth.ts` is consulted in **every** fetch in `actions.ts`,
  and `stripPrices()` NULLS the fields **before the payload is returned**. The network
  response is the leak — hiding them client-side would not be gating.
- The boolean is passed down as `canViewPrices`, and when false `buildColumns()` **omits
  the two ₱ columns entirely** rather than blanking them, so the keyboard coordinate space
  has no unreachable holes and the table's min-width stays honest.
- `saveDeliveries` **refuses** a patch carrying a ₱ key from a gated viewer (outcome
  `forbidden`) — refused per receipt, not filtered silently, because a silent drop would
  look like a successful save that lost the operator's typing.
- Visibility is never re-derived with an inline `profiles.select('role')` lookup — that
  would ignore the impersonation cookie.

### Motion

**No animation on rows, cells or selection** — no stagger, no transition on the active
ring, the range tint, the cell tints or the draft rows. The only animated chrome is the
toolbar (`animate-fade-in` on the unsaved-count chip and on each active-filter chip), the
toolbar's own frosted bar (`bg-background/95 backdrop-blur
supports-backdrop-filter:bg-background/60`), and the two `AlertDialog`s — the delete
confirmation and the unsaved-work guard — which inherit `animate-modal-enter` and the
dialog glass from `AlertDialogContent` itself rather than declaring their own. Row hover is
`transition-colors duration-150`.

### Errors

Every error surface goes through **`errorToast()`** (persistent + Copy button, per the
HARD RULE). The load-error banner carries its own inline Copy button. Success/info
messages use sonner directly.

---

## Dependencies

- `@/components/shared/grid` — `EditInput`, `GridContextMenu` + `GridMenuItem`.
- `@/lib/hooks/use-grid-keyboard-nav` (`useGridKeyboardNav`, `CoordinateId`,
  `NavResolver`, `GridRangeSlot`), `use-grid-edit-session`, `use-grid-paste`,
  `use-grid-context-menu`.
- `@/lib/hooks/use-cell-selection`, `use-cell-aggregation`, `use-clipboard-copy` +
  `@/components/providers/status-bar-context` (`useStatusBar`) — the floating pill.
- `@/lib/cenapro/rc-formula` — `parseWeightInput`, `parsePriceInput`, `formulaCellText`,
  `weightFormulaFrom`, `priceFormulaFrom`.
- `@/lib/auth` — `canViewPrices()`; `@/lib/supabase/server` — `createClient()`.
- `@/lib/toast` — `errorToast()`; `@/lib/paste-utils` — `trimCellValue`,
  `normalizeTypedDate`; `@/lib/utils` — `cn()`.
- `@/types/supabase` — every row shape is derived from the generated `Database` type.
- `react-virtuoso` (`TableVirtuoso`, endless scope only), `date-fns`, `sonner`,
  `lucide-react`.
- Shadcn: `button`, `input`, `popover`, `alert-dialog`, `dropdown-menu`.

## See Also

- `../CONTEXT.md` → "RC Deliveries — DATA LAYER" for the schema, the generated-column
  design, the RLS/grants posture and the importer.
- `components/shared/grid/CONTEXT.md` — the Blackwood Table interaction model.
- `app/(app)/cenapro/qc/qc-ledger-client.tsx` — the day-grouping / `Σ DAY TOTAL` / sticky
  month footer / per-cell resolver this grid is modelled on.
- `app/(app)/cenapro/production/{ledger-url.ts,use-ledger-window.ts,production-endless-sheet.tsx}`
  — the URL-axis, keyset-pager and virtualized-table patterns this module mirrors.
- Project `CLAUDE.md` — the Excel Standard, "never crush always scroll", Frozen Panes,
  Motion & Glass, the Error Toast HARD RULE, price gating.
