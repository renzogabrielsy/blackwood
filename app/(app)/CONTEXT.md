# Dashboard Module Context

## Purpose
The dashboard at `/` is the **platform-layer entry point** for Blackwood — intentionally source-agnostic and domain-neutral. It renders a composable grid of widgets using ReactGridLayout. Widget layout and per-widget settings persist to localStorage under the key `bw_v1` (multi-profile store; migrates from the legacy `bw_d6_prefs` key on first load).

The dashboard shell and all widget components are **tenant-agnostic**: they contain zero charcoal-specific knowledge. What changes between tenants is only the adapter (and domain modules). The dashboard shell, widget registry, and widget components stay exactly the same.

## Files
- `page.tsx` — **async Server Component** (no `'use client'`). Runs all 4 charcoal adapters + `loadDashboardPrefs()` in `Promise.allSettled` (5 items), falls back to static mock data on adapter failure, passes results to `DashboardShell`.
- `actions.ts` — Server actions: `fetchKpiData` (KPI period refetch), `loadDashboardPrefs` (read `user_dashboard_prefs` → `D6Prefs | null`), `saveDashboardPrefs` (upsert `user_dashboard_prefs` on `user_id` conflict, no `revalidatePath`).
- `components/dashboard/DashboardShell.tsx` — SSR-safe client wrapper (`'use client'`, `dynamic(..., { ssr: false })`). Accepts `DashboardGridProps` and passes through to `DashboardGrid`.
- `components/dashboard/DashboardGrid.tsx` — main grid shell: layout state, edit mode, add/remove/collapse, localStorage + Supabase persistence. Accepts `DashboardGridProps` (`kpiData`, `chartConfig`, `warehouseData`, `scatterData`, `serverPrefs`) — all optional with static fallbacks.
- `lib/dashboard/types.ts` — shared TypeScript types (`D6Prefs`, `LayoutItem`) — extracted here to prevent circular imports between `DashboardGrid.tsx` and `profile-store.ts`.
- `lib/dashboard/migrate-prefs.ts` — pure function `migrateLegacyPrefs(raw, defaults)` that normalizes raw stored prefs into a clean `D6Prefs` object. Handles widget settings format upgrades, `quality-scatter` → `special-chart` remap, `scatterSettings` → `specialChartSettings` carry-over, and missing-field defaults. Called by `DashboardGrid.tsx` on mount.
- `lib/dashboard/profile-store.ts` — pure (no React, no Supabase) localStorage utility. Manages `bw_v1` multi-profile store. Exports: `loadProfileStore`, `saveProfileStore`, `getActiveProfile`, `updateActiveProfile`, `listProfiles`, `createProfile`, `switchProfile`, `deleteProfile`, `getActiveProfileName`.
- `components/dashboard/WidgetShell.tsx` — generic widget frame (title bar, collapse toggle, remove button, ResizeObserver-backed `WidgetSizeContext`)
- `components/dashboard/WidgetPicker.tsx` — "Add widget" modal showing all types from `WIDGET_REGISTRY`

## Data Flow & Adapter Layer

**Live data (current):**
1. `page.tsx` (Server Component) calls `createClient()` and runs `Promise.allSettled([kpiAdapter, chartAdapter, warehouseAdapter, scatterAdapter, loadDashboardPrefs()])`
2. Fulfilled results are passed as props to `DashboardShell` → `DashboardGrid`
3. Rejected/failed adapters fall back to their static counterparts from `lib/widgets/mock-data.ts`
4. `DashboardGrid` passes data to widgets via `renderWidgetContent()`

**Dashboard preferences persistence (dual-layer):**
- **Primary store:** Supabase `user_dashboard_prefs` table — server-side, persists across devices and browsers. Loaded at page render and seeded into `DashboardGrid` via `serverPrefs` prop. Written back on every prefs mutation via a 1500ms debounce (`saveDashboardPrefs` from `actions.ts`).
- **Cache layer:** `localStorage` via `profile-store.ts` (`bw_v1` key) — instant read on hydration, no network round-trip for subsequent visits in the same browser. Updated synchronously alongside the debounced Supabase write.
- **Seed priority:** On mount, `loadPrefs(props.serverPrefs)` uses `serverPrefs` as `raw` when present, falling back to `getActiveProfile(DEFAULT_PREFS)` from localStorage. This means a fresh browser gets the correct layout on first load without waiting for a client-side read.
- **Failure isolation:** If `loadDashboardPrefs()` throws (auth error, network, etc.), `Promise.allSettled` absorbs it and `serverPrefs` is `undefined` — the grid falls back to localStorage as before. If `saveDashboardPrefs` throws, the `.catch(() => {})` swallows it silently.

