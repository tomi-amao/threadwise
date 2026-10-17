/**
 * Inventory v2 — design-language preview.
 *
 * Frontend-only redesign of /inventory following docs/design-language.md.
 * No loader/action: it runs on local mock data (edits reset on reload), so the
 * original /inventory page and its backend wiring stay untouched.
 */

import React, { useState } from 'react';
import type { LinksFunction, MetaFunction } from 'react-router';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Eyebrow, gbp, int, pct } from '~/components/dashboard-v2/ui-shared';
import { ThemeToggle, useCv2Theme } from '~/components/collections-v2/theme';
import {
  SEED_ITEMS,
  generateMovements,
  summary,
  type Item,
  type Movement,
} from '~/components/inventory-v2/data';
import { ItemDrawer, StockDrawer } from '~/components/inventory-v2/drawers';
import {
  ItemsTab,
  MovementsTab,
  StockTab,
  ValuationTab,
  type ItemFilter,
  type StockFilter,
} from '~/components/inventory-v2/tabs';
import '~/components/collections-v2/collections-v2.css';
import '~/components/reports-v2/reports-v2.css';

export const meta: MetaFunction = () => [
  { title: 'Inventory (new design) - ThreadWise' },
  { name: 'description', content: 'Design-language preview of the Inventory page' },
];

export const links: LinksFunction = () => [
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400&display=swap',
  },
];

