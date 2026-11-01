/**
 * Invoices: server-side reads and the call to the AI agent.
 *
 * Every read runs as the signed-in user (cookie session), so row-level security decides what
 * they can see: their invoices, and the stock movements, payments and chart of accounts
 * around them. The service-role client is only used for the document store (Storage),
 * and only after the invoice has been fetched as the user, so the entity and file always come
 * from a row the user is allowed to see, never from the request.
 *
 * Writes that touch the ledger go to the agent (see api.invoices.tsx), never straight to
 * Postgres.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabaseClient } from '~/lib/supabase';
import { getRequestSupabaseClient } from '~/lib/supabase-server';
import { getApiBaseUrl } from './base-url';
import { fetchAllRows } from './paginate.server';
import { getAttachmentUrl } from './transactions.server';

export { getUserEntity } from './entity.server';
import type {
  DocumentSource,
  GlAccountOption,
  InvoiceContact,
  InvoiceDetail,
  InvoiceLineItem,
  InvoiceOrigin,
  InvoiceRow,
  PaymentCandidate,
} from '~/types/invoice';

const CONTACT_COLUMNS = 'id, name, company_name, email, contact_type';
const LIST_COLUMNS =
  'id, entity_id, invoice_number, invoice_type, status, currency, net_amount, tax_amount, ' +
  'gross_amount, invoice_date, due_date, source, notes, created_at, file_path, origin, ' +
  'attachment_id';

interface InvoiceDbRow extends Omit<InvoiceRow, 'document' | 'contacts' | 'origin'> {
  file_path: string | null;
  attachment_id: string | null;
  origin: InvoiceOrigin | null;
  contacts: InvoiceContact | null;
}

/** An uploaded original wins, then the receipt it was read from, then a printable copy. */
export function documentSource(
  row: Pick<InvoiceDbRow, 'file_path' | 'attachment_id' | 'origin'>
): DocumentSource | null {
  if (row.file_path) return 'upload';
  if (row.attachment_id) return 'receipt';
  if (row.origin === 'revolut_merchant') return 'generated';
  return null;
}

