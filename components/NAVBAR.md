# Navbar Component

## Purpose
Persistent navigation bar (302 lines, `components/navbar.tsx`). Owns ALL page titles/descriptions via `getBreadcrumb()`. Dark-themed in both modes.

## Layout (3-column)
- **Left:** Breadcrumb — `<- Back to {parent} / Page Title` + muted description
- **Center:** "Blackwood" logo (always visible, links to `/`)
- **Right:** Modules dropdown, dev role switcher, dark mode toggle, notification bell, profile avatar

## Registered Breadcrumbs (`getBreadcrumb()`)
| Path | Back Label | Page Title | Description |
|------|-----------|------------|-------------|
| `/inventory/rc-in/edit/*` | Back to Master Log | Edit Remarks | — |
| `/inventory/rc-in` | Back to Inventory | Master Log | Recent delivery history |
| `/inventory/rc-out` | Back to Inventory | Inventory Usage | Raw charcoal usage & depletion |
| `/inventory/blocking` | Back to Inventory | Blocking | Block location inventory |
| `/inventory` | Back to Dashboard | Inventory | Raw charcoal inventory management |
| `/notifications` | Back to Dashboard | Notifications | — |
| `/settings` | Back to Dashboard | Settings | Manage user roles and permissions |
| `/admin` | Back to Dashboard | Admin Panel | Manage users and invitations |

Dashboard (`/`) returns `null` — no breadcrumb shown.

## Module Dropdown (`MODULES` constant)
```
Inventory (/inventory)
  -> Deliveries (/inventory/rc-in)
  -> Usage (/inventory/rc-out)
  -> Blocking (/inventory/blocking)
Production (disabled)
Accounting (disabled)
---
Admin Panel (/admin) — only if PRIVILEGED_ROLES
```

## Role-Based Visibility
- **Dev Role Switcher (Shield icon):** Visible only if `dbRole` is Owner/Admin/Dev. Dropdown lists all 5 roles.
- **Admin Panel menu item:** Visible only if current `role` is Owner/Admin/Dev.

## Styling
- Always dark: `bg-zinc-800 dark:bg-zinc-700` (shifts one shade lighter in dark mode for contrast against `zinc-950` body)
- Text: `text-zinc-400` (links) / `text-zinc-200` (titles) / `text-zinc-100` (logo)
- `z-10` with custom shadow `shadow-[0_2px_8px_rgba(0,0,0,0.3)]`
- Theme toggle: `mounted` state guard prevents hydration mismatch (equivalent to `ssr: false`)

## Dependencies
- `@/components/notification-bell` — `NotificationBell` component
- `@/components/providers/auth-context` — `useAuth()`, `UserRole`
- `next-themes` — `useTheme()` for dark mode toggle
- shadcn: Avatar, Button, DropdownMenu, Tooltip

## See Also
- [Auth Provider](providers/AUTH.md) — role/permission context consumed by navbar
- [Notifications](NOTIFICATIONS.md) — `NotificationBell` rendered in navbar
- [RC IN](../app/(app)/inventory/rc-in/CONTEXT.md) — example of breadcrumb consumer
