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
      return meta?.audit_log_id ? `/rc-in/edit/${meta.audit_log_id}` : '/rc-in';
    case 'delivery_created':
      return meta?.date ? `/rc-in?date=${meta.date}` : '/rc-in';
    case 'remarks_added':
      return meta?.audit_log_id ? `/rc-in/edit/${meta.audit_log_id}` : '/rc-in';
    case 'delivery_deleted':
      return '/rc-in';
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

export function NotificationBell() {
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [notifications, setNotifications] = React.useState<Notification[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [animateBadge, setAnimateBadge] = React.useState(false);

  // Poll unread count every 30s
  React.useEffect(() => {
    let mounted = true;

    const fetchCount = async () => {
      const count = await getUnreadCount();
      if (!mounted) return;
      setUnreadCount((prev) => {
        if (count > prev && prev !== 0) {
          setAnimateBadge(true);
          setTimeout(() => setAnimateBadge(false), 600);
        }
        return count;
      });
    };

    fetchCount();
    const interval = setInterval(fetchCount, 10000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

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
    await markAllAsRead();
    setUnreadCount(0);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const handleRead = (id: string) => {
    setUnreadCount((prev) => Math.max(0, prev - 1));
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  };

  const badgeText = unreadCount > 9 ? '9+' : String(unreadCount);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-600 relative"
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span
                  className={`absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white ${
                    animateBadge ? 'animate-pulse scale-110' : ''
                  } transition-transform`}
                >
                  {badgeText}
                </span>
              )}
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
  );
}
