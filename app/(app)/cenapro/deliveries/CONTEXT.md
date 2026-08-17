# RC Deliveries (`/cenapro/deliveries`) — CONTEXT.md

## Purpose

Cenapro's **raw-charcoal receipt ledger** — the operators' "RC 2026" Excel sheet as a
live grid. It is the Cenapro analogue of ICTC's RC IN (`public.deliveries`), built to
the **QC Ledger's interaction standard** on the platform's **Blackwood Table**
primitives.

**971 receipts** + 244 moisture sub-samples are loaded (see the parent `../CONTEXT.md` →
"RC Deliveries" → **"Live state"** for the full live/import-day table). 991 came in from
the workbook and were reconciled to the centavo against it; the **22 duplicates were
hard-DELETEd on 2026-08-04** (₱17,185,938.70) and **2 receipts have since been created in
the app** — so `provenance` is now 969 `sheet_import` + 2 `app`, and **13 rows sit at
`row_version > 1`**. This module is the UI on top of that. Since 2026-08-05 every write
here is trailed in `cenapro.rc_delivery_audit`, and each receipt's own trail is readable
from the row context menu (*View history*) — see "Audit trail" below.

**The feature this exists to support is liquidation** (assigning cheques and payments to
receipts). That is why the money columns are decomposed rather than opaque, why an
unresolvable supplier is refused rather than stored, and why `TTL PRICE` is never
computed in the browser.

**Since 2026-08-06 that feature reaches INTO this screen.** The ledger now carries a
**`PAID?` settlement column**, an **Add cheque** button, and two context-menu items that
assign a cheque to a receipt or record one for it — Renzo's own ask, and the reason the
liquidation page can become a summary rather than the workplace. See **"Liquidation from
the receipt side"** below.

**Tenant/Domain layer** — Cebu-specific, zero ICTC coupling.

---

## Files

