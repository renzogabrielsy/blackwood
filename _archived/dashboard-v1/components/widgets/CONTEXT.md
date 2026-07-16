# Widget System Context

## Purpose
Reusable, self-contained visualization widgets for the modular dashboard at `/`. Each widget is a **source-agnostic**, **data-agnostic** React component that adapts its layout based on the `WidgetSizeContext` (pixel dimensions + size tiers) provided by `WidgetShell`.

## Files
- `index.ts` — `WIDGET_REGISTRY`: maps type → component + metadata + default settings. Re-exports all widget components and port types (`WarehouseData`, `SpecialChartData`, `SpecialChartSettings`).
- `chart/types.ts` — all chart TypeScript interfaces: `LedgerMonth`, `LedgerQuarter`, `LedgerYear`, `UsageMonth/Quarter/Year`, `ChartConfig`, `FiscalCalEntry`, `ChartSeries`, `ChartInstanceSettings`, `ComparisonSlice`, `WidgetSize`, `SizeTier`, etc.
- `chart/utils.ts` — chart utilities: `getWidthTier()`, `getHeightTier()`, `getRootFontSize()`, `formatPeriodLabel()`, `getAvailableFields()`, `getFilterIndices(filter, fiscalCalendar)`, `WidgetSizeContext`, `useWidgetSize()` hook
- `chart/ChartWidget.tsx` — multi-series Recharts chart with full settings popover (X axis filter, Y series builder, comparison slices, font scale, color picker, drag-to-reorder). Accepts `config?: ChartConfig` prop (falls back to `CHARCOAL_UNIVERSAL_CONFIG` if not provided).
- `kpi-strip/types.ts` — `KPIData`, `KPIStripSettings`, `KPIThreshold`, `KPIComparison`, `KPIFlowData` interfaces (the KPI strip port)
- `kpi-strip/chips.tsx` — chip variant renderers: `DefaultChip`, `FlowChip`, `ProgressChip`, `RatioChip`, `Sparkline`, `ComparisonLine`, `getThresholdColor`. Pure presentational — no hooks, no data source imports.
- `kpi-strip/KPIStripWidget.tsx` — responsive KPI strip (xs/sm/md/lg/xl layouts); accepts `data: KPIData[]`, `settings: KPIStripSettings`, `onSettingsChange` props. Includes period selector (D/W/M/Q/Y), pinned-chip xs/sm behavior, chip variant dispatch, settings filter+sort. Nav links driven by chips with `href` and no `value`.
- `kpi-strip/settings-popover.tsx` — gear-icon popover (`w-64`) for chip visibility toggle, reorder (up/down), per-chip expand panel (···), and display density toggle. Expand panel provides label override input, pinned toggle, show-comparison toggle, show-sparkline toggle. Mounted in `WidgetShell` headerAction slot via `DashboardGrid`.
- `special-chart/types.ts` — `SpecialChartData`, `SpecialChartSettings`, `FieldDef`, `SpecialChartType`, `ScatterGranularity` interfaces (the special chart port)
- `special-chart/aggregation.ts` — pure aggregation utilities: `niceScale()`, `numericFields()`, `categoricalFields()`, `fieldLabel()`, `fieldUnit()`, `granularityKey()`, `aggregateScatterData()`, `aggregatePieData()`, `buildColorMap()`, `YEAR_COLORS`, `GENERIC_PALETTE`
- `special-chart/scatter-renderer.tsx` — generic SVG scatter renderer. Reads field config from `SpecialChartData.fields`. X/Y/color all driven by settings. No domain knowledge.
- `special-chart/pie-renderer.tsx` — SVG pie/donut renderer. Standard arc path math, `GENERIC_PALETTE` coloring, donut center total, `<title>` tooltips.
- `special-chart/SpecialChartWidget.tsx` — widget shell. Dispatches to `ScatterRenderer` or `PieRenderer` based on `chartType`. Settings popover with chart type toggle, conditional field selectors, granularity picker, quarter filter tree (indeterminate checkboxes). Zero domain knowledge.
- `warehouse-occupancy/types.ts` — `WarehouseData` interface (the warehouse occupancy port)
- `warehouse-occupancy/WarehouseOccupancyWidget.tsx` — WHSE A/B/C/D occupancy progress bars with inline stats. Accepts `data: WarehouseData[]` prop. Computes total footer dynamically. Zero domain knowledge. Responsive via `useWidgetSize()`: xs/sm width shows minimal single-letter labels + compact bars; md shows partial stats (PHP/KG, MC); lg/xl shows full stats (PHP/KG, MC, ASH). Footer adapts label and format by width tier. Height tier controls vertical spacing and footer visibility.

