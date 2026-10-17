/**
 * CostsTab: the spend linked to this collection. Each row is a real bank transaction, so the
 * amount can never drift from the books; linking one files it under a category taken from the
 * expense account it was journalled to.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useFetcher } from 'react-router';
import { MagnifyingGlass, PencilSimple, Trash } from 'phosphor-react';
import { ShareChart } from '~/components/charts';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { Drawer } from '~/components/ui/drawer';
import { EmptyState } from '~/components/ui/empty-state';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Panel } from '~/components/ui/panel';
import type { CostCandidate, CostRow } from '~/lib/api/collections.server';
import { cn } from '~/lib/utils';
import { money, prettyType, shortDate } from './model';
import { ConfirmRemove, useCollectionAction } from './use-collection-action';

const payee = (c: CostRow) => c.vendor || c.description || 'Transaction';

export function CostsTab({
  costs,
  onAdd,
  onEdit,
}: {
  costs: CostRow[];
  onAdd: () => void;
  onEdit: (id: string) => void;
}) {
  const [removing, setRemoving] = useState<CostRow | null>(null);
  const remove = useCollectionAction(() => setRemoving(null));
  const total = costs.reduce((t, c) => t + c.amount, 0);

  if (costs.length === 0) {
    return (
      <div className="overflow-hidden rounded-2xl border bg-row">
        <EmptyState
          eyebrow="No costs linked"
          title="No spend attributed yet."
          description="Link a bank transaction to count it against this collection."
          action={
            <Button size="sm" onClick={onAdd}>
              Add cost
            </Button>
          }
        />
      </div>
    );
  }

  const byType = new Map<string, number>();
  for (const c of costs) byType.set(c.costType, (byType.get(c.costType) ?? 0) + c.amount);
  const share = [...byType.entries()]
    .map(([type, value]) => ({ id: type, label: prettyType(type), value }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-4">
      <Panel
        title="By category"
        action={<span className="font-serif text-[28px] tabular-nums">{money(total)}</span>}
      >
        <ShareChart
          data={share}
          ariaLabel="Linked costs by category"
          height={170}
          format={v => money(v)}
        />
      </Panel>

      <div className="overflow-hidden rounded-2xl border bg-row">
        <DataTable label="Linked costs" bare surface="page">
          <thead>
            <tr>
              <th>Transaction</th>
              <th>Category</th>
              <th className="hidden md:table-cell">Date</th>
              <th className="text-right">Amount</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {costs.map(c => (
              <tr key={c.id}>
                <td>
                  <Link
                    to={`/transactions?transactionId=${c.transactionId}`}
                    className="block max-w-[320px] rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block truncate">{payee(c)}</span>
                    {c.notes && (
                      <span className="block truncate text-[13px] text-text-2">{c.notes}</span>
                    )}
                  </Link>
                </td>
                <td>
                  <Chip tone="plain">{prettyType(c.costType)}</Chip>
                </td>
                <td className="hidden whitespace-nowrap font-mono text-[13px] text-text-2 md:table-cell">
                  {shortDate(c.occurredAt)}
                </td>
                <td className="whitespace-nowrap text-right tabular-nums">
                  {money(c.amount, c.currency, 2)}
                </td>
                <td className="whitespace-nowrap text-right">
                  <button
                    type="button"
                    onClick={() => onEdit(c.id)}
                    aria-label={`Edit ${payee(c)}`}
                    className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <PencilSimple size={16} weight="light" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemoving(c)}
                    aria-label={`Remove ${payee(c)}`}
                    className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash size={16} weight="light" aria-hidden />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>

      <ConfirmRemove
        open={!!removing}
        title="Unlink this cost?"
        description={
          removing
            ? `${payee(removing)} (${money(removing.amount, removing.currency, 2)}) stops counting against this collection. The bank transaction itself is untouched.`
            : ''
        }
        confirmLabel="Unlink"
        busy={remove.busy}
        error={remove.error}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.submit({ intent: 'removeCost', costId: removing.id })}
      />
    </div>
  );
}

// ─── Link a transaction ───────────────────────────────────────────────

export function AddCostDrawer({
  collectionId,
  open,
  onClose,
}: {
  collectionId: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={o => !o && onClose()}
      eyebrow="Add a cost"
      title="Link a bank transaction."
      description="Search outbound transactions and link one as a cost"
      className="w-[min(560px,100vw)]"
    >
      {open && <AddForm collectionId={collectionId} onDone={onClose} />}
    </Drawer>
  );
}

function AddForm({ collectionId, onDone }: { collectionId: string; onDone: () => void }) {
  const search = useFetcher<{ candidates: CostCandidate[] }>();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<CostCandidate | null>(null);
  const [notes, setNotes] = useState('');
  const first = useRef(true);
  const action = useCollectionAction(onDone);

  // Search as you type, after a short pause. The first load (no text) runs at once.
  useEffect(() => {
    const url = `/api/collections/transactions?collection=${collectionId}&q=${encodeURIComponent(query.trim())}`;
    if (first.current) {
      first.current = false;
      search.load(url);
      return;
    }
    const timer = setTimeout(() => search.load(url), 300);
    return () => clearTimeout(timer);
    // `search` is a fresh object each render; the query is what should trigger a search.
  }, [query, collectionId]);

  const pick = (c: CostCandidate) => {
    setPicked(c);
    setNotes(
      [
        c.accountName
          ? `Account: ${[c.accountNumber, c.accountName].filter(Boolean).join(' ')}`
          : null,
        c.counterparty ? `Payee: ${c.counterparty}` : null,
        c.description ? `Transaction: ${c.description}` : null,
      ]
        .filter(Boolean)
        .join(' | ')
    );
  };

  const candidates = search.data?.candidates ?? [];
  const loading = search.state !== 'idle';

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
          placeholder="Payee, description or amount"
          aria-label="Search transactions"
          className="rounded-full pl-10"
        />
      </div>

      <div aria-busy={loading}>
        {candidates.length === 0 ? (
          <p className="text-[15px] text-text-2">
            {loading ? 'Searching…' : 'No unlinked outbound transactions match that.'}
          </p>
        ) : (
          <ul className="divide-y rounded-xl border" aria-label="Transactions">
            {candidates.map(c => (
              <li key={c.id}>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-3 px-3.5 py-2.5 hover:bg-accent',
                    picked?.id === c.id && 'bg-accent'
                  )}
                >
                  <input
                    type="radio"
                    name="transaction"
                    checked={picked?.id === c.id}
                    onChange={() => pick(c)}
                    className="size-4 accent-[var(--primary)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px]">
                      {c.counterparty || c.description || 'Transaction'}
                    </span>
                    <span className="block truncate font-mono text-xs text-text-2">
                      {shortDate(c.occurredAt)}
                      {c.accountName ? ` · ${c.accountNumber ?? ''} ${c.accountName}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-[15px]">
                    {money(c.amount, c.currency, 2)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {picked && (
        <div className="space-y-4 rounded-xl border bg-background p-4">
          <p className="text-[14px]">
            <span className="text-text-2">Filed as </span>
            <Chip tone="plain">{prettyType(picked.costType)}</Chip>
            <span className="ml-2 text-text-2">
              {picked.accountName
                ? `from account ${picked.accountNumber ?? ''} ${picked.accountName}`
                : 'No expense account found for it yet.'}
            </span>
          </p>
          <Field label="Notes">
            <Input value={notes} onChange={e => setNotes(e.target.value)} maxLength={400} />
          </Field>
        </div>
      )}

      {action.error && (
        <p role="alert" className="text-[14px] text-destructive">
          {action.error}
        </p>
      )}
      <Button
        disabled={action.busy || !picked}
        onClick={() =>
          picked &&
          action.submit({
            intent: 'addCost',
            transactionId: picked.id,
            notes,
            costType: picked.costType,
          })
        }
      >
        {action.busy ? 'Linking…' : 'Link cost'}
      </Button>
    </>
  );
}

// ─── Edit a linked cost ───────────────────────────────────────────────

export function EditCostDrawer({
  cost,
  open,
  onClose,
}: {
  cost: CostRow | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open && !!cost}
      onOpenChange={o => !o && onClose()}
      eyebrow="Linked cost"
      title={cost ? payee(cost) : 'Cost'}
      description="Category and notes for this linked cost"
    >
      {cost && open && <EditForm key={cost.id} cost={cost} onDone={onClose} />}
    </Drawer>
  );
}

function EditForm({ cost, onDone }: { cost: CostRow; onDone: () => void }) {
  const [type, setType] = useState(cost.costType);
  const [notes, setNotes] = useState(cost.notes ?? '');
  const action = useCollectionAction(onDone);
  return (
    <>
      <p className="text-[15px] text-text-2">
        {money(cost.amount, cost.currency, 2)} on {shortDate(cost.occurredAt)}. The amount comes
        from the bank transaction and cannot be changed here.
      </p>
      <Field label="Category" hint="How this cost is grouped on the Overview.">
        <Input value={type} maxLength={80} onChange={e => setType(e.target.value)} />
      </Field>
      <Field label="Notes">
        <Input value={notes} maxLength={400} onChange={e => setNotes(e.target.value)} />
      </Field>
      {action.error && (
        <p role="alert" className="text-[14px] text-destructive">
          {action.error}
        </p>
      )}
      <Button
        disabled={action.busy || !type.trim()}
        onClick={() =>
          action.submit({ intent: 'updateCost', costId: cost.id, costType: type, notes })
        }
      >
        {action.busy ? 'Saving…' : 'Save'}
      </Button>
    </>
  );
}
