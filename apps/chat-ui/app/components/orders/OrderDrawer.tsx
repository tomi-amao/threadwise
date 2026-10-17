/**
 * OrderDrawer
 *
 * One order: what was bought, what it came to, how it was paid, and who it was for. Loaded from
 * /api/orders?id= when opened (?order=<id>).
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArrowSquareOut, CircleNotch } from 'phosphor-react';
import { Chip } from '~/components/ui/chip';
import { Drawer } from '~/components/ui/drawer';
import { Eyebrow } from '~/components/ui/eyebrow';
import type { OrderDetail } from '~/lib/api/orders.server';
import { cn } from '~/lib/utils';
import { customerLabel, int, money, shortDate, statusOf } from './model';

type Load =
  | { id: string; state: 'ready'; detail: OrderDetail }
  | { id: string; state: 'error'; message: string };

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

function addressLines(address: Record<string, unknown> | null): string[] {
  if (!address) return [];
  const pick = (...keys: string[]) =>
    keys.map(k => address[k]).find(v => typeof v === 'string' && v.trim()) as string | undefined;
  const name = pick('name') ?? [pick('first_name'), pick('last_name')].filter(Boolean).join(' ');
  return [
    name,
    pick('address1', 'address_line_1', 'line1', 'street'),
    pick('address2', 'address_line_2', 'line2'),
    [pick('city'), pick('province', 'region', 'state'), pick('zip', 'postal_code', 'postcode')]
      .filter(Boolean)
      .join(' '),
    pick('country', 'country_code'),
  ].filter((l): l is string => !!l && l.trim().length > 0);
}

export function OrderDrawer({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const [load, setLoad] = useState<Load | null>(null);

  useEffect(() => {
    if (!orderId) return;
    let live = true;
    fetch(`/api/orders?id=${encodeURIComponent(orderId)}`)
      .then(r => r.json())
      .then((result: { ok: boolean; error?: string; detail?: OrderDetail }) => {
        if (!live) return;
        setLoad(
          result.ok && result.detail
            ? { id: orderId, state: 'ready', detail: result.detail }
            : { id: orderId, state: 'error', message: result.error ?? 'Could not load this order' }
        );
      })
      .catch(
        () => live && setLoad({ id: orderId, state: 'error', message: 'Could not load this order' })
      );
    return () => {
      live = false;
    };
  }, [orderId]);

  const current = load && load.id === orderId ? load : null;
  const detail = current?.state === 'ready' ? current.detail : null;
  const order = detail?.order;
  const status = order ? statusOf(order.status) : null;

  return (
    <Drawer
      open={!!orderId}
      onOpenChange={open => !open && onClose()}
      eyebrow={order ? `Order · ${shortDate(order.created_at)}` : 'Order'}
      title={order ? order.order_number : current?.state === 'error' ? 'Order' : 'Loading…'}
      description="What was ordered, how it was paid and who it was for"
      className="w-[min(560px,100vw)]"
    >
      {orderId && !current && (
        <div role="status" className="flex items-center gap-2 text-text-2">
          <CircleNotch size={18} className="animate-spin" aria-hidden /> Loading order…
        </div>
      )}
      {current?.state === 'error' && (
        <p role="alert" className="text-destructive">
          {current.message}
        </p>
      )}
      {detail && order && status && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={status.tone} dot>
              {status.label}
            </Chip>
            <Chip>{titleCase(order.fulfillment_status)}</Chip>
            {order.refunded_total > 0 && order.status !== 'refunded' && (
              <Chip tone="negative">Part refunded</Chip>
            )}
          </div>

          <section aria-label="Customer" className="space-y-1">
            <Eyebrow>Customer</Eyebrow>
            <div className="text-[15px]">{customerLabel(order)}</div>
            {order.customer_name && order.customer_email && (
              <div className="text-[13px] text-text-2">{order.customer_email}</div>
            )}
            {order.customer_id && (
              <Link
                to={`/customers?customer=${order.customer_id}`}
                className="inline-flex items-center gap-1 rounded-sm text-[14px] text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                View customer <ArrowSquareOut size={14} aria-hidden />
              </Link>
            )}
          </section>

          <section aria-label="Items" className="space-y-3 border-t pt-5">
            <Eyebrow>Items</Eyebrow>
            <ul className="divide-y rounded-xl border">
              {detail.lines.map(line => (
                <li key={line.id} className="flex items-start justify-between gap-3 px-3.5 py-3">
                  <div className="min-w-0">
                    <div className="text-[15px]">{line.product_name}</div>
                    <div className="font-mono text-xs text-text-2">
                      {int(line.quantity)} × {money(line.unit_price, order.currency)}
                      {line.variant_name && ` · ${line.variant_name}`}
                      {line.sku && ` · ${line.sku}`}
                    </div>
                  </div>
                  <div className="shrink-0 tabular-nums">
                    {money(line.total_price, order.currency)}
                  </div>
                </li>
              ))}
            </ul>
            <dl className="space-y-1.5 text-[15px]">
              {[
                ['Subtotal', order.subtotal, false],
                ['Discount', -order.discount, order.discount === 0],
                ['Shipping', order.shipping, false],
                ['Total', order.grand_total, false],
                ['Refunded', -order.refunded_total, order.refunded_total === 0],
              ].map(([label, value, hide]) =>
                hide ? null : (
                  <div
                    key={label as string}
                    className={cn(
                      'flex items-baseline justify-between',
                      label === 'Total' && 'border-t pt-2 font-medium'
                    )}
                  >
                    <dt className="text-text-2">{label as string}</dt>
                    <dd
                      className={cn(
                        'tabular-nums',
                        label === 'Refunded' && 'text-destructive',
                        label === 'Total' && 'font-serif text-[22px]'
                      )}
                    >
                      {(value as number) < 0 ? '−' : ''}
                      {money(Math.abs(value as number), order.currency)}
                    </dd>
                  </div>
                )
              )}
            </dl>
            <p className="text-[13px] text-muted-foreground">
              Includes {money(order.tax, order.currency)} VAT.
            </p>
          </section>

          <section aria-label="Payment" className="space-y-2 border-t pt-5">
            <Eyebrow>Payment</Eyebrow>
            {detail.payments.length === 0 ? (
              <p className="text-[14px] text-text-2">No payment is recorded for this order.</p>
            ) : (
              <ul className="space-y-2">
                {detail.payments.map(p => (
                  <li key={p.id} className="flex items-baseline justify-between gap-3 text-[15px]">
                    <span>
                      {titleCase(p.gateway ?? 'Unknown')}
                      {p.payment_method && p.payment_method !== p.gateway && (
                        <span className="text-text-2"> · {titleCase(p.payment_method)}</span>
                      )}
                      <span className="block text-[13px] text-text-2">
                        {titleCase(p.status)}
                        {p.paid_on && ` · ${shortDate(p.paid_on)}`}
                      </span>
                    </span>
                    <span className="text-right tabular-nums">
                      {money(p.amount, order.currency)}
                      <span className="block text-[13px] text-text-2">
                        {money(p.net_amount, order.currency)} after fees
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {addressLines(order.shipping_address).length > 0 && (
            <section aria-label="Shipping address" className="space-y-1 border-t pt-5">
              <Eyebrow>Ships to</Eyebrow>
              <address className="text-[15px] not-italic">
                {addressLines(order.shipping_address).map(line => (
                  <div key={line}>{line}</div>
                ))}
              </address>
            </section>
          )}
        </>
      )}
    </Drawer>
  );
}
