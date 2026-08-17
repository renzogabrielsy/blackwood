# Cenapro RC Deliveries — code audit for the Universal Table extraction

Read-only audit, 2026-08-17. Files read in full: `deliveries-ledger.tsx` (5,494 lines),
`types.ts`, `ledger-url.ts`, `use-deliveries-window.ts`, `actions.ts` (skimmed for the
read/write contract), the eight platform hooks, the five shared grid components,
`components/shared/grid/CONTEXT.md`, `app/(app)/cenapro/deliveries/CONTEXT.md` (1,599
lines), and `scripts/verify-rc-deliveries-cells.ts` (117 checks).

Nothing was edited.

---

## A. BUGS / KINKS

Ordered blocker → cosmetic. "PLATFORM" means the defect lives in `lib/hooks/` or
`components/shared/grid/` and therefore already affects RC IN, RC OUT, Production Daily,
Electricity, Trucks, Summaries and both Cenapro production grids.

### A1 — Typing over a range writes the character into the WRONG cell — BLOCKER, PLATFORM

`lib/hooks/use-grid-keyboard-nav.ts:191-198` (range branch, printable char) and
`:241-247` (the branch that actually starts the edit).

```
// :191  range branch
if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
  const anchor = range.anchorId() as Id | null;
  if (anchor !== null && anchor !== undefined) { range.clear(); setActiveCell(anchor); }
  // fall through to existing char handling below
}
...
// :241  the char handler — `active` was captured at :134, BEFORE setActiveCell(anchor)
if (e.key.length === 1 && ...) { if (resolver.isEditable(active)) { e.preventDefault(); edit.start(active, e.key); } }
```

`range.anchorId()` returns the **normalised top-left** of the rectangle
(`deliveries-ledger.tsx:1524-1527`, and identically `bulk-delivery-input.tsx:371-374`),
not the drag origin. So whenever a drag went **up or left**, `anchor !== active` and the
two branches disagree about which cell is being typed into.

**Repro (30 seconds, ordinary gesture):** drag-select from row 20 / `WT` up-left to
row 15 / `SKS`, then type `5`.
- `edit.start({row:20, col:WT}, '5')` writes `5` into row 20's WT cell — it goes dirty,
  amber, with no editor on it.
- `activeCell` is now `{row:15, col:SKS}`, so `renderCell` mounts the editor there
  (`deliveries-ledger.tsx:2914-2917`) showing SKS's **stored** value — the typed `5` is
  not there.
- The operator's next keystroke lands in the SKS editor. Two cells are now wrong and only
  one is visible.

**Ctrl+A variant:** anchor becomes `{0,0}` = the `#` column, which has `field: null`. An
editor mounts inside the unaddressable `#` cell of row 0, bound to `getCellText({0,0})`
= `''` and to a `setCellText` that no-ops (`deliveries-ledger.tsx:789`). Meanwhile the
previously-active cell silently receives the character.

Fix shape: in the range branch, seed the edit from the anchor (or refuse to fall through)
— one of the two branches has to win, and it must be the same cell in both.

### A2 — Clicking TTL PRICE deadens the keyboard — BLOCKER, TENANT (+ platform contract)

`deliveries-ledger.tsx:2939`:

```
setActiveCell(canEdit ? { row: navRow, col: colIndex } : null);
```

TTL PRICE is `isSelectableColumn` but not `addressable`, so clicking it sets `activeCell`
to `null`. `use-grid-keyboard-nav.ts:133` (`if (activeCell === null) return;`) then makes
the **entire** state machine inert.

**Repro:** click any `TTL PRICE` cell. Press ArrowDown → nothing. Press Escape → the
selection is not cleared (the ledger's Escape branch at `:1653` finds nothing to revert
because `selectedCells()` filters by `addressable`, then falls through to a hook that
returns immediately). Press Delete → `clearSelectedCells()` runs (it is deliberately
outside the `activeRef` guard, `:1680`) but `selectedCells()` returns `[]` for a
single-cell TTL selection, so nothing happens and nothing is said.

The grid is now keyboard-dead until another cell is clicked. The CONTEXT documents the
"hook is inert without an active cell" rule and the "range dragged from TTL PRICE" case,
but the *single click* case is not covered by any of the ledger's own interceptors.

### A3 — `deleteDelivery` has no price gate and returns ₱ — BLOCKER, TENANT (security)

`app/(app)/cenapro/deliveries/actions.ts:1057-1100`. It is the **only** exported action in
the module that never calls `canViewPrices()` (verified: `grep canViewPrices actions.ts`
hits every other fetcher and `saveDeliveries`, not this one). It returns:

- `allocatedPhp`, `releasedPhp`
- `blocking[]` = `{ paymentId, paymentDate, method, chequeNo, amountPhp, allocatedPhp }`

The "Delete receipt…" menu item is **not** inside the `canViewPrices` spread
(`deliveries-ledger.tsx:2264-2299` gates only the two liquidation items; delete is at
`:2321-2330`, outside it). The refusal dialog renders the money verbatim
(`:4118-4140`: `₱{formatBalancePeso(deleteBlocked?.result.allocatedPhp)}` plus one line
per cheque with its number and `₱{formatBalancePeso(p.allocatedPhp)}`), and the success
toast prints `₱{formatBalancePeso(result.releasedPhp)}` (`:2566`).

**Repro:** impersonate Production (navbar shield → Production), open
`/cenapro/deliveries`, right-click a receipt that has a cheque assigned, "Delete
receipt…", confirm. The second dialog names the total and every cheque number and amount.

Two separate problems, both worth deciding: the ₱ disclosure, and the fact that a
Production role can attempt a hard delete of a receipt at all — there is no
`requirePrivileged()` anywhere on this path.

### A4 — A multi-row paste scatters onto moisture sub-rows — BLOCKER, TENANT

`deliveries-ledger.tsx:1769-1805`, specifically `:1783`:

