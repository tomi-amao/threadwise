/**
 * Notifications, read and marked read in the browser as the signed-in user.
 *
 * The agent writes them (apps/ai_agent/src/ai_agent/services/notifications.py); row-level
 * security limits reads to the user's own business, and `read_at` is the only column a user may
 * change (supabase/migrations/20261107000000_notifications.sql). Only open ones are listed:
 * a resolved notification is about a problem that has gone away.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  updated_at: string;
  read_at: string | null;
}

/** The bell shows at most this many; more than that is a sign of a different problem. */
export const NOTIFICATIONS_SHOWN = 50;

export async function readNotifications(supabase: SupabaseClient): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, kind, title, body, link, created_at, updated_at, read_at')
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
    .limit(NOTIFICATIONS_SHOWN);
  if (error) throw new Error(error.message);
  return (data ?? []) as AppNotification[];
}

/** Mark these read. Those already read keep the time they were first read. */
export async function markNotificationsRead(
  supabase: SupabaseClient,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .in('id', ids)
    .is('read_at', null);
  if (error) throw new Error(error.message);
}

/** A link is a path inside the app; anything else is not followed. */
export const safeLink = (link: string | null): string | null =>
  link && link.startsWith('/') && !link.startsWith('//') && !link.startsWith('/\\') ? link : null;

/** "Just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function noticeAge(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
