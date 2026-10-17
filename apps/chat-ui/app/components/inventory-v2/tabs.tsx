import React, { useMemo, useState } from 'react';
import { CaretRight, MagnifyingGlass } from 'phosphor-react';
import {
  STATE_LABEL,
  STATE_TONE,
  margin,
  onHand,
  stockState,
  stockValue,
  summary,
  valuation,
  type Item,
  type Movement,
} from './data';
import {
  Eyebrow,
  Meter,
  RAMP,
  Segmented,
  StatusChipRaw,
  fmtDate,
  gbp,
  int,
  pct,
} from '../dashboard-v2/ui-shared';

export type StockFilter = 'all' | 'in' | 'low' | 'out' | 'oversold' | 'samples';
export type ItemFilter = 'all' | 'linked' | 'unlinked' | 'uncosted' | 'samples';

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="cv2-search" style={{ maxWidth: 320 }}>
      <MagnifyingGlass size={16} weight="light" />
      <input
        className="cv2-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}

function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div style={{ padding: '64px 24px', textAlign: 'center' }}>
      <h3 className="cv2-h3" style={{ fontSize: 24 }}>
        {title}
      </h3>
      <p className="cv2-2" style={{ margin: '8px 0 0' }}>
        {note}
      </p>
    </div>
  );
}

const itemTitle = (i: Item) =>
  i.productName ?? (i.itemType === 'sample' ? 'Development sample' : 'Unlinked variant');
const attrText = (i: Item) => Object.values(i.attributes).join(' / ');

