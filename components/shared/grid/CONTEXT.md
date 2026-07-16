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
  otherwise unchanged. Used by the flat coordinate grids.
- **`SelectCell.tsx`** — categorical dropdown cell (DropdownMenu + RadioGroup).
  `value/options/onChange`, optional `renderLabel`/`renderTrigger`, `nullable`
  ("— None"), `placeholder`, `disabled`/`disabledHint`, `align`. Stops propagation
  on mouse/pointer-down so opening never starts a drag. Promoted verbatim from the
  production ledger (the canonical source).
- **`DatePickerCell.tsx`** — native `<input type=date>` overlay (opacity:0) + a
  `formatDateShort` display + calendar icon. `showPicker()` on click when available.
  Also **exports `formatDateShort`** (was a local helper in the ledger — promoted
  here as its single source of truth).
- **`EditInput.tsx`** — the bare inline editor matching static-metric cells exactly
  (no row-height change on edit). `escapedRef` suppresses the blur-commit after
  Escape; placeholder vanishes on focus (Excel-like); `autoFocus` + type-over
  seeding. Also exports the canonical `EDIT_INPUT` class string. Standalone /
  presentational — no domain imports.
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
- **Active ring z-scale over frozen panes (CLAUDE.md rule):** the active-cell ring
  must sit at **z-20** so it clears `.frozen-col` (z-10). Frozen cells repaint
  opaquely; never glass. This package keeps `GridCell`/`DatePickerCell` ring at the
  existing inset-ring z; consuming frozen grids are responsible for the z-20 layering
  of the ring over frozen columns.
- **No animation on cells (CLAUDE.md motion rule):** cell selection, the active ring,
  and the edit transition are **static** — no `@keyframes`, no transition on the
  ring/tint/selection. (Row-level hover/`transition-colors` is fine; cell selection
  is not.) The shared cells follow this — do not add transitions to the ring.
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

- Approved plan: `/Users/renzosy/.claude/plans/delightful-popping-grove.md`
  (Blackwood Table consolidation — phased migration).
- Reference state machine (Phase 1 source): `app/(app)/inventory/rc-in/bulk-delivery-input.tsx`.
- DOM resolver + EditInput source: `app/(app)/cenapro/production/production-daily-block.tsx`.
- Canonical SelectCell/DatePickerCell source + a context menu:
  `app/(app)/cenapro/production/production-ledger-grid.tsx`.
- Context-menu edge-detection source: `app/(app)/inventory/rc-in/delivery-master-table.tsx`.
- Frozen-pane z-scale + motion rules: project `CLAUDE.md`.
