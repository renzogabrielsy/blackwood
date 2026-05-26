# Inventory Module — Tab Container

## Purpose
The `/inventory` route is the single-page container for all inventory operations. Four tabs share the same layout and tab bar (sliding indicator + glass strip), all crossfading through a single `displayTab` state. Each tab is lazy-loaded except for Deliveries (which is server-rendered for first paint).

> **Domain Module (Charcoal Tenant):** Charcoal-specific operations layer. Sibling submodules — Blocking, RC IN (Deliveries), RC OUT (Usage), RC Movement — share this layout and tab system.

## Files
| File | Lines | Role |
|------|-------|------|
| `page.tsx` | ~105 | Server component. Fetches deliveries (year-scoped + paginated), batches, suppliers, locations, user role. Renders `<InventoryView>` with these props. |
| `layout.tsx` | ~22 | Wraps content in `InventoryTabProvider` + `Card` shell + `<InventorySheetTabs />` footer bar. |
| `components/inventory-tab-context.tsx` | ~45 | React context — `activeTab`/`setActiveTab` + localStorage persistence (key `inventory_active_tab`). Tab union: `'deliveries' \| 'usage' \| 'blocking' \| 'movement'`. |
| `components/sheet-tabs.tsx` | ~75 | The bottom tab bar with sliding indicator. Order: Blocking · Deliveries · Usage · Movement. |
| `components/inventory-view.tsx` | ~70 | Crossfade wrapper. Renders all four tab containers; only the active one is visible (opacity transition over 150ms). |
| `components/rc-out-lazy-tab.tsx` | ~70 | Lazy fetch + render for the Usage tab. |
| `components/blocking-lazy-tab.tsx` | ~75 | Lazy fetch + render for the Blocking tab. Fetches on first activation, retry button on failure. |
| `components/rc-movement-lazy-tab.tsx` | ~105 | Lazy fetch + render for the Movement tab. Manages year/month state, syncs to URL params (`?y=&m=`), refetches on picker change. |
| `components/DeliverySheetFooter.tsx` | ~230 | Full year+12-month picker — used by RC IN (Deliveries tab). RC Movement uses a simpler inline picker. |

## Data
- **Deliveries:** fetched in `page.tsx`, passed to `<DeliveryMasterTableWrapper>` (server-rendered + hydrated)
- **Usage:** lazy via `RcOutLazyTab` → `fetchRcOutTabData()` in `rc-out/actions.ts`
- **Blocking:** lazy via `BlockingLazyTab` → `fetchBlockingGridData()` in `blocking/actions.ts`
- **Movement:** lazy via `RcMovementLazyTab` → `fetchRcMovementData(year, month)` in `rc-movement/actions.ts`

## Key Behaviors

### Tab system
- **Default tab:** `'deliveries'` (set in `InventoryTabProvider` initial state)
- **Persistence:** localStorage key `inventory_active_tab` — restored after hydration to avoid SSR mismatch
- **Crossfade:** 150ms opacity transition between tabs (`inventory-view.tsx`). All four containers stay mounted; non-active tabs use `absolute inset-0 invisible opacity-0 pointer-events-none`. This avoids re-mount cost when switching back to a previously-loaded tab.
- **Tab bar:** glass strip (`bg-muted/50 backdrop-blur-sm`) at the bottom of the Card, with sliding zinc indicator and `text-background` inverted active state.

### Lazy loading pattern
- Blocking, Usage, and Movement tabs do NOT fetch on initial page render — only when the user first activates that tab. This keeps the initial load fast even though Movement queries can be large.
- Each lazy tab has its own `loading` and `error` states, with a Retry button on failure.
- The Deliveries tab is the exception — it's server-rendered in `page.tsx` for fast first paint, since it's the default landing tab.

### Tab Catalog
| Tab | Submodule | Module CONTEXT |
|-----|-----------|----------------|
| Blocking | `blocking/` | [Blocking](./blocking/CONTEXT.md) — warehouse grid heatmap |
| Deliveries | `rc-in/` | [RC IN](./rc-in/CONTEXT.md) — Delivery Master Log |
| Usage | `rc-out/` | [RC OUT](./rc-out/CONTEXT.md) — Inventory Usage |
| Movement | `rc-movement/` | [RC Movement](./rc-movement/CONTEXT.md) — Batch Feed Movement Log |

## Dependencies
- All four submodules share `@/components/providers/auth-context` for permission gating
- Layout uses `@/components/ui/card` for the outer shell
- The bottom tab bar uses the same sliding-indicator pattern as `DeliverySheetFooter` (year + month controls)

## See Also
- [Navbar](../../../components/NAVBAR.md) — registers `/inventory` breadcrumb and page title
- [Auth Provider](../../../components/providers/AUTH.md) — permission model for cost visibility
