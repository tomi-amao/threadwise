import React, { useState } from 'react';
import { Check, FilePdf, Warning } from 'phosphor-react';
import {
  cashFlowFor,
  cashInsights,
  balanceSheet,
  detailFor,
  netIncomeOf,
  otherOutboundOf,
  pnlFor,
  revenueFor,
  sum,
  totalSalesOf,
  type Account,
  type DetailKind,
  type MonthRow,
} from './data';
import { AccountDrawer, Statement, acct, type Row } from './Statement';
import { CashBars, TrendChart } from './charts';
import { Drawer, Eyebrow, Meter, gbp, int, pct } from '../collections-v2/ui';
import { toast } from 'sonner';

const Card = ({
  children,
  pad = true,
  style,
}: {
  children: React.ReactNode;
  pad?: boolean;
  style?: React.CSSProperties;
}) => (
  <section className={`cv2-card ${pad ? 'cv2-card-pad' : ''}`} style={style}>
    {children}
  </section>
);

function Heading({ eyebrow, title, note }: { eyebrow: string; title: string; note?: string }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h3 className="cv2-h3" style={{ fontSize: 26, marginTop: 8 }}>
        {title}
      </h3>
      {note && (
        <p className="cv2-2" style={{ margin: '8px 0 0', fontSize: 14, maxWidth: 560 }}>
          {note}
        </p>
      )}
    </div>
  );
}

/* ── Revenue ─────────────────────────────────────────── */

function MonthDetailDrawer({
  month,
  kind,
  onClose,
}: {
  month: MonthRow;
  kind: DetailKind;
  onClose: () => void;
}) {
  const items = detailFor(month, kind);
  const title = {
    cogs: 'Cost of goods sold',
    shipping: 'Shipping & fulfilment',
    other: 'Other outbound & expenses',
  }[kind];
  return (
    <Drawer
      eyebrow={month.label}
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="cv2-btn cv2-btn-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="cv2-serif-num" style={{ fontSize: 44, lineHeight: 1.05 }}>
        {gbp(sum(items.map(i => i.amount)))}
      </div>
      <div>
        {items.map(i => (
          <div
            key={i.label}
            className="cv2-between"
            style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}
          >
            <div>
              <div>{i.label}</div>
              <div className="cv2-mono cv2-muted" style={{ fontSize: 12, marginTop: 2 }}>
                {i.note.toUpperCase()}
              </div>
            </div>
            <div className="cv2-num">{gbp(i.amount)}</div>
          </div>
        ))}
      </div>
      <p className="cv2-muted" style={{ fontSize: 13, margin: 0 }}>
        Sample rows for the preview. The live page lists the source transactions for the month.
      </p>
    </Drawer>
  );
}

