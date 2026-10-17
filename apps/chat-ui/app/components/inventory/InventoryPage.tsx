/**
 * InventoryPage
 *
 * What is held, what it is worth, and what needs attention. Four tabs share one record per
 * item: Stock (on-hand and state), Items (cost, type, product link), Movements (the ledger of
 * stock in and out) and Valuation (what has been invested per SKU). Tab, filter, search and the
 * open item live in the URL.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowClockwise, ArrowLeft, ArrowRight, MagnifyingGlass, X } from 'phosphor-react';
import { useRevalidator } from 'react-router';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import { Input } from '~/components/ui/input';
import { JumpTo } from '~/components/ui/jump-to';
import { KpiTile } from '~/components/ui/kpi-tile';
import { CompactHeader } from '~/components/ui/page-header';
import { Segmented } from '~/components/ui/segmented';
import { Tabs, tabId } from '~/components/ui/tabs';
import type {
  InventoryItemRow,
  InventoryMovementsData,
  InventoryValuationItem,
  StockData,
} from '~/lib/api/inventory.server';
import { useUrlParams } from '~/lib/use-url-params';
import { cn } from '~/lib/utils';
import { ItemDrawer } from './ItemDrawer';
import {
  MOVEMENT_LABEL,
  MOVEMENT_TONE,
  STATE_LABEL,
  STATE_TONE,
  buildEntries,
  int,
  marginOf,
  money,
  shortDate,
  summarise,
  type InventoryEntry,
} from './model';

export interface InventoryPageData {
  allItems: InventoryItemRow[];
  products: { id: string; name: string }[];
  stock: StockData;
  movements: InventoryMovementsData;
  valuation: {
    items: InventoryValuationItem[];
    totalInventoryValue: number;
    totalUnitsPurchased: number;
  };
  errors: string[];
}

const TABS = [
  { id: 'stock', label: 'Stock' },
  { id: 'items', label: 'Items' },
  { id: 'movements', label: 'Movements' },
  { id: 'valuation', label: 'Valuation' },
] as const;
type TabKey = (typeof TABS)[number]['id'];

const PAGE_SIZE = 50;

const VIEWS: Record<TabKey, { value: string; label: string }[]> = {
  stock: [
    { value: 'all', label: 'All' },
    { value: 'oversold', label: 'Oversold' },
    { value: 'out', label: 'Out' },
    { value: 'low', label: 'Low' },
    { value: 'in', label: 'In stock' },
    { value: 'samples', label: 'Samples' },
  ],
  items: [
    { value: 'all', label: 'All' },
    { value: 'unlinked', label: 'Not linked' },
    { value: 'uncosted', label: 'No cost' },
    { value: 'samples', label: 'Samples' },
  ],
  movements: [
    { value: 'all', label: 'All' },
    { value: 'PURCHASE', label: 'Purchases' },
    { value: 'SALE', label: 'Sales' },
    { value: 'GIFT', label: 'Gifts' },
    { value: 'WRITE_OFF', label: 'Write-offs' },
  ],
  valuation: [],
};

const isTab = (v: string | null): v is TabKey => TABS.some(t => t.id === v);

function matches(entry: InventoryEntry, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    entry.name.toLowerCase().includes(needle) || (entry.sku ?? '').toLowerCase().includes(needle)
  );
}

const STATE_RANK = { oversold: 0, out: 1, low: 2, in: 3, unlimited: 4 } as const;
const stockRank = (e: InventoryEntry): number =>
  e.itemType !== 'sellable' ? 5 : e.state ? STATE_RANK[e.state] : 6;

function ItemCell({ entry, onOpen }: { entry: InventoryEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation();
        onOpen();
      }}
      className="block max-w-[320px] rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="block truncate">{entry.name}</span>
      <span className="block truncate font-mono text-xs text-text-2">{entry.sku ?? 'No SKU'}</span>
    </button>
  );
}

function StockTable({
  rows,
  onOpen,
  selected,
}: {
  rows: InventoryEntry[];
  onOpen: (id: string) => void;
  selected: string | null;
}) {
  return (
    <DataTable label="Stock levels" bare surface="page">
      <thead>
        <tr>
          <th>Item</th>
          <th>Status</th>
          <th className="text-right">On hand</th>
          <th className="hidden text-right md:table-cell">Sold</th>
          <th className="hidden text-right md:table-cell">Unit cost</th>
          <th className="text-right">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(e => (
          <tr
            key={e.id}
            onClick={() => onOpen(e.id)}
            aria-selected={e.id === selected || undefined}
            className={cn('cursor-pointer', e.id === selected && '[&_td]:bg-accent')}
          >
            <td>
              <ItemCell entry={e} onOpen={() => onOpen(e.id)} />
            </td>
            <td>
              {e.itemType !== 'sellable' ? (
                <Chip tone="planned">{e.itemType === 'sample' ? 'Sample' : 'Material'}</Chip>
              ) : e.state ? (
                <Chip tone={STATE_TONE[e.state]} dot>
                  {STATE_LABEL[e.state]}
                </Chip>
              ) : (
                <Chip tone="active" dot>
                  Not linked
                </Chip>
              )}
            </td>
            <td
              className={cn(
                'text-right tabular-nums',
                e.state === 'oversold' && 'text-destructive'
              )}
            >
              {e.isUnlimited ? '∞' : e.stock ? int(e.onHand) : '—'}
            </td>
            <td className="hidden text-right tabular-nums text-text-2 md:table-cell">
              {e.stock ? int(e.stock.unitsSold) : '—'}
            </td>
            <td className="hidden text-right tabular-nums text-text-2 md:table-cell">
              {e.costed ? money(e.unitCost, 2) : '—'}
            </td>
            <td className="text-right tabular-nums">{e.stock ? money(e.stockValue) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function ItemsTable({
  rows,
  onOpen,
  selected,
}: {
  rows: InventoryEntry[];
  onOpen: (id: string) => void;
  selected: string | null;
}) {
  return (
    <DataTable label="Inventory items" bare surface="page">
      <thead>
        <tr>
          <th>Item</th>
          <th>Type</th>
          <th className="text-right">Price</th>
          <th className="text-right">Unit cost</th>
          <th className="hidden text-right md:table-cell">Margin</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(e => {
          const margin = marginOf(e.sellingPrice, e.unitCost);
          return (
            <tr
              key={e.id}
              onClick={() => onOpen(e.id)}
              className={cn('cursor-pointer', e.id === selected && '[&_td]:bg-accent')}
            >
              <td>
                <ItemCell entry={e} onOpen={() => onOpen(e.id)} />
              </td>
              <td>
                {e.itemType === 'sellable' ? (
                  e.linked ? (
                    <Chip tone="done">Linked</Chip>
                  ) : (
                    <Chip tone="active" dot>
                      Not linked
                    </Chip>
                  )
                ) : (
                  <Chip tone="planned">{e.itemType === 'sample' ? 'Sample' : 'Material'}</Chip>
                )}
              </td>
              <td className="text-right tabular-nums">
                {e.sellingPrice ? money(e.sellingPrice, 2) : '—'}
              </td>
              <td className="text-right tabular-nums">
                {e.costed ? (
                  money(e.unitCost, 2)
                ) : e.isUnlimited ? (
                  '—'
                ) : (
                  <span className="text-accent-text">No cost</span>
                )}
              </td>
              <td className="hidden text-right tabular-nums text-text-2 md:table-cell">
                {margin == null ? '—' : `${margin.toFixed(0)}%`}
              </td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}

function Pager({
  page,
  pages,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (pages <= 1) return null;
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3"
    >
      <span className="font-mono text-xs tracking-[0.04em] text-muted-foreground">
        {int(from)}–{int(to)} OF {int(total)}
      </span>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ArrowLeft size={14} weight="light" aria-hidden /> Previous
        </Button>
        <span className="font-mono text-[13px] text-text-2">
          {page} / {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next <ArrowRight size={14} weight="light" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

export function InventoryPage({ data }: { data: InventoryPageData }) {
  const revalidator = useRevalidator();
  const [sp, apply] = useUrlParams();

  const rawTab = sp.get('tab');
  const tab: TabKey = isTab(rawTab) ? rawTab : 'stock';
  const view = sp.get('view') ?? 'all';
  const q = sp.get('q') ?? '';
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const selectedId = sp.get('item');

  const entries = useMemo(
    () => buildEntries(data.allItems, data.stock.items),
    [data.allItems, data.stock.items]
  );
  const summary = useMemo(() => summarise(entries), [entries]);
  const selected = entries.find(e => e.id === selectedId) ?? null;

  const setTab = (next: TabKey) =>
    apply(p => {
      p.set('tab', next);
      p.delete('view');
      p.delete('q');
      p.delete('page');
      return p;
    });
  const setView = useCallback(
    (next: string) =>
      apply(p => {
        if (next === 'all') p.delete('view');
        else p.set('view', next);
        p.delete('page');
        return p;
      }),
    [apply]
  );
  const setPage = (next: number) =>
    apply(p => {
      if (next <= 1) p.delete('page');
      else p.set('page', String(next));
      return p;
    });
  const openItem = (id: string | null) =>
    apply(p => {
      if (id) p.set('item', id);
      else p.delete('item');
      return p;
    });

  // Search: type freely, apply after a short pause.
  const [searchText, setSearchText] = useState(q);
  useEffect(() => setSearchText(q), [q]);
  useEffect(() => {
    if (searchText === q) return;
    const timer = setTimeout(
      () =>
        apply(p => {
          if (searchText.trim()) p.set('q', searchText.trim());
          else p.delete('q');
          p.delete('page');
          return p;
        }),
      300
    );
    return () => clearTimeout(timer);
  }, [searchText, q, apply]);

  // Rows for the current tab, filtered.
  const stockRows = useMemo(
    () =>
      entries
        .filter(e => {
          if (!e.stock) return false;
          if (!matches(e, q)) return false;
          if (view === 'samples') return e.itemType !== 'sellable';
          if (e.itemType !== 'sellable') return view === 'all';
          return view === 'all' || e.state === view;
        })
        // Problems first (oversold, out, low), then healthy stock, then samples; the name order
        // from buildEntries is kept within each group.
        .sort((a, b) => stockRank(a) - stockRank(b)),
    [entries, q, view]
  );
  const itemRows = useMemo(
    () =>
      entries.filter(e => {
        if (!matches(e, q)) return false;
        if (view === 'unlinked') return e.itemType === 'sellable' && !e.linked;
        if (view === 'uncosted') return e.itemType === 'sellable' && !e.costed && !e.isUnlimited;
        if (view === 'samples') return e.itemType !== 'sellable';
        return true;
      }),
    [entries, q, view]
  );
  const movementRows = useMemo(() => {
    const needle = q.toLowerCase();
    return data.movements.movements.filter(
      m =>
        (view === 'all' || m.transactionType === view) &&
        (!needle ||
          (m.productName ?? '').toLowerCase().includes(needle) ||
          (m.sku ?? '').toLowerCase().includes(needle) ||
          (m.reference ?? '').toLowerCase().includes(needle))
    );
  }, [data.movements.movements, q, view]);
  const valuationRows = useMemo(() => {
    const needle = q.toLowerCase();
    return data.valuation.items.filter(
      i =>
        !needle ||
        (i.productName ?? '').toLowerCase().includes(needle) ||
        (i.sku ?? '').toLowerCase().includes(needle)
    );
  }, [data.valuation.items, q]);

  const listLength =
    tab === 'stock'
      ? stockRows.length
      : tab === 'items'
        ? itemRows.length
        : tab === 'movements'
          ? movementRows.length
          : valuationRows.length;
  const pages = Math.max(1, Math.ceil(listLength / PAGE_SIZE));
  const current = Math.min(page, pages);
  const slice = <T,>(rows: T[]): T[] => rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const flags = [
    { key: 'oversold', count: summary.oversold, label: 'oversold', tab: 'stock', view: 'oversold' },
    { key: 'out', count: summary.out, label: 'out of stock', tab: 'stock', view: 'out' },
    { key: 'low', count: summary.low, label: 'low', tab: 'stock', view: 'low' },
    {
      key: 'unlinked',
      count: summary.unlinked,
      label: 'not linked',
      tab: 'items',
      view: 'unlinked',
    },
    {
      key: 'uncosted',
      count: summary.uncosted,
      label: 'without a cost',
      tab: 'items',
      view: 'uncosted',
    },
  ].filter(f => f.count > 0);

  const jump = (f: (typeof flags)[number]) =>
    apply(p => {
      p.set('tab', f.tab);
      p.set('view', f.view);
      p.delete('q');
      p.delete('page');
      return p;
    });

  const empty = entries.length === 0 && data.errors.length === 0;
  const filtered = q !== '' || view !== 'all';

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Inventory"
        title={
          <>
            What you hold, <em>and what it&rsquo;s worth.</em>
          </>
        }
        description="Stock on hand, what each item cost, and what needs attention."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => revalidator.revalidate()}
            disabled={revalidator.state !== 'idle'}
          >
            <ArrowClockwise size={14} weight="light" aria-hidden /> Refresh
          </Button>
        }
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        {data.errors.length > 0 && (
          <div role="alert" className="rounded-xl border bg-destructive/10 p-4 text-sm">
            <p className="font-medium text-destructive">Some inventory data did not load.</p>
            <ul className="mt-1 list-disc pl-5 text-text-2">
              {data.errors.map(e => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Stock value"
            value={money(summary.stockValue)}
            caption="sellable, at unit cost"
          />
          <KpiTile label="Units on hand" value={int(summary.unitsOnHand)} caption="sellable" />
          <KpiTile
            label="Needs attention"
            value={int(summary.needsAttention)}
            tone={summary.oversold > 0 ? 'negative' : 'default'}
            caption={summary.needsAttention === 0 ? 'all clear' : 'items to look at'}
          />
          <KpiTile
            label="Invested"
            value={money(data.movements.totalInvested)}
            caption={`${int(data.movements.totalQuantityPurchased)} units bought`}
          />
        </div>

        <JumpTo
          items={flags.map(f => ({
            key: f.key,
            count: f.count,
            label: f.label,
            severe: f.key === 'oversold',
            onSelect: () => jump(f),
          }))}
        />

        <Tabs
          tabs={TABS.map(t => ({
            id: t.id,
            label: t.label,
            count: int(
              t.id === 'stock'
                ? data.stock.items.length
                : t.id === 'items'
                  ? entries.length
                  : t.id === 'movements'
                    ? data.movements.totalMovements
                    : data.valuation.items.length
            ),
          }))}
          value={tab}
          onChange={setTab}
        />

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-[280px]">
            <MagnifyingGlass
              size={16}
              weight="light"
              aria-hidden
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              placeholder="Search name or SKU"
              aria-label="Search inventory"
              className="rounded-full pl-10"
            />
          </div>
          {VIEWS[tab].length > 0 && (
            <div className="max-w-full overflow-x-auto">
              <Segmented label="Filter" value={view} onChange={setView} options={VIEWS[tab]} />
            </div>
          )}
          {filtered && (
            <button
              type="button"
              onClick={() =>
                apply(p => {
                  p.delete('q');
                  p.delete('view');
                  p.delete('page');
                  return p;
                })
              }
              className="inline-flex items-center gap-1 rounded-sm text-sm text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={12} aria-hidden /> Clear filters
            </button>
          )}
        </div>

        <div
          role="tabpanel"
          aria-labelledby={tabId(tab)}
          className="overflow-hidden rounded-2xl border bg-row"
        >
          {empty ? (
            <EmptyState
              title="No inventory yet."
              description="Items appear here once products are synced or purchases are recorded."
            />
          ) : listLength === 0 ? (
            <EmptyState
              title="Nothing matches."
              description={
                filtered ? 'No rows match these filters.' : 'There is nothing in this view yet.'
              }
            />
          ) : tab === 'stock' ? (
            <StockTable rows={slice(stockRows)} onOpen={openItem} selected={selectedId} />
          ) : tab === 'items' ? (
            <ItemsTable rows={slice(itemRows)} onOpen={openItem} selected={selectedId} />
          ) : tab === 'movements' ? (
            <DataTable label="Inventory movements" bare surface="page">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Type</th>
                  <th className="text-right">Units</th>
                  <th className="hidden text-right md:table-cell">Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {slice(movementRows).map(m => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap text-text-2">{shortDate(m.occurredAt)}</td>
                    <td>
                      <span className="block max-w-[320px] truncate">
                        {m.productName ?? m.sku ?? 'Unknown item'}
                      </span>
                      <span className="block truncate font-mono text-xs text-text-2">
                        {m.reference ? `${m.sku ?? ''} · ${m.reference}` : (m.sku ?? '')}
                      </span>
                    </td>
                    <td>
                      <Chip tone={MOVEMENT_TONE[m.transactionType] ?? 'plain'}>
                        {MOVEMENT_LABEL[m.transactionType] ?? m.transactionType}
                      </Chip>
                    </td>
                    <td className="text-right tabular-nums">
                      {m.quantity > 0 ? '+' : '−'}
                      {int(Math.abs(m.quantity))}
                    </td>
                    <td className="hidden text-right tabular-nums text-text-2 md:table-cell">
                      {m.unitCost > 0 ? money(m.unitCost, 2) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <DataTable label="Valuation by item" bare surface="page">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="text-right">Unit cost</th>
                  <th className="text-right">Units bought</th>
                  <th className="text-right">Invested</th>
                </tr>
              </thead>
              <tbody>
                {slice(valuationRows).map(i => (
                  <tr key={i.id}>
                    <td>
                      <span className="block max-w-[320px] truncate">
                        {i.productName ?? i.sku ?? 'Unlinked'}
                      </span>
                      <span className="block truncate font-mono text-xs text-text-2">
                        {i.sku ?? 'No SKU'}
                      </span>
                    </td>
                    <td className="text-right tabular-nums text-text-2">
                      {i.unitCost > 0 ? money(i.unitCost, 2) : '—'}
                    </td>
                    <td className="text-right tabular-nums">{int(i.totalPurchased)}</td>
                    <td className="text-right tabular-nums">{money(i.totalInvested)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td />
                  <td className="text-right tabular-nums">
                    {int(data.valuation.totalUnitsPurchased)}
                  </td>
                  <td className="text-right tabular-nums">
                    {money(data.valuation.totalInventoryValue)}
                  </td>
                </tr>
              </tfoot>
            </DataTable>
          )}
          {listLength > 0 && (
            <Pager page={current} pages={pages} total={listLength} onPage={setPage} />
          )}
        </div>
      </div>

      <ItemDrawer
        entry={selected}
        products={data.products}
        movements={data.movements.movements}
        onClose={() => openItem(null)}
      />
    </div>
  );
}
