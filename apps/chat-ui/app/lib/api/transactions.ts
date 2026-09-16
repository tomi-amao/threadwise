/**
 * Transactions API Client
 *
 * Client-side service for financial transaction search, detail fetch, and update.
 * All requests go to the AI Agent backend (FastAPI).
 */

function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return import.meta.env?.VITE_AI_AGENT_URL || 'http://localhost:2024';
  }
  return process.env.AI_AGENT_URL || process.env.VITE_AI_AGENT_URL || 'http://localhost:2024';
}

// ============================================================================
// Types
// ============================================================================

export type TransactionSource = 'revolut' | 'paypal';
export type TransactionDirection = 'in' | 'out';
export type TransactionType =
  | 'payment'
  | 'transfer'
  | 'expense'
  | 'fee'
  | 'fx_conversion'
  | 'refund'
  | 'funding'
  | 'payout'
  | 'reserve_hold'
  | 'reserve_release'
  | 'other';

export interface FinancialTransaction {
  id: string;
  entity_id: string;
  source: TransactionSource;
  external_transaction_id: string;
  amount: number;
  currency_code: string;
  direction: TransactionDirection;
  transaction_type: TransactionType;
  occurred_at: string;
  description: string | null;
  counterparty_name: string | null;
  status: string | null;
  excluded_reason: string | null;
  journalised_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface JournalLineItemWithAccount {
  id: string;
  journal_id: string;
  account_id: string;
  account_number: string | null;
  account_name: string | null;
  account_type: string | null;
  debit: number;
  credit: number;
  currency: string;
  description: string | null;
  effective_date: string | null;
}

export interface TransactionJournal {
  id: string;
  entity_id: string;
  journal_date: string;
  journal_type: string;
  description: string | null;
  source_type: string;
  source_id: string;
  status: 'draft' | 'posted' | 'reversed';
  posted_at: string | null;
  reversed_by_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  line_items?: JournalLineItemWithAccount[];
}

export interface ListTransactionsParams {
  entityId: string;
  search?: string;
  source?: string;
  direction?: string;
  transactionType?: string;
  txnStatus?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface ListTransactionsResponse {
  entity_id: string;
  transactions: FinancialTransaction[];
  total_count: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface TransactionDetailResponse {
  transaction: FinancialTransaction;
  journal: TransactionJournal | null;
}

export interface UpdateTransactionPayload {
  description?: string;
  counterparty_name?: string;
  account_code?: string;
  expense_category?: string;
  excluded_reason?: string;
  re_journal?: boolean;
}

export interface UpdateTransactionResponse {
  transaction: FinancialTransaction;
  journal_action: 'none' | 'reversed' | 'reversed_and_recreated' | 'reversed_only';
  new_journal: TransactionJournal | null;
  re_journal_needed: boolean;
}

// ============================================================================
// API Functions
// ============================================================================

export async function listTransactions(
  params: ListTransactionsParams
): Promise<ListTransactionsResponse> {
  const baseUrl = getApiBaseUrl();
  const query = new URLSearchParams({ entity_id: params.entityId });

  if (params.search) query.set('search', params.search);
  if (params.source) query.set('source', params.source);
  if (params.direction) query.set('direction', params.direction);
  if (params.transactionType) query.set('transaction_type', params.transactionType);
  if (params.txnStatus) query.set('txn_status', params.txnStatus);
  if (params.dateFrom) query.set('date_from', params.dateFrom);
  if (params.dateTo) query.set('date_to', params.dateTo);
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('page_size', String(params.pageSize));

  const response = await fetch(`${baseUrl}/accounting/transactions?${query}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to list transactions: ${text}`);
  }
  return response.json();
}

export async function getTransaction(
  entityId: string,
  transactionId: string
): Promise<TransactionDetailResponse> {
  const baseUrl = getApiBaseUrl();
  const query = new URLSearchParams({ entity_id: entityId });
  const response = await fetch(`${baseUrl}/accounting/transactions/${transactionId}?${query}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch transaction: ${text}`);
  }
  return response.json();
}

export async function updateTransaction(
  entityId: string,
  transactionId: string,
  payload: UpdateTransactionPayload
): Promise<UpdateTransactionResponse> {
  const baseUrl = getApiBaseUrl();
  const query = new URLSearchParams({ entity_id: entityId });
  const response = await fetch(`${baseUrl}/accounting/transactions/${transactionId}?${query}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update transaction: ${text}`);
  }
  return response.json();
}
