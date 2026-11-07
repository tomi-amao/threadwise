/**
 * NotificationsProvider: the signed-in user's open notifications, for the bell in the sidebar
 * and the phone header and the drawer they open. Mounted once in AppLayout, so the list is read
 * once and shared. It reads on mount, every minute while the tab is visible, and when the tab
 * comes back into view; a failed read keeps what was shown (the bell is not worth an error).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  markNotificationsRead,
  readNotifications,
  type AppNotification,
} from '~/lib/notifications';
import { getSupabaseBrowserClient } from '~/lib/supabase-browser';
import { useAuth } from './AuthProvider';

const POLL_MS = 60_000;

interface NotificationsContextValue {
  notifications: AppNotification[];
  unread: number;
  open: boolean;
  setOpen: (open: boolean) => void;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      setNotifications(await readNotifications(getSupabaseBrowserClient()));
    } catch {
      // Keep what is shown; the next poll tries again.
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, refresh]);

  const markRead = useCallback(
    async (ids: string[]) => {
      const unreadIds = ids.filter(id => notifications.find(n => n.id === id && !n.read_at));
      if (unreadIds.length === 0) return;
      const now = new Date().toISOString();
      // Shown as read at once; the next read corrects it if the write did not land.
      setNotifications(list =>
        list.map(n => (unreadIds.includes(n.id) ? { ...n, read_at: now } : n))
      );
      try {
        await markNotificationsRead(getSupabaseBrowserClient(), unreadIds);
      } catch {
        void refresh();
      }
    },
    [notifications, refresh]
  );

  const markAllRead = useCallback(
    () => markRead(notifications.filter(n => !n.read_at).map(n => n.id)),
    [markRead, notifications]
  );

  const value = useMemo(
    () => ({
      notifications,
      unread: notifications.filter(n => !n.read_at).length,
      open,
      setOpen,
      markRead,
      markAllRead,
      refresh,
    }),
    [notifications, open, markRead, markAllRead, refresh]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsContextValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error('useNotifications must be used inside NotificationsProvider');
  return value;
}
