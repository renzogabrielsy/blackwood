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
- **`?grid=v1|v2`** — which implementation of BOTH tables renders. **On this page the default is `v2`** (the Blackwood Table) and `?grid=v1` reaches the classic tables; every other screen on the toggle still defaults to `v1`. An axis of the CLIENT only — see the flip section below.
- **`?year=<yyyy>|all`** + **`?month=<1-12>|all`** — the **PERIOD axis** on the v2 grids (`lib/table/period-param.ts`, control `components/shared/table/PeriodPicker.tsx`). ONE pair for BOTH tabs. `year` bounds the server query and always has; `month` is client-side over rows already fetched. **Absent means this page's default** — the current calendar month of the current year, falling back to the year's latest month with data — so `all months` is written out loud as `?month=all` and is never absence. A month outside `1-12` (and `?month=aug`, `?month=0`, `?month=`) resolves to the default rather than half-selecting anything, exactly like `?grid=`. See the period section below.
  - **Not to be confused with the classic table's `?m=`**, which is ZERO-based (`?m=7` means August) and belongs to `DeliverySheetFooter`. The two params are independent and neither reads the other; `?m=` is untouched by this work.

## Files
| File | Role |
|------|------|
| `layout.tsx` | **THIN** shared chrome for ALL `/inventory/*` routes — just the `bg-muted/20` full-bleed container + padded content area. It deliberately does NOT own the tab shell anymore (so the standalone routes don't inherit the Deliveries/Usage tab bar). |
| `page.tsx` | Server component (the logs page). Fetches deliveries (year-scoped + paginated), batches, suppliers, locations; resolves `canViewPrices`. Wraps `<InventoryViewV2>` — or `<InventoryView>` at `?grid=v1` — in `<LogsShell>` inside a `<Suspense>` (the tab provider uses `useSearchParams`). Both branches get the identical payload. |
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

## The Blackwood Table is this screen's DEFAULT (2026-08-21) — `?grid=v1` is the way back

**This page flipped.** `/inventory` — both tabs — now renders on the **Blackwood Table**
(`components/shared/table`), and the classic tables are reached at **`?grid=v1`**. Renzo
authorised exactly these two screens: *"I'm satisfied with ICTC Deliveries and Usage table
so we can start to make grid v2 as our current table now for those 2."*

**It is a DEFAULT FLIP, not a cutover.** Nothing was deleted, nothing was migrated, and the
classic tables stay **fully reachable and fully functional** — they are the editing fallback
Renzo tests against for as long as he wants. The only change is which one you land on.

| URL | What renders |
|---|---|
| `/inventory` (and any unrecognised `?grid=`) | **v2** — the Blackwood Table, both tabs |
| `/inventory?grid=v2` | v2, the default spelt out loud |
| `/inventory?grid=v1` | **the classic tables** — `DeliveryMasterTable` / `RcOutTable`, untouched |

The toggle in the bar reads **`Classic` · `Table (new)`** here rather than `Current` · `New`
(the labels are props on `GridVersionBar`), because "Current" would be a lie on a page whose
current table is the new one. The amber accent stays on the v2 side, as on every other
screen, so a screenshot still says which grid produced it.

**The other nine toggle screens are untouched** — RC Movement, Production Daily /
Electricity / Trucks, Flecon Bags, Cenapro Production / QC / Deliveries all still default to
their live tables and still switch on `?grid=v2`. The default is a per-page argument
(`resolveGrid(grid, GRID_V2)` / `defaultVersion={GRID_V2}`), not a change to the param.

It remains the strangler-fig method from
`handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`: the new grids
were built BESIDE the production ones, and **`delivery-master-table.tsx`, `rc-out-table.tsx`,
`bulk-delivery-input.tsx`, `bulk-usage-input.tsx`, both `actions.ts` and both mobile-card
files are not edited by one character.**

| File | Role |
|------|------|
| `page.tsx` | Reads `?grid=` via `resolveGrid(grid, GRID_V2)` from `@/lib/table`, mounts `<GridVersionBar defaultVersion={GRID_V2} …>` above the sheet, and picks `<InventoryViewV2>` or `<InventoryView>` with the same props. **Also resolves the PERIOD** (`?year=` / `?month=`) once and threads it to the picker and both grids. |
| `components/inventory-view-v2.tsx` | The `?grid=v2` twin of `inventory-view.tsx` — same `InventoryTabProvider`, both panes mounted, inactive one hidden. **No cross-fade** (see below). Passes `periodYear` / `periodMonth` to both panes. |
| `components/rc-out-lazy-tab-v2.tsx` | The twin of `rc-out-lazy-tab.tsx`; calls the SAME read-only `fetchRcOutTabData()` and mounts `RcOutGridV2`. Forwards the period. |
| `rc-in/delivery-grid-v2.tsx` | RC IN on the Blackwood Table. **Editable** (inline edits + a blank-row pool, through the existing server actions). Cuts its rows to the selected month. |
| `rc-out/rc-out-grid-v2.tsx` | RC OUT on the Blackwood Table. Read-only. Cuts its rows to the selected **year AND month** — its fetch is not year-scoped. |

**Five rules this obeys** (the recipe lives in `lib/table/CONTEXT.md` → "The side-by-side toggle"):

1. **ONE toggle governs BOTH tabs.** Deliveries and Usage are two views of one shell; two switches would let the screen sit half-migrated. `?tab=` and `?grid=` are independent axes — flipping either never disturbs the other.
2. **The param is an axis of the CLIENT, never of the data.** Every fetch in `page.tsx` runs identically either way; `?grid=` reaches no query, no action and no role gate.
3. **`?grid=` absent, misspelt, `V2` or `3` all mean this page's DEFAULT — which is now v2.** Only the exact `v1` reaches the classic tables, and only the exact `v2` reaches the new ones on the nine screens that have not flipped. A typo can never half-select anything, on either kind of page.
4. **The bar carries its own layout.** `GridVersionBar` is `shrink-0`; the page mounts it and never re-types its classes.
5. **RC OUT v2 is READ-ONLY** — every column `cellKind: 'readonly'`, no `parse`, no draft pool, and no server action that writes is imported by that file. **RC IN v2 edits and saves** (2026-08-21) through the existing `bulkUpdateDeliveries` / `submitBulkDeliveries`, with no new SQL. Column resize is session-local state on both, deliberately NOT persisted.

## The PERIOD picker — one Year + Month pair for both tabs (2026-08-21)

Renzo: *"both deliveries and usage need to be filtered using the dropdowns of year and month,
im sure this is a pattern for most tables we're using"* — and it is, which is why the control
is **platform chrome**, not a pair of selects on this page. `components/shared/table/PeriodPicker.tsx`
knows no module, no column and no currency; `lib/table/period-param.ts` owns what its URL
means. This is the `PeriodPicker` that Stage 1B listed as deferred chrome.

**Where it sits:** the RIGHT-HAND slot of the existing `GridVersionBar` (`trailing`), so the
grid toggle and the period controls are ONE strip above the sheet rather than two — a second
bar costs a row of the sheet. It renders on the **v2 branch only**; the classic table keeps
its own footer strip and popovers, untouched.

| URL | The period in force |
|---|---|
| `/inventory` | **the current month of the current year** — or that year's latest month with data if the current one is empty |
| `/inventory?month=3` | March of the current year |
| `/inventory?year=2025&month=3` | March 2025 |
| `/inventory?month=all` | every month of the current year |
| `/inventory?year=all` | every year — the month select goes inert, because one calendar month spread across nine years is not a period anybody reads |
| `/inventory?search=…` | **`all` / `all`, and the picker is inert** — the search query deliberately drops the date bound and spans every year, so narrowing it would throw away most of the hits. The `?year=` in the URL is untouched and returns when the search clears. |

**The rules, and why each is not optional**

1. **ONE pair for BOTH tabs**, for the same reason there is one grid toggle for both. Two
   period controls would let the screen sit showing August on Deliveries and March on Usage.
   Flipping the tab is therefore a period NON-event.
2. **Every other param survives, in both directions.** `withPeriod` copies the query
   exhaustively (`tab`, `grid`, `search`, filters) and touches only its own two keys; the
   toggle's `withGrid` does the same for the period. Verified as a round trip on a URL
   carrying all five.
3. **The year bounds the QUERY; the month does not.** The year's rows are already in hand,
   so the month is a cut of a payload that arrived either way — the same model the live
   footer strip has always used, and why flipping between two months is instant rather than
   a server round trip. RC OUT is the exception in one direction only: `fetchRcOutTabData()`
   returns every row there has ever been, so its grid cuts the **year too**.
4. **The cut happens in `flatten`, upstream of every accumulator**, so the sticky Σ rule-off,
   each month heading and RC OUT's blended ₱/kg all describe the **filtered** set. `inPeriod`
   is the one definition both grids call — string slicing on `yyyy-MM-dd`, never a `Date`,
   because parsing a stored date back to ask its month is where a timezone moves a row to the
   previous day.
5. **A single month renders NO month headings and NO spacers.** A heading naming the only
   month present carries no information, and its totals would repeat the pinned Σ rule-off
   digit for digit. The totals are said ONCE, at the foot; the headings return the moment the
   sheet spans more than one month. Each sheet also names its period beside its row count and
   in its empty state — *"No deliveries in July 2026"* is an answer, *"No deliveries"* looks
   like missing data.
6. **The year list is DERIVED, not hard-coded.** The classic footer offers `currentYear + 1`
   down to `2010` — sixteen years the ledger has never held. `page.tsx` reads the earliest and
   latest `transaction_date` (two `limit(1)` queries, folded into the existing `Promise.all`)
   and lists exactly that span, extended to the current year. It is deliberately NOT stretched
   to reach whatever `?year=` says: `?year=9999` parses, and folding it in would build an
   eight-thousand-item dropdown. A year the URL names but the list does not hold is prepended
   by the control itself.
7. **A typed year is what a blank row's date means.** `DeliveryGridV2`'s `fallbackYear` used to
   be the newest dated row in view, with a note that the real answer was the `?year=` param
   `page.tsx` did not thread down. It does now — so an operator looking at 2025 who types
   `3/14` lands in March 2025. The data derivation survives underneath for `?year=all` and for
   a search, where the period names no single year.

**Deliberate difference from the live view:** `inventory-view-v2.tsx` swaps tabs instantly instead of cross-fading. The live 150ms fade is driven by a `setTransitioning(true)` inside a `useEffect`, which is one of the repo's 28 pre-existing `react-hooks` lint errors (`inventory-view.tsx:26:9`); copying it would have added a 29th.

At cutover — which is a SEPARATE, later decision from this flip — the bar, the param and the classic tables go together. Until then the fallback is deliberate and supported. A permanent escape hatch is a second grid nobody maintains; a fallback with a stated end is how a migration is tested in production.

## Dependencies
- Submodules share `@/components/providers/auth-context` / `lib/auth` for permission gating (cost visibility).
- The logs shell uses `@/components/ui/card`.
- Tab state + block/campaign selection use `next/navigation` (`useSearchParams` / `useRouter` / `usePathname`).

## See Also
- [Navbar](../../../components/NAVBAR.md) — breadcrumbs for `/inventory`, `/inventory/blocking`, `/inventory/rc-movement`, `/inventory/flecon-bags` + the nested Inventory module dropdown
- [Auth Provider](../../../components/providers/AUTH.md) — permission model for cost visibility
