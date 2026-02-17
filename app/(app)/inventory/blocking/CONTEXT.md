# Blocking Module

## Purpose

Physical warehouse grid visualization — the digital equivalent of the Excel blocking sheet. Renders a heatmap of 220 block locations across 4 warehouses (A, B, C, D), showing which batch occupies each slot and key metrics at a glance. Clicking an occupied cell opens a slide-over detail panel with balance, quality metrics, delivery history, and usage history.

## Files

| File | Description |
|---|---|
| `types.ts` | Shared interfaces: `BlockData` (single cell data), `BlockingGridData` (full grid payload with aggregates), `DeliveryHistoryRecord` (includes `id`, `mc`, `bd_astm`, `ash`, `cost_basis`), `UsageHistoryRecord`, `BlockingDetailData` (detail panel payload), `FullDeliveryRecord` (full delivery for edit dialog) |
| `constants.ts` | `WarehouseConfig` interface and `WAREHOUSES` constant — warehouse layout config (name, columns, rows, total slots per warehouse) |
| `actions.ts` | Server actions: `fetchBlockingGridData()` (queries `view_blocking_grid`, returns grid data with role-gated PHP/KG), `fetchBlockingDetail(batchCode, batchId)` (fetches delivery + usage history with delivery IDs + lab results (mc/bd_astm/ash), batch notes, and avg_cost for a specific batch), `fetchSingleDelivery(deliveryId)` (fetches full delivery record for edit dialog and info dialog), `updateBlockNotes(batchId, notes)` (updates `batches.notes`, calls `revalidatePath('/inventory')`) |
| `blocking-grid.tsx` | Main client component — accepts `data: BlockingGridData` and `canViewPrices: boolean` props. Renders sticky global summary header with warehouse filter chips, heatmap legend, global stats. 4 warehouse grid sections with CSS Grid layout, heatmap-colored occupied cells, empty cells, utilization bars. Manages `selectedLocKey`, `activeWarehouses`, and `statusFilter` state. Warehouse headers display all 7 weighted-average lab results. Status badges are clickable with spotlight dim/glow effect |
| `blocking-detail-panel.tsx` | Slide-over panel component (w-[520px], h-dvh) — accepts `data` and `canViewPrices: boolean` props. Fetches detail data on-demand via `fetchBlockingDetail()` when a cell is selected. Fixed right panel with backdrop. **Delivery-card style layout** designed to fit iPad Mini 6 portrait (~1080px usable) without scrolling to see delivery history: (1) Compact header with loc badge, status badge, whse/col/row, batch code; (2) **Metrics grid** — 3-col grid with Balance cell (value + pct + thin progress bar), PHP/KG, Est. Value (role-gated, grid collapses to 1-col when prices hidden); (3) **Lab results row** — 7 flex cells matching delivery card pattern (`text-[8px]` labels, `text-xs font-mono font-bold` values); (4) **Inline notes** — single line when not editing (StickyNote icon + "Notes:" label + truncated text + pencil icon), expands to compact textarea when editing; (5) **Scrollable area** with delivery history table (tighter `px-1.5 py-1` cells, `text-[10px]`/`text-[9px]` sizing) + usage history below. No sticky footer. EditDeliveryDialog integration, and **DeliveryHistoryDialog** (from RC IN) for per-delivery info view. Escape key and backdrop click to close |
| `edit-delivery-dialog.tsx` | Edit delivery dialog — opened from delivery row pencil icon. Fetches full delivery via `fetchSingleDelivery()`, form with all delivery fields + collapsible lab results section. Saves via `bulkUpdateDeliveries()` from RC IN actions for audit trail. Cost field role-gated behind `canViewPrices`. Glass effect DialogContent with `animate-modal-enter` |
| `CONTEXT.md` | This file |

## Data

**Primary data source:** `view_blocking_grid` SQL view on Supabase — one row per active batch (STORED/IN-USE) with `block_loc`, `balance`, `total_in`, and all 7 weighted-average lab results (`mc`, `ash`, `bd_astm`, `bd_jis`, `grit`, `vm`, `fc`) pre-computed in SQL.

**Data loading pattern:**
- Grid data lazy-loaded via `fetchBlockingGridData()` server action on tab mount (follows RC OUT pattern via `blocking-lazy-tab.tsx` in `inventory/components/`)
- Detail data (deliveries + usage + notes + avg_cost) fetched on-demand per cell click via `fetchBlockingDetail(batchCode, batchId)`
- PHP/KG is role-gated: Production role users receive `null` for cost data

**Warehouse layout:**

