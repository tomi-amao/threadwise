/**
 * Accounting API Service
 *
 * Client-side operations for journal creation and accounting:
 * - Accrue orders (revenue recognition)
 * - Settle reconciled payouts
 * - Journal categorized expenses
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

export interface BatchJournalResult {
  created: number;
  skipped: number;
  errors: string[];
  journals?: Array<{ id: string; description: string }>;
}

export interface ListJournalsResponse {
  entity_id: string;
  journals: Journal[];
  count: number;
}

// ============================================================================
// Journal Creation
// ============================================================================

/**
 * Create accrual journals for completed orders.
 * DR Payment Gateway Clearing (1200) = grand_total
 * CR Revenue (4000), Shipping Revenue (4100), Tax Payable (2100)
 */
export async function accrueOrders(
  entityId: string,
  orderIds?: string[]
): Promise<BatchJournalResult> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/accounting/journals/accrue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_id: entityId,
      ...(orderIds && { order_ids: orderIds }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to accrue orders: ${errorText}`);
  }

  return response.json();
}

/**
 * Create settlement journals for reconciled payouts.
 * DR Cash (1000/1100) + Processing Fees (5000)
 * CR Payment Gateway Clearing (1200)
 */
export async function settleMatches(
  entityId: string,
  matchIds?: string[]
): Promise<BatchJournalResult> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/accounting/journals/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_id: entityId,
      ...(matchIds && { match_ids: matchIds }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to settle matches: ${errorText}`);
  }

  return response.json();
}

/**
 * Create expense journals for categorized bank transactions.
 * DR 6xxx Expense account
 * CR Cash (1000/1100)
 */
export async function journalExpenses(
  entityId: string,
  transactionIds?: string[]
): Promise<BatchJournalResult> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/accounting/journals/expense`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_id: entityId,
      ...(transactionIds && { transaction_ids: transactionIds }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to journal expenses: ${errorText}`);
  }

  return response.json();
}

// ============================================================================
// Journal Listing
// ============================================================================

/**
 * List journals with optional filters.
 */
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

export async function listJournals(
  entityId: string,
  journalType?: string,
  statusFilter?: string,
  limit: number = 100
): Promise<ListJournalsResponse> {
  const baseUrl = getApiBaseUrl();
  const params = new URLSearchParams({ entity_id: entityId });
  if (journalType) params.set('journal_type', journalType);
  if (statusFilter) params.set('status_filter', statusFilter);
  params.set('limit', String(limit));

  const response = await fetch(`${baseUrl}/accounting/journals?${params}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list journals: ${errorText}`);
  }

  return response.json();
}
