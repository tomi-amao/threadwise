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
import type {
  Contact,
  Invoice,
  InvoiceFilters,
  InvoiceStats,
  UpdateInvoiceStatusInput,
} from '~/types/invoice';

export type { Contact, Invoice, InvoiceStats };
// Re-export key types for convenience
export type { InvoiceType, InvoiceStatus, ContactType, InvoiceLineItem } from '~/types/invoice';

// Use shared Supabase client
const getSupabaseClient = getServerSupabaseClient;
const getClient = (override?: SupabaseClient) => override ?? getSupabaseClient();

// ============================================================================
// STORAGE HELPERS
// ============================================================================

/**
 * Upload an invoice file to Supabase Storage
 * Returns the storage path on success.
 */
export async function uploadInvoiceFile(
  file: File,
  entityId?: string
): Promise<{ path: string; error: string | null }> {
  const supabase = getSupabaseClient();

  const timestamp = Date.now();
  const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
  const folder = entityId || 'general';
  const filePath = `${folder}/${timestamp}-${sanitizedName}`;

  const { data, error } = await supabase.storage.from('invoices').upload(filePath, file, {
    contentType: file.type || 'application/pdf',
    upsert: false,
  });

  if (error) {
    console.error('Error uploading invoice file:', error);
    return { path: '', error: error.message };
  }

  return { path: data.path, error: null };
}

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

/**
 * Delete a file from Supabase Storage.
 */
export async function deleteInvoiceFile(
  filePath: string
): Promise<{ success: boolean; error: string | null }> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.storage.from('invoices').remove([filePath]);

  if (error) {
    console.error('Error deleting invoice file:', error);
    return { success: false, error: error.message };
  }

  return { success: true, error: null };
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
 * Update invoice status.
 */
export async function updateInvoiceStatus(
  id: string,
  input: UpdateInvoiceStatusInput
): Promise<{ invoice: Invoice | null; error: string | null }> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('invoices')
    .update({ status: input.status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating invoice status:', error);
    return { invoice: null, error: error.message };
  }

  return { invoice: data as unknown as Invoice, error: null };
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

// ============================================================================
// CONTACTS
// ============================================================================

/**
 * List contacts for an entity.
 */
export async function listContacts(
  entityId?: string
): Promise<{ contacts: Contact[]; error: string | null }> {
  const supabase = getSupabaseClient();

  let query = supabase.from('contacts').select('*');

  if (entityId) query = query.eq('entity_id', entityId);

  const { data, error } = await query.eq('is_active', true).order('name', { ascending: true });

  if (error) {
    console.error('Error listing contacts:', error);
    return { contacts: [], error: error.message };
  }

  return { contacts: data as Contact[], error: null };
}

/**
 * Get a single contact by ID.
 */
export async function getContact(
  id: string
): Promise<{ contact: Contact | null; error: string | null }> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.from('contacts').select('*').eq('id', id).single();

  if (error) {
    console.error('Error fetching contact:', error);
    return { contact: null, error: error.message };
  }

  return { contact: data as Contact, error: null };
}