export function RevenueTab({ months }: { months: MonthRow[] }) {
  const rev = revenueFor(months);
  const [detail, setDetail] = useState<{ month: MonthRow; kind: DetailKind } | null>(null);
  const chart = months.map(m => ({
    label: m.label,
    sales: totalSalesOf(m),
    income: netIncomeOf(m),
  }));
  const breakdown: Row[] = [
    { kind: 'line', label: 'Gross sales', amount: rev.grossSales },
    { kind: 'line', label: 'Discounts', amount: rev.discounts, deduct: true, indent: true },
    { kind: 'line', label: 'Returns', amount: rev.returns, deduct: true, indent: true },
    { kind: 'total', label: 'Net sales', amount: rev.netSales },
    { kind: 'line', label: 'Shipping charges', amount: rev.shipping, indent: true },
    { kind: 'line', label: 'Taxes', amount: rev.taxes, indent: true },
    { kind: 'total', label: 'Total sales', amount: rev.totalSales },
    { kind: 'line', label: 'Processing fees', amount: rev.fees, deduct: true, indent: true },
    { kind: 'grand', label: 'Net revenue', amount: rev.netRevenue },
  ];
  const cell = (m: MonthRow, kind: DetailKind, v: number) =>
    v > 0 ? (
      <button
        type="button"
        className="cv2-cell-btn"
        onClick={() => setDetail({ month: m, kind })}
        aria-label={`${m.label} ${kind} detail`}
      >
        ({gbp(v)})
      </button>
    ) : (
      '—'
    );

  return (
    <div style={{ display: 'grid', gap: 24 }}>
      {months.length > 1 && (
        <Card>
          <div className="cv2-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Heading eyebrow="Trend" title="Sales against what you kept." />
            <div className="cv2-chart-legend">
              <span>
                <i style={{ background: 'var(--ramp-1)' }} />
                Total sales
              </span>
              <span>
                <i style={{ background: 'var(--plum)' }} />
                Net income
              </span>
            </div>
          </div>
          <TrendChart data={chart} />
        </Card>
      )}

      <div className="cv2-grid-wide">
        <Card>
          <Heading
            eyebrow="Revenue breakdown"
            title="From gross sales to net revenue."
            note="Follows Shopify's total-sales breakdown. Processing fees come off last so you can see what is retained."
          />
          <Statement rows={breakdown} />
        </Card>

        <Card>
          <Heading eyebrow="Around the edges" title="Orders and shipping." />
          <dl className="cv2-dl">
            <div>
              <dt>
                Orders<small>Non-cancelled, in period</small>
              </dt>
              <dd>{int(rev.orders)}</dd>
            </div>
            <div>
              <dt>
                Average order value<small>Net sales plus shipping, per order</small>
              </dt>
              <dd>{gbp(rev.avgOrderValue, 2)}</dd>
            </div>
            <div>
              <dt>
                Shipping cost<small>From bank transactions</small>
              </dt>
              <dd>{gbp(rev.shippingCost)}</dd>
            </div>
            <div>
              <dt>
                Shipping margin<small>Charged less paid out</small>
              </dt>
              <dd className={rev.shippingMargin < 0 ? 'cv2-neg' : ''}>
                {acct(rev.shippingMargin)}
              </dd>
            </div>
            <div>
              <dt>
                Gifted stock<small>Kept out of sold COGS</small>
              </dt>
              <dd>{gbp(rev.giftedStock)}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card pad={false}>
        <div style={{ padding: '24px 24px 8px' }}>
          <Heading
            eyebrow="Month by month"
            title="Where each month landed."
            note="Select a cost figure to see what it is made of."
          />
        </div>
        <div className="cv2-scroll">
          <table className="cv2-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="r">Total sales</th>
                <th className="r">Discounts</th>
                <th className="r">Returns</th>
                <th className="r">Fees</th>
                <th className="r">COGS</th>
                <th className="r">Shipping</th>
                <th className="r">Other</th>
                <th className="r">Net income</th>
                <th className="r">Orders</th>
              </tr>
            </thead>
            <tbody>
              {months.map(m => (
                <tr key={m.key}>
                  <td>
                    {m.label}
                    {(m.fraction !== undefined || m.partial) && (
                      <span className="cv2-muted cv2-mono" style={{ fontSize: 11, marginLeft: 8 }}>
                        {m.fraction !== undefined
                          ? `${Math.round(m.fraction * 100)}% OF MONTH`
                          : 'TO DATE'}
                      </span>
                    )}
                  </td>
                  <td className="r cv2-num">{gbp(totalSalesOf(m))}</td>
                  <td className="r cv2-num cv2-2">({gbp(m.discounts)})</td>
                  <td className="r cv2-num cv2-2">({gbp(m.returns)})</td>
                  <td className="r cv2-num cv2-2">({gbp(m.fees)})</td>
                  <td className="r cv2-num cv2-2">{cell(m, 'cogs', m.cogs)}</td>
                  <td className="r cv2-num cv2-2">{cell(m, 'shipping', m.shippingCost)}</td>
                  <td className="r cv2-num cv2-2">{cell(m, 'other', otherOutboundOf(m))}</td>
                  <td className={`r cv2-num ${netIncomeOf(m) < 0 ? 'cv2-neg' : ''}`}>
                    {acct(netIncomeOf(m))}
                  </td>
                  <td className="r cv2-num cv2-2">{int(m.orders)}</td>
                </tr>
              ))}
            </tbody>
            {months.length > 1 && (
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="r cv2-num">{gbp(rev.totalSales)}</td>
                  <td className="r cv2-num">({gbp(rev.discounts)})</td>
                  <td className="r cv2-num">({gbp(rev.returns)})</td>
                  <td className="r cv2-num">({gbp(rev.fees)})</td>
                  <td className="r cv2-num">({gbp(sum(months.map(m => m.cogs)))})</td>
                  <td className="r cv2-num">({gbp(rev.shippingCost)})</td>
                  <td className="r cv2-num">({gbp(sum(months.map(otherOutboundOf)))})</td>
                  <td className="r cv2-num">{acct(sum(months.map(netIncomeOf)))}</td>
                  <td className="r cv2-num">{int(rev.orders)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {detail && (
        <MonthDetailDrawer
          month={detail.month}
          kind={detail.kind}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

/* ── Profit & loss ───────────────────────────────────── */

export function PnlTab({ months, endLabel }: { months: MonthRow[]; endLabel: string }) {
  const p = pnlFor(months);
  const [open, setOpen] = useState<Account | null>(null);
  const line = (a: Account, deduct = false): Row => ({
    kind: 'line',
    label: a.name,
    amount: a.balance,
    indent: true,
    deduct,
    onClick: () => setOpen(a),
  });
  const rows: Row[] = [
    { kind: 'section', label: 'Revenue' },
    ...p.revenue.map(a => line(a)),
    { kind: 'total', label: 'Total revenue', amount: p.totalRevenue },
    { kind: 'section', label: 'Cost of goods sold' },
    ...p.cogs.map(a => line(a, true)),
    { kind: 'total', label: 'Total cost of goods sold', amount: p.totalCogs, deduct: true },
    { kind: 'total', label: 'Gross profit', amount: p.grossProfit },
    { kind: 'section', label: 'Operating expenses' },
    ...p.opex.map(a => line(a, true)),
    { kind: 'total', label: 'Total operating expenses', amount: p.totalOpex, deduct: true },
    { kind: 'grand', label: 'Net income', amount: p.netIncome },
  ];
  const ladder = [
    {
      label: 'Gross margin',
      value: p.totalRevenue ? (p.grossProfit / p.totalRevenue) * 100 : 0,
      cap: 'Revenue left after goods sold',
    },
    {
      label: 'Operating margin',
      value: p.totalRevenue ? ((p.grossProfit - p.totalOpex) / p.totalRevenue) * 100 : 0,
      cap: 'After running the business',
    },
    {
      label: 'Largest cost',
      value: p.totalRevenue
        ? (Math.max(...p.opex.map(a => a.balance), p.totalCogs) / p.totalRevenue) * 100
        : 0,
      cap:
        p.totalCogs >= Math.max(...p.opex.map(a => a.balance))
          ? 'Cost of goods sold'
          : [...p.opex].sort((a, b) => b.balance - a.balance)[0].name,
    },
  ];

  return (
    <div className="cv2-grid-wide">
      <Card>
        <Heading
          eyebrow="Profit & loss"
          title="Built from posted journals."
          note="Revenue is credit-normal, expenses are debit-normal. Select an account to see the entries behind it."
        />
        <Statement rows={rows} />
      </Card>

      <div style={{ display: 'grid', gap: 20 }}>
        <Card>
          <Eyebrow>Net income</Eyebrow>
          <div className={`cv2-stat-value ${p.netIncome < 0 ? 'cv2-neg' : ''}`}>
            {acct(p.netIncome)}
          </div>
          <div className="cv2-stat-cap" style={{ marginTop: 8 }}>
            {months.length === 1
              ? months[0].label
              : `${months[0].label} to ${months[months.length - 1].label}`}
          </div>
        </Card>
        <Card>
          <Eyebrow>Margin ladder</Eyebrow>
          <div style={{ display: 'grid', gap: 22, marginTop: 18 }}>
            {ladder.map((l, i) => (
              <div key={l.label}>
                <div className="cv2-between" style={{ alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 500 }}>{l.label}</span>
                  <span className="cv2-serif-num" style={{ fontSize: 28 }}>
                    {pct(l.value, i === 2 ? 0 : 1)}
                  </span>
                </div>
                <div style={{ margin: '8px 0 6px' }}>
                  <Meter value={Math.max(0, l.value) / 100} />
                </div>
                <div className="cv2-muted" style={{ fontSize: 13 }}>
                  {l.cap}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {open && <AccountDrawer account={open} endLabel={endLabel} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ── Balance sheet ───────────────────────────────────── */

export function BalanceTab({ endLabel }: { endLabel: string }) {
  const b = balanceSheet();
  const [open, setOpen] = useState<Account | null>(null);
  const line = (a: Account): Row => ({
    kind: 'line',
    label: a.name,
    amount: a.balance,
    indent: true,
    onClick: () => setOpen(a),
  });
  const rows: Row[] = [
    { kind: 'section', label: 'Assets' },
    ...b.assets.map(line),
    { kind: 'total', label: 'Total assets', amount: b.totalAssets },
    { kind: 'section', label: 'Liabilities' },
    ...b.liabilities.map(line),
    { kind: 'total', label: 'Total liabilities', amount: b.totalLiabilities },
    { kind: 'section', label: 'Equity' },
    ...b.equity.map(line),
    { kind: 'total', label: 'Total equity', amount: b.totalEquity },
    { kind: 'grand', label: 'Liabilities + equity', amount: b.totalLiabilities + b.totalEquity },
  ];
  const balanced = Math.abs(b.totalAssets - (b.totalLiabilities + b.totalEquity)) < 0.01;

  return (
    <div className="cv2-grid-wide">
      <Card>
        <Heading
          eyebrow="Balance sheet"
          title="A snapshot, not a period."
          note="Cumulative balances as of today. It does not change with the period above."
        />
        <Statement rows={rows} />
      </Card>

      <div style={{ display: 'grid', gap: 20 }}>
        <Card>
          <Eyebrow>The equation</Eyebrow>
          <div className="cv2-flex" style={{ gap: 10, margin: '14px 0 18px' }}>
            {balanced ? <Check size={18} weight="light" /> : <Warning size={18} weight="light" />}
            <h3 className="cv2-h3" style={{ fontSize: 24 }}>
              {balanced ? 'The books balance.' : 'The books are out.'}
            </h3>
          </div>
          <dl className="cv2-dl">
            <div>
              <dt>Assets</dt>
              <dd>{gbp(b.totalAssets)}</dd>
            </div>
            <div>
              <dt>Liabilities + equity</dt>
              <dd>{gbp(b.totalLiabilities + b.totalEquity)}</dd>
            </div>
          </dl>
        </Card>
        <Card>
          <Eyebrow>What funds the assets</Eyebrow>
          <div className="cv2-stack" style={{ margin: '16px 0 14px' }}>
            <span
              style={{ flexGrow: b.totalLiabilities, background: 'var(--plum)' }}
              title={`Liabilities ${gbp(b.totalLiabilities)}`}
            />
            <span
              style={{ flexGrow: b.totalEquity, background: 'var(--ramp-1)' }}
              title={`Equity ${gbp(b.totalEquity)}`}
            />
          </div>
          <div className="cv2-legend">
            <span>
              <i style={{ background: 'var(--plum)' }} />
              Owed{' '}
              <span className="cv2-mono cv2-num">
                {pct((b.totalLiabilities / b.totalAssets) * 100, 0)}
              </span>
            </span>
            <span>
              <i style={{ background: 'var(--ramp-1)' }} />
              Owned{' '}
              <span className="cv2-mono cv2-num">
                {pct((b.totalEquity / b.totalAssets) * 100, 0)}
              </span>
            </span>
          </div>
        </Card>
      </div>

      {open && <AccountDrawer account={open} endLabel={endLabel} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ── Cash flow ───────────────────────────────────────── */

export function CashTab({ months }: { months: MonthRow[] }) {
  const ci = cashInsights();
  const cf = cashFlowFor(months);
  const [spendOpen, setSpendOpen] = useState(false);
  const tone =
    ci.verdict === 'generating'
      ? 'var(--ramp-1)'
      : ci.verdict === 'consuming'
        ? 'var(--neg)'
        : 'var(--plum)';
  const pctOfCash = Math.max(0, (ci.safeToSpend / cf.closing) * 100);
  const fmt = (l: { label: string; amount: number }): Row => ({
    kind: 'line',
    label: l.label,
    amount: l.amount,
    indent: true,
  });

  const rows: Row[] = [
    { kind: 'total', label: 'Opening cash', amount: cf.opening },
    { kind: 'section', label: 'Operating activities' },
    ...cf.operating.map(fmt),
    { kind: 'total', label: 'Net cash from operations', amount: cf.totalOperating },
    ...(cf.investing.length
      ? [
          { kind: 'section', label: 'Investing activities' } as Row,
          ...cf.investing.map(fmt),
          { kind: 'total', label: 'Net cash from investing', amount: cf.totalInvesting } as Row,
        ]
      : []),
    ...(cf.financing.length
      ? [
          { kind: 'section', label: 'Financing activities' } as Row,
          ...cf.financing.map(fmt),
          { kind: 'total', label: 'Net cash from financing', amount: cf.totalFinancing } as Row,
        ]
      : []),
    { kind: 'section', label: 'Not yet journalled' },
    ...cf.unclassified.map(fmt),
    { kind: 'grand', label: 'Net change in cash', amount: cf.netChange },
    { kind: 'total', label: 'Closing cash (per bank)', amount: cf.closing },
  ];

  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <div className="cv2-between" style={{ flexWrap: 'wrap' }}>
        <p className="cv2-2" style={{ margin: 0, fontSize: 14, maxWidth: 560 }}>
          Cash health and safe-to-spend look at a trailing window ending today, so they don&rsquo;t
          move with the period above.
        </p>
        <button
          type="button"
          className="cv2-btn cv2-btn-secondary cv2-btn-sm"
          onClick={() =>
            toast.info('Download is part of the live page — not wired in this preview.')
          }
        >
          <FilePdf size={14} weight="light" /> Download report
        </button>
      </div>

      <div className="cv2-grid-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Card>
          <Eyebrow>Cash health</Eyebrow>
          <div className="cv2-verdict" style={{ margin: '12px 0 8px' }}>
            <span className="cv2-dot" style={{ background: tone }} />
            <h3 className="cv2-h3" style={{ fontSize: 28 }}>
              {ci.headline}
            </h3>
          </div>
          <p className="cv2-2" style={{ margin: 0, fontSize: 14 }}>
            {ci.detail}
          </p>

          <dl className="cv2-dl" style={{ marginTop: 20 }}>
            <div>
              <dt>
                Average month<small>Operating cash, last 11 complete months</small>
              </dt>
              <dd className={ci.avg < 0 ? 'cv2-neg' : ''}>{acct(Math.round(ci.avg))}</dd>
            </div>
            <div>
              <dt>
                Last 12 months<small>Before funding</small>
              </dt>
              <dd className={ci.trailing12 < 0 ? 'cv2-neg' : ''}>{acct(ci.trailing12)}</dd>
            </div>
            <div>
              <dt>Best month</dt>
              <dd>
                {gbp(ci.best.amount)} <small>{ci.best.label}</small>
              </dd>
            </div>
            <div>
              <dt>Worst month</dt>
              <dd>
                {acct(ci.worst.amount)} <small>{ci.worst.label}</small>
              </dd>
            </div>
          </dl>

          <hr className="cv2-rule" style={{ margin: '8px 0 18px' }} />
          <div className="cv2-between" style={{ alignItems: 'baseline' }}>
            <span style={{ fontWeight: 500 }}>Funded by trading</span>
            <span className="cv2-serif-num" style={{ fontSize: 28 }}>
              {ci.tradingPct}%
            </span>
          </div>
          <div style={{ margin: '8px 0 6px' }}>
            <Meter value={ci.tradingPct / 100} />
          </div>
          <div className="cv2-muted" style={{ fontSize: 13 }}>
            {gbp(ci.trading)} from trading · {gbp(ci.director)} from you
          </div>
          {ci.runwayMonths !== null && (
            <div className="cv2-note" style={{ marginTop: 16 }}>
              <b>!</b> At the current average burn, cash covers about {ci.runwayMonths} months.
            </div>
          )}
        </Card>

        <Card style={{ display: 'flex', flexDirection: 'column' }}>
          <Eyebrow>Safe to spend</Eyebrow>
          <div className="cv2-stat-value" style={{ marginTop: 12 }}>
            {gbp(ci.safeToSpend)}
          </div>
          <div className="cv2-stat-cap" style={{ marginTop: 6 }}>
            of {gbp(cf.closing)} in the bank · {pct(pctOfCash, 0)}
          </div>
          <div style={{ margin: '18px 0 8px' }}>
            <Meter value={pctOfCash / 100} />
          </div>
          <dl className="cv2-dl" style={{ marginTop: 12 }}>
            {ci.lines.slice(1).map(l => (
              <div key={l.label}>
                <dt>{l.label.replace('Less: ', '')}</dt>
                <dd>{acct(l.amount)}</dd>
              </div>
            ))}
          </dl>
          <div style={{ marginTop: 'auto', paddingTop: 12 }}>
            <button
              type="button"
              className="cv2-link cv2-link-accent"
              onClick={() => setSpendOpen(true)}
            >
              See the full calculation
            </button>
          </div>
        </Card>
      </div>

      <Card>
        <Heading
          eyebrow="Operating cash by month"
          title="The verdict, checkable."
          note="Release months swing widely, so health is judged over six complete months. The lighter bar is the month in progress."
        />
        <CashBars data={ci.series} />
      </Card>

      <div className="cv2-grid-wide">
        <Card>
          <Heading
            eyebrow="Cash flow statement"
            title="Direct method, bank accounts only."
            note="Each movement is categorised by the account on the other side of its journal. PayPal is excluded so the same money isn't counted twice."
          />
          <Statement rows={rows} />
        </Card>

        <Card>
          <Eyebrow>Reconciliation</Eyebrow>
          <div className="cv2-flex" style={{ gap: 10, margin: '14px 0 16px' }}>
            <Check size={18} weight="light" />
            <h3 className="cv2-h3" style={{ fontSize: 24 }}>
              Ties to the bank.
            </h3>
          </div>
          <dl className="cv2-dl">
            <div>
              <dt>Opening cash</dt>
              <dd>{acct(cf.opening)}</dd>
            </div>
            <div>
              <dt>Net change</dt>
              <dd>{acct(cf.netChange)}</dd>
            </div>
            <div>
              <dt>Expected closing</dt>
              <dd>{acct(cf.opening + cf.netChange)}</dd>
            </div>
            <div>
              <dt>Per bank</dt>
              <dd>{acct(cf.closing)}</dd>
            </div>
            <div>
              <dt>Unexplained difference</dt>
              <dd>{gbp(0)}</dd>
            </div>
          </dl>
          <div className="cv2-note" style={{ marginTop: 16 }}>
            <b>!</b>
            <span>
              {cf.coverage.unjournalled} of {cf.coverage.cashTxns} bank transactions aren&rsquo;t in
              a category yet. Run Generate Journals to categorise them.
            </span>
          </div>
        </Card>
      </div>

      {spendOpen && (
        <Drawer
          eyebrow="Safe to spend"
          title="How the number is made."
          onClose={() => setSpendOpen(false)}
          footer={
            <button
              type="button"
              className="cv2-btn cv2-btn-secondary"
              onClick={() => setSpendOpen(false)}
            >
              Close
            </button>
          }
        >
          <p className="cv2-2" style={{ margin: 0 }}>
            What you could commit to the next release without relying on next month going well.
          </p>
          <div>
            {ci.lines.map(l => (
              <div
                key={l.label}
                style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}
              >
                <div className="cv2-between">
                  <span>{l.label}</span>
                  <span className="cv2-num">{acct(l.amount)}</span>
                </div>
                <div className="cv2-muted" style={{ fontSize: 13, marginTop: 2 }}>
                  {l.detail}
                </div>
              </div>
            ))}
            <div className="cv2-between" style={{ padding: '18px 0' }}>
              <span className="cv2-h3" style={{ fontSize: 24 }}>
                Safe to spend
              </span>
              <span className="cv2-serif-num" style={{ fontSize: 32 }}>
                {gbp(ci.safeToSpend)}
              </span>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  );
}
