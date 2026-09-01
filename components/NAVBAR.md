# Navbar Component

## Purpose
Persistent navigation bar (`components/navbar.tsx`). Owns ALL page titles/descriptions via the `BREADCRUMB_REGISTRY` + `getBreadcrumb()`. Dark-themed in both modes. Pages MUST NOT render their own title/description headers — register them here instead.

> **Platform Chrome:** The navbar is platform-level chrome — it must remain domain-neutral. Module links and breadcrumbs are tenant-registered navigation entries, not hardcoded charcoal concepts. Any future tenant module is registered in the registry + the `MODULES`-family constants the same way.

## Layout (3-column)
- **Left:** Breadcrumb — `← {backLabel} / {pageTitle}` + muted `pageDescription` (**`hidden sm:flex` — desktop only**). Below `sm` a **hamburger `Sheet` trigger** (`sm:hidden`) takes its place — see [Mobile Navigation](#mobile-navigation-below-sm).
- **Center:** "Blackwood" logo (always visible, links to `/`)
- **Right:** Modules dropdown (Factory icon), dev role switcher (Shield, privileged only), dark-mode toggle, notification bell, profile avatar

The dashboard (`/`) returns `null` from `getBreadcrumb()` — no breadcrumb shown, and since
2026-08-28 there is no exception: `/` hosts one surface again. `getBreadcrumb()` still
resolves on pathname **+ query params** — the signature and the `params` thread are intact —
but NO entry consults `params` today. The one that did (`/?view=schedule`, the Production
Schedule) went with the retired plan; see `_archived/prod-schedule-v1/`. Keep the parameter:
the next multi-view route needs it, and the wiring (`useSearchParams()` in `Navbar`) is the
part that is easy to get wrong.

## Mobile Navigation (below `sm`)
Additive, mobile-only. At 375px the desktop breadcrumb (fixed `shrink-0` parts ~180px) can't fit the narrow left region without clipping/overflow (Audit 10). Fix:

- The desktop breadcrumb block is wrapped in `hidden sm:flex` → shows **only at `sm`+** (desktop navbar unchanged above `sm`).
- Below `sm`, a `sm:hidden` hamburger (`Menu` icon) `Button` in the left region opens a shadcn `Sheet` (`side="left"`), rendered by the module-level **`MobileNav`** component.
- The sheet is a normal `bg-background` surface (readable nav, per the sheet glass convention) — NOT the dark navbar theme. The **BAR itself stays dark** (`bg-zinc-800 dark:bg-zinc-700`), only the slide-out panel is a normal surface.
- **Header:** shows the current `getBreadcrumb(pathname, searchParams).pageTitle` (fallback `"Dashboard"` for the bare `/`), since the breadcrumb text is now hidden on mobile. Same title resolution the breadcrumb uses.
- **Body:** REUSES the same three constants the desktop Modules dropdown renders — `ICTC_INVENTORY` / `ICTC_MODULES` / `CENAPRO_MODULES` — plus the identical `PRIVILEGED_ROLES` conditional section (Sync Review · Review Queue · Admin Panel). **No duplicated link list** — single source of truth. The nesting (ICTC · Davao → indented Inventory sub-group → sibling modules → Cenapro · Cebu → privileged) mirrors the dropdown structure.
- **Close-on-navigate:** each live row is a module-level **`MobileNavItem`** that wraps its `Link` in `SheetClose asChild`, so a tap closes the sheet AND navigates in one gesture. Disabled modules (e.g. Accounting) render as inert `text-muted-foreground/50` text. Rows are `min-h-11` (44px touch targets).
- `MobileNavItem` is hoisted to module level (never defined during render) to satisfy the `react-hooks/static-components` lint rule.

## Breadcrumb Registry (`BREADCRUMB_REGISTRY` → `getBreadcrumb()`)
The old long if-chain was refactored into an **ordered registry array**. Each entry has a `test(pathname, params)` predicate — `params` is the current query string (a structural `QueryParams = { get(key): string | null }`, satisfied by both `URLSearchParams` and Next's `ReadonlyURLSearchParams`), consulted only by routes that host several URL-driven views — **no entry does so today** (the `/?view=schedule` one was retired 2026-08-28). Entries are built via the `exact()` / `prefix()` helpers. The FIRST match wins, so **more-specific routes MUST come before their parent catch-alls** (e.g. the bare `/` deliberately has NO entry; `/inventory/blocking`, `/inventory/rc-movement`, and `/inventory/flecon-bags` precede the `/inventory` catch-all; `/price-demos/demo1..4` precede the `/price-demos` index; `exact('/cenapro/qc/breakdown')` precedes `exact('/cenapro/qc')` — the breakdown is NESTED under the ledger, so a `prefix('/cenapro/qc')` would swallow it; `exact('/cenapro/liquidation/subgroups')` and `exact('/cenapro/liquidation/banks')` precede `prefix('/cenapro/liquidation')` for exactly the same reason; `/cenapro/production` precedes `/cenapro`). `getBreadcrumb(pathname, params)` just `.find()`s the first matching entry.

> **The five CCC Analysis draft entries were REMOVED on 2026-08-01** when the two chosen designs shipped as `/cenapro/qc` (QC Ledger, entry) and `/cenapro/qc/breakdown` (QC Breakdown, reading). Unlike the drafts — which were breadcrumb-only, deliberately absent from the dropdown because they were evaluation surfaces — **BOTH QC routes are listed in `CENAPRO_MODULES`**. Listing the reading page as well as the entry page is intentional: a screen reachable only through another screen is a screen nobody finds (the same reason Prod Schedule and Setup Library used to be listed under ICTC, before both were retired on 2026-08-28).

`Navbar` therefore calls `useSearchParams()` alongside `usePathname()`. It is safe without an extra `Suspense` boundary because the navbar is mounted via `dynamic(..., { ssr: false })` in `app-shell.tsx` — it never participates in prerender.

| Match | Back Label | Page Title | Description |
|------|-----------|------------|-------------|
| `prefix('/edit/')` | Back to Inventory | Edit Discussion | — |
| `prefix('/inventory/blocking')` | Back to Inventory | Blocking | Warehouse grid — block occupancy & balances |
| `prefix('/inventory/rc-movement')` | Back to Inventory | Movement | Daily feed matrix — campaign-scoped day × block |
| `prefix('/inventory/flecon-bags')` | Back to Inventory | Bag Inventory | FLECON bag stock — balances & movement ledger |
| `prefix('/inventory')` | Back to Dashboard | Inventory | Raw charcoal deliveries, usage & tracking |
| `prefix('/production')` | Back to Dashboard | Production | Daily runs, downtime, waste, electricity & trucks |
| `prefix('/analytics')` | Back to Dashboard | Analytics | ICTC month-on-month KPIs — price, volume, stock & runway |
| `prefix('/summaries')` | Back to Dashboard | Summaries | Delivery price & volume analysis — by period or supplier |
| `prefix('/price-demos/demo1')` | Back to Demos | Terminal | Dual-axis volume × price command view (concept 1 of 4) |
| `prefix('/price-demos/demo2')` | Back to Demos | Ledger | Sortable supplier league table with sparklines (concept 2 of 4) |
| `prefix('/price-demos/demo3')` | Back to Demos | Heatmap | Month × supplier ₱/kg & volume matrix (concept 3 of 4) |
| `prefix('/price-demos/demo4')` | Back to Demos | Analyst Brief | Executive monthly review dashboard (concept 4 of 4) |
| `prefix('/price-demos')` | Back to Dashboard | Price & Volume Demos | Four design concepts for delivery price & volume analysis |
| `exact('/cenapro/liquidation/subgroups')` | Back to Liquidation | Supplier Subgroups | Which trader may be paid for which — one level, stated by hand |
| `exact('/cenapro/liquidation/banks')` | Back to Liquidation | Banks & Accounts | CI's own banks and the accounts cheques are drawn on — retire, never delete |
| `prefix('/cenapro/liquidation')` | Back to Cenapro | Liquidation | What CI owes each raw-charcoal trader — minus means we owe them |
| `exact('/cenapro/qc/breakdown')` | Back to QC Ledger | QC Breakdown | Weighted monthly + daily lab analytics — ex-DVO, read-only |
| `exact('/cenapro/qc')` | Back to Cenapro | QC Ledger | Log CCC partner lab results (BD · ASH · GRIT · MC) onto the receipts |
| `prefix('/cenapro/production')` | Back to Cenapro | Cenapro · Production | CI production events — bagging & partner draws |
| `prefix('/cenapro/inventory')` | Back to Cenapro | Cenapro · Flec Inventory | Per-warehouse flec balances & movement ledger |
| `prefix('/cenapro')` | Back to Dashboard | Cenapro | CI / Cebu production & flec inventory — second tenant |
| `exact('/notifications')` | Back to Dashboard | Notifications | — |
| `exact('/settings')` | Back to Dashboard | Settings | Your profile and sign-out |
| `exact('/admin')` | Back to Dashboard | Admin Panel | Manage users and invitations |
| `exact('/review-queue')` | Back to Dashboard | Review Queue | Pre-extracted rows from daily reports awaiting approval |

> **Removed 2026-08-28 (production schedule retired):** the `/` + `?view=schedule` entry, `exact('/production/schedule')`, `exact('/production/setups')`, and the **Prod Schedule** + **Setup Library** rows in `ICTC_MODULES`. All three routes are gone; the source is at `_archived/prod-schedule-v1/`. The `app/(app)/production/(tabs)/` ROUTE GROUP that let those two routes escape the Daily · Electricity · Trucks shell (BUG-003) **stays** — it currently guards nothing, but the next non-tab route under `/production` needs exactly that escape, and re-deriving it is how BUG-003 happened.

> **Removed (stale):** the 9 `/draft1`–`/draft6` + `/rcindraft1`–`/rcindraft3` entries (their route dirs no longer exist) were deleted from the registry.

**Adding a page:** insert a `BreadcrumbEntry` into `BREADCRUMB_REGISTRY` at the right position (specific before catch-all) with `test`, `backLabel`, `backHref`, `pageTitle`, and optional `pageDescription`.

## Module Dropdown (Factory icon)
A nested information architecture grouped by tenant. The dropdown is built from three constants:

| Constant | Section | Items |
|----------|---------|-------|
| `ICTC_INVENTORY` | ICTC · Davao → **Inventory** sub-group (indented) | Blocking (`/inventory/blocking`) · Deliveries (`/inventory?tab=deliveries`) · Usage (`/inventory?tab=usage`) · Movement (`/inventory/rc-movement`) · Bag Inventory (`/inventory/flecon-bags`) |
| `ICTC_MODULES` | ICTC · Davao (siblings below Inventory) | **Analytics (`/analytics`)** · Production (`/production`) · Summaries (`/summaries`) · Shipments (`/shipments`) · Accounting (disabled) |
| `CENAPRO_MODULES` | Cenapro · Cebu | Production (`/cenapro/production`) · RC Deliveries (`/cenapro/deliveries`) · Liquidation (`/cenapro/liquidation`) · Flec Inventory (`/cenapro/inventory`) · QC Ledger (`/cenapro/qc`) · QC Breakdown (`/cenapro/qc/breakdown`) |

Render structure inside `DropdownMenuContent`:
```
ICTC · Davao                 ← uppercase tenant label
  Inventory                  ← mini sub-group label (pl-2)
    Blocking                 ← indented children (pl-5)
    Deliveries
    Usage
    Movement
    Bag Inventory
  Production                 ← sibling module
  Summaries
  Accounting (disabled)
─────────────
Cenapro · Cebu               ← uppercase tenant label
  Production
  Flec Inventory
  QC Ledger
  QC Breakdown
─────────────  (privileged only)
  Sync Review
  Review Queue
  Admin Panel
```

**Notes:**
- Child labels are **plain** (Blocking / Deliveries / Usage / Movement), NOT "RC " prefixed.
- **Deliveries / Usage** are NOT separate routes — they deep-link into the `/inventory` logs page's tab via the `?tab=` URL param (the tab state lives in the URL; see [inventory/CONTEXT.md](../app/(app)/inventory/CONTEXT.md)).
- **Blocking / Movement** ARE standalone routes (`/inventory/blocking`, `/inventory/rc-movement`).
- The nesting is done inline (mini `DropdownMenuLabel` + indented `DropdownMenuItem`s via `pl-5`) for scannability — everything is visible at once, no flyout.
- Sync Review + Review Queue + Admin Panel appear only for `PRIVILEGED_ROLES` (Owner/Admin/Dev) under a separator.

## Role-Based Visibility
- **Dev Role Switcher (Shield icon):** visible only if `dbRole` ∈ Owner/Admin/Dev. Dropdown lists all 5 roles + the "logged in as" reset.
- **Sync Review / Review Queue / Admin Panel menu items:** visible only if current `role` ∈ Owner/Admin/Dev.

## Styling
- Always dark: `bg-zinc-800 dark:bg-zinc-700` (one shade lighter in dark mode for contrast against the `zinc-950` body)
- Text: `text-zinc-400` (links) / `text-zinc-200` (titles) / `text-zinc-100` (logo)
- `z-10` with custom shadow `shadow-[0_2px_8px_rgba(0,0,0,0.3)]`
- Theme toggle: `mounted` state guard prevents hydration mismatch (equivalent to `ssr: false`)

## Safe Areas (edge-to-edge / iOS PWA)
The app runs `viewport-fit=cover` + `statusBarStyle: 'black-translucent'` (`app/layout.tsx`), so the
webview spans the whole display and the iOS status bar is a transparent overlay **on top of this bar**.
'cover' is mandatory — without it iOS pillarboxes the app in landscape. The contract: the bar's dark
background bleeds edge-to-edge, its CONTENT stays inside the safe area.

- **Height:** `h-[calc(3rem+env(safe-area-inset-top))]` + `.safe-t` — the top inset is padding, so the
  usable content row is still exactly `h-12`. Do NOT restore a bare `h-12`.
- **Horizontal:** `.safe-x [--safe-x-min:1rem] sm:[--safe-x-min:2rem]` replaces the old `px-4 sm:px-8`.
  The floor var preserves those paddings and `max()`es them against the landscape notch inset.
- `.safe-*` classes are defined **unlayered** in `globals.css` (they beat Tailwind's utility layer, so a
  `p-0` can't wipe them). Override the floor var, never with a `px-*`/`pt-*` utility.
- The **mobile nav Sheet** inherits its own insets from `SheetContent` (`side="left"` → `.safe-t .safe-l
  .safe-b`) — never re-pad it here.
- Every `env(safe-area-inset-*)` resolves to 0 on desktop, so all of the above are desktop no-ops.

## Dependencies
- `@/components/notification-bell` — `NotificationBell`
- `@/components/providers/auth-context` — `useAuth()`, `UserRole`
- `next-themes` — `useTheme()` for dark mode toggle
- `next/navigation` — `usePathname()` + `useSearchParams()` (breadcrumb resolution), `useRouter()` (sign-out redirect)
- shadcn: Avatar, Button, DropdownMenu (incl. Label/Separator/Item), Tooltip, **Sheet** (incl. `SheetClose`/`SheetTrigger`/`SheetContent`/`SheetHeader`/`SheetTitle`/`SheetDescription` — mobile nav)
- `lucide-react` — `Menu` icon (mobile hamburger)

## See Also
- [Auth Provider](providers/AUTH.md) — role/permission context consumed by navbar
- [Notifications](NOTIFICATIONS.md) — `NotificationBell` rendered in navbar
- [Inventory](../app/(app)/inventory/CONTEXT.md) — the logs shell + standalone Blocking/Movement routes the dropdown links to
