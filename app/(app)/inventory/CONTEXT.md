# Inventory Module — Logs Shell + Standalone Routes

## Purpose
`/inventory` is the **logs shell** — a single page with TWO tabs: **Deliveries** (RC IN, server-rendered, default) and **Usage** (RC OUT, lazy). Blocking and RC Movement are NO LONGER tabs — they are **standalone routes** (`/inventory/blocking`, `/inventory/rc-movement`) that render outside the tab shell.

> **Domain Module (Charcoal Tenant):** Charcoal-specific operations layer. Sibling submodules — Blocking, RC IN (Deliveries), RC OUT (Usage), RC Movement — live under `/inventory/*` and share the thin layout, but only Deliveries + Usage share the tab system.

## Route map
| Route | What renders | Tab shell? |
|-------|--------------|------------|
| `/inventory` | Logs page — Deliveries + Usage tabs (the `LogsShell`) | **Yes** |
| `/inventory?tab=deliveries` | Logs page, Deliveries tab active (default) | Yes |
| `/inventory?tab=usage` | Logs page, Usage tab active | Yes |
| `/inventory/blocking` | Standalone warehouse grid + shared detail panel | **No** |
| `/inventory/rc-movement` | Standalone campaign feed matrix | **No** |
| `/inventory/flecon-bags` | Standalone FLECON bag inventory (balances + movement ledger) | **No** |

## URL contracts
- **`?tab=deliveries|usage`** — drives the logs tab (Phase 1). The URL is the source of truth (`useSearchParams` + `router.replace`, the project house style — NOT the nuqs library). localStorage (`inventory_active_tab`) is a **fallback only**: it seeds the tab on first load when no `?tab=` is present (written into the URL once, post-hydration). Default `deliveries`. Deep-linkable / shareable.
- **`?block=<block_loc>`** — drives the open block on `/inventory/blocking` (Phase 2). Deep-linkable, refresh-safe, browser Back closes the panel. Click a cell to toggle; clicking the open cell or pressing Escape clears it.
- **`?campaign=<PRODUCTION_BATCH-YEAR>`** — drives the selected campaign on `/inventory/rc-movement` (e.g. `JUNE-2026`). Absent → the server action resolves the most recent campaign. The matrix owns the month/day-range via the campaign.

