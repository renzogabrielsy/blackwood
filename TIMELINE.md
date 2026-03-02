# Blackwood Project Timeline

> **Living document.** Update this file whenever a task is completed, a phase starts, or scope changes.
> Both Claude and Antigravity agents must read this file before starting any work session.
> Last updated: **2026-02-19**

---

## Recent Completions

| Date | Item |
|---|---|
| 2026-02-20 | SpecialChartWidget system rework. Replaced `QualityScatterWidget` + `charcoalScatterAdapter` with a fully generic `SpecialChartWidget` (scatter/pie/donut), `charcoalSpecialAdapter`, and supporting files. New files: `special-chart/types.ts` (`FieldDef`, `SpecialChartData`, `SpecialChartSettings`, `SpecialChartType`, `ScatterGranularity`), `special-chart/aggregation.ts` (pure aggregation utilities: `niceScale`, `numericFields`, `categoricalFields`, `fieldLabel`, `fieldUnit`, `granularityKey`, `aggregateScatterData`, `aggregatePieData`, `buildColorMap`, `YEAR_COLORS`, `GENERIC_PALETTE`), `special-chart/scatter-renderer.tsx` (generic SVG scatter; X/Y/colorBy all field-driven), `special-chart/pie-renderer.tsx` (SVG pie/donut with arc path math, GENERIC_PALETTE, donut center total), `special-chart/SpecialChartWidget.tsx` (shell dispatcher with settings popover — chart type toggle, field dropdowns, granularity, quarter filter tree). Adapter: `lib/widgets/adapters/charcoal-special.ts` — one flat row per delivery, 11 numeric + 7 categorical `FieldDef` fields, `CHARCOAL_FIELDS` constant. Deleted: `components/widgets/quality-scatter/` (entire directory), `lib/widgets/adapters/charcoal-scatter.ts`. Updated: `components/widgets/index.ts` (registry entry `special-chart`), `lib/dashboard/types.ts` (`specialChartSettings` replaces `scatterSettings`), `components/dashboard/DashboardGrid.tsx` (import swap, prop rename, handler rename, `renderWidgetContent` swap, `loadPrefs` migration for existing users), `app/(app)/page.tsx` (adapter swap), `lib/widgets/mock-data.ts` (`CHARCOAL_SPECIAL_DATA` replaces `CHARCOAL_SCATTER_DATA`), `components/widgets/CONTEXT.md`. Build: zero TypeScript errors. |
| 2026-02-19 | Simplified chart year model from fiscal years (Mar–Feb, 'FY' prefix) to plain calendar years. `charcoal-chart.ts`: replaced `getFiscalYear`/`getFiscalMonth` with `getCalYear`/`getCalMonth`; accumulator is now `Map<calYear, MonthAcc[12]>` (0=Jan). `FiscalCalEntry.fiscalYear` stores plain year string ('2025', '2026'); `fiscalMonth` = `calIdx` = 0=Jan…11=Dec. `STATIC_FISCAL_CALENDAR` in `mock-data.ts` updated: Jan 2026 → `fiscalYear:'2026', fiscalMonth:0`, Feb 2026 → `fiscalYear:'2026', fiscalMonth:1`. `dataYears: ['2025', '2026']`. `getFilterIndices` in `utils.ts`: removed `'FY' +` coercion; quarters updated to Q1=Jan–Mar, Q2=Apr–Jun, Q3=Jul–Sep, Q4=Oct–Dec. `ChartWidget`: `CURRENT_FY` → `CURRENT_YEAR`, `FISCAL_MONTH_LABELS` → `MONTH_LABELS` (Jan–Dec order), quarter dropdown labels updated, comparison slice filter `onChange` now auto-populates label from selected value. Build: zero TypeScript errors. |
| 2026-02-19 | Dashboard persistence foundation (`lib/dashboard/profile-store.ts`, multi-profile `bw_v1` store with migration from `bw_d6_prefs`). Shared types extracted to `lib/dashboard/types.ts` (`D6Prefs`, `LayoutItem`) to avoid circular imports. Grid reflow fix (`compactVertically` on pin, `prePinLayout` snapshot in `D6Prefs` for restore on unpin). Removed Inventory + Admin nav chips from KPI adapter (`lib/widgets/adapters/charcoal-kpi.ts`) + mock data (`lib/widgets/mock-data.ts`). Per-chip settings builder: `KPIChipOverride` type + `chipOverrides` in `KPIStripSettings` (`types.ts`), `applyChipOverrides()` in `KPIStripWidget.tsx`, inline expand panel in settings popover with label/pinned/showComparison/showSparkline controls (now `w-64`). Active profile name shown in dashboard header. Auto-fetch live KPI on mount when saved period != 'month'. Build: zero TypeScript errors. |
| 2026-02-19 | Sticky KPI Bar pinning feature. `D6Prefs` extended with `stickyKpi?: boolean`. Pin button added to KPI strip `WidgetShell` header action — pins the strip out of the grid into a second row of the sticky dashboard header. Unpin button in sticky row restores to grid with 200ms exit animation. `animate-kpi-enter` / `animate-kpi-exit` CSS keyframes added to `globals.css`. `STICKY_BAR_SIZE` module-level constant provides xl/sm tier to `WidgetSizeContext`. `IntersectionObserver` sentinel adds `shadow-lg` when header scrolls past viewport top. Mobile guard (`isMobile`, `max-width: 640px`) skips pinned mode on small screens — strip stays in grid. `showStickyBar` / `showKpiInGrid` derived booleans gate grid filter and map render loop. Build passes zero TypeScript errors. |
| 2026-02-19 | KPI Strip Widget Full Customization System. Extended `KPIData` port with `variant`, `thresholds`, `sparkline`, `comparison` (KPIComparison), `flowData` (KPIFlowData), `pinned`, `drilldown`. Extended `KPIStripSettings` with `hidden`, `order`, `chipMode`, `period`. Created `chips.tsx` (pure chip variant renderers: `DefaultChip`, `FlowChip`, `ProgressChip`, `RatioChip`, `Sparkline`, `ComparisonLine`, `getThresholdColor`). Created `settings-popover.tsx` (gear-icon popover: visibility toggle, reorder, density mode). Refactored `KPIStripWidget.tsx` with period selector (D/W/M/Q/Y), pinned-first xs/sm behavior, chip dispatcher. Updated `DashboardGrid.tsx`: `kpiSettings` in `D6Prefs`, `handleKpiSettingsChange`, `liveKpiData` state, `KPIStripSettingsPopover` in headerAction slot, inner `renderWidgetContent` function. Created `app/(app)/actions.ts` with `fetchKpiData(period)` server action. Updated `charcoalKpiAdapter` with `fetchWithPeriod()`, 6-query `queryAndBuild()` (adds sparkline query), new chip fields (pinned, variant, thresholds, drilldown, comparison, flowData). Updated `CHARCOAL_KPI_DATA` static mock with all new fields. Build passes zero TS errors. |
| 2026-02-19 | Removed all mock data fallbacks from dashboard adapter error handling. `WidgetError` component created (`components/dashboard/WidgetError.tsx`) — amber warning state with one-click clipboard copy of full diagnostic string (adapter ID, timestamp, stack trace). `DashboardGridProps` extended with `kpiError`, `chartError`, `warehouseError`, `scatterError`. `page.tsx` `formatAdapterError()` helper formats copy-friendly diagnostic strings. `DashboardGrid.tsx` checks error/data per widget type; renders `WidgetError` when either condition is met. All mock data fallback imports removed from both files. Build passes zero TS errors. |
| 2026-02-19 | Live Supabase adapters for all 4 dashboard widgets. `QualityScatterWidget` and `WarehouseOccupancyWidget` decoupled from mock-data. Port types (`ScatterPoint`, `WarehouseData`) created. `lib/widgets/adapters/` directory created with `types.ts`, `charcoal-kpi.ts`, `charcoal-chart.ts`, `charcoal-warehouse.ts`, `charcoal-scatter.ts`. `DashboardGrid` accepts `DashboardGridProps` (all optional, fall back to static). `DashboardShell` is the new SSR-safe client wrapper. `app/(app)/page.tsx` converted to async Server Component — runs all 4 adapters in `Promise.allSettled` with static fallback on failure. Build passes with zero TypeScript errors. |
| 2026-02-19 | `KPIStripWidget` decoupled from hardcoded data. Accepts `data: KPIData[]` prop. `KPIData` + `KPIStripSettings` interfaces defined in `kpi-strip/types.ts`. Static adapter exports `CHARCOAL_KPI_DATA` from `lib/widgets/mock-data.ts`. `DashboardGrid` passes it via prop. Zero domain knowledge remains in widget layer. |

