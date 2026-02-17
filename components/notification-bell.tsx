'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowUpDown,
  Bell,
  CheckCircle2,
  MessageSquare,
  PackagePlus,
  Pencil,
  Reply,
  Trash2,
  XCircle,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  type Notification,
  type NotificationType,
} from '@/app/(app)/notifications/actions';
import { useAuth } from '@/components/providers/auth-context';
import { useStatusBar } from '@/components/providers/status-bar-context';
import { createClient } from '@/lib/supabase/client';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';

const ICON_MAP: Record<NotificationType, { icon: React.ElementType; color: string }> = {
  resolve_request: { icon: ArrowUpDown, color: 'text-amber-500' },
  resolve_approved: { icon: CheckCircle2, color: 'text-green-500' },
  resolve_denied: { icon: XCircle, color: 'text-red-500' },
  delivery_created: { icon: PackagePlus, color: 'text-blue-500' },
  delivery_edited: { icon: Pencil, color: 'text-orange-500' },
  delivery_deleted: { icon: Trash2, color: 'text-red-500' },
  remarks_added: { icon: MessageSquare, color: 'text-purple-500' },
  audit_comment_reply: { icon: Reply, color: 'text-blue-400' },
};

function getNavigationTarget(notification: Notification): string {
  const meta = notification.metadata as Record<string, string> | null;
  switch (notification.type) {
    case 'resolve_request':
    case 'resolve_approved':
    case 'resolve_denied':
    case 'delivery_edited':
    case 'audit_comment_reply':
      return meta?.audit_log_id ? `/edit/${meta.audit_log_id}` : '/inventory';
    case 'delivery_created':
      return meta?.date ? `/inventory?date=${meta.date}` : '/inventory';
    case 'remarks_added':
      return meta?.audit_log_id ? `/edit/${meta.audit_log_id}` : '/inventory';
    case 'delivery_deleted':
      return '/inventory';
    default:
      return '/';
  }
}

