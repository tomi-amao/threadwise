import React, { useState } from 'react';
import {
  PRODUCTS,
  STATE_LABEL,
  STATE_TONE,
  margin,
  onHand,
  stockState,
  stockValue,
  type Item,
  type ItemType,
} from './data';
import {
  Drawer,
  Eyebrow,
  Field,
  Segmented,
  StatusChipRaw,
  gbp,
  int,
  pct,
} from '../dashboard-v2/ui-shared';

const title = (i: Item) =>
  i.productName ?? (i.itemType === 'sample' ? 'Development sample' : 'Unlinked variant');

/** Edit one inventory item: cost, type, and which product it belongs to. */
export function ItemDrawer({
  item,
  all,
  onClose,
  onSave,
}: {
  item: Item;
  all: Item[];
  onClose: () => void;
  onSave: (patch: Partial<Item>) => void;
}) {
  const [cost, setCost] = useState(String(item.unitCost));
  const [type, setType] = useState<ItemType>(item.itemType);
  const [productId, setProductId] = useState(item.productId ?? '');
  const m = margin({ ...item, unitCost: Number(cost) || 0 });
  const siblings = item.productId
    ? all.filter(i => i.productId === item.productId && i.id !== item.id)
    : [];
  const dirty =
    Number(cost) !== item.unitCost ||
    type !== item.itemType ||
    (productId || null) !== item.productId;

  return (
    <Drawer
      eyebrow={item.provider}
      title={title(item)}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cv2-btn cv2-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cv2-btn cv2-btn-primary"
            disabled={!dirty || Number(cost) < 0 || cost === ''}
            onClick={() => {
              const product = PRODUCTS.find(p => p.id === productId);
              onSave({
                unitCost: Number(cost),
                itemType: type,
                // Samples are never linked to a product by design.
                productId: type === 'sample' ? null : (product?.id ?? null),
                productName: type === 'sample' ? null : (product?.name ?? null),
              });
            }}
          >
            Save changes
          </button>
        </>
      }
    >
      <div>
        <div className="cv2-mono" style={{ fontSize: 13 }}>
          {item.sku}
        </div>
        <div className="cv2-flex" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {Object.entries(item.attributes).map(([k, v]) => (
            <span key={k} className="cv2-chip cv2-chip-plain">
              {k}: {v}
            </span>
          ))}
          {item.itemType === 'sample' ? (
            <StatusChipRaw tone="planned">Sample</StatusChipRaw>
          ) : item.productId ? (
            <StatusChipRaw tone="completed">Linked</StatusChipRaw>
          ) : (
            <StatusChipRaw tone="active">Unlinked</StatusChipRaw>
          )}
        </div>
      </div>

      <dl className="cv2-dl">
        <div>
          <dt>Selling price</dt>
          <dd>{item.sellingPrice ? gbp(item.sellingPrice, 2) : '—'}</dd>
        </div>
        <div>
          <dt>
            Margin<small>At the unit cost entered below</small>
          </dt>
          <dd>{m == null ? '—' : pct(m, 0)}</dd>
        </div>
        <div>
          <dt>On hand</dt>
          <dd>{item.isUnlimited ? 'Unlimited' : int(onHand(item))}</dd>
        </div>
      </dl>

      <Field label="Unit cost (GBP)" hint="Feeds stock value and margin.">
        <input
          className="cv2-input"
          type="number"
          min={0}
          step="0.01"
          value={cost}
          onChange={e => setCost(e.target.value)}
          autoFocus
        />
      </Field>

      <div className="cv2-field">
        <span className="cv2-eyebrow">Item type</span>
        <Segmented<ItemType>
          label="Item type"
          value={type}
          onChange={setType}
          options={[
            { value: 'sellable', label: 'Sellable' },
            { value: 'sample', label: 'Sample' },
          ]}
        />
        {type === 'sample' && (
          <span className="cv2-muted" style={{ fontSize: 13 }}>
            Samples are never linked to a product and stay out of the sellable stock picture.
          </span>
        )}
      </div>

      {type === 'sellable' && (
        <Field label="Linked product">
          <select
            className="cv2-select"
            value={productId}
            onChange={e => setProductId(e.target.value)}
          >
            <option value="">Not linked</option>
            {PRODUCTS.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {siblings.length > 0 && (
        <div>
          <Eyebrow>Other variants of this product</Eyebrow>
          <div style={{ marginTop: 8 }}>
            {siblings.map(s => (
              <div
                key={s.id}
                className="cv2-between"
                style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}
              >
                <span className="cv2-mono" style={{ fontSize: 13 }}>
                  {s.sku}
                </span>
                <span className="cv2-2" style={{ fontSize: 14 }}>
                  {s.sellingPrice ? gbp(s.sellingPrice, 2) : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}

/** Stock breakdown for one item, plus recording a gift or write-off. */
export function StockDrawer({
  item,
  onClose,
  onRecord,
}: {
  item: Item;
  onClose: () => void;
  onRecord: (kind: 'gift' | 'writeoff', qty: number) => void;
}) {
  const [kind, setKind] = useState<'gift' | 'writeoff'>('gift');
  const [qty, setQty] = useState('');
  const st = stockState(item);
  const n = Number(qty);
  const valid = Number.isInteger(n) && n > 0;

  const row = (label: string, value: number, sign: '+' | '−' | '') => (
    <div>
      <dt>{label}</dt>
      <dd>
        {sign}
        {int(value)}
      </dd>
    </div>
  );

  return (
    <Drawer
      eyebrow="Stock"
      title={title(item)}
      onClose={onClose}
      footer={
        <button type="button" className="cv2-btn cv2-btn-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div>
        <div className="cv2-mono" style={{ fontSize: 13 }}>
          {item.sku}
        </div>
        <div style={{ marginTop: 10 }}>
          <StatusChipRaw tone={STATE_TONE[st]}>{STATE_LABEL[st]}</StatusChipRaw>
        </div>
      </div>

      <div>
        <Eyebrow>On hand</Eyebrow>
        <div
          className={`cv2-serif-num ${st === 'oversold' ? 'cv2-neg' : ''}`}
          style={{ fontSize: 56, lineHeight: 1.05, marginTop: 6 }}
        >
          {item.isUnlimited ? '∞' : int(onHand(item))}
        </div>
        {!item.isUnlimited && (
          <div className="cv2-muted" style={{ fontSize: 13, marginTop: 4 }}>
            {gbp(stockValue(item))} at {gbp(item.unitCost, 2)} each
          </div>
        )}
      </div>

      <dl className="cv2-dl">
        {row('Purchased', item.purchased, '+')}
        {row('Sold', item.sold, '−')}
        {row('Returned', item.refunded, '+')}
        {row('Gifted', item.gifted, '−')}
        {row('Written off', item.writtenOff, '−')}
      </dl>

      <hr className="cv2-rule" />

      <div style={{ display: 'grid', gap: 14 }}>
        <Eyebrow>Record a disposal</Eyebrow>
        <Segmented<'gift' | 'writeoff'>
          label="Disposal type"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'gift', label: 'Gift' },
            { value: 'writeoff', label: 'Write-off' },
          ]}
        />
        <div className="cv2-flex" style={{ gap: 12 }}>
          <input
            className="cv2-input"
            type="number"
            min={1}
            step={1}
            placeholder="Units"
            value={qty}
            onChange={e => setQty(e.target.value)}
            aria-label="Units"
          />
          <button
            type="button"
            className="cv2-btn cv2-btn-primary"
            disabled={!valid}
            onClick={() => {
              onRecord(kind, n);
              setQty('');
            }}
          >
            Record
          </button>
        </div>
        <p className="cv2-muted" style={{ margin: 0, fontSize: 13 }}>
          Each save adds a new dated movement rather than changing a running total. To reduce a
          figure, correct the original movement.
        </p>
      </div>
    </Drawer>
  );
}