---

## How to Read This File

- `[ ]` — Not started
- `[/]` — In progress
- `[x]` — Done
- **ETA** = estimated working days (not calendar days)
- Phases are sequential — each phase depends on the previous one being substantially complete
- Sub-tasks within a phase can sometimes be parallelized

---

## Current Sprint

**Focus:** Widget Resizing Refinement
**Started:** 2026-02-19
**Goal:** All widgets handle resizing as gracefully as `ChartWidget` — text scales, elements reflow, nothing clips at any size tier.

### Tasks
- [ ] Audit current resizing behavior across all 4 widgets
- [x] Refine `KPIStripWidget` — chip variants (flow/progress/ratio/default), pinned xs/sm, period selector, settings popover
- [x] Live Supabase prefs sync — `user_dashboard_prefs` table, `loadDashboardPrefs` / `saveDashboardPrefs` server actions, 1500ms debounce, `serverPrefs` prop seeds grid on hydration (Supabase-primary, localStorage-cache)
- [x] Multi-profile localStorage store — `lib/dashboard/profile-store.ts`, `bw_v1` key, migration from legacy `bw_d6_prefs`
- [x] Sticky KPI Bar — Pin/PinOff, second sticky header row, `prePinLayout` snapshot, mobile guard, `animate-kpi-enter`/`animate-kpi-exit`
- [x] `WidgetError` component — amber error state with one-click diagnostic clipboard copy
- [x] Calendar-year chart model — replaced fiscal-year (FY prefix, Mar–Feb) with plain calendar years (Jan–Dec)
- [x] Refine `QualityScatterWidget` → replaced with `SpecialChartWidget` (scatter/pie/donut, generic field system)
- [ ] Refine `WarehouseOccupancyWidget` — progress bars, stats collapse at small sizes
- [ ] Review `WidgetShell` — consider adding `fontScale` to `WidgetSizeContext`
- [ ] Manual QA across desktop, tablet (820px), mobile (393px) viewports