```
if (!isNew && !addressable(targetRow, targetCol)) continue;
```

Block row `r` maps to `navRows[anchor.row + r]` with no regard for the row's **kind**. A
receipt that carries moisture draws contributes extra nav rows between receipts, so a
5-row block copied out of Google Sheets and pasted onto a receipt with 2 draws under it
writes:

- block row 0 → the receipt (all columns)
- block rows 1–2 → the two **draws**, and only their seven lab lanes; DATE, TRK#, SKS,
  WT, WAREHOUSE, REMARKS, PHP/KG of those source rows are silently dropped
- block rows 3–4 → the next two receipts

and the toast says `Pasted 5 rows`. No warning, no count of skipped cells. This is the
single most dangerous behaviour in the file, and it is the exact hazard a universal table
will inherit the moment any consumer has heterogeneous rows.

### A5 — A paste is never validated and never clears an invalid mark — ANNOYING, TENANT

`applyClipboardPaste` (`:1728-1847`) never calls `validateOnCommit` and never touches
`invalidCells`. Consequences:

- An unresolvable supplier or warehouse pasted in shows **no** inline error and **no**
  destructive tint. It is caught only at Save. CONTEXT.md line 812 claims *"an
  unresolvable supplier/warehouse still refuses at commit and again at save"* — the
  commit half does not exist on the paste path, because a paste has no commit.
- An unreadable date is written verbatim (`cleanPastedCell`, `types.ts:1207-1210` returns
  the raw text on error) with no toast.
- A cell already marked invalid keeps its `bg-destructive/15` tint after a *good* value is
  pasted over it, until the operator commits that cell by hand.

### A6 — "Fill MOIST from N draws" bypasses the ONE dirty definition — ANNOYING, TENANT

`deliveries-ledger.tsx:2131-2134`:

```
setEdits((prev) => ({ ...prev, [deliveryId]: { ...(prev[deliveryId] ?? {}), moisture_pct: avg.toFixed(2) } }));
```

This is the only cell write in the file that does not go through `setCellText` →
`mergeFieldEdit`. Two effects: (a) filling a value identical to the stored one still marks
the row dirty; (b) `avg.toFixed(2)` produces `"12.50"` while `canonicalEditText`
(`:5318-5320`) produces `String(12.5)` = `"12.5"`, so the field can **never** compare
equal to canonical and can never drop out of the edit map on its own. Pressing the menu
item and then Escape on that cell will clear it (Escape writes `storedCellText` back), but
the natural "fill, look at it, decide it was already right" path leaves a permanent
unsaved row.

### A7 — Add-then-remove a moisture draw leaves the row permanently dirty — ANNOYING, TENANT

`addSample` (`:2092-2106`) and `removeSample` (`:2108-2116`) write `sampleDrafts[id]`
unconditionally; the `sameDrafts` comparison that drops a clean block exists **only**
inside `setCellText` (`:801-805`). `dirtyIds` (`:625-630`) adds every key of
`sampleDrafts`, so add-a-draw + remove-it leaves the receipt counted as unsaved forever,
Save writes an identical sample block, and the only escape is the context menu's "Discard
changes on this row".

### A8 — `Ctrl/Cmd+A` selects columns the grid says are not selectable — ANNOYING, PLATFORM

`lib/hooks/use-cell-selection.ts:223-231` — `selectAll()` sets the range to
`{0,0}…{rowCount-1, colCount-1}` and never consults `isSelectableColumn`, unlike every
other path in the same file. In this grid that spans `#` (col 0) through `PAID?` (last),
both unselectable.

- Ctrl+A then Ctrl+C emits a **leading and a trailing empty TSV column**
  (`copySelectionToClipboard` iterates the box and `clipboardCellText` returns `''` for a
  non-existent cell, `:1387`).
- `useCellAggregation`'s `count` (`use-cell-aggregation.ts:48`) counts every coordinate in
  the rectangle, so the pill's COUNT over-reports badly.
- Shift+Arrow immediately after Ctrl+A does nothing: focus is parked on the unselectable
  `settle` column, and the skip loop at `use-cell-selection.ts:327-333` uses
  `delta.col !== 0 ? delta.col : 1` — so a **vertical** arrow drifts the column RIGHT,
  walks off the end, and the `if (!isColSelectable(next.col)) return;` at `:337` bails.

### A9 — Ctrl+A → Delete blanks every editable cell of every loaded row, silently — ANNOYING, TENANT

`:1680-1688` → `clearSelectedCells()` → one `setCellText` per addressable cell, each doing
a `setEdits` updater that clones the whole map. On the default ~120-row window that is
~1,800 updaters; after paging back several pages it is thousands, each cloning a map that
is itself growing. **PLAUSIBLE** UI freeze — verify in a browser with ~1,000 rows loaded.
There is no confirmation and no distinct "you are about to blank 1,000 rows" message;
Escape does undo it (the selection is deliberately retained), which is the mitigation.

### A10 — The row context menu takes the caret and never returns it — ANNOYING, TENANT

`GridContextMenu` is rendered outside `gridRef` (`:4011`, a sibling of the grid wrapper).
Clicking a menu item moves focus out of the wrapper → `onBlur` at `:3877` sets
`activeCell` to `null` → the orphan-focus effect at `:1050-1055` refuses to run (it
requires `activeCell !== null`) → after the menu closes, focus is on a removed `<button>`
and then `document.body`. The grid is keyboard-dead and paste-dead until a cell is
clicked. The history dialog already solved exactly this with `onClosed={focusGrid}`
(`:4101`); `menu.close` has no equivalent.

### A11 — Opening a column-filter popover drops the caret the same way — ANNOYING, TENANT

Radix portals `PopoverContent` out of the grid, so the same `:3877` blur nulls
`activeCell`. Cancelling the popover leaves the sheet with no active cell and no way back
except a click. (`isGridChrome` correctly stops the popover from *swallowing* keystrokes;
it does nothing about focus restoration.)

