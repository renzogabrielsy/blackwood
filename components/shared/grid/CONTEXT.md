# Blackwood Table — Shared Grid Package (CONTEXT.md)

## Purpose

The agnostic, modular **"Blackwood Table"** primitives — one canonical Excel-style
interaction model shared by every grid in the app ("oh, it's the Blackwood table"),
while staying visually malleable enough for the richest grids (the Cenapro Daily
Block). This package is **platform-layer, tenant-neutral**: zero charcoal/domain
knowledge.

The cell interaction is identical everywhere; only **target resolution** (which cell
is "next") and **range selection** (rectangular multi-cell) differ. So the package is
split into three layers (below). Phase 0 ships these primitives as **pure additions** —
nothing wires them into call sites yet (Phase 1+ migrates each grid).

### Canonical interaction model

| Gesture | Result |
|---|---|
| **Click** | SELECT the cell (ring, no edit) |
| **Type a printable char** | EDIT, seeded with that char (type-over) |
| **Double-click / F2** | EDIT, preserving the value |
| **Esc** (while editing) | REVERT to the pre-edit value, exit edit |
| **Enter / Tab** (while editing) | COMMIT + move to the next cell |
| **Enter** (after a Tab run) | COMMIT + drop one row, return to the Tab run's **lane** (Enter-anchor) |
| **Arrows / Tab / Enter** (not editing) | Navigate (skip read-only/locked, clamp/​wrap at bounds) |
| **Delete / Backspace** | Clear the cell (or the whole range in range mode) |
| **Shift+Arrow** | Extend a rectangular range (coordinate grids only) |
| **Ctrl/Cmd+C** | Copy the range as TSV (coordinate grids only) |

## Files

### `components/shared/grid/` (presentational)
- **`GridCell.tsx`** — coordinate `{row,col}` cell. Two modes: display (ring/tint +
  selection feedback) and edit (renders `children`). Extended in Phase 0 with an
  optional `onContextMenu` passthrough on the display div; ring/tint/behavior
  otherwise unchanged. Used by the flat coordinate grids. Its **fallback**
  `onMouseDown` (the branch taken only when the consumer passes NO
  `onCellMouseDown` — i.e. QC and the digest schedule grid) focuses the grid with
  **`{ preventScroll: true }`** — see "Focus must never scroll" below.
- **`SelectCell.tsx`** — categorical dropdown cell (DropdownMenu + RadioGroup).
  `value/options/onChange`, optional `renderLabel`/`renderTrigger`, `nullable`
  ("— None"), `placeholder`, `disabled`/`disabledHint`, `align`. Stops propagation
  on mouse/pointer-down so opening never starts a drag. Promoted verbatim from the
  production ledger (the canonical source).
- **`DatePickerCell.tsx`** — native `<input type=date>` overlay (opacity:0) + a
  `formatDateShort` display + calendar icon. `showPicker()` on click when available;
  both `.focus()` fallbacks pass `{ preventScroll: true }`. Also **exports
  `formatDateShort`** (was a local helper in the ledger — promoted here as its
  single source of truth).
- **`EditInput.tsx`** — the bare inline editor matching static-metric cells exactly
  (no row-height change on edit). `escapedRef` suppresses the blur-commit after
  Escape; placeholder vanishes on focus (Excel-like); `autoFocus` + type-over
  seeding. The `autoFocus` **prop is honoured by a ref callback, never by React's
  own `autoFocus` attribute** — see "Focus must never scroll" below. Also exports
  the canonical `EDIT_INPUT` class string. Standalone / presentational — no domain
  imports.
- **`GridContextMenu.tsx`** — declarative right-click menu (NO shadcn/Radix; avoids
  focus-steal inside grids). Consumes `useGridContextMenu` state; items via
  `GridMenuItem<T>` (label as string|fn for Delete↔Restore, icon, onSelect, variant
  default|destructive, disabled(ref), hidden(ref), or separator). Styling lifted
  verbatim from the existing menus (`z-[9999] … rounded-md border bg-popover/95 py-1
  shadow-lg backdrop-blur-lg`). **Phase 4** added two optional `GridMenuItem` fields
  for the RC IN column-header toggles: `keepOpen` (skip `onClose()` after `onSelect`
  so bold/italic/underline flip without dismissing the menu) and `trailingIcon(ref)`
  (a right-aligned indicator — e.g. a `Check` when a toggle is active — which switches
  the row to `justify-between`). Dynamic Delete↔Restore (where the muted/destructive
  `variant` must change) is modeled as two `hidden`-gated items, since `variant` is
  static. **Now consumed by all three grid menus:** RC IN delivery-master (row + column
  header), the Cenapro production ledger (row), and the daily production ledger (row).
  **2026-08-19 (the Blackwood Table platform pass)** added three more, so the universal
  table's built-in menu could reuse this popover instead of growing a fourth hand-rolled
  copy: `children` (nodes rendered ABOVE the declarative items, with the separator between
  them drawn here so a caller cannot forget it — the universal table puts a consumer's own
  `contextMenuItems` there and the shared defaults below), `containerProps` (extra
  attributes on the popover element — the table sets `data-table-context-menu`,
  `data-grid-chrome` and `role="menu"` on it), and `GridMenuItem.trailingLabel` (a
  right-aligned keyboard shortcut, the text twin of `trailingIcon`). All three are
  optional; every existing caller renders byte-identically.
