/**
 * AdjustmentDrawer
 *
 * Record a manual adjustment to a period's taxable profit: an add-back (spending the ledger
 * deducted but tax does not allow) or a deduction (a relief or allowance the ledger does not show).
 * Opened from the review queue, which pre-fills the account it is about.
 */

import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import { Drawer } from '~/components/ui/drawer';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/native-select';
import { Segmented } from '~/components/ui/segmented';
import type { TaxPeriod, TaxReviewItem } from '~/lib/api/tax.server';
import { CATEGORY_LABEL, money } from './model';

type Direction = 'add_back' | 'deduction';

export function AdjustmentDrawer({
  period,
  item,
  open,
  onClose,
}: {
  period: TaxPeriod | undefined;
  /** The review item this resolves, if opened from the queue. */
  item: TaxReviewItem | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open && !!period}
      onOpenChange={o => !o && onClose()}
      eyebrow={period ? period.label : 'Tax'}
      title="Record an adjustment"
      description="Add back or deduct an amount in the tax computation"
    >
      {period && open && (
        <Form
          key={`${period.periodId}-${item?.accountNumber ?? ''}`}
          period={period}
          item={item}
          onDone={onClose}
        />
      )}
    </Drawer>
  );
}

function Form({
  period,
  item,
  onDone,
}: {
  period: TaxPeriod;
  item: TaxReviewItem | null;
  onDone: () => void;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string; message?: string }>();
  const [direction, setDirection] = useState<Direction>('add_back');
  const [category, setCategory] = useState(
    item?.accountNumber === '7100'
      ? 'entertainment'
      : item?.accountNumber === '7080'
        ? 'depreciation'
        : 'other'
  );
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState(item ? `${item.accountName}: ` : '');
  const saving = fetcher.state !== 'idle';

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    if (fetcher.data.ok) {
      toast.success(fetcher.data.message ?? 'Adjustment recorded');
      onDone();
    }
    // onDone is a fresh function each render; reacting to the result only is what is wanted.
  }, [fetcher.state, fetcher.data]);

  const submit = () => {
    const form = new FormData();
    form.set('intent', 'addAdjustment');
    form.set('periodId', period.periodId);
    form.set('direction', direction);
    form.set('category', category);
    form.set('amount', amount);
    form.set('description', description);
    if (item) form.set('accountNumber', item.accountNumber);
    fetcher.submit(form, { method: 'POST' });
  };

  return (
    <>
      {item && (
        <div className="rounded-xl border bg-card p-3.5 text-[14px]">
          <div className="flex items-baseline justify-between gap-3">
            <span>
              <span className="font-mono text-xs text-text-2">{item.accountNumber}</span>{' '}
              {item.accountName}
            </span>
            <span className="tabular-nums">{money(item.amount)}</span>
          </div>
          <p className="mt-1.5 text-[13px] text-text-2">{item.guidance}</p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="eyebrow">Effect</span>
        <Segmented<Direction>
          label="Effect on profit"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'add_back', label: 'Add back' },
            { value: 'deduction', label: 'Deduct' },
          ]}
        />
        <span className="text-[13px] text-muted-foreground">
          {direction === 'add_back'
            ? 'Spending the accounts deducted that tax does not allow. It raises taxable profit.'
            : 'A relief or allowance that tax gives and the accounts do not show. It lowers taxable profit.'}
        </span>
      </div>

      <Field label="Amount (GBP)">
        <Input
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          value={amount}
          onChange={e => setAmount(e.target.value)}
        />
      </Field>

      <Field label="Category">
        <NativeSelect
          shape="field"
          aria-label="Category"
          className="w-full"
          value={category}
          onChange={e => setCategory(e.target.value)}
        >
          {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </Field>

      <Field label="What it is for" hint="Your accountant will read this.">
        <Input value={description} maxLength={200} onChange={e => setDescription(e.target.value)} />
      </Field>

      {fetcher.data && !fetcher.data.ok && (
        <p role="alert" className="text-[14px] text-destructive">
          {fetcher.data.error}
        </p>
      )}

      <Button onClick={submit} disabled={saving || !amount || description.trim().length < 3}>
        {saving ? 'Saving…' : 'Record adjustment'}
      </Button>
    </>
  );
}
