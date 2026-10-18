/**
 * Journals: server-side reads, and the writes the page can make.
 *
 * Reads run as the signed-in user (row-level security). A manual journal is written in one
 * atomic database call after its accounts have been checked against the user's own chart of
 * accounts. Reversing a journal and posting a draft go to the agent, which owns the ledger and
 * enforces the period locks; this module only passes its refusal on.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabaseClient } from '~/lib/supabase';
import { AgentError, callAgent, jsonInit } from './invoices.server';
import { fetchAllRows } from './paginate.server';

export type JournalStatus = 'draft' | 'posted' | 'reversed';

export interface LedgerAccount {
  id: string;
  number: string;
  name: string;
  type: string;
}

export interface JournalRow {
  id: string;
  date: string;
  type: string;
  status: JournalStatus;
  description: string;
  sourceType: string | null;
  /** True when a person wrote it (rather than the system, from an order, payment or bank line). */
  manual: boolean;
  lineCount: number;
  /** What moved, in the business's currency: the debits (equal to the credits when it balances). */
  amount: number;
  /** Account numbers it touches, for searching. */
  accounts: string[];
}

export interface JournalsData {
  journals: JournalRow[];
  accounts: LedgerAccount[];
  /** The account draft journals are parked on until a person chooses. */
  fallbackAccountId: string | null;
}

export interface JournalDetail {
  id: string;
  date: string;
  type: string;
  status: JournalStatus;
  description: string;
  sourceType: string | null;
  sourceId: string | null;
  postedAt: string | null;
  reversedById: string | null;
  lines: {
    id: string;
    accountId: string;
    accountNumber: string;
    accountName: string;
    debit: number;
    credit: number;
    currency: string;
    memo: string | null;
  }[];
  totalDebit: number;
  totalCredit: number;
}

const FALLBACK_ACCOUNT = '8090';

export const MANUAL_TYPES = ['adjustment', 'accrual', 'expense', 'payment', 'funding'] as const;

const gbp = (n: number | string | null | undefined) => Number(n ?? 0);

