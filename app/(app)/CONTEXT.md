# Dashboard Module Context

## Purpose
The dashboard at `/` is the **platform-layer entry point** for Blackwood — intentionally source-agnostic and domain-neutral. It renders a composable grid of widgets using ReactGridLayout. Widget layout and per-widget settings persist to localStorage under the key `bw_d6_prefs`.

The dashboard shell and all widget components are **tenant-agnostic**: they contain zero charcoal-specific knowledge. What changes between tenants is only the adapter (and domain modules). The dashboard shell, widget registry, and widget components stay exactly the same.

## Files
- `page.tsx` — thin `'use client'` wrapper that dynamically imports `DashboardGrid` with `ssr: false` (ReactGridLayout does not SSR)
- `components/dashboard/DashboardGrid.tsx` — main grid shell: layout state, edit mode, add/remove/collapse, localStorage persistence
- `components/dashboard/WidgetShell.tsx` — generic widget frame (title bar, collapse toggle, remove button, ResizeObserver-backed `WidgetSizeContext`)
- `components/dashboard/WidgetPicker.tsx` — "Add widget" modal showing all types from `WIDGET_REGISTRY`

## Data Flow & Adapter Layer
- No server-side fetching at this layer. Widget data is provided via the **charcoal static adapter** (`lib/widgets/mock-data.ts`) — a tenant-specific, data-agnostic implementation of the platform's widget interfaces. It is charcoal-shaped, but structurally identical to what a live adapter would produce.
- When real live adapters are built (`lib/widgets/adapters/`), they drop in alongside `mock-data.ts`. The dashboard and widgets require **zero changes**.
- Layout and per-widget settings persist to localStorage key: `bw_d6_prefs`

## Key Behaviors
- **Edit mode** — toggle via "Edit Layout" button in sticky header. Enables drag (via `.drag-handle` class), resize (southeast handle), and per-widget remove buttons.
- **Collapse** — stores original height in component state, sets grid `h: 2`, restores on expand.
- **Widget picker** — shows `WIDGET_REGISTRY` singletons (one per dashboard) and a "Add Chart Widget" button for unlimited chart instances.
- **Chart instances** — `price-trajectory` is the seed instance; `uchart-{timestamp}` IDs for user-created charts. Settings stored per-instance in `prefs.widgetSettings`.
- **Reset layout** — available in edit mode, resets to `DEFAULT_PREFS`.

## Dependencies
- `components/widgets/` — widget registry and all widget components
- `react-grid-layout` — drag/resize grid (`GridLayout` + `verticalCompactor`)
- `lib/widgets/mock-data.ts` — static adapter (charcoal-shaped implementation of platform widget interfaces)
- `components/widgets/chart/utils.ts` — `WidgetSizeContext` for responsive tier system

## See Also
- `components/widgets/CONTEXT.md` — widget system architecture
- `components/NAVBAR.md` — dashboard has no title registered (left side empty per convention)