---

## Phase 1 — Widget Data Layer Decoupling
**ETA:** 5–8 days · **Status:** Complete · **Completed:** 2026-02-19

Break the static adapter coupling so widgets can receive data from any source. This is the foundational work that enables multi-tenant use.

### Tasks
- [ ] Move `CHART_PALETTE` and `SLICE_PALETTE` from `mock-data.ts` → `components/widgets/chart/constants.ts`
- [x] Refactor `getFilterIndices()` in `chart/utils.ts` — accepts `fiscalCalendar` as parameter instead of importing `FISCAL_TO_CALENDAR`
- [x] Convert `QualityScatterWidget` to accept data via props
- [x] Convert `WarehouseOccupancyWidget` to accept data via props
- [x] Define `WidgetAdapter<TPort>` interface type in `lib/widgets/adapters/types.ts`
- [x] Build live adapters: `charcoal-kpi`, `charcoal-chart`, `charcoal-warehouse`, `charcoal-scatter`
- [x] Wire live adapters into dashboard page with `Promise.allSettled` + `WidgetError` fallback on failure
- [x] Update `components/widgets/CONTEXT.md`

### Definition of Done
- Zero imports from `mock-data.ts` inside `components/widgets/` (except for default fallbacks passed via props)
- At least one widget renders live Supabase data via an adapter
- All existing widget behavior unchanged (no regressions)

