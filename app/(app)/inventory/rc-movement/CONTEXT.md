# RC Movement Module — Daily Feed Matrix

## Purpose
A cross-tab / pivot of feeding activity, mirroring how the user reasons about a cycle-month at a glance: **days as rows, opened blocks as columns, kg-fed in the cells.** This IS the **Movement tab** inside `/inventory` — the dense matrix surfaced through the inventory tab system.

> **Domain Module (Charcoal Tenant):** Tenant-specific. Reads the charcoal-shaped `view_rc_movement` SQL view (plus `rc_out` for the per-day production batch). Lives in the inventory/charcoal layer — never imported by platform widgets.

> **Single view now.** The earlier flat-list Movement view (one row per (date, batch lane)) was **retired** — the user decided the matrix is the correct presentation. There is **no standalone `/inventory/rc-movement` route** anymore; the folder holds only the matrix component + its server action, and the matrix is mounted as a lazy tab from `../components/rc-movement-matrix-lazy-tab.tsx`.

## Files
| File | Lines | Role |
|------|-------|------|
| `actions.ts` | ~250 | Backend. Single server action `fetchRcMovementMatrix(month?)` → `RcMovementMatrix`: pivots `view_rc_movement` into ordered block-columns × calendar-day-rows; also queries `rc_out` for the dominant non-null `production_batch` per date. Paginated `.range()` loops bypass PostgREST's 1000-row cap. |
| `rc-movement-matrix.tsx` | ~520 | **Matrix** client table. Frozen-pane sticky table: 5 pinned left columns (Row # / Date / Day / Batch / Total fed) + frozen header row + pinned top-left corner **+ frozen summary footer pinned to the container bottom** (per-column stacked summary + bottom-left corner). Dynamic block columns scroll horizontally. `table-fixed`, explicit px widths, `h-8` rows, mono right-aligned numerics, thousands separators, blank zero cells. Month picker (shadcn `Select`) calls an `onMonthChange?(month)` prop — the parent lazy tab owns month state and re-fetches. Block column headers are **clickable** → open the shared `BlockingDetailPanel` (slide-over) for that column's batch. No router/navigation for the month picker. |

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
    // ── Footer summary (computed in ONE batched pass over the month's batches) ──
    totalOut: number;             // all-time SUM(rc_out.weight_kg) for this batch (= total fed)
    totalIn: number;              // all-time SUM(deliveries.weight_kg) for this batch
    status: string;               // batches.status -> IN-USE (blue) / else CLOSED (red) badge
    mc: number;                   // weighted-avg moisture % (0 when no metric-bearing deliveries)
    ash: number;                  // weighted-avg ash %
    blockLoss: number | null;     // (totalOut - totalIn) / totalIn, signed ratio; null when totalIn = 0
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
  grandTotalFed: number;          // SUM of fed_today across the visible month (footer grand total, kg)
}
```

## Key Behaviors
- **Concept:** cross-tab / pivot. ROWS = every calendar day from the cycle's first feed date to its last (zero-feed days **included** so open/close edges show as gaps). COLUMNS = each opened block consumed that month, "spawned" in chronological order of FIRST feed date (tie-break `batch_code` ASC). CELLS = kg fed from that block on that day (blank when none).
- **No price/lab columns yet** — explicitly deferred. `view_rc_movement` exposes `php_*`/balance fields; the matrix ignores them in v1.
- **Pure reshaping:** `fed_today` is already SQL-aggregated. TS only sums already-aggregated `fed_today` for the per-day row total — no inventory math derived in TS (respects CLAUDE.md rule).
- **"Batch" left column = production batch** being made that day. `view_rc_movement` does not carry `production_batch`, so `fetchRcMovementMatrix` separately queries `rc_out` grouped by `transaction_date` and maps the **dominant non-null** `production_batch` (by summed weight) onto each row. Kept isolated → one-column change if interpretation differs. NULL `production_batch` rows are excluded from the dominance vote (they routinely out-weigh the labeled value but carry no batch identity).
- **Default month:** most recent month with `feedDays > 2` (skips a 1-day month like 2026-06). The lazy tab starts with no month selected (empty string), letting the action resolve this default; the resolved value comes back on `data.month` and the Select reflects it.
- **Frozen panes (canonical pattern — see CLAUDE.md "Frozen Panes" + `globals.css`):** 5 left columns pinned via cumulative `left` offsets (Row #=48 / Date=100 / Day=52 / Batch=96 / Total fed=88); header row pinned `top:0`; top-left corner pinned in both axes. Uses the shared `.frozen-col` / `.frozen-row` / `.frozen-corner` utilities (plus the new footer mirrors `.frozen-row-bottom` / `.frozen-corner-bottom` / `.frozen-edge-top`, see globals.css) — z-scale: **corner(s) 30 > header/footer row 20 > frozen body col 10 > normal scrolling cells**. The footer is the bottom-pinned mirror of the header (`bottom:0` instead of `top:0`). **All frozen surfaces are fully OPAQUE** (corner/header `bg-muted` solid, body `bg-background` solid — NEVER the `/opacity` glass pattern, which lets scrolling content bleed THROUGH the pinned cells). Frozen body cells repaint the hover tint opaquely via `group-hover:bg-accent` over the opaque base so pinned and scrolling cells match. The table uses `border-separate` + `borderSpacing:0` (NOT `border-collapse`) — collapsed borders make sticky-cell backgrounds render transparent, so the frozen columns would bleed; `border-separate` keeps each cell's opaque background painting. The last frozen column (Total fed) carries `.frozen-edge` (solid inset right border + soft shadow) to kill the 1px boundary seam.
- **Frozen summary footer (bottom-pinned, mirror of the header) — COMPACT 2-LINE layout, WHOLE-CELL state tint, MC/Ash in a hover tooltip:** a sticky `<tfoot>` pinned to the container bottom (`bottom:0`). Each per-column cell is **two tight lines** (`px-2 py-0.5`, no inter-line gap) wrapped in a `Tooltip`/`TooltipTrigger` (reusing the table's existing `TooltipProvider`); the trigger content carries `cursor-default`:
  - **Line 1 (headline):** a `flex justify-between` row — tiny `text-[10px]` uppercase muted `fed` label pinned left + total fed kg (`totalOut`, bold `font-mono text-xs`) pinned right, mirroring the loss row's label/value rhythm.
  - **Line 2 (loss):** a `flex justify-between` row — tiny `text-[10px]` uppercase muted `loss` label pinned left + the signed block-loss % (`fmtSignedPct(blockLoss)`, `font-mono text-[10px]`) pinned right. "—" when `blockLoss` is null.
  - **MC & Ash live in the hover tooltip** (de-clutters the previously cramped 3-col `mc | ash | loss` grid, which was REMOVED). **Tooltip = a polished info card, not stacked text.** The `TooltipContent` (`side="top"`, `w-[180px]`, `p-0`) uses the canonical popover **glass** surface `bg-popover/95 backdrop-blur-lg` (correct here — it floats over empty space, unlike the OPAQUE frozen cells). Structure: a **header** (`px-2.5 py-2`) with the batch code (`font-mono text-xs font-semibold`) over the `block_loc` (muted `text-[10px]`) on the left and a compact **state pill** on the right (colored dot + uppercase status text — blue for IN-USE, red for CLOSED/FEED, neutral muted otherwise, matching the footer tint convention); a `border-t border-border` **divider**; then a `<dl>` **label/value list** (`px-2.5 py-2`, `space-y-1`) with muted left labels + `font-mono tabular-nums` right-aligned values via `flex justify-between` per row — **Fed** (`totalOut` kg), **In** (`totalIn` kg), **MC** (2-dec %), **Ash** (2-dec %), **Loss** (signed %, keeps red-neg/emerald-pos/muted-null coloring), **Opened** (`firstFedDate`). All `text-[11px]`, semantic tokens (light + dark).
  - **STATE = ENTIRE-CELL COLOR (the `StateBadge` dot/label was REMOVED).** The whole per-column footer cell background is tinted by `batches.status` via the `statusTint()` helper, which **replaces** `bg-muted` on these cells (one bg per element — never a translucent tint layered over `bg-muted`). The cell itself is `p-0`; the inner trigger `<div>` owns the `px-2 py-0.5` padding. **CRITICAL: the tints are OPAQUE solid tokens** (this is a frozen/sticky surface — any `/opacity`/glass reopens the bleed-through bug). Mapping: **IN-USE → `bg-blue-100 dark:bg-blue-950`** (blue), **CLOSED / FEED → `bg-red-100 dark:bg-red-950`** (red), **everything else (STORED / SUNDRYING / SUNDRIED / …) → neutral `bg-muted`**. Each tint pairs a readable foreground for both modes (blue/red `text-…-950 dark:text-…-50`; neutral `text-foreground`). On the RED (CLOSED/FEED) tint the loss red/green would clash, so **loss inherits the cell foreground there**; on the blue and neutral tints loss keeps the red(neg)/emerald(pos)/muted(null) sign coloring.
  - The 5 cells under the frozen LEFT columns are the **bottom-left corner** — sticky on BOTH axes via `.frozen-corner-bottom` (z30), `align-middle`; they stay **NEUTRAL opaque `bg-muted`** (not per-column, so no state tint). The "Total fed" footer cell shows the **grand total** (`grandTotalFed`, bold) and carries `.frozen-edge` for the vertical seam, the Date footer cell shows a muted "Totals" label, the rest are blank. The scrolling per-column footer cells use `.frozen-row-bottom` (z20) + `.frozen-edge-top` to kill the seam against the scrolling body above. All footer surfaces remain fully OPAQUE.
  - **State tint convention (footer-specific):** IN-USE = **blue**, CLOSED/FEED = **red**, other = **neutral**. This is distinct from the Blocking heatmap's status palette — it reflects feed-completion, not warehouse occupancy.
  - **Block loss formula (PENDING SIGN CONFIRMATION):** implemented exactly as `(totalOut − totalIn) / totalIn`, rendered as a signed % (negative tinted red, positive emerald). Divide-by-zero guarded: `totalIn = 0` → `blockLoss = null` → renders "—". The sign/direction is a first-look; confirm with the user before treating it as final.
  - **Summary data is computed in ONE batched pass** in `fetchRcMovementMatrix` — three `.in(...)` queries (`batches` for status, `deliveries` for totalIn + weighted mc/ash, `rc_out` for totalOut) keyed on the column batch_ids/codes, NOT a per-column action call. Weighted-avg mc/ash mirrors Blocking's `fetchBlockDataForBatch` (`SUM(metric × weight) / SUM(weight_with_metric)`). totalOut/totalIn are all-time SUMs (not month-bounded). No price/role gating in the footer (no PHP shown — deferred).
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