### A12 — `handleSave` can return `false` with no message, and unsaved work can strand — ANNOYING, TENANT

`:2370-2372` skips any dirty id not present in `recordsById` (`if (!rec) continue;`),
`:2440` collects those into `stranded`, and `:2507` returns
`failed.length === 0 && stranded.length === 0`. Nothing is ever said about a stranded row —
the operator sees "Saved N receipts" and "Save and continue" silently refuses to navigate.

Reachable path: a batch containing both a draft insert and an edit that comes back
`version_conflict`. The insert succeeds → `win.reset({kind:'latest'})` at `:2503` replaces
the whole window → the conflicted row is no longer in `recordsById` → its entry stays in
`edits` forever, the "N unsaved" chip counts a row that is not on screen, Save can never
send it again, and the only exits are the axis guard's *Discard N changes* or a page
reload.

### A13 — `firstItemIndex` is decremented by RECORDS while `items` grows by more — ANNOYING, PLATFORM

`use-deliveries-window.ts:129`: `setFirstItemIndex((prev) => prev - fresh.length)`.
`fresh` counts **receipts**; the rendered `items` array grows by receipts + their sample
sub-rows + one day-spacer per day boundary (`deliveries-ledger.tsx:5110-5141`).

This is now provable from the library rather than inferred. `node_modules/react-virtuoso/
dist/index.mjs:876-890`:

```
Ot((u, g) => ({ diff: u.prev - g, prev: g }), { diff: 0, prev: 0 }),
...
if (u > 0) { M(e, !0), M(s, u + Sn(u, g)); }   // firstItemIndex DECREASED → unshiftWith(diff)
else if (u < 0) { ... M(i, u); }                // firstItemIndex INCREASED → shiftWith(diff)
```

The prepend compensation is driven **entirely** by the `firstItemIndex` delta, so the
scroll adjustment is short by the height of every sample row and every spacer in the
prepended page — the viewport jumps upward on each backward page. CONTEXT.md already flags
this as a known approximation; this is the confirmation and the exact mechanism.

### A14 — `reset()` / `refreshWindow()` push `firstItemIndex` back UP — ANNOYING, PLATFORM

`use-deliveries-window.ts:187` and `:272` both `setFirstItemIndex(FIRST_ITEM_BASE)` after
`fetchOlder` may have decremented it. Per the stream above, an increase is a **negative
diff** → `shiftWith(-n)`, i.e. virtuoso is told *n* items were removed from the front and
adjusts `scrollTop` accordingly, even though the entire dataset was replaced.
**PLAUSIBLE** scroll jump. Repro: in `?scope=endless`, scroll up until two "Loading
earlier receipts…" pages have landed, edit one cell, Save, and watch the scroll position.

### A15 — A draft cell typed to exactly the seeded date looks untouched — COSMETIC, TENANT

`:3325` keys the muted style off `e[field] === undefined`, and `mergeFieldEdit` deletes the
field when the text equals `draftCanonical` (= the seed). So an operator who deliberately
types the seeded date sees the cell stay grey and the row stay non-dirty — indistinguishable
from not having typed at all.

### A16 — `draftDefaultDate` moves under the operator — COSMETIC, TENANT

`:609-616` derives it from the newest dated record in the window. A background
`fetchNewer` / `refreshWindow` can change it, which silently changes what every untouched
draft's DATE cell displays **and** changes what counts as "typed back to canonical" for
`mergeFieldEdit`.

### A17 — `written++` counts writes that were immediately dropped — COSMETIC, TENANT

`:1801` increments unconditionally, including when `mergeFieldEdit` deleted the field
because the pasted value equalled canonical. `Pasted N rows` can therefore claim rows
where nothing changed.

### A18 — Right-click does not select the cell — COSMETIC, TENANT

`:2933` (`if (!exists || e.button !== 0) return;`) bails on button 2, so the context menu
can act on a row while the selection sits somewhere else entirely. Sheets selects the cell
under a right-click. This is what makes "Record a cheque for these N…" (`:2286-2296`) need
its defensive `selectedDeliveryIds.includes(ref.deliveryId)` check.

### A19 — Clicking a cell that does not exist is a dead click — COSMETIC, TENANT

Same guard at `:2933`. Clicking the `#` lane, a moisture draw's DATE / WT / REMARKS, or
the `PAID?` column does nothing at all — no caret move, no `focusGrid()`, no selection
change. In a sheet, every click lands somewhere.

### A20 — Escape while editing reverts twice — COSMETIC, PLATFORM

`components/shared/grid/EditInput.tsx:96` calls `onEscape()` (→ `edit.revertChanges`) and
blurs; the event then bubbles to the wrapper, where `use-grid-keyboard-nav.ts:140-145`
calls `edit.revert()` again. Idempotent today because `revertChanges` just re-writes the
same snapshot — but it means "revert" is not a single-shot operation, which is exactly the
assumption a future undo stack would break on.

### A21 — A bare integer typed into DATE becomes a 1900 Excel serial — COSMETIC

`types.ts:1080` → `lib/paste-utils.ts:114-116` → `parseExcelDate`'s serial branch. `5`
becomes `1900-01-05`, passes `isIsoDate`, and saves. Sheets does the same thing with a
date-formatted cell, so this may be parity rather than a bug — but on a payment ledger it
deserves an explicit decision.

### A22 — `import_flags[].raw` is outside the ₱ boundary — LOW CONFIDENCE

`FlagPopover` (`:4835-4839`) prints the workbook's original text verbatim to every role.
`import_flags` / `import_flags_state` are deliberately **not** in `PRICE_FIELDS`
(`types.ts:164-172`) and are not touched by `redactAuditJson`. Today's flag kinds appear
to be supplier / warehouse / date only, so there is nothing to leak — but the boundary
rests on that being true forever. Worth one sentence in CONTEXT.md, or a `raw` redaction
for any future price-bearing flag kind.

### Reuse hazards — what breaks for a table with a different row shape

