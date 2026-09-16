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

// Get the AI Agent API base URL
function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return import.meta.env?.VITE_AI_AGENT_URL || 'http://localhost:2024';
  }
  return process.env.AI_AGENT_URL || process.env.VITE_AI_AGENT_URL || 'http://localhost:2024';
}

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
// Generate-All Pipeline Types
// ============================================================================

export interface PipelineStepResult {
  step: string;
  title: string;
  status: 'running' | 'completed' | 'error';
  error?: string;
  // Journal creation (payments / settlements / inbound / expenses)
  payments_processed?: number;
  settlements_processed?: number;
  transactions_processed?: number;
  created?: number;
  skipped?: number;
  errors?: Array<{
    payment_id?: string;
    transaction_id?: string;
    error: string;
  }>;
  // journal_inbound step extras
  passthrough?: {
    classified: number;
    skipped: number;
    already_classified?: number;
    total_pairs?: number;
    total_pairs_examined?: number;
  };
  by_type?: Record<
    string,
    {
      total: number;
      created: number;
      skipped: number;
      errors: Array<{ transaction_id: string; error: string }>;
    }
  >;
}

export interface PipelineError {
  step: string;
  source_id?: string;
  error: string;
}

export interface GenerateAllResult {
  entity_id: string;
  status: 'completed' | 'completed_with_errors';
  steps: PipelineStepResult[];
  summary: {
    total_journals_created: number;
    total_skipped: number;
    total_errors: number;
    failed_steps: string[];
  };
  errors: PipelineError[];
  started_at: string;
  completed_at: string;
}

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

export type JournalScope = 'payments' | 'transactions' | 'all';

export async function generateAllJournals(
  entityId: string,
  scope?: JournalScope
): Promise<GenerateAllResult> {
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
