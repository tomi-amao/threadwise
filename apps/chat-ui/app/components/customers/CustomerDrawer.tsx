/**
 * CustomerDrawer
 *
 * One customer: how much they have spent, how often, what they buy, and their orders. Loaded
 * from /api/customers?id= when opened (?customer=<id>).
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CircleNotch } from 'phosphor-react';
import { Chip } from '~/components/ui/chip';
import { Drawer } from '~/components/ui/drawer';
import { Eyebrow } from '~/components/ui/eyebrow';
import type { CustomerDetail } from '~/lib/api/customers.server';
import { ago, int, money, segmentOf, shortDate } from './model';

type Load =
  | { id: string; state: 'ready'; detail: CustomerDetail }
  | { id: string; state: 'error'; message: string };

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

export function CustomerDrawer({
  customerId,
  today,
  currency,
  onClose,
}: {
  customerId: string | null;
  today: string;
  currency: string;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<Load | null>(null);

  useEffect(() => {
    if (!customerId) return;
    let live = true;
    fetch(`/api/customers?id=${encodeURIComponent(customerId)}`)
      .then(r => r.json())
      .then((result: { ok: boolean; error?: string; detail?: CustomerDetail }) => {
        if (!live) return;
        setLoad(
          result.ok && result.detail
            ? { id: customerId, state: 'ready', detail: result.detail }
            : {
                id: customerId,
                state: 'error',
                message: result.error ?? 'Could not load this customer',
              }
        );
      })
      .catch(
        () =>
          live &&
          setLoad({ id: customerId, state: 'error', message: 'Could not load this customer' })
      );
    return () => {
      live = false;
    };
  }, [customerId]);

  const current = load && load.id === customerId ? load : null;
  const detail = current?.state === 'ready' ? current.detail : null;
  const customer = detail?.customer;
  const segment = customer ? segmentOf(customer, today) : null;

  return (
    <Drawer
      open={!!customerId}
      onOpenChange={open => !open && onClose()}
      eyebrow="Customer"
      title={customer ? customer.name : current?.state === 'error' ? 'Customer' : 'Loading…'}
      description="Spend, order history and favourite products for this customer"
      className="w-[min(560px,100vw)]"
    >
      {customerId && !current && (
        <div role="status" className="flex items-center gap-2 text-text-2">
          <CircleNotch size={18} className="animate-spin" aria-hidden /> Loading customer…
        </div>
      )}
      {current?.state === 'error' && (
        <p role="alert" className="text-destructive">
          {current.message}
        </p>
      )}
      {detail && customer && segment && (
        <>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={segment.tone} dot>
                {segment.label}
              </Chip>
            </div>
            {customer.email && <div className="text-[14px] text-text-2">{customer.email}</div>}
            {customer.phone && <div className="text-[14px] text-text-2">{customer.phone}</div>}
          </div>

          <dl aria-label="Summary" className="grid grid-cols-3 gap-3">
            <div>
              <dt className="eyebrow">Spent</dt>
              <dd className="mt-1 font-serif text-[24px] tabular-nums">
                {money(customer.spent, currency, 0)}
              </dd>
            </div>
            <div>
              <dt className="eyebrow">Orders</dt>
              <dd className="mt-1 font-serif text-[24px] tabular-nums">{int(customer.orders)}</dd>
            </div>
            <div>
              <dt className="eyebrow">Average</dt>
              <dd className="mt-1 font-serif text-[24px] tabular-nums">
                {customer.orders > 0 ? money(customer.spent / customer.orders, currency, 0) : '—'}
              </dd>
            </div>
          </dl>
          <dl className="grid grid-cols-2 gap-3 text-[14px]">
            <div>
              <dt className="eyebrow">First order</dt>
              <dd className="mt-1">
                {customer.first_order_at ? shortDate(customer.first_order_at) : '—'}
              </dd>
            </div>
            <div>
              <dt className="eyebrow">Latest order</dt>
              <dd className="mt-1">
                {customer.last_order_at
                  ? `${shortDate(customer.last_order_at)} · ${ago(customer.last_order_at, today)}`
                  : '—'}
              </dd>
            </div>
          </dl>

          {detail.top_products.length > 0 && (
            <section aria-label="Favourite products" className="space-y-2 border-t pt-5">
              <Eyebrow>Buys most</Eyebrow>
              <ul className="divide-y rounded-xl border">
                {detail.top_products.map(p => (
                  <li
                    key={p.name}
                    className="flex items-baseline justify-between gap-3 px-3.5 py-2.5"
                  >
                    <span className="min-w-0 truncate text-[15px]">{p.name}</span>
                    <span className="shrink-0 font-mono text-xs text-text-2">
                      {int(p.quantity)} {p.quantity === 1 ? 'UNIT' : 'UNITS'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-label="Orders" className="space-y-2 border-t pt-5">
            <div className="flex items-baseline justify-between gap-3">
              <Eyebrow>Orders</Eyebrow>
              <span className="font-mono text-xs text-text-2">{int(detail.orders.length)}</span>
            </div>
            {detail.orders.length === 0 ? (
              <p className="text-[14px] text-text-2">This customer has not ordered yet.</p>
            ) : (
              <ul className="divide-y rounded-xl border">
                {detail.orders.slice(0, 10).map(o => (
                  <li key={o.id}>
                    <Link
                      to={`/orders?order=${o.id}&tab=all`}
                      className="flex items-baseline justify-between gap-3 px-3.5 py-2.5 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="min-w-0">
                        <span className="font-mono text-[13px]">{o.order_number}</span>
                        <span className="block text-[13px] text-text-2">
                          {shortDate(o.created_at)} · {titleCase(o.status)}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {money(o.grand_total, o.currency)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {detail.orders.length > 10 && (
              <p className="text-[13px] text-muted-foreground">
                Showing the latest 10 of {int(detail.orders.length)}.
              </p>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}
