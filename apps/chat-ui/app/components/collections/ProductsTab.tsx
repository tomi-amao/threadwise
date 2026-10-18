/**
 * ProductsTab: the products in the collection, what each has sold, and its share of the
 * collection's revenue. Products are added from the catalogue; each membership can carry a
 * display order, a reason and an allocation weight.
 */

import { useMemo, useState } from 'react';
import { MagnifyingGlass, Package, PencilSimple, Trash } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { DataTable } from '~/components/ui/data-table';
import { Drawer } from '~/components/ui/drawer';
import { EmptyState } from '~/components/ui/empty-state';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Meter } from '~/components/ui/meter';
import { Textarea } from '~/components/ui/textarea';
import type { MembershipRow, ProductOption } from '~/lib/api/collections.server';
import { cn } from '~/lib/utils';
import { int, money, pct } from './model';
import { ConfirmRemove, useCollectionAction } from './use-collection-action';

const nameOf = (m: MembershipRow) =>
  m.product?.name ?? m.sku ?? m.variantExternalId ?? 'Unmapped product';

export function ProductsTab({
  memberships,
  onAdd,
  onEdit,
}: {
  memberships: MembershipRow[];
  onAdd: () => void;
  onEdit: (id: string) => void;
}) {
  const [removing, setRemoving] = useState<MembershipRow | null>(null);
  const remove = useCollectionAction(() => setRemoving(null));
  const total = memberships.reduce((t, m) => t + m.revenue, 0);

  if (memberships.length === 0) {
    return (
      <div className="overflow-hidden rounded-2xl border bg-row">
        <EmptyState
          eyebrow="No products linked"
          title="Nothing in this collection yet."
          description="Add products from your catalogue. Their sales count as the collection's revenue."
          action={
            <Button size="sm" onClick={onAdd}>
              Add products
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border bg-row">
      <DataTable label="Products in this collection" bare surface="page">
        <thead>
          <tr>
            <th>Product</th>
            <th className="hidden text-right md:table-cell">Order</th>
            <th className="text-right">Units</th>
            <th className="text-right">Revenue</th>
            <th className="hidden min-w-[150px] lg:table-cell">Share</th>
            <th className="hidden lg:table-cell">Reason</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {memberships.map(m => (
            <tr key={m.id}>
              <td>
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-accent-tint text-accent-text">
                    {m.product?.thumbnailUrl ? (
                      <img src={m.product.thumbnailUrl} alt="" className="size-full object-cover" />
                    ) : (
                      <Package size={16} weight="light" aria-hidden />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="max-w-[260px] truncate">{nameOf(m)}</div>
                    <div className="max-w-[260px] truncate font-mono text-xs text-text-2">
                      {m.product?.provider ?? m.sku ?? m.variantExternalId ?? 'Membership'}
                    </div>
                  </div>
                </div>
              </td>
              <td className="hidden text-right tabular-nums text-text-2 md:table-cell">
                {m.displayOrder ?? '–'}
              </td>
              <td className="text-right tabular-nums">{int(m.units)}</td>
              <td className="whitespace-nowrap text-right tabular-nums">{money(m.revenue)}</td>
              <td className="hidden lg:table-cell">
                <div className="flex items-center gap-3">
                  <Meter value={total ? m.revenue / total : 0} className="flex-1" />
                  <span className="w-10 font-mono text-[13px] tabular-nums text-text-2">
                    {pct(total ? (m.revenue / total) * 100 : 0, 0)}
                  </span>
                </div>
              </td>
              <td className="hidden max-w-[240px] truncate text-[14px] text-text-2 lg:table-cell">
                {m.inclusionReason || '–'}
              </td>
              <td className="whitespace-nowrap text-right">
                <button
                  type="button"
                  onClick={() => onEdit(m.id)}
                  aria-label={`Edit ${nameOf(m)}`}
                  className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PencilSimple size={16} weight="light" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => setRemoving(m)}
                  aria-label={`Remove ${nameOf(m)}`}
                  className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Trash size={16} weight="light" aria-hidden />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      <ConfirmRemove
        open={!!removing}
        title="Remove this product?"
        description={
          removing
            ? `${nameOf(removing)} leaves the collection, and its sales stop counting towards the collection's revenue. The product itself is untouched.`
            : ''
        }
        busy={remove.busy}
        error={remove.error}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          removing && remove.submit({ intent: 'removeProduct', membershipId: removing.id })
        }
      />
    </div>
  );
}

// ─── Add products ─────────────────────────────────────────────────────

export function AddProductsDrawer({
  options,
  taken,
  open,
  onClose,
}: {
  options: ProductOption[];
  /** Product ids already in the collection. */
  taken: Set<string>;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={o => !o && onClose()}
      eyebrow="Add products"
      title="Pick from the catalogue."
      description="Choose products to add to this collection"
    >
      {open && <AddForm options={options} taken={taken} onDone={onClose} />}
    </Drawer>
  );
}

function AddForm({
  options,
  taken,
  onDone,
}: {
  options: ProductOption[];
  taken: Set<string>;
  onDone: () => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const action = useCollectionAction(onDone);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options
      .filter(p => !taken.has(p.id))
      .filter(
        p => !q || `${p.name} ${p.provider ?? ''} ${p.productType ?? ''}`.toLowerCase().includes(q)
      );
  }, [options, taken, query]);

  const toggle = (id: string) =>
    setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));

  return (
    <>
      <div className="relative">
        <MagnifyingGlass
          size={16}
          weight="light"
          aria-hidden
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search products"
          aria-label="Search products"
          className="rounded-full pl-10"
        />
      </div>

      {shown.length === 0 ? (
        <p className="text-[15px] text-text-2">
          {options.length === taken.size
            ? 'Every product is already in this collection.'
            : 'No products match that.'}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border" aria-label="Products">
          {shown.map(p => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 hover:bg-accent">
                <input
                  type="checkbox"
                  checked={picked.includes(p.id)}
                  onChange={() => toggle(p.id)}
                  className="size-4 accent-[var(--primary)]"
                />
                <span className="min-w-0">
                  <span className="block truncate text-[15px]">{p.name}</span>
                  <span className="block truncate font-mono text-xs text-text-2">
                    {[p.provider, p.productType].filter(Boolean).join(' · ') || 'Product'}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {action.error && (
        <p role="alert" className="text-[14px] text-destructive">
          {action.error}
        </p>
      )}
      <Button
        disabled={action.busy || picked.length === 0}
        onClick={() => action.submit({ intent: 'addProducts', productIds: JSON.stringify(picked) })}
      >
        {action.busy
          ? 'Adding…'
          : picked.length === 0
            ? 'Add products'
            : `Add ${picked.length} ${picked.length === 1 ? 'product' : 'products'}`}
      </Button>
    </>
  );
}

// ─── Edit a membership ────────────────────────────────────────────────

export function EditProductDrawer({
  membership,
  open,
  onClose,
}: {
  membership: MembershipRow | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open && !!membership}
      onOpenChange={o => !o && onClose()}
      eyebrow="Product in collection"
      title={membership ? nameOf(membership) : 'Product'}
      description="Display order, reason and weight for this product"
    >
      {membership && open && (
        <EditForm key={membership.id} membership={membership} onDone={onClose} />
      )}
    </Drawer>
  );
}

function EditForm({ membership, onDone }: { membership: MembershipRow; onDone: () => void }) {
  const [order, setOrder] = useState(
    membership.displayOrder != null ? String(membership.displayOrder) : ''
  );
  const [weight, setWeight] = useState(
    membership.allocationWeight != null ? String(membership.allocationWeight) : ''
  );
  const [reason, setReason] = useState(membership.inclusionReason ?? '');
  const action = useCollectionAction(onDone);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display order" hint="Lower numbers come first.">
          <Input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={order}
            onChange={e => setOrder(e.target.value)}
          />
        </Field>
        <Field label="Allocation weight" hint="Above 0, up to 1. Used to share costs.">
          <Input
            type="number"
            min={0}
            max={1}
            step="0.01"
            inputMode="decimal"
            value={weight}
            onChange={e => setWeight(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Why it is in the collection">
        <Textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
      {action.error && (
        <p role="alert" className={cn('text-[14px] text-destructive')}>
          {action.error}
        </p>
      )}
      <Button
        disabled={action.busy}
        onClick={() =>
          action.submit({
            intent: 'updateProduct',
            membershipId: membership.id,
            displayOrder: order,
            allocationWeight: weight,
            inclusionReason: reason,
          })
        }
      >
        {action.busy ? 'Saving…' : 'Save'}
      </Button>
    </>
  );
}