- **`index.ts`** — barrel for the presentational components + their public types.
- **`RemarksCellAdaptor.tsx`** — pre-existing remarks cell adaptor (not part of the
  Phase 0 primitives).

### `lib/hooks/` (logic — imported directly, NOT from the barrel)
- **`use-grid-keyboard-nav.ts`** — **the linchpin.** `useGridKeyboardNav<Id>` is the
  cell-id-agnostic keyboard state machine (Esc/Enter/Tab/F2/Delete/printable + the
  Enter-anchor). Delegates "where do I go" to a pluggable `NavResolver<Id>`, and
  rectangular selection to an optional `range` slot. Also exports the two resolver
  factories: `createCoordinateNavResolver` and `createDomOrderNavResolver`.
- **`use-grid-edit-session.ts`** — `useGridEditSession<Id>` owns `isEditing` + the
  pre-edit snapshot + `startEditing`/`revertChanges`/`commit` (generic via injected
  `getValue`/`setValue`). The active-cell state itself stays in the consuming grid.
- **`use-grid-paste.ts`** — `useGridPaste` is the Excel/TSV smart-paste (parse TSV,
  auto-create rows past the end, map columns via `columnMap`, clean each value).
- **`use-grid-context-menu.ts`** — `useGridContextMenu<T>` owns menu state: viewport
  edge-flip on `open`, close on outside (capture-phase mousedown) + Escape.
- **KEEP unchanged (existing range hooks, composed not modified):**
  `use-cell-selection.ts`, `use-clipboard-copy.ts`, `use-cell-delete.ts`,
  `use-cell-aggregation.ts`.

### `scripts/` (guards — framework-free, run with `npx tsx`)
- **`verify-grid-keyboard-nav.ts`** (2026-08-17) — the range branch of
  `use-grid-keyboard-nav.ts`. A pure MODEL of "which cell does a printable character
  edit?" (showing the old anchor-vs-active divergence and the new agreement, across
  every drag direction and `Ctrl/Cmd+A`), plus a SOURCE SCAN asserting the shipped
  branch contains no `setActiveCell` and no `anchorId()`, that a character still edits
  `active`, and that the nav and char branches stay symmetric. **6 assertions, must stay
  green.** Its vacuous-pass guard is anchored on CODE, not a comment — `stripComments`
  removes the section headers, so a comment anchor would fail on a healthy file.

## Data

The primitives are **data-agnostic** — they carry no schema knowledge. The contracts:

- **`NavResolver<Id>`** — `resolve(from, move)` (null at a boundary), `laneOf(id)`
  (Enter-anchor lane), optional `resolveInRow(from, lane, dir)`, `isEditable(id)`.
- **`NavMove`** — `{kind:'arrow';dir}` | `{kind:'tab';shift}` | `{kind:'enter';shift}`.
- **`GridRangeSlot`** — `isRangeSelected`, `extend(e)`, `clear()`, `seedFromActive()`,
  `anchorId()`, `onCopy(e)`, `onDelete(e)`. Absent ⇒ DOM grid (no range mode; all
  range branches in the state machine are skipped).
- **`GridMenuItem<T>`** — declarative menu item over the row-ref payload `T`.

### The two NavResolver implementations — when to use which

| Resolver | `Id` type | Use for | Mechanics |
|---|---|---|---|
| **`createCoordinateNavResolver`** | `{row,col}` | flat grids: RC IN/OUT bulk, production ledger, daily ledger, electricity, trucks, cenapro bulk-add | The `moveSelection` math — skip null columns, Tab wraps rows + clamps, Enter down / Shift+Enter up. Pair with the `range` slot for rectangular selection. |
| **`createDomOrderNavResolver`** | `string` navid | the Cenapro **Daily Block** (merged-rowSpan pivot, heterogeneous rows) | Reads `[data-navid]` in **document order** (NOTE: `[data-navid]`, not `input[data-navid]`, so it also finds STATIC click-to-select cells); up/down + Enter-anchor use an injected `findColInAdjacentRow` (prefer same lane, else nearest by `navColOrder`). **No** `range` slot. |

