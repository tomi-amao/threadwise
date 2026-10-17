import React, { useState } from 'react';
import { Link } from 'react-router';
import { ArrowClockwise, ArrowRight } from 'phosphor-react';
import { toast } from 'sonner';
import { Eyebrow, RAMP, Segmented, StatusChipRaw, fmtDate, gbp, int, pct } from './ui-shared';
import { RevenueBars } from './charts';
import {
  BANK_ACCOUNTS,
  CUSTOMER_STATS,
  ENTITY_NAME,
  KPIS,
  MONTHLY,
  ORDER_STATUSES,
  PAYMENTS,
  RECENT_ORDERS,
  TOP_CUSTOMERS,
  TOP_PRODUCTS,
  sum,
} from './data';

const label = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const ORDER_TONE: Record<string, string> = {
  delivered: 'completed',
  paid: 'active',
  shipped: 'active',
  processing: 'active',
  pending: 'draft',
  cancelled: 'draft',
  refunded: 'planned',
  partially_refunded: 'planned',
};

function Section({
  eyebrow,
  title,
  note,
  band = false,
  action,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  note?: string;
  band?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={band ? 'cv2-band' : ''}>
      <div className="cv2-wrap" style={{ paddingTop: 88, paddingBottom: 88 }}>
        <div
          className="cv2-between"
          style={{ alignItems: 'flex-end', marginBottom: 40, flexWrap: 'wrap' }}
        >
          <div style={{ maxWidth: 680 }}>
            <Eyebrow>{eyebrow}</Eyebrow>
            <h2 className="cv2-h2" style={{ marginTop: 12 }}>
              {title}
            </h2>
            {note && (
              <p className="cv2-2" style={{ margin: '12px 0 0', maxWidth: 560 }}>
                {note}
              </p>
            )}
          </div>
          {action}
        </div>
        {children}
      </div>
    </section>
  );
}

function ViewAll({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="cv2-link">
      {children} <ArrowRight size={14} weight="light" />
    </Link>
  );
}

