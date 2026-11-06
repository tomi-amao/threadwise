/**
 * The bell: opens the notifications drawer, and says how many are unread. In the sidebar (a
 * nav-sized row, or an icon when the sidebar is collapsed) and in the phone header, like the
 * assistant's launcher.
 */

import { Bell } from 'phosphor-react';
import { cn } from '~/lib/utils';
import { useNotifications } from '~/providers/NotificationsProvider';

export function NotificationsBell({
  variant,
  collapsed = false,
  onActivate,
}: {
  variant: 'sidebar' | 'header';
  collapsed?: boolean;
  onActivate?: () => void;
}) {
  const { unread, open, setOpen } = useNotifications();
  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
  const activate = () => {
    onActivate?.();
    setOpen(true);
  };
  const count = unread > 0 && (
    <span
      aria-hidden
      className="inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 font-mono text-[11px] leading-5 text-white tabular-nums"
    >
      {unread > 99 ? '99+' : unread}
    </span>
  );

  if (variant === 'header') {
    return (
      <button
        type="button"
        id="notifications-bell-header"
        onClick={activate}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative inline-flex size-8 items-center justify-center rounded-lg text-text-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell size={20} weight="light" aria-hidden />
        {unread > 0 && (
          <span aria-hidden className="absolute right-1 top-1 size-2 rounded-full bg-destructive" />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      id="notifications-bell"
      onClick={activate}
      aria-label={collapsed ? label : undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={collapsed ? label : undefined}
      className={cn(
        'relative flex w-full items-center gap-3 rounded-xl text-sm font-medium transition-colors duration-200',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
        collapsed ? 'justify-center px-3 py-3' : 'px-4 py-3',
        open ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/70'
      )}
    >
      <Bell size={20} weight="light" aria-hidden />
      {collapsed ? (
        unread > 0 && (
          <span aria-hidden className="absolute right-2 top-2 size-2 rounded-full bg-destructive" />
        )
      ) : (
        <>
          <span className="flex-1 text-left">Notifications</span>
          {count}
          {unread > 0 && <span className="sr-only">, {unread} unread</span>}
        </>
      )}
    </button>
  );
}