## Files
| File | Role |
|------|------|
| `layout.tsx` | **THIN** shared chrome for ALL `/inventory/*` routes — just the `bg-muted/20` full-bleed container + padded content area. It deliberately does NOT own the tab shell anymore (so the standalone routes don't inherit the Deliveries/Usage tab bar). |
| `page.tsx` | Server component (the logs page). Fetches deliveries (year-scoped + paginated), batches, suppliers, locations; resolves `canViewPrices`. Wraps `<InventoryView>` in `<LogsShell>` inside a `<Suspense>` (the tab provider uses `useSearchParams`). |
| `loading.tsx` | Route-level skeleton (toolbar + header + 14 rows). Covers `/inventory` AND — by inheritance — `blocking` / `rc-movement` / `flecon-bags`, which have no loading file of their own (all dense grid surfaces, so one shape fits). Static pulses only — no row animation. |
| `components/logs-shell.tsx` | **NEW.** Client wrapper that owns the tab shell for the logs page ONLY: `InventoryTabProvider` + `Card` frame + `<InventorySheetTabs>` footer. Moved out of `layout.tsx` so the layout stays tab-shell-agnostic. |
| `components/inventory-tab-context.tsx` | React context — `activeTab`/`setActiveTab`. **URL-driven (`?tab=`)** via `useSearchParams` + `router.replace`; localStorage fallback only. Tab union narrowed to `'deliveries' \| 'usage'`. **Hosts the navigation-event bridge:** a `window` listener for `INVENTORY_NAVIGATE_EVENT` (from the shared detail panel's "Edit All" when rendered in-shell) that flips the tab. The standalone routes wire `onNavigateToBatch` directly instead, so they don't depend on this bridge. |
| `components/sheet-tabs.tsx` | Bottom tab bar with sliding indicator. Order: **Deliveries · Usage** (Blocking + Movement removed). |
| `components/inventory-view.tsx` | Crossfade wrapper. Renders only the Deliveries + Usage containers (150ms opacity transition). |
| `components/rc-out-lazy-tab.tsx` | Lazy fetch + render for the Usage tab (owned by another agent this wave). |
| `components/DeliverySheetFooter.tsx` | Year + 12-month picker — used by RC IN (Deliveries tab). |
| `_shared/` | **Shell-agnostic shared UI** (private folder — `_` prefix = never a route). `blocking-detail-panel.tsx` (the batch slide-over; exports `INVENTORY_NAVIGATE_EVENT`, `emitInventoryNavigate()`, `BlockingDetailNavTarget`, accepts optional `onNavigateToBatch`) + its private `edit-delivery-dialog.tsx`. Imports tenant data from `../blocking/*` + `../rc-in/*`; imports NOTHING from the tab shell — so both the standalone routes and the in-shell grid can render it. |

> **Deleted this wave:** `components/blocking-lazy-tab.tsx` and `components/rc-movement-matrix-lazy-tab.tsx` — their fetch / loading / error / `?campaign=` logic was moved into the standalone route views (`blocking/blocking-route-view.tsx`, `rc-movement/rc-movement-route-view.tsx`). No dead files remain.

## Data
- **Deliveries:** fetched in `page.tsx`, passed to `<DeliveryMasterTableWrapper>` (server-rendered + hydrated).
- **Usage:** lazy via `RcOutLazyTab` → `fetchRcOutTabData()` in `rc-out/actions.ts`.
- **Blocking (standalone route):** `BlockingRouteView` → `fetchBlockingGridData()` in `blocking/actions.ts`.
- **Movement (standalone route):** `RcMovementRouteView` → `fetchRcMovementMatrix(campaign?)` in `rc-movement/actions.ts`.

## Key Behaviors
### Tab system (logs page)
- **Default tab:** `deliveries` (when `?tab=` absent and no localStorage hint).
- **Source of truth:** the `?tab=` URL param. localStorage only seeds the initial tab.
- **Crossfade:** 150ms opacity transition (`inventory-view.tsx`); both containers stay mounted (non-active uses `absolute inset-0 invisible opacity-0 pointer-events-none`).
- **Tab bar:** glass strip (`bg-muted/50 backdrop-blur-sm`) at the Card bottom with a sliding zinc indicator + `text-background` inverted active state.

### Standalone routes (Blocking / Movement)
- Render their own full-height container inside the thin layout — **no tab-bar footer**.
- Each route view repurposes the deleted lazy-tab's fetch/loading/error/retry logic but is shell-agnostic (does NOT use `useInventoryTab`).
- "Edit All" from the shared detail panel navigates via `router.push('/inventory?tab=deliveries|usage&search=…&editBatch=…')` (wired through `onNavigateToBatch`), since there is no in-shell tab provider listening on these routes.

### Pending UI on URL writes (both standalone routes)
These routes are dynamic, so **every** `?param=` write costs a server round-trip (~1-3s) even when the data is already client-side. Both route views therefore wrap `router.replace` in `useTransition`; neither gave any feedback before, so a click looked dead and then the surface flipped.
- **`blocking-route-view.tsx` (`?block=`):** selection is mirrored in `useOptimistic(urlBlock)`, so the cell highlights and the detail panel open on the SAME frame as the click; React reverts to the URL value once the navigation settles (Back / refresh / abandoned navigation all stay correct). `blocking-grid.tsx` is untouched — it stays a controlled component fed `selectedLocKey`.
- **`rc-movement-route-view.tsx` (`?campaign=`):** TWO waits stack here — the navigation, then the `fetchRcMovementMatrix` action re-fetch in the effect. `isPending` covers the first, a `switching` flag (set on click, cleared when rows land) covers the second; together they dim the outgoing matrix (`opacity-50`, compositor-only) under a floating "Loading campaign…" spinner. The matrix stays mounted — nothing reflows, no row animates.

### Submodule catalog
| Surface | Submodule | Module CONTEXT |
|---------|-----------|----------------|
| Blocking (`/inventory/blocking`) | `blocking/` | [Blocking](./blocking/CONTEXT.md) — warehouse grid heatmap |
| Deliveries (`?tab=deliveries`) | `rc-in/` | [RC IN](./rc-in/CONTEXT.md) — Delivery Master Log |
| Usage (`?tab=usage`) | `rc-out/` | [RC OUT](./rc-out/CONTEXT.md) — Inventory Usage |
| Movement (`/inventory/rc-movement`) | `rc-movement/` | [RC Movement](./rc-movement/CONTEXT.md) — Daily Feed Matrix |
| Bag Inventory (`/inventory/flecon-bags`) | `flecon-bags/` | [FLECON Bags](./flecon-bags/CONTEXT.md) — packaging-material stock |

## The `?grid=v2` side-by-side (universal-table migration, 2026-08-18)

`/inventory?grid=v2` renders BOTH tabs on the **Blackwood Table** (`components/shared/table`) instead of the live tables. It is the strangler-fig method from `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`: the new grids are built BESIDE the production ones, and **`delivery-master-table.tsx`, `rc-out-table.tsx`, `bulk-delivery-input.tsx`, `bulk-usage-input.tsx`, both `actions.ts` and both mobile-card files are not edited by one character.**

| File | Role |
|------|------|
| `page.tsx` | **The only edited file.** Reads `?grid=` via `parseGrid` from `@/lib/table`, mounts `<GridVersionBar>` above the sheet, and picks `<InventoryViewV2>` or `<InventoryView>` with the same props. |
| `components/inventory-view-v2.tsx` | The `?grid=v2` twin of `inventory-view.tsx` — same `InventoryTabProvider`, both panes mounted, inactive one hidden. **No cross-fade** (see below). |
| `components/rc-out-lazy-tab-v2.tsx` | The twin of `rc-out-lazy-tab.tsx`; calls the SAME read-only `fetchRcOutTabData()` and mounts `RcOutGridV2`. |
| `rc-in/delivery-grid-v2.tsx` | RC IN on the Blackwood Table. Read-only. |
| `rc-out/rc-out-grid-v2.tsx` | RC OUT on the Blackwood Table. Read-only. |

**Five rules this obeys** (the recipe lives in `lib/table/CONTEXT.md` → "The side-by-side toggle"):

1. **ONE toggle governs BOTH tabs.** Deliveries and Usage are two views of one shell; two switches would let the screen sit half-migrated. `?tab=` and `?grid=` are independent axes — flipping either never disturbs the other.
2. **The param is an axis of the CLIENT, never of the data.** Every fetch in `page.tsx` runs identically either way; `?grid=` reaches no query, no action and no role gate.
3. **`?grid=` absent, misspelt, `V2` or `3` all mean the CURRENT tables.** Only the exact `v2` switches.
4. **The bar carries its own layout.** `GridVersionBar` is `shrink-0`; the page mounts it and never re-types its classes.
5. **BOTH v2 grids are READ-ONLY** — no editor, no save, no delete, no draft rows, no context menu, and no server action that writes is imported by either file. Column resize is session-local state, deliberately NOT persisted, because persisting it would be a write.

**Deliberate difference from the live view:** `inventory-view-v2.tsx` swaps tabs instantly instead of cross-fading. The live 150ms fade is driven by a `setTransitioning(true)` inside a `useEffect`, which is one of the repo's 28 pre-existing `react-hooks` lint errors (`inventory-view.tsx:26:9`); copying it would have added a 29th.

At cutover the bar, the param and all four v2 files either replace the live tables or are deleted with them. A permanent escape hatch is a second grid nobody maintains.

## Dependencies
- Submodules share `@/components/providers/auth-context` / `lib/auth` for permission gating (cost visibility).
- The logs shell uses `@/components/ui/card`.
- Tab state + block/campaign selection use `next/navigation` (`useSearchParams` / `useRouter` / `usePathname`).

## See Also
- [Navbar](../../../components/NAVBAR.md) — breadcrumbs for `/inventory`, `/inventory/blocking`, `/inventory/rc-movement`, `/inventory/flecon-bags` + the nested Inventory module dropdown
- [Auth Provider](../../../components/providers/AUTH.md) — permission model for cost visibility
