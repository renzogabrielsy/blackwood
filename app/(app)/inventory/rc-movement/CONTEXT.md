# RC Movement Module — Batch Feed Movement Log

## Purpose
Mirrors the user's Excel RC MOVEMENT sheet column-for-column. Each row represents one batch's feed-out on one day, grouped by date with day-level totals on a glass divider row. Shows running balances, cumulative feed, and percent-loss provisional vs. final per batch lifecycle.

> **Domain Module (Charcoal Tenant):** Tenant-specific. Reads the charcoal-shaped `view_rc_movement` SQL view. Lives in the inventory/charcoal layer — never imported by platform widgets.

## Files
| File | Lines | Role |
|------|-------|------|
| `actions.ts` | ~165 | Backend (locked). One server action: `fetchRcMovementData(year, month)` → `RcMovementData`. Queries `view_rc_movement` filtered to month, groups by date in JS, computes day-level `ttlKg`/`ttlPhp`/`laneCount`, scrubs price columns for Production-role users. Exports `RcMovementRow`, `RcMovementDay`, `RcMovementData`. |
| `page.tsx` | ~20 | Redirect stub — redirects `/inventory/rc-movement` → `/inventory?y=…&m=…` (preserves URL params). |
| `rc-movement-table.tsx` | ~470 | Main client table. Renders a flat virtual list of typed items (`{ kind: 'day-header' | 'lane' }`) so day groups and batch lanes share one `useVirtualizer` instance. Excel-mirrored columns, dense `h-8` rows, mono numerics, accounting ₱ format. Month picker footer with prev/next + year dropdown. |
| `components/rc-movement-table-wrapper.tsx` | ~30 | `dynamic({ ssr: false })` wrapper — mirrors RC OUT / RC IN's table-wrapper pattern to avoid Radix Tooltip hydration mismatches. |

## Data
- **Source:** `view_rc_movement` (defined in `supabase/migrations/20260525000000_create_view_rc_movement.sql`)
- **Server action:** `fetchRcMovementData(year, month)` from `app/(app)/inventory/rc-movement/actions.ts`
- **Auth:** `getUserRole(user.id)` — `Production` role gets `canViewPrices: false`; price columns scrubbed to `null` server-side
- **Types:** `RcMovementRow`, `RcMovementDay`, `RcMovementData` (all in `actions.ts`)

### `RcMovementData` shape
```typescript
{
  days: Array<{
    date: string;          // YYYY-MM-DD
    day: number;           // day-of-month
    ttlKg: number;
    ttlPhp: number | null; // null when !canViewPrices
    laneCount: number;
    rows: Array<{
      batchCode: string;
      blockLoc: string | null;
      supplier: string | null;
      startBalance: number;
      batchFed: number;    // kg fed for this batch on this day
      ttlFed: number;      // cumulative kg fed for this batch through this day
      pctLoss: number | null;   // residual fraction (balance_after / deliveries_total)
      phpPerKg: number | null;  // null when !canViewPrices
      phpTotal: number | null;  // null when !canViewPrices
      status: 'active' | 'closed';
      feedDayN: number;
    }>;
  }>;
  canViewPrices: boolean;
}
```

## Key Behaviors

### Column structure (Excel-mirrored, left-to-right)
| Col | Width | Field | Format | Notes |
|-----|-------|-------|--------|-------|
| DATE | 100 | day.date | YYYY-MM-DD | Day-header row only — visually empty on lanes |
| DAY | 44 | day.day | integer | Day-header row only |
| TTL KG | 88 | day.ttlKg | int,thousand-sep | Day-header row only |
| BLOCKS | 120 | row.batchCode | mono bold | Tooltip on hover shows supplier |
| START BAL | 88 | row.startBalance | int,thousand-sep | Right-aligned mono |
| BATCH FED | 88 | row.batchFed | int,thousand-sep | Right-aligned mono |
| TTL FED | 88 | row.ttlFed | int,thousand-sep | Right-aligned mono |
| % LOSS | 76 | row.pctLoss | percent, 2dp | Italic+muted with `*` suffix when active (provisional); solid when closed (final). Color: <0 red, >30% amber |
| PHP/KG | 88 | row.phpPerKg | accounting ₱ | Hidden when `!canViewPrices` |
| PHP TTL | 100 | row.phpTotal | accounting ₱ | Hidden when `!canViewPrices` |
| STATUS | 84 | row.status | badge | `● active` (emerald) / `✕ closed` (red, line-through) |
| BLOCK LOC | 76 | row.blockLoc | mono muted | Non-Excel context column showing physical block |

