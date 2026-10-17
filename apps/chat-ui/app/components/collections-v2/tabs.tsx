import React, { useState } from 'react';
import { Plus, Trash } from 'phosphor-react';
import {
  COLLAB_LABEL,
  SCENARIOS,
  costByCategory,
  projectPlan,
  stats,
  sum,
  type Collab,
  type Collection,
  type Plan,
  type ScenarioId,
} from './data';
import { Eyebrow, Meter, RAMP, Segmented, fmtDate, gbp, int, pct } from './ui';

/* ── Overview ────────────────────────────────────────── */

function WeeklyChart({ data }: { data: number[] }) {
  if (data.length === 0) {
    return (
      <p className="cv2-2" style={{ padding: '48px 0', textAlign: 'center' }}>
        No sales yet. Bars appear here once linked products start selling.
      </p>
    );
  }
  const max = Math.max(...data);
  const W = 560;
  const H = 180;
  const gap = 10;
  const bw = (W - gap * (data.length - 1)) / data.length;
  return (
    <svg
      viewBox={`0 0 ${W} ${H + 24}`}
      width="100%"
      role="img"
      aria-label="Weekly revenue"
      className="cv2-bar-col"
    >
      {[0.5, 1].map(f => (
        <line
          key={f}
          x1={0}
          x2={W}
          y1={H - f * H}
          y2={H - f * H}
          stroke="var(--border)"
          strokeDasharray="2 4"
        />
      ))}
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * (H - 8));
        const x = i * (bw + gap);
        return (
          <g key={i}>
            <rect
              x={x}
              y={H - h}
              width={bw}
              height={h}
              rx={4}
              fill={i === data.indexOf(max) ? 'var(--ramp-1)' : 'var(--ramp-3)'}
            >
              <title>{`Week ${i + 1}: ${gbp(v)}`}</title>
            </rect>
            <text
              x={x + bw / 2}
              y={H + 18}
              textAnchor="middle"
              fontSize="11"
              fontFamily="var(--font-mono)"
              fill="var(--text-muted)"
            >
              W{i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function OverviewTab({ c }: { c: Collection }) {
  const s = stats(c);
  const cats = costByCategory(c.costs);
  const ranked = [...c.products]
    .map(p => ({ ...p, revenue: p.units * p.price }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 3);
  const over = s.budgetUsed != null && s.budgetUsed > 1;

  return (
    <div style={{ display: 'grid', gap: 32 }}>
      <div className="cv2-stats">
        <div className="cv2-stat">
          <Eyebrow>Revenue</Eyebrow>
          <div className="cv2-stat-value">{gbp(s.revenue)}</div>
          <div className="cv2-stat-label">From linked products</div>
          <div className="cv2-stat-cap">
            {int(s.units)} units · {int(s.orders)} orders
          </div>
        </div>
        <div className="cv2-stat">
          <Eyebrow>Costs</Eyebrow>
          <div className="cv2-stat-value">{gbp(s.cost)}</div>
          <div className="cv2-stat-label">Linked transactions</div>
          <div className="cv2-stat-cap">{c.costs.length} on record</div>
        </div>
        <div className="cv2-stat">
          <Eyebrow>Gross profit</Eyebrow>
          <div className={`cv2-stat-value ${s.profit < 0 ? 'cv2-neg' : ''}`}>{gbp(s.profit)}</div>
          <div className="cv2-stat-label">Revenue less costs</div>
          <div className="cv2-stat-cap">
            {s.units ? `${gbp(s.profit / s.units, 2)} per unit` : 'No units sold'}
          </div>
        </div>
        <div className="cv2-stat">
          <Eyebrow>Margin</Eyebrow>
          <div className={`cv2-stat-value ${s.margin != null && s.margin < 0 ? 'cv2-neg' : ''}`}>
            {pct(s.margin)}
          </div>
          <div className="cv2-stat-label">Gross margin</div>
          <div className="cv2-stat-cap">
            {s.margin == null
              ? 'Needs revenue'
              : s.margin < 0
                ? 'Spend exceeded sales'
                : 'After linked costs'}
          </div>
        </div>
      </div>

      <div className="cv2-grid-2">
        <section className="cv2-card cv2-card-pad">
          <Eyebrow>Weekly revenue</Eyebrow>
          <h3 className="cv2-h3" style={{ fontSize: 24, margin: '8px 0 20px' }}>
            {c.weekly.length ? `${c.weekly.length} weeks since launch.` : 'Waiting on launch.'}
          </h3>
          <WeeklyChart data={c.weekly} />
        </section>

        <section
          className="cv2-card cv2-card-pad"
          style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
        >
          <div>
            <Eyebrow>Budget</Eyebrow>
            {c.budget ? (
              <>
                <div
                  className="cv2-serif-num"
                  style={{ fontSize: 40, marginTop: 8, lineHeight: 1.05 }}
                >
                  {gbp(Math.abs(c.budget - s.cost))}
                  <span
                    className="cv2-2"
                    style={{
                      fontSize: 15,
                      fontFamily: 'var(--font-sans)',
                      letterSpacing: 0,
                      marginLeft: 10,
                    }}
                  >
                    {over ? 'over budget' : 'remaining'}
                  </span>
                </div>
                <div style={{ margin: '16px 0 8px' }}>
                  <Meter value={s.budgetUsed ?? 0} over={over} />
                </div>
                <div className="cv2-mono cv2-muted" style={{ fontSize: 12 }}>
                  {gbp(s.cost)} OF {gbp(c.budget)} · {pct((s.budgetUsed ?? 0) * 100, 0)} USED
                </div>
              </>
            ) : (
              <p className="cv2-2" style={{ marginTop: 8 }}>
                No budget set. Costs are still tracked below.
              </p>
            )}
          </div>

          <hr className="cv2-rule" />

          <div>
            <Eyebrow>Where the money went</Eyebrow>
            {cats.length === 0 ? (
              <p className="cv2-2" style={{ marginTop: 8 }}>
                No costs linked yet.
              </p>
            ) : (
              <>
                <div className="cv2-stack" style={{ margin: '14px 0' }}>
                  {cats.map((x, i) => (
                    <span
                      key={x.category}
                      style={{ flexGrow: x.amount, background: RAMP[i % RAMP.length] }}
                      title={`${x.category}: ${gbp(x.amount)}`}
                    />
                  ))}
                </div>
                <div className="cv2-legend">
                  {cats.slice(0, 4).map((x, i) => (
                    <span key={x.category}>
                      <i style={{ background: RAMP[i % RAMP.length] }} />
                      {x.category}{' '}
                      <span className="cv2-mono cv2-num">{pct((x.amount / s.cost) * 100, 0)}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      </div>

      <section>
        <Eyebrow>Best sellers</Eyebrow>
        {ranked.length === 0 ? (
          <p className="cv2-2" style={{ marginTop: 12 }}>
            Link products to see what is carrying the collection.
          </p>
        ) : (
          <div className="cv2-grid-3" style={{ marginTop: 16 }}>
            {ranked.map((p, i) => (
              <div
                key={p.id}
                style={{ borderTop: '1px solid var(--border-strong)', paddingTop: 16 }}
              >
                <div className="cv2-step">0{i + 1}</div>
                <h3 className="cv2-h3" style={{ fontSize: 24, margin: '8px 0' }}>
                  {p.name}.
                </h3>
                <p className="cv2-2" style={{ margin: 0, fontSize: 15 }}>
                  {gbp(p.revenue)} from {int(p.units)} units,{' '}
                  {pct((p.revenue / s.revenue) * 100, 0)} of collection revenue.
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ── Plan ────────────────────────────────────────────── */

export function PlanTab({
  c,
  onChange,
  onCreate,
  onAddLine,
}: {
  c: Collection;
  onChange: (plan: Plan) => void;
  onCreate: () => void;
  onAddLine: () => void;
}) {
  const [scenario, setScenario] = useState<ScenarioId>('expected');
  const plan = c.plan;

  if (!plan) {
    return (
      <div className="cv2-card cv2-card-pad" style={{ padding: '72px 24px', textAlign: 'center' }}>
        <Eyebrow>No plan yet</Eyebrow>
        <h3 className="cv2-h3" style={{ margin: '12px auto 12px', maxWidth: 420 }}>
          Model it before you make it.
        </h3>
        <p className="cv2-2" style={{ maxWidth: 440, margin: '0 auto 24px' }}>
          Add planned quantities, unit costs and sell-through to see projected profit under three
          scenarios.
        </p>
        <button type="button" className="cv2-btn cv2-btn-primary" onClick={onCreate}>
          Start a plan
        </button>
      </div>
    );
  }

  const proj = projectPlan(plan, scenario);
  const setLine = (id: string, patch: Partial<Plan['lines'][number]>) =>
    onChange({ ...plan, lines: plan.lines.map(l => (l.id === id ? { ...l, ...patch } : l)) });

  return (
    <div style={{ display: 'grid', gap: 32 }}>
      {/* Terms + scenario on a single quiet row */}
      <div className="cv2-between" style={{ flexWrap: 'wrap', gap: 20 }}>
        <div className="cv2-flex" style={{ gap: 16, flexWrap: 'wrap' }}>
          <Segmented<Collab>
            label="Collaboration type"
            value={plan.collab}
            onChange={collab =>
              onChange({
                ...plan,
                collab,
                sharePct: collab === 'in_house' ? 0 : plan.sharePct || 30,
              })
            }
            options={(Object.keys(COLLAB_LABEL) as Collab[]).map(k => ({
              value: k,
              label: COLLAB_LABEL[k],
            }))}
          />
          {plan.collab !== 'in_house' && (
            <>
              <input
                className="cv2-input"
                style={{ width: 200, borderRadius: 9999 }}
                placeholder="Partner name"
                value={plan.partner}
                onChange={e => onChange({ ...plan, partner: e.target.value })}
                aria-label="Partner name"
              />
              <label className="cv2-flex cv2-2" style={{ gap: 8, fontSize: 14 }}>
                Share
                <input
                  className="cv2-input cv2-input-sm"
                  style={{ width: 72 }}
                  type="number"
                  min={0}
                  max={100}
                  value={plan.sharePct}
                  onChange={e => onChange({ ...plan, sharePct: Number(e.target.value) })}
                />
                % of profit
              </label>
            </>
          )}
        </div>
        <Segmented<ScenarioId>
          label="Scenario"
          value={scenario}
          onChange={setScenario}
          options={SCENARIOS.map(s => ({ value: s.id, label: s.label }))}
        />
      </div>

      <div
        className="cv2-stats"
        style={{ gridTemplateColumns: `repeat(${plan.collab === 'in_house' ? 4 : 5}, 1fr)` }}
      >
        <div className="cv2-stat">
          <Eyebrow>Projected revenue</Eyebrow>
          <div className="cv2-stat-value">{gbp(proj.revenue)}</div>
          <div className="cv2-stat-cap">
            {SCENARIOS.find(s => s.id === scenario)!.label.toLowerCase()} sell-through
          </div>
        </div>
        <div className="cv2-stat">
          <Eyebrow>Goods cost</Eyebrow>
          <div className="cv2-stat-value">{gbp(proj.cogs)}</div>
          <div className="cv2-stat-cap">{int(sum(plan.lines.map(l => l.qty)))} units bought</div>
        </div>
        <div className="cv2-stat">
          <Eyebrow>Other costs</Eyebrow>
          <div className="cv2-stat-value">{gbp(proj.other)}</div>
          <div className="cv2-stat-cap">
            {proj.tbd ? `${proj.tbd} still to be determined` : 'All amounts known'}
          </div>
        </div>
        {plan.collab !== 'in_house' && (
          <div className="cv2-stat">
            <Eyebrow>{plan.partner || 'Partner'} payout</Eyebrow>
            <div className="cv2-stat-value">{gbp(proj.payout)}</div>
            <div className="cv2-stat-cap">{plan.sharePct}% of projected profit</div>
          </div>
        )}
        <div className="cv2-stat">
          <Eyebrow>Net profit</Eyebrow>
          <div className={`cv2-stat-value ${proj.net < 0 ? 'cv2-neg' : ''}`}>{gbp(proj.net)}</div>
          <div className="cv2-stat-cap">{pct(proj.margin)} margin</div>
        </div>
      </div>

      <section className="cv2-card" style={{ overflow: 'hidden' }}>
        <div className="cv2-between" style={{ padding: '20px 24px 8px' }}>
          <div>
            <Eyebrow>Planned range</Eyebrow>
            <h3 className="cv2-h3" style={{ fontSize: 24, marginTop: 6 }}>
              {plan.lines.length} products.
            </h3>
          </div>
          <button
            type="button"
            className="cv2-btn cv2-btn-secondary cv2-btn-sm"
            onClick={onAddLine}
          >
            <Plus size={14} /> Add line
          </button>
        </div>
        <div className="cv2-scroll">
          <table className="cv2-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="r">Qty</th>
                <th className="r">Unit cost</th>
                <th className="r">Price</th>
                <th style={{ minWidth: 190 }}>Sell-through</th>
                <th className="r">Revenue</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {proj.lines.map(l => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td className="r">
                    <input
                      className="cv2-input cv2-input-sm"
                      style={{ width: 80 }}
                      type="number"
                      min={0}
                      value={l.qty}
                      onChange={e => setLine(l.id, { qty: Number(e.target.value) })}
                      aria-label={`${l.name} quantity`}
                    />
                  </td>
                  <td className="r cv2-mono cv2-num cv2-2">{gbp(l.unitCost, 2)}</td>
                  <td className="r cv2-mono cv2-num cv2-2">{gbp(l.price, 2)}</td>
                  <td>
                    <div className="cv2-flex" style={{ gap: 12 }}>
                      <input
                        className="cv2-range"
                        type="range"
                        min={0}
                        max={100}
                        value={plan.lines.find(x => x.id === l.id)!.sellThrough}
                        onChange={e => setLine(l.id, { sellThrough: Number(e.target.value) })}
                        aria-label={`${l.name} sell-through`}
                      />
                      <span className="cv2-mono cv2-num" style={{ width: 44, fontSize: 13 }}>
                        {Math.round(l.effectiveSellThrough)}%
                      </span>
                    </div>
                  </td>
                  <td className="r cv2-num">{gbp(l.revenue)}</td>
                  <td className="r">
                    <button
                      type="button"
                      className="cv2-icon-btn"
                      aria-label={`Remove ${l.name}`}
                      onClick={() =>
                        onChange({ ...plan, lines: plan.lines.filter(x => x.id !== l.id) })
                      }
                    >
                      <Trash size={16} weight="light" />
                    </button>
                  </td>
                </tr>
              ))}
              {plan.lines.length === 0 && (
                <tr>
                  <td colSpan={7} className="cv2-2" style={{ textAlign: 'center', padding: 40 }}>
                    No lines yet. Add a product to start modelling.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cv2-card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px 8px' }}>
          <Eyebrow>Other planned costs</Eyebrow>
          <h3 className="cv2-h3" style={{ fontSize: 24, marginTop: 6 }}>
            Disclosed upfront, priced when known.
          </h3>
        </div>
        <table className="cv2-table">
          <tbody>
            {plan.costs.map(pc => (
              <tr key={pc.id}>
                <td>{pc.category}</td>
                <td className="r">
                  {pc.amount == null ? (
                    <span className="cv2-chip cv2-chip-tbd">to be determined</span>
                  ) : null}
                </td>
                <td className="r" style={{ width: 140 }}>
                  <input
                    className="cv2-input cv2-input-sm"
                    type="number"
                    min={0}
                    placeholder="TBD"
                    value={pc.amount ?? ''}
                    onChange={e =>
                      onChange({
                        ...plan,
                        costs: plan.costs.map(x =>
                          x.id === pc.id
                            ? {
                                ...x,
                                amount: e.target.value === '' ? null : Number(e.target.value),
                              }
                            : x
                        ),
                      })
                    }
                    aria-label={`${pc.category} amount`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/* ── Products ────────────────────────────────────────── */

export function ProductsTab({ c, onRemove }: { c: Collection; onRemove: (id: string) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const total = sum(c.products.map(p => p.units * p.price));

  if (c.products.length === 0) {
    return (
      <div className="cv2-card" style={{ padding: '72px 24px', textAlign: 'center' }}>
        <Eyebrow>No products linked</Eyebrow>
        <h3 className="cv2-h3" style={{ margin: '12px 0' }}>
          Nothing in this collection yet.
        </h3>
        <p className="cv2-2" style={{ margin: 0 }}>
          Use “Add product” to attach items from your catalogue.
        </p>
      </div>
    );
  }

  return (
    <div className="cv2-card cv2-scroll">
      <table className="cv2-table">
        <thead>
          <tr>
            <th>Product</th>
            <th className="r">Units</th>
            <th className="r">Revenue</th>
            <th style={{ minWidth: 160 }}>Share</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {c.products.map(p => {
            const rev = p.units * p.price;
            return (
              <tr key={p.id}>
                <td>
                  <div className="cv2-flex" style={{ gap: 14 }}>
                    <span className="cv2-mono-mark">{p.name[0]}</span>
                    <div>
                      <div>{p.name}</div>
                      <div className="cv2-mono cv2-muted" style={{ fontSize: 12 }}>
                        {p.sku} · {gbp(p.price, 2)}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="r cv2-num">{int(p.units)}</td>
                <td className="r cv2-num">{gbp(rev)}</td>
                <td>
                  <div className="cv2-flex" style={{ gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <Meter value={total ? rev / total : 0} />
                    </div>
                    <span className="cv2-mono cv2-num cv2-2" style={{ fontSize: 13, width: 40 }}>
                      {pct(total ? (rev / total) * 100 : 0, 0)}
                    </span>
                  </div>
                </td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  {confirm === p.id ? (
                    <span className="cv2-flex" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="cv2-link cv2-link-accent"
                        onClick={() => {
                          onRemove(p.id);
                          setConfirm(null);
                        }}
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        className="cv2-link cv2-muted"
                        onClick={() => setConfirm(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="cv2-icon-btn"
                      aria-label={`Remove ${p.name}`}
                      onClick={() => setConfirm(p.id)}
                    >
                      <Trash size={16} weight="light" />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Costs ───────────────────────────────────────────── */

export function CostsTab({ c, onRemove }: { c: Collection; onRemove: (id: string) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const cats = costByCategory(c.costs);
  const total = sum(c.costs.map(x => x.amount));

  if (c.costs.length === 0) {
    return (
      <div className="cv2-card" style={{ padding: '72px 24px', textAlign: 'center' }}>
        <Eyebrow>No costs linked</Eyebrow>
        <h3 className="cv2-h3" style={{ margin: '12px 0' }}>
          No spend attributed yet.
        </h3>
        <p className="cv2-2" style={{ margin: 0 }}>
          Use “Add cost” to link an existing transaction.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <section className="cv2-card cv2-card-pad">
        <div className="cv2-between" style={{ marginBottom: 16, alignItems: 'baseline' }}>
          <Eyebrow>By category</Eyebrow>
          <span className="cv2-serif-num" style={{ fontSize: 28 }}>
            {gbp(total)}
          </span>
        </div>
        <div className="cv2-stack">
          {cats.map((x, i) => (
            <span
              key={x.category}
              style={{ flexGrow: x.amount, background: RAMP[i % RAMP.length] }}
              title={`${x.category}: ${gbp(x.amount)}`}
            />
          ))}
        </div>
        <div className="cv2-legend" style={{ marginTop: 16 }}>
          {cats.map((x, i) => (
            <span key={x.category}>
              <i style={{ background: RAMP[i % RAMP.length] }} />
              {x.category} <span className="cv2-mono cv2-num">{gbp(x.amount)}</span>
            </span>
          ))}
        </div>
      </section>

      <div className="cv2-card cv2-scroll">
        <table className="cv2-table">
          <thead>
            <tr>
              <th>Transaction</th>
              <th>Category</th>
              <th>Date</th>
              <th className="r">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {c.costs.map(x => (
              <tr key={x.id}>
                <td>
                  <div>{x.vendor}</div>
                  {x.note && (
                    <div className="cv2-muted" style={{ fontSize: 13 }}>
                      {x.note}
                    </div>
                  )}
                </td>
                <td>
                  <span className="cv2-chip cv2-chip-plain">{x.category}</span>
                </td>
                <td className="cv2-mono cv2-2" style={{ fontSize: 13 }}>
                  {fmtDate(x.date)}
                </td>
                <td className="r cv2-num">{gbp(x.amount)}</td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  {confirm === x.id ? (
                    <span className="cv2-flex" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="cv2-link cv2-link-accent"
                        onClick={() => {
                          onRemove(x.id);
                          setConfirm(null);
                        }}
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        className="cv2-link cv2-muted"
                        onClick={() => setConfirm(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="cv2-icon-btn"
                      aria-label={`Remove ${x.vendor}`}
                      onClick={() => setConfirm(x.id)}
                    >
                      <Trash size={16} weight="light" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