| File | Role |
|---|---|
| `deliveries-grid-v2.tsx` | **Client — the Stage 1D rewire, built BESIDE the live ledger.** The same screen rendered through the platform's **`BlackwoodTable`** (`components/shared/table/`), reachable only at `?grid=v2`. See "The `?grid=v2` rewire" below for what it does and does not do yet. |
| `page.tsx` | **Server component.** Resolves the URL axes, fetches, hands off. Also picks between the two grids on `?grid=v2` (defaulting to `DeliveriesLedger`), with an IDENTICAL prop set in both branches. Runs `fetchDeliveryMonthKeys()` + `fetchDeliveryDimensions()` in parallel, then either `fetchDeliveryMonth()` (focus) or `fetchDeliveryPage({mode:'anchor'})` (endless). Keys the client by `axesKey(...)` so a scope / lens / search change remounts with the server-prefetched window for the NEW axes — one deterministic seeding path, and it resets `firstItemIndex` by construction. **Renders no title** (the navbar owns titles). `export const dynamic = 'force-dynamic'`. |
| `types.ts` | **PURE module** (no `'use client'`, no server tag) — the shared vocabulary, imported by the server page, the server actions, the client grid AND the verify script. Owns: the generated-type-derived row shapes; **`PRICE_FIELDS` + `stripPrices()` + `redactAuditJson()`** (the ONE ₱ boundary — one list, two consumers: named fields on a row shape, and keys inside the audit trail's jsonb); **the audit vocabulary** (`RcDeliveryAuditRow`, `DeliveryHistoryEntry`, `AUDIT_TRAIL_START`, `readAuditChanges` / `auditColumnLabel` / `formatAuditValue` / `auditHeadline` / `auditSnapshotColumns`); the column table + `buildColumns` / `frozenOffsets` / `minTableWidth` / `isSelectableColumn` / `columnCalcType`; **`parseSupplierCell` / `formatSupplierCell`** and **`parseDestinationCell` / `formatDestinationCell`** (the single-column ⇄ multi-field pairs); `weightEditText` / `priceEditText` (the formula round-trip); **`parseDeliveryDate` / `isIsoDate`** (the DATE cell's free-text ⇄ `yyyy-MM-dd` verdict); **`mergeFieldEdit` / `isDirtyFieldEdits`** (when unsaved text stops being unsaved) and **`countUnsavedWork` / `hasUnsavedWork` / `describeUnsavedWork`** (the ONE number the unsaved chip, the Save button and the axis guard all read); `sampleFieldFor` (which columns a sub-row occupies); **`columnOffsets` / `frozenBlockWidth` / `columnScrollLeft`** (where the caret-follow may scroll sideways to, given the pinned block) and **`dragAutoScrollDelta`** (the same frozen-block correction, for a click-drag at the edge); **`summarySpans`** (the `Σ DAY TOTAL` / month-footer `colSpan`s, read off the column table); **`needsDaySpacer` / `DAY_SPACER_ROW_H`** (the endless scope's blank between-days row); **the clipboard exchange** (`parseClipboardTable` / `tsvEscape` / `clipboardNumber` / `cleanPastedCell` / `planPaste` — TSV in and out, and the geometry of where a pasted block lands); the draft-row constants (`DEFAULT_DRAFT_ROWS`, `MAX_DRAFT_ADD`, `clampDraftAdd`); the display formatters; `rowIssues` / `readImportFlags` and **`flagSummary`** (the ONE verdict on whether an import flag still describes a live problem — see "Flag resolution" below); and the save-payload contracts. |
| `ledger-url.ts` | **PURE module** — the URL axes: `parseScope`, `resolvePeriod` / `periodBounds` / `periodLabel`, `parseIssueLens` (+ `ISSUE_LABELS` / `ISSUE_HINTS`), `parseQuery`, `axesKey`, **and the per-column filter grammar** (`parseColumnFilters` / `serializeColumnFilter` / `withColumnFilter` / `filtersKey` / `describeFilter` / `buildFilterPredicates` / `dateFilterMissesPeriod`). No React, no Next imports, so the server page and the client toolbar share one contract without a boundary hazard (same discipline as `production/ledger-url.ts`). It imports the column table from `types.ts` — column metadata lives with the columns, URL/SQL translation lives here. |
| `actions.ts` | **`'use server'`** — reads AND writes. `fetchDeliveryPage` (bidirectional keyset pager, plus the duplicate worklist branch), `fetchDeliveryMonth` (focus), `fetchDeliveryDimensions`, `fetchDeliveryMonthKeys`, **`getDeliveryHistory`** (one receipt's audit trail, ₱-redacted server-side), `saveDeliveries`, `deleteDelivery`. Enforces the ₱ gate on every read and every write, applies the issue lens + per-column filters + search in **one** `buildRowQuery`, and sequences a combined field+samples save. |
| `assign-cheque-dialog.tsx` | **Client** — liquidation Step 4's **delivery-first door**, opened from the row context menu (*Assign to a cheque…*). Picks any live payment of the receipt's `group_code` with `unallocated_php > 0` (so the picker can never offer a guaranteed refusal, and a parent's cheque reaches a sub-supplier's receipt), defaults the amount to `min(left on the cheque, still owed)`, and writes through `cenapro_allocate_delivery_to_payment`. On an UNPRICED receipt there is no default and cannot be one — assigning is still allowed, just never guessed. |
| `delivery-history-dialog.tsx` | **Client** — the per-receipt audit trail, opened from the grid's row context menu (*View history*). Renders one entry per `cenapro.rc_delivery_audit` row, newest first, with the receipt AND its moisture draws in one list. See "Audit trail" below. Imports nothing from ICTC's `DeliveryHistoryDialog` — same reading experience, entirely separate wiring. |
| `use-deliveries-window.ts` | **Client hook** — `useDeliveriesWindow(initial, lens)`: the endless sheet's self-contained bidirectional keyset pager (no TanStack Query, mirroring `production/use-ledger-window.ts`). Owns react-virtuoso's `firstItemIndex` so a prepend and its index decrement land in one state batch, and holds the server's `totalCount`. Exposes `fetchOlder` / `fetchNewer` / `reset` / `refreshWindow` / `dropRecord`. |
| `deliveries-ledger.tsx` | **Client** — the grid. Both scopes, one set of closures. Custom `NavResolver`, edit state, cell renderers, toolbar, per-column filter popovers, the duplicate-peer popover, context menu, save, delete. Also owns **`requestAxisChange`**, the single guarded path every URL write goes through, and the unsaved-work prompt it raises, plus the **caret-follow** (`scrollTo` / `scrollToCol` / `scrollerEl`) **and the drag auto-scroll**, whose every scroll is contained to the table's own scroller. |
| `../../../../scripts/verify-rc-deliveries-cells.ts` | Framework-free assertions over the two single-column pairs, the DATE parse, the dirty-clearing rule, the draft-row rules, the column/selection geometry, **the horizontal caret-follow's frozen-block arithmetic**, **the drag auto-scroll's** (same block, same correction, plus a source scan that the loop reads its element from `scrollerEl()` rather than a one-scope ref), **the summary-row spans** (both gating states tile with no gap or overhang, each figure lands on its own column, the frozen corner spans exactly the pinned block, a column inserted anywhere is absorbed — plus a source scan refusing any arithmetic `colSpan` in the ledger), **the virtuoso index space** (`jn`'s clamp modelled verbatim, plus a source scan of `deliveries-ledger.tsx` refusing any `firstItemIndex` rebase at a scroll call site), **the filter grammar + predicate builder, the duplicate-badge logic and the axis guard's firing condition** (what counts as unsaved work, and which URL writes actually move the axes key), **the clear ⇄ Escape-revert round trip** (single cell, range, draft row, and Escape's two-stage verdict — plus a source scan that the wiring is still there and that clearing does not drop the selection), **the day spacer** (a gap on every day change and never before the first row, the undated→dated transition, `navRows` byte-identical with and without spacers, the span against `summarySpans` in both gating states, the post-save regroup, plus a source scan that the spacer never enters `navRows`, is endless-only, and is a FULL-height row of per-column cells carrying the ordinary rules, opaque and unanimated), **the clipboard** (the TSV parse/escape round trip over the cells that used to shred a row, the DB-decimal copy payload, the per-column paste cleaning, the paste geometry — a block taller than the sheet creates the rows it needs and a non-zero anchor maps to the right columns — plus source scans that the truncating bridge is gone, that copy is reachable for a SINGLE cell, that the payload reads the stored generated columns rather than recomputing them, that a multi-cell delete keeps its selection, and that `use-cell-selection.ts` publishes its anchor/focus refs synchronously), **the paste SINK** (it exists, is a single real `<textarea>`, is hidden by opacity/size rather than by anything that would make it unfocusable, is not `readOnly`, is exempt from `isGridChrome` *before* the form-control test, is the target of every `focusGrid()` and the only focus target left — no `gridRef.current.focus(` survives; the orphan-focus effect cannot fire over an open editor; the `document`-level fallback is bubble-phase and guarded four ways; the two delivery paths cannot double-apply; and every paste outcome names itself), ending in a **replay over all 991 real receipts**. **the flag-resolution surface** (the 12→2 lens shape modelled from the live counts, the rail/badge predicate, the unknown-`kind` fail-safe, the `has_unresolved_flags` OR, the no-state-column fallback, `kind`/`detail`/`raw` preservation, the per-kind resolution sentence, a malformed element that must not shift verdicts, plus source scans that the lens filters on `has_unresolved_flags`, that `ROW_COLS` is still ONE literal carrying all four derived columns, and that the grid reaches the verdict in exactly one place while a fully-repaired row keeps an openable history), **the paste ROW-FAMILY rule** (a receipt block steps over moisture draws and lands on receipts; a draw-anchored block never reaches a receipt; `delivery`+`draft` are one family; the flat-sheet case is byte-identical to the old positional mapping at every anchor × block size; the resolved targets feed `planPaste` the same plan it used to compute positionally — plus source scans that `anchor.row + r` is gone and the skip is reported), **and the read-only-cell caret** (a click never nulls the active cell). `npx tsx scripts/verify-rc-deliveries-cells.ts` — **120 assertions**, must stay green. |

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
- **Settlement (liquidation Step 4):** `public.cenapro_rc_delivery_settlement` — one row per
  receipt (`allocated_php`, `balance_php`, `settlement_status`, `is_allocatable`), fetched
  ALONGSIDE a page rather than joined into the read model, and **not fetched at all** for a
  viewer who may not see prices. Plus `public.cenapro_rc_payment_state` and
  `public.cenapro_rc_payment_allocations`, read through the liquidation module's actions for
  the two allocation dialogs.
- **Write RPCs:** `cenapro_save_rc_delivery`, `cenapro_save_rc_delivery_samples`,
  `cenapro_delete_rc_delivery` — all compare-and-set on `row_version`. The delete gained a
  third argument, `p_release_allocations` (default false); it now refuses with
  `has_allocations` when money points at the receipt. Allocation itself is written by the
  liquidation module's RPCs, never by this one.

---

## Key Behaviors

### The columns — the sheet's own order

`# · DATE · TRK# · SUPPLIER · SKS · WT · BD · MOIST · GRIT · ASH · DUST · VM · FC ·
WAREHOUSE · REMARKS · PHP/KG · TTL PRICE · PAID?`

*(`PAID?` was appended 2026-08-06 by liquidation Step 4. It is part of the ₱ group, so a
gated viewer sees 15 columns, not 18 — see "Liquidation from the receipt side".)*

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

### Cell borders — the `border-collapse: separate` trap (2026-08-05)

Renzo: *"could you add horizontal lines as well for the borders? they are used to the
shape of seeing the cell borders on the table so this might seem very weird to them if it
looks like theres no borders on the rows and stuff."*

The grid drew **vertical** cell lines and no **horizontal** ones, so it did not read as a
spreadsheet. The horizontal rules had been written — they just never rendered.

**The rule, and it is absolute: both tables are `border-collapse: separate`, and in the
separated-borders model the CSS spec paints borders on table CELLS ONLY.** A border
declared on `<tr>`, `<tbody>`, `<col>` or `<colgroup>` is ignored outright. So
`rowClassFor`'s `border-b border-border/30` (delivery), `/20` (sample sub-rows), `/20`
(draft rows) and the header `<tr className="border-b">` were all **inert**, while the
`<td>`'s own `border-r` rendered fine — which is exactly why only the verticals showed.
The `Σ DAY TOTAL`, day-header and month-footer rows always looked right because their
borders were on cells (`DAY_TOTAL_CELL` / `DAY_HEADER_CELL`) from the start.

- **`borderCollapse: 'separate'` is LOAD-BEARING and must never be changed to
  `collapse`.** Under `collapse` a border belongs to the TABLE rather than the cell, so a
  `position: sticky` frozen column's borders scroll away and the pinned block loses its
  edges — a much worse bug than a missing line. (Same reason the RC Movement matrix and
  the flecon view say so in their own files.) **Never "fix" a future missing border by
  putting it back on the `<tr>`, and never by flipping to `collapse`.**
- **The weight lives in ONE place: `ROW_RULE` in `deliveries-ledger.tsx`**, a
  `Record<NavRow['kind'], string>` applied by `renderCell` and keyed off the **same
  `navRows[navRow].kind` lookup that already decides the row's height** — so the two can
  never disagree about which family a row is in. `rowClassFor` carries no `border-b` at
  all any more; re-adding one would be both inert and a second copy of the table.
  Hierarchy preserved verbatim: receipts `/30`, sample sub-rows `/20` (lighter — they are
  children), draft rows `/20`.
- **The colour is SIDE-SPECIFIC** (`border-b-border/…`, and the cell's vertical rule was
  changed to `border-r-border/30` to match). An all-sides `border-border/20` would land in
  the same tailwind-merge group as the `border-r` colour and silently restyle the vertical
  line to the row family's weight.
- **The header's rule is on the `<th>`** — `border-b border-b-border` at full weight,
  because this is the header↔body boundary, not another row division. Its `border-r` stays
  at `/40`.
- **Frozen cells get the horizontal line too**, which matters most: they are the ones that
  looked broken without it. They are opaque (`bg-background` body / `bg-muted` header), so
  a cell-level border paints cleanly on them, and it runs along a **different edge** from
  `.frozen-edge` (inset RIGHT border + shadow) and `.frozen-edge-top` (sticky footer) — the
  three never fight.
- **Row heights are unchanged.** Tailwind's preflight makes every cell `border-box`, so the
  1px rule is drawn INSIDE the explicit `height` on the `<td>` (`ROW_H = 32` receipt/draft,
  `SAMPLE_ROW_H = 26` draw). Nothing grows, so virtuoso's measured row heights do not
  desynchronise and `minTableWidth` is untouched.
- **Both scopes are identical by construction** — `endless` and `focus` share `renderCell`
  and `headerRow`, so there is no per-scope border code to drift.
- **No animation was added** — the rule is a static border; row hover is still
  `transition-colors duration-150`.

**Latent elsewhere (not fixed in this pass).** The same inert-`<tr>`-border bug exists
wherever `border-collapse: separate` meets a row-level `border-b`:
`cenapro/production/production-endless-sheet.tsx` (`:374` header, `:430`/`:453` rows),
`cenapro/production/production-ledger-grid.tsx` (`:552` row, `:1597` header),
`production/daily/daily-ledger-grid.tsx` (`:1735`) and `production/trucks/trucks-grid.tsx`
(`:763`). The **QC ledger is NOT affected** — `qc-ledger-client.tsx` uses plain
`border-collapse`, where row borders do render.

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
| Ctrl/Cmd+A · Ctrl/Cmd+C | select all · copy the **range or the single active cell** as TSV |
| Ctrl/Cmd+V | paste a TSV block from the anchor, **creating blank rows if it runs past the end** |

Enter-opens-the-cell and Delete-clears-outright are the two departures from Excel; Enter
*while editing* still commits and moves, so the Tab-run → Enter lane return survives.

This holds for EVERY editable column — the DATE cell included (item 8 removed the reason
it was special-cased), empty cells (the geometry fix gave them a hit area), REMARKS, the
sample sub-rows and the draft rows.

**The caret lands on any cell that EXISTS, editable or not (2026-08-17, BUG-023).** A
click used to set the active cell to `null` when the cell was not addressable —
`setActiveCell(canEdit ? … : null)` — and `useGridKeyboardNav` returns on its first line
when there is no active cell. So clicking a **`TTL PRICE`** cell (selectable by design, so
a run of receipt totals can be summed in the pill) left the whole sheet with no arrows, no
Tab, no Escape, no Delete and no copy until another cell was clicked. It is unconditional
now. Nothing needed the null: `createDeliveryNavResolver` only ever tests the **target's**
addressability, so movement resolves correctly *from* a read-only cell (left/right/Tab
find the next addressable lane; up/down in the `TTL PRICE` column correctly stay put,
since no row has that cell); `isEditable` still refuses F2 / Delete / type-over; and an
open editor is already committing — `focusGrid()` in the same handler blurs it and
`EditInput`'s blur-commit clears `edit.isEditing` before the render, so `isEditingThis`
cannot become true on a non-addressable cell. **Still open:** clicking a cell the row does
not have at all (a draw's WT lane) is still a dead click — that needs the module's
`occupies()` row model.

The grid's own `onGridKeyDown`/`onGridPaste` wrappers hold one further guard: a keystroke
or paste aimed at a real form control inside the grid (the "add rows" counter, a column
header's filter box, the cell editor's own input) is not a grid gesture and is left alone.
**The one exception is the paste sink** — a hidden `<textarea>` that is a form control by
construction but is the grid's own ear; `isGridChrome` exempts it explicitly, and must,
or every keystroke would bail on the first line of `onGridKeyDown`. See *"The paste
SINK"* under **The clipboard** below.

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

### Dragging a selection to the edge — the other thing that has to scroll (2026-08-04)

Click-dragging a range to the edge of the sheet has to scroll it, and it did not in the
**endless** scope at all. `useCellSelection` takes ONE `scrollContainerRef`; this grid has
TWO scrollers — the plain wrapper in `focus`, virtuoso's own div in `endless` — so the ref
it was handed (`scrollerRef`, the focus wrapper) was **null under endless**, and the
platform hook's auto-scroll bailed on its first frame and never rescheduled.

- **The ledger drives the loop itself now**, off the same **`scrollerEl()`** the
  caret-follow uses — the existing per-scope plumbing, `LedgerCtx.onScroller` included,
  reused rather than duplicated. `scrollContainerRef` is deliberately **not** passed: two
  loops on the same axis would double the speed, and the platform one is inert without it.
- **The frozen block is a WALL, not a scroll position.** A pointer 100px in from the left
  edge is not near an edge — it is sitting ON the pinned `# · DATE · TRK# · SUPPLIER`
  columns with scrolling cells hidden underneath, so a left-edge rule measured from the
  scrollport would stall there and the covered cells would be undraggable-to. The left
  band is therefore measured from the block's INNER edge (`rect.left + 424 + 40`), the
  same correction `columnScrollLeft` makes with `scrollLeft + frozen`. That is the only
  behavioural difference from the platform hook, and it applies in **both** scopes (both
  pin the same four columns); the vertical axis and the right edge are unchanged.
- `dragAutoScrollDelta` in `types.ts` is **pure** and asserted (6 assertions): the two
  axes are independent, a delta is never issued at a wall, and a table that fits its
  scrollport never scrolls sideways at all — the drag counterpart of `columnScrollLeft`
  returning null.
- **Instant, and contained.** The delta is applied by assignment (`scrollTop`/`scrollLeft`
  `+=`) on that one element, so no ancestor and no document scroll can follow. It runs
  only while the pointer is down, so it never races the caret-follow, which runs only on a
  keyboard move.
- One cost, accepted: `useCellSelection` still registers its own `pointermove` listener
  while dragging even with no container to scroll. Removing it means editing shared
  platform code that RC IN / RC OUT / Production also use.

**Fixed since (2026-08-04, platform pass).** `EditInput`'s `autoFocus` used to focus
through React's own bare `.focus()` call, which has no `preventScroll`, so *starting an
edit* re-centred the row through every scrolling ancestor. It is now a ref callback
calling `focus({ preventScroll: true })` (`components/shared/grid/EditInput.tsx`), and
`GridCell.tsx` + `DatePickerCell.tsx` are guarded the same way. This grid uses
`EditInput`, so it inherits the fix — no local change was needed.

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

### The day spacer — endless groups days with an ACTUAL empty row (2026-08-05)

Renzo: *"Make this specific table smart enough to auto skip a table row to separate and
group days together. Nothing fancy. If input rows dont separate them in the first place
then they should auto separate when they click save."* — and, on the first attempt:
*"It should be literally just an empty row, not some made up effect on screen, it just
looks weird. Just place an actual row in between days."*

The **focus** scope already groups days with a heading and a `Σ DAY TOTAL` rule-off. The
**endless** scope had nothing, so receipts ran continuously with no sign of where one day
ended. Endless now emits a **blank spacer row** on each day boundary — and that is the
whole feature. **It is not a second day-header system:** no label, no count, no total.

**It is a real row of the spreadsheet, not an effect between rows (2026-08-05, second
pass).** The first version shipped as a 10px sliver with no borders and one `colSpan`
cell; it read as a rendering artefact. It is now indistinguishable from a row somebody
left blank:

- **`DAY_SPACER_ROW_H === ROW_H`** (32px). The identity is asserted — a spacer of any
  other height is the artefact again.
- **One `<td>` PER COLUMN**, from `cols.map(...)`, never a `colSpan`. That is what runs
  the vertical `border-r border-r-border` rules through it; a spanning cell erases every
  one of them, which is exactly what gave the old version away.
- **The same horizontal rule the receipts draw** — `border-b border-b-border`, on the
  CELL (`border-collapse: separate` never paints a `<tr>` border; see the section above).
- **The frozen block behaves like a data row's**: `.frozen-col` with the cumulative
  `left` offset, `.frozen-edge` on the last pinned column, and fully OPAQUE
  `bg-background`. Without that, the scrolling rows bleed through the pinned block at
  every gap.
- Still **not addressable**, no hover state, no animation.

- **`needsDaySpacer(prevDate, date)` in `types.ts` is the single rule.**
  `prevDate === undefined` means nothing is above it yet, which is the whole of "never a
  leading gap at the top of the sheet". The **undated group needs no special case**: an
  undated receipt normalises to `''`, so two consecutive undated rows compare equal (no
  spacer) and the undated → first-dated-day transition differs (spacer), exactly like any
  other boundary. Canonical order is `delivery_date ASC NULLS FIRST, id ASC`, so that
  transition really is at the head of history.
- **The focus branch is untouched** — it keeps `kind: 'day'` and `kind: 'day-total'`
  verbatim. The spacer is a separate `LedgerItem` kind (`day-gap`) emitted only when
  `scope === 'endless'`.
- **`DAY_SPACER_ROW_H = ROW_H`** (32px) — see the block above. The first pass used 10px
  with no rules; *"it just looks weird"* was exactly right, and the height was only half
  of why.
- **It carries the rules, it does not skip them.** The first pass argued a spacer with a
  border "would read as an empty table row rather than as breathing room" — which was the
  wrong goal. An empty table row is precisely what was asked for, so it draws
  `border-r border-r-border` on every cell and `border-b border-b-border` underneath,
  the same weights `ROW_RULE.delivery` uses.
- **Fully OPAQUE** (`bg-background`, no alpha, no `backdrop-blur`) on the frozen cells,
  per the frozen-pane rule — a translucent spacer would show the scrolling rows through
  the pinned block. The cell count comes from `cols.map(...)` (one per column), so a
  column added anywhere is covered with no new arithmetic; the verify script asserts that
  count against `summarySpans` in **both** gating states. **No animation, no hover
  state.**
- **It is NOT addressable, and that is the load-bearing part.** The spacer never enters
  `navRows`, so the keyboard coordinate space, the per-cell `NavResolver`, arrow/Tab
  movement and range selection are **byte-identical** with and without it (asserted).
  `scrollTo` maps a nav row to an items index with
  `items.findIndex(it => (delivery|sample|draft) && it.navRow === row)`, so a non-nav item
  can never match — the caret cannot land on a spacer by construction.
- **Virtuoso measurement:** `rowHeightFor` returns `DAY_SPACER_ROW_H` for the kind, so the
  endless list sizes the one row family that has no content to size it.
- **Prepend anchoring is unchanged — and note the pre-existing approximation.**
  `fetchOlder` decrements `firstItemIndex` by the number of prepended RECORDS, while the
  `items` array has always grown by more than that (each receipt may bring moisture
  sub-rows). Spacers join that same existing category; they do not change the mechanism,
  and nothing in `use-deliveries-window.ts` was touched. If a scroll-up ever jumps, that
  count mismatch is where to look — it is not new with the spacer.
- **After Save the rows regroup for free — no new code.** Drafts are appended at the
  bottom in creation order and are deliberately **not** grouped while typing (a row that
  jumped between groups mid-keystroke is the hazard the QC ledger's `anchorDate` avoids).
  An insert re-anchors the endless window on `latest` (`win.reset({kind:'latest'})`), and
  every read comes back in canonical `(delivery_date, id)` order — so the regroup **is**
  the server's sort. Typing 08-01 / 08-03 / 08-01 and saving yields one 08-01 group and
  one spacer. Asserted as a regression rather than reimplemented.

### The clipboard — paste IN, copy OUT (2026-08-05)

Renzo: *"allow us to copy and paste into existing entries and empty entries (from google
sheet, into the app)"* · *"allow us to delete multiple cells at once via selecting
multiple cells."* · *"allow us to copy data from the app so its pastable into google
sheet"*.

All three gestures were already wired, and all three were broken in a different, silent
way. The exchange format is now decided in ONE place — the pure helpers
`parseClipboardTable` / `tsvEscape` / `clipboardNumber` / `cleanPastedCell` / `planPaste`
in `types.ts` — so it is asserted without a browser.

#### The paste SINK — READ THIS BEFORE TOUCHING THE PASTE PATH (2026-08-05)

> **Never put `onPaste` on a non-editable `<div>` and expect it to fire.** This grid did,
> and paste was dead for three rounds of fixes.

Renzo, after the second round: *"delete works and copy seems to work but pasting into
cells be it empty or populated really doesn't work still."* — no error, no toast, nothing.
Both earlier rounds had fixed genuine faults **inside** `applyClipboardPaste` (see the two
defects below). Neither helped, because **the handler was never running.**

**Why.** `Delete`, `Escape`, the arrows and `Ctrl/Cmd+C` are all `keydown`, and a keydown
is delivered to whatever element holds focus — a `<div tabIndex={-1}>` included. That is
exactly why those four gestures work here: `focusGrid()` puts focus on the grid wrapper
and `onGridKeyDown` hears everything. **`paste` is a clipboard event and plays by a
different rule:** the browser dispatches it at an element that can *accept* a paste. A
focused non-editable div cannot, so the event is dispatched at **`document.body`** instead
(stricter engines disable the paste command outright and dispatch nothing). `document.body`
is an **ancestor** of React's root container, so an event targeted there never travels
through the grid — React's `onPaste={onGridPaste}` on the wrapper could not fire, ever.

**The corroboration is structural, and it is in this repo.** Every grid here where paste
demonstrably works — `bulk-delivery-input.tsx`, `bulk-usage-input.tsx`,
`production-ledger-grid.tsx` — has a real `<input>` under the caret, so the browser always
has a legitimate target and the container's `onPaste` catches it on the way up. This
ledger is the **only** grid whose cells are non-editable `<div>`s in nav mode. That is the
whole of the difference.
*(An earlier framing of this bug claimed copy had been broken the same way and was fixed
by moving off the `copy` DOM event. That is not what happened — copy was never on a DOM
clipboard event here; it was on a keydown path whose guards were too tight
(`activeCell !== null && size > 1`). The evidence for the sink is the structural one
above, not that one.)*

**The fix — two complementary delivery paths, one application.**

| Path | What it covers | Where |
|---|---|---|
| **The sink** | The browser delivers the event *somewhere legitimate*, and that somewhere is inside the grid | a real `<textarea>` inside the grid wrapper, marked `PASTE_SINK_ATTR` |
| **The `document` fallback** | The engine dispatches at `document.body` anyway, where React can never see it | one bubble-phase `document.addEventListener('paste', …)` |

- **The sink must be a real, rendered, focusable, EDITABLE element.** `display:none`,
  `visibility:hidden`, `hidden` and `sr-only` all make an element **unfocusable**, and an
  unfocusable sink is no sink. It is hidden by `opacity-0` + `size-px` + `-z-10`, kept out
  of every click with `pointer-events-none`, off the Tab order with `tabIndex={-1}`, out of
  the a11y tree with `aria-hidden`, and carries `select-text` because WebKit applies the
  wrapper's `select-none` to editable descendants too. `readOnly` is **not** an option —
  a readOnly textarea is not a paste target in Chromium. `onInput` empties it, so a
  keystroke the grid declines to handle cannot accumulate inside it.
- **`focusGrid()` is the ONE way focus reaches the grid.** It focuses the sink (falling
  back to the wrapper), always with `preventScroll: true` — see the caret-follow rules
  below. All three caret sites (`onAfterMove`, a cell's `onMouseDown`, `goToReceipt`) go
  through it; a surviving `gridRef.current.focus()` would be a cell whose next Ctrl/Cmd+V
  lands nowhere, so the verify script forbids the string outright.
- **The sink is exempt from `isGridChrome`, and the exemption comes FIRST.** `isGridChrome`
  treats every `INPUT`/`TEXTAREA`/`SELECT` as a control the grid does not own, and
  `onGridKeyDown`'s first line is `if (!edit.isEditing && isGridChrome(e.target)) return;`.
  Without the exemption the sink — a textarea, and the thing holding focus — would silently
  kill Delete, Escape, Ctrl/Cmd+C, type-to-edit and the arrows.
- **It never steals the caret from an open cell editor.** The three caret sites are user
  gestures and are always safe (the shared hook calls `edit.commit()` *before* any move, so
  the editor is already on its way out). The one unprompted focus move is a narrow effect:
  it fires only when `edit.isEditing` is false **as read after render**, only when a cell is
  selected, and only when focus has been genuinely orphaned on `document.body` — which is
  what happens when the editor unmounts on Escape and takes the caret with it. A filter
  popover or the search box is never `document.body`, so neither is ever interrupted.
- **The two paths cannot double-apply**, and a doubled paste writes a second copy of a
  receipt — precisely the fault this ledger flagged 22 rows for (all since deleted; the
  detection still runs, it just has nothing to catch today). Two interlocks:
  *(a)* the React handler stamps `handledPasteRef` with the native event, and the document
  listener refuses a stamped event — which holds because React's root listener runs **before**
  a **bubble-phase** listener on `document` (capture would invert it, so capture is forbidden);
  *(b)* structurally, the document listener ignores any event whose target is inside
  `gridRef` — including one `onGridPaste` deliberately *declined*, because that paste
  belongs to the control it hit. There is exactly **one** React `onPaste` in the file.
- **The document fallback is guarded four ways:** not `isGridChrome` (a text field, the
  search box, a Radix-portalled filter popover, anything `data-grid-chrome`); not while a
  cell editor is mounted; and only when the grid holds the caret **or** holds focus.

**Every paste path now ends in a message.** `if (!text) return;` — the most silent line in
the module — is gone. The complete set of outcomes:

| Situation | What the operator sees |
|---|---|
| Clipboard holds no text | `toast.info` *"Nothing pasted — the clipboard holds no text."* |
| Clipboard parses to no cells | `toast.info` *"Nothing pasted — the clipboard held no cells."* |
| No cell selected | persistent `errorToast` *"Nothing was pasted — no cell is selected."* |
| Block lands entirely on non-editable cells | `toast.info` *"…that block lands outside the editable cells."* |
| Rows past the end / columns past `REMARKS` | persistent `errorToast` naming the count **and** the reason |
| It worked | `toast.success` *"Pasted N rows · M new rows"* |
| Paste aimed at a real control inside the grid | *nothing from the grid* — and correctly so: the browser performs that control's own paste |

**PASTE (`applyClipboardPaste` in the ledger; the platform `useGridPaste` is no longer
used here).** Two further defects, both silent, both fixed in earlier rounds:

1. **The block was truncated to the rows that already existed.** `useGridPaste` builds
   its own row array and appends to it happily, but the adapter that wrote that array
   back into this grid's edit MAP looped `r < Math.min(after.length, navRows.length)`.
   Pasting a 30-row slip into a sheet showing 20 blank rows wrote 20, threw 10 away, and
   toasted *"Pasted 30 rows"*.
2. **With no active cell it did nothing at all** — not even `preventDefault`.
   `handleGridPaste` is `if (activeCell) {…}` with no `else`, so a paste before anything
   had been clicked, or after clicking TTL PRICE (read-only ⇒ the active cell is set to
   `null`), vanished without a word.

- **A block taller than the sheet CREATES the rows it needs**, through the same
  `makeDraftIds` → `draftIds` / `draftEdits` path the *Add N more rows* control uses.
  There is no second way to make a draft row. New rows only exist where a blank row
  MEANS something (`showDrafts`: never under a lens or a search, and in endless only at
  the true newest end) — where they are absent the overflow is **reported**, never
  appended into the middle of history. `MAX_DRAFT_ADD = 500` caps one gesture, and what
  it refuses is said out loud.
- **Nothing is truncated in silence.** No anchor, rows past the end, columns past
  `REMARKS` — each raises a persistent `errorToast` naming the count and the reason.
- **Every existing refusal is unchanged**: an unresolvable supplier/warehouse still
  refuses at commit and again at save; a pasted date goes through `parseDeliveryDate`
  with the same context year a typed one gets (`contextYearFor(row)`, `fallbackYear` for
  a row that does not exist yet); a cell the row does not have (a moisture draw has no
  weight) is skipped by the same `addressable` rule the keyboard uses; the ₱ columns are
  absent from `cols` for a gated viewer, and `field === 'price' && !canViewPrices` is the
  belt to that braces.
- **A numeric column strips the rendering Sheets copied with it** (`₱`, thousands
  commas, stray quotes) — and only a numeric column, because a supplier origin or a
  remark may legitimately contain a comma. A formula (`=27045*88%`) pastes through intact.

**A block lands on rows of the ANCHOR'S OWN FAMILY (2026-08-17, BUG-024).** A fourth
defect, and the worst of them: the block was mapped onto nav rows **positionally**
(`anchor.row + r`), which walks straight through the moisture draws sitting under a
receipt. A 5-row receipt block pasted onto a receipt with 2 draws wrote block rows 1–2
into the **draws** — and only their seven lab lanes, because every other column failed the
per-cell `addressable` test and was dropped in silence — then carried on into the
following receipts, and toasted *"Pasted 5 rows"*. Wrong data in real receipts, reported
as success.

- **`pasteRowTargets({kinds, anchorRow, blockRows})` in `types.ts` is the single rule**,
  pure and asserted. It walks the nav rows from the anchor collecting only rows whose kind
  is **compatible** with the anchor's: a `sample` anchor takes draws only; a
  `delivery`/`draft` anchor takes receipts **and** blank rows, because a pasted slip
  flowing off the last receipt into the draft pool is how it BECOMES new receipts. That
  predicate is `pasteKindsCompatible`, stated once.
- **`planPaste` is reused verbatim, not replaced.** It is called with `startRow: 0` and
  `navRowCount: targets.length`, so its row math (`needed = startRow + blockRows −
  navRowCount`) is exactly the overflow and its column math is untouched. Asserted: with
  no foreign rows in the way the two forms return the *same* plan, for every anchor × block
  size on a flat sheet — the ordinary paste is byte-identical to before.
- **A draw-anchored block may never manufacture receipts**: `canCreateRows` gained
  `&& anchorKind !== 'sample'`, and that overflow gets its own sentence rather than the
  "no blank rows to grow into" one, which would have been the wrong advice.
- **The step-over is REPORTED** — `Pasted 5 rows · 2 draw rows skipped`. Skipping is
  correct, but it is not what the block looked like on screen. `skipped` counts only rows
  genuinely stepped OVER to reach a later target: a run of foreign rows at the point the
  block (or the sheet) ran out is not reported, because `planPaste` already reports that
  as dropped rows and double-counting it would read as two different problems.
- **This is the seed of the universal table module's `occupies()` row model** — the same
  question ("does this row have this cell, and as what?") asked per cell instead of per
  row. See `.agents/prompts/universal-table-module.md`.

**COPY (`clipboardCellText` + `copySelectionToClipboard`; the platform
`useClipboardCopy` is no longer used here).** Three defects:

1. **It was only reachable through the platform nav hook's RANGE branch**, guarded by
   BOTH `activeCell !== null` (`use-grid-keyboard-nav.ts:133`) and
   `range.isRangeSelected` — which is `size > 1`. So **Ctrl/Cmd+C on a single selected
   cell reached nothing at all**, and neither did a drag begun on TTL PRICE (selectable,
   never active). It is intercepted in the ledger's own `onGridKeyDown` now, ahead of the
   shared hook, and covers the single cell, the range and the no-active-cell range.
2. **The payload was the cell's EDIT text.** WT reads back as `=27045*88%` and PHP/KG as
   `=39.5+2.7`, so a copied block landed in the operator's own sheet as **live formulas**
   — locale-sensitive (`88%`), recalculating, editable — and TTL PRICE went through
   `formatPeso`, i.e. `6,940,123.45`, which Sheets reads as text.
3. **Nothing was escaped.** One REMARKS cell holding a line break shredded every row
   below it.

- **VALUE, not formula — and the value is the DATABASE's.** WT copies `net_weight_kg`,
  PHP/KG copies `price_php_kg`, TTL PRICE copies `total_price_php`. All three are STORED
  GENERATED exact decimals, so `clipboardNumber` emits the DB's own digits **verbatim**
  when the source is already a plain numeric string — no `Number()` round trip, nothing
  re-derived. The formula is a derivation; the figure is the fact, and a payment ledger
  exports facts. (A DRAFT row has nothing stored, so it copies the operator's own text —
  inventing a figure there is the arithmetic this module refuses to do.)
- **TSV, properly.** Tab between columns, newline between rows, `tsvEscape` on every cell
  (quote + doubled `""`), which is the convention Sheets and Excel both parse. Dates are
  `yyyy-MM-dd`, lab values are bare numbers, and nothing carries `₱` or a thousands
  separator.
- **A gated viewer can never get ₱ on the clipboard** — `buildColumns(false)` omits both
  ₱ columns, so they are not in the coordinate space a copy range can address, and
  `clipboardCellText` guards again.
- **One definition.** The context menu's *Copy row as TSV* builds its payload from the
  same `clipboardCellText`; the old `displayText` (which emitted the on-screen
  formatting) is gone.
- **A refused clipboard write says so.** `navigator.clipboard.writeText` had no rejection
  handler at all, so an insecure origin or an unfocused document was an unhandled promise
  and a silent no-op. Both copy paths now `errorToast`.

**DELETE over a multi-cell selection — the real cause was the SELECTION, not the
delete.** `clearSelectedCells` was already correct (it iterates `selectedCells()`, which
returns the whole range when its size > 1, filtered by `addressable`, and deliberately
leaves the selection intact so Escape can undo it). What did not work was **building** the
range with the keyboard: `useGridKeyboardNav`'s "Shift+Arrow from a single cell" branch
calls `range.seedFromActive()` and then `range.extend(e)` back to back **in one event
handler**, and React applies a state update only after the handler returns — so
`useCellSelection`'s `anchorRef`, which was synced during RENDER only, was still the
previous value when `extend` read it. `extend` took its *"no anchor ⇒ start a selection at
(0,0)"* branch and its setters landed last, so **shift+arrow selected the top-left corner
of the sheet** instead of extending from the caret, and the Delete that followed blanked
cells the operator was not looking at. Drag-selection was unaffected (a drag spans several
renders). Fixed in the platform hook — see below.

**Platform change (`lib/hooks/use-cell-selection.ts`).** Every `setAnchor` / `setFocus`
now writes its ref synchronously as well, which is the discipline the same file already
used for `isDraggingRef` and for the same reason; the render-time assignment stays as the
fallback. It is a platform fix because the race is in the platform hook's contract with
`useGridKeyboardNav`, and **every consumer has the identical bug and can only benefit**:
RC IN (`delivery-master-table.tsx`, `bulk-delivery-input.tsx`), RC OUT
(`rc-out-table.tsx`, `bulk-usage-input.tsx`), Production Daily / Electricity / Trucks and
the Cenapro production grids all wire the same `seedFromActive` → `extend` range slot, so
shift+arrow started their selections at (0,0) too. No behaviour that any of them could
want is changed — a ref that agrees with state sooner is strictly more correct.
`lib/hooks/use-grid-keyboard-nav.ts`, `use-grid-paste.ts` and `use-clipboard-copy.ts` were
**NOT** touched; the other grids keep using the latter two verbatim.

### The `?grid=v2` rewire — built BESIDE the ledger, not in place of it (2026-08-17)

Stage 1D of the universal-table migration. `deliveries-grid-v2.tsx` renders this same
screen through the platform's `BlackwoodTable`; `deliveries-ledger.tsx` stays the
production path and **is not edited by one character** while both are alive. The method,
and why the earlier atomic attempts could never land, is in
`handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`.

- **`page.tsx` picks on `?grid=v2`, defaulting to the OLD grid.** Both branches hand the
  two components the identical prop set — v2 imports `DeliveriesLedgerProps` from the
  ledger rather than re-declaring it, so the two can never drift — and both read the same
  server data. No action, RPC or query changes with the flag.
- **`?grid=v2` joins `axesKey(...)`** (`ledger-url.ts`, `parseGrid` / `GRID_V2`) so a
  switch REMOUNTS rather than reconciling one component's tree into the other's. The field
  is optional and contributes nothing when absent, so every existing key is unchanged.
- **The column table is TRANSLATED, never re-declared.** The specs are built from
  `buildColumns(canViewPrices)`, so `types.ts` stays the ONE definition of the order, the
  widths, the pinned block, the summary lanes, the filter grammar and — critically — which
  columns are money. The module's `visible: (ctx) => …` seam is the more idiomatic
  spelling, but using it here would create a SECOND definition of the price boundary.
- **Slice 1 (2026-08-17) is READ-ONLY.** Column specs, row families, the flatten (day
  heading, `Σ DAY TOTAL`, the endless day spacer, the sticky month footer) and the render,
  in both scopes. **Not built yet:** editing, save, the toolbar, filter popovers, the row
  context menu, the dialogs, and the blank draft rows. `ctx.canEdit` is FALSE and every
  editable column ANDs its own rule with it, so nothing can be typed into — one switch, not
  fifteen omissions. The duplicate and import-flag POPOVERS are rendered as `title` text
  instead: same facts, nothing pretending to be a button.
- **`#` / `TTL PRICE` / `PAID?` are `addressable: false`, and that seam exists because this
  slice found it.** All three carry content the ledger paints (the row ordinal and its
  status rail, the DB-generated total, the settlement badge) and none is a place the old
  grid's caret ever lands — `field: null` makes a column unaddressable there. `occupies()`
  originally answered *"does this row render content here"* and *"may the caret land here"*
  with ONE value, so slice 1 shipped with the three columns marked occupied and a Tab run
  walking through three dead stops per row. `CellSlot.addressable` (platform, 2026-08-17)
  splits the two questions; `buildSlots` sets it from **`col.field !== null`**, the same
  condition the ledger's own `addressable()` uses, so there is no second rule to keep in
  step. `TTL PRICE` stays SELECTABLE — a run of receipt totals is the most useful thing on
  this sheet to sweep and add up, and none of that involves the caret resting there. One
  residual difference: v2 renders a hit area on all three, so a CLICK parks the caret on
  `#` or `PAID?` where the old grid ignores the click entirely (it gates the mousedown on
  its own `cellExists`, which is true only for `TTL PRICE`). The platform keeps the mouse on
  the render predicate deliberately — see `lib/table/CONTEXT.md` → `CellSlot.addressable`.
- **One known divergence from the ledger, structural.** The pager's `firstItemIndex` is
  corrected **at the call site** with `shiftFirstItemIndex`, measured as "items above a
  fixed anchor row" — `use-deliveries-window.ts` decrements by RECORDS while the flat array
  grows by more (draws, spacers), which is the pre-existing approximation noted under "The
  day spacer".
- **The filter triggers now have somewhere to go.** `BlackwoodTable.renderHeaderSlot` →
  `HeaderCell.filterSlot` was added by this slice too (the second seam it found). Slice 1
  passes none: a filter button that opens nothing is exactly what this slice refuses to
  render. The `filter` metadata is already declared on every spec, from `./types`.

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
— no further, or it would overhang into scrolling territory. That span is
`summarySpans(cols).frozen`, which IS `frozenOffsets(cols).length`: the corner and the
`left` offsets are the same walk, so they cannot drift apart (see "Totals").

The block's 424px total is not only a paint concern: it is subtracted by the horizontal
caret-follow, or Tab would scroll a column to a position where the pinned columns cover
it, and by the drag auto-scroll, or a drag could never reach the cells parked under the
pinned columns. See "Following the caret" and "Dragging a selection to the edge" above.

### Data-quality surfacing

The import deliberately kept bad rows visible rather than fixing them, so the UI surfaces
them rather than smoothing them over:

| State | Treatment |
|---|---|
| `is_suspected_duplicate` (**0 rows today**, was 22) | Rose inset rail on the frozen block + a **`DUP n/N` badge opening the peer popover** + a rose row wash. **The keep-or-drop decision has since been MADE and EXECUTED:** the 22 copies — three consecutive days pasted twice, ₱17,185,938.70 in total (2026-04-06 9 rows ₱6.94M · 04-07 7 rows ₱5.32M · 04-08 6 rows ₱4.93M) — were hard-DELETEd on 2026-08-04, so nothing renders this treatment today. **The rendering is not removed and still works**; it fires again the moment a receipt is pasted twice. The day-total and month-footer "includes … from suspected duplicates" lines are correspondingly dormant. |
| `duplicate_group_key IS NOT NULL`, unflagged (**0 rows today**, was 22) | The ORIGINALS the flagged rows were pasted from — see "Duplicate pairing" below. A **thinner, 40%-opacity rose rail, no row wash**, and an OUTLINE `TWIN n/N` badge onto the same popover. With their copies deleted the 22 originals no longer pair with anything, so they render as ordinary receipts — which is correct. |
| `has_unresolved_flags` (**2 rows**) | Sky rail + a warning icon opening a **popover** with each flag's `kind` / `detail` / the workbook's original `raw` text. **Live problems only** — see "Flag resolution" below. |
| flags, all of them repaired (**10 rows**) | **No rail, no badge, no lens membership.** A quiet `History` glyph at 40% muted opens the SAME popover, so the history stays reachable without reading as a problem. |
| `supplier_unresolved` / `destination_unresolved` (**1 / 0 rows**, verified live 2026-08-05) | Amber rail + a `MAP?` badge; the cell shows the raw text; a save is refused until it resolves. The one remaining is the 2026-02-23 receipt with no payee (₱864,743.75) — it is the one receipt liquidation structurally cannot settle. `destination_unresolved` is 0 because the five unmapped yards were repaired to `WHSE 3A`; the two receipts that still have a NULL `destination_code` (the `SEVILLA` lab-sample rows 1321/1322) carry no `destination_raw` either, so they are not "unresolved" — nothing was ever typed to resolve. |
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

> **STATUS 2026-08-05 — this all still WORKS, and currently matches NOTHING.** The 22
> duplicate copies were hard-DELETEd on 2026-08-04, so `duplicate_group_key IS NOT NULL`
> returns **0 rows** and `?issue=duplicate` is empty. Nothing below was removed or turned
> off; the pairing is re-derived on every read and will light up the next time a receipt
> is pasted twice. Read the counts below as the 2026-08-04 state that shaped the design.

**BEHAVIOUR CHANGE: `?issue=duplicate` now returns 44 rows, not 22.** It filtered on
`is_suspected_duplicate`, and the importer flagged only the SECOND copy of each pasted
receipt — so the lens returned 22 orphans with their 22 originals invisible, which is
exactly the shape that cannot answer "is it really an exact copy of that row?". It now
filters `duplicate_group_key IS NOT NULL`: **22 groups × 2 = 44 rows, on exactly
2026-04-06 / 04-07 / 04-08** (verified live over PostgREST, `content-range 0-43/44`
— on 2026-08-04, when those rows still existed).

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
  **He made it on 2026-08-04 and dropped them** — all 22 copies hard-DELETEd,
  ₱17,185,938.70 off the total. This surface did not do that and would not have; a
  human did it directly. It also left **no audit trace of any kind**, which is what
  produced `cenapro.rc_delivery_audit` the next day (see `../CONTEXT.md` → "Audit
  trail"). From 2026-08-05 the same deletion would be fully recorded — row, actor,
  timestamp, and the payable total it carried.

### Flag resolution — the queue shows LIVE problems, the history stays (2026-08-05)

**BEHAVIOUR CHANGE: `?issue=flagged` now returns 2 rows, not 12.**

`import_flags` records what the extractor saw **on the day of the import**, and it is
**never cleared, edited or deleted** — it is the only surviving witness that the workbook
literally said `WHSE A/R#16` (decision 3, "flagged, never fixed"). So it does not stop
describing a problem when a human repairs one. Renzo repaired most of them, and the lens
became a lie: **12 receipts carried a flag while only 2 still had anything to do.** A
worklist where five in six entries are already done is a worklist nobody opens, and every
future repair made it worse.

**The rule, and it is the whole of the change: flags are never cleared, only
de-emphasised.** The read model (migration `20260805090000`, see `../CONTEXT.md` → "Flag
resolution") now DERIVES, per flag, whether its condition still holds —
`import_flags_state` (the same array with a `resolved` boolean added to each element),
`unresolved_flag_count`, `resolved_flag_count`, `has_unresolved_flags`. Nothing is
mutated; `import_flags` / `import_flag_count` / `has_import_flags` are untouched and
still travel on every row. What changed is only what the UI **emphasises**.

- **The lens filters on `has_unresolved_flags`** (`actions.ts::buildRowQuery`), not
  `has_import_flags`. The four new columns are appended to `ROW_COLS` — still ONE string
  literal, because `+`-concatenation defeats PostgREST's type inference.
- **`flagSummary(row)` in `types.ts` is the ONE place the verdict is reached**, and
  everything that reacts to a flag reads that one call: `rowIssues` derives the `flagged`
  issue from it (which is what drives the sky rail), and the grid's icon reads the same
  object. A second call site would be a second definition of "still a problem" — the
  verify script counts them and refuses more than one.
- **Two fail-safes, both leaning "still a problem"**, matching the backend's own
  asymmetry (a wrong *resolved* silently hides a real problem; a wrong *unresolved*
  merely leaves a row where a human will see it): an element whose `resolved` is not
  literally `true` counts as UNRESOLVED — so an **unknown `kind`** stays in the queue, as
  does a row read through a projection that lacks `import_flags_state`; and
  `has_unresolved_flags` is **ORed in**, so a boolean saying "live" is never overridden
  by an array that lost its verdicts.
- **A live flag keeps today's treatment** — sky rail, sky `AlertTriangle`, the `kind` /
  `detail` / the workbook's `raw` text.
- **A resolved flag renders as history**: the whole entry at 60% opacity, a green check,
  the `kind` struck through, and one line saying **what repaired it** ("Resolved — the
  receipt now has a warehouse (WHSE 3A)"), read off the row's CURRENT state — the same
  state the SQL predicate asked about. **`raw` is still shown**, on both: not losing the
  workbook's original text is the entire reason a flag is never cleared. The popover's
  footer says so in the operator's words.
- **A fully-repaired row must not become undiscoverable.** It loses its rail and its
  badge (correctly — it is not in the queue), so it would otherwise take its history with
  it. It gets a deliberately quiet affordance instead: a `History` glyph at
  `text-muted-foreground/40`, no colour, no ring, same size, opening the same popover.
  Enough to open, not enough to read as a problem. **The trigger keys off the flag COUNT,
  not off `live`** — that is the line that keeps the history reachable, and the verify
  script pins it.
- **No `stripPrices()` entry.** None of the four columns is or can reveal a ₱ figure —
  two counts, a boolean, and the extractor's own text. "This receipt still has an open
  data problem" is an operational fact every role needs.
- **No animation** (nothing on a row, a cell or a selection); the popover keeps the
  canonical glass `bg-popover/95 backdrop-blur-lg`, the frozen cells stay opaque.
- The lens hint in `ledger-url.ts` was rewritten to say what it now shows, so the toolbar
  does not promise the old behaviour.

**Pinned by 11 assertions** in `verify-rc-deliveries-cells.ts` (105 → **116**): the
12→2 shape modelled row-for-row from the live counts, the rail/badge predicate on both
sides, the unknown-`kind` fail-safe, the `has_unresolved_flags` OR, the no-state-column
fallback, `kind`/`detail`/`raw` preservation, the per-kind resolution sentence, a
malformed element that must not shift verdicts onto the wrong flag, a source scan of
`actions.ts` (the lens predicate + `ROW_COLS` still one literal carrying all four
columns) and a source scan of the ledger (exactly one `flagSummary` call, no
`readImportFlags`, no `has_import_flags`, the count-keyed trigger, the `History` glyph
and the strike-through).

### Audit trail — every write from this grid is now recorded (2026-08-05)

**The data layer landed first, then the UI on top of it the same day. Read the DATA LAYER
half below before touching the dialog — the ₱ hazard in it is the whole reason the dialog
is not a two-line fetch.**

#### DATA LAYER

Migration `20260805100000_cenapro_rc_delivery_audit.sql` added `cenapro.rc_delivery_audit`,
read through **`public.cenapro_rc_delivery_audit`** (SELECT only). It trails every
INSERT / UPDATE / DELETE on **both** `rc_delivery` and its sub-samples in ONE table, keyed
by `delivery_id` — so a receipt's whole history is `select … where delivery_id = $1 order by
changed_at desc`, one indexed query, sub-samples included. Full schema and rationale live in
`../CONTEXT.md` → **"Audit trail"**. What matters at this layer:

- **It catches this grid.** The trigger fires on every writer — the three save RPCs, direct
  DML through the auto-updatable accessor, the importer. It cannot be bypassed by a save
  path this module adds later, and it needs no change to `actions.ts`.
- **A save that changes nothing writes nothing.** `changed` excludes `updated_at` and
  `row_version`, so the touch trigger's unconditional bump never manufactures a phantom
  entry. Matches this module's own dirty-state rule (an edit that undoes itself is not an
  edit) — the trail agrees with the grid about what counts as a change.
- **The money is in the diff.** A `WT` or `PHP/KG` edit records `net_weight_kg`,
  `price_php_kg` and `total_price_php` moving alongside the base column that moved them, so
  "who changed what this receipt is worth" is answerable without recomputing anything.
- **⚠ It is ₱-BEARING, and `stripPrices()` does not reach it.** `changed` and `snapshot` are
  free-form jsonb carrying every column, `total_price_php` included. `stripPrices()` in
  `types.ts` nulls named fields on a row shape and **will not touch a jsonb blob**. So a
  history popover cannot just fetch and render: the server action must **redact the ₱ keys
  out of `changed`/`snapshot` before the payload returns** when `!canViewPrices()`, exactly
  like every other read here. The network response is the leak. That is the single
  non-obvious hazard in building this UI.
- **`source` is NULL on everything.** No writer sets `cenapro.audit_source` today. If a
  history UI wants to say *which surface* made a change, the save RPCs need a
  `set_config('cenapro.audit_source', 'rc_deliveries_grid', true)` — and it must be cleared
  immediately after the statement it describes, because a transaction-local GUC left set
  will mislabel any later write in the same transaction.
- **The trail starts 2026-08-05.** Every receipt older than that has an empty history, and
  that is the honest answer — not a bug to paper over with a synthetic "imported" entry.

#### THE UI — `delivery-history-dialog.tsx` (2026-08-05, Step 1b)

Opened from the grid's **row context menu → "View history"**. There is no second
affordance and no second menu: the receipt menu and the DRAFT menu are separate arrays,
so a blank row cannot reach it by construction — a row that has never been saved has no
history and no id to look one up with. `useGridContextMenu`'s edge-flip estimate went
`height: 220 → 252` with the extra item; it is a flip estimate, not a layout value, but
leaving it stale drops the last item off the bottom of the viewport.

**The ₱ decision, and it is a decision — state it when changing anything here.**
`changed` and `snapshot` are ₱-bearing jsonb and `stripPrices()` cannot reach inside a
blob (see the DATA LAYER note above). So:

- **The keys are DELETED server-side in `getDeliveryHistory`, before the payload returns**,
  by `redactAuditJson(raw, showPrices)` — which reads the SAME `PRICE_FIELDS` list
  `stripPrices()` reads. `showPrices` is a PARAMETER rather than a caller-side `if`, so
  there is one code path into the payload and no way to build an entry that skipped the
  gate. The network response is the leak; the renderer is never the boundary.
- **`PRICE_FIELDS` is now a shared constant** (`types.ts`), `satisfies readonly (keyof
  RcDeliveryRow)[]` so a typo cannot silently redact nothing. It has exactly two
  consumers. **A money column added to one and forgotten in the other is a hole in the
  boundary at the surface nobody looks at** — which is precisely why the list moved out of
  `stripPrices`'s object literal.
- **A row whose ONLY changed column was a price still RENDERS**, as *"1 price field
  changed — figures hidden by your role"*, with no figure and no column name. It is **not**
  omitted. Omitting it would make the history lie by silence: a change certainly happened,
  and *"who touched this receipt and when"* is an operational fact every role needs — the
  same reasoning that keeps `duplicate_group_key` out of `stripPrices()`. What the boundary
  hides is FIGURES, not the existence of the ledger. The count is carried as
  `redactedChanges` on the entry; the ₱ column NAMES are not sent, because the two ₱
  columns are ABSENT from a gated viewer's grid entirely and naming them here would
  re-introduce what `buildColumns(false)` removes.
- **`deduction_pct` is deliberately NOT redacted.** The brief that commissioned this listed
  it among the ₱ keys; the module's ₱ boundary does not, and the boundary wins. A gated
  viewer already sees the deduction in the WT cell (`=27045*88%` — `buildColumns(false)`
  drops PHP/KG and TTL PRICE but keeps WT, and `stripPrices()` nulls `price_formula` but
  not `weight_formula`). Redacting it only in the history would be a SECOND, divergent
  definition of "is this a price".

**What the dialog shows.**

| Entry | Renders as |
|---|---|
| `delivery` INSERT | "Receipt created" + a snapshot summary (DATE · TRK# · SUPPLIER · SKS · WT · WAREHOUSE · TTL PRICE) |
| `delivery` DELETE | "Receipt deleted" + the same summary, read off `snapshot` — **the point of the whole table**: the 22 rows deleted on 2026-08-04 took ₱17,185,938.70 and left nothing behind. A deletion now keeps its numbers. |
| `delivery` UPDATE | field-by-field `old → new`, in the sheet's own left-to-right column order |
| `sample` * | "Moisture draw added / removed / edited" + `#N`, indented, on a `bg-muted/20` wash and wearing the `Droplets` glyph rather than the operation's — a `Trash2` beside "Moisture draw removed" reads as though the RECEIPT were deleted |

- **Values are formatted by their column, with the module's EXISTING formatters** —
  `formatKg` / `formatPeso` / `formatRate` / `formatInt` / `formatLab` + `labDecimals`
  (BD 3 dp, the rest 2 dp), dates `yyyy-MM-dd`, ₱ in **accounting form** (symbol pinned
  left, figure pinned right, `min-w-[7.5rem]` so a column of totals lines up). Nothing new
  was invented, so a figure in the history and the same figure in the sheet cannot
  disagree. A NULL renders as an em dash and **loses the strike-through** — a struck em
  dash reads as a rendering fault (the `no-underline` must stay AFTER `line-through`;
  tailwind-merge keeps the last of a conflicting group, not the most specific).
- **Actor.** `changed_by` → `public.profiles` in a SEPARATE lookup over the distinct uuids.
  There is deliberately **no FK** (an audit row must outlive the account), so a miss
  renders **"Unknown user"** and never throws. **`changed_by IS NULL` renders as
  *"system"*** — a service-role / importer / psql write — never as a blank name.
- **Time** is `formatDistanceToNow` with the absolute `yyyy-MM-dd HH:mm:ss` on hover.
- **Two bookkeeping columns are not listed in a diff**, both already stated elsewhere on
  the same entry: `updated_by` (identical to the audit row's own `changed_by`, which the
  actor line already names) and `delivery_year` (a STORED GENERATED mirror of
  `delivery_date`, directly above it). **Nothing else is hidden** — `provenance`,
  `source_row`, `import_flags`, `created_by` all still show. `updated_at` and `row_version`
  never arrive at all; the trigger excludes them.
- **Ordering is `changed_at DESC, id DESC`.** The `id` tiebreak is load-bearing: the
  samples RPC replaces the WHOLE block, so one moisture edit writes several rows at one
  identical `changed_at`. The dialog says so in a footer line rather than leaving a burst
  of draw entries looking like a mystery.
- **`HISTORY_MAX = 300`**, and reaching it is **said out loud** in a `notice` rather than
  silently clipping — same discipline as `DUPLICATE_WORKLIST_MAX`.
- **The empty state is the common case for a while, and it must say WHY**: *"No changes
  recorded since 2026-08-05 … which is not the same as nothing having happened."* A bare
  "no history" would be a claim the database cannot make about a receipt from April.
- **Errors are inline**, not a toast: a bordered destructive banner with its own **Copy**
  button, per the HARD RULE (persistent + copyable). It is the module's existing
  load-error idiom.
- **Focus.** `DialogContent` gets `onCloseAutoFocus={e => {e.preventDefault(); onClosed()}}`
  and the ledger passes `focusGrid`. Radix would restore focus to the TRIGGER — a
  context-menu item that has already unmounted — leaving the caret on `<body>` and the
  next keystroke nowhere. `focusGrid` uses `{ preventScroll: true }`, so closing the dialog
  does not jog the sheet (see "Following the caret").
- **Motion.** `animate-modal-enter` on `DialogContent` (which already ships the dialog
  glass `bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80`) —
  the same idiom `_shared/edit-delivery-dialog.tsx` and `blend-proposal-dialog.tsx` use.
  **Nothing inside the dialog animates**: entries are data, and a history that fades in one
  row at a time is chrome pretending to be information. No `stagger-children` — the list is
  unbounded.
- **Zero ICTC coupling.** `inventory/rc-in/components/DeliveryHistoryDialog.tsx` +
  `audit-shared.tsx` are the shape this is modelled on and **nothing is imported from
  them**. They are bound to `public.audit_logs`, `audit_comments`, notifications and
  resolve-requests — none of which exist for Cenapro — and the tenant wall forbids the
  import regardless. The reading experience is copied; the wiring is not.
- **The grid was barely touched**: one import, one `historyTarget` state, one menu item,
  one flip-height constant, one mounted dialog. No render path, no nav resolver, no
  clipboard, no save path changed.

**Not yet done, deliberately.** `source` is NULL on every row (no writer sets
`cenapro.audit_source`), so the dialog only shows it when it is present and shows nothing
today. Wiring it is a save-RPC change, not a UI one — see the DATA LAYER note above.

### Liquidation from the receipt side (2026-08-06, Step 4)

Renzo: *"I was expecting some UI enhancements to deliveries to be able to liquidate from
there. An **add cheque button in deliveries page** would be nice. Being able to **right
click on a delivery and then assign a cheque to it or add a cheque from a delivery** would
be nice don't you think? That would make the **liquidations page more of a summary page**.
But of course, still being able to do the same things just in a different flow."*

**THE ARCHITECTURAL POINT, AND IT IS THE WHOLE DESIGN: both doors create the SAME
`cenapro.rc_payment_allocation` rows through the SAME RPC.** The write path, the
validation and the vocabulary are built ONCE, in the liquidation module; only the entry
point differs. Nothing about allocation is re-implemented here, and a second
implementation is a bug rather than a variation — two code paths writing money could
disagree about a peso, and one of them would be wrong.

| Affordance | Where | What it calls |
|---|---|---|
| **Add cheque** (toolbar) | `deliveries-ledger.tsx` | the liquidation module's own `PaymentDialog`, **imported not forked** |
| **Assign to a cheque…** (row menu) | `assign-cheque-dialog.tsx` | `allocateDeliveryToPayment` → `cenapro_allocate_delivery_to_payment`, which is built **in SQL on top of** the block RPC |
| **Record a cheque for this / these N…** (row menu, and the toolbar button when rows are selected) | `PaymentDialog` + `allocateOldestFirst` | `savePayment`, then ONE atomic `cenapro_save_rc_payment_allocations` |
| **PAID?** column | `deliveries-ledger.tsx` | reads `DeliveryRecord.settlement`, fetched by `loadChildren` |

#### The PAID? column, and the three rules in it

- **"not priced yet", NEVER ₱0.00.** `total_price_php` COALESCEs a missing weight or price
  to exactly zero, so an unpriced receipt with no payments satisfies "allocated >= total"
  and reads as **settled** under any naive comparison. The view returns `balance_php` as
  **NULL rather than 0** and `stillOwedText()` (liquidation `types.ts`) is the ONE place
  that becomes words. **Confirmed live:** SEVILLA's two 2026-07-14 receipts render
  `TTL PRICE ₱0.00` beside `PAID? → "not priced yet"`, and so does the 2026-08-05 ALI UNGA
  pair (agreed ₱42.00/kg, no weight yet).
- **It uses the LIQUIDATION peso formatter, not this module's.** `formatPeso` here keeps 2
  decimals — right for TTL PRICE, **wrong for a remainder**: 19 receipts price out to
  sub-centavo fractions, so a still-owed ₱0.004 would render `0.00` and read as SETTLED.
  Imported as `formatBalancePeso` with the reason stated at the import.
- **No red, anywhere.** A remainder is ordinary business (decision 8) and
  `over_allocated` is recorded on purpose (decision 13). The only emphasis is amber on
  `unpriced`, which is the one state that hides an unknown. A receipt with no settlement
  row renders an em dash saying so — honest, where a "paid" would be a fabrication.

#### Settlement rides ALONGSIDE the receipt, and is gated harder than `stripPrices()`

- **`cenapro.view_rc_delivery` is untouched.** The Step 4 migration deliberately left this
  module's 60-column read model alone, so settlement arrives from
  `public.cenapro_rc_delivery_settlement` in its own round trip and hangs off
  **`DeliveryRecord.settlement`** — exactly the way the moisture sub-samples do. There is
  no `paid` flag on `cenapro.rc_delivery` and there never will be: it would be a second
  truth about the same money.
- **`loadChildren`** fetches the draws and the settlement **in parallel**, and returns
  their errors SEPARATELY. A samples failure is fatal to the page (a draw is part of the
  receipt's addressable shape); a settlement failure is **not** — 971 receipts are still
  worth showing, and each PAID? cell says it could not load.
- **The settlement fields do NOT join `PRICE_FIELDS`, and cannot.** That list is
  `satisfies readonly (keyof RcDeliveryRow)[]`, and `balance_php` is not a column of this
  read model — the compiler would refuse it. So the gate is **earlier and stronger than
  `stripPrices()`**: `loadSettlements` does not issue the query at all when
  `canViewPrices()` is false, and `buildColumns(false)` drops the PAID? column with the
  other two ₱ columns. **The brief that commissioned this said the new fields "join the
  ones already in `stripPrices()`" — they do not and must not; this is the correction.**
- **`fetchPaymentDimensions` now gates itself.** It used to rely on its only caller
  (`/cenapro/liquidation`) being gated. This page is its second caller and serves gated
  viewers, so a Production role would have been handed CI's bank-account list with the
  account numbers on it. The check moved inside the fetcher.

#### The multi-receipt door reuses the grid operators already have

§7a's reuse note: delivery-first is *"that selection plus one action"*. `selectedDeliveryIds`
reads `useCellSelection`'s existing range — the same instrument that feeds the floating
pill — so a drag, a Shift+click and a Shift+Arrow all reach it with **no new gesture and no
second grid**. A sample sub-row counts as its parent receipt; a draft row counts as
nothing (no id, so no receipt for a cheque to settle).

- **A mixed-supplier selection is REFUSED, naming the traders.** A cheque is always to ONE
  payee (decision 1), so `resolveSelectionPayee` refuses — **unless every trader resolves
  to the same `group_code`**, which is exactly what a subgroup is for. The group comes off
  `view_rc_supplier_group`; nothing guesses it from a name.
- **An unpriced receipt contributes NOTHING to the pre-filled total, and the operator is
  told.** `outstandingTotal` counts `balance_php` over the ALLOCATABLE receipts only and
  reports how many it skipped. Folding an unpriced receipt in at its ₱0
  `total_price_php` would make five receipts "come to ₱4.1M" when one is an unknown — and
  would then mark it settled forever.
- **The pre-filled amount stays EDITABLE.** A trader who wants a round figure is the
  normal case, and the remainder they carry is ordinary business (decision 8). Because the
  post-save distribution is worked out server-side against the view's own figures, a
  rounded-down cheque covers the oldest receipts in full and part-pays the last — which is
  what happens in the yard.
- **The assignment is ONE atomic call.** `allocateOldestFirst` assembles the block on the
  server and writes it once. N per-receipt calls would be N transactions, so a failure
  halfway would leave a **half-applied cheque** — the exact thing the block RPC exists to
  make impossible.
- If the payment saves but the assignment is refused, the toast says **both**: the payment
  is saved and has already moved the balance, and the assignment has to be made from the
  liquidation screen. A quiet half-done act is the worst outcome available.

#### Deleting a receipt that has money against it — WARN, then RELEASE

`cenapro_delete_rc_delivery` gained a third argument and now **REFUSES** with outcome
**`has_allocations`**, carrying the real allocated total and the real cheques. §5c, Renzo:
*"what if an entry was a duplicate and it was already assigned money."*

- The refusal is **a question, not a failure**, so it opens a SECOND `AlertDialog` that
  states the figures — total, count, and one line per cheque with its number and amount —
  rather than a generic scare.
- Confirming re-calls with the release flag. The edges are removed in the same transaction
  and the money **returns to each cheque's unassigned pool** automatically (because
  `unallocated_php` is derived), each with a full-snapshot audit row. It is never
  destroyed: the cheque would otherwise still exist carrying money that no longer adds up.
- **With no allocations the behaviour and the payload are byte-for-byte unchanged.** The
  new argument defaults to false in SQL as well as here, and is only sent when releasing.
- The success toast names what was released, and `revalidatePath('/cenapro/liquidation')`
  fires only when something actually moved.

#### What the column table and the verify script needed

- `PAID?` is in **`PRICE_COLS`**, so `buildColumns(false)` drops all three money columns
  together and the keyboard space keeps no unreachable holes.
- It carries **`field: null`** — settlement is derived state, written by assigning a
  payment, never by typing in the column.
- **`summarySpans` absorbed it with no arithmetic change**, which is what it was built for:
  `PAID?` sits right of TTL PRICE, so the `trailing` lane went 0 → 1 and both summary rows
  already render it. That lane's whole purpose was *"tiles, full stop"* rather than "tiles
  for the two shapes that exist" — this is the third shape arriving and being absorbed.
- **Three assertions in `verify-rc-deliveries-cells.ts` were statements about the OLD
  table and were corrected, not deleted** — the count stays **116**. Each had hard-coded a
  second, undeclared definition of which columns are money: `open.length - gated.length
  === 2` (now derived from the difference against ONE `MONEY_COLS` list),
  `trailing === 0` ("nothing sits right of TTL PRICE today" — now `canViewPrices ? 1 : 0`),
  and `buildColumns(true).length === buildColumns(false).length + 2` (now
  `+ MONEY_COLS.length`). `settle` was also added to the "cells a draw does not have" loop.

### Per-column filters (`?f_<column>=…`, 2026-08-04)

**Filterable:** DATE · TRK# · SUPPLIER · BD · MOIST · GRIT · ASH · DUST · VM · FC ·
WAREHOUSE · REMARKS. **Not filterable:** SKS · WT · PHP/KG · TTL PRICE (Renzo's own
exclusion list).

**Every filter is pushed into the SQL query.** The endless scope is a keyset pager
holding a ~120-row window, not the full 971 rows, so a filter applied to the loaded window
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

**Their `colSpan`s are read off the column table, not counted against its length
(2026-08-04).** They used to say `colSpan={5}`, `spanAll - 7` and
`cols.length - frozenCount - 3`, with a `canViewPrices` ternary standing in for "is TTL
PRICE there". That was correct for both gating states and silently wrong the moment
anyone touched the column table — those constants encode WHERE `wt` and `ttl` sit and
nothing says so, and `buildColumns()` already emits two shapes in production. **`summarySpans(cols)`** in `types.ts` derives the lanes instead: the label runs up to `wt`,
the net-kg figure sits ON `wt`, the duplicate note fills `wt` → `ttl` exclusive, the ₱
cell exists exactly when the `ttl` column does, and a `trailing` filler covers anything
right of it. Insert a column and the lane containing it widens on its own.

- **Both forms tile totally:** `label + weight + note + total + trailing` and
  `frozen + spacer + weight + note + total + trailing` each equal `cols.length`, for ANY
  column table — asserted over both gating states and four mutations of the table.
- **A zero lane renders NO cell.** `colSpan={0}` means "to the end of the column group"
  in HTML, which is the opposite of nothing.
- **`spans.frozen` is `frozenOffsets(cols).length`** — literally the same walk that
  produces the sticky `left` offsets, so the footer's bottom-left corner and the offsets
  can never disagree about where the pinned block ends (see "Frozen panes").
- The ₱ **cell** follows its column so the row always tiles; the ₱ **figure** keeps its
  own `canViewPrices` gate, belt and braces. The two agree by construction.
- Purely a robustness change: both gating states render byte-identically to before. A
  source scan in the verify script now refuses any `colSpan` in the ledger that is not
  `spanAll` or a single `summarySpans` lane.

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
- **`deleteDelivery` was the hole, and it is closed (2026-08-17, BUG-025).** It was the
  ONLY exported action in `actions.ts` that never called `canViewPrices()`, and it returns
  money: the allocated total, the released total, and a `blocking[]` of cheques with
  numbers and amounts — all rendered verbatim in the refusal dialog and the success toast.
  Nothing anywhere checked the caller's ROLE either, and `/cenapro/**` has no route gate,
  so any signed-in user could read a receipt's cheques out of that dialog and then delete
  it. Two changes, both required:
  - **`isPrivileged()` (new, `lib/auth.ts`)** — the canonical Owner/Admin/Dev predicate,
    built exactly like `canViewPrices()` so it honours the impersonation cookie and fails
    closed. `deleteDelivery` refuses with outcome `forbidden` **before** the RPC;
    `page.tsx` resolves `canDelete` server-side and passes it down, and the
    `Delete receipt…` item is `hidden` for everyone else (the same shape as RC IN's
    `hidden: () => !hasPermission('delete:all')`). The UI hiding a control is not a gate —
    the server check is the one that holds.
  - **The ₱ redaction** — when `!canViewPrices()` the action returns `allocatedPhp: null`,
    `releasedPhp: null` and **`blocking: []`**, plus **`pricesHidden: true`**. The COUNTS
    survive. The dialog then reads *"…has money assigned to it from 2 payments. The amounts
    are hidden by your role."* — it must **never** render a blank where the figure was,
    because that reads as *"nothing is assigned to this receipt"*, which is the one thing
    that would make a gated viewer delete it confidently and wrongly. Same principle as
    `redactAuditJson`: a hidden figure still announces itself rather than lying by silence.
  - `blocking` being emptied server-side is deliberate belt-and-braces: the cheque list's
    `<ul>` is already `.length > 0`-gated, so even an unguarded future render of it cannot
    leak a cheque number.
- **The audit view is the one ₱ surface `stripPrices()` cannot protect — and it is now
  read.** `public.cenapro_rc_delivery_audit` carries `changed` / `snapshot` as free-form
  jsonb containing every column, `total_price_php` included. `stripPrices()` nulls **named
  fields on a row shape** — it will not reach inside a jsonb blob. **`getDeliveryHistory`
  therefore deletes the ₱ keys out of the jsonb** with `redactAuditJson(raw, showPrices)`
  before the payload returns. Both it and `stripPrices()` read the ONE shared list
  **`PRICE_FIELDS`** (`types.ts`), which is `satisfies readonly (keyof RcDeliveryRow)[]`
  so a typo cannot silently redact nothing. **Any future action that reads this view must
  go through `redactAuditJson` too** — the fields list has two consumers today and must
  never grow a third definition. See "Audit trail" above for the full decision, including
  why a price-only change still renders and why `deduction_pct` is not in the list.

### Motion

**No animation on rows, cells or selection** — no stagger, no transition on the active
ring, the range tint, the cell tints or the draft rows. The only animated chrome is the
toolbar (`animate-fade-in` on the unsaved-count chip and on each active-filter chip), the
toolbar's own frosted bar (`bg-background/95 backdrop-blur
supports-backdrop-filter:bg-background/60`), the two `AlertDialog`s — the delete
confirmation and the unsaved-work guard — which inherit `animate-modal-enter` and the
dialog glass from `AlertDialogContent` itself rather than declaring their own, and the
history `Dialog`, which declares `animate-modal-enter` explicitly (`DialogContent` ships
the glass but not that entrance) and animates **nothing** inside itself. Row hover is
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
- Shadcn: `button`, `input`, `popover`, `alert-dialog`, `dialog`, `dropdown-menu`.
- **`../liquidation/` — a REAL and DELIBERATE dependency since 2026-08-06.** `types.ts` imports
  the settlement vocabulary (`SETTLEMENT_LABEL`, `NOT_PRICED_TEXT`, `stillOwedText`,
  `settlementStatus`, `outstandingTotal`, `resolveSelectionPayee`, `receiptLabel`,
  `DeliverySettlementRow`); `actions.ts` imports the row type; the ledger imports
  `PaymentDialog`, `allocateOldestFirst` and `fetchSettlementsFor`; `page.tsx` imports
  `fetchPaymentDimensions`. **Both are Cenapro tenant code, so this crosses no layer**, and
  `liquidation/types.ts` is a PURE module (no React, no Supabase, no `'use client'`) so nothing
  is dragged into the bundle. It is one vocabulary and one write path shared by two doors — the
  alternative is two definitions of what a settled receipt is.
- **Not a dependency, and must never become one:** `app/(app)/inventory/rc-in/components/`
  (`DeliveryHistoryDialog.tsx`, `audit-shared.tsx`, `lib/field-labels.ts`). ICTC's history
  UI is the model for this module's dialog and is imported by exactly nothing here — it is
  wired to `public.audit_logs` + `audit_comments` + notifications, and the tenant wall
  forbids the coupling.

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
