/**
 * Invoices API Service
 *
 * Server-side operations for managing invoices:
 * - Upload PDFs to Supabase Storage
 * - CRUD operations on invoice metadata
 * - List and filter invoices
 * - Contacts management
 */

import { getServerSupabaseClient } from '~/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Invoice, InvoiceFilters, InvoiceStats } from '~/types/invoice';

// Use shared Supabase client
const getSupabaseClient = getServerSupabaseClient;
const getClient = (override?: SupabaseClient) => override ?? getSupabaseClient();

// ============================================================================
// STORAGE HELPERS
// ============================================================================

/**
 * Get a signed URL for viewing/downloading an invoice file.
 */
export async function getInvoiceUrl(
  filePath: string,
  expiresIn: number = 3600
): Promise<string | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.storage
    .from('invoices')
    .createSignedUrl(filePath, expiresIn);

  if (error) {
    console.error('Error getting signed URL:', error);
    return null;
  }

  return data.signedUrl;
}

// ============================================================================
// INVOICE CRUD
// ============================================================================

/**
 * Get a single invoice by ID, with joined contact and line items.
 */
export async function getInvoice(
  id: string
): Promise<{ invoice: Invoice | null; error: string | null }> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('invoices')
    .select(
      `*, contacts:counterparty_id(id, name, company_name, email, contact_type),
       invoice_line_items(*)`
    )
    .eq('id', id)
    .single();

  if (error) {
    console.error('Error fetching invoice:', error);
    return { invoice: null, error: error.message };
  }

  return { invoice: data as unknown as Invoice, error: null };
}

/**
 * Check whether a financial transaction exists that is matched to the given invoice.
 * Uses metadata.invoice_id to find transactions referencing the invoice number.
 */
export async function findMatchingTransaction(
  invoiceNumber: string,
  entityId: string
): Promise<{ transactionId: string | null; found: boolean }> {
  if (!invoiceNumber || !entityId) {
    return { transactionId: null, found: false };
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('financial_transactions')
    .select('id')
    .eq('entity_id', entityId)
    .filter('metadata->>invoice_id', 'eq', invoiceNumber)
    .is('excluded_reason', null)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Error checking matching transaction:', error);
    return { transactionId: null, found: false };
  }

  return { transactionId: data?.id ?? null, found: !!data };
}

/**
 * Delete invoice metadata record (storage file handled separately).
 */
export async function deleteInvoice(
  id: string
): Promise<{ success: boolean; error: string | null }> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from('invoices').delete().eq('id', id);

  if (error) {
    console.error('Error deleting invoice:', error);
    return { success: false, error: error.message };
  }

  return { success: true, error: null };
}

/**
 * List invoices with optional filters, joining contact name and line items.
 */
export async function listInvoices(
  filters?: InvoiceFilters,
  client?: SupabaseClient
): Promise<{ invoices: Invoice[]; error: string | null }> {
  const supabase = getClient(client);

  let query = supabase
    .from('invoices')
    .select(
      `*, contacts:counterparty_id(id, name, company_name, email, contact_type),
       invoice_line_items(*)`
    )
    .order('created_at', { ascending: false });

  if (filters?.entity_id) query = query.eq('entity_id', filters.entity_id);
  if (filters?.invoice_type) query = query.eq('invoice_type', filters.invoice_type);
  if (filters?.status) query = query.eq('status', filters.status);
  if (filters?.startDate) query = query.gte('invoice_date', filters.startDate);
  if (filters?.endDate) query = query.lte('invoice_date', filters.endDate);

  if (filters?.search) {
    query = query.or(`invoice_number.ilike.%${filters.search}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error listing invoices:', error);
    return { invoices: [], error: error.message };
  }

  return { invoices: data as unknown as Invoice[], error: null };
}

/**
 * Compute invoice statistics split by SALE / PURCHASE type.
 */
export async function getInvoiceStats(
  entityId?: string,
  client?: SupabaseClient
): Promise<InvoiceStats> {
  const supabase = getClient(client);

  let query = supabase.from('invoices').select('invoice_type, status, gross_amount');

  if (entityId) query = query.eq('entity_id', entityId);

  const { data, error } = await query;

  const empty = {
    total: 0,
    sales: { total: 0, open: 0, paid: 0, overdue: 0, outstanding: 0 },
    purchases: { total: 0, open: 0, paid: 0, overdue: 0, payable: 0 },
  };

  if (error || !data) return empty;

  const stats: InvoiceStats = { ...empty, total: data.length };

  for (const row of data) {
    const amount = row.gross_amount ?? 0;

    if (row.invoice_type === 'SALE') {
      stats.sales.total += 1;
      if (row.status === 'OPEN') {
        stats.sales.open += 1;
        stats.sales.outstanding += amount;
      }
      if (row.status === 'PAID') stats.sales.paid += 1;
      if (row.status === 'OVERDUE') {
        stats.sales.overdue += 1;
        stats.sales.outstanding += amount;
      }
      if (row.status === 'PARTIALLY_PAID') stats.sales.outstanding += amount;
    } else if (row.invoice_type === 'PURCHASE') {
      stats.purchases.total += 1;
      if (row.status === 'OPEN') {
        stats.purchases.open += 1;
        stats.purchases.payable += amount;
      }
      if (row.status === 'PAID') stats.purchases.paid += 1;
      if (row.status === 'OVERDUE') {
        stats.purchases.overdue += 1;
        stats.purchases.payable += amount;
      }
      if (row.status === 'PARTIALLY_PAID') stats.purchases.payable += amount;
    }
  }

  return stats;
}