These are not bugs today; they are the places the code asserts *this* schema and will fail
to compile or silently misbehave for another consumer.

| Site | Hard-coded fact |
|---|---|
| `deliveries-ledger.tsx:239-242` `NavRow` | a closed union of `delivery` \| `sample` \| `draft` |
| `:376-383` `ROW_RULE` | `Record<NavRow['kind'], string>` — a new kind is a compile error in two files |
| `:715-723` `cellExists` | `cols[col]?.key === 'ttl' && navRows[row]?.kind === 'delivery'` |
| `:1300-1315` `getNumericCellValue` | a `switch` over `sacks/wt/bd/moist/…/php_kg/ttl` |
| `:1392-1406` `clipboardCellText` | `c.key === 'ttl'`, `field === 'price'`, `field === 'wt'` |
| `:1782` paste | `field === 'price' && !canViewPrices` |
| `types.ts:587-607` `summarySpans` | the literal keys `'wt'` and `'ttl'` |
| `types.ts:373-412` `frozenOffsets` / `frozenBlockWidth` | the frozen block is a **prefix** (`break` on the first non-frozen column) — a right-pinned column is inexpressible |
| `types.ts:667-685` `columnCalcType` | a `switch` over domain column keys |
| `types.ts:693-695` `isSelectableColumn` | `col.field !== null \|\| col.key === 'ttl'` |
| `types.ts:808-814` `sampleFieldFor` | "the sub-row's label rides in the SUPPLIER lane" |
| `:891-905` `contextYearFor` / `:619-623` `fallbackYear` | a date-domain concept threaded through the generic paste and edit paths |

---

## B. GOOGLE SHEETS PARITY

`✓` = present and behaves as Sheets does. `~` = present but different. `✗` = absent.

