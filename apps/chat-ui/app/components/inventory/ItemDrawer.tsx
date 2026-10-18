/**
 * ItemDrawer
 *
 * One inventory item: where its stock figure comes from, recording a gift or write-off, and
 * editing cost, type and product link. Opened from any tab with ?item=<id>.
 */

import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { Drawer } from '~/components/ui/drawer';
import { Eyebrow } from '~/components/ui/eyebrow';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/native-select';
import { Segmented } from '~/components/ui/segmented';
import type { InventoryMovementRow } from '~/lib/api/inventory.server';
import {
  MOVEMENT_LABEL,
  MOVEMENT_TONE,
  STATE_LABEL,
  STATE_TONE,
  int,
  marginOf,
  money,
  shortDate,
  type InventoryEntry,
} from './model';

type ItemType = 'sellable' | 'sample' | 'material';
type Disposal = 'GIFT' | 'WRITE_OFF';

export interface ProductOption {
  id: string;
  name: string;
}

function BreakdownRow({ label, value, sign }: { label: string; value: number; sign: string }) {
  return (
    <div className="flex items-baseline justify-between border-b py-2.5 last:border-b-0">
      <dt className="text-text-2">{label}</dt>
      <dd className="font-mono tabular-nums">{value === 0 ? '0' : `${sign}${int(value)}`}</dd>
    </div>
  );
}

function errorOf(data: unknown): string | null {
  if (data && typeof data === 'object' && 'error' in data)
    return String((data as { error: unknown }).error);
  return null;
}

export function ItemDrawer({
  entry,
  products,
  movements,
  onClose,
}: {
  entry: InventoryEntry | null;
  products: ProductOption[];
  movements: InventoryMovementRow[];
  onClose: () => void;
}) {
  return (
    <Drawer
      open={!!entry}
      onOpenChange={open => !open && onClose()}
      eyebrow={entry ? (entry.provider ?? 'Inventory item') : undefined}
      title={entry?.name ?? 'Item'}
      description="Stock breakdown and settings for this inventory item"
    >
      {entry && <Body key={entry.id} entry={entry} products={products} movements={movements} />}
    </Drawer>
  );
}

