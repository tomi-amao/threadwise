import React, { useState } from 'react';
import { ArrowLeft, DownloadSimple, Plus } from 'phosphor-react';
import { toast } from 'sonner';
import { stats, type Collection, type Plan } from './data';
import { AddCostDrawer, AddLineDrawer, AddProductDrawer } from './drawers';
import { CostsTab, OverviewTab, PlanTab, ProductsTab } from './tabs';
import { Eyebrow, StatusChip, fmtDate } from './ui';

export type TabId = 'overview' | 'plan' | 'products' | 'costs';

export function CollectionDetail({
  collection: c,
  tab,
  onTab,
  onBack,
  onUpdate,
}: {
  collection: Collection;
  tab: TabId;
  onTab: (t: TabId) => void;
  onBack: () => void;
  onUpdate: (fn: (c: Collection) => Collection) => void;
}) {
  const [drawer, setDrawer] = useState<null | 'product' | 'cost' | 'line'>(null);
  const s = stats(c);

  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'plan', label: 'Plan' },
    { id: 'products', label: 'Products', count: c.products.length },
    { id: 'costs', label: 'Costs', count: c.costs.length },
  ];

  // One amber action per view, and it always matches what the tab is for.
  const primary =
    tab === 'products'
      ? { label: 'Add product', run: () => setDrawer('product') }
      : tab === 'plan'
        ? c.plan
          ? { label: 'Add plan line', run: () => setDrawer('line') }
          : null
        : { label: 'Add cost', run: () => setDrawer('cost') };

  const defaultPlan = (): Plan => ({
    collab: 'in_house',
    partner: '',
    sharePct: 0,
    lines: [],
    costs: ['Freight in', 'Outbound shipping', 'Gifting'].map((category, i) => ({
      id: `pc-new-${i}`,
      category,
      amount: null,
    })),
  });

  return (
    <>
      <header className="cv2-wrap cv2-rise" style={{ paddingTop: 48, paddingBottom: 32 }}>
        <button
          type="button"
          className="cv2-link cv2-2"
          onClick={onBack}
          style={{ marginBottom: 32 }}
        >
          <ArrowLeft size={16} weight="light" /> All collections
        </button>

        <div className="cv2-between" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 24 }}>
          <div>
            <div className="cv2-flex" style={{ gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
              <StatusChip status={c.status} />
              <Eyebrow>
                {c.type}
                {c.ref ? ` · ${c.ref}` : ''}
              </Eyebrow>
            </div>
            <h1 className="cv2-h1" style={{ fontSize: 'clamp(36px, 4.6vw, 56px)' }}>
              {c.name}
            </h1>
            <p className="cv2-2" style={{ margin: '16px 0 0' }}>
              {c.launchDate ? `Launches ${fmtDate(c.launchDate)}` : 'No launch date set'} ·{' '}
              {c.products.length} products · {s.orders ? `${s.orders} orders` : 'no orders yet'}
            </p>
          </div>
          <div className="cv2-flex" style={{ gap: 12 }}>
            <button
              type="button"
              className="cv2-btn cv2-btn-secondary"
              onClick={() =>
                toast.info('Export is part of the live page — not wired in this preview.')
              }
            >
              <DownloadSimple size={16} weight="light" /> Export pack
            </button>
            {primary && (
              <button type="button" className="cv2-btn cv2-btn-primary" onClick={primary.run}>
                <Plus size={16} weight="bold" /> {primary.label}
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="cv2-wrap">
        <div className="cv2-tabs" role="tablist">
          {tabs.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="cv2-tab"
              aria-selected={tab === t.id}
              onClick={() => onTab(t.id)}
            >
              {t.label}
              {t.count != null && <small>{String(t.count).padStart(2, '0')}</small>}
            </button>
          ))}
        </div>
      </div>

      <main className="cv2-wrap cv2-rise" key={tab} style={{ paddingTop: 40, paddingBottom: 112 }}>
        {tab === 'overview' && <OverviewTab c={c} />}
        {tab === 'plan' && (
          <PlanTab
            c={c}
            onChange={plan => onUpdate(x => ({ ...x, plan }))}
            onCreate={() => {
              onUpdate(x => ({ ...x, plan: defaultPlan() }));
              toast.success('Plan started');
            }}
            onAddLine={() => setDrawer('line')}
          />
        )}
        {tab === 'products' && (
          <ProductsTab
            c={c}
            onRemove={id => {
              onUpdate(x => ({ ...x, products: x.products.filter(p => p.id !== id) }));
              toast.success('Product removed');
            }}
          />
        )}
        {tab === 'costs' && (
          <CostsTab
            c={c}
            onRemove={id => {
              onUpdate(x => ({ ...x, costs: x.costs.filter(k => k.id !== id) }));
              toast.success('Cost removed');
            }}
          />
        )}
      </main>

      {drawer === 'product' && (
        <AddProductDrawer
          existing={c.products}
          onClose={() => setDrawer(null)}
          onAdd={products => {
            onUpdate(x => ({ ...x, products: [...x.products, ...products] }));
            setDrawer(null);
            onTab('products');
            toast.success(`${products.length} added`);
          }}
        />
      )}
      {drawer === 'cost' && (
        <AddCostDrawer
          onClose={() => setDrawer(null)}
          onAdd={cost => {
            onUpdate(x => ({ ...x, costs: [cost, ...x.costs] }));
            setDrawer(null);
            toast.success('Cost added');
          }}
        />
      )}
      {drawer === 'line' && (
        <AddLineDrawer
          onClose={() => setDrawer(null)}
          onAdd={line => {
            onUpdate(x => ({
              ...x,
              plan: x.plan ? { ...x.plan, lines: [...x.plan.lines, line] } : x.plan,
            }));
            setDrawer(null);
            toast.success('Line added');
          }}
        />
      )}
    </>
  );
}