function toRow({ file_path, attachment_id, origin, ...rest }: InvoiceDbRow): InvoiceRow {
  return {
    ...rest,
    net_amount: Number(rest.net_amount),
    tax_amount: Number(rest.tax_amount),
    gross_amount: Number(rest.gross_amount),
    origin: origin ?? 'upload',
    document: documentSource({ file_path, attachment_id, origin }),
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

  const entityId = invoice.entity_id;
  const [matched, stocked, accounts, products, candidates] = await Promise.all([
    findMatchingTransaction(user, invoiceId),
    readStockedLines(
      user,
      lines.map(l => l.id)
    ),
    readGlAccounts(user),
    readProducts(user, entityId),
    findPaymentCandidates(user, invoice),
  ]);

  return {
    invoice,
    lines,
    matched_transaction_id: matched,
    payment_candidates: matched ? [] : candidates,
    stocked_line_ids: stocked,
    gl_accounts: accounts,
    products,
  };
}

async function readStockedLines(supabase: SupabaseClient, lineIds: string[]): Promise<string[]> {
  if (lineIds.length === 0) return [];
  const { data, error } = await supabase
    .from('inventory_movements')
    .select('reference_id')
    .eq('reference_table', 'invoice_line_items')
    .eq('transaction_type', 'PURCHASE')
    .in('reference_id', lineIds);
  if (error) throw new Error(`Failed to load stock movements: ${error.message}`);
  return [...new Set((data ?? []).map(r => r.reference_id as string))];
}

/** The chart of accounts is shared by every business (it has no entity column). */
async function readGlAccounts(supabase: SupabaseClient): Promise<GlAccountOption[]> {
  const { data, error } = await supabase
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
 * The bank transaction matched to this invoice as its payment (the earliest, if several part
 * payments are). null means no match, a normal result; a failing query throws.
 */
export async function findMatchingTransaction(
  supabase: SupabaseClient,
  invoiceId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('invoice_payments')
    .select('financial_transaction_id')
    .eq('invoice_id', invoiceId)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to check for a matching payment: ${error.message}`);
  return (data?.financial_transaction_id as string | undefined) ?? null;
}

/**
 * Bank transactions that could be the payment for a finalised invoice: money going the right way
 * (out for a purchase, in for a sale), in the invoice's currency, within 10% of its total, and
 * not already matched to another invoice. Nearest amount first.
 */
export async function findPaymentCandidates(
  supabase: SupabaseClient,
  invoice: InvoiceRow
): Promise<PaymentCandidate[]> {
  if (invoice.status === 'DRAFT' || invoice.status === 'CANCELLED' || invoice.status === 'VOID') {
    return [];
  }
  const total = invoice.gross_amount;
  if (!(total > 0)) return [];
  const { data, error } = await supabase
    .from('financial_transactions')
    .select('id, occurred_at, description, counterparty_name, amount, currency_code')
    .eq('entity_id', invoice.entity_id)
    .eq('direction', invoice.invoice_type === 'SALE' ? 'in' : 'out')
    .eq('currency_code', invoice.currency)
    .is('excluded_reason', null)
    .gte('amount', total * 0.9)
    .lte('amount', total * 1.1)
    .order('occurred_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(`Failed to look for a matching payment: ${error.message}`);
  const rows = data ?? [];
  // A transaction pays one invoice, so those already matched are not offered.
  const { data: taken, error: takenError } = rows.length
    ? await supabase
        .from('invoice_payments')
        .select('financial_transaction_id')
        .in(
          'financial_transaction_id',
          rows.map(t => t.id as string)
        )
    : { data: [], error: null };
  if (takenError) throw new Error(`Failed to look for a matching payment: ${takenError.message}`);
  const matched = new Set((taken ?? []).map(t => t.financial_transaction_id as string));
  return rows
    .filter(t => !matched.has(t.id as string))
    .map(t => ({
      id: t.id as string,
      occurred_at: t.occurred_at as string,
      description: (t.description as string | null) ?? null,
      counterparty: (t.counterparty_name as string | null) ?? null,
      amount: Number(t.amount),
      currency: t.currency_code as string,
    }))
    .sort(
      (a, b) =>
        Math.abs(a.amount - total) - Math.abs(b.amount - total) ||
        b.occurred_at.localeCompare(a.occurred_at)
    )
    .slice(0, 8);
}

/** The minimum a write needs to know about an invoice the user may touch. */
export interface OwnedInvoice {
  id: string;
  entity_id: string;
  invoice_number: string;
  invoice_type: 'SALE' | 'PURCHASE';
  status: string;
  file_path: string | null;
  attachment_id: string | null;
  origin: InvoiceOrigin | null;
}

/** The invoice if the signed-in user can see it (RLS), else null. Gate every write on this. */
export async function getOwnedInvoice(
  request: Request,
  invoiceId: string
): Promise<OwnedInvoice | null> {
  const { data, error } = await getRequestSupabaseClient(request)
    .from('invoices')
    .select('id, entity_id, invoice_number, invoice_type, status, file_path, attachment_id, origin')
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load invoice: ${error.message}`);
  return (data as OwnedInvoice | null) ?? null;
}

export async function getDocumentUrl(filePath: string, expiresIn = 3600): Promise<string> {
  const { data, error } = await getServerSupabaseClient()
    .storage.from('invoices')
    .createSignedUrl(filePath, expiresIn);
  if (error) throw new Error(`Failed to open the document: ${error.message}`);
  return data.signedUrl;
}

/**
 * Where to open an invoice's document: a signed link to the upload or the receipt it was read
 * from, or the printable copy. null when it has none. `invoice` must have been read as the user.
 */
export async function documentUrlFor(
  request: Request,
  invoice: OwnedInvoice
): Promise<string | null> {
  switch (documentSource(invoice)) {
    case 'upload':
      return getDocumentUrl(invoice.file_path as string);
    case 'receipt':
      // Read as the user again: the attachment row decides, as it does on the transaction.
      return getAttachmentUrl(
        getRequestSupabaseClient(request),
        invoice.entity_id,
        invoice.attachment_id as string
      );
    case 'generated':
      return `/api/invoices/print?id=${encodeURIComponent(invoice.id)}`;
    default:
      return null;
  }
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

/**
 * Call the AI agent as the signed-in user (`token` from `requestAccessToken(request)`);
 * throws AgentError with the agent's own message and status on failure.
 */
export async function callAgent<T>(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    response = await fetch(`${getApiBaseUrl()}${path}`, { ...init, headers });
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
