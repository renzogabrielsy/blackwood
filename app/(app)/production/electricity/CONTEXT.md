# Production — Electricity Tab

## Purpose
Daily electricity meter readings (MAIN / BUNKHOUSE / PUMP) with computed DIFF and CONSUMPTION (KWH).

> **Schema reworked 2026-05-29 (backend + frontend, shipped):** `electricity_readings.rate_php_per_kwh` was renamed to **`meter_multiplier`** (NOT NULL DEFAULT 120) and a generated stored column **`consumption_kwh` = (end_kwh − start_kwh) × meter_multiplier** was added. The `120` was never a peso rate — the source email labels it a "METER MULTIPLIER" and computes `CONSUMPTION (KWH) = diff × 120` (PRODUCTION_DESIGN.md §15.2 Section D). **There is no peso cost in this data.** The DB layer (`actions.ts`, `types/supabase.ts`) and the UI (`electricity-grid.tsx`) are both updated: the grid's two rightmost data columns are now **MULT** (editable `meter_multiplier`, default 120) and **TTL KWH** (computed `diff × multiplier`, plain right-aligned number — no ₱).
>
> **Note:** The monthly summary table (fed by `view_electricity_monthly`) was removed (May 2026) — the format was undesired. The `view_electricity_monthly` DB view was **DROPPED 2026-05-29** (it referenced the old column and computed bogus peso math; nothing queried it).

## Files
| File | Role |
|------|------|
| `actions.ts` | `fetchElectricityTabData(year, month)`, `saveBulkElectricity`. Defines `BulkSavePayload` locally. **Human-edit latch (2026-08-03):** every insert/update also passes `human_edited_at` via the local `claim()` helper, so the row is marked as yours and the sync will not overwrite it. The DB trigger `fn_stamp_human_edit` is the actual guarantee (it also fills `human_edited_by` from `auth.uid()`); hand a row back with `releaseProductionRows` in `app/(app)/production/actions.ts`. See the module CONTEXT → "Human-edit latch". |
| `electricity-view.tsx` | Scope-label wrapper (shows "Showing: {scope}") — renders the grid `hidden sm:block` + `ElectricityCardsMobile` `sm:hidden` (`h-[70dvh]`). Accepts `year: number\|null`, `month: number\|null`, and `v2?: boolean` — which of the two desktop grids to render. The phone card list is outside the switch and identical on both sides. |
| `electricity-grid.tsx` | Inline-editable grid for `electricity_readings` (desktop, unchanged) |
| `electricity-grid-v2.tsx` | **READ-ONLY Blackwood Table rendering of the same readings** (`?grid=v2`, 2026-08-18). Built beside `electricity-grid.tsx`, which is unchanged. Nine columns at the live grid's own widths (Σ 668px = the live 688px minus its 20px delete column); sticky header, **no frozen columns**, no totals footer (the live grid has none either). DIFF and TTL KWH mirror the live grid's CLIENT-side `end − start` / `diff × mult` rather than the DB's generated columns, so the two sides agree cell for cell. `#`, DIFF and TTL KWH are `addressable: false` — they render and sweep into a rectangle while the caret steps over them. Read-only STRUCTURALLY: no spec declares `parse` or `editable`. The REM popover becomes an icon + native `title` (the remark is readable, not writable). See the module CONTEXT → "The `?grid=v2` side-by-side". |
| `electricity-cards-mobile.tsx` | **Phone read layer** (`sm:hidden`) — simplest Archetype C `MobileCardList` over the `readings` rows. Headline `date · meter · TTL KWH · [start→end]`; detail = start/end/diff/mult/consumption/remarks. DIFF + TTL KWH read off the DB generated columns. Read-only — no editing/keyboard/paste. |

## Column Order
`#` / DATE / METER (Select + custom) / START KWH / END KWH / DIFF (computed, read-only) / MULT (`meter_multiplier`, editable, default 120) / TTL KWH (consumption — computed `diff × multiplier`, read-only) / REM / [delete]

All columns always render (no price gating). DIFF and TTL KWH are read-only/computed; TTL KWH renders as a plain right-aligned `font-mono` number with no ₱ symbol. The DB regenerates the stored `consumption_kwh` column on save, so the UI computes TTL KWH client-side only for live preview and never sends it in the payload.

