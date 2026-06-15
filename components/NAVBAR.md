# Navbar Component

## Purpose
Persistent navigation bar (`components/navbar.tsx`). Owns ALL page titles/descriptions via the `BREADCRUMB_REGISTRY` + `getBreadcrumb()`. Dark-themed in both modes. Pages MUST NOT render their own title/description headers — register them here instead.

> **Platform Chrome:** The navbar is platform-level chrome — it must remain domain-neutral. Module links and breadcrumbs are tenant-registered navigation entries, not hardcoded charcoal concepts. Any future tenant module is registered in the registry + the `MODULES`-family constants the same way.

## Layout (3-column)
- **Left:** Breadcrumb — `← {backLabel} / {pageTitle}` + muted `pageDescription`
- **Center:** "Blackwood" logo (always visible, links to `/`)
- **Right:** Modules dropdown (Factory icon), dev role switcher (Shield, privileged only), dark-mode toggle, notification bell, profile avatar

The dashboard (`/`) returns `null` from `getBreadcrumb()` — no breadcrumb shown.

## Breadcrumb Registry (`BREADCRUMB_REGISTRY` → `getBreadcrumb()`)
The old long if-chain was refactored into an **ordered registry array**. Each entry has a `test(pathname)` predicate (built via the `exact()` / `prefix()` helpers); the FIRST match wins, so **more-specific routes MUST come before their parent catch-alls** (e.g. `/inventory/blocking` and `/inventory/rc-movement` precede the `/inventory` catch-all; `/cenapro/production` precedes `/cenapro`). `getBreadcrumb()` just `.find()`s the first matching entry.

| Match | Back Label | Page Title | Description |
|------|-----------|------------|-------------|
| `prefix('/edit/')` | Back to Inventory | Edit Discussion | — |
| `prefix('/inventory/blocking')` | Back to Inventory | Blocking | Warehouse grid — block occupancy & balances |
| `prefix('/inventory/rc-movement')` | Back to Inventory | Movement | Daily feed matrix — campaign-scoped day × block |
| `prefix('/inventory')` | Back to Dashboard | Inventory | Raw charcoal deliveries, usage & tracking |
| `prefix('/production')` | Back to Dashboard | Production | Daily runs, downtime, waste, electricity & trucks |
| `prefix('/cenapro/production')` | Back to Cenapro | Cenapro · Production | CI production events — bagging & partner draws |
| `prefix('/cenapro/inventory')` | Back to Cenapro | Cenapro · Flec Inventory | Per-warehouse flec balances & movement ledger |
| `prefix('/cenapro')` | Back to Dashboard | Cenapro | CI / Cebu production & flec inventory — second tenant |
| `exact('/notifications')` | Back to Dashboard | Notifications | — |
| `exact('/settings')` | Back to Dashboard | Settings | Manage user roles and permissions |
| `exact('/admin')` | Back to Dashboard | Admin Panel | Manage users and invitations |
| `exact('/review-queue')` | Back to Dashboard | Review Queue | Pre-extracted rows from daily reports awaiting approval |

> **Removed (stale):** the 9 `/draft1`–`/draft6` + `/rcindraft1`–`/rcindraft3` entries (their route dirs no longer exist) were deleted from the registry.

**Adding a page:** insert a `BreadcrumbEntry` into `BREADCRUMB_REGISTRY` at the right position (specific before catch-all) with `test`, `backLabel`, `backHref`, `pageTitle`, and optional `pageDescription`.

## Module Dropdown (Factory icon)
A nested information architecture grouped by tenant. The dropdown is built from three constants:

| Constant | Section | Items |
|----------|---------|-------|
| `ICTC_INVENTORY` | ICTC · Davao → **Inventory** sub-group (indented) | Blocking (`/inventory/blocking`) · Deliveries (`/inventory?tab=deliveries`) · Usage (`/inventory?tab=usage`) · Movement (`/inventory/rc-movement`) |
| `ICTC_MODULES` | ICTC · Davao (siblings below Inventory) | Production (`/production`) · Accounting (disabled) |
| `CENAPRO_MODULES` | Cenapro · Cebu | Production (`/cenapro/production`) · Flec Inventory (`/cenapro/inventory`) |

Render structure inside `DropdownMenuContent`:
```
ICTC · Davao                 ← uppercase tenant label
  Inventory                  ← mini sub-group label (pl-2)
    Blocking                 ← indented children (pl-5)
    Deliveries
    Usage
    Movement
  Production                 ← sibling module
  Accounting (disabled)
─────────────
Cenapro · Cebu               ← uppercase tenant label
  Production
  Flec Inventory
─────────────  (privileged only)
  Review Queue
  Admin Panel
```

**Notes:**
- Child labels are **plain** (Blocking / Deliveries / Usage / Movement), NOT "RC " prefixed.
- **Deliveries / Usage** are NOT separate routes — they deep-link into the `/inventory` logs page's tab via the `?tab=` URL param (the tab state lives in the URL; see [inventory/CONTEXT.md](../app/(app)/inventory/CONTEXT.md)).
- **Blocking / Movement** ARE standalone routes (`/inventory/blocking`, `/inventory/rc-movement`).
- The nesting is done inline (mini `DropdownMenuLabel` + indented `DropdownMenuItem`s via `pl-5`) for scannability — everything is visible at once, no flyout.
- Review Queue + Admin Panel appear only for `PRIVILEGED_ROLES` (Owner/Admin/Dev) under a separator.

## Role-Based Visibility
- **Dev Role Switcher (Shield icon):** visible only if `dbRole` ∈ Owner/Admin/Dev. Dropdown lists all 5 roles + the "logged in as" reset.
- **Review Queue / Admin Panel menu items:** visible only if current `role` ∈ Owner/Admin/Dev.

## Styling
- Always dark: `bg-zinc-800 dark:bg-zinc-700` (one shade lighter in dark mode for contrast against the `zinc-950` body)
- Text: `text-zinc-400` (links) / `text-zinc-200` (titles) / `text-zinc-100` (logo)
- `z-10` with custom shadow `shadow-[0_2px_8px_rgba(0,0,0,0.3)]`
- Theme toggle: `mounted` state guard prevents hydration mismatch (equivalent to `ssr: false`)

## Dependencies
- `@/components/notification-bell` — `NotificationBell`
- `@/components/providers/auth-context` — `useAuth()`, `UserRole`
- `next-themes` — `useTheme()` for dark mode toggle
- `next/navigation` — `usePathname()` (breadcrumb), `useRouter()` (sign-out redirect)
- shadcn: Avatar, Button, DropdownMenu (incl. Label/Separator/Item), Tooltip

## See Also
- [Auth Provider](providers/AUTH.md) — role/permission context consumed by navbar
- [Notifications](NOTIFICATIONS.md) — `NotificationBell` rendered in navbar
- [Inventory](../app/(app)/inventory/CONTEXT.md) — the logs shell + standalone Blocking/Movement routes the dropdown links to
