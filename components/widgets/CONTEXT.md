# Widget System Context

## Purpose
Reusable, self-contained visualization widgets for the modular dashboard at `/`. Each widget is a **source-agnostic**, **data-agnostic** React component that adapts its layout based on the `WidgetSizeContext` (pixel dimensions + size tiers) provided by `WidgetShell`.

## Files
- `index.ts` — `WIDGET_REGISTRY`: maps type → component + metadata + default settings. Also re-exports all widget components.
- `chart/types.ts` — all chart TypeScript interfaces: `LedgerMonth`, `LedgerQuarter`, `LedgerYear`, `UsageMonth/Quarter/Year`, `ChartConfig`, `ChartSeries`, `ChartInstanceSettings`, `ComparisonSlice`, `WidgetSize`, `SizeTier`, etc.
- `chart/utils.ts` — chart utilities: `getWidthTier()`, `getHeightTier()`, `getRootFontSize()`, `formatPeriodLabel()`, `getAvailableFields()`, `getFilterIndices()`, `WidgetSizeContext`, `useWidgetSize()` hook
- `chart/ChartWidget.tsx` — multi-series Recharts chart with full settings popover (X axis filter, Y series builder, comparison slices, font scale, color picker, drag-to-reorder)
- `kpi-strip/KPIStripWidget.tsx` — responsive KPI strip (xs/sm/md/lg/xl layouts) with nav links in wide mode
- `quality-scatter/QualityScatterWidget.tsx` — SVG scatter plot (PHP/KG vs MC or ASH) with MC/ASH toggle
- `warehouse-occupancy/WarehouseOccupancyWidget.tsx` — WHSE A/B/C/D occupancy progress bars with inline stats

## How to Add a New Widget Type
1. Create `components/widgets/<name>/<Name>Widget.tsx` — export a named React component
2. Call `useWidgetSize()` from `@/components/widgets/chart/utils` for responsive behavior
3. Add an entry to `WIDGET_REGISTRY` in `components/widgets/index.ts`
4. The widget receives no required props beyond what the parent `WidgetShell` provides via context

## Widget Size Tier System
`WidgetShell` uses a `ResizeObserver` to measure the content area and provides `WidgetSize` via `WidgetSizeContext`:

| Tier | Width (rem) | Approx px |
|------|-------------|-----------|
| xs   | < 10        | < 160     |
| sm   | 10–17.5     | 160–280   |
| md   | 17.5–27.5   | 280–440   |
| lg   | 27.5–40     | 440–640   |
| xl   | > 40        | > 640     |

Height tiers use the same breakpoints applied to height.

## Data-Agnostic Interface (Port)

Widgets are **source-agnostic** — they declare a typed data contract (the "port") and are permanently isolated from whoever fills it.

**Ports and Adapters model:**
- The **widget** is the application core
- The **port** is the typed interface it declares (`ChartConfig`, `KPIData`, `ScatterPoint[]`, etc.)
- The **adapter** is whoever fills the port — the widget sees no difference between sources

**Three sources that can fill a port:**
1. **Static adapter** — `lib/widgets/mock-data.ts` exports pre-shaped data (current approach)
2. **Live adapter** — `lib/widgets/adapters/` (future) — fetches from Supabase and transforms to port interface
3. **Server-fetched props** — `page.tsx` fetches and passes data down; widget still only sees the typed interface

**What widgets must NEVER do:**
- Import from Supabase or any data source directly
- Reference charcoal-specific domain concepts (`batch_code`, `php_kg`, `block_loc`, etc.)
- Contain business logic or data transformation
- Know which tenant or domain is using them

**What adapters must NEVER do:**
- Import React or contain rendering logic
- Know which widget will consume their output
- Be imported directly inside `components/widgets/` or `components/dashboard/`

`ChartWidget` receives `settings: ChartInstanceSettings` + `onSettingsChange` props for in-widget configuration. All current widgets receive data from the static adapter (`lib/widgets/mock-data.ts`).

## Dependencies
- `recharts` — `ComposedChart`, `Line`, `Bar`, `Area`, `XAxis`, `YAxis`, `Tooltip`, `ReferenceLine`
- `components/ui/popover` — settings popover in `ChartWidget`
- `lib/widgets/mock-data.ts` — static data: `CHARCOAL_UNIVERSAL_CONFIG`, `LEDGER`, `USAGE_LEDGER`, `WAREHOUSE_LIST`, `PIVOT_MONTHS`, `FISCAL_TO_CALENDAR`, `SLICE_PALETTE`, `CHART_PALETTE`

## See Also
- `components/dashboard/DashboardGrid.tsx` — consumes `WIDGET_REGISTRY` and renders widgets inside `WidgetShell`
- `app/(app)/CONTEXT.md` — dashboard module context