## Key Behaviors
- **Inline editing (shared Blackwood Table primitives):** keyboard nav + the edit session are driven by `useGridKeyboardNav` (coordinate resolver via `createCoordinateNavResolver({ rowCount, columnMap: COL_MAP })`) + `useGridEditSession` — see `components/shared/grid/CONTEXT.md`. `enableEnterAnchor: false` (plain Enter drops straight down). `revertChanges` is kept custom (NOT the session's) to preserve the `_state: 'modified' → 'existing'` rollback. `Home`/`End` are intercepted before the shared handler (Home → col 1, End → `COL_COUNT - 2`, i.e. REMARKS — the trailing delete column is skipped). `handleSmartPaste` stays local because it must mark `_state='modified'` + maintain the trailing empty row (the generic `useGridPaste` cannot express that). The reference wiring is `app/(app)/inventory/rc-in/bulk-delivery-input.tsx`.
- **Focus never scrolls (2026-08-04):** `HTMLElement.focus()` scrolls its target into view with block AND inline `"center"` through every scrolling ancestor, and `"center"` always computes a target — so it fires even when nothing moved, re-centring the row and dragging the page. All three `gridRef.current?.focus()` sites (single-cell click, the custom `revertChanges`, the Tab/Enter commit) now pass **`{ preventScroll: true }`**. Focus still moves; only the scroll is refused. **CLOSED 2026-08-05:** the 5 cell editors now pass **`ref={focusNoScroll}`** (`lib/utils.ts`) instead of `autoFocus`. React's `autoFocus` prop is unfixable from the outside — react-dom's `commitMount` is a bare `domElement.focus()` with no options — so the prop must simply not be used on a cell editor. The ref callback lands in the same commit/layout phase and, like react-dom, calls no `select()`/`setSelectionRange()`, so caret behaviour is byte-identical. Same idiom as `components/shared/grid/EditInput.tsx`. See "Focus must never scroll" in `components/shared/grid/CONTEXT.md`.
- **Row borders DO render here — this grid is plain `border-collapse` (2026-08-05).** The Daily and Trucks ledgers are `borderCollapse: 'separate'`, where the CSS spec paints borders on table CELLS ONLY and a `<tr>`-level `border-b` is ignored outright; both had to move their row rules onto the cells. This table sets `border-collapse` (collapse) on the `<table>`, so its header row's `border-b border-foreground/20` and the body rows' rules paint normally. **Do not "fix" what is not broken here** — and if this grid ever gains sticky frozen columns and therefore has to switch to `separate`, every row-level border in it becomes inert in the same instant.
- **Escape-after-Delete audit (2026-08-04) — no gap, nothing changed:** a **single-cell** Delete/Backspace goes through `useGridKeyboardNav`'s `edit.start(active, '')`, which snapshots the pre-edit value before blanking, so Escape reverts it (through the custom `revertChanges`, which also rolls `_state` back to `'existing'`). A **range** Delete runs `useCellDelete` → `clearCell` (writes `''` through `updateRow`, no snapshot) and the shared hook then drops the selection — not undoable, and deliberately left that way: rows are mutated in place with a `_state` flag and carry **no per-cell stored value** to revert to. Discard, which rebuilds from the fetched readings, is this grid's undo at the granularity it actually has.
- **Meter select:** MAIN / BUNKHOUSE / PUMP dropdown; choosing "Other (type manually)" switches to free-text Input for that row. (This uses the shadcn `<Select>`, NOT the shared `SelectCell` — left unchanged in the migration since it is not a GridCell-style dropdown.)
- **No price gating:** MULT and TTL KWH are operational kWh data (not sensitive pricing) — always visible to all roles. The grid no longer imports `useAuth`/`hasPermission`.
- **Computed DIFF:** `diff_kwh` is a generated DB column (`end_kwh - start_kwh`), shown as read-only muted cell
- **Computed TTL KWH (consumption):** `consumption_kwh` is a generated DB column (`(end_kwh - start_kwh) × meter_multiplier`) — raw kWh, NOT pesos. The UI mirrors this client-side (`diff × meter_multiplier`) for live preview as the user edits MULT; the value is not written (DB regenerates it).
- **Validation:** end_kwh ≥ start_kwh, meter_multiplier ≥ 0 — enforced server-side in `saveBulkElectricity` (note: DB CHECK requires meter_multiplier > 0; insert/update default falls back to 120, so an empty or `0` MULT cell saves as 120)
- **Empty state:** `animate-fade-up` message "Awaiting Production Manager sync..."
- **Error toasts:** `errorToast()` from `lib/toast.ts`

## Hooks Used
- `useGridKeyboardNav` + `createCoordinateNavResolver`, `useGridEditSession` — shared Blackwood Table keyboard/edit primitives (see `components/shared/grid/CONTEXT.md`)
- `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useStatusBar`

## Server Action Contract
```ts
saveBulkElectricity(payload: BulkSavePayload<TablesInsert<'electricity_readings'>, TablesUpdate<'electricity_readings'>>)
  => Promise<{ ok: true, insertedCount, updatedCount, deletedCount } | { ok: false, error: string }>
```

## Data Fetch
`fetchElectricityTabData(year?: number | null, month?: number | null)` — filters `electricity_readings` by `reading_date`. Driven by the **module-level shared period** (see `production/CONTEXT.md` → "Universal Period Control"):
- `year=null` → all readings (no date filter)
- `year=<num>, month=null` → all readings in that calendar year
- `year=<num>, month=<n>` → that month of that year (`month` is 0-indexed)

The `electricity-lazy-tab` derives `month = batchToMonth(batch)` from the shared batch before calling (unrecognized/null batch → null month → whole year). `undefined` args fall back to the current month for backwards compatibility. Returns `{ data: { readings, year, month } }`.