**Adapter files (in `lib/widgets/adapters/`):**
- `types.ts` — `WidgetAdapter<TPort>` base interface
- `tenant-config.ts` — centralized charcoal tenant configuration. Exports `CHARCOAL_FIELD_CONFIG` (field definitions for special chart), `CHARCOAL_FIELDS` (flat array alias), `CHARCOAL_CHART_CONFIG` (series/group/preset metadata for chart widget). Both `charcoal-special.ts` and `charcoal-chart.ts` import from here. Marked as the tenant override point.
- `charcoal-kpi.ts` — fetches batches, view_blocking_grid, deliveries, rc_out → `KPIData[]`
- `charcoal-chart.ts` — fetches deliveries + rc_out, aggregates by fiscal month → `ChartConfig`. Series metadata imported from `tenant-config.ts`.
- `charcoal-warehouse.ts` — fetches view_blocking_grid, aggregates per warehouse letter → `WarehouseData[]`
- `charcoal-special.ts` — fetches deliveries with lab_results, flattens to row-per-delivery → `SpecialChartData`. Field definitions imported from `tenant-config.ts`.

**Static fallbacks (from `lib/widgets/mock-data.ts`):**
- `CHARCOAL_KPI_DATA` — fallback KPI data
- `CHARCOAL_UNIVERSAL_CONFIG` — fallback chart config
- `CHARCOAL_WAREHOUSE_DATA` — fallback warehouse occupancy data (typed `WarehouseData[]`)
- `CHARCOAL_SCATTER_DATA` — fallback scatter data (typed `ScatterPoint[]`, derived from `LEDGER`)

Layout and per-widget settings persist to **both** Supabase (`user_dashboard_prefs` table, keyed by `user_id`) and localStorage key `bw_v1` (multi-profile store, migrates from legacy `bw_d6_prefs` on first load). Supabase is the primary source of truth; localStorage is the cache.

`D6Prefs` fields (defined in `lib/dashboard/types.ts`):
- `layout` — grid item positions/sizes
- `visibleModules` — ordered list of widget IDs to render
- `collapsed` — IDs of collapsed widgets
- `widgetSettings` — per-chart-instance settings keyed by widget ID
- `kpiSettings` — KPI strip visibility/order/density/chipOverrides settings
- `stickyKpi` — `boolean` (default `false`). When `true`, the KPI strip is removed from the grid and rendered in a second row inside the sticky header, providing always-visible KPIs while scrolling.
- `prePinLayout` — `LayoutItem[] | undefined`. Snapshot of the full grid layout saved just before the KPI strip is pinned. Restored verbatim when the strip is unpinned. `undefined` when not pinned.

## Key Behaviors
- **Edit mode** — toggle via "Edit Layout" button in sticky header. Enables drag (via `.drag-handle` class), resize (southeast handle), and per-widget remove buttons.
- **Collapse** — stores original height in component state, sets grid `h: 2`, restores on expand.
- **Widget picker** — shows `WIDGET_REGISTRY` singletons (one per dashboard) and a "Add Chart Widget" button for unlimited chart instances.
- **Chart instances** — `price-trajectory` is the seed instance; `uchart-{timestamp}` IDs for user-created charts. Settings stored per-instance in `prefs.widgetSettings`.
- **Reset layout** — available in edit mode, resets to `DEFAULT_PREFS`.
- **Adapter fallback** — `Promise.allSettled` ensures a single failing adapter never breaks the whole dashboard. Each widget independently falls back to its static data.
- **Sticky KPI Bar** — clicking the Pin icon in the KPI strip's header action sets `stickyKpi: true`. The strip is removed from the ReactGridLayout grid and re-rendered in a second row inside the sticky dashboard header via `WidgetSizeContext.Provider` with a fixed `xl/sm` tier. An `IntersectionObserver` on a sentinel `<div>` adds `shadow-lg` to the header when it scrolls past the viewport top. An Unpin button (PinOff icon) restores the strip to the grid with a 200ms `animate-kpi-exit` animation. On screens ≤640px (`isMobile`), sticky mode is disabled — strip always stays in the grid.

## Dependencies
- `components/widgets/` — widget registry and all widget components
- `react-grid-layout` — drag/resize grid (`GridLayout` + `verticalCompactor`)
- `lib/widgets/mock-data.ts` — static adapter fallbacks
- `lib/widgets/adapters/` — live Supabase adapters
- `lib/supabase/server.ts` — `createClient()` for server-side Supabase access
- `components/widgets/chart/utils.ts` — `WidgetSizeContext` for responsive tier system

## See Also
- `components/widgets/CONTEXT.md` — widget system architecture, port types, adapter contract
- `components/NAVBAR.md` — dashboard has no title registered (left side empty per convention)