## How to Add a New Widget Type
1. Create `components/widgets/<name>/<Name>Widget.tsx` — export a named React component
2. Call `useWidgetSize()` from `@/components/widgets/chart/utils` for responsive behavior
3. Define the data-agnostic interface (port) in `components/widgets/<name>/types.ts`
4. Add an entry to `WIDGET_REGISTRY` in `components/widgets/index.ts`
5. The widget receives no required props beyond what the parent `WidgetShell` provides via context, plus optional `data` props from the adapter layer

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

**`ChartConfig` interface** (port for `ChartWidget`):

`ChartConfig` now includes two additional fields:

| Field | Type | Description |
|-------|------|-------------|
| `fiscalCalendar` | `FiscalCalEntry[]` | All months spanning the data range, in chronological order. Each entry: `x` (chronological index starting 0), `calIdx` (0-11 Jan-based), `fiscalYear` (e.g. `'FY2025'`), `fiscalMonth` (0=Mar … 11=Feb), `label` (e.g. `'Mar 2025'`). |
| `dataYears` | `string[]` | Sorted fiscal year labels present in the data, e.g. `['FY2023', 'FY2024', 'FY2025']`. Used to populate year filter dropdowns. |

`x` values in `ChartDataPoint` are **chronological month indices** that reference positions in `fiscalCalendar`, not fixed 0-11 fiscal slots. An `x` of 0 is the earliest data month; `x` of N-1 is the most recent.

`getFilterIndices(filter, fiscalCalendar)` now requires the config's `fiscalCalendar` as its second argument. It returns the subset of `x` values matching the filter. Legacy year filters stored as `'2025'` are treated as `'FY2025'` for backward compatibility.

**Ports and Adapters model:**
- The **widget** is the application core
- The **port** is the typed interface it declares (`ChartConfig`, `KPIData`, `SpecialChartData`, `WarehouseData[]`, etc.)
- The **adapter** is whoever fills the port — the widget sees no difference between sources

**Three sources that can fill a port:**
1. **Static adapter** — `lib/widgets/mock-data.ts` exports pre-shaped data (fallback)
2. **Live adapter** — `lib/widgets/adapters/` — fetches from Supabase and transforms to port interface
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

**`KPIData` interface** (port for `KPIStripWidget`):

| Field | Type | Description |
|-------|------|-------------|
| `label` | `string` | Required. Display label, rendered uppercase + tracking-wider. |
| `value` | `string?` | Primary display value, pre-formatted. Chips with `value` = data chips (all tiers). Chips without = nav chips (lg/xl only). |
| `prefix` | `string?` | Unit prefix rendered before value (e.g., `"₱"`). |
| `suffix` | `string?` | Unit suffix rendered after value. |
| `sub` | `string?` | Secondary sub-line, pre-formatted. Falls back if `comparison` is not set. |
| `subTrend` | `'up' \| 'down' \| 'neutral'?` | Colors the sub line: emerald-500 / red-500 / muted-foreground. |
| `href` | `string?` | If set on a chip with no `value`, renders as a nav link in the lg/xl right section. |
| `accent` | `string?` | Tailwind `bg-*` class for the colored dot in the nav section (e.g., `"bg-emerald-500"`). |
| `variant` | `'default' \| 'flow' \| 'progress' \| 'ratio'?` | Chip rendering strategy. Default = legacy label+value+sub. |
| `thresholds` | `KPIThreshold[]?` | Adapter pre-sorts highest→lowest. Widget walks array to pick text color class. |
| `sparkline` | `number[]?` | Normalized by widget. Adapter decides period/count. Rendered as 40×14px SVG polyline. |
| `comparison` | `KPIComparison?` | Period-over-period delta. Shown beneath value when `showSub` is true; replaces `sub` line. |
| `flowData` | `KPIFlowData?` | Required when `variant === 'flow'`. Three-part in/out/net breakdown. |
| `pinned` | `boolean?` | When true, chip is always shown at xs/sm tiers (pinned to compact view). |
| `drilldown` | `{ href: string }?` | Wraps entire chip in a Next.js Link. |

**`KPIChipOverride` interface** (keyed by original chip label in `chipOverrides`):

