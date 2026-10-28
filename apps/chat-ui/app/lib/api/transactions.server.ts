/**
 * Transactions: server-side reads.
 *
 * Callers pass the signed-in user's Supabase client, so row-level security limits every read to
 * their own business, and each query also filters by `entityId` (from getUserEntity()). Only
 * reads live here: an edit can reverse or recreate a journal, so it still goes to the agent
 * (updateTransaction in transactions.ts).
 *
 * The shapes match the agent's /accounting/transactions responses, which the page was built on.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabaseClient } from '~/lib/supabase';
import type {
  FinancialTransaction,
  TransactionAttachment,
  JournalLineItemWithAccount,
  ListTransactionsResponse,
  TransactionDetailResponse,
  TransactionJournal,
} from './transactions';

export interface TransactionQuery {
  search?: string;
  source?: string;
  direction?: string;
  transactionType?: string;
  txnStatus?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
}

const LIST_COLUMNS =
  'id, entity_id, source, external_transaction_id, amount, currency_code, ' +
  'base_amount, base_currency_code, fx_rate, ' +
  'direction, transaction_type, occurred_at, description, counterparty_name, ' +
  'status, excluded_reason, journalised_at, metadata';

/** One page of the business's transactions, newest first, with the total that match. */
export async function listTransactions(
  supabase: SupabaseClient,
  entityId: string,
  query: TransactionQuery
): Promise<ListTransactionsResponse> {
  const { page, pageSize } = query;
  let q = supabase
    .from('financial_transactions')
    .select(LIST_COLUMNS, { count: 'exact' })
    .eq('entity_id', entityId);

  if (query.source) q = q.eq('source', query.source);
  if (query.direction) q = q.eq('direction', query.direction);
  if (query.transactionType) q = q.eq('transaction_type', query.transactionType);
  if (query.txnStatus === 'excluded') q = q.not('excluded_reason', 'is', null);
  else if (query.txnStatus === 'active') q = q.is('excluded_reason', null);
  if (query.dateFrom) q = q.gte('occurred_at', query.dateFrom);
  if (query.dateTo) q = q.lte('occurred_at', query.dateTo);
  // `.or()` takes PostgREST filter syntax, where these characters are structure, not text.
  const search = query.search?.trim().replace(/[%,()]/g, ' ');
  if (search) q = q.or(`description.ilike.%${search}%,counterparty_name.ilike.%${search}%`);

  const from = (page - 1) * pageSize;
  // Many transactions share a timestamp (a day's bank feed), so `id` keeps paging stable.
  const { data, count, error } = await q
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw new Error(`Failed to load transactions: ${error.message}`);

  const total = count ?? 0;
  return {
    entity_id: entityId,
    transactions: (data ?? []) as unknown as FinancialTransaction[],
    total_count: total,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

interface LineItemDbRow extends Omit<
  JournalLineItemWithAccount,
  'account_number' | 'account_name' | 'account_type'
> {
  chart_of_accounts: {
    account_number: string | null;
    name: string | null;
    account_type: string | null;
  } | null;
}

const ATTACHMENT_COLUMNS = 'id, source, file_name, content_type, size_bytes, created_at';

/** Where attachment files live (supabase/migrations/20261028000000_transaction_attachments.sql). */
const ATTACHMENT_BUCKET = 'transaction-attachments';

/**
 * One transaction with its current journal (the newest one not reversed), that journal's lines
 * and the files attached to it, or null if the transaction is not this business's. Attachments
 * name their transaction by the provider's id, as the sync stores them.
 */
export async function getTransactionDetail(
  supabase: SupabaseClient,
  entityId: string,
  transactionId: string
): Promise<TransactionDetailResponse | null> {
  const [txn, journals] = await Promise.all([
    supabase
      .from('financial_transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('entity_id', entityId)
      .maybeSingle(),
    supabase
      .from('journals')
      .select('*')
      .eq('entity_id', entityId)
      .eq('source_type', 'financial_transaction')
      .eq('source_id', transactionId)
      .neq('status', 'reversed')
      .order('created_at', { ascending: false })
      .limit(1),
  ]);
  if (txn.error) throw new Error(`Failed to load transaction: ${txn.error.message}`);
  if (journals.error) throw new Error(`Failed to load its journal: ${journals.error.message}`);
  if (!txn.data) return null;
  const transaction = txn.data as FinancialTransaction;

  const files = await supabase
    .from('transaction_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('entity_id', entityId)
    .eq('source', transaction.source)
    .eq('external_transaction_id', transaction.external_transaction_id)
    .order('created_at');
  if (files.error) throw new Error(`Failed to load its attachments: ${files.error.message}`);

  const journal = (journals.data?.[0] ?? null) as TransactionJournal | null;
  if (journal) {
    const { data, error } = await supabase
      .from('journal_line_items')
      .select(
        'id, journal_id, account_id, debit, credit, currency, description, effective_date, ' +
          'chart_of_accounts!account_id(account_number, name, account_type)'
      )
      .eq('journal_id', journal.id)
      .order('id');
    if (error) throw new Error(`Failed to load journal lines: ${error.message}`);
    journal.line_items = ((data ?? []) as unknown as LineItemDbRow[]).map(
      ({ chart_of_accounts: account, ...item }) => ({
        ...item,
        account_number: account?.account_number ?? null,
        account_name: account?.name ?? null,
        account_type: account?.account_type ?? null,
      })
    );
  }

  return {
    transaction,
    journal,
    attachments: (files.data ?? []) as unknown as TransactionAttachment[],
  };
}

/**
 * A link to one attachment's file that works for a few minutes, or null if the attachment is not
 * this business's. The row is read as the user, so row-level security decides; only then does
 * the service role sign the link (the bucket has no policies of its own).
 */
export async function getAttachmentUrl(
  supabase: SupabaseClient,
  entityId: string,
  attachmentId: string,
  expiresIn = 300
): Promise<string | null> {
  const { data, error } = await supabase
    .from('transaction_attachments')
    .select('file_path, file_name')
    .eq('id', attachmentId)
    .eq('entity_id', entityId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the attachment: ${error.message}`);
  if (!data) return null;
  const signed = await getServerSupabaseClient()
    .storage.from(ATTACHMENT_BUCKET)
    .createSignedUrl(data.file_path, expiresIn);
  if (signed.error) throw new Error(`Failed to open the attachment: ${signed.error.message}`);
  return signed.data.signedUrl;
}
