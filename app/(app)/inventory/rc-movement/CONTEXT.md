# RC Movement Module — Daily Feed Matrix

## Purpose
A cross-tab / pivot of feeding activity, mirroring how the user reasons about a cycle-month at a glance: **days as rows, opened blocks as columns, kg-fed in the cells.** This IS the **Movement tab** inside `/inventory` — the dense matrix surfaced through the inventory tab system.

> **Domain Module (Charcoal Tenant):** Tenant-specific. Reads the charcoal-shaped `view_rc_movement` SQL view (plus `rc_out` for the per-day production batch). Lives in the inventory/charcoal layer — never imported by platform widgets.

> **Single view now.** The earlier flat-list Movement view (one row per (date, batch lane)) was **retired** — the user decided the matrix is the correct presentation. There is **no standalone `/inventory/rc-movement` route** anymore; the folder holds only the matrix component + its server action, and the matrix is mounted as a lazy tab from `../components/rc-movement-matrix-lazy-tab.tsx`.

## Files
| File | Lines | Role |
|------|-------|------|
| `actions.ts` | ~250 | Backend. Single server action `fetchRcMovementMatrix(month?)` → `RcMovementMatrix`: pivots `view_rc_movement` into ordered block-columns × calendar-day-rows; also queries `rc_out` for the dominant non-null `production_batch` per date. Paginated `.range()` loops bypass PostgREST's 1000-row cap. |
| `rc-movement-matrix.tsx` | ~360 | **Matrix** client table. Frozen-pane sticky table: 5 pinned left columns (Row # / Date / Day / Batch / Total fed) + frozen header row + pinned top-left corner. Dynamic block columns scroll horizontally. `table-fixed`, explicit px widths, `h-8` rows, mono right-aligned numerics, thousands separators, blank zero cells. Month picker (shadcn `Select`) calls an `onMonthChange?(month)` prop — the parent lazy tab owns month state and re-fetches. Block column headers are **clickable** → open the shared `BlockingDetailPanel` (slide-over) for that column's batch. No router/navigation for the month picker. |

> The folder has **no `page.tsx`** — without it, `/inventory/rc-movement` is not a route. The matrix is reached only via the Movement tab in `/inventory`.

## Data
- **Source:** `view_rc_movement` (defined in `supabase/migrations/20260525000000_create_view_rc_movement.sql`) + `rc_out` (for the per-day production batch)
- **Server action:** `fetchRcMovementMatrix(month?)` from `app/(app)/inventory/rc-movement/actions.ts`
- **Types:** `RcMovementMatrix`, `RcMovementMatrixColumn`, `RcMovementMatrixRow`, `RcMovementMonthOption` (all in `actions.ts`)
- **No price/role gating in v1** — the matrix shows kg only; prices/lab are deferred.

### `RcMovementMatrix` shape
```typescript
{
  month: string;                  // resolved YYYY-MM
  columns: Array<{                // ordered by firstFedDate, tie-break batchCode
    batchId: string;
    batchCode: string;
    blockLoc: string | null;      // '' / null FEED blocks -> null
    firstFedDate: string;         // YYYY-MM-DD
  }>;
  rows: Array<{                    // every calendar day, first→last feed date
    rowNum: number;               // 1-based
    date: string;                 // YYYY-MM-DD
    dayOfWeek: string;            // Mon/Tue/…
    productionBatch: string | null; // dominant non-null rc_out.production_batch for the day
    totalFed: number;             // sum of fed_today across blocks (kg)
    fedByBatch: Record<string, number>; // batchId -> kg (absent = blank cell)
  }>;
  monthOptions: Array<{ value: string; label: string; feedDays: number }>;
}
```

## Key Behaviors
- **Concept:** cross-tab / pivot. ROWS = every calendar day from the cycle's first feed date to its last (zero-feed days **included** so open/close edges show as gaps). COLUMNS = each opened block consumed that month, "spawned" in chronological order of FIRST feed date (tie-break `batch_code` ASC). CELLS = kg fed from that block on that day (blank when none).
- **No price/lab columns yet** — explicitly deferred. `view_rc_movement` exposes `php_*`/balance fields; the matrix ignores them in v1.
- **Pure reshaping:** `fed_today` is already SQL-aggregated. TS only sums already-aggregated `fed_today` for the per-day row total — no inventory math derived in TS (respects CLAUDE.md rule).
- **"Batch" left column = production batch** being made that day. `view_rc_movement` does not carry `production_batch`, so `fetchRcMovementMatrix` separately queries `rc_out` grouped by `transaction_date` and maps the **dominant non-null** `production_batch` (by summed weight) onto each row. Kept isolated → one-column change if interpretation differs. NULL `production_batch` rows are excluded from the dominance vote (they routinely out-weigh the labeled value but carry no batch identity).
- **Default month:** most recent month with `feedDays > 2` (skips a 1-day month like 2026-06). The lazy tab starts with no month selected (empty string), letting the action resolve this default; the resolved value comes back on `data.month` and the Select reflects it.
- **Frozen panes (canonical pattern — see CLAUDE.md "Frozen Panes" + `globals.css`):** 5 left columns pinned via cumulative `left` offsets (Row #=48 / Date=100 / Day=52 / Batch=96 / Total fed=88); header row pinned `top:0`; top-left corner pinned in both axes. Uses the shared `.frozen-col` / `.frozen-row` / `.frozen-corner` utilities — z-scale: **corner 30 > header row 20 > frozen body col 10 > normal scrolling cells**. **All frozen surfaces are fully OPAQUE** (corner/header `bg-muted` solid, body `bg-background` solid — NEVER the `/opacity` glass pattern, which lets scrolling content bleed THROUGH the pinned cells). Frozen body cells repaint the hover tint opaquely via `group-hover:bg-accent` over the opaque base so pinned and scrolling cells match. The table uses `border-separate` + `borderSpacing:0` (NOT `border-collapse`) — collapsed borders make sticky-cell backgrounds render transparent, so the frozen columns would bleed; `border-separate` keeps each cell's opaque background painting. The last frozen column (Total fed) carries `.frozen-edge` (solid inset right border + soft shadow) to kill the 1px boundary seam.
- **No virtualization:** ~44 cols × ~31 rows (~1.3k cells) — a plain sticky `<table>` is sufficient and simpler.
- **Density:** `table-fixed` + `<colgroup>` explicit px widths, `px-2 py-1`, `text-xs`, `h-8` rows. Numerics `font-mono tabular-nums`, right-aligned, integer kg, thousands separators, blank for zero. Active (fed) cells get a subtle `bg-emerald-500/10` tint.
- **Block column header (clickable → detail panel):** `batch_code` (mono bold) over `block_loc` muted subline; full code + block + open-date in a Tooltip ("Click to view batch details"). The whole header is a `<button>` inside the frozen-row `<th>` — affordance is `cursor-pointer` + `hover:bg-accent` (and `bg-accent` while selected) layered over the OPAQUE `bg-muted` frozen surface (no `/opacity` on the sticky cell, so no bleed-through). Keyboard-focusable with `focus-visible:ring`. Clicking opens the shared **`BlockingDetailPanel`** (the same slide-over the Blocking tab uses) for THAT column's batch.
  - **Batch-accurate, not loc-accurate:** the panel must show the matrix column's specific batch even for historical months where the slot was later reused or the batch was closed. Detail history is fetched batch-keyed via the Blocking module's `fetchBlockingDetail(batchCode, batchId)`. The **header summary** (`BlockData`: status / balance / total_in / php / lab weighted-avgs) is fetched via a new Blocking action **`fetchBlockDataForBatch(batchId)`** — it computes the same metrics `view_blocking_grid` produces but keyed on `batch_id` with **no status/loc filter**, so a CLOSED/reused batch (absent from the view) still resolves. `canViewPrices` comes back from that same call.
  - **State:** `selectedColumn` / `panelBlockData` / `panelCanViewPrices` live in `RcMovementMatrix`. On header click: set the column (panel slides open), clear `panelBlockData` (panel shows its loading/blank state), then fill from `fetchBlockDataForBatch`. The panel's display `locKey` = `column.blockLoc ?? column.batchCode` (FEED columns have no loc; the panel's `parseLocKey` tolerates the non-loc key and just hides the "WHSE/Col/Row" subline). The panel owns its own close/Escape/scroll-lock.
- **Weekend cue:** Sat/Sun day-of-week label tinted amber.
- **Month picker:** shadcn `Select` showing `Month YYYY` + feed-day count; selection calls the `onMonthChange` prop → the lazy tab updates its `month` state → re-fetch. No URL navigation, no page reload — state-driven within the tab.
- **Glass vs frozen:** the month-picker Select dropdown uses glass (`bg-popover/95 backdrop-blur-lg`) because it floats over empty space. Frozen header/column/corner surfaces are the OPPOSITE — fully opaque (see Frozen panes above), since they overlap scrolling content. Empty state `animate-fade-up`. No row stagger/entrance animation (per CLAUDE.md).

### Lazy loading (tab integration)
- `app/(app)/inventory/components/rc-movement-matrix-lazy-tab.tsx` is the client host. It owns `month` state, fetches `fetchRcMovementMatrix(month || undefined)` on first render and whenever `month` changes, shows a `Loader2` spinner while loading, and renders `<RcMovementMatrix data={…} onMonthChange={setMonth} />`.
- Mounted by `inventory-view.tsx` for the `'movement'` tab via `getTabClass('movement')`, so it lazy-mounts on first reveal and **stays mounted** (visibility toggled, state preserved) like the other tabs.
- Month switching re-fetches the server action **without a page reload** — the spinner shows only when there is no prior data.

## Dependencies
- `@/lib/supabase/server` — used by `actions.ts` (server-side only)
- `@/components/ui/select` — month picker in the matrix
- `@/components/ui/tooltip` — block-column header tooltip (batch code + block + open date)
- `@/lib/utils` — `cn()` for the matrix's frozen-cell class composition
- `lucide-react` — `Loader2` (spinner in the lazy tab)
- `../blocking/blocking-detail-panel` — `BlockingDetailPanel` reused for the column-header slide-over (cross-module import into the Blocking tenant module)
- `../blocking/actions` — `fetchBlockDataForBatch(batchId)` (batch-accurate header summary) — the matrix calls this; detail history is fetched by the panel itself via `fetchBlockingDetail`
- `../blocking/types` — `BlockData` (panel header-summary shape)

## See Also
- [RC IN](../rc-in/CONTEXT.md) — Source of `deliveries.lab_results`, `deliveries.cost_basis`, `deliveries.block_loc` which feed `view_rc_movement` via `batch_meta` CTE
- [RC OUT](../rc-out/CONTEXT.md) — Source of `rc_out.weight_kg`, `rc_out.transaction_date`, and `rc_out.production_batch` which feed the matrix
- [Blocking](../blocking/CONTEXT.md) — Sibling visualization showing physical warehouse occupancy. **Owns the shared `BlockingDetailPanel`** that the matrix's clickable column headers reuse, plus `fetchBlockDataForBatch` (batch-accurate header summary for the panel).
- [Inventory](../CONTEXT.md) — Parent module that owns the tab system; the Movement tab mounts this matrix
- Reference frozen-pane implementation alongside the Cenapro production ledger (`app/(app)/cenapro/production/production-ledger-grid.tsx`)
