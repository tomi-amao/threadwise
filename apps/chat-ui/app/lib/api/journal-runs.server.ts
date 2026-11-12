/**
 * The record of journal generation runs, read as the signed-in user, so row-level security
 * decides which runs exist. The agent writes these rows; nothing here changes them.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type JournalRunStatus =
  'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

export interface JournalRun {
  id: string;
  entityId: string;
  scope: string;
  status: JournalRunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  created: number;
  skipped: number;
  errors: number;
  failureReason: string | null;
}

/** One error on one item, as the pipeline step recorded it. */
export interface JournalRunItemError {
  error: string;
  payment_id?: string;
  transaction_id?: string;
}

export interface JournalRunStep {
  step: string;
  title: string;
  status: 'completed' | 'error';
  created?: number;
  skipped?: number;
  /** Why the whole step failed, when it did. */
  error?: string;
  errors?: JournalRunItemError[];
  /** How many errors there were; `errors` keeps only the first ones. */
  errors_total?: number;
}

export interface JournalRunDetail extends JournalRun {
  steps: JournalRunStep[];
}

const LIST_COLUMNS =
  'id, entity_id, scope, status, created_at, started_at, finished_at, total_created, total_skipped, total_errors, failure_reason';

/** More than anyone reads, and a list of runs needs no paging from the server. */
const MAX_RUNS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toRun(row: Record<string, unknown>): JournalRun {
  return {
    id: row.id as string,
    entityId: row.entity_id as string,
    scope: row.scope as string,
    status: row.status as JournalRunStatus,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    created: Number(row.total_created ?? 0),
    skipped: Number(row.total_skipped ?? 0),
    errors: Number(row.total_errors ?? 0),
    failureReason: (row.failure_reason as string | null) ?? null,
  };
}

export async function getJournalRuns(supabase: SupabaseClient): Promise<JournalRun[]> {
  const { data, error } = await supabase
    .from('journal_generation_runs')
    .select(LIST_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(MAX_RUNS);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => toRun(row as Record<string, unknown>));
}

/** One run, or null if it does not exist or is another business's. */
export async function getJournalRunDetail(
  supabase: SupabaseClient,
  id: string
): Promise<JournalRunDetail | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await supabase
    .from('journal_generation_runs')
    .select(`${LIST_COLUMNS}, steps`)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return { ...toRun(row), steps: (row.steps as JournalRunStep[]) ?? [] };
}