---

## Phase 2 — Dashboard Persistence & Multi-Device
**ETA:** 4–5 days · **Status:** Complete (core persistence) · **Completed:** 2026-02-19

Dashboard layouts and prefs persisted to Supabase so users can see their layout on any device. Multi-profile support added via `profile-store.ts`.

### Tasks
- [x] Design `user_dashboard_prefs` table schema (`user_id` PK, `prefs` JSONB, `updated_at`)
- [x] Create Supabase migration and RLS policy (users can only access their own row)
- [x] Add Supabase persistence to `DashboardGrid.tsx` — `saveDashboardPrefs` with 1500ms debounce
- [x] Add localStorage as offline cache (`bw_v1` key, `profile-store.ts`) — Supabase-primary, localStorage-cache
- [x] `loadDashboardPrefs()` server action seeds `serverPrefs` prop at page render (no cold-start flicker)
- [x] `lib/dashboard/profile-store.ts` — pure multi-profile store; migrates from legacy `bw_d6_prefs`
- [x] `lib/dashboard/types.ts` — `D6Prefs` + `LayoutItem` extracted to avoid circular imports
- [ ] Add device-type detection (mobile / tablet / desktop) for responsive layout profiles
- [ ] Add responsive column breakpoints — 12 cols (desktop) → 6 (tablet) → 2 (mobile)

### Definition of Done
- Dashboard layout saved per user in Supabase
- Layout edits on desktop visible on phone after refresh
- Offline fallback works when Supabase is unreachable

---

## Phase 3 — Widget Registry V2 & New Widget Types
**ETA:** 5–7 days · **Status:** Not Started · **Depends on:** Phase 1

Make the widget system richer and more extensible for general-purpose use.

### Tasks
- [ ] Extend `WidgetDefinition` with `dataPort` type for typed adapter binding
- [ ] Add `category` field to registry (e.g., "Analytics", "Operations", "Monitoring")
- [ ] Support multi-instance for all widget types (not just charts)
- [ ] Build `TableWidget` — generic dense data table widget (TanStack Table inside a widget shell)
- [ ] Build `BlockingGridWidget` — wrap blocking grid pattern as a dashboard-embeddable widget
- [ ] Build `TextWidget` — markdown/rich-text display for notes, announcements
- [ ] Redesign WidgetPicker with category sections and search
- [ ] Update `components/widgets/CONTEXT.md` and `components/widgets/index.ts`

### Definition of Done
- Widget picker shows categories
- At least 3 new widget types functional
- Any widget type can have multiple instances

---

## Phase 4 — Mobile-Forward Design Pass
**ETA:** 5–8 days · **Status:** Not Started · **Depends on:** Phase 2, Phase 3

The "do everything on your phone" sprint. Touch-first UX, bottom sheets, responsive polish.

### Tasks
- [ ] Audit all interactive elements for 44×44px minimum touch targets
- [ ] Replace popovers with bottom sheets on mobile (< 768px)
- [ ] Add swipe-to-dismiss on widget detail panels and slide-overs
- [ ] Implement pull-to-refresh on dashboard
- [ ] Optimize blocking grid for portrait mobile — vertical scroll with fixed column headers
- [ ] Test navigation flow on iPhone 14 Pro (393×852) and Pixel 7 (412×915)
- [ ] Test on iOS Safari and Android Chrome for rendering differences
- [ ] Add haptic feedback triggers for iOS (via Capacitor later)

### Definition of Done
- All core workflows (dashboard view, widget config, inventory tables) usable with thumb-only navigation
- No horizontal scroll on any page at 375px width
- Touch targets ≥ 44×44px everywhere