| WHSE | Columns | Rows | Total Slots |
|------|---------|------|-------------|
| A | 1-20 | A-C | 60 |
| B | 1-20 | A-B | 40 |
| C | 1-20 | A-B | 40 |
| D | 1-20 | A-D | 80 |
| **Total** | | | **220** |

**Block LOC format:** `{WHSE}-{COL}{ROW}` (e.g., `A-1A`, `C-15A`, `D-20D`)

**Heatmap thresholds (percent of `balance / total_in` — % remaining of total delivered):**
- Full (dark green): >= 50%
- Healthy (green): 20-50%
- Depleting (amber): 10-20%
- Critical (red): < 10%

**BlockData fields:**
- `batch_code`, `batch_id`, `status` ('STORED' | 'IN-USE' | 'SUNDRYING' | 'SUNDRIED'), `balance`, `total_in`, `php`
- Lab results: `mc`, `ash`, `bd_astm`, `bd_jis`, `grit`, `vm`, `fc`

## State Management

| State | Type | Default | Purpose |
|---|---|---|---|
| `selectedLocKey` | `string \| null` | `null` | Currently selected cell for detail panel |
| `activeWarehouses` | `Set<string>` | `new Set(['A','B','C','D'])` | Warehouse filter — which warehouse sections are visible |
| `statusFilter` | `'ALL' \| 'STORED' \| 'IN-USE' \| 'SUNDRYING' \| 'SUNDRIED' \| 'EMPTY'` | `'ALL'` | Status spotlight filter — dims non-matching cells |

## Key Behaviors

- **Warehouse filter chips** — ALL/WHSE A/B/C/D toggle buttons in global header. Individual chips toggle on/off. If all deselected, auto-reverts to ALL. Global stats recalculate for visible warehouses only
- **Weighted average stats** — Each warehouse header shows all 7 lab result weighted averages (weighted by balance): MC, ASH, BD ASTM, BD JIS, GRIT, VM, FC. Also shows weighted PHP/KG (role-gated via `canViewPrices`)
- **Clickable status badges** — Stored (blue), In-Use (amber), Sundrying (orange), Sundried (violet), Empty (muted) buttons in global header and warehouse headers. Click toggles spotlight filter, click again deselects to ALL
- **Spotlight effect** — When status filter active: non-matching cells get `opacity: 0.3; pointer-events: none` (`.spotlight-dimmed`), matching cells get colored glow ring (`.spotlight-stored`, `.spotlight-in-use`, `.spotlight-empty`). All transitions 150ms
- **Sticky global header** — `sticky top-0 z-30` with glass effect `bg-card/95 backdrop-blur-sm`
- **Heatmap coloring** — gradient backgrounds applied via CSS classes (`heat-full`, `heat-healthy`, `heat-depleting`, `heat-critical`) defined in `globals.css`
- **Cell click** — toggles detail panel open/closed. Clicking same cell again closes. Clicking different cell switches content
- **Selected state** — outline ring on selected cell via `.blocking-cell.selected` CSS class
- **Critical pulse** — balance text in critical cells pulses with 2s animation
- **Cell hover** — `scale(1.08)` transform with shadow (CSS-only, no JS)
- **Detail panel** — slides from right (520px wide, `h-dvh`) with cubic-bezier easing, body scroll locked while open. **Delivery-card style metrics** — Row 1: 3-col grid with Balance cell (value + percentage + thin 1px progress bar + 0/total range), PHP/KG cell, Est. Value cell (role-gated; grid collapses to 1-col when prices hidden). Row 2: 7 flex lab result cells matching DeliveryHistoryDialog pattern (`text-[8px]` labels, `text-xs font-mono font-bold` values, centered in bordered rounded cells). **Inline notes** — single-line display (StickyNote icon + "Notes:" + truncated text + pencil edit icon, ~24px height), expands to compact textarea with Save/Cancel on edit. **Scrollable content area** (`flex-1 min-h-0 overflow-y-auto`) contains delivery history and usage history. Delivery table: tighter cells (`px-1.5 py-1`, `text-[10px]` body, `text-[9px]` headers) with Date, Supplier, Sacks, Weight, PHP/KG (role-gated), MC, BD, ASH + action column with Info + Edit icons on hover + total footer row. **"Edit All" button** in header. Usage table below with same tight sizing. No sticky footer (Est. Value moved to metrics grid). Designed to fit iPad Mini 6 portrait (~1080px) without scrolling to see delivery history.
- **Escape key** — closes detail panel
- **Responsive** — `overflow-x-auto` on grid wrapper for smaller screens
- **Cell content** — loc key (status-colored text: blue=STORED, amber=IN-USE, orange=SUNDRYING, violet=SUNDRIED), 2-line batch name, balance (abbreviated via `formatKg`), PHP/KG, ASH%, MC%
- **All cell text is white** — rendered on gradient backgrounds, `text-white` in both light and dark modes, except loc key which uses status color
- **Legend labels** — percent-based: "> 50% Full", "20-50% OK", "10-20% Depleting", "< 10% Critical"
- **Balance formatting** — uses `formatKg()` everywhere (>= 1000 -> Xk, else Xkg)
- **Utilization colors** — reversed: >75% = red (almost full, warning), >50% = amber, <=50% = green (plenty of room)
- **Detail panel balance bar** — progress bar max uses `total_in` (actual total delivered), not hardcoded 100,000