## Key Behaviors

- **Three-layer architecture:** (A) generic state machine `useGridKeyboardNav`
  interprets keys + owns the Enter-anchor; (B) pluggable `NavResolver<Id>` answers
  "next cell"; (C) opt-in `range` slot adds rectangular selection (coordinate grids
  only). The range branches are **fully skipped** when no `range` is passed.
- **Enter-anchor** lives in the state machine (gated by `enableEnterAnchor`, default
  on): the first Tab of a run records `resolver.laneOf(active)`; a later plain Enter
  drops one row via `resolveInRow(active, anchorLane, +1)` then clears the anchor;
  any arrow clears it. Lane type is whatever `laneOf` returns (col index for
  coordinate grids, colKey string for the Daily Block) — reconciled from both the
  bulk-add (numeric) and Daily Block (string) implementations.
- **Esc + Radix:** while editing, Escape calls
  `e.nativeEvent.stopImmediatePropagation()` so a parent Radix Dialog never catches
  it and closes the modal.
- **Delete/Backspace is undoable ONLY because it opens an editor (2026-08-04).**
  `useGridKeyboardNav`'s single-cell branch is `edit.start(active, '')` — it goes
  through `useGridEditSession.startEditing`, which snapshots the pre-edit value
  BEFORE blanking the cell. That snapshot is the only thing Escape has to restore,
  so in every grid on this hook a single-cell clear reverts cleanly. **The range
  branch does not:** `range.onDelete(e); range.clear();` runs the consumer's
  `useCellDelete` (which writes `''` per cell with no snapshot) and then drops the
  selection in the same breath, so a multi-cell clear is not undoable and there is
  no selection left to aim an undo at. **This is deliberate and unchanged** — a
  correct fix needs a per-cell *stored* value to revert to, which the coordinate
  grids on this hook do not have (see the audit note in each consuming module's
  CONTEXT.md). A grid that DOES have one (Cenapro RC Deliveries) expresses the whole
  behaviour in its own `onGridKeyDown` wrapper and never touches this hook.
- **The hook is inert without an active cell.** `handleKeyDown` returns immediately
  when `activeCell === null`, which includes the range branches — so a range built
  purely by dragging (the coordinate grids set `activeCell` on a single-cell *click*,
  not on a drag) will not respond to Delete/Copy until some cell has been clicked.
  Consumers needing otherwise must handle those keys before delegating.
  - **Corollary a consumer can get wrong: never set `activeCell` to `null` just because
    the clicked cell is read-only.** A cell that is selectable but not editable is still
    a place the caret may rest — the resolvers only ever test the **target's**
    addressability, so arrows and Tab resolve correctly *from* one, and `isEditable`
    already refuses the edit. Nulling it instead makes this hook inert and the whole
    sheet loses arrows, Escape, Delete and copy until another cell is clicked. That was
    BUG-023 in the Cenapro deliveries ledger (`setActiveCell(canEdit ? … : null)`).
- **Typing over a range edits the ACTIVE cell, never the range's anchor (2026-08-17,
  BUG-022).** The RANGE MODE printable-char branch used to `setActiveCell(range.anchorId())`
  and then fall through to the char handler, which starts the edit on `active` — the cell
  captured at the top of `handleKeyDown`, before the move. **`anchorId()` is the geometric
  TOP-LEFT** (every consumer derives it from `useCellSelection`'s `normalizeRange`, which
  is `Math.min`/`Math.max`), while `activeCell` is where the **drag started**. They differ
  on every drag that went up or left, so the typed character went into one cell while the
  editor mounted on another showing a different value — in **all 8 grids on this hook**.
  The branch now only calls `range.clear()`, which makes it symmetric with the `NAV_KEYS`
  branch above it and matches Google Sheets (the active cell of a selection is the drag
  origin). `anchorId` stays on `GridRangeSlot` — a paste that tiles a block over a
  selection will need it. Guarded by `scripts/verify-grid-keyboard-nav.ts`.
- **Active ring z-scale over frozen panes (CLAUDE.md rule):** the active-cell ring
  must sit at **z-20** so it clears `.frozen-col` (z-10). Frozen cells repaint
  opaquely; never glass. This package keeps `GridCell`/`DatePickerCell` ring at the
  existing inset-ring z; consuming frozen grids are responsible for the z-20 layering
  of the ring over frozen columns.
