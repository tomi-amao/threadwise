import React, { useState } from 'react';
import {
  CATALOG,
  COST_CATEGORIES,
  type Collection,
  type Cost,
  type Product,
  type PlanLine,
  type Status,
} from './data';
import { Drawer, Field, gbp } from './ui';

let seq = 1000;
const uid = (p: string) => `${p}-${++seq}`;

export function CreateCollectionDrawer({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (c: Collection) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('Seasonal');
  const [status, setStatus] = useState<Status>('draft');
  const [launch, setLaunch] = useState('');
  const [budget, setBudget] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate({
      id: uid('col'),
      name: name.trim(),
      type,
      status,
      ref: '',
      launchDate: launch || null,
      budget: budget ? Number(budget) : null,
      weekly: [],
      products: [],
      costs: [],
      plan: null,
    });
  };

  return (
    <Drawer
      eyebrow="New collection"
      title="Name it, date it, budget it."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cv2-btn cv2-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="cv2-create"
            className="cv2-btn cv2-btn-primary"
            disabled={!name.trim()}
          >
            Create collection
          </button>
        </>
      }
    >
      <form id="cv2-create" onSubmit={submit} style={{ display: 'grid', gap: 18 }}>
        <Field label="Name">
          <input
            className="cv2-input"
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Winter Capsule"
          />
        </Field>
        <Field label="Type">
          <select className="cv2-select" value={type} onChange={e => setType(e.target.value)}>
            {['Seasonal', 'Capsule', 'Collaboration', 'Core range', 'Clearance'].map(t => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            className="cv2-select"
            value={status}
            onChange={e => setStatus(e.target.value as Status)}
          >
            {(['draft', 'planned', 'active', 'completed'] as Status[]).map(s => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Launch date" hint="Optional. Leave blank for drafts.">
          <input
            className="cv2-input"
            type="date"
            value={launch}
            onChange={e => setLaunch(e.target.value)}
          />
        </Field>
        <Field label="Budget (GBP)" hint="Optional. Costs are tracked against this.">
          <input
            className="cv2-input"
            type="number"
            min={0}
            value={budget}
            onChange={e => setBudget(e.target.value)}
            placeholder="12000"
          />
        </Field>
      </form>
    </Drawer>
  );
}

export function AddProductDrawer({
  existing,
  onClose,
  onAdd,
}: {
  existing: Product[];
  onClose: () => void;
  onAdd: (products: Product[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const taken = new Set(existing.map(p => p.sku));
  const options = CATALOG.filter(
    p => !taken.has(p.sku) && `${p.name} ${p.sku}`.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <Drawer
      eyebrow="Add products"
      title="Pick from the catalogue."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cv2-btn cv2-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cv2-btn cv2-btn-primary"
            disabled={picked.length === 0}
            onClick={() =>
              onAdd(
                CATALOG.filter(p => picked.includes(p.id)).map(p => ({
                  ...p,
                  id: uid('p'),
                  units: 0,
                }))
              )
            }
          >
            Add {picked.length || ''} {picked.length === 1 ? 'product' : 'products'}
          </button>
        </>
      }
    >
      <input
        className="cv2-input"
        autoFocus
        placeholder="Search by name or SKU"
        value={query}
        onChange={e => setQuery(e.target.value)}
        aria-label="Search catalogue"
      />
      <div style={{ display: 'grid', gap: 8 }}>
        {options.length === 0 && (
          <p className="cv2-2">Everything matching is already in this collection.</p>
        )}
        {options.map(p => (
          <button
            key={p.id}
            type="button"
            className="cv2-pick"
            aria-pressed={picked.includes(p.id)}
            onClick={() =>
              setPicked(cur => (cur.includes(p.id) ? cur.filter(x => x !== p.id) : [...cur, p.id]))
            }
          >
            <span className="cv2-mono-mark">{p.name[0]}</span>
            <span style={{ flex: 1 }}>
              <div>{p.name}</div>
              <div className="cv2-mono cv2-muted" style={{ fontSize: 12 }}>
                {p.sku}
              </div>
            </span>
            <span className="cv2-mono cv2-2" style={{ fontSize: 13 }}>
              {gbp(p.price, 2)}
            </span>
          </button>
        ))}
      </div>
    </Drawer>
  );
}

export function AddCostDrawer({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (c: Cost) => void;
}) {
  const [vendor, setVendor] = useState('');
  const [category, setCategory] = useState(COST_CATEGORIES[0]);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const valid = vendor.trim() && Number(amount) > 0;

  return (
    <Drawer
      eyebrow="Add cost"
      title="Link a piece of spend."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cv2-btn cv2-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cv2-btn cv2-btn-primary"
            disabled={!valid}
            onClick={() =>
              onAdd({
                id: uid('c'),
                vendor: vendor.trim(),
                category,
                amount: Number(amount),
                date,
                note: note.trim(),
              })
            }
          >
            Add cost
          </button>
        </>
      }
    >
      <Field label="Vendor / counterparty">
        <input
          className="cv2-input"
          autoFocus
          value={vendor}
          onChange={e => setVendor(e.target.value)}
          placeholder="Porto Knitwear"
        />
      </Field>
      <Field
        label="Category"
        hint="In the live app this is inferred from the transaction's expense account."
      >
        <select className="cv2-select" value={category} onChange={e => setCategory(e.target.value)}>
          {COST_CATEGORIES.map(c => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <Field label="Amount (GBP)">
        <input
          className="cv2-input"
          type="number"
          min={0}
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="1200"
        />
      </Field>
      <Field label="Date">
        <input
          className="cv2-input"
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
        />
      </Field>
      <Field label="Note">
        <textarea
          className="cv2-textarea"
          rows={3}
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Optional"
        />
      </Field>
    </Drawer>
  );
}

export function AddLineDrawer({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (l: PlanLine) => void;
}) {
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [price, setPrice] = useState('');
  const [sell, setSell] = useState(80);
  const valid = name.trim() && Number(qty) > 0 && Number(unitCost) >= 0 && Number(price) > 0;

  return (
    <Drawer
      eyebrow="Add plan line"
      title="One product, four numbers."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cv2-btn cv2-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cv2-btn cv2-btn-primary"
            disabled={!valid}
            onClick={() =>
              onAdd({
                id: uid('l'),
                name: name.trim(),
                qty: Number(qty),
                unitCost: Number(unitCost),
                price: Number(price),
                sellThrough: sell,
              })
            }
          >
            Add line
          </button>
        </>
      }
    >
      <Field label="Product">
        <input
          className="cv2-input"
          autoFocus
          list="cv2-catalog"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Choose or type a name"
        />
        <datalist id="cv2-catalog">
          {CATALOG.map(p => (
            <option key={p.id} value={p.name} />
          ))}
        </datalist>
      </Field>
      <Field label="Planned quantity">
        <input
          className="cv2-input"
          type="number"
          min={0}
          value={qty}
          onChange={e => setQty(e.target.value)}
        />
      </Field>
      <Field label="Unit cost (GBP)">
        <input
          className="cv2-input"
          type="number"
          min={0}
          step="0.01"
          value={unitCost}
          onChange={e => setUnitCost(e.target.value)}
        />
      </Field>
      <Field label="Selling price (GBP)">
        <input
          className="cv2-input"
          type="number"
          min={0}
          step="0.01"
          value={price}
          onChange={e => setPrice(e.target.value)}
        />
      </Field>
      <Field label={`Expected sell-through · ${sell}%`}>
        <input
          className="cv2-range"
          type="range"
          min={0}
          max={100}
          value={sell}
          onChange={e => setSell(Number(e.target.value))}
        />
      </Field>
    </Drawer>
  );
}