/** A table row that opens a drawer: whole row clickable, first cell is the keyboard target. */
function ClickRow({
  onOpen,
  label,
  children,
}: {
  onOpen: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <tr onClick={onOpen} style={{ cursor: 'pointer' }}>
      {children}
      <td className="r" style={{ width: 36 }}>
        <button
          type="button"
          className="cv2-icon-btn"
          aria-label={label}
          onClick={e => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <CaretRight size={14} weight="light" />
        </button>
      </td>
    </tr>
  );
}

/* ── Stock ───────────────────────────────────────────── */

export function StockTab({
  items,
  filter,
  onFilter,
  onOpen,
}: {
  items: Item[];
  filter: StockFilter;
  onFilter: (f: StockFilter) => void;
  onOpen: (i: Item) => void;
}) {
  const [q, setQ] = useState('');
  const s = summary(items);
  const rows = useMemo(() => {
    let list = filter === 'samples' ? s.samples : s.sellable;
    if (filter === 'in') list = list.filter(i => ['in', 'unlimited'].includes(stockState(i)));
    if (filter === 'low') list = list.filter(i => stockState(i) === 'low');
    if (filter === 'out') list = list.filter(i => stockState(i) === 'out');
    if (filter === 'oversold') list = list.filter(i => stockState(i) === 'oversold');
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter(i => `${itemTitle(i)} ${i.sku}`.toLowerCase().includes(needle));
    return list;
  }, [s.sellable, s.samples, filter, q]);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="cv2-between" style={{ flexWrap: 'wrap' }}>
        <Segmented<StockFilter>
          label="Stock filter"
          value={filter}
          onChange={onFilter}
          options={[
            { value: 'all', label: `All ${s.sellable.length}` },
            { value: 'in', label: 'In stock' },
            { value: 'low', label: `Low ${s.low}` },
            { value: 'out', label: `Empty ${s.out}` },
            { value: 'oversold', label: `Oversold ${s.oversold}` },
            { value: 'samples', label: `Samples ${s.samples.length}` },
          ]}
        />
        <SearchBox value={q} onChange={setQ} placeholder="Search product or SKU" />
      </div>

      <div className="cv2-card cv2-scroll">
        {rows.length === 0 ? (
          <Empty title="Nothing matches." note="Try another filter or clear the search." />
        ) : (
          <table className="cv2-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Status</th>
                <th className="r">Purchased</th>
                <th className="r">Sold</th>
                <th className="r">On hand</th>
                <th className="r">Value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(i => {
                const st = stockState(i);
                return (
                  <ClickRow key={i.id} onOpen={() => onOpen(i)} label={`Open ${i.sku}`}>
                    <td>
                      <div>{itemTitle(i)}</div>
                      <div className="cv2-mono cv2-muted" style={{ fontSize: 12 }}>
                        {i.sku}
                        {attrText(i) ? ` · ${attrText(i)}` : ''}
                      </div>
                    </td>
                    <td>
                      <StatusChipRaw tone={STATE_TONE[st]}>{STATE_LABEL[st]}</StatusChipRaw>
                    </td>
                    <td className="r cv2-num cv2-2">{int(i.purchased)}</td>
                    <td className="r cv2-num cv2-2">{int(i.sold)}</td>
                    <td
                      className={`r cv2-num ${st === 'oversold' ? 'cv2-neg' : ''}`}
                      style={{ fontWeight: 500 }}
                    >
                      {i.isUnlimited ? '∞' : int(onHand(i))}
                    </td>
                    <td className="r cv2-num">{i.isUnlimited ? '—' : gbp(stockValue(i))}</td>
                  </ClickRow>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="cv2-muted" style={{ margin: 0, fontSize: 13 }}>
        Open a row for the full breakdown — refunded, gifted and written-off units — and to record a
        gift or write-off.
      </p>
    </div>
  );
}

/* ── Items ───────────────────────────────────────────── */

export function ItemsTab({
  items,
  filter,
  onFilter,
  onOpen,
}: {
  items: Item[];
  filter: ItemFilter;
  onFilter: (f: ItemFilter) => void;
  onOpen: (i: Item) => void;
}) {
  const [q, setQ] = useState('');
  const s = summary(items);
  const rows = useMemo(() => {
    let list = filter === 'samples' ? s.samples : s.sellable;
    if (filter === 'linked') list = list.filter(i => i.productId != null);
    if (filter === 'unlinked') list = list.filter(i => i.productId == null);
    if (filter === 'uncosted') list = items.filter(i => !i.isUnlimited && i.unitCost <= 0);
    const needle = q.trim().toLowerCase();
    if (needle)
      list = list.filter(i =>
        `${itemTitle(i)} ${i.sku} ${i.provider}`.toLowerCase().includes(needle)
      );
    return list;
  }, [items, s.sellable, s.samples, filter, q]);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="cv2-card cv2-card-pad cv2-coverage">
        <div>
          <Eyebrow>Cost coverage</Eyebrow>
          <div className="cv2-serif-num" style={{ fontSize: 36, marginTop: 6 }}>
            {pct(s.costCoverage, 0)}
          </div>
        </div>
        <div>
          <Meter value={s.costCoverage / 100} />
          <p className="cv2-2" style={{ margin: '10px 0 0', fontSize: 14 }}>
            {s.uncosted === 0
              ? 'Every item has a unit cost.'
              : `${s.uncosted} item${s.uncosted === 1 ? ' has' : 's have'} no unit cost, so margin and stock value understate.`}
          </p>
        </div>
        {s.uncosted > 0 && (
          <button
            type="button"
            className="cv2-btn cv2-btn-secondary cv2-btn-sm"
            onClick={() => onFilter('uncosted')}
          >
            Show them
          </button>
        )}
      </div>

      <div className="cv2-between" style={{ flexWrap: 'wrap' }}>
        <Segmented<ItemFilter>
          label="Item filter"
          value={filter}
          onChange={onFilter}
          options={[
            { value: 'all', label: `Sellable ${s.sellable.length}` },
            { value: 'linked', label: `Linked ${s.linked}` },
            { value: 'unlinked', label: `Unlinked ${s.unlinked}` },
            { value: 'uncosted', label: `Uncosted ${s.uncosted}` },
            { value: 'samples', label: `Samples ${s.samples.length}` },
          ]}
        />
        <SearchBox value={q} onChange={setQ} placeholder="Search SKU, product or source" />
      </div>

      <div className="cv2-card cv2-scroll">
        {rows.length === 0 ? (
          <Empty title="No items here." note="Nothing matches this filter." />
        ) : (
          <table className="cv2-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Source</th>
                <th>Link</th>
                <th className="r">Unit cost</th>
                <th className="r">Price</th>
                <th className="r">Margin</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(i => {
                const m = margin(i);
                return (
                  <ClickRow key={i.id} onOpen={() => onOpen(i)} label={`Open ${i.sku}`}>
                    <td>
                      <div>{itemTitle(i)}</div>
                      <div className="cv2-mono cv2-muted" style={{ fontSize: 12 }}>
                        {i.sku}
                        {attrText(i) ? ` · ${attrText(i)}` : ''}
                      </div>
                    </td>
                    <td>
                      <span className="cv2-chip cv2-chip-plain">{i.provider}</span>
                    </td>
                    <td>
                      {i.itemType === 'sample' ? (
                        <StatusChipRaw tone="planned">Sample</StatusChipRaw>
                      ) : i.productId ? (
                        <StatusChipRaw tone="completed">Linked</StatusChipRaw>
                      ) : (
                        <StatusChipRaw tone="active">Unlinked</StatusChipRaw>
                      )}
                    </td>
                    <td className="r cv2-num">
                      {i.unitCost > 0 ? (
                        gbp(i.unitCost, 2)
                      ) : (
                        <span className="cv2-chip cv2-chip-tbd">not set</span>
                      )}
                    </td>
                    <td className="r cv2-num cv2-2">
                      {i.sellingPrice ? gbp(i.sellingPrice, 2) : '—'}
                    </td>
                    <td className="r cv2-num cv2-2">{m == null ? '—' : pct(m, 0)}</td>
                  </ClickRow>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ── Movements ───────────────────────────────────────── */

const TYPE_TONE: Record<Movement['type'], string> = {
  PURCHASE: 'planned',
  SALE: 'active',
  REFUND: 'completed',
  GIFT: 'draft',
  WRITE_OFF: 'neg',
};
const TYPE_LABEL: Record<Movement['type'], string> = {
  PURCHASE: 'Purchase',
  SALE: 'Sale',
  REFUND: 'Return',
  GIFT: 'Gift',
  WRITE_OFF: 'Write-off',
};

export function MovementsTab({ movements, items }: { movements: Movement[]; items: Item[] }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(25);
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return movements;
    return movements.filter(m => {
      const it = byId.get(m.itemId);
      return `${it?.sku} ${it?.productName} ${m.notes} ${m.reference} ${TYPE_LABEL[m.type]}`
        .toLowerCase()
        .includes(needle);
    });
  }, [movements, byId, q]);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="cv2-between" style={{ flexWrap: 'wrap' }}>
        <SearchBox
          value={q}
          onChange={v => {
            setQ(v);
            setLimit(25);
          }}
          placeholder="Search SKU, type or note"
        />
        <span className="cv2-mono cv2-muted" style={{ fontSize: 12 }}>
          {rows.length} MOVEMENTS
        </span>
      </div>
      <div className="cv2-card cv2-scroll">
        {rows.length === 0 ? (
          <Empty title="No movements found." note="Nothing matches that search." />
        ) : (
          <table className="cv2-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Type</th>
                <th className="r">Qty</th>
                <th className="r">Unit cost</th>
                <th className="r">Total</th>
                <th className="r">Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map(m => {
                const it = byId.get(m.itemId);
                return (
                  <tr key={m.id}>
                    <td>
                      <div className="cv2-mono" style={{ fontSize: 13 }}>
                        {it?.sku}
                      </div>
                      <div className="cv2-muted" style={{ fontSize: 13 }}>
                        {[it?.productName, m.reference, m.notes].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>
                      <StatusChipRaw tone={TYPE_TONE[m.type]}>{TYPE_LABEL[m.type]}</StatusChipRaw>
                    </td>
                    <td className={`r cv2-num ${m.quantity < 0 ? '' : ''}`}>
                      {m.quantity > 0 ? '+' : '−'}
                      {int(Math.abs(m.quantity))}
                    </td>
                    <td className="r cv2-num cv2-2">{m.unitCost > 0 ? gbp(m.unitCost, 2) : '—'}</td>
                    <td className="r cv2-num">
                      {m.unitCost > 0 ? gbp(Math.abs(m.quantity) * m.unitCost) : '—'}
                    </td>
                    <td className="r cv2-mono cv2-2" style={{ fontSize: 13 }}>
                      {fmtDate(m.date, true)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {rows.length > limit && (
        <div style={{ textAlign: 'center' }}>
          <button
            type="button"
            className="cv2-btn cv2-btn-secondary cv2-btn-sm"
            onClick={() => setLimit(l => l + 25)}
          >
            Show 25 more
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Valuation ───────────────────────────────────────── */

export function ValuationTab({ items }: { items: Item[] }) {
  const { rows, total } = valuation(items);
  const top = rows.slice(0, 5);
  const rest = total - top.reduce((a, r) => a + r.invested, 0);
  const max = rows[0]?.invested ?? 1;

  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <div className="cv2-card cv2-card-pad">
        <div className="cv2-between" style={{ alignItems: 'baseline', marginBottom: 16 }}>
          <Eyebrow>Where the money went</Eyebrow>
          <span className="cv2-serif-num" style={{ fontSize: 28 }}>
            {gbp(total)}
          </span>
        </div>
        <div className="cv2-stack">
          {top.map((r, i) => (
            <span
              key={r.item.id}
              style={{ flexGrow: r.invested, background: RAMP[i] }}
              title={`${r.item.sku}: ${gbp(r.invested)}`}
            />
          ))}
          {rest > 0 && (
            <span
              style={{ flexGrow: rest, background: 'var(--ramp-5)' }}
              title={`Everything else: ${gbp(rest)}`}
            />
          )}
        </div>
        <div className="cv2-legend" style={{ marginTop: 16 }}>
          {top.map((r, i) => (
            <span key={r.item.id}>
              <i style={{ background: RAMP[i] }} />
              {r.item.sku}{' '}
              <span className="cv2-mono cv2-num">{pct((r.invested / total) * 100, 0)}</span>
            </span>
          ))}
          {rest > 0 && (
            <span>
              <i style={{ background: 'var(--ramp-5)' }} />
              Everything else{' '}
              <span className="cv2-mono cv2-num">{pct((rest / total) * 100, 0)}</span>
            </span>
          )}
        </div>
      </div>

      <div className="cv2-card cv2-scroll">
        <table className="cv2-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th style={{ width: '26%' }}>Share of spend</th>
              <th className="r">Purchased</th>
              <th className="r">Unit cost</th>
              <th className="r">Invested</th>
              <th className="r">%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, invested }) => (
              <tr key={item.id}>
                <td>
                  <div className="cv2-mono" style={{ fontSize: 13 }}>
                    {item.sku}
                  </div>
                  <div className="cv2-muted" style={{ fontSize: 13 }}>
                    {itemTitle(item)}
                  </div>
                </td>
                <td>
                  <Meter value={invested / max} />
                </td>
                <td className="r cv2-num cv2-2">{int(item.purchased)}</td>
                <td className="r cv2-num cv2-2">{gbp(item.unitCost, 2)}</td>
                <td className="r cv2-num">{gbp(invested)}</td>
                <td className="r cv2-mono cv2-2" style={{ fontSize: 13 }}>
                  {pct((invested / total) * 100)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
