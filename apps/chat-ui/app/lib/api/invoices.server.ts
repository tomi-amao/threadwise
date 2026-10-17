/**
 * Invoices: server-side reads and the call to the AI agent.
 *
 * Reads run as the signed-in user (cookie session), so row-level security decides which
 * invoices they can see. Anything the user's session cannot read (journals, chart of accounts,
 * stock movements: no RLS policies for them) is read with the service client, but only after
 * the invoice itself has been fetched as the user, so the entity always comes from a row the
 * user is allowed to see, never from the request.
 *
 * Writes that touch the ledger go to the agent (see api.invoices.tsx), never straight to
 * Postgres.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabaseClient } from '~/lib/supabase';
import { getRequestSupabaseClient } from '~/lib/supabase-server';
import { getApiBaseUrl } from './base-url';
import { fetchAllRows } from './paginate.server';
import type {
  GlAccountOption,
  InvoiceContact,
  InvoiceDetail,
  InvoiceLineItem,
  InvoiceRow,
} from '~/types/invoice';

const CONTACT_COLUMNS = 'id, name, company_name, email, contact_type';
const LIST_COLUMNS =
  'id, entity_id, invoice_number, invoice_type, status, currency, net_amount, tax_amount, ' +
  'gross_amount, invoice_date, due_date, source, notes, created_at, file_path';

interface InvoiceDbRow extends Omit<InvoiceRow, 'has_document' | 'contacts'> {
  file_path: string | null;
  contacts: InvoiceContact | null;
}

function toRow({ file_path, ...rest }: InvoiceDbRow): InvoiceRow {
  return {
    ...rest,
    net_amount: Number(rest.net_amount),
    tax_amount: Number(rest.tax_amount),
    gross_amount: Number(rest.gross_amount),
    has_document: !!file_path,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────

/** Every invoice the signed-in user can see, newest first. Read in full: see paginate.server. */
export async function listInvoices(request: Request): Promise<InvoiceRow[]> {
  const supabase = getRequestSupabaseClient(request);
  const rows = await fetchAllRows<InvoiceDbRow>('invoices', (from, to) =>
    supabase
      .from('invoices')
      .select(`${LIST_COLUMNS}, contacts:counterparty_id(${CONTACT_COLUMNS})`)
      .order('id')
      .range(from, to)
  );
  return rows
    .map(toRow)
    .sort(
      (a, b) =>
        b.invoice_date.localeCompare(a.invoice_date) || b.created_at.localeCompare(a.created_at)
    );
}

/**
 * One invoice with its lines and everything the drawer needs. Returns null when the user
 * cannot see it (it does not exist, or belongs to someone else).
 */
