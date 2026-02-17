# Notifications Component

## Purpose
Real-time notification bell (500 lines, `components/notification-bell.tsx`) with adaptive polling fallback. Renders in the navbar. Server actions live in `app/(app)/notifications/actions.ts`.

## Files
| File | Lines | Role |
|------|-------|------|
| `components/notification-bell.tsx` | 500 | Client component — bell icon, popover list, realtime subscription |
| `app/(app)/notifications/actions.ts` | ~80 | Server actions: `getNotifications`, `getUnreadCount`, `markAsRead`, `markAllAsRead` |
| `app/(app)/notifications/page.tsx` | — | Full notifications page (if exists) |

## Data
- **Table:** `notifications` — `id`, `user_id`, `type`, `title`, `body`, `source_user_id`, `metadata` (JSONB), `read`, `read_at`, `archived`, `created_at`
- **Table:** `notification_subscriptions` — `id`, `user_id`, `audit_log_id`, `created_at`
- **Enum (`notification_type`):** `resolve_request`, `resolve_approved`, `resolve_denied`, `delivery_created`, `delivery_edited`, `delivery_deleted`, `remarks_added`, `audit_comment_reply`
- **RPC:** `_insert_notification()` — server-side function to create notifications

## Notification Type -> URL Mapping
| Type | Target URL |
|------|-----------|
| `resolve_request/approved/denied` | `/edit/{audit_log_id}` |
| `delivery_created` | `/inventory/rc-in?date={date}` |
| `delivery_edited` | `/edit/{audit_log_id}` |
| `delivery_deleted` | `/inventory/rc-in` |
| `remarks_added` | `/edit/{audit_log_id}` |
| `audit_comment_reply` | `/edit/{audit_log_id}` |

## Key Behaviors

### Realtime -> Polling Fallback Chain
1. **Connect:** Subscribe to `postgres_changes` on `notifications` table (INSERT + UPDATE, filtered by `user_id`)
2. **SUBSCRIBED:** Stop polling, sync count once, set status green
3. **CHANNEL_ERROR / TIMED_OUT:** Mark realtime disconnected, start adaptive polling
4. **Polling:** Direct PostgREST count query (1 hop vs 3 for server action). Exponential backoff: 30s base -> 1.5x -> 120s max

### Visibility Optimization
- **Tab hidden:** Stop polling, save resources
- **Tab visible:** Immediate poll + reset backoff + attempt realtime reconnect

### Optimistic Read Tracking
- `locallyReadRef` (Set) tracks IDs marked read locally
- When realtime UPDATE arrives for a locally-read ID, skip decrement (prevents double-count)
- ID removed from set after skip

### Badge Animation
- Uses `animate-badge-pop` (CSS keyframe in `globals.css`) — a spring-like scale 0 → 1.15 → 1 over 250ms
- Triggered via `animateBadge` state on realtime INSERT, auto-clears after 600ms

### Self-Notification Filtering
- INSERT callback checks `source_user_id === user.id` — skips own actions

### Status Indicator
- Connection status is pushed to `StatusBarProvider` context via `useStatusBar().setConnectionStatus()` and displayed in the unified `FloatingStatusBar` (bottom-right). The fixed bottom-left indicator was removed from this component.

## Dependencies
- `@/app/(app)/notifications/actions` — server actions for fetch/read
- `@/lib/supabase/client` — singleton browser client for realtime channel
- `@/components/providers/auth-context` — `useAuth()` for user ID
- `@/components/providers/status-bar-context` — `useStatusBar()` for pushing connection status to FloatingStatusBar
- `@supabase/supabase-js` — `RealtimePostgresChangesPayload` type
- `date-fns`, `lucide-react`, shadcn: Popover, Tooltip, Button

## See Also
- [Navbar](NAVBAR.md) — `NotificationBell` rendered in navbar right section
- [RC IN](../app/(app)/inventory/rc-in/CONTEXT.md) — audit actions trigger notifications
- [Auth Provider](providers/AUTH.md) — provides user context for subscription filter
