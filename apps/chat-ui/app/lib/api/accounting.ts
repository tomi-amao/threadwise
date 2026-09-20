/**
 * Accounting API Service
 *
 * Client-side operations for journal creation and accounting:
 * - Accrue payments (revenue recognition)
 * - Settle gateway payouts (cash recognition)
 * - Journal categorized expenses
 * - Journal invoices (purchase/sale/payment)
 * - List journals
 */

import { getApiBaseUrl } from './base-url';

// ============================================================================
// Types
// ============================================================================

export interface JournalLineItem {
  id: string;
  account_id: string;
  debit: number;
  credit: number;
  currency: string;
  description: string | null;
  effective_date: string;
}

export interface Journal {
  id: string;
  entity_id: string;
  journal_date: string;
  journal_type:
    | 'accrual'
    | 'settlement'
    | 'adjustment'
    | 'reversal'
    | 'purchase'
    | 'expense'
    | 'payment';
  description: string | null;
  source_type: string | null;
  source_id: string | null;
  status: 'draft' | 'posted' | 'reversed';
  posted_at: string | null;
  reversed_by_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  line_items?: JournalLineItem[];
}

// ============================================================================
// Generate-All Pipeline: types for the *realtime* progress payloads
// (JournalStepProgressData / JournalPipelineStatusData) live in
// JournalGenerationModal.tsx itself, mirroring SyncProgressToast's
// convention — the pipeline no longer returns its result synchronously
// (see generateAllJournals below), it streams progress over
// `journals:{entityId}` instead.
// ============================================================================

// ============================================================================
// Journal Creation
// ============================================================================

// ============================================================================
// Chart of Accounts
// ============================================================================

export interface ChartOfAccountEntry {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
  is_header: boolean;
}

/**
 * Fetch the full chart of accounts from the AI agent.
 * The table is not entity-scoped so entity_id is passed for API compat only.
 */
export async function fetchChartOfAccounts(entityId: string): Promise<ChartOfAccountEntry[]> {
  const baseUrl = getApiBaseUrl();
  const params = new URLSearchParams({ entity_id: entityId });
  const response = await fetch(`${baseUrl}/accounting/chart-of-accounts?${params}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch chart of accounts: ${errorText}`);
  }
  const data = await response.json();
  // API returns { entity_id, accounts: [...] }
  return (data.accounts ?? []) as ChartOfAccountEntry[];
}

// ============================================================================
// Generate All Journals (Full Pipeline)
// ============================================================================

// ============================================================================
// Review Summary
// ============================================================================

export interface ReviewSummary {
  entity_id: string;
  summary: {
    draft_journals_total: number;
    needs_review: boolean;
  };
  draft_journals: Journal[];
  draft_journals_by_type: Record<string, number>;
}

/**
 * Fetch items needing human review after journal generation.
 * Returns draft journals that need manual account assignment.
 */
export async function fetchReviewSummary(entityId: string): Promise<ReviewSummary> {
  const baseUrl = getApiBaseUrl();
  const params = new URLSearchParams({ entity_id: entityId });
  const response = await fetch(`${baseUrl}/accounting/journals/review-summary?${params}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch review summary: ${errorText}`);
  }

  return response.json();
}

export interface DraftAccountSuggestion {
  account_id: string | null;
  confidence: number;
  reasoning: string;
}

/**
 * Advisory-only: ask an LLM to guess the right account for draft journals,
 * to pre-fill the Review tab's picker with a suggestion the user still has
 * to confirm before posting. Never posts anything itself. Omitting
 * `journalIds` suggests for every current draft.
 */
export async function suggestDraftAccounts(
  entityId: string,
  journalIds?: string[]
): Promise<Record<string, DraftAccountSuggestion>> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/accounting/journals/suggest-accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_id: entityId,
      ...(journalIds && { journal_ids: journalIds }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to suggest draft accounts: ${errorText}`);
  }

  const data = await response.json();
  return data.suggestions ?? {};
}

export type JournalScope = 'payments' | 'transactions' | 'all';

export interface TriggerGenerateAllResponse {
  entity_id: string;
  scope: string;
  status: 'triggered';
  message: string;
}

/**
 * Fix a draft journal's miscategorised line and post it — the Review tab's
 * action. Every draft journal this pipeline produces has one line on the
 * uncategorised fallback account (8090); this repoints it at `accountId`
 * and flips the journal to 'posted' in one atomic step.
 */
export async function postDraftJournal(
  entityId: string,
  journalId: string,
  accountId: string
): Promise<Journal> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/accounting/journals/${journalId}/post-draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_id: entityId, account_id: accountId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to post draft journal: ${errorText}`);
  }

  return response.json();
}

/**
 * Trigger the journal-generation pipeline. Returns as soon as the backend
 * has queued the background job — it does not wait for the pipeline to
 * finish. Subscribe to the `journals:{entityId}` realtime channel (see
 * JournalGenerationModal) for live progress instead of polling.
 */
export async function generateAllJournals(
  entityId: string,
  scope?: JournalScope
): Promise<TriggerGenerateAllResponse> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/accounting/journals/generate-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_id: entityId,
      ...(scope && scope !== 'all' && { scope }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to generate journals: ${errorText}`);
  }

  return response.json();
}