export function DashboardV2() {
  const [window_, setWindow] = useState<'6' | '12' | 'all'>('12');
  const [updated, setUpdated] = useState(() => new Date());

  const monthly = window_ === 'all' ? MONTHLY : MONTHLY.slice(-Number(window_));
  const windowRevenue = sum(monthly.map(m => m.revenue));
  const k = KPIS;
  const feePct = (k.processingFees / k.grossRevenue) * 100;
  const refundPct = (k.totalRefunds / k.grossRevenue) * 100;
  const top3 = sum(TOP_PRODUCTS.slice(0, 3).map(p => p.totalRevenue));
  const topMax = TOP_PRODUCTS[0].totalRevenue;
  const payTotal = sum(PAYMENTS.map(p => p.totalAmount));
  const payName = (g: string, m: string) => {
    const gg = label(g);
    return m === g || m === 'Unknown' ? gg : `${gg} · ${label(m)}`;
  };
  const avgOrders = KPIS.totalOrders / CUSTOMER_STATS.withOrders;
  const ltv = KPIS.grossRevenue / CUSTOMER_STATS.withOrders;
  const best = monthly.reduce((a, m) => (m.revenue > a.revenue ? m : a));
  const bankTotal = sum(BANK_ACCOUNTS.map(a => a.balance));

  return (
    <>
      <header className="cv2-wrap cv2-rise" style={{ paddingTop: 64, paddingBottom: 48 }}>
        <Eyebrow>{ENTITY_NAME} · All time</Eyebrow>
        <h1 className="cv2-h1" style={{ marginTop: 20, maxWidth: 820 }}>
          Where the business <em>stands today.</em>
        </h1>
        <p className="cv2-lead" style={{ marginTop: 24 }}>
          {gbp(k.grossRevenue)} sold across {int(k.totalOrders)} orders, with{' '}
          {gbp(k.totalBankBalance)} in the bank.
        </p>
        <div className="cv2-flex" style={{ marginTop: 32, gap: 16 }}>
          <button
            type="button"
            className="cv2-btn cv2-btn-secondary"
            onClick={() => {
              setUpdated(new Date());
              toast.success('Dashboard refreshed');
            }}
          >
            <ArrowClockwise size={16} weight="light" /> Refresh
          </button>
          <span className="cv2-mono cv2-muted" style={{ fontSize: 12, letterSpacing: '0.04em' }}>
            UPDATED {updated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </header>

      <section className="cv2-wrap cv2-rise" style={{ animationDelay: '60ms' }}>
        <div className="cv2-stats">
          <div className="cv2-stat">
            <Eyebrow>Gross revenue</Eyebrow>
            <div className="cv2-stat-value">{gbp(k.grossRevenue)}</div>
            <div className="cv2-stat-label">All orders</div>
            <div className="cv2-stat-cap">
              {int(k.totalOrders)} orders · {gbp(k.avgOrderValue, 2)} average
            </div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Net revenue</Eyebrow>
            <div className="cv2-stat-value">{gbp(k.netRevenue)}</div>
            <div className="cv2-stat-label">After fees and refunds</div>
            <div className="cv2-stat-cap">
              {pct((k.netRevenue / k.grossRevenue) * 100)} of gross kept
            </div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>In the bank</Eyebrow>
            <div className="cv2-stat-value">{gbp(k.totalBankBalance)}</div>
            <div className="cv2-stat-label">{BANK_ACCOUNTS.length} accounts</div>
            <div className="cv2-stat-cap">Revolut and PayPal</div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Customers</Eyebrow>
            <div className="cv2-stat-value">{int(k.totalCustomers)}</div>
            <div className="cv2-stat-label">{int(CUSTOMER_STATS.withOrders)} have bought</div>
            <div className="cv2-stat-cap">{pct(CUSTOMER_STATS.repeatRate)} come back</div>
          </div>
        </div>
      </section>

      {/* Money in */}
      <Section
        eyebrow="Revenue"
        title={
          <>
            Money in, <em>and what stays.</em>
          </>
        }
        note={`Fees take ${pct(feePct)} of gross and refunds ${pct(refundPct)}. ${best.label} was the strongest month at ${gbp(best.revenue)}.`}
        action={
          <Segmented
            label="Chart window"
            value={window_}
            onChange={setWindow}
            options={[
              { value: '6', label: '6 months' },
              { value: '12', label: '12 months' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      >
        <div className="cv2-grid-wide">
          <div className="cv2-card cv2-card-pad">
            <div className="cv2-between" style={{ marginBottom: 12 }}>
              <Eyebrow>Monthly gross revenue</Eyebrow>
              <span className="cv2-mono cv2-2" style={{ fontSize: 13 }}>
                {gbp(windowRevenue)} in window
              </span>
            </div>
            <RevenueBars data={monthly} />
            <div style={{ marginTop: 16 }}>
              <ViewAll to="/reports-v2">Open reports</ViewAll>
            </div>
          </div>

          <div className="cv2-card cv2-card-pad">
            <Eyebrow>Orders by status</Eyebrow>
            <div className="cv2-stat-value" style={{ marginTop: 10, fontSize: 36 }}>
              {int(k.totalOrders)}
            </div>
            <div className="cv2-stack" style={{ margin: '16px 0 18px' }}>
              {ORDER_STATUSES.map((s, i) => (
                <span
                  key={s.status}
                  style={{ flexGrow: s.count, background: RAMP[i % RAMP.length] }}
                  title={`${label(s.status)}: ${s.count}`}
                />
              ))}
            </div>
            <dl className="cv2-dl">
              {ORDER_STATUSES.map((s, i) => (
                <div key={s.status}>
                  <dt>
                    <span className="cv2-legend">
                      <span>
                        <i style={{ background: RAMP[i % RAMP.length] }} />
                        {label(s.status)}
                      </span>
                    </span>
                  </dt>
                  <dd>
                    {int(s.count)}{' '}
                    <small style={{ display: 'inline', marginLeft: 6 }}>
                      {pct((s.count / k.totalOrders) * 100, 0)}
                    </small>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Section>

      {/* What sells */}
      <Section
        band
        eyebrow="Products and payments"
        title={
          <>
            Three products carry <em>{pct((top3 / k.grossRevenue) * 100, 0)} of sales.</em>
          </>
        }
        note="Ranked by revenue across every order. Payment methods show what was captured, not what was charged."
        action={<ViewAll to="/products">All products</ViewAll>}
      >
        <div className="cv2-grid-3" style={{ marginBottom: 32 }}>
          {TOP_PRODUCTS.slice(0, 3).map((p, i) => (
            <div
              key={p.name}
              style={{ borderTop: '1px solid var(--border-strong)', paddingTop: 16 }}
            >
              <div className="cv2-step">0{i + 1}</div>
              <h3 className="cv2-h3" style={{ fontSize: 26, margin: '8px 0' }}>
                {p.name}.
              </h3>
              <p className="cv2-2" style={{ margin: 0 }}>
                {gbp(p.totalRevenue)} from {int(p.totalQuantity)} units in {int(p.orderCount)}{' '}
                orders.
              </p>
            </div>
          ))}
        </div>

        <div className="cv2-grid-wide">
          <div className="cv2-card cv2-scroll">
            <table className="cv2-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th style={{ width: '34%' }}>Share of top seller</th>
                  <th className="r">Units</th>
                  <th className="r">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {TOP_PRODUCTS.map(p => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td>
                      <div className="cv2-meter">
                        <span style={{ width: `${(p.totalRevenue / topMax) * 100}%` }} />
                      </div>
                    </td>
                    <td className="r cv2-num cv2-2">{int(p.totalQuantity)}</td>
                    <td className="r cv2-num">{gbp(p.totalRevenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="cv2-card cv2-card-pad">
            <Eyebrow>Payment methods</Eyebrow>
            <div className="cv2-stat-value" style={{ marginTop: 10, fontSize: 36 }}>
              {gbp(payTotal)}
            </div>
            <div className="cv2-stat-cap" style={{ marginBottom: 16 }}>
              captured
            </div>
            <div className="cv2-stack" style={{ marginBottom: 18 }}>
              {PAYMENTS.map((p, i) => (
                <span
                  key={i}
                  style={{ flexGrow: p.totalAmount, background: RAMP[i % RAMP.length] }}
                  title={`${payName(p.gateway, p.method)}: ${gbp(p.totalAmount)}`}
                />
              ))}
            </div>
            <dl className="cv2-dl">
              {PAYMENTS.map((p, i) => (
                <div key={i}>
                  <dt>
                    <span className="cv2-legend">
                      <span>
                        <i style={{ background: RAMP[i % RAMP.length] }} />
                        {payName(p.gateway, p.method)}
                      </span>
                    </span>
                  </dt>
                  <dd>
                    {gbp(p.totalAmount)}{' '}
                    <small style={{ display: 'inline', marginLeft: 6 }}>
                      {pct((p.totalAmount / payTotal) * 100, 0)}
                    </small>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Section>

      {/* Who buys */}
      <Section
        eyebrow="Customers"
        title={
          <>
            {pct(CUSTOMER_STATS.repeatRate, 0)} of buyers <em>come back.</em>
          </>
        }
        note={`${int(CUSTOMER_STATS.repeat)} of ${int(CUSTOMER_STATS.withOrders)} buyers have ordered more than once.`}
        action={<ViewAll to="/customers">All customers</ViewAll>}
      >
        <div className="cv2-grid-4" style={{ marginBottom: 40 }}>
          {[
            [
              '01',
              'Repeat.',
              `${int(CUSTOMER_STATS.repeat)} customers`,
              `${pct(CUSTOMER_STATS.repeatRate)} repeat rate`,
            ],
            [
              '02',
              'Buyers.',
              `${int(CUSTOMER_STATS.withOrders)}`,
              `of ${int(CUSTOMER_STATS.total)} on file`,
            ],
            ['03', 'Frequency.', avgOrders.toFixed(1), 'orders per buyer'],
            ['04', 'Lifetime.', gbp(ltv), 'average revenue per buyer'],
          ].map(([n, t, v, c]) => (
            <div key={n} style={{ borderTop: '1px solid var(--border-strong)', paddingTop: 16 }}>
              <div className="cv2-step">{n}</div>
              <h3 className="cv2-h3" style={{ fontSize: 26, margin: '8px 0 4px' }}>
                {t}
              </h3>
              <div className="cv2-serif-num" style={{ fontSize: 32 }}>
                {v}
              </div>
              <p className="cv2-muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
                {c}
              </p>
            </div>
          ))}
        </div>

        <div className="cv2-card cv2-scroll">
          <table className="cv2-table">
            <thead>
              <tr>
                <th>Top customers</th>
                <th className="r">Orders</th>
                <th>Last order</th>
                <th className="r">Lifetime spend</th>
              </tr>
            </thead>
            <tbody>
              {TOP_CUSTOMERS.map(c => (
                <tr key={c.id}>
                  <td>
                    <div>{c.name}</div>
                    <div className="cv2-muted" style={{ fontSize: 13 }}>
                      {c.email}
                    </div>
                  </td>
                  <td className="r cv2-num cv2-2">{c.orderCount}</td>
                  <td className="cv2-mono cv2-2" style={{ fontSize: 13 }}>
                    {fmtDate(c.lastOrderDate, true)}
                  </td>
                  <td className="r cv2-num">{gbp(c.totalSpent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Cash */}
      <Section
        band
        eyebrow="Cash"
        title={
          <>
            {gbp(bankTotal)} <em>across {BANK_ACCOUNTS.length} accounts.</em>
          </>
        }
        note="Live balances from connected banks and PayPal."
        action={<ViewAll to="/reports-v2?tab=cash">Cash flow</ViewAll>}
      >
        <div className="cv2-grid-3">
          {BANK_ACCOUNTS.map(a => (
            <div key={a.id} className="cv2-card cv2-card-pad cv2-hover">
              <div className="cv2-between">
                <Eyebrow>{a.source}</Eyebrow>
                <span className="cv2-chip cv2-chip-plain">{a.currency}</span>
              </div>
              <div className="cv2-serif-num" style={{ fontSize: 36, margin: '14px 0 4px' }}>
                {gbp(a.balance, 2)}
              </div>
              <div className="cv2-2">{a.name}</div>
              <div style={{ marginTop: 16 }} className="cv2-meter">
                <span style={{ width: `${(a.balance / bankTotal) * 100}%` }} />
              </div>
              <div className="cv2-mono cv2-muted" style={{ fontSize: 12, marginTop: 8 }}>
                {pct((a.balance / bankTotal) * 100, 0)} OF TOTAL
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Latest */}
      <Section
        eyebrow="Latest orders"
        title={
          <>
            The last ten, <em>newest first.</em>
          </>
        }
        action={<ViewAll to="/orders">All orders</ViewAll>}
      >
        <div className="cv2-card cv2-scroll">
          <table className="cv2-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Status</th>
                <th className="r">Items</th>
                <th className="r">Amount</th>
                <th className="r">Date</th>
              </tr>
            </thead>
            <tbody>
              {RECENT_ORDERS.map(o => (
                <tr key={o.id}>
                  <td className="cv2-mono" style={{ fontSize: 13 }}>
                    {o.orderNumber}
                  </td>
                  <td>{o.customerName}</td>
                  <td>
                    <StatusChipRaw tone={ORDER_TONE[o.status] ?? 'draft'}>
                      {label(o.status)}
                    </StatusChipRaw>
                  </td>
                  <td className="r cv2-num cv2-2">{o.itemCount}</td>
                  <td className="r cv2-num">{gbp(o.grandTotal, 2)}</td>
                  <td className="r cv2-mono cv2-2" style={{ fontSize: 13 }}>
                    {fmtDate(o.createdAt, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <div style={{ height: 24 }} />
    </>
  );
}