| Behaviour | Google Sheets | This ledger | Gap? | Diff | Notes |
|---|---|---|---|---|---|
| Click = select | selects, no editor | same (`:2932-2948`) | ✓ | — | except non-existent cells swallow the click (A19) |
| Type printable = type-over | replaces value, opens editor | same (`use-grid-keyboard-nav.ts:241-247`) | ✓ | — | **but see A1** — wrong cell over a range |
| Enter (not editing) | opens the editor | same (`:1662-1667`) — deliberate departure from Excel | ✓ | — | documented decision |
| F2 | opens the editor, keeps value | same (`:228-231`) | ✓ | — | |
| Double-click | opens the editor | same (`:2950-2955`) | ✓ | — | |
| Enter while editing | commit + move down | same (`:146-154` → `vertical(+1)`) | ✓ | — | |
| Shift+Enter while editing | commit + move up | same | ✓ | — | |
| Tab / Shift+Tab | commit + move right/left, wrap rows | same (`tabStep`, `:4969-4985`) | ✓ | — | wraps to next/prev row; does not wrap the whole sheet |
| Tab-run then Enter returns to the lane | yes | yes (`enableEnterAnchor: true`, `:1571`) | ✓ | — | |
| Arrows (not editing) | move one cell, skip nothing | same (`:4987-5003`), skipping cells the row does not have | ~ | — | the asymmetry is deliberate: ArrowDown in WT walks receipt-to-receipt, in MOIST walks every draw |
| Ctrl/Cmd+Arrow → jump to data edge | yes | **behaves as a plain arrow** (`NAV_KEYS` matches before any modifier test, `:203`) | ✗ | M | needs an "is this cell blank" probe per column |
| Home / End | row start / row end | unhandled | ✗ | S | |
| Ctrl+Home / Ctrl+End | sheet corners | unhandled | ✗ | S | `Ctrl+End` in an endless keyset pager means "the newest loaded row", not the last row of history — needs a decision |
| PageUp / PageDown | viewport-height jump | unhandled | ✗ | M | needs the scroller's `clientHeight`; `scrollerEl()` already provides it |
| Shift+click | extend the rectangle | same (`:2937` passes the event; `use-cell-selection.ts:241-244`) | ✓ | — | |
| Shift+Arrow | extend the rectangle | same (`:207-216` seeds, `:163-166` extends) | ✓ | — | the (0,0) race was fixed 2026-08-05 |
| Drag = rectangle | yes | same, with edge auto-scroll | ✓ | — | |
| Ctrl/Cmd+A | select all cells | selects all **columns including unselectable ones** | ~ | S | A8 |
| Click the row number = select the row | yes | ✗ — `#` is unselectable and swallows the click | ✗ | M | the range model can already express a full row; only the affordance is missing |
| Click a column header = select the column | yes | ✗ — headers only host filter triggers | ✗ | M | same |
| Shift+Space / Ctrl+Space (row / column) | yes | ✗ | ✗ | S | trivial once the row/column selection primitive exists |
| Delete / Backspace clears without an editor, keeps the selection | yes | same (`:1680-1688`) — the ledger intercepts ahead of the platform hook precisely for this | ✓ | — | one of this ledger's best decisions |
| Escape while editing = revert | yes | same (`:140-145`) | ✓ | — | fires twice (A20) |
| Escape not editing = undo | Sheets deselects; there is no "undo" on Escape | **undoes the unsaved edits under the selection**, then deselects | ~ | — | deliberate, and better than Sheets given Delete opens no editor |
| **Undo / redo stack** (Ctrl+Z, Ctrl+Y, Cmd+Shift+Z) across edits, clears, pastes | full multi-level history | **absent entirely.** Escape is a one-shot revert-to-stored of the *current selection only* | ✗ | **L** | the single biggest parity gap. Today five code paths mutate cell state directly (`setCellText`, `fillMoistureFromSamples`, `addSample`/`removeSample`, `applyClipboardPaste`'s `setDraftEdits`, `clearDraftRow`), so a journal has to be introduced at a chokepoint that does not exist yet |
| Ctrl+X (cut) | copy + clear | ✗ | ✗ | S | both halves already exist (`copySelectionToClipboard` + `clearSelectedCells`) |
| Ctrl+C — single cell | yes | yes (`:1634-1638`, intercepted ahead of the platform hook) | ✓ | — | |
| Ctrl+C — range as TSV | yes | yes, with `tsvEscape` quoting and DB-exact decimals | ✓ | — | genuinely better than the platform `useClipboardCopy`, which emits display text unescaped |
| Ctrl+V — block at the anchor | yes | yes (`applyClipboardPaste`) | ✓ | — | but see A4 (scatters onto sub-rows) |
| Ctrl+V — **single value onto a selected range fills every cell** | yes | ✗ — the loop iterates the **block**, not the target range (`:1769-1776`), so a 1×1 clipboard writes exactly one cell | ✗ | **S** | high value / low cost; the single most-missed Sheets habit |
| Ctrl+V — block taller than the sheet creates rows | yes | yes, via `planPaste` + `makeDraftIds` | ✓ | — | capped at `MAX_DRAFT_ADD = 500`, and the overflow is *reported* |
| Ctrl+V — block wider than the sheet | Sheets adds columns | reported as an error, never added | ~ | — | correct for a schema-backed table |
| Fill handle (drag the little square) | yes | ✗ | ✗ | M | |
| Ctrl+D fill-down / Ctrl+R fill-right | yes | ✗ | ✗ | S | S once the "iterate the target range" primitive from the single-value paste exists |
| Drag-select auto-scroll | yes | yes (`:1209-1243`), with the frozen block treated as a wall | ✓ | — | better than the platform hook, which is inert here |
| Context menu — copy | yes | "Copy row as TSV" (whole row only, not the selection) | ~ | S | |
| Context menu — paste | yes | ✗ | ✗ | S | blocked by the browser clipboard-read permission, not by this code |
| Context menu — delete row | yes | "Delete receipt…" (a real DB delete, with the allocation warning) | ✓ | — | |
| Context menu — clear row | "Clear contents" | "Discard changes on this row" (reverts to **stored**) / "Clear this new row" | ~ | S | there is no way to blank a saved receipt's cells from the menu |
| Context menu — insert row above / below | yes | ✗ — only "Add moisture draw" | ✗ | L | the sheet's order is the server's canonical `(delivery_date, id)`; "above" has no meaning. Needs a product decision, not code |
| Column resize by dragging the header edge | yes | ✗ — fixed pixel widths in `BASE_COLS` (`types.ts:271-328`), emitted through a `<colgroup>` (`:3546-3552`) | ✗ | M | `user_table_settings` already exists to persist per-user widths |
| Column reorder | yes | ✗ | ✗ | M–L | `minTableWidth` / `frozenOffsets` / `summarySpans` all walk the array in order, so reorder must not move a frozen column out of the prefix |
| Freeze panes | user-configurable | fixed: `# · DATE · TRK# · SUPPLIER` (424px) | ~ | M | the geometry helpers assume a **prefix** (A-table above) |
| Per-column filter | yes, client-side | yes, **pushed into SQL** (12 columns) with URL state and a chip row | ✓ | — | better than Sheets: honest over the whole matching set, not the loaded window |
| Per-column sort | yes | ✗ — order is always canonical `(delivery_date, id)` | ✗ | M–L | a different sort breaks the keyset cursor, which is expressed in that ordering — exactly why the duplicate lens does not page at all (`actions.ts:359-373`) |
| Find (Ctrl+F) | in-sheet find/next with highlight | a toolbar **search** that re-queries the server over 8 columns; Ctrl+F falls through to the browser's find, which only sees the ~40 virtualised rows in the DOM | ~ | M | |
| Cell number formatting | user-settable per cell | fixed per column (`formatKg`/`formatPeso`/`formatRate`/`formatLab` + `labDecimals`) | ~ | — | correct for a schema-backed table |
| Multi-cell aggregate pill (SUM/AVG/COUNT/MIN/MAX) | status bar | yes, via `useCellAggregation` + the shared `FloatingStatusBar`, with per-column defaults (SUM for SKS/WT/TTL, AVERAGE for the labs and PHP/KG) | ✓ | — | `count` over-reports on heterogeneous rows (A8) |
| Typing a date loosely and having it transcribed | yes | yes — `parseDeliveryDate` on commit and on paste, same context year for both | ✓ | — | and it **refuses** unreadable text rather than storing a guess |
| Formulas (`=` cells) | full formula language | `WT` and `PHP/KG` only, via `lib/cenapro/rc-formula.ts` (recursive descent, no `eval`); `=` in any other column is stored as literal text | ~ | — | deliberate and correct; a general formula engine is out of scope |

---

## C. EXTRACTION ASSESSMENT

### C.1 Responsibility classification

**(1) GENERIC — belongs in the platform-layer universal table**

| Responsibility | Where it lives today |
|---|---|
| Frozen-pane geometry (offsets, block width, edge, corner) | `types.ts:373-412`, `deliveries-ledger.tsx:2868-2894` |
| "Never crush, always scroll" min-width + `<colgroup>` | `types.ts:384-386`, `:3546-3552` |
| The cell shell — `absolute inset-0`, one `bg-*` by explicit ternary, `z-20` ring over `z-10` frozen, per-row-family `border-b` on the `<td>` | `:2841-2962` (`renderCell`) |
| Per-cell nav resolver (rowStep / tabStep / vertical) | `:4958-5015` |
| Keyboard wiring, Enter-anchor, select≠edit, Escape's two meanings, Delete-keeps-selection | `:1616-1696` + `use-grid-keyboard-nav.ts` |
| Edit session + pre-edit snapshot | `use-grid-edit-session.ts` |
| Rectangular selection, drag, Shift+click, Shift+Arrow, select-all | `use-cell-selection.ts` |
| Aggregate pill plumbing (debounce, unmount reset) | `:1325-1350` |
| Clipboard exchange — `parseClipboardTable` / `tsvEscape` / `clipboardNumber` / `planPaste` | `types.ts:1127-1259` |
| Copy (`copySelectionToClipboard`), paste (`applyClipboardPaste` minus the field switch), clear, revert-to-stored | `:1418-1541`, `:1728-1847` |
| **The paste sink** and the document-level fallback, with both interlocks | `:299-331`, `:1869-1950`, `isGridChrome` `:5232-5239` |
| `focusGrid()` + the `{preventScroll:true}` discipline + the orphan-focus effect | `:502-505`, `:1050-1055` |
| Caret-follow on both axes (`scrollTo`, `scrollToCol`, `columnScrollLeft`) | `:1079-1164`, `types.ts:441-464` |
| Drag auto-scroll with the frozen block as a wall | `:1209-1243`, `types.ts:512-530` |
| Draft rows: ids, `showDrafts`, `MAX_DRAFT_ADD`, the "Add N more rows" control | `:598-600`, `:2171-2174`, `:3349-3378`, `types.ts:1367-1375` |
| Dirty tracking (`mergeFieldEdit`, `isDirtyFieldEdits`, `countUnsavedWork`, `describeUnsavedWork`) | `types.ts:1264-1355` |
| `invalidCells` keyed by `<rowKey>:<colKey>` (never by index) | `:557`, `:873-925` |
| The axis guard (`requestAxisChange`, the three exits, `beforeunload`) | `:2614-2781` |
| Virtuoso plumbing (`Scroller`/`Table`/`TableHead`/`TableRow`, the `context` strip, the RAW-in/PUBLIC-out index rule) | `:4879-4938` |
| Keyset window hook (`fetchOlder`/`fetchNewer`/`reset`/`refreshWindow`/`dropRecord`, `firstItemIndex` ownership) | `use-deliveries-window.ts` |
| Summary-row span arithmetic (the *mechanism*, not the lane names) | `types.ts:587-607` |
| Grouping spacer (`needsDaySpacer` + a non-addressable full-height row) | `types.ts:653-656`, `:3398-3421` |
| Per-column filter **grammar** (parse/serialize/describe/predicates) and the popover shell | `ledger-url.ts:159-392`, `:4290-4621` |
| Context-menu state + declarative items | `use-grid-context-menu.ts`, `GridContextMenu.tsx` |
| Save orchestration *shape* — validate-all-first, one bad cell blocks the batch, a per-row verdict, `Promise<boolean>` | `:2363-2515` |

**(2) TENANT / DOMAIN — stays in the consuming module**

`parseSupplierCell` / `formatSupplierCell` / `parseDestinationCell` /
`formatDestinationCell` (`types.ts:848-962`) · the formula round-trip `weightEditText` /
`priceEditText` and `lib/cenapro/rc-formula` · `canonicalEditText` (`:5303-5322`) ·
`buildPatch` (`:5353-5490`) · `weightTitle` / `priceTitle` · `deliveryCells` /
`sampleCells` / `draftCells` (`:2965-3337`) · the `PAID?` settlement cell and everything
it imports from `../liquidation` · the three liquidation doors (`:1984-2079`, `:2264-2299`,
`:4172-4216`) · `DuplicatePeerPopover` and `FlagPopover` (`:4636-4857`) · `rowIssues` /
`flagSummary` / `duplicateBadge` / `readImportFlags` · `railClass` (`:408-414`) ·
day-heading text and the `Σ DAY TOTAL` / month-footer *figures* · the four issue lenses ·
the price boundary (`PRICE_FIELDS`, `stripPrices`, `redactAuditJson`) · `rowLabel` /
`draftLabel` · `sampleFieldFor`'s "label rides in the SUPPLIER lane".

**(3) ENTANGLED — generic behaviour that hard-codes domain facts**

| Line | What it hard-codes | Why it matters |
|---|---|---|
| `types.ts:271-328` `BASE_COLS` frozen block | 4 columns, 424px, and the assumption that frozen columns are a **prefix** | `frozenOffsets`/`frozenBlockWidth` both `break` on the first non-frozen column (`types.ts:376-381`, `:407-411`); a right-pinned column is inexpressible |
| `types.ts:693-695` `isSelectableColumn` | `col.field !== null \|\| col.key === 'ttl'` | "read-only but summable" is a real generic concept wearing a column key |
| `types.ts:667-685` `columnCalcType` | a switch over 11 domain keys | belongs on the column spec as `calcType` |
| `types.ts:587-607` `summarySpans` | the literal keys `'wt'` and `'ttl'` | the *mechanism* (derive lanes from the column table) is generic; the lane identities are not |
| `types.ts:808-814` `sampleFieldFor` | which columns a sub-row occupies | this is the whole "row shape" concept, expressed as one domain function |
| `:239-242` `NavRow` + `:376-383` `ROW_RULE` | a closed union of three kinds | a `Record<Kind, string>` over a closed union means a 4th kind is a compile error in two files |
| `:689-723` `addressable` / `cellExists` | `nav.kind === 'sample'`, `cols[col]?.key === 'ttl'` | the addressability predicate is generic; its body is not |
| `:1285-1318` `getNumericCellValue` | a switch over domain keys + `canViewPrices` | belongs on the column spec as `numericValue(row)` |
| `:1382-1410` `clipboardCellText` | `c.key === 'ttl'`, `field === 'price'`, `field === 'wt'` | "copy the stored value, not the edit text" is generic; which columns those are is not |
| `:1782` paste | `field === 'price' && !canViewPrices` | a per-column `writable(ctx)` predicate would express it |
| `:891-905` `contextYearFor`, `:619-623` `fallbackYear` | a date-domain notion threaded through the generic paste and edit paths | the generic form is "a per-cell parse **context**", not "a year" |
| `:2087-2090` menu flip height `330 / 252` | a hand-counted item height | should be measured, not asserted |
| `:1963-1966` `refreshSettlement` | a domain refresh wired into the generic post-write path | |

### C.2 THE SEAM — what a data-agnostic port looks like

Three contracts. Nothing below mentions charcoal, pesos, suppliers or dates.

**1. Column spec** — the single source the geometry, keyboard, clipboard, filters, pill
and summary rows all read (today split across `DeliveryCol`, `columnCalcType`,
`isSelectableColumn`, `getNumericCellValue`, `clipboardCellText` and `cleanPastedCell`).

```ts
interface ColumnSpec<Row, Ctx> {
  key: string;                 // stable, used in URL params and invalidCells keys
  label: string;
  title?: string;
  width: number;               // px — no 1fr, ever
  align: 'left' | 'right' | 'center';
  pin?: 'start' | 'end';       // replaces `frozen: true`; both ends expressible
  cellKind: 'text' | 'number' | 'date' | 'select' | 'formula' | 'readonly' | 'derived';

  // display / edit round trip
  format(row: Row, ctx: Ctx): React.ReactNode;
  editText(row: Row, ctx: Ctx): string;                 // what the cell shows on FOCUS
  parse(text: string, ctx: Ctx): Ok<Patch> | { error: string };  // the ONE commit verdict

  // capabilities, not column names
  editable?: (row: Row, ctx: Ctx) => boolean;           // subsumes `field === 'price' && !canViewPrices`
  selectable?: boolean;                                 // may a RANGE cover it (subsumes `|| key === 'ttl'`)
  numericValue?: (row: Row) => number | null;           // the pill (subsumes getNumericCellValue)
  clipboardValue?: (row: Row) => string;                // stored value, not edit text
  cleanPasted?: (raw: string, ctx: Ctx) => string;
  calcType?: 'SUM' | 'AVERAGE';
  filter?: { kind: 'set'|'text'|'range'|'dateRange'; column: string };
  summaryLane?: 'label' | 'figure' | 'note' | 'total';  // replaces summarySpans' 'wt'/'ttl'
}
```

**2. Row model** — the thing `NavRow` / `LedgerItem` / `ROW_RULE` / `sampleFieldFor` are
each half of.

```ts
interface RowKind<Row> {
  kind: string;                                  // open, not a closed union
  height: number;                                // ROW_H / SAMPLE_ROW_H / DAY_SPACER_ROW_H
  rule: string;                                  // the border-b weight (ROW_RULE, keyed by kind)
  /** THE row-shape question, asked once: which column does this row occupy, and as what? */
  occupies(colKey: string): { as: string } | null;   // null ⇒ the cell does not exist
  addressable: boolean;                          // does the keyboard see this row at all
}

type GridRow<Row> =
  | { kind: string; id: string; data: Row; children?: GridRow<Row>[] }   // records + sub-rows
  | { kind: 'draft'; id: string }
  | { kind: 'spacer' | 'group-header' | 'summary'; key: string };        // never addressable
```

`occupies()` is the seam that makes A4 fixable: a paste can ask *"is the target row the
same kind as the block's source?"* instead of silently writing into whatever nav row the
arithmetic landed on.

**3. Data-source adapter** — the Grafana-style port. The grid never imports Supabase.

```ts
interface GridDataSource<Row, Cursor, Lens> {
  fetchWindow(req: { anchor?: Anchor; cursor?: Cursor; direction?: 'older'|'newer'; lens: Lens }):
    Promise<{ rows: Row[]; hasOlder: boolean; hasNewer: boolean; totalCount?: number|null; notice?: string; error?: string }>;
  saveBatch(inputs: SaveInput[]): Promise<{ results: SaveVerdict[]; savedCount: number }>;
  deleteRow?(id: string, expectedVersion: number, opts?: unknown): Promise<DeleteVerdict>;
  dimensions?(): Promise<Record<string, {code:string; label:string}[]>>;  // feeds `set` filters
  cursorOf(row: Row): Cursor;
  identityOf(row: Row): { id: string; version: number | null };
}
```

**Hooks the module would export**

- `useGridColumns(specs, ctx)` → `{ cols, offsets, pinnedWidth, minWidth, summarySpans }`
- `useGridRows(rows, rowKinds, drafts, grouping)` → `{ items, navRows, placeById, addressable, cellExists }`
- `useGridEdits(specs, rows, rowKinds)` → `{ getCellText, setCellText, storedCellText, dirtyIds, dirtyDraftIds, unsaved, invalidCells, markInvalid, revertSelection, clearSelection }`
- `useGridInteraction(...)` → the whole keyboard + selection + clipboard + paste-sink + caret-follow bundle, returning `{ onKeyDown, onPaste, activeCell, sinkProps, gridProps }`
- `useGridWindow(dataSource, initial, lens)` → today's `useDeliveriesWindow`, generalised
- `useGridAxisGuard(unsaved, save)` → `requestAxisChange` + the prompt
- `<BlackwoodTable …>` → the container (virtuoso or plain), header, colgroup, frozen panes, summary rows, floating pill

**What cannot be made generic without a redesign**

1. **The keyset cursor is welded to one ORDER BY.** `keysetPredicate`
   (`actions.ts:100-111`) hard-codes `(delivery_date, id)` including the NULLS-FIRST group.
   Any user-chosen sort needs a cursor expressed in that sort — which is exactly why the
   duplicate lens abandons paging entirely (`actions.ts:359-373`). A generic "sortable
   endless table" is a data-layer redesign, not a UI one.
2. **The formula cells.** `WT`/`PHP/KG` show a formula on focus and a value on blur, and
   the *DB* computes the result. The generic form is a `cellKind: 'formula'` with an
   injected engine, but the "one cell → three columns, DB-generated fourth" pattern is
   irreducibly domain-shaped.
3. **One cell → several DB columns** (`parseSupplierCell`, `parseDestinationCell`). The
   port can express it as `parse(): Patch` returning multiple keys — but the *refusal*
   semantics (validated at commit, again at save, one bad cell blocks the batch) have to
   be part of the generic contract or they will be re-invented per consumer.
4. **`stripPrices` / `redactAuditJson` / `PRICE_FIELDS`.** Field-level visibility is a
   **server** boundary; the grid can only be told "this column does not exist for you".
   Keep it that way — `buildColumns(canViewPrices)` omitting columns is the right shape and
   should become `specs.filter(s => s.visible(ctx))`.
5. **Undo.** There is no undo stack to extract because there is none. Building one is the
   only item on this list that is genuinely new construction.

### C.3 Size / shape

- **`deliveries-ledger.tsx`: 5,494 lines**, one exported component + 8 module-level
  sub-components/helpers.
- **Hooks:** 21 `useState`, 24 `useMemo`, 52 `useCallback`, 11 `useRef`, 6 `useEffect`
  (**114 inline hook calls**) plus 11 imported hooks (`useRouter`, `usePathname`,
  `useSearchParams`, `useTransition`, `useStatusBar`, `useGridContextMenu`,
  `useGridEditSession`, `useGridKeyboardNav`, `useCellSelection`, `useCellAggregation`,
  `useDeliveriesWindow`). All 114 live inside **one** component function — that alone is
  the case for extraction.
- **Rough split** (by line ranges, comments counted with the code they document):
  - **GENERIC ≈ 2,400 lines (~44%)** — `:299-418` (sink, cell geometry, row rules),
    `:465-524`, `:662-736`, `:1011-1350`, `:1352-1541`, `:1543-1696`, `:1698-1950`,
    `:2579-2811`, `:2813-2962`, `:3339-3421` + `:3483-3620`, `:4221-4268`, `:4859-4938`,
    `:4940-5015`, `:5017-5164` (minus the totals), `:5175-5239`.
  - **TENANT ≈ 1,900 lines (~35%)** — `:74-104` + the liquidation blocks `:1952-2079` and
    `:2253-2299`, `:2964-3337` (the three cell renderers), `:3422-3481` (day totals),
    `:4623-4857` (both popovers), `:5241-5490` (`canonicalEditText`, titles, `buildPatch`).
  - **ENTANGLED ≈ 1,150 lines (~21%)** — `:737-1010` (cell text + validation: generic
    machinery, domain switches), `:2081-2336` (menu: generic shell, domain items),
    `:2338-2577` (save/delete: generic sequencing, domain payload), `:3623-4219` (render:
    generic layout, domain toolbar), `:4270-4621` (filters: generic grammar, domain
    dimensions).
- `types.ts` (1,951 lines) is roughly **55% already-generic pure helpers** (geometry,
  clipboard, paste plan, dirty tracking, spans, spacer, formatters) and 45% domain
  (supplier/destination parsing, flags, duplicates, audit vocabulary, price boundary). It
  is the best-factored file in the module and the natural donor for the platform package.
- `scripts/verify-rc-deliveries-cells.ts` (2,622 lines, 117 checks) already asserts the
  generic half without a browser. **Its assertions are the acceptance test for the
  extraction** — if the platform module can satisfy them unchanged, the seam is right.

---

## D. TOP-10 PRIORITY LIST

1. **Fix A1 (type-over-a-range writes the wrong cell) in `use-grid-keyboard-nav.ts`.**
   It silently corrupts a cell the operator is not looking at, on an everyday gesture, in
   every grid in the app.
2. **Fix A3 (`deleteDelivery` has no `canViewPrices()` gate and returns ₱ + cheque
   numbers).** It is the only hole in an otherwise carefully-built price boundary, and it
   is a security bug, not a UX one. Decide the role gate on delete at the same time.
3. **Fix A4 (multi-row paste scatters onto sub-rows).** It writes wrong data into real
   receipts and reports success — and it is the exact behaviour a universal table will
   propagate to every future consumer with heterogeneous rows.
4. **Fix A2 (clicking TTL PRICE deadens the keyboard) and A10/A11 (the context menu and
   filter popovers drop the caret).** Three symptoms of one missing rule: *the grid must
   always own a caret and always get focus back.* Decide it once, in the port.
5. **Decide the undo model before extracting anything.** Escape-reverts-the-selection is a
   good one-shot, but the universal table needs a real Ctrl+Z, and that requires every
   mutation to funnel through one journalled writer — which A6 and A7 prove does not exist
   today. Retrofitting a journal after five consumers have their own write paths is the
   expensive version of this decision.
6. **Add "a single copied value fills the selected range" + Ctrl+D / Ctrl+R + Ctrl+X.**
   Three of the most-used Sheets habits, all S-sized, all sharing one new primitive
   ("iterate the target range instead of the source block") that the paste code does not
   have yet.
7. **Make `isSelectableColumn`, `columnCalcType`, `getNumericCellValue`,
   `clipboardCellText` and `cleanPastedCell` into fields on the column spec.** Five
   switches over the same domain keys, in five files, is the single clearest extraction
   win — and it is what unblocks A2 (`selectable` + `readonly` become declarative rather
   than a `key === 'ttl'` special case).
8. **Generalise the frozen block to `pin: 'start' | 'end'`** and stop assuming it is a
   prefix (`frozenOffsets`/`frozenBlockWidth` both `break` on the first non-frozen
   column). Every downstream consumer — caret-follow, drag auto-scroll, the footer corner,
   `summarySpans` — reads that assumption, so it has to change before the first grid that
   wants a pinned action column arrives.
9. **Fix the virtuoso prepend accounting (A13/A14).** `firstItemIndex` must move by the
   number of **items** prepended, and a reset must not push it back up. It is a small
   change in `use-deliveries-window.ts` and it is load-bearing for any universal table with
   sub-rows or group spacers.
10. **Close the small dirty-state leaks (A6, A7, A12) and clear `invalidCells` on paste
    (A5).** They are cheap individually, but each one is a *second definition* of "dirty"
    or "valid" — and the module's whole design rests on there being exactly one. Fix them
    before they get copied into the platform package.