| Field | Type | Description |
|-------|------|-------------|
| `labelOverride` | `string?` | Replaces `chip.label` in the display. Original label is still used as the `chipOverrides` key. |
| `pinned` | `boolean?` | Override the adapter's `pinned` flag for this chip. |
| `showComparison` | `boolean?` | `false` = hide the comparison/sub line for this chip. Narrows the global `showSub`, never expands it. |
| `showSparkline` | `boolean?` | `false` = hide the sparkline for this chip. Narrows the global `showSub`, never expands it. |

**`KPIStripSettings` interface**:

| Field | Type | Description |
|-------|------|-------------|
| `maxVisible` | `number?` | Max chips before collapsing (default: show all). |
| `layout` | `'horizontal' \| 'grid'?` | Override auto-layout by size tier. |
| `hidden` | `string[]?` | Labels of chips toggled off in the settings popover. |
| `order` | `string[]?` | Labels in display order. Unlisted chips append at the end. |
| `chipMode` | `'auto' \| 'compact' \| 'expanded'?` | Controls sub-line + sparkline visibility. `auto` = show at md+ height tier. |
| `period` | `'today' \| 'week' \| 'month' \| 'quarter' \| 'year'?` | Time window for live data fetches via `fetchKpiData` server action. |
| `chipOverrides` | `Record<string, KPIChipOverride>?` | Per-chip display overrides keyed by ORIGINAL chip label (before any `labelOverride`). Applied in `KPIStripWidget` after `applySettings()`. |

**`SpecialChartData` interface** (port for `SpecialChartWidget`):

| Field | Type | Description |
|-------|------|-------------|
| `rows` | `Record<string, string \| number \| null>[]` | One object per raw record. Field keys match `FieldDef.key`. |
| `fields` | `FieldDef[]` | Ordered list of field definitions. Drives axis labels, dropdowns, color logic. |

**`FieldDef` interface** (field metadata emitted by adapters):

| Field | Type | Description |
|-------|------|-------------|
| `key` | `string` | Row key. Must match a key in each `rows` record. |
| `label` | `string` | Human-readable display label (axis titles, dropdown options). |
| `type` | `'numeric' \| 'categorical'` | Determines which selectors the field appears in. |
| `unit` | `string?` | Optional unit string shown on axis labels (`'₱'`, `'%'`, `'kg'`). |