function NotificationItem({
  notification,
  onRead,
}: {
  notification: Notification;
  onRead: (id: string) => void;
}) {
  const router = useRouter();
  const { icon: Icon, color } = ICON_MAP[notification.type] ?? {
    icon: Bell,
    color: 'text-muted-foreground',
  };

  const handleClick = async () => {
    if (!notification.read) {
      onRead(notification.id);
      markAsRead(notification.id);
    }
    router.push(getNavigationTarget(notification));
  };

  const timeAgo = notification.created_at
    ? formatDistanceToNow(new Date(notification.created_at), { addSuffix: false })
      .replace('about ', '')
      .replace('less than a minute', '<1m')
      .replace(' minutes', 'm')
      .replace(' minute', 'm')
      .replace(' hours', 'h')
      .replace(' hour', 'h')
      .replace(' days', 'd')
      .replace(' day', 'd')
    : '';

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex items-start gap-3 w-full px-3 py-2.5 text-left hover:bg-accent rounded-md transition-colors"
    >
      <div className={`mt-0.5 shrink-0 ${color}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm leading-tight ${!notification.read ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
          {notification.title}
        </p>
        {notification.body && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {notification.body}
          </p>
        )}
        <p className="text-[10px] text-muted-foreground mt-1">{timeAgo} ago</p>
      </div>
      {!notification.read && (
        <div className="mt-2 shrink-0">
          <span className="block h-2 w-2 rounded-full bg-blue-500" />
        </div>
      )}
    </button>
  );
}

// Polling constants
const POLL_BASE_INTERVAL = 30_000;  // 30s initial
const POLL_MAX_INTERVAL = 120_000;  // 2min cap
const POLL_BACKOFF_FACTOR = 1.5;

export function NotificationBell() {
  const { user } = useAuth();
  const { setConnectionStatus } = useStatusBar();
  const [notifications, setNotifications] = React.useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [animateBadge, setAnimateBadge] = React.useState(false);
  const openRef = React.useRef(open);

  // Sync ref with state
  React.useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Keep track of IDs we've marked as read locally (optimistic updates)
  // so the Realtime UPDATE callback doesn't double-decrement the count.
  const locallyReadRef = React.useRef<Set<string>>(new Set());

  // Track connection status to avoid redundant polling if Realtime is working
  const isRealtimeConnectedRef = React.useRef(false);
  const isPollingFallbackRef = React.useRef(false);
  const [realtimeStatus, setRealtimeStatus] = React.useState<string>('CONNECTING');

  // Subscribe to realtime notifications
  React.useEffect(() => {
    if (!user) {
      return;
    }

    let mounted = true;

    // Seed initial unread count via server action (benefits from server proximity)
    getUnreadCount().then((count) => {
      if (mounted) setUnreadCount(count);
    });

    // Use the singleton client to share auth token refresh and avoid duplicate auth calls
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    /** Direct client-side count query — 1 PostgREST call instead of 3 hops via server action */
    const userId = user.id;
    async function pollUnreadCount(): Promise<number> {
      const { count } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('read', false)
        .eq('archived', false);
      return count ?? 0;
    }

    // Adaptive polling state
    let pollTimeout: ReturnType<typeof setTimeout> | null = null;
    let currentInterval = POLL_BASE_INTERVAL;

    function clearPollTimeout() {
      if (pollTimeout !== null) {
        clearTimeout(pollTimeout);
        pollTimeout = null;
      }
    }

    function schedulePoll() {
      clearPollTimeout();
      // Skip polling when tab is hidden — visibility handler will resume
      if (document.visibilityState === 'hidden') return;
      // Don't poll if Realtime is connected
      if (isRealtimeConnectedRef.current) return;

      pollTimeout = setTimeout(async () => {
        if (!mounted || isRealtimeConnectedRef.current) return;
        const count = await pollUnreadCount();
        if (mounted) setUnreadCount(count);
        // Exponential backoff for next poll
        currentInterval = Math.min(currentInterval * POLL_BACKOFF_FACTOR, POLL_MAX_INTERVAL);
        schedulePoll();
      }, currentInterval);
    }

    function startPolling() {
      currentInterval = POLL_BASE_INTERVAL;
      // Immediate first poll — don't wait 30s after Realtime fails
      pollUnreadCount().then((count) => {
        if (mounted) setUnreadCount(count);
      });
      schedulePoll();
    }

    const connect = async () => {
      if (channel) {
        await supabase.removeChannel(channel);
        channel = null;
      }
      setRealtimeStatus('CONNECTING');

      // Ensure the client has loaded the auth token from localStorage before subscribing.
      // getSession() on the browser client is a local read, not a network call.
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;
      if (!session?.access_token) return;

      channel = supabase
        .channel('notifications-realtime')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${user.id}`,
          },
          (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
            if (!mounted) return;
            const row = payload.new as Record<string, unknown>;

            // Skip self-notifications (actions you performed yourself)
            if (row.source_user_id === user.id) {
              return;
            }

            setUnreadCount((prev) => prev + 1);
            setAnimateBadge(true);
            setTimeout(() => setAnimateBadge(false), 600);

            // If popover is open, prepend the new notification
            if (openRef.current) {
              setNotifications((prev) => [row as unknown as Notification, ...prev]);
            }
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${user.id}`,
          },
          (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
            if (!mounted) return;
            const oldRow = payload.old as Record<string, unknown>;
            const newRow = payload.new as Record<string, unknown>;
            const id = newRow.id as string;

            // Skip if this client already handled the read optimistically
            if (locallyReadRef.current.has(id)) {
              locallyReadRef.current.delete(id);
              return;
            }

            // Only decrement if read changed from false→true (external update)
            if (oldRow.read === false && newRow.read === true) {
              setUnreadCount((prev) => Math.max(0, prev - 1));
            }
          }
        )
        .subscribe((status: string, err: Error | undefined) => {
          console.log(`[NotificationBell] Realtime connection status: ${status}`);

          if (status === 'SUBSCRIBED') {
            isRealtimeConnectedRef.current = true;
            isPollingFallbackRef.current = false;
            // Stop polling — Realtime is live
            clearPollTimeout();
            currentInterval = POLL_BASE_INTERVAL;
            // Sync once: Realtime may have missed events during disconnection
            pollUnreadCount().then((count) => {
              if (mounted) setUnreadCount(count);
            });
            setRealtimeStatus('SUBSCRIBED');
          } else if (status === 'CHANNEL_ERROR') {
            // WSS is blocked — immediately fall back to polling
            isRealtimeConnectedRef.current = false;
            isPollingFallbackRef.current = true;
            // console.warn('[NotificationBell] Realtime connection blocked. Falling back to polling.');
            startPolling();
            setRealtimeStatus('CHANNEL_ERROR');
          } else if (status === 'TIMED_OUT') {
            isRealtimeConnectedRef.current = false;
            // If already polling, maintain current backoff — don't reset
            if (pollTimeout === null) {
              isPollingFallbackRef.current = true;
              // console.warn('[NotificationBell] Realtime timed out. Starting polling.');
              startPolling();
            }
            setRealtimeStatus('TIMED_OUT');
          } else {
            isRealtimeConnectedRef.current = false;
            // Don't let Realtime retry statuses (JOINING, etc.) override
            // the UI when we're already in polling fallback mode
            if (!isPollingFallbackRef.current) {
              setRealtimeStatus(status);
            }
          }

          if (err) {
            console.error('[NotificationBell] Realtime connection error details:', err);
          }
        });
    };
    connect();

    // Visibility change: poll immediately when tab becomes visible, reset backoff
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (!isRealtimeConnectedRef.current) {
          // Immediate poll + reset backoff
          pollUnreadCount().then((count) => {
            if (mounted) setUnreadCount(count);
          });
          currentInterval = POLL_BASE_INTERVAL;
          schedulePoll();
          // Also try to reconnect Realtime
          connect();
        }
      } else {
        // Tab hidden — stop polling to save resources
        clearPollTimeout();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mounted = false;
      clearPollTimeout();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (channel) supabase.removeChannel(channel);
    };
  }, [user]);

  // Fetch notifications when popover opens
  const handleOpenChange = async (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      setLoading(true);
      const { notifications: data } = await getNotifications(undefined, 20);
      setNotifications(data);
      setLoading(false);
    }
  };

  const handleMarkAllRead = async () => {
    // Register all unread IDs so the Realtime UPDATE callback skips them
    notifications.filter((n) => !n.read).forEach((n) => locallyReadRef.current.add(n.id));
    setUnreadCount(0);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    await markAllAsRead();
  };

  const handleRead = (id: string) => {
    // Register so the Realtime UPDATE callback skips this ID
    locallyReadRef.current.add(id);
    setUnreadCount((prev) => Math.max(0, prev - 1));
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  };

  const badgeText = unreadCount > 9 ? '9+' : String(unreadCount);

  // Push connection status to shared context
  React.useEffect(() => {
    setConnectionStatus(realtimeStatus);
  }, [realtimeStatus, setConnectionStatus]);

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="relative text-muted-foreground hover:text-foreground"
              >
                <Bell className="h-5 w-5" />
                {unreadCount > 0 && (
                  <span
                    className={`absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground ${animateBadge ? 'animate-badge-pop' : ''
                      } transition-transform`}
                  >
                    {badgeText}
                  </span>
                )}
                <span className="sr-only">Notifications</span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Notifications</TooltipContent>
        </Tooltip>

        <PopoverContent align="end" className="w-[380px] p-0">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <h3 className="text-sm font-semibold">Notifications</h3>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-[400px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                <Bell className="h-8 w-8 mb-2 opacity-40" />
                <p className="text-sm">You&apos;re all caught up</p>
              </div>
            ) : (
              <div className="py-1">
                {notifications.map((n) => (
                  <NotificationItem
                    key={n.id}
                    notification={n}
                    onRead={handleRead}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t px-4 py-2.5">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              View all notifications
            </Link>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
