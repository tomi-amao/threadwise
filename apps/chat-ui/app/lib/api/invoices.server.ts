/**
 * Invoices API Service
 *
 * Server-side operations for managing invoices:
 * - Upload PDFs to Supabase Storage
 * - CRUD operations on invoice metadata
 * - List and filter invoices
 */

import { getServerSupabaseClient } from '~/lib/supabase';

// Invoice status type
export type InvoiceStatus = 'pending' | 'paid' | 'overdue' | 'cancelled';

// Extraction status type
export type ExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed';

// Extracted line item
export interface ExtractedLineItem {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total_price: number | null;
}

// Invoice interface matching database schema
export interface Invoice {
  id: string;
  entity_id: string | null;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  invoice_number: string | null;
  vendor_name: string | null;
  invoice_date: string | null;
  due_date: string | null;
  amount: number | null;
  currency: string;
  status: InvoiceStatus;
  notes: string | null;
  uploaded_at: string;
  updated_at: string;
  created_by: string | null;
  // Extraction-related fields
  extraction_status: ExtractionStatus | null;
  extraction_confidence: number | null;
  document_category: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  line_items: ExtractedLineItem[] | null;
}

// Create invoice input
export interface CreateInvoiceInput {
  entity_id?: string;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type?: string;
  invoice_number?: string;
  vendor_name?: string;
  invoice_date?: string;
  due_date?: string;
  amount?: number;
  currency?: string;
  status?: InvoiceStatus;
  notes?: string;
}

// Update invoice input
export interface UpdateInvoiceInput {
  invoice_number?: string;
  vendor_name?: string;
  invoice_date?: string;
  due_date?: string;
  amount?: number;
  currency?: string;
  status?: InvoiceStatus;
  notes?: string;
  // Extraction-related fields
  extraction_status?: ExtractionStatus;
  extraction_confidence?: number;
  document_category?: string;
  subtotal?: number;
  tax_amount?: number;
  line_items?: ExtractedLineItem[];
}

// Filter options for listing invoices
export interface InvoiceFilters {
  status?: InvoiceStatus;
  entity_id?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}

// Use shared Supabase client
const getSupabaseClient = getServerSupabaseClient;

/**
 * Upload a PDF file to Supabase Storage
 */
export async function uploadInvoiceFile(
  file: File,
  entityId?: string
): Promise<{ path: string; error: string | null }> {
  const supabase = getSupabaseClient();

  // Generate unique file path
  const timestamp = Date.now();
  const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
  const folder = entityId || 'general';
  const filePath = `${folder}/${timestamp}-${sanitizedName}`;

  const { data, error } = await supabase.storage.from('invoices').upload(filePath, file, {
    contentType: 'application/pdf',
    upsert: false,
  });

  if (error) {
    console.error('Error uploading invoice file:', error);
    return { path: '', error: error.message };
  }

  return { path: data.path, error: null };
}

/**
 * Get a signed URL for viewing/downloading an invoice
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
 * Delete a file from storage
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

/**
 * Create invoice metadata record
 */
export async function createInvoice(
  input: CreateInvoiceInput
): Promise<{ invoice: Invoice | null; error: string | null }> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      entity_id: input.entity_id || null,
      file_name: input.file_name,
      file_path: input.file_path,
      file_size: input.file_size,
      mime_type: input.mime_type || 'application/pdf',
      invoice_number: input.invoice_number || null,
      vendor_name: input.vendor_name || null,
      invoice_date: input.invoice_date || null,
      due_date: input.due_date || null,
      amount: input.amount || null,
      currency: input.currency || 'USD',
      status: input.status || 'pending',
      notes: input.notes || null,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating invoice:', error);
    return { invoice: null, error: error.message };
  }

  return { invoice: data as Invoice, error: null };
}

/**
 * Get invoice by ID
 */
export async function getInvoice(
  id: string
): Promise<{ invoice: Invoice | null; error: string | null }> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.from('invoices').select('*').eq('id', id).single();

  if (error) {
    console.error('Error fetching invoice:', error);
    return { invoice: null, error: error.message };
  }

  return { invoice: data as Invoice, error: null };
}

/**
 * Update invoice metadata
 */
export async function updateInvoice(
  id: string,
  input: UpdateInvoiceInput
): Promise<{ invoice: Invoice | null; error: string | null }> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('invoices')
    .update({
      ...input,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating invoice:', error);
    return { invoice: null, error: error.message };
  }

  return { invoice: data as Invoice, error: null };
}

/**
 * Delete invoice (both file and metadata)
 */
export async function deleteInvoice(
  id: string
): Promise<{ success: boolean; error: string | null }> {
  const supabase = getSupabaseClient();

  // First get the invoice to get the file path
  const { invoice, error: fetchError } = await getInvoice(id);
  if (fetchError || !invoice) {
    return { success: false, error: fetchError || 'Invoice not found' };
  }

  // Delete the file from storage
  const { error: fileError } = await deleteInvoiceFile(invoice.file_path);
  if (fileError) {
    console.warn('Failed to delete file, continuing with metadata deletion:', fileError);
  }

  // Delete the metadata
  const { error } = await supabase.from('invoices').delete().eq('id', id);

  if (error) {
    console.error('Error deleting invoice:', error);
    return { success: false, error: error.message };
  }

  return { success: true, error: null };
}

/**
 * List invoices with optional filters
 */
export async function listInvoices(
  filters?: InvoiceFilters
): Promise<{ invoices: Invoice[]; error: string | null }> {
  const supabase = getSupabaseClient();

  let query = supabase.from('invoices').select('*').order('uploaded_at', { ascending: false });

  if (filters?.entity_id) {
    query = query.eq('entity_id', filters.entity_id);
  }

  if (filters?.status) {
    query = query.eq('status', filters.status);
  }

  if (filters?.startDate) {
    query = query.gte('invoice_date', filters.startDate);
  }

  if (filters?.endDate) {
    query = query.lte('invoice_date', filters.endDate);
  }

  if (filters?.search) {
    query = query.or(
      `vendor_name.ilike.%${filters.search}%,invoice_number.ilike.%${filters.search}%,file_name.ilike.%${filters.search}%`
    );
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error listing invoices:', error);
    return { invoices: [], error: error.message };
  }

  return { invoices: data as Invoice[], error: null };
}

/**
 * Get invoice statistics
 */
export async function getInvoiceStats(): Promise<{
  total: number;
  pending: number;
  paid: number;
  overdue: number;
  totalAmount: number;
  pendingAmount: number;
}> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.from('invoices').select('status, amount');

  if (error || !data) {
    return {
      total: 0,
      pending: 0,
      paid: 0,
      overdue: 0,
      totalAmount: 0,
      pendingAmount: 0,
    };
  }

  const stats = {
    total: data.length,
    pending: data.filter(i => i.status === 'pending').length,
    paid: data.filter(i => i.status === 'paid').length,
    overdue: data.filter(i => i.status === 'overdue').length,
    totalAmount: data.reduce((sum, i) => sum + (i.amount || 0), 0),
    pendingAmount: data
      .filter(i => i.status === 'pending' || i.status === 'overdue')
      .reduce((sum, i) => sum + (i.amount || 0), 0),
  };

  return stats;
}
