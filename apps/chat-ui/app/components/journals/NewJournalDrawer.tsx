/**
 * NewJournalDrawer: write a double-entry journal by hand. It cannot be posted until the debits
 * and the credits match, and the running difference is shown as you type.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import { Plus, Trash } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Drawer } from '~/components/ui/drawer';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/native-select';
import { FIELD_TRIGGER_CLASS, SearchableSelect } from '~/components/ui/searchable-select';
import type { LedgerAccount } from '~/lib/api/journals.server';
import { MANUAL_TYPES_UI, money } from './model';

interface Line {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

const blank = (key: number): Line => ({ key, accountId: '', debit: '', credit: '', memo: '' });
const today = () => new Date().toISOString().slice(0, 10);

export function NewJournalDrawer({
  accounts,
  open,
  onClose,
}: {
  accounts: LedgerAccount[];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={o => !o && onClose()}
      eyebrow="Journals"
      title="New journal"
      description="Record a double-entry journal by hand"
      className="w-[min(640px,100vw)]"
    >
      {open && <Form accounts={accounts} onDone={onClose} />}
    </Drawer>
  );
}

function Form({ accounts, onDone }: { accounts: LedgerAccount[]; onDone: () => void }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string; message?: string }>();
  const [date, setDate] = useState(today());
  const [type, setType] = useState<string>('adjustment');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>([blank(1), blank(2)]);
  const saving = fetcher.state !== 'idle';

  const options = useMemo(
    () =>
      accounts.map(a => ({
        value: a.id,
        label: `${a.number} · ${a.name}`,
        group: a.type.replace(/^./, c => c.toUpperCase()),
      })),
    [accounts]
  );

  const debit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const credit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const difference = Math.round((debit - credit) * 100) / 100;
  const complete =
    lines.length >= 2 &&
    lines.every(l => l.accountId && Number(l.debit) > 0 !== Number(l.credit) > 0);
  const ready = complete && difference === 0 && debit > 0 && description.trim().length >= 3;

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data?.ok) return;
    toast.success(fetcher.data.message ?? 'Journal posted');
    onDone();
  }, [fetcher.state, fetcher.data]);

  const update = (key: number, patch: Partial<Line>) =>
    setLines(ls =>
      ls.map(l => {
        if (l.key !== key) return l;
        const next = { ...l, ...patch };
        // A line is a debit or a credit, never both: typing in one clears the other.
        if (patch.debit) next.credit = '';
        if (patch.credit) next.debit = '';
        return next;
      })
    );

  const submit = () => {
    const form = new FormData();
    form.set('intent', 'create');
    form.set('date', date);
    form.set('type', type);
    form.set('description', description);
    form.set(
      'lines',
      JSON.stringify(
        lines.map(l => ({
          accountId: l.accountId,
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
          memo: l.memo,
        }))
      )
    );
    fetcher.submit(form, { method: 'POST' });
  };

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date">
          <Input type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} />
        </Field>
        <Field label="Type">
          <NativeSelect
            shape="field"
            aria-label="Type"
            className="w-full"
            value={type}
            onChange={e => setType(e.target.value)}
          >
            {MANUAL_TYPES_UI.map(t => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field label="What it is for" hint="Shown in the ledger, and read by your accountant.">
        <Input value={description} maxLength={200} onChange={e => setDescription(e.target.value)} />
      </Field>

      <section aria-label="Lines" className="space-y-3">
        <div className="eyebrow">Lines</div>
        {lines.map((l, i) => (
          <div key={l.key} className="space-y-2 rounded-xl border bg-card p-3">
            <SearchableSelect
              options={options}
              value={l.accountId}
              onChange={v => update(l.key, { accountId: v })}
              placeholder="Choose an account"
              aria-label={`Account for line ${i + 1}`}
              className={FIELD_TRIGGER_CLASS}
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                placeholder="Debit"
                aria-label={`Debit for line ${i + 1}`}
                value={l.debit}
                onChange={e => update(l.key, { debit: e.target.value })}
              />
              <Input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                placeholder="Credit"
                aria-label={`Credit for line ${i + 1}`}
                value={l.credit}
                onChange={e => update(l.key, { credit: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Note (optional)"
                aria-label={`Note for line ${i + 1}`}
                value={l.memo}
                maxLength={200}
                onChange={e => update(l.key, { memo: e.target.value })}
              />
              {lines.length > 2 && (
                <button
                  type="button"
                  onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}
                  aria-label={`Remove line ${i + 1}`}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Trash size={15} weight="light" aria-hidden />
                </button>
              )}
            </div>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setLines(ls => [...ls, blank(Math.max(...ls.map(x => x.key)) + 1)])}
        >
          <Plus size={14} weight="bold" aria-hidden /> Add a line
        </Button>
      </section>

      <div
        role="status"
        aria-label="Balance"
        className="rounded-xl border bg-background px-4 py-3 text-[14px]"
      >
        <div className="flex justify-between">
          <span className="text-text-2">Debits</span>
          <span className="tabular-nums">{money(debit)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-2">Credits</span>
          <span className="tabular-nums">{money(credit)}</span>
        </div>
        <div className="mt-1.5 flex justify-between border-t pt-1.5 font-medium">
          <span>{difference === 0 && debit > 0 ? 'Balanced' : 'Difference'}</span>
          <span className="tabular-nums">{money(Math.abs(difference))}</span>
        </div>
      </div>

      {fetcher.data && !fetcher.data.ok && (
        <p role="alert" className="text-[14px] text-destructive">
          {fetcher.data.error}
        </p>
      )}
      <Button onClick={submit} disabled={saving || !ready}>
        {saving ? 'Posting…' : 'Post journal'}
      </Button>
    </>
  );
}