### Role-Gating

- **Production role:** PHP/KG hidden in grid cells, detail panel metric card, delivery table cost column, and footer estimated value. These fields render as `--` or are omitted entirely
- **All other roles:** Full visibility of all cost and pricing data

## CSS (globals.css)

The blocking heatmap system is defined at the bottom of `app/globals.css`:
- `.heat-critical`, `.heat-depleting`, `.heat-healthy`, `.heat-full` — gradient backgrounds with light-mode default shadows and `.dark` overrides for glowy shadows
- `.blocking-cell` — base cell styles (border-radius, transition, cursor)
- `.blocking-cell:hover` — scale transform
- `.blocking-cell.selected` — outline ring with dark mode variant
- `blocking-critical-pulse` keyframe — pulsing animation for critical balance text
- `.spotlight-dimmed` — `opacity: 0.3; pointer-events: none` with 150ms transition
- `.spotlight-stored` — blue glow ring (`box-shadow`) with `.dark` variant for stronger glow
- `.spotlight-in-use` — amber glow ring (`box-shadow`) with `.dark` variant
- `.spotlight-sundrying` — orange glow ring (`box-shadow`) with `.dark` variant
- `.spotlight-sundried` — violet glow ring (`box-shadow`) with `.dark` variant
- `.spotlight-empty` — muted glow ring (`box-shadow`) with `.dark` variant

## Prop Chain (Spotlight)

`BlockingGrid` (owns `statusFilter`) -> `WarehouseSection` (gets `statusFilter`, `onToggleStatus`) -> `WarehouseRow` (gets `statusFilter`) -> `OccupiedCell`/`EmptyCell` (gets computed `spotlightMatch: 'none' | 'match' | 'dimmed'`)

## Dependencies

- `@/lib/utils` — `cn()` for class merging
- `@/lib/supabase/server` — Supabase client for data fetching in server actions
- `@/lib/auth` — `getUserRole()` for role-based access control (PHP/KG gating)
- `view_blocking_grid` SQL view on Supabase — pre-computed blocking data
- `lucide-react` — `X`, `Pencil`, `Check`, `StickyNote`, `Loader2`, `ChevronDown`, `ChevronUp`, `Info`, `ExternalLink` icons
- `@/components/ui/dialog` — Shadcn Dialog for edit delivery dialog
- `@/components/ui/tooltip` — Tooltip for Edit All button and metric hover (in detail panel)
- `@/components/ui/button`, `@/components/ui/input`, `@/components/ui/label` — form components in edit dialog
- `@/app/(app)/inventory/rc-in/actions` — `bulkUpdateDeliveries()` for saving delivery edits with audit trail
- `@/app/(app)/inventory/rc-in/components/DeliveryHistoryDialog` — reused for per-delivery info view in detail panel
- `@/app/(app)/inventory/components/inventory-tab-context` — `useInventoryTab()` for tab switching from Edit All button
- `next/navigation` — `useRouter()` for navigating to deliveries tab with search filter

## Integration

`BlockingLazyTab` wrapper (in `app/(app)/inventory/components/blocking-lazy-tab.tsx`) is rendered inside `inventory-view.tsx` as the content for the "blocking" tab. It fetches data on mount via `fetchBlockingGridData()` and passes `data` and `canViewPrices` props to `BlockingGrid`.

## See Also

- `app/(app)/inventory/rc-in/CONTEXT.md` — RC IN (Delivery Master Log) — data source for delivery history in detail panel
- `app/(app)/inventory/rc-out/CONTEXT.md` — RC OUT (Inventory Usage) — data source for usage history in detail panel
- `CLAUDE.md` — BLOCKING feature section with full warehouse layout and data source documentation