---

## Phase 5 — Multi-Platform Packaging
**ETA:** 8–12 days · **Status:** Not Started · **Depends on:** Phase 4

Ship as a PWA, Electron desktop app, and Capacitor mobile app.

### Tasks
- [ ] Add PWA manifest (`manifest.json`) + service worker for installable web app
- [ ] Configure `next-pwa` or custom service worker with offline caching strategy
- [ ] Electron wrapper — main process, preload, window config
- [ ] Build Windows `.exe` installer (Electron Builder)
- [ ] Build macOS `.dmg` installer (Electron Builder)
- [ ] Capacitor project init + iOS/Android config
- [ ] Capacitor plugin integration (Push Notifications, Haptics, App Badge)
- [ ] Cross-platform notification bridge (web push → Capacitor push)
- [ ] CI/CD pipeline for multi-platform builds
- [ ] App Store / Play Store submission prep (icons, screenshots, descriptions)

### Definition of Done
- Web app installable as PWA from Chrome/Safari
- Electron `.exe` and `.dmg` build and launch successfully
- Capacitor iOS build runs on simulator
- Capacitor Android build runs on emulator
- Push notifications reach all platforms

---

## Future Backlog (Unscheduled)

These are ideas and features that may be prioritized into a future phase:

- [ ] Multi-tenant support — organization switcher, data isolation per tenant
- [ ] Custom widget builder — drag-and-drop widget creation UI
- [ ] Data connector marketplace — connect Shopify, QuickBooks, Google Sheets, etc.
- [ ] AI insights widget — GPT-powered anomaly detection on inventory data
- [ ] Audit trail / changelog for dashboard edits
- [ ] White-label theming — tenants can customize colors, logo, branding
- [ ] Role-specific default dashboards — different layouts per user role
- [ ] Export/import dashboard layouts as JSON
- [ ] Collaborative editing — multiple users editing the same dashboard
- [ ] Automated test suite (Playwright E2E + Vitest unit tests)

---

## Changelog

| Date | Change |
|---|---|
| 2026-02-19 | Sticky KPI Bar: `stickyKpi` pref, Pin/PinOff buttons, second header row with `WidgetSizeContext.Provider`, sentinel IntersectionObserver for shadow-on-scroll, mobile guard, `animate-kpi-enter`/`animate-kpi-exit` keyframes. Build: zero TypeScript errors. |
| 2026-02-19 | KPI Strip full customization: new chip variants (flow/progress/ratio), threshold coloring, sparklines, MoM comparison, period selector, settings popover (visibility + reorder + density). `chips.tsx` + `settings-popover.tsx` created. `KPIStripWidget` refactored. `DashboardGrid` wired with `kpiSettings` persistence + `liveKpiData` state. `app/(app)/actions.ts` created with `fetchKpiData` server action. `charcoalKpiAdapter.fetchWithPeriod()` added with 6-query build logic. Build: zero TypeScript errors. |
| 2026-02-19 | Live Supabase adapters implemented for all 4 widgets. Phase 1 widget decoupling tasks completed. `ScatterPoint`/`WarehouseData` port types created. `lib/widgets/adapters/` directory created with `WidgetAdapter<TPort>` base interface and 4 charcoal adapters. `page.tsx` converted to async Server Component with `Promise.allSettled` + static fallback pattern. `DashboardShell` created as SSR-safe client wrapper. `DashboardGrid` accepts `DashboardGridProps`. Build: zero TypeScript errors. |
| 2026-02-19 | `KPIStripWidget` fully decoupled — `KPIData`/`KPIStripSettings` types created, `CHARCOAL_KPI_DATA` static adapter added, widget now accepts `data` prop with zero domain knowledge in platform layer. |
| 2026-02-19 | Initial timeline created. Codebase audit confirmed hexagonal architecture is ready for general-purpose pivot. Current sprint set to widget resizing refinement. |
