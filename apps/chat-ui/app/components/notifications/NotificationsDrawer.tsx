/**
 * NotificationsDrawer: what needs the user, newest first. Each says what happened and links to
 * where to act on it; following the link marks it read. Resolved notifications (the problem has
 * gone away) are not listed. "Mark all as read" clears the count without acting on anything.
 */

import { Link } from 'react-router';
import { Button } from '~/components/ui/button';
import { Drawer } from '~/components/ui/drawer';
import { noticeAge, safeLink } from '~/lib/notifications';
import { cn } from '~/lib/utils';
import { useNotifications } from '~/providers/NotificationsProvider';

export function NotificationsDrawer() {
  const { notifications, unread, open, setOpen, markRead, markAllRead } = useNotifications();

  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      eyebrow="Notifications"
      title="What needs you"
      description="Notifications about your integrations and your books"
      footer={
        unread > 0 ? (
          <Button variant="outline" onClick={() => void markAllRead()}>
            Mark all as read
          </Button>
        ) : undefined
      }
    >
      {notifications.length === 0 ? (
        <p className="py-10 text-center text-[15px] text-text-2">Nothing needs you right now.</p>
      ) : (
        <ul aria-label="Notifications" className="divide-y rounded-xl border">
          {notifications.map(n => {
            const link = safeLink(n.link);
            const fresh = !n.read_at;
            return (
              <li key={n.id} className="px-4 py-3.5">
                <article aria-label={n.title} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      'mt-2 size-2 shrink-0 rounded-full',
                      fresh ? 'bg-destructive' : 'bg-transparent'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className={cn('text-[15px]', fresh && 'font-medium')}>
                      {n.title}
                      {fresh && <span className="sr-only"> (unread)</span>}
                    </h3>
                    {n.body && <p className="mt-0.5 text-[14px] text-text-2">{n.body}</p>}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-2">
                      <span>{noticeAge(n.updated_at)}</span>
                      {link && (
                        <Link
                          to={link}
                          onClick={() => {
                            void markRead([n.id]);
                            setOpen(false);
                          }}
                          className="rounded-sm text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Go to it
                        </Link>
                      )}
                      {fresh && (
                        <button
                          type="button"
                          onClick={() => void markRead([n.id])}
                          className="rounded-sm underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Mark as read
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
