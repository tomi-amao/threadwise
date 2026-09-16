/**
 * Manual Journal Entries (Protected)
 *
 * Allows recording double-entry accounting adjustments directly in ThreadWise:
 *   - Samples / unlinked inventory reclassification (quick action)
 *   - Arbitrary manual adjustments with full account picker
 *   - Recent journal history
 */

import React, { useState, useCallback } from 'react';
import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData, useFetcher } from 'react-router';
import {
  Plus,
  Trash,
  Warning,
  CheckCircle,
  BookOpen,
  CurrencyDollar,
  FloppyDisk,
  SpinnerGap,
  ArrowsDownUp,
  Info,
} from 'phosphor-react';
import { getServerSupabaseClient } from '~/lib/supabase';
import { cn } from '~/lib/utils';
import { Button } from '~/components/ui/button';

const ENTITY_ID = 'f49f608d-0868-4e63-b0bb-d4c60d74db68';

export const meta: MetaFunction = () => [
  { title: 'Journal Entries - ThreadWise' },
  { name: 'description', content: 'Record manual accounting adjustments' },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Account {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
  normal_balance: string;
}

interface JournalLineSummary {
  account_name: string;
  account_number: string;
  debit: number;
  credit: number;
  currency: string;
  gbp_equivalent: number | null;
}

interface RecentJournal {
  id: string;
  journal_date: string;
  journal_type: string;
  description: string | null;
  posted_at: string | null;
  lines: JournalLineSummary[];
  gbp_total: number;
}

interface SamplesSummary {
  count: number;
  usd_total: number;
}

interface LoaderData {
  accounts: Account[];
  recentJournals: RecentJournal[];
  samples: SamplesSummary;
  alreadyReclassified: boolean;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader(_: LoaderFunctionArgs): Promise<LoaderData> {
  const supabase = getServerSupabaseClient();

  const [accountsRes, sampleItemsRes] = await Promise.all([
    supabase
      .from('chart_of_accounts')
      .select('id, account_number, name, account_type, normal_balance')
      .eq('status', 'active')
      .eq('is_header', false)
      .order('account_number'),
    supabase
      .from('inventory_items')
      .select('id, unit_cost')
      .is('product_id', null)
      .eq('entity_id', ENTITY_ID),
  ]);

  const accounts: Account[] = (accountsRes.data || []).map((a: any) => ({
    id: a.id,
    account_number: String(a.account_number),
    name: a.name,
    account_type: a.account_type,
    normal_balance: a.normal_balance,
  }));

  // Sample items — unit_cost stored in USD
  const sampleItems = sampleItemsRes.data || [];
  const usdTotal = sampleItems.reduce(
    (s: number, i: any) => s + Number(i.unit_cost || 0),
    0
  );

  // Check if the reclassification journal already exists
  const { data: existingAdj } = await supabase
    .from('journals')
    .select('id')
    .eq('entity_id', ENTITY_ID)
    .eq('source_type', 'manual')
    .ilike('description', '%sample%reclassif%')
    .limit(1);

  // Fetch recent manual journals (last 30)
  const { data: rawJournals } = await supabase
    .from('journals')
    .select('id, journal_date, journal_type, description, posted_at')
    .eq('entity_id', ENTITY_ID)
    .eq('source_type', 'manual')
    .order('journal_date', { ascending: false })
    .limit(30);

  const journalIds = (rawJournals || []).map((j: any) => j.id as string);
  let lineItemsData: any[] = [];
  if (journalIds.length > 0) {
    const { data: lines } = await supabase
      .from('journal_line_items')
      .select('journal_id, account_id, debit, credit, currency, gbp_equivalent')
      .in('journal_id', journalIds);
    lineItemsData = lines || [];
  }

  // Build account lookup
  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  // Group line items by journal
  const linesByJournal = new Map<string, JournalLineSummary[]>();
  for (const line of lineItemsData) {
    const acct = accountMap.get(line.account_id);
    const entry: JournalLineSummary = {
      account_name: acct?.name ?? 'Unknown',
      account_number: acct?.account_number ?? '?',
      debit: Number(line.debit || 0),
      credit: Number(line.credit || 0),
      currency: line.currency ?? 'GBP',
      gbp_equivalent: line.gbp_equivalent != null ? Number(line.gbp_equivalent) : null,
    };
    const existing = linesByJournal.get(line.journal_id) || [];
    existing.push(entry);
    linesByJournal.set(line.journal_id, existing);
  }

  const recentJournals: RecentJournal[] = (rawJournals || []).map((j: any) => {
    const lines = linesByJournal.get(j.id) || [];
    const gbp_total = lines.reduce((s, l) => {
      if (l.debit > 0) {
        return s + (l.gbp_equivalent != null ? l.gbp_equivalent : l.debit);
      }
      return s;
    }, 0);
    return {
      id: j.id,
      journal_date: j.journal_date,
      journal_type: j.journal_type,
      description: j.description,
      posted_at: j.posted_at,
      lines,
      gbp_total,
    };
  });

  return {
    accounts,
    recentJournals,
    samples: { count: sampleItems.length, usd_total: usdTotal },
    alreadyReclassified: (existingAdj?.length ?? 0) > 0,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GBP = (v: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);

const USD = (v: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

const TYPE_LABELS: Record<string, string> = {
  adjustment: 'Adjustment',
  accrual: 'Accrual',
  settlement: 'Settlement',
  reversal: 'Reversal',
  purchase: 'Purchase',
  expense: 'Expense',
  payment: 'Payment',
};

// ─── Account Select ───────────────────────────────────────────────────────────

function AccountSelect({
  accounts,
  value,
  onChange,
  placeholder,
}: {
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-muted border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
    >
      <option value="">{placeholder || '— Select account —'}</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.account_number} — {a.name}
        </option>
      ))}
    </select>
  );
}

// ─── Journal Line Row ─────────────────────────────────────────────────────────

interface JournalLine {
  id: string;
  account_id: string;
  debit: string;
  credit: string;
  currency: string;
  gbp_equivalent: string;
  line_description: string;
}

function LineRow({
  line,
  accounts,
  onChange,
  onRemove,
  canRemove,
}: {
  line: JournalLine;
  accounts: Account[];
  onChange: (updated: JournalLine) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const isNonGbp = line.currency !== 'GBP';

  return (
    <div className="grid grid-cols-[1fr_88px_88px_72px_80px_32px] gap-2 items-start py-1.5 border-b border-border/40 last:border-0">
      {/* Account picker */}
      <AccountSelect
        accounts={accounts}
        value={line.account_id}
        onChange={(id) => onChange({ ...line, account_id: id })}
      />

      {/* Debit */}
      <input
        type="number"
        min="0"
        step="0.01"
        placeholder="0.00"
        value={line.debit}
        onChange={(e) => onChange({ ...line, debit: e.target.value, credit: e.target.value ? '' : line.credit })}
        className="bg-muted border border-border rounded-lg px-2 py-1.5 text-xs text-right text-foreground tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/50"
      />

      {/* Credit */}
      <input
        type="number"
        min="0"
        step="0.01"
        placeholder="0.00"
        value={line.credit}
        onChange={(e) => onChange({ ...line, credit: e.target.value, debit: e.target.value ? '' : line.debit })}
        className="bg-muted border border-border rounded-lg px-2 py-1.5 text-xs text-right text-foreground tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/50"
      />

      {/* Currency */}
      <select
        value={line.currency}
        onChange={(e) => onChange({ ...line, currency: e.target.value, gbp_equivalent: '' })}
        className="bg-muted border border-border rounded-lg px-1 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
      >
        <option>GBP</option>
        <option>USD</option>
        <option>EUR</option>
      </select>

      {/* GBP equiv (non-GBP only) */}
      {isNonGbp ? (
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="GBP"
          value={line.gbp_equivalent}
          onChange={(e) => onChange({ ...line, gbp_equivalent: e.target.value })}
          className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-2 py-1.5 text-xs text-right text-amber-600 dark:text-amber-400 tabular-nums focus:outline-none focus:ring-2 focus:ring-amber-500/50"
        />
      ) : (
        <div className="py-1.5 text-xs text-muted-foreground text-center">—</div>
      )}

      {/* Remove */}
      <button
        type="button"
        disabled={!canRemove}
        onClick={onRemove}
        className={cn(
          'flex items-center justify-center rounded-lg p-1.5 transition-colors',
          canRemove
            ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
            : 'text-muted-foreground/30 cursor-not-allowed'
        )}
      >
        <Trash size={14} />
      </button>
    </div>
  );
}

// ─── New Journal Form ─────────────────────────────────────────────────────────

function NewJournalForm({
  accounts,
  initialLines,
  initialDate,
  initialDescription,
  onSuccess,
}: {
  accounts: Account[];
  initialLines?: JournalLine[];
  initialDate?: string;
  initialDescription?: string;
  onSuccess?: (journalId: string) => void;
}) {
  const fetcher = useFetcher<{ ok?: boolean; journal_id?: string; error?: string }>();

  const makeEmptyLine = (): JournalLine => ({
    id: crypto.randomUUID(),
    account_id: '',
    debit: '',
    credit: '',
    currency: 'GBP',
    gbp_equivalent: '',
    line_description: '',
  });

  const [date, setDate] = useState(initialDate || todayISO());
  const [description, setDescription] = useState(initialDescription || '');
  const [journalType, setJournalType] = useState('adjustment');
  const [lines, setLines] = useState<JournalLine[]>(
    initialLines && initialLines.length >= 2 ? initialLines : [makeEmptyLine(), makeEmptyLine()]
  );

  const isSubmitting = fetcher.state !== 'idle';

  // Compute balance
  const getGbpValue = (line: JournalLine, side: 'debit' | 'credit') => {
    const raw = side === 'debit' ? Number(line.debit) || 0 : Number(line.credit) || 0;
    if (raw === 0) return 0;
    if (line.currency !== 'GBP') {
      return Number(line.gbp_equivalent) || 0;
    }
    return raw;
  };

  const totalDebit = lines.reduce((s, l) => s + getGbpValue(l, 'debit'), 0);
  const totalCredit = lines.reduce((s, l) => s + getGbpValue(l, 'credit'), 0);
  const imbalance = Math.abs(totalDebit - totalCredit);
  const isBalanced = imbalance < 0.005;

  const updateLine = useCallback((id: string, updated: JournalLine) => {
    setLines((prev) => prev.map((l) => (l.id === id ? updated : l)));
  }, []);

  const removeLine = useCallback((id: string) => {
    setLines((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const addLine = () => setLines((prev) => [...prev, makeEmptyLine()]);

  // Handle success
  React.useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.journal_id) {
      onSuccess?.(fetcher.data.journal_id);
      // Reset form
      setDescription('');
      setDate(todayISO());
      setLines([makeEmptyLine(), makeEmptyLine()]);
    }
  }, [fetcher.data]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isBalanced) return;

    const payload = lines.map((l) => ({
      account_id: l.account_id,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      currency: l.currency,
      gbp_equivalent: l.currency !== 'GBP' && l.gbp_equivalent ? Number(l.gbp_equivalent) : null,
      line_description: l.line_description || null,
    }));

    fetcher.submit(
      {
        intent: 'createJournal',
        journal_date: date,
        description,
        journal_type: journalType,
        lines: JSON.stringify(payload),
      },
      { method: 'POST', action: '/api/journals' }
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Header fields */}
      <div className="grid grid-cols-[1fr_1fr_180px] gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Date</label>
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Description</label>
          <input
            type="text"
            placeholder="e.g. Write-off gifted stock"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Type</label>
          <select
            value={journalType}
            onChange={(e) => setJournalType(e.target.value)}
            className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="adjustment">Adjustment</option>
            <option value="accrual">Accrual</option>
            <option value="reversal">Reversal</option>
            <option value="expense">Expense</option>
            <option value="purchase">Purchase</option>
          </select>
        </div>
      </div>

      {/* Line items table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {/* Column headers */}
        <div className="grid grid-cols-[1fr_88px_88px_72px_80px_32px] gap-2 px-4 py-2 bg-muted/40 border-b border-border">
          <span className="text-xs font-medium text-muted-foreground">Account</span>
          <span className="text-xs font-medium text-muted-foreground text-right">Debit</span>
          <span className="text-xs font-medium text-muted-foreground text-right">Credit</span>
          <span className="text-xs font-medium text-muted-foreground">Currency</span>
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400 text-right">GBP Equiv</span>
          <span />
        </div>

        {/* Lines */}
        <div className="px-4">
          {lines.map((line) => (
            <LineRow
              key={line.id}
              line={line}
              accounts={accounts}
              onChange={(updated) => updateLine(line.id, updated)}
              onRemove={() => removeLine(line.id)}
              canRemove={lines.length > 2}
            />
          ))}
        </div>

        {/* Totals row */}
        <div className="grid grid-cols-[1fr_88px_88px_72px_80px_32px] gap-2 px-4 py-2 bg-muted/40 border-t border-border">
          <span className="text-xs font-semibold text-foreground">Totals</span>
          <span className="text-xs font-semibold text-right tabular-nums text-foreground">
            {GBP(totalDebit)}
          </span>
          <span className="text-xs font-semibold text-right tabular-nums text-foreground">
            {GBP(totalCredit)}
          </span>
          <span />
          <span />
          <span />
        </div>
      </div>

      {/* Add line button */}
      <button
        type="button"
        onClick={addLine}
        className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors"
      >
        <Plus size={14} weight="bold" />
        Add line
      </button>

      {/* Balance indicator */}
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
          isBalanced
            ? 'bg-green-500/10 text-green-600 dark:text-green-400'
            : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
        )}
      >
        {isBalanced ? (
          <CheckCircle size={14} weight="fill" />
        ) : (
          <Warning size={14} weight="fill" />
        )}
        {isBalanced
          ? `Balanced — debits equal credits (${GBP(totalDebit)})`
          : `Unbalanced — difference of ${GBP(imbalance)} (debits ${GBP(totalDebit)}, credits ${GBP(totalCredit)})`}
      </div>

      {/* Error */}
      {fetcher.data?.error && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs bg-rose-500/10 text-rose-600">
          <Warning size={14} weight="fill" />
          {fetcher.data.error}
        </div>
      )}

      {/* Submit */}
      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={!isBalanced || isSubmitting || lines.some((l) => !l.account_id)}
          className="flex items-center gap-2"
        >
          {isSubmitting ? (
            <SpinnerGap size={14} className="animate-spin" />
          ) : (
            <FloppyDisk size={14} weight="bold" />
          )}
          Post Journal Entry
        </Button>
      </div>
    </form>
  );
}