const TABS = [
  { id: 'stock', label: 'Stock' },
  { id: 'items', label: 'Items' },
  { id: 'movements', label: 'Movements' },
  { id: 'valuation', label: 'Valuation' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function InventoryV2() {
  const [dark, setDark] = useCv2Theme();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<Item[]>(SEED_ITEMS);
  const [movements, setMovements] = useState<Movement[]>(() => generateMovements(SEED_ITEMS));
  const [stockFilter, setStockFilter] = useState<StockFilter>('all');
  const [itemFilter, setItemFilter] = useState<ItemFilter>('all');
  const [stockOpen, setStockOpen] = useState<string | null>(null);
  const [itemOpen, setItemOpen] = useState<string | null>(null);

  const rawTab = params.get('tab') as TabId | null;
  const tab: TabId = TABS.some(t => t.id === rawTab) ? (rawTab as TabId) : 'stock';
  const goTab = (t: TabId) => setParams({ tab: t }, { replace: true });

  const s = summary(items);
  const attention = s.oversold + s.low + s.unlinked + s.uncosted;

  const flags: { key: string; count: number; label: string; neg?: boolean; go: () => void }[] = [
    {
      key: 'over',
      count: s.oversold,
      label: 'oversold',
      neg: true,
      go: () => {
        setStockFilter('oversold');
        goTab('stock');
      },
    },
    {
      key: 'low',
      count: s.low,
      label: 'low on stock',
      go: () => {
        setStockFilter('low');
        goTab('stock');
      },
    },
    {
      key: 'out',
      count: s.out,
      label: 'sold out',
      go: () => {
        setStockFilter('out');
        goTab('stock');
      },
    },
    {
      key: 'unlinked',
      count: s.unlinked,
      label: 'not linked to a product',
      go: () => {
        setItemFilter('unlinked');
        goTab('items');
      },
    },
    {
      key: 'uncosted',
      count: s.uncosted,
      label: 'without a unit cost',
      go: () => {
        setItemFilter('uncosted');
        goTab('items');
      },
    },
  ].filter(f => f.count > 0);

  const patchItem = (id: string, patch: Partial<Item>) =>
    setItems(cur => cur.map(i => (i.id === id ? { ...i, ...patch } : i)));

  const stockItem = items.find(i => i.id === stockOpen) ?? null;
  const editItem = items.find(i => i.id === itemOpen) ?? null;

  return (
    <div className="cv2" data-theme={dark ? 'dark' : 'light'}>
      <div className="cv2-glow" aria-hidden />

      <div className="cv2-wrap" style={{ paddingTop: 20 }}>
        <div className="cv2-between">
          <span className="cv2-chip cv2-chip-active cv2-chip-plain">
            Preview · new design · mock data
          </span>
          <ThemeToggle dark={dark} onChange={setDark} />
        </div>
      </div>

      <header className="cv2-wrap cv2-rise" style={{ paddingTop: 64, paddingBottom: 48 }}>
        <Eyebrow>
          Inventory · {items.length} items · {s.products} products
        </Eyebrow>
        <h1 className="cv2-h1" style={{ marginTop: 20, maxWidth: 820 }}>
          What&rsquo;s on the shelf, <em>and what it cost.</em>
        </h1>
        <p className="cv2-lead" style={{ marginTop: 24 }}>
          {int(s.unitsOnHand)} sellable units worth {gbp(s.stockValue)} at cost, from{' '}
          {gbp(s.invested)} invested to date.
        </p>
      </header>

      <section className="cv2-wrap cv2-rise" style={{ animationDelay: '60ms' }}>
        <div className="cv2-stats">
          <div className="cv2-stat">
            <Eyebrow>Stock value</Eyebrow>
            <div className="cv2-stat-value">{gbp(s.stockValue)}</div>
            <div className="cv2-stat-label">On hand, at cost</div>
            <div className="cv2-stat-cap">{gbp(s.invested)} invested overall</div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Units on hand</Eyebrow>
            <div className="cv2-stat-value">{int(s.unitsOnHand)}</div>
            <div className="cv2-stat-label">Sellable</div>
            <div className="cv2-stat-cap">of {int(s.unitsPurchased)} ever purchased</div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Needs attention</Eyebrow>
            <div className={`cv2-stat-value ${s.oversold ? 'cv2-neg' : ''}`}>{attention}</div>
            <div className="cv2-stat-label">Items to look at</div>
            <div className="cv2-stat-cap">{attention ? 'Listed below' : 'All clear'}</div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Cost coverage</Eyebrow>
            <div className="cv2-stat-value">{pct(s.costCoverage, 0)}</div>
            <div className="cv2-stat-label">Items with a unit cost</div>
            <div className="cv2-stat-cap">{s.uncosted} still to cost</div>
          </div>
        </div>

        {flags.length > 0 && (
          <div className="cv2-flex" style={{ gap: 10, flexWrap: 'wrap', marginTop: 20 }}>
            <Eyebrow>Jump to</Eyebrow>
            {flags.map(f => (
              <button
                key={f.key}
                type="button"
                className={`cv2-flag ${f.neg ? 'cv2-flag-neg' : ''}`}
                onClick={f.go}
              >
                <b>{f.count}</b> {f.label}
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="cv2-wrap" style={{ marginTop: 72 }}>
        <div className="cv2-tabs" role="tablist">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="cv2-tab"
              aria-selected={tab === t.id}
              onClick={() => goTab(t.id)}
            >
              {t.label}
              {t.id === 'items' && <small>{String(items.length).padStart(2, '0')}</small>}
              {t.id === 'movements' && <small>{movements.length}</small>}
            </button>
          ))}
        </div>
      </div>

      <main className="cv2-wrap cv2-rise" key={tab} style={{ paddingTop: 40, paddingBottom: 112 }}>
        {tab === 'stock' && (
          <StockTab
            items={items}
            filter={stockFilter}
            onFilter={setStockFilter}
            onOpen={i => setStockOpen(i.id)}
          />
        )}
        {tab === 'items' && (
          <ItemsTab
            items={items}
            filter={itemFilter}
            onFilter={setItemFilter}
            onOpen={i => setItemOpen(i.id)}
          />
        )}
        {tab === 'movements' && <MovementsTab movements={movements} items={items} />}
        {tab === 'valuation' && <ValuationTab items={items} />}
      </main>

      {stockItem && (
        <StockDrawer
          item={stockItem}
          onClose={() => setStockOpen(null)}
          onRecord={(kind, qty) => {
            patchItem(
              stockItem.id,
              kind === 'gift'
                ? { gifted: stockItem.gifted + qty }
                : { writtenOff: stockItem.writtenOff + qty }
            );
            setMovements(cur => [
              {
                id: `new-${Date.now()}`,
                itemId: stockItem.id,
                type: kind === 'gift' ? 'GIFT' : 'WRITE_OFF',
                quantity: -qty,
                unitCost: stockItem.unitCost,
                reference: null,
                notes: kind === 'gift' ? 'Gifted' : 'Written off',
                date: new Date().toISOString(),
              },
              ...cur,
            ]);
            toast.success(`${qty} ${kind === 'gift' ? 'gifted' : 'written off'}`);
          }}
        />
      )}
      {editItem && (
        <ItemDrawer
          key={editItem.id}
          item={editItem}
          all={items}
          onClose={() => setItemOpen(null)}
          onSave={patch => {
            patchItem(editItem.id, patch);
            setItemOpen(null);
            toast.success('Item updated');
          }}
        />
      )}
    </div>
  );
}