**`SpecialChartSettings` interface** (persisted in `D6Prefs.specialChartSettings`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `chartType` | `'scatter' \| 'pie' \| 'donut'` | `'scatter'` | Active renderer. |
| `xField` | `string?` | first numeric field | Field key for X axis (scatter). |
| `yField` | `string?` | second numeric field | Field key for Y axis (scatter). |
| `colorBy` | `string?` | `'year'` field, else first categorical | Field key for dot color grouping (scatter). |
| `granularity` | `'day' \| 'month' \| 'quarter' \| 'year'` | `'month'` | Aggregation granularity (scatter). |
| `showRefLines` | `boolean?` | `true` | Show mean reference lines (scatter). |
| `valueField` | `string?` | first numeric field | Field key to aggregate (pie/donut). |
| `aggregation` | `'sum' \| 'avg' \| 'count'` | `'sum'` | Aggregation function (pie/donut). |
| `groupBy` | `string?` | first categorical field | Field key to group by (pie/donut). |
| `quarterFilter` | `string[]?` | `[]` | "YYYY-QN" filter keys; empty = show all. |

**Chip Variants:**

| Variant | Renderer | Description |
|---------|----------|-------------|
| `default` | `DefaultChip` | Label + prefix/value/suffix + optional sparkline + comparison or sub line. |
| `flow` | `FlowChip` | Three-part in/out/net horizontal row. Requires `flowData`. `netValue` colored by sign. |
| `progress` | `ProgressChip` | Thin 3px progress bar between label and value. Percentage parsed from `value` string. |
| `ratio` | `RatioChip` | Label + mono value with threshold coloring. Simpler than default — no sub or sparkline. |

**`WarehouseData` interface** (port for `WarehouseOccupancyWidget`):

| Field | Type | Description |
|-------|------|-------------|
| `label` | `string` | Single-letter warehouse label: 'A', 'B', 'C', 'D'. |
| `occupied` | `number` | Count of occupied slots (active batches) in this warehouse. |
| `total` | `number` | Total physical slot count (A=60, B=40, C=40, D=80). |
| `phpKg` | `number` | Weighted average PHP/KG across all batches in this warehouse. |
| `mc` | `number` | Weighted average moisture content (%). |
| `ash` | `number` | Weighted average ash content (%). |

**Widget data prop status:**

| Widget | Data prop | Fallback |
|--------|-----------|---------|
| `KPIStripWidget` | `data: KPIData[]` | `CHARCOAL_KPI_DATA` from mock-data.ts |
| `ChartWidget` | `config?: ChartConfig` | `CHARCOAL_UNIVERSAL_CONFIG` from mock-data.ts |
| `SpecialChartWidget` | `data?: SpecialChartData` | `CHARCOAL_SPECIAL_DATA` from mock-data.ts |
| `WarehouseOccupancyWidget` | `data?: WarehouseData[]` | `CHARCOAL_WAREHOUSE_DATA` from mock-data.ts |

## Special Chart — Adapter Output Contract

`charcoalSpecialAdapter` (`lib/widgets/adapters/charcoal-special.ts`) returns one flat row per delivery with these keys:

| Key | Type | Notes |
|-----|------|-------|
| `date` | `string` | "YYYY-MM-DD" |
| `year` | `string` | "2026" |
| `month` | `string \| null` | "YYYY-MM" |
| `quarter` | `string \| null` | "YYYY-QN" |
| `supplier` | `string \| null` | |
| `batchCode` | `string \| null` | |
| `blockLoc` | `string \| null` | |
| `warehouse` | `string` | Derived from `block_loc[0]` |
| `weightKg` | `number \| null` | |
| `phpKg` | `number \| null` | |
| `phpTotal` | `number \| null` | phpKg × weightKg |
| `mc` | `number \| null` | From lab_results JSONB |
| `ash` | `number \| null` | |
| `bdAstm` | `number \| null` | |
| `bdJis` | `number \| null` | |
| `grit` | `number \| null` | |
| `vm` | `number \| null` | |
| `fc` | `number \| null` | |

Numeric fields are ordered so defaults produce PHP/KG (X) vs Weight (Y).
Categorical fields are ordered so default `colorBy` is Year.

## Migration Notes (quality-scatter → special-chart)

`loadPrefs()` in `DashboardGrid.tsx` migrates existing stored prefs:
- `visibleModules: 'quality-scatter'` → remapped to `'special-chart'`
- `layout[].i === 'quality-scatter'` → remapped to `'special-chart'`
- `scatterSettings` → copied to `specialChartSettings` preserving `granularity`, `quarterFilter`, `showRefLines`

## Dependencies
- `recharts` — `ComposedChart`, `Line`, `Bar`, `Area`, `XAxis`, `YAxis`, `Tooltip`, `ReferenceLine`
- `date-fns` — `format`, `parseISO`, `parse` (in `aggregation.ts` and `scatter-renderer.tsx`)
- `components/ui/popover` — settings popover in `ChartWidget` and `SpecialChartWidget`
- `lib/widgets/mock-data.ts` — static data fallbacks: `CHARCOAL_UNIVERSAL_CONFIG`, `CHARCOAL_KPI_DATA`, `CHARCOAL_WAREHOUSE_DATA`, `CHARCOAL_SPECIAL_DATA`, `LEDGER`, `USAGE_LEDGER`, `WAREHOUSE_LIST`, `PIVOT_MONTHS`, `FISCAL_TO_CALENDAR`, `SLICE_PALETTE`, `CHART_PALETTE`
- `lib/widgets/adapters/` — live Supabase adapters: `charcoalKpiAdapter`, `charcoalChartAdapter`, `charcoalWarehouseAdapter`, `charcoalSpecialAdapter`
- `lib/widgets/adapters/tenant-config.ts` — centralized tenant field/series/preset definitions. Both `charcoal-special.ts` and `charcoal-chart.ts` import from here instead of defining inline. Contains `CHARCOAL_FIELD_CONFIG`, `CHARCOAL_FIELDS`, `CHARCOAL_CHART_CONFIG`.

## See Also
- `components/dashboard/DashboardGrid.tsx` — consumes `WIDGET_REGISTRY` and renders widgets inside `WidgetShell`. Now accepts `DashboardGridProps` with optional live data props including `specialChartData` / `specialChartError`.
- `components/dashboard/DashboardShell.tsx` — SSR-safe wrapper (dynamic import, `ssr: false`) that accepts `DashboardGridProps` and passes them into `DashboardGrid`.
- `app/(app)/page.tsx` — Server Component that runs all 4 adapters in `Promise.allSettled`, falls back to static data on failure, passes results to `DashboardShell`.
- `app/(app)/CONTEXT.md` — dashboard module context