export async function getInvoiceDetail(
  request: Request,
  invoiceId: string
): Promise<InvoiceDetail | null> {
  const user = getRequestSupabaseClient(request);
  const { data, error } = await user
    .from('invoices')
    .select(
      `${LIST_COLUMNS}, contacts:counterparty_id(${CONTACT_COLUMNS}), ` +
        'invoice_line_items(id, invoice_id, description, sku, quantity, unit_cost, ' +
        'gl_account_id, tax_code, vat_rate, line_net, line_vat, line_gross)'
    )
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load invoice: ${error.message}`);
  if (!data) return null;

  const { invoice_line_items, ...invoiceRow } = data as unknown as InvoiceDbRow & {
    invoice_line_items: InvoiceLineItem[] | null;
  };
  const invoice = toRow(invoiceRow);
  const lines = (invoice_line_items ?? [])
    .map(l => ({
      ...l,
      quantity: Number(l.quantity),
      unit_cost: Number(l.unit_cost),
      vat_rate: Number(l.vat_rate),
      line_net: l.line_net == null ? null : Number(l.line_net),
      line_vat: l.line_vat == null ? null : Number(l.line_vat),
      line_gross: l.line_gross == null ? null : Number(l.line_gross),
    }))
    // The table has no line number, so a stable order needs a tiebreak on something fixed.
    .sort((a, b) => a.id.localeCompare(b.id));

  const service = getServerSupabaseClient();
  const entityId = invoice.entity_id;
  const [journals, matched, stocked, accounts, products] = await Promise.all([
    readJournals(service, entityId, invoiceId),
    findMatchingTransaction(invoice.invoice_number, entityId),
    readStockedLines(
      service,
      lines.map(l => l.id)
    ),
    readGlAccounts(service),
    readProducts(user, entityId),
  ]);

  return {
    invoice,
    lines,
    journals,
    matched_transaction_id: matched,
    stocked_line_ids: stocked,
    gl_accounts: accounts,
    products,
  };
}

async function readJournals(service: SupabaseClient, entityId: string, invoiceId: string) {
  const { data, error } = await service
    .from('journals')
    .select('id, journal_type, journal_date, status')
    .eq('entity_id', entityId)
    .eq('source_type', 'invoice')
    .eq('source_id', invoiceId)
    .neq('status', 'reversed')
    .order('journal_date');
  if (error) throw new Error(`Failed to load journals: ${error.message}`);
  return data ?? [];
}

async function readStockedLines(service: SupabaseClient, lineIds: string[]): Promise<string[]> {
  if (lineIds.length === 0) return [];
  const { data, error } = await service
    .from('inventory_movements')
    .select('reference_id')
    .eq('reference_table', 'invoice_line_items')
    .eq('transaction_type', 'PURCHASE')
    .in('reference_id', lineIds);
  if (error) throw new Error(`Failed to load stock movements: ${error.message}`);
  return [...new Set((data ?? []).map(r => r.reference_id as string))];
}

/** The chart of accounts is shared by every business (it has no entity column). */
async function readGlAccounts(service: SupabaseClient): Promise<GlAccountOption[]> {
  const { data, error } = await service
    .from('chart_of_accounts')
    .select('id, account_number, name, account_type')
    .eq('is_header', false)
    .eq('status', 'active')
    .order('account_number');
  if (error) throw new Error(`Failed to load the chart of accounts: ${error.message}`);
  return data ?? [];
}

async function readProducts(user: SupabaseClient, entityId: string) {
  const rows = await fetchAllRows<{ id: string; name: string }>('products', (from, to) =>
    user
      .from('products')
      .select('id, name')
      .eq('entity_id', entityId)
      .neq('status', 'archived')
      .order('id')
      .range(from, to)
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A bank transaction already matched to this invoice (the PayPal enrichment writes the invoice
 * number into metadata.invoice_id). null means no match, a normal result; a failing query throws.
 */
export async function findMatchingTransaction(
  invoiceNumber: string,
  entityId: string
): Promise<string | null> {
  if (!invoiceNumber || !entityId) return null;
  const { data, error } = await getServerSupabaseClient()
    .from('financial_transactions')
    .select('id')
    .eq('entity_id', entityId)
    .filter('metadata->>invoice_id', 'eq', invoiceNumber)
    .is('excluded_reason', null)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to check for a matching payment: ${error.message}`);
  return data?.id ?? null;
}

/** The minimum a write needs to know about an invoice the user may touch. */
export interface OwnedInvoice {
  id: string;
  entity_id: string;
  invoice_number: string;
  invoice_type: 'SALE' | 'PURCHASE';
  status: string;
  file_path: string | null;
}

/** The invoice if the signed-in user can see it (RLS), else null. Gate every write on this. */
export async function getOwnedInvoice(
  request: Request,
  invoiceId: string
): Promise<OwnedInvoice | null> {
  const { data, error } = await getRequestSupabaseClient(request)
    .from('invoices')
    .select('id, entity_id, invoice_number, invoice_type, status, file_path')
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load invoice: ${error.message}`);
  return (data as OwnedInvoice | null) ?? null;
}

/** The business the signed-in user owns (its id and trading currency), or null. */
export async function getUserEntity(
  request: Request
): Promise<{ id: string; currency: string } | null> {
  const { data, error } = await getRequestSupabaseClient(request)
    .from('entities')
    .select('id, currency')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load your business: ${error.message}`);
  return data ? { id: data.id, currency: data.currency ?? 'GBP' } : null;
}

export async function getDocumentUrl(filePath: string, expiresIn = 3600): Promise<string> {
  const { data, error } = await getServerSupabaseClient()
    .storage.from('invoices')
    .createSignedUrl(filePath, expiresIn);
  if (error) throw new Error(`Failed to open the document: ${error.message}`);
  return data.signedUrl;
}

// ─── The agent ────────────────────────────────────────────────────────

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** FastAPI reports errors as {detail: string | [{msg}]}; reduce either to one sentence. */
function detailOf(body: string): string {
  try {
    const { detail } = JSON.parse(body) as { detail?: unknown };
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail.map(d => (d as { msg?: string }).msg ?? JSON.stringify(d)).join('; ');
    }
  } catch {
    /* not JSON: use the text */
  }
  return body || 'The accounting service did not respond';
}

/** Call the AI agent; throws AgentError with the agent's own message and status on failure. */
export async function callAgent<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, init);
  } catch {
    throw new AgentError('The accounting service is not reachable. Try again in a moment.', 503);
  }
  if (!response.ok) throw new AgentError(detailOf(await response.text()), response.status);
  return (await response.json()) as T;
}

export const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