export async function getJournalsData(supabase: SupabaseClient): Promise<JournalsData> {
  const [accountRows, headers, lines] = await Promise.all([
    fetchAllRows<{
      id: string;
      account_number: string | number;
      name: string;
      account_type: string;
    }>('accounts', (from, to) =>
      supabase
        .from('chart_of_accounts')
        .select('id, account_number, name, account_type')
        .eq('is_header', false)
        .order('id')
        .range(from, to)
    ),
    fetchAllRows<{
      id: string;
      journal_date: string;
      journal_type: string;
      status: JournalStatus;
      description: string | null;
      source_type: string | null;
    }>('journals', (from, to) =>
      supabase
        .from('journals')
        .select('id, journal_date, journal_type, status, description, source_type')
        .order('id')
        .range(from, to)
    ),
    fetchAllRows<{
      journal_id: string;
      account_id: string;
      debit: number | string;
      credit: number | string;
      currency: string;
      gbp_equivalent: number | string | null;
    }>('journal lines', (from, to) =>
      supabase
        .from('journal_line_items')
        .select('id, journal_id, account_id, debit, credit, currency, gbp_equivalent')
        .order('id')
        .range(from, to)
    ),
  ]);

  const accounts: LedgerAccount[] = accountRows
    .map(a => ({
      id: a.id,
      number: String(a.account_number),
      name: a.name,
      type: a.account_type,
    }))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  const numberOf = new Map(accounts.map(a => [a.id, a.number]));

  const byJournal = new Map<string, { count: number; amount: number; accounts: Set<string> }>();
  for (const l of lines) {
    const entry = byJournal.get(l.journal_id) ?? { count: 0, amount: 0, accounts: new Set() };
    entry.count += 1;
    const debit = gbp(l.debit);
    if (debit > 0) {
      entry.amount +=
        l.currency !== 'GBP' && l.gbp_equivalent != null ? gbp(l.gbp_equivalent) : debit;
    }
    const number = numberOf.get(l.account_id);
    if (number) entry.accounts.add(number);
    byJournal.set(l.journal_id, entry);
  }

  const journals: JournalRow[] = headers
    .map(h => {
      const entry = byJournal.get(h.id);
      return {
        id: h.id,
        date: h.journal_date.slice(0, 10),
        type: h.journal_type,
        status: h.status,
        description: h.description ?? '',
        sourceType: h.source_type,
        manual: h.source_type === 'manual',
        lineCount: entry?.count ?? 0,
        amount: Math.round((entry?.amount ?? 0) * 100) / 100,
        accounts: [...(entry?.accounts ?? [])],
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  return {
    journals,
    accounts,
    fallbackAccountId: accounts.find(a => a.number === FALLBACK_ACCOUNT)?.id ?? null,
  };
}

/** One journal with its lines; null when the user cannot see it. */
export async function getJournalDetail(
  supabase: SupabaseClient,
  id: string
): Promise<JournalDetail | null> {
  const { data: journal, error } = await supabase
    .from('journals')
    .select(
      'id, journal_date, journal_type, status, description, source_type, source_id, posted_at, reversed_by_id'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!journal) return null;

  const { data: lineRows, error: linesError } = await supabase
    .from('journal_line_items')
    .select(
      'id, account_id, debit, credit, currency, description, chart_of_accounts(account_number, name)'
    )
    .eq('journal_id', id)
    .order('created_at')
    .order('id');
  if (linesError) throw new Error(linesError.message);

  const lines = (lineRows ?? []).map(l => {
    const account = l.chart_of_accounts as unknown as {
      account_number: string | number;
      name: string;
    } | null;
    return {
      id: l.id as string,
      accountId: l.account_id as string,
      accountNumber: String(account?.account_number ?? ''),
      accountName: account?.name ?? 'Unknown account',
      debit: gbp(l.debit),
      credit: gbp(l.credit),
      currency: (l.currency as string) ?? 'GBP',
      memo: (l.description as string | null) ?? null,
    };
  });

  return {
    id: journal.id,
    date: String(journal.journal_date).slice(0, 10),
    type: journal.journal_type,
    status: journal.status,
    description: journal.description ?? '',
    sourceType: journal.source_type,
    sourceId: journal.source_id,
    postedAt: journal.posted_at,
    reversedById: journal.reversed_by_id,
    lines,
    totalDebit: Math.round(lines.reduce((s, l) => s + l.debit, 0) * 100) / 100,
    totalCredit: Math.round(lines.reduce((s, l) => s + l.credit, 0) * 100) / 100,
  };
}

// ─── Writes ───────────────────────────────────────────────────────────

export type JournalActionResult =
  | { ok: true; message: string; id?: string; suggestions?: Record<string, unknown> }
  | { ok: false; error: string; status?: number };

const fail = (error: string, status = 400): JournalActionResult => ({ ok: false, error, status });
const cents = (n: number) => Math.round(n * 100);

interface DraftLine {
  accountId: string;
  debit: number;
  credit: number;
  memo: string;
}

/** Write a manual journal, posted. The accounts must be ones in the user's own chart. */
export async function createManualJournal(
  supabase: SupabaseClient,
  entityId: string,
  form: FormData
): Promise<JournalActionResult> {
  const date = String(form.get('date') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    return fail('Choose the date of the journal.');
  }
  if (date > new Date().toISOString().slice(0, 10))
    return fail('A journal cannot be dated in the future.');

  const type = String(form.get('type') ?? 'adjustment');
  if (!(MANUAL_TYPES as readonly string[]).includes(type))
    return fail('Choose a type from the list.');
  const description = String(form.get('description') ?? '').trim();
  if (description.length < 3) return fail('Say briefly what this journal is for.');
  if (description.length > 200) return fail('Keep the description under 200 characters.');

  let lines: DraftLine[];
  try {
    const raw = JSON.parse(String(form.get('lines') ?? '[]')) as {
      accountId?: string;
      debit?: number | string;
      credit?: number | string;
      memo?: string;
    }[];
    lines = raw.map(l => ({
      accountId: String(l.accountId ?? ''),
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      memo: String(l.memo ?? '')
        .trim()
        .slice(0, 200),
    }));
  } catch {
    return fail('The lines could not be read.');
  }
  if (lines.length < 2) return fail('A journal needs at least two lines.');
  for (const [i, l] of lines.entries()) {
    if (!l.accountId) return fail(`Choose an account for line ${i + 1}.`);
    if (l.debit < 0 || l.credit < 0) return fail(`Line ${i + 1} cannot be negative.`);
    if (l.debit > 0 === l.credit > 0) {
      return fail(`Line ${i + 1} needs either a debit or a credit, not both or neither.`);
    }
  }
  const debit = lines.reduce((s, l) => s + cents(l.debit), 0);
  const credit = lines.reduce((s, l) => s + cents(l.credit), 0);
  if (debit !== credit) {
    return fail(
      `Debits and credits must match. Debits are £${(debit / 100).toFixed(2)} and credits £${(credit / 100).toFixed(2)}.`
    );
  }

  // The accounts must be the user's own (readable under row-level security), not a guessed id.
  const ids = [...new Set(lines.map(l => l.accountId))];
  const { data: owned, error: ownedError } = await supabase
    .from('chart_of_accounts')
    .select('id, is_header')
    .in('id', ids);
  if (ownedError) return fail(ownedError.message, 500);
  if ((owned ?? []).length !== ids.length || (owned ?? []).some(a => a.is_header)) {
    return fail('One of the accounts is not available. Choose again.');
  }

  const { data, error } = await getServerSupabaseClient().rpc('upsert_journal_with_lines', {
    p_entity_id: entityId,
    p_journal_date: date,
    p_journal_type: type,
    p_description: description,
    p_source_type: 'manual',
    p_source_id: null,
    p_status: 'posted',
    p_metadata: { created_by: 'journals_page' },
    p_line_items: lines.map(l => ({
      account_id: l.accountId,
      debit: l.debit,
      credit: l.credit,
      currency: 'GBP',
      description: l.memo || null,
    })),
  });
  if (error) {
    if (/period is locked/i.test(error.message)) {
      return fail('That date falls in a period that has been closed. Choose a later date.', 409);
    }
    return fail(error.message, 500);
  }
  return { ok: true, message: 'Journal posted', id: data as string };
}

async function visibleJournal(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from('journals')
    .select('id, status, entity_id, description')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as {
    id: string;
    status: JournalStatus;
    entity_id: string;
    description: string | null;
  } | null;
}

const agentFail = (error: unknown): JournalActionResult =>
  error instanceof AgentError
    ? fail(error.message, error.status)
    : fail(error instanceof Error ? error.message : 'That did not work', 500);

/** Take a posted journal out of the books. The agent refuses it inside a closed period. */
export async function reverseJournal(
  supabase: SupabaseClient,
  entityId: string,
  id: string
): Promise<JournalActionResult> {
  const journal = await visibleJournal(supabase, id);
  if (!journal) return fail('That journal was not found.', 404);
  if (journal.status !== 'posted') return fail('Only a posted journal can be reversed.');
  try {
    await callAgent(
      `/accounting/journals/${id}/reverse`,
      jsonInit('POST', { entity_id: entityId })
    );
    return { ok: true, message: 'Journal reversed. It no longer counts in any total.' };
  } catch (error) {
    return agentFail(error);
  }
}

/** Choose the account for a draft and post it. */
export async function postDraft(
  supabase: SupabaseClient,
  entityId: string,
  id: string,
  accountId: string
): Promise<JournalActionResult> {
  const journal = await visibleJournal(supabase, id);
  if (!journal) return fail('That journal was not found.', 404);
  if (journal.status !== 'draft') return fail('That journal is not waiting for review.');
  const { data: account } = await supabase
    .from('chart_of_accounts')
    .select('id, is_header')
    .eq('id', accountId)
    .maybeSingle();
  if (!account || account.is_header) return fail('Choose an account from the list.');
  try {
    await callAgent(
      `/accounting/journals/${id}/post-draft`,
      jsonInit('POST', { entity_id: entityId, account_id: accountId })
    );
    return { ok: true, message: 'Journal posted' };
  } catch (error) {
    return agentFail(error);
  }
}

/** Ask the agent to guess an account for each draft. Advice only: nothing is posted. */
export async function suggestForDrafts(
  entityId: string,
  journalIds: string[]
): Promise<JournalActionResult> {
  try {
    const result = await callAgent<{ suggestions?: Record<string, unknown> }>(
      '/accounting/journals/suggest-accounts',
      jsonInit('POST', { entity_id: entityId, journal_ids: journalIds })
    );
    return { ok: true, message: 'Suggestions ready', suggestions: result.suggestions ?? {} };
  } catch (error) {
    return agentFail(error);
  }
}
