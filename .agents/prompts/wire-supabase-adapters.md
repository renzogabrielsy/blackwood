Read TIMELINE.md, CLAUDE.md, and components/widgets/CONTEXT.md before starting. Enter plan mode first — outline what you will do, get my approval, then execute. When done, give me a concise summary of what adapters you built, what queries they run, what widgets are now live, and any issues or edge cases you found.

## Task: Build Live Supabase Adapters for All Widgets

Currently all widgets receive data from the static adapter (lib/widgets/mock-data.ts). Build live Supabase adapters that query real data and transform it into the existing widget interfaces (KPIData[], ChartConfig, etc.).

## Architecture Reminder

The adapter layer follows Ports and Adapters:
- Port = the typed interface the widget declares (KPIData[], ChartConfig, etc.) — these already exist
- Adapter = a pure async function that fetches from Supabase and transforms raw rows into the port interface
- Widget = renders whatever data the port gives it — ZERO changes to widget code

Adapters live in lib/widgets/adapters/. They are tenant-specific (charcoal domain) and data-source-specific (Supabase). This is correct and expected.

## What to Build

1. Create adapter infrastructure — lib/widgets/adapters/types.ts:
   Define a generic WidgetAdapter<TPort> interface with an id string and a fetch method that takes a SupabaseClient and returns Promise<TPort>. This is the pattern all adapters follow.

2. Build lib/widgets/adapters/charcoal-kpi.ts:
   Query the real aggregated data that the static CHARCOAL_KPI_DATA was mocking:
   - Total inventory balance: sum of batch current_weight where status IN (STORED, IN-USE)
   - Warehouse occupancy: count from view_blocking_grid vs total slots from blocking constants
   - Current weighted avg PHP/KG: from view_blocking_grid or batches
   - Current month flow: RC IN total, RC OUT total, net from deliveries and rc_out tables filtered to current month
   Transform results into KPIData[] matching the existing static shape exactly.
   Export as charcoalKpiAdapter satisfying WidgetAdapter<KPIData[]>.

3. Build lib/widgets/adapters/charcoal-chart.ts:
   Query monthly aggregated data for the chart:
   - Monthly RC IN totals (weight, avg PHP/KG) from deliveries grouped by month
   - Monthly RC OUT totals from rc_out grouped by month
   - Monthly quality averages (MC, ASH, BD ASTM) from deliveries grouped by month
   Transform into ChartConfig matching the existing CHARCOAL_UNIVERSAL_CONFIG shape.
   Export as charcoalChartAdapter satisfying WidgetAdapter<ChartConfig>.

4. Build lib/widgets/adapters/charcoal-warehouse.ts:
   Query warehouse occupancy from view_blocking_grid.
   Group by warehouse letter (A/B/C/D), count occupied vs total.
   Compute weighted avg PHP/KG, MC, ASH per warehouse.
   Transform into the warehouse data shape that WarehouseOccupancyWidget expects.
   The widget may need to accept data via props first (like KPIStrip was just refactored). If so, follow the same pattern: define a WarehouseData interface, refactor the widget to accept props, create the adapter.

5. Update the dashboard data layer — app/(app)/page.tsx:
   This should become a Server Component that fetches data via adapters on the server side then passes results to the client-side DashboardGrid. DashboardGrid receives adapter results as props and passes them down to individual widgets. Keep static adapter as fallback: if the fetch fails or returns empty, fall back to mock data.

6. Handle the QualityScatterWidget:
   This currently imports LEDGER directly from mock-data.
   Follow the same pattern: define port interface, refactor to accept props, build adapter.
   Or, if the scatter data can be derived from the chart adapter data, share the adapter.

## Important Rules

- Adapters are pure functions — no React, no hooks, no rendering
- Adapters live in lib/widgets/adapters/ — this is tenant/domain code, not platform code
- Widgets in components/widgets/ must NOT import from lib/widgets/adapters/ directly — data flows through page.tsx then DashboardGrid then widget props
- Use the server Supabase client (lib/supabase/server.ts) in server components, NOT the browser client
- All queries should be efficient — use views where they exist (view_blocking_grid, view_rc_in_master)
- NULL-safe: handle missing data gracefully (empty arrays, zero values, "No data" states)

## Database Reference

Check the actual schema before writing queries:
- Run supabase gen types or check types/supabase.ts for current column names
- Key tables: batches, deliveries, rc_out
- Key views: view_blocking_grid, view_rc_in_master
- Read app/(app)/inventory/blocking/CONTEXT.md and app/(app)/inventory/rc-in/CONTEXT.md for schema details

## Testing

After implementation:
1. Run npm run build — must pass with zero errors
2. Run npm run dev and check the dashboard — widgets should show REAL data from Supabase
3. Compare widget output to the previous static data — values will differ (real vs mock) but the SHAPE and LAYOUT must be identical

## Update Documentation

- Update components/widgets/CONTEXT.md — document the adapter to widget data flow
- Update TIMELINE.md — check off relevant Phase 1 tasks, add entry to Recent Completions and Changelog
