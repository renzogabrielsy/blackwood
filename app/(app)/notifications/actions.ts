'use server';

import { createClient } from '@/lib/supabase/server';

export type NotificationType =
  | 'resolve_request'
  | 'resolve_approved'
  | 'resolve_denied'
  | 'delivery_created'
  | 'delivery_edited'
  | 'delivery_deleted'
  | 'remarks_added'
  | 'audit_comment_reply';

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  metadata: Record<string, string> | null;
  read: boolean;
  read_at: string | null;
  created_at: string;
  source_user_id: string | null;
  archived: boolean;
}

/** Fetch paginated notifications for the current user */
export async function getNotifications(cursor?: string, limit = 20): Promise<{
  notifications: Notification[];
  nextCursor: string | null;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { notifications: [], nextCursor: null };

  let query = supabase
    .from('notifications')
    .select('*')
    .eq('user_id', user.id)
    .eq('archived', false)
    .order('created_at', { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.lt('created_at', cursor);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const notifications = (data ?? []) as unknown as Notification[];
  const hasMore = notifications.length > limit;
  if (hasMore) notifications.pop();

  return {
    notifications,
    nextCursor: hasMore ? notifications[notifications.length - 1]?.created_at ?? null : null,
  };
}

/** Get count of unread notifications for badge */
export async function getUnreadCount(): Promise<number> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;

  const { count, error } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('read', false)
    .eq('archived', false);

  if (error) return 0;
  return count ?? 0;
}

/** Mark a single notification as read */
export async function markAsRead(id: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(error.message);
}

/** Mark all notifications as read for current user */
export async function markAllAsRead(): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { error } = await supabase
    .from('notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('read', false);

  if (error) throw new Error(error.message);
}

/** Soft-delete a notification (archive it) */
export async function archiveNotification(id: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('notifications')
    .update({ archived: true })
    .eq('id', id);

  if (error) throw new Error(error.message);
}