// ─── Samples Reclassification Card ───────────────────────────────────────────

function SamplesReclassificationCard({
  samples,
  accounts,
  alreadyReclassified,
  onSuccess,
}: {
  samples: SamplesSummary;
  accounts: Account[];
  alreadyReclassified: boolean;
  onSuccess: () => void;
}) {
  const fetcher = useFetcher<{ ok?: boolean; journal_id?: string; gbp_amount?: number; error?: string }>();
  const [expanded, setExpanded] = useState(!alreadyReclassified);
  const [debitAccId, setDebitAccId] = useState('');
  const [creditAccId, setCreditAccId] = useState('');
  const [gbpAmount, setGbpAmount] = useState('');
  const [date, setDate] = useState(todayISO());

  const isSubmitting = fetcher.state !== 'idle';

  React.useEffect(() => {
    if (fetcher.data?.ok) {
      onSuccess();
      setExpanded(false);
    }
  }, [fetcher.data]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetcher.submit(
      {
        intent: 'reclassifySamples',
        debit_account_id: debitAccId,
        credit_account_id: creditAccId,
        gbp_amount: gbpAmount,
        usd_amount: String(samples.usd_total),
        journal_date: date,
      },
      { method: 'POST', action: '/api/journals' }
    );
  };

  if (alreadyReclassified && !expanded) {
    return (
      <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 flex items-start gap-3">
        <CheckCircle size={18} weight="fill" className="text-green-500 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-foreground">Samples already reclassified</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            A reclassification journal has been posted for the {samples.count} sample items.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5">
      {/* Alert header */}
      <div
        className="flex items-start gap-3 p-4 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <Warning size={18} weight="fill" className="text-amber-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">
            Samples in Finished Goods — reclassification needed
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {samples.count} unlinked / sample items ({USD(samples.usd_total)} USD) are currently
            booked as Inventory — Finished Goods assets. They should be expensed to Samples &amp;
            Product Development.
          </p>
        </div>
        <span className="text-xs text-primary font-medium shrink-0">
          {expanded ? 'Collapse' : 'Reclassify now ↓'}
        </span>
      </div>

      {/* Expanded form */}
      {expanded && (
        <form onSubmit={handleSubmit} className="border-t border-amber-500/20 p-4 space-y-4">
          <div className="rounded-lg bg-muted/50 border border-border px-3 py-2 text-xs text-muted-foreground flex items-start gap-2">
            <Info size={14} className="text-primary mt-0.5 shrink-0" />
            <span>
              The unit costs for these items are stored in <strong>USD</strong>. Enter the GBP
              equivalent — the amount that currently appears on your Balance Sheet under Inventory
              — Finished Goods for these {samples.count} items.
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                DR — Samples / Expense account
              </label>
              <AccountSelect
                accounts={accounts}
                value={debitAccId}
                onChange={setDebitAccId}
                placeholder="— Select expense account —"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                CR — Inventory account (Finished Goods)
              </label>
              <AccountSelect
                accounts={accounts}
                value={creditAccId}
                onChange={setCreditAccId}
                placeholder="— Select inventory account —"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                GBP Amount (balance sheet impact)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  £
                </span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  placeholder="673.20"
                  value={gbpAmount}
                  onChange={(e) => setGbpAmount(e.target.value)}
                  className="w-full bg-muted border border-border rounded-lg pl-7 pr-3 py-2 text-sm text-foreground tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                USD total from DB: {USD(samples.usd_total)}
              </p>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Journal Date</label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          {fetcher.data?.error && (
            <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs bg-rose-500/10 text-rose-600">
              <Warning size={14} weight="fill" />
              {fetcher.data.error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setExpanded(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!debitAccId || !creditAccId || !gbpAmount || isSubmitting}
              className="flex items-center gap-2"
            >
              {isSubmitting ? (
                <SpinnerGap size={13} className="animate-spin" />
              ) : (
                <ArrowsDownUp size={13} weight="bold" />
              )}
              Post Reclassification
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ─── Recent Journals Table ────────────────────────────────────────────────────

function RecentJournalsTable({ journals }: { journals: RecentJournal[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (journals.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <BookOpen size={28} className="text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No manual journal entries yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">
              Date
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">
              Description
            </th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">
              Type
            </th>
            <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">
              Amount (GBP)
            </th>
            <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground" />
          </tr>
        </thead>
        <tbody>
          {journals.map((j) => (
            <React.Fragment key={j.id}>
              <tr
                className="border-b border-border/60 hover:bg-muted/30 cursor-pointer transition-colors"
                onClick={() => setExpanded(expanded === j.id ? null : j.id)}
              >
                <td className="px-4 py-2.5 text-sm text-foreground tabular-nums">{j.journal_date}</td>
                <td className="px-4 py-2.5 text-sm text-foreground max-w-xs truncate">
                  {j.description ?? <span className="text-muted-foreground italic">No description</span>}
                </td>
                <td className="px-4 py-2.5">
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                    {TYPE_LABELS[j.journal_type] ?? j.journal_type}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-sm text-right tabular-nums text-foreground">
                  {GBP(j.gbp_total)}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground text-right">
                  {expanded === j.id ? '▲' : '▼'}
                </td>
              </tr>

              {/* Expanded line items */}
              {expanded === j.id && (
                <tr>
                  <td colSpan={5} className="px-4 pb-3 pt-0 bg-muted/20">
                    <div className="rounded-lg border border-border overflow-hidden mt-1">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-muted/40">
                            <th className="px-3 py-1.5 text-left text-muted-foreground">Account</th>
                            <th className="px-3 py-1.5 text-right text-muted-foreground">Debit</th>
                            <th className="px-3 py-1.5 text-right text-muted-foreground">Credit</th>
                            <th className="px-3 py-1.5 text-left text-muted-foreground">Currency</th>
                            <th className="px-3 py-1.5 text-right text-muted-foreground">GBP Equiv</th>
                          </tr>
                        </thead>
                        <tbody>
                          {j.lines.map((l, i) => (
                            <tr key={i} className="border-t border-border/40">
                              <td className="px-3 py-1.5 text-foreground">
                                {l.account_number} — {l.account_name}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-foreground">
                                {l.debit > 0 ? GBP(l.debit) : '—'}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-foreground">
                                {l.credit > 0 ? GBP(l.credit) : '—'}
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground">{l.currency}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-amber-600 dark:text-amber-400">
                                {l.gbp_equivalent != null ? GBP(l.gbp_equivalent) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function JournalsPage() {
  const { accounts, recentJournals, samples, alreadyReclassified } =
    useLoaderData<typeof loader>();

  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const handleSuccess = useCallback((journalId?: string) => {
    setSuccessBanner(
      `Journal posted successfully${journalId ? ` (${journalId.slice(0, 8)}…)` : ''}.`
    );
    setTimeout(() => setSuccessBanner(null), 6000);
  }, []);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Journal Entries</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Record manual accounting adjustments, write-offs, and reclassifications. All entries post
          immediately to your financial reports.
        </p>
      </div>

      {/* Success banner */}
      {successBanner && (
        <div className="flex items-center gap-2 rounded-xl px-4 py-3 bg-green-500/10 border border-green-500/30 text-sm text-green-600 dark:text-green-400">
          <CheckCircle size={16} weight="fill" />
          {successBanner}
        </div>
      )}

      {/* Samples reclassification quick action */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
          <CurrencyDollar size={14} />
          Quick Actions
        </h2>
        <SamplesReclassificationCard
          samples={samples}
          accounts={accounts}
          alreadyReclassified={alreadyReclassified}
          onSuccess={() => handleSuccess()}
        />
      </section>

      {/* Manual journal form */}
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
          <BookOpen size={15} weight="duotone" />
          New Journal Entry
        </h2>
        <NewJournalForm
          accounts={accounts}
          onSuccess={(id) => handleSuccess(id)}
        />
      </section>

      {/* Recent journals */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Recent Manual Journals
        </h2>
        <RecentJournalsTable journals={recentJournals} />
      </section>
    </div>
  );
}
