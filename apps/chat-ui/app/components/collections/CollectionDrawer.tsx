/**
 * CollectionDrawer: create a collection, or edit the one on screen. Same fields either way.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '~/components/ui/button';
import { Drawer } from '~/components/ui/drawer';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/native-select';
import type { CollectionRow } from '~/lib/api/collections.server';
import { COLLECTION_STATUSES } from '~/lib/collection-status';
import { COLLECTION_TYPES, STATUS } from './model';
import { useCollectionAction } from './use-collection-action';

const toSlug = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

export function CollectionDrawer({
  collection,
  open,
  onClose,
}: {
  /** The collection to edit; omit to create one. */
  collection?: CollectionRow;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={o => !o && onClose()}
      eyebrow={collection ? 'Edit collection' : 'New collection'}
      title={collection ? 'Change the details.' : 'Name it, date it, budget it.'}
      description="Collection details"
    >
      {open && <Form collection={collection} onDone={onClose} />}
    </Drawer>
  );
}

function Form({ collection, onDone }: { collection?: CollectionRow; onDone: () => void }) {
  const navigate = useNavigate();
  const editing = !!collection;
  const [name, setName] = useState(collection?.name ?? '');
  const [slug, setSlug] = useState(collection?.slug ?? '');
  const [slugEdited, setSlugEdited] = useState(editing);
  const [status, setStatus] = useState<string>(collection?.status ?? 'draft');
  const [type, setType] = useState(collection?.type ?? '');
  const [launch, setLaunch] = useState(collection?.launchDate ?? '');
  const [startsAt, setStartsAt] = useState(collection?.startsAt?.slice(0, 10) ?? '');
  const [endsAt, setEndsAt] = useState(collection?.endsAt?.slice(0, 10) ?? '');
  const [budget, setBudget] = useState(collection?.budget != null ? String(collection.budget) : '');
  const [currency, setCurrency] = useState(collection?.budgetCurrency ?? 'GBP');
  const [ref, setRef] = useState(collection?.externalRef ?? '');

  const action = useCollectionAction(result => {
    onDone();
    if (!editing && result.id) navigate(`/collections/${result.id}`);
  });

  const submit = () =>
    action.submit({
      intent: editing ? 'updateCollection' : 'createCollection',
      name,
      slug: slugEdited ? slug : '',
      status,
      collectionType: type,
      launchDate: launch,
      startsAt,
      endsAt,
      plannedBudgetAmount: budget,
      budgetCurrency: currency,
      externalRef: ref,
    });

  return (
    <>
      <Field label="Name">
        <Input
          value={name}
          maxLength={120}
          autoFocus
          placeholder="Winter Capsule"
          onChange={e => {
            setName(e.target.value);
            if (!slugEdited) setSlug(toSlug(e.target.value));
          }}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" hint="Seasonal, capsule, drop… or your own.">
          <Input
            list="collection-types"
            value={type}
            onChange={e => setType(e.target.value)}
            placeholder="Seasonal"
          />
        </Field>
        <Field label="Status">
          <NativeSelect
            shape="field"
            aria-label="Status"
            className="w-full"
            value={status}
            onChange={e => setStatus(e.target.value)}
          >
            {COLLECTION_STATUSES.map(s => (
              <option key={s} value={s}>
                {STATUS[s].label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <datalist id="collection-types">
        {COLLECTION_TYPES.map(t => (
          <option key={t} value={t} />
        ))}
      </datalist>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Launch date">
          <Input type="date" value={launch} onChange={e => setLaunch(e.target.value)} />
        </Field>
        <Field label="Starts">
          <Input type="date" value={startsAt} onChange={e => setStartsAt(e.target.value)} />
        </Field>
        <Field label="Ends">
          <Input
            type="date"
            value={endsAt}
            min={startsAt || undefined}
            onChange={e => setEndsAt(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
        <Field label="Budget" hint="Optional. Linked costs are tracked against it.">
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={budget}
            onChange={e => setBudget(e.target.value)}
          />
        </Field>
        <Field label="Currency">
          <Input
            value={currency}
            maxLength={3}
            onChange={e => setCurrency(e.target.value.toUpperCase())}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Web name" hint="Used in links. Made from the name.">
          <Input
            value={slug}
            onChange={e => {
              setSlug(toSlug(e.target.value));
              setSlugEdited(true);
            }}
          />
        </Field>
        <Field label="Reference" hint="Optional, e.g. a season code.">
          <Input value={ref} maxLength={60} onChange={e => setRef(e.target.value)} />
        </Field>
      </div>

      {action.error && (
        <p role="alert" className="text-[14px] text-destructive">
          {action.error}
        </p>
      )}
      <Button onClick={submit} disabled={action.busy || !name.trim()}>
        {action.busy ? 'Saving…' : editing ? 'Save changes' : 'Create collection'}
      </Button>
    </>
  );
}