### Day-header row
- Single `<td colSpan>` cell with glass background (`bg-muted/90 backdrop-blur-sm`)
- Format: `DAY 22 · May 22, 2026 · TTL KG 31,908 · ₱1,530,720 · 4 lanes`
- ₱ segment omitted when `!canViewPrices`
- Height: 28px (vs 32px for lane rows)

### Virtual scroll architecture
- `buildVirtualItems(days)` flattens day groups into a single ordered array of typed items: `[dayHeader, lane, lane, dayHeader, lane, ...]`
- Single `useVirtualizer` instance with variable `estimateSize` based on item kind
- Bypasses TanStack Table's row model — grouped virtual rows don't map cleanly to `ColumnDef`. Raw `<table>` + `@tanstack/react-virtual` is the simplest correct pattern.

### Month picker
- Custom in-table footer (NOT reused from `DeliverySheetFooter`) — lighter UX appropriate for the simpler month-to-date scope
- Layout: `[← Prev]  May 2026  [Next →]` with separate year `<Select>` dropdown to the left
- Default: current year + current month on first activation
- URL sync: `?y=YYYY&m=M` updated via `window.history.replaceState` (no Next.js navigation, no server round-trip)
- Month change triggers a new `fetchRcMovementData` call (handled in `rc-movement-lazy-tab.tsx`)

### % LOSS rendering specifics
- **Active rows:** `italic text-muted-foreground/70` + small superscript `*` indicator + tooltip "Provisional. Will finalize when batch closes."
- **Closed rows:** solid color, no italic, tooltip "Final shrinkage at batch closure."
- **Color coding:** negative (data anomaly) = red; >30% = amber; otherwise normal text
- **Header tooltip:** "% remaining of original batch intake. Provisional while active; freezes as final shrinkage at closure."

### Lazy loading
- `app/(app)/inventory/components/rc-movement-lazy-tab.tsx` fetches on first activation of the Movement tab
- Re-fetches when user changes month/year via the picker
- Loading + error states match existing tabs

### Role gating
- `data.canViewPrices === false` → PHP/KG and PHP TTL columns are filtered out of `visibleColumns` entirely (column not rendered, not just blanked)
- Day-header row omits the ₱ segment when `!canViewPrices`
- Top-row monthly totals strip omits the ₱ segment when `!canViewPrices`

### Glass & Motion
- Sticky column headers: `bg-muted/90 backdrop-blur-sm`
- Day-header rows: `bg-muted/90 backdrop-blur-sm`
- Month picker footer: `bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60`
- Row hover: `transition-all duration-150`
- Empty state: `animate-fade-up`
- **No row stagger or row entrance animations** — per CLAUDE.md, never animate table rows

## Dependencies
- `@/lib/supabase/server` — used by `actions.ts` (server-side only)
- `@/lib/auth` — `getUserRole()` (used in `actions.ts`)
- `@tanstack/react-virtual` — `useVirtualizer` for the flat day-header + lane list
- `date-fns` — `format`, `startOfMonth`, `endOfMonth` (server) + `format` (client for day-header date label)
- `@/components/ui/tooltip` — header tooltip on `% LOSS`, supplier tooltip on `BLOCKS`, provisional/final tooltip on `% LOSS` values
- `@/components/ui/select` — year picker in the month-picker footer
- `@/components/ui/button` — prev/next month buttons
- `lucide-react` — `ChevronLeft`, `ChevronRight`, `Loader2`

## See Also
- [RC IN](../rc-in/CONTEXT.md) — Source of `deliveries.lab_results`, `deliveries.cost_basis`, `deliveries.block_loc` which feed `view_rc_movement` via `batch_meta` CTE
- [RC OUT](../rc-out/CONTEXT.md) — Source of `rc_out.weight_kg` and `rc_out.transaction_date` which feed the `day_agg` CTE
- [Blocking](../blocking/CONTEXT.md) — Sibling visualization showing physical warehouse occupancy
- [Inventory](../CONTEXT.md) — Parent module that owns the tab system