- **No animation on cells (CLAUDE.md motion rule):** cell selection, the active ring,
  and the edit transition are **static** — no `@keyframes`, no transition on the
  ring/tint/selection. (Row-level hover/`transition-colors` is fine; cell selection
  is not.) The shared cells follow this — do not add transitions to the ring.
- **Focus must never scroll (2026-08-04).** `HTMLElement.focus()` is specified to run
  "scroll an element into view" with block AND inline **`"center"`**, in every
  scrolling box up to the document — and an `overflow-hidden` ancestor is still
  programmatically scrollable, so it counts. `"center"` always computes a target, so
  it fires **even when the element is already fully visible**. In a grid that means a
  purely lateral gesture (click a cell, start an edit) re-centres the row and drags
  the whole page with it. **Every `.focus()` in this package therefore passes
  `{ preventScroll: true }`** — `GridCell`'s fallback mouse-down, both
  `DatePickerCell` fallbacks, and `EditInput`'s autofocus. Focus still moves; only
  the scroll is refused. A new `.focus()` here without the option is a bug.
  - **`EditInput` cannot use React's `autoFocus` attribute.** react-dom's
    `commitMount` implements it as a bare `domElement.focus()` with no options, so
    the prop is unfixable from the outside. `EditInput` keeps the `autoFocus` *prop*
    but honours it with a **ref callback** (`el?.focus({ preventScroll: true })`),
    which lands in the same commit/layout phase `commitMount` would have. Like
    react-dom it calls no `select()` / `setSelectionRange()`, so the caret still
    lands wherever the browser puts it for a freshly focused input — caret and
    selection behaviour are byte-identical to before, and `autoFocus` must stay OFF
    the `<input>` or React re-adds its own unguarded focus on top.
  - Any scroll a grid genuinely wants (following the caret) must be its own, and
    instant (`behavior:'auto'`) — arithmetic on the table scroller's own
    `scrollTop`/`scrollLeft`, or at worst `scrollIntoView({ block:'nearest' })`,
    which is a no-op for an already-visible element. Never `'center'`.
  - **Consumers that pass their own `onCellMouseDown` never reach `GridCell`'s
    fallback** and own their focus calls themselves (they focus the grid wrapper on
    click / commit / revert). Those sites need the same `{ preventScroll: true }`.
- **Context menu:** no Radix (focus-steal); `data-ctx-menu` marks the surface;
  capture-phase outside-mousedown + Escape close it; `open` flips left/up at the
  viewport edge. `hidden` items skip; `disabled` items render dimmed/non-interactive.
- **Toasts:** success/info messages (e.g. "Pasted N rows", "Copied N cells") use
  sonner directly. Any ERROR surface MUST use `errorToast()` from `lib/toast.ts`
  (persist + Copy button). There are no error surfaces in these primitives.

## Dependencies

- `@/lib/utils` (`cn`), `date-fns` (DatePickerCell), `lucide-react` (icons),
  `@/components/ui/dropdown-menu` (SelectCell), `sonner` (paste/copy success toasts).
- Range hooks compose with `use-cell-selection` / `use-clipboard-copy` /
  `use-cell-delete` / `use-cell-aggregation` (unchanged).
- React 19 / Next 16, strict TypeScript.

## See Also

- **`.agents/prompts/universal-table-module.md` — the plan of record for "Blackwood
  Table v2" (2026-08-17).** This package is its starting point: the module being built in
  `lib/table/` + `components/shared/table/` absorbs these primitives and the ~44% of
  `app/(app)/cenapro/deliveries/deliveries-ledger.tsx` that is generic, behind a column
  spec / row model / data-source port. `useGridPaste`, `useClipboardCopy`, `useCellDelete`
  and `GridCell` are slated for **retirement** once no consumer remains — the Cenapro
  deliveries ledger already opted out of the first three because they could not do its
  job. Evidence pack: `docs/universal-table/`.
- Approved plan: `/Users/renzosy/.claude/plans/delightful-popping-grove.md`
  (Blackwood Table consolidation — phased migration; superseded by the prompt above).
- Reference state machine (Phase 1 source): `app/(app)/inventory/rc-in/bulk-delivery-input.tsx`.
- DOM resolver + EditInput source: `app/(app)/cenapro/production/production-daily-block.tsx`.
- Canonical SelectCell/DatePickerCell source + a context menu:
  `app/(app)/cenapro/production/production-ledger-grid.tsx`.
- Context-menu edge-detection source: `app/(app)/inventory/rc-in/delivery-master-table.tsx`.
- Frozen-pane z-scale + motion rules: project `CLAUDE.md`.
