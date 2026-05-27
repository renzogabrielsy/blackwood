# Production Module

## Purpose
Top-level route `/production` for charcoal plant operations data: daily production runs, downtime, waste streams, electricity consumption, and truck odometer readings. Excel-parity views matching the MASTER sheet structure — implemented as **true inline-editable grids** (no dialogs).

> **Domain Module (Charcoal Tenant):** Charcoal-specific operations layer. All data is fully visible to all authenticated users. Cost/price data (Electricity RATE/TTL PHP) is gated by `hasPermission('view:prices')`.

## Files
| File | Role |
|------|------|
| `page.tsx` | Server entry point — renders `<ProductionView />` |
| `layout.tsx` | Client layout — wraps in `ProductionTabProvider` + Card shell + `<ProductionSheetTabs />` |
| `error.tsx` | Error boundary |
| `loading.tsx` | Loading skeleton |
| `components/production-tab-context.tsx` | React context — `activeTab` / `setActiveTab`, localStorage key `production_active_tab` |
| `components/sheet-tabs.tsx` | Bottom tab bar with sliding indicator (Daily · Electricity · Trucks) |
| `components/production-view.tsx` | Crossfade wrapper for 3 tabs (150ms opacity transition) |
| `components/daily-lazy-tab.tsx` | Lazy loader for Daily tab — fetches on first activation |
| `components/electricity-lazy-tab.tsx` | Lazy loader for Electricity tab |
| `components/trucks-lazy-tab.tsx` | Lazy loader for Trucks tab |

## Tab Catalog
| Tab | Submodule | Data | UI |
|-----|-----------|------|----|
| Daily | `daily/` | `production_runs`, `production_downtime`, `production_waste` | 3 inline-editable grids side-by-side |
| Electricity | `electricity/` | `electricity_readings`, `view_electricity_monthly` | Single inline-editable grid + monthly summary |
| Trucks | `trucks/` | `truck_readings`, `view_trucks_monthly` | Single inline-editable grid + monthly summary |

## Grid Architecture (Excel-Style)
All 5 grids share the same pattern (modelled after `bulk-delivery-input.tsx`):
- **Row states:** `existing | new | modified | deleted` — dirty tracking per row
- **Dirty indicator:** amber left border on `modified` rows; strikethrough on `deleted` rows
- **Save/Discard:** each grid independently batches its own inserts/updates/deletes into one server action call
- **Trailing empty row:** always maintained at the bottom for adding new data
- **Keyboard nav:** Arrow/Tab/Enter navigation, F2 edit, Escape revert, Home/End row edges
- **Paste:** Ctrl+V from clipboard auto-expands rows; `parseExcelDate` handles date columns
- **Range selection:** left-click-drag, Shift+Arrow, Ctrl+A; Ctrl+C copies TSV
- **Status bar:** pushes selection count + aggregates to `StatusBarProvider`
- **Error toasts:** `errorToast()` from `lib/toast.ts` — HARD RULE

## Daily Tab Layout
```
[ PRODUCTION OUTPUT (~620px) ] | [ DOWNTIME (~700px) ] | [ WASTE SUMMARY (~1200px) ]
```
Outer `overflow-x-auto` horizontal scroll. Each grid has independent vertical scroll.

## Shared Types
`BulkSavePayload<TInsert, TUpdate>` — exported from `daily/actions.ts`:
```ts
type BulkSavePayload<TInsert, TUpdate> = {
  inserts: TInsert[];
  updates: { id: string; data: TUpdate }[];
  deletes: string[];
};
```

## Key Behaviors
- **Lazy loading:** All 3 tabs load on first activation. `hasLoadedRef` prevents re-fetch on tab switch.
- **Crossfade:** 150ms opacity transition (same pattern as Inventory).
- **Tab persistence:** localStorage key `production_active_tab`, default `'daily'`.
- **Error handling:** Each lazy tab has Retry button on fetch failure.
- **Navbar:** Registered in `getBreadcrumb()` at `startsWith('/production')`. Production enabled in `MODULES` array.

## Schema References
- `production_runs` — date, production_batch, **customer** (CEBU/KURARAY/..., default 'CEBU'), grade (3X50/6X50/8X50/2X6), shift (M/E/N), ttl_kg, sacks_bags. Natural key: `(date, production_batch, customer, grade, shift)`.
- `production_downtime` — date, batch, shift, shift_hrs, dt_hrs, dt_mins, dt_reason. Natural key: `(date, production_batch, shift)`.
- `production_waste` — date, batch, shift, 8 waste streams (kg + sacks text each). Natural key: `(date, production_batch, shift)`.
- `electricity_readings` — date, meter (MAIN/BUNKHOUSE/PUMP), start_kwh, end_kwh, rate_php_per_kwh
- `truck_readings` — date, plate_no, start_km, end_km, fuel_liters
- `view_electricity_monthly` — monthly aggregates per meter
- `view_trucks_monthly` — monthly aggregates per plate

**Note (2026-05-27):** `production_runs.customer` was added during the MASTER backfill. Default `CEBU` covers ~99% of rows. The `production-runs-grid.tsx` UI does not yet expose a customer column — new rows entered via the grid will silently default to `CEBU` via the DB default. Follow-up UI work: add a customer dropdown to the grid for non-CEBU rows.

## Dependencies
- `@/components/providers/auth-context` — `useAuth()`, `hasPermission('view:prices')` for cost gating
- `@/components/providers/status-bar-context` — `useStatusBar()` for selection aggregates
- `@/lib/hooks/use-cell-selection` — range selection
- `@/lib/hooks/use-clipboard-copy` — Ctrl+C
- `@/lib/hooks/use-cell-delete` — Delete/Backspace on selection
- `@/lib/hooks/use-cell-aggregation` — SUM/AVG in status bar
- `@/lib/paste-utils` — `parseExcelDate`, `trimCellValue`
- `@/components/shared/grid/GridCell` — unified cell display/edit component
- `@/components/shared/grid/RemarksCellAdaptor` — popover remarks editor
- `@/lib/toast` — `errorToast()` for all error toasts (HARD RULE)
- `@/types/supabase` — `Tables<>`, `TablesInsert<>`, `TablesUpdate<>` for all type inference

## See Also
- [Navbar](../../../components/NAVBAR.md)
- [Auth Provider](../../../components/providers/AUTH.md)
- [RC IN bulk-delivery-input](../inventory/rc-in/bulk-delivery-input.tsx) — canonical Excel grid pattern
