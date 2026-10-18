/**
 * ReviewTab: draft journals waiting for a person. The system could tell money moved but not what
 * it was for, so it parked one side on "Uncategorised". Choose the account and post it; or ask
 * for a suggestion first (advice only: nothing posts until you do).
 */

import { useEffect, useMemo, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import { Sparkle } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import { FIELD_TRIGGER_CLASS, SearchableSelect } from '~/components/ui/searchable-select';
import type { JournalRow, LedgerAccount } from '~/lib/api/journals.server';
import { money, shortDate, typeLabel } from './model';

interface Suggestion {
  account_id: string | null;
  confidence: number;
  reasoning: string;
}

type Result = {
  ok: boolean;
  error?: string;
  message?: string;
  suggestions?: Record<string, Suggestion>;
};

export function ReviewTab({
  drafts,
  accounts,
  fallbackAccountId,
  onOpen,
}: {
  drafts: JournalRow[];
  accounts: LedgerAccount[];
  fallbackAccountId: string | null;
  onOpen: (id: string) => void;
}) {
  const suggest = useFetcher<Result>();
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});

  useEffect(() => {
    if (suggest.state !== 'idle' || !suggest.data) return;
    if (suggest.data.ok)
      setSuggestions(prev => ({ ...prev, ...(suggest.data?.suggestions ?? {}) }));
    else toast.error(suggest.data.error ?? 'Could not get suggestions');
  }, [suggest.state, suggest.data]);

  const options = useMemo(
    () =>
      accounts
        .filter(a => a.id !== fallbackAccountId)
        .map(a => ({
          value: a.id,
          label: `${a.number} · ${a.name}`,
          group: a.type.replace(/^./, c => c.toUpperCase()),
        })),
    [accounts, fallbackAccountId]
  );

  if (drafts.length === 0) {
    return (
      <EmptyState
        title="Nothing to review."
        description="Every journal the system wrote has an account."
      />
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <p className="max-w-xl text-[14px] text-text-2">
          These were written from your bank and orders, but the system could not tell what each was
          for. Choose the account and post it. Until then they are in no total.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={suggest.state !== 'idle'}
          onClick={() => {
            const form = new FormData();
            form.set('intent', 'suggest');
            form.set('journalIds', JSON.stringify(drafts.map(d => d.id)));
            suggest.submit(form, { method: 'POST' });
          }}
        >
          <Sparkle size={14} weight="light" aria-hidden />{' '}
          {suggest.state !== 'idle' ? 'Thinking…' : 'Suggest accounts'}
        </Button>
      </div>
      <DataTable label="Journals needing review" bare surface="page">
        <thead>
          <tr>
            <th>Journal</th>
            <th className="text-right">Amount</th>
            <th>Account</th>
            <th>
              <span className="sr-only">Post</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {drafts.map(d => (
            <DraftRow
              key={d.id}
              draft={d}
              options={options}
              suggestion={suggestions[d.id]}
              onOpen={() => onOpen(d.id)}
            />
          ))}
        </tbody>
      </DataTable>
    </>
  );
}

function DraftRow({
  draft,
  options,
  suggestion,
  onOpen,
}: {
  draft: JournalRow;
  options: { value: string; label: string; group: string }[];
  suggestion: Suggestion | undefined;
  onOpen: () => void;
}) {
  const fetcher = useFetcher<Result>();
  const [chosen, setChosen] = useState('');
  const accountId = chosen || suggestion?.account_id || '';
  const busy = fetcher.state !== 'idle';

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    if (fetcher.data.ok) toast.success(fetcher.data.message ?? 'Journal posted');
  }, [fetcher.state, fetcher.data]);

  return (
    <tr>
      <td>
        <button
          type="button"
          onClick={onOpen}
          className="block max-w-[320px] rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="block truncate">{draft.description || typeLabel(draft.type)}</span>
          <span className="block text-[13px] text-text-2">{shortDate(draft.date)}</span>
        </button>
      </td>
      <td className="whitespace-nowrap text-right tabular-nums">{money(draft.amount)}</td>
      <td className="min-w-[240px]">
        <SearchableSelect
          options={options}
          value={accountId}
          onChange={setChosen}
          placeholder="Choose an account"
          aria-label={`Account for ${draft.description || 'journal'}`}
          className={FIELD_TRIGGER_CLASS}
        />
        {!chosen && suggestion?.account_id && (
          <p className="mt-1 text-[12px] text-text-2">Suggested: {suggestion.reasoning}</p>
        )}
        {fetcher.data && !fetcher.data.ok && (
          <p role="alert" className="mt-1 text-[13px] text-destructive">
            {fetcher.data.error}
          </p>
        )}
      </td>
      <td className="text-right">
        <Button
          size="sm"
          disabled={!accountId || busy}
          aria-label={`Post ${draft.description || 'journal'}`}
          onClick={() => {
            const form = new FormData();
            form.set('intent', 'postDraft');
            form.set('journalId', draft.id);
            form.set('accountId', accountId);
            fetcher.submit(form, { method: 'POST' });
          }}
        >
          {busy ? 'Posting…' : 'Post'}
        </Button>
      </td>
    </tr>
  );
}
