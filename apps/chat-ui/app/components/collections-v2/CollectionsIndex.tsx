import React, { useMemo, useState } from 'react';
import { ArrowRight, MagnifyingGlass, Plus } from 'phosphor-react';
import { stats, sum, type Collection, type Status } from './data';
import { Eyebrow, Meter, Segmented, Sparkline, StatusChip, fmtDate, gbp, int, pct } from './ui';

type Filter = 'all' | Status;
type Sort = 'recent' | 'revenue' | 'margin';

export function CollectionsIndex({
  collections,
  onOpen,
  onCreate,
}: {
  collections: Collection[];
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');

  const totals = useMemo(() => {
    const all = collections.map(stats);
    const revenue = sum(all.map(s => s.revenue));
    const cost = sum(all.map(s => s.cost));
    return {
      revenue,
      cost,
      profit: revenue - cost,
      margin: revenue > 0 ? ((revenue - cost) / revenue) * 100 : null,
      active: collections.filter(c => c.status === 'active').length,
      products: sum(collections.map(c => c.products.length)),
      costs: sum(collections.map(c => c.costs.length)),
    };
  }, [collections]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = collections
      .filter(c => filter === 'all' || c.status === filter)
      .filter(c => !q || [c.name, c.type, c.ref, c.status].join(' ').toLowerCase().includes(q))
      .map(c => ({ c, s: stats(c) }));
    if (sort === 'revenue') list.sort((a, b) => b.s.revenue - a.s.revenue);
    if (sort === 'margin') list.sort((a, b) => (b.s.margin ?? -999) - (a.s.margin ?? -999));
    return list;
  }, [collections, query, filter, sort]);

  const counts = (s: Status) => collections.filter(c => c.status === s).length;

  return (
    <>
      {/* Hero */}
      <header className="cv2-wrap cv2-rise" style={{ paddingTop: 72, paddingBottom: 56 }}>
        <Eyebrow>Collections · {collections.length} in total</Eyebrow>
        <div
          className="cv2-between"
          style={{ alignItems: 'flex-end', marginTop: 20, flexWrap: 'wrap', gap: 32 }}
        >
          <div style={{ maxWidth: 760 }}>
            <h1 className="cv2-h1">
              What each drop earned, <em>and what it cost.</em>
            </h1>
            <p className="cv2-lead" style={{ marginTop: 24 }}>
              Plan a collection, attach its products and spend, and see profit the moment sales
              land. One row each, nothing else on the page.
            </p>
          </div>
          <button type="button" className="cv2-btn cv2-btn-primary" onClick={onCreate}>
            <Plus size={16} weight="bold" />
            New collection
          </button>
        </div>
      </header>

      {/* Portfolio numbers */}
      <section className="cv2-wrap cv2-rise" style={{ animationDelay: '60ms' }}>
        <div className="cv2-stats">
          <div className="cv2-stat">
            <Eyebrow>Revenue</Eyebrow>
            <div className="cv2-stat-value">{gbp(totals.revenue)}</div>
            <div className="cv2-stat-label">Across all collections</div>
            <div className="cv2-stat-cap">
              {int(sum(collections.map(c => stats(c).units)))} units sold
            </div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Linked costs</Eyebrow>
            <div className="cv2-stat-value">{gbp(totals.cost)}</div>
            <div className="cv2-stat-label">Attributed spend</div>
            <div className="cv2-stat-cap">{totals.costs} transactions</div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Gross profit</Eyebrow>
            <div className={`cv2-stat-value ${totals.profit < 0 ? 'cv2-neg' : ''}`}>
              {gbp(totals.profit)}
            </div>
            <div className="cv2-stat-label">Revenue less costs</div>
            <div className="cv2-stat-cap">{pct(totals.margin)} blended margin</div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Live now</Eyebrow>
            <div className="cv2-stat-value">{totals.active}</div>
            <div className="cv2-stat-label">Active collections</div>
            <div className="cv2-stat-cap">{totals.products} products in range</div>
          </div>
        </div>
      </section>

      {/* List */}
      <section className="cv2-wrap" style={{ paddingTop: 80, paddingBottom: 112 }}>
        <div
          className="cv2-between"
          style={{ alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 28 }}
        >
          <div>
            <Eyebrow>All collections</Eyebrow>
            <h2 className="cv2-h2" style={{ marginTop: 12 }}>
              Pick one to <em>open it.</em>
            </h2>
          </div>
          <div
            className="cv2-flex"
            style={{ gap: 12, flexWrap: 'wrap', flex: 1, justifyContent: 'flex-end' }}
          >
            <div className="cv2-search">
              <MagnifyingGlass size={16} weight="light" />
              <input
                className="cv2-input"
                placeholder="Search by name, type or ref"
                value={query}
                onChange={e => setQuery(e.target.value)}
                aria-label="Search collections"
              />
            </div>
          </div>
        </div>

        <div className="cv2-between" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
          <Segmented<Filter>
            label="Filter by status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All ${collections.length}` },
              { value: 'active', label: `Active ${counts('active')}` },
              { value: 'planned', label: `Planned ${counts('planned')}` },
              { value: 'completed', label: `Completed ${counts('completed')}` },
              { value: 'draft', label: `Draft ${counts('draft')}` },
            ]}
          />
          <Segmented<Sort>
            label="Sort"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'recent', label: 'Recent' },
              { value: 'revenue', label: 'Revenue' },
              { value: 'margin', label: 'Margin' },
            ]}
          />
        </div>

        <div className="cv2-card" style={{ overflow: 'hidden' }}>
          <div className="cv2-list-head cv2-eyebrow">
            <span>Collection</span>
            <span>Status</span>
            <span className="cv2-col-r cv2-hide-md">Products</span>
            <span className="cv2-col-r">Revenue</span>
            <span className="cv2-col-r cv2-hide-md">Costs</span>
            <span className="cv2-hide-md">Trend</span>
            <span>Margin</span>
            <span />
          </div>

          {rows.length === 0 ? (
            <div style={{ padding: '64px 24px', textAlign: 'center' }}>
              <h3 className="cv2-h3" style={{ fontSize: 24 }}>
                Nothing matches that.
              </h3>
              <p className="cv2-2" style={{ margin: '8px 0 16px' }}>
                Try a different search, or clear the status filter.
              </p>
              <button
                type="button"
                className="cv2-btn cv2-btn-secondary cv2-btn-sm"
                onClick={() => {
                  setQuery('');
                  setFilter('all');
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            rows.map(({ c, s }) => (
              <button key={c.id} type="button" className="cv2-row" onClick={() => onOpen(c.id)}>
                <div style={{ minWidth: 0 }}>
                  <div className="cv2-name">{c.name}</div>
                  <div
                    className="cv2-mono cv2-muted"
                    style={{ fontSize: 12, marginTop: 4, letterSpacing: '0.04em' }}
                  >
                    {c.type.toUpperCase()} ·{' '}
                    {c.launchDate
                      ? `LAUNCH ${fmtDate(c.launchDate, true).toUpperCase()}`
                      : 'NO LAUNCH DATE'}
                  </div>
                </div>
                <div className="cv2-hide-sm">
                  <StatusChip status={c.status} />
                </div>
                <div className="cv2-col-r cv2-num cv2-hide-md cv2-2">
                  {c.products.length || '—'}
                </div>
                <div className="cv2-col-r cv2-num cv2-hide-sm">
                  {s.revenue ? gbp(s.revenue) : <span className="cv2-muted">—</span>}
                </div>
                <div className="cv2-col-r cv2-num cv2-hide-md cv2-2">
                  {s.cost ? gbp(s.cost) : <span className="cv2-muted">—</span>}
                </div>
                <div className="cv2-hide-md">
                  <Sparkline data={c.weekly} />
                </div>
                <div className="cv2-hide-sm">
                  {s.margin == null ? (
                    <span className="cv2-muted">—</span>
                  ) : (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <span
                        className={`cv2-mono cv2-num ${s.margin < 0 ? 'cv2-neg' : ''}`}
                        style={{ fontSize: 14 }}
                      >
                        {pct(s.margin)}
                      </span>
                      <Meter value={Math.max(s.margin, 0) / 100} over={s.margin < 0} />
                    </div>
                  )}
                </div>
                <ArrowRight className="cv2-row-arrow" size={16} weight="light" />
              </button>
            ))
          )}
        </div>
      </section>
    </>
  );
}
