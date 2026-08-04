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
| `types.ts` | **PURE module** (no `'use client'`, no server tag) — the shared vocabulary, imported by the server page, the server actions, the client grid AND the verify script. Owns: the generated-type-derived row shapes; `stripPrices()` (the ONE ₱ boundary); the column table + `buildColumns` / `frozenOffsets` / `minTableWidth`; **`parseSupplierCell` / `formatSupplierCell`** and **`parseDestinationCell` / `formatDestinationCell`** (the single-column ⇄ multi-field pairs); `weightEditText` / `priceEditText` (the formula round-trip); `sampleFieldFor` (which columns a sub-row occupies); the display formatters; `rowIssues` / `readImportFlags`; and the save-payload contracts. |
| `ledger-url.ts` | **PURE module** — the URL axes: `parseScope`, `resolvePeriod` / `periodBounds` / `periodLabel`, `parseIssueLens` (+ `ISSUE_LABELS` / `ISSUE_HINTS`), `parseQuery`, `axesKey`. No React, no Next imports, so the server page and the client toolbar share one contract without a boundary hazard (same discipline as `production/ledger-url.ts`). |
| `actions.ts` | **`'use server'`** — reads AND writes. `fetchDeliveryPage` (bidirectional keyset pager), `fetchDeliveryMonth` (focus), `fetchDeliveryDimensions`, `fetchDeliveryMonthKeys`, `saveDeliveries`, `deleteDelivery`. Enforces the ₱ gate on every read and every write, and sequences a combined field+samples save. |
| `use-deliveries-window.ts` | **Client hook** — `useDeliveriesWindow(initial, lens)`: the endless sheet's self-contained bidirectional keyset pager (no TanStack Query, mirroring `production/use-ledger-window.ts`). Owns react-virtuoso's `firstItemIndex` so a prepend and its index decrement land in one state batch. Exposes `fetchOlder` / `fetchNewer` / `reset` / `refreshWindow` / `dropRecord`. |
| `deliveries-ledger.tsx` | **Client** — the grid. Both scopes, one set of closures. Custom `NavResolver`, edit state, cell renderers, toolbar, context menu, save, delete. |
| `../../../../scripts/verify-rc-deliveries-cells.ts` | Framework-free assertions over the two single-column pairs + the column geometry, ending in a **replay over all 991 real receipts**. `npx tsx scripts/verify-rc-deliveries-cells.ts` — 20 assertions, must stay green. |

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
  `(delivery_date, id)`, server-prefetched first window. Month boundaries show as a badge
  on the date cell.
  - **NULL dates are handled explicitly.** Canonical order is `delivery_date ASC NULLS
    FIRST, id ASC`, and a plain `delivery_date.gt.X` never matches a NULL — so the two
    undated receipts would sit at the head of history and be permanently unreachable.
    `keysetPredicate()` names the NULL group in both directions. Verified live against
    PostgREST.
- **focus** — month-scoped (`?year=&month=`), day-grouped, with `Σ DAY TOTAL` rule-off
  rows and a **sticky month footer**.

### Frozen panes

`# · DATE · TRK# · SUPPLIER` are frozen with cumulative `left` offsets. Every frozen cell
is **fully OPAQUE** (`bg-background` body / `bg-muted` header — never glass, no alpha, no
`backdrop-blur`), `.frozen-edge` sits on the last frozen column, and the **active-cell
ring is at `z-20`** so it clears `.frozen-col` (z-10). The month footer's bottom-left
corner is `.frozen-corner-bottom` + `.frozen-edge` and spans **exactly** the frozen block
— no further, or it would overhang into scrolling territory.

### Data-quality surfacing

The import deliberately kept bad rows visible rather than fixing them, so the UI surfaces
them rather than smoothing them over:

| State | Treatment |
|---|---|
| `is_suspected_duplicate` (22 rows) | Rose inset rail on the frozen block + a `DUP` badge + a rose row wash. **THREE consecutive days are pasted twice, ₱17,185,939 in total** — 2026-04-06 (9 rows, ₱6.94M), 04-07 (7 rows, ₱5.32M), 04-08 (6 rows, ₱4.93M). *(An earlier draft of this note said "the 2026-04-06 block, roughly ₱7M"; that is only the largest of the three — corrected 2026-08-04 from live counts.)* Every day total and the month footer carry an explicit "includes … from suspected duplicates" line, so nothing is silently double-counted — but **the human decision to keep or drop them has not been made.** |
| `has_import_flags` (34 rows) | Sky rail + a warning icon opening a **popover** with each flag's `kind` / `detail` / the workbook's original `raw` text. |
| `supplier_unresolved` / `destination_unresolved` (1 / 5 rows) | Amber rail + a `MAP?` badge; the cell shows the raw text; a save is refused until it resolves. |
| unparseable date (2 rows) | Amber triangle in the date cell, with `delivery_date_raw` in the title. |

Each is also a **URL lens** (`?issue=duplicate|unmapped|flagged|undated`), pushed into the
SQL query rather than filtering after the fact, so a link to "the 22 suspected duplicates"
is shareable.

### Totals

Day totals and the month footer are **SUMS OF STORED COLUMNS** (`net_weight_kg`,
`total_price_php` — both DB-generated, exact decimal), not arithmetic re-derived from
gross × deduction × rate. A rule-off line adds up the numbers already on screen; it does
not recompute them.

### Save

One Save button, batching every dirty receipt. **Validation runs first and a single bad
cell blocks the WHOLE batch** — half-committing a sheet an operator is midway through is
worse than refusing it, because they would then have to work out which rows landed. The
error toast names every offending receipt.

A receipt with both field edits and sample edits is **sequenced server-side**: the field
patch runs first (bumping `row_version` via the `fn_touch_rc_delivery` trigger) and its
returned version is threaded into the samples call. Firing both with the same expected
version would make the second conflict with the first. Nothing retries and nothing
force-writes — a genuine `version_conflict` means another human moved.

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
ring or the cell tints. The only animated chrome is the toolbar (`animate-fade-in` on the
unsaved-count chip) and the toolbar's own frosted bar
(`bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60`). Row hover is
`transition-colors duration-150`.

### Errors

Every error surface goes through **`errorToast()`** (persistent + Copy button, per the
HARD RULE). The load-error banner carries its own inline Copy button. Success/info
messages use sonner directly.

---

## Dependencies

- `@/components/shared/grid` — `EditInput`, `GridContextMenu` + `GridMenuItem`.
- `@/lib/hooks/use-grid-keyboard-nav` (`useGridKeyboardNav`, `CoordinateId`,
  `NavResolver`), `use-grid-edit-session`, `use-grid-paste`, `use-grid-context-menu`.
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