function Body({
  entry,
  products,
  movements,
}: {
  entry: InventoryEntry;
  products: ProductOption[];
  movements: InventoryMovementRow[];
}) {
  const save = useFetcher<{ ok: boolean; error?: string }>();
  const dispose = useFetcher<{ success?: boolean; error?: string }>();

  const [cost, setCost] = useState(String(entry.unitCost));
  const [type, setType] = useState<ItemType>(entry.itemType);
  const [productId, setProductId] = useState(entry.productId ?? '');
  const [kind, setKind] = useState<Disposal>('GIFT');
  const [qty, setQty] = useState('');

  const costNumber = Number(cost);
  const costValid = cost !== '' && Number.isFinite(costNumber) && costNumber >= 0;
  const dirty =
    costNumber !== entry.unitCost ||
    type !== entry.itemType ||
    (type === 'sellable' && (productId || null) !== entry.productId);
  const margin = marginOf(entry.sellingPrice, costValid ? costNumber : entry.unitCost);

  const saving = save.state !== 'idle';
  const disposing = dispose.state !== 'idle';
  const quantity = Number(qty);
  const qtyValid = Number.isInteger(quantity) && quantity > 0;

  useEffect(() => {
    if (save.state !== 'idle' || !save.data) return;
    if (save.data.ok) toast.success('Item saved');
    else toast.error(save.data.error ?? 'Could not save this item');
  }, [save.state, save.data]);

  useEffect(() => {
    if (dispose.state !== 'idle' || !dispose.data) return;
    const error = errorOf(dispose.data);
    if (error) toast.error(error);
    else {
      toast.success(kind === 'GIFT' ? 'Gift recorded' : 'Write-off recorded');
      setQty('');
    }
    // `kind` is the value at submit time; it cannot change while the request is in flight.
  }, [dispose.state, dispose.data]);

  const onSave = () => {
    const form = new FormData();
    form.set('intent', 'update_item');
    form.set('inventoryItemId', entry.id);
    form.set('unitCost', String(costNumber));
    form.set('itemType', type);
    if (type === 'sellable') form.set('productId', productId);
    save.submit(form, { method: 'POST' });
  };

  const onRecord = () => {
    const form = new FormData();
    form.set('intent', 'recordDisposal');
    form.set('inventoryItemId', entry.id);
    form.set('disposalType', kind);
    form.set('quantity', String(quantity));
    dispose.submit(form, { method: 'POST', action: '/api/inventory' });
  };

  const stock = entry.stock;
  const recent = movements.filter(m => m.inventoryItemId === entry.id).slice(0, 6);

  return (
    <>
      <div className="space-y-3">
        <div className="font-mono text-[13px] text-text-2">{entry.sku ?? 'No SKU'}</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(entry.attributes).map(([k, v]) => (
            <Chip key={k}>
              {k}: {v}
            </Chip>
          ))}
          {entry.state && <Chip tone={STATE_TONE[entry.state]}>{STATE_LABEL[entry.state]}</Chip>}
          {entry.itemType !== 'sellable' ? (
            <Chip tone="planned">{entry.itemType === 'sample' ? 'Sample' : 'Material'}</Chip>
          ) : entry.linked ? (
            <Chip tone="done">Linked</Chip>
          ) : (
            <Chip tone="active">Not linked</Chip>
          )}
        </div>
      </div>

      {stock ? (
        <section aria-label="Stock">
          <Eyebrow>On hand</Eyebrow>
          <div
            className={`mt-1.5 font-serif text-[56px] ${entry.state === 'oversold' ? 'text-destructive' : ''}`}
          >
            {entry.isUnlimited ? '∞' : int(entry.onHand)}
          </div>
          {!entry.isUnlimited && (
            <p className="mt-1 text-[13px] text-muted-foreground">
              {money(entry.stockValue)} at {money(entry.unitCost, 2)} each
            </p>
          )}
          <dl className="mt-4 text-[15px]">
            <BreakdownRow label="Purchased" value={stock.unitsPurchased} sign="+" />
            <BreakdownRow label="Sold" value={stock.unitsSold} sign="−" />
            <BreakdownRow label="Returned" value={stock.unitsRefunded} sign="+" />
            <BreakdownRow label="Gifted" value={stock.unitsGifted} sign="−" />
            <BreakdownRow label="Written off" value={stock.unitsWrittenOff} sign="−" />
          </dl>
        </section>
      ) : (
        <p className="rounded-xl border border-dashed border-border-strong p-4 text-[14px] text-text-2">
          This variant is not linked to a product, so it has no stock figure yet. Link it below to
          bring it into the stock picture.
        </p>
      )}

      {stock && !entry.isUnlimited && (
        <section aria-label="Record a disposal" className="space-y-3 border-t pt-5">
          <Eyebrow>Record a disposal</Eyebrow>
          <Segmented<Disposal>
            label="Disposal type"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'GIFT', label: 'Gift' },
              { value: 'WRITE_OFF', label: 'Write-off' },
            ]}
          />
          <div className="flex gap-3">
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              placeholder="Units"
              aria-label="Units"
              value={qty}
              onChange={e => setQty(e.target.value)}
            />
            <Button onClick={onRecord} disabled={!qtyValid || disposing}>
              {disposing ? 'Recording…' : 'Record'}
            </Button>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Each save adds a new dated movement and its journal, rather than changing a running
            total.
          </p>
        </section>
      )}

      <section aria-label="Edit item" className="space-y-4 border-t pt-5">
        <Eyebrow>Details</Eyebrow>
        <dl className="grid grid-cols-2 gap-3 text-[15px]">
          <div>
            <dt className="text-[13px] text-muted-foreground">Selling price</dt>
            <dd>{entry.sellingPrice ? money(entry.sellingPrice, 2) : '—'}</dd>
          </div>
          <div>
            <dt className="text-[13px] text-muted-foreground">Margin at this cost</dt>
            <dd>{margin == null ? '—' : `${margin.toFixed(0)}%`}</dd>
          </div>
        </dl>

        <Field label="Unit cost (GBP)" hint="Feeds stock value and margin.">
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={cost}
            onChange={e => setCost(e.target.value)}
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Item type</span>
          <Segmented<ItemType>
            label="Item type"
            value={type}
            onChange={setType}
            options={[
              { value: 'sellable', label: 'Sellable' },
              { value: 'sample', label: 'Sample' },
              { value: 'material', label: 'Material' },
            ]}
          />
          {type !== 'sellable' && (
            <span className="text-[13px] text-muted-foreground">
              Samples and materials are never linked to a product and stay out of the sellable stock
              picture.
            </span>
          )}
        </div>

        {type === 'sellable' && (
          <Field label="Linked product">
            <NativeSelect
              shape="field"
              aria-label="Linked product"
              className="w-full"
              value={productId}
              onChange={e => setProductId(e.target.value)}
            >
              <option value="">Not linked</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}

        <Button onClick={onSave} disabled={!dirty || !costValid || saving} className="w-full">
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </section>

      {recent.length > 0 && (
        <section aria-label="Recent movements" className="space-y-1 border-t pt-5">
          <Eyebrow>Recent movements</Eyebrow>
          <ul className="mt-2 divide-y text-[14px]">
            {recent.map(m => (
              <li key={m.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="flex items-center gap-2">
                  <Chip tone={MOVEMENT_TONE[m.transactionType] ?? 'plain'}>
                    {MOVEMENT_LABEL[m.transactionType] ?? m.transactionType}
                  </Chip>
                  <span className="text-muted-foreground">{shortDate(m.occurredAt)}</span>
                </span>
                <span className="font-mono tabular-nums">
                  {m.quantity > 0 ? '+' : '−'}
                  {int(Math.abs(m.quantity))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
