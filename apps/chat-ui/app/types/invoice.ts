/**
 * Invoice Types — aligned with the new DB schema
 *
 * invoices: id, entity_id, invoice_number, net_amount, tax_amount, gross_amount,
 *           currency, invoice_date, due_date, source, notes, created_at, updated_at,
 *           status (DRAFT|OPEN|PAID|PARTIALLY_PAID|OVERDUE|CANCELLED|VOID),
 *           counterparty_id, invoice_type (SALE|PURCHASE), fx_rate
 *
 * contacts: id, entity_id, contact_type (supplier|customer|both),
 *           name, company_name, email, phone, address_*, currency,
 *           tax_number, payment_terms, is_active, created_at, updated_at
 *
 * invoice_line_items: id, invoice_id, description, quantity, unit_cost,
 *                     gl_account_id, tax_code, vat_rate,
 *                     line_net (generated), line_vat (generated), line_gross (generated)
 */

// =============================================================================
// ENUMS / LITERALS
// =============================================================================

export type InvoiceType = 'SALE' | 'PURCHASE';

export type InvoiceStatus =
  | 'DRAFT'
  | 'OPEN'
  | 'PAID'
  | 'PARTIALLY_PAID'
  | 'OVERDUE'
  | 'CANCELLED'
  | 'VOID';

export type ContactType = 'supplier' | 'customer' | 'both';

// =============================================================================
// CONTACT
// =============================================================================

export interface Contact {
  id: string;
  entity_id: string;
  contact_type: ContactType;
  name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  currency: string | null;
  tax_number: string | null;
  payment_terms: number | null;
  provider: string | null;
  external_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Minimal contact embedded inside invoice rows from JOIN */
export interface InvoiceContact {
  id: string;
  name: string;
  company_name: string | null;
  email: string | null;
  contact_type: ContactType;
}

// =============================================================================
// INVOICE LINE ITEM
// =============================================================================

export interface InvoiceLineItem {
  id: string;
  invoice_id: string;
  description: string;
  sku: string | null;
  quantity: number | null;
  unit_cost: number | null;
  gl_account_id: string | null;
  created_at: string;
  tax_code: string | null;
  vat_rate: number | null;
  /** Generated column — quantity * unit_cost */
  line_net: number | null;
  /** Generated column — line_net * (vat_rate / 100) */
  line_vat: number | null;
  /** Generated column — line_net + line_vat */
  line_gross: number | null;
}

// =============================================================================
// INVOICE
// =============================================================================

export interface Invoice {
  id: string;
  entity_id: string;
  invoice_number: string | null;
  invoice_type: InvoiceType;
  status: InvoiceStatus;
  currency: string;
  net_amount: number | null;
  tax_amount: number | null;
  gross_amount: number | null;
  fx_rate: number | null;
  invoice_date: string | null;
  due_date: string | null;
  source: string | null; // Payment platform: 'paypal' | 'revolut' | 'manual' etc.
  file_path: string | null; // Supabase Storage path for the uploaded document
  notes: string | null;
  counterparty_id: string | null;
  created_at: string;
  updated_at: string;
  // Embedded relations (available when fetched with JOIN)
  contacts?: InvoiceContact | null;
  invoice_line_items?: InvoiceLineItem[];
}

// =============================================================================
// INPUT TYPES
// =============================================================================

export interface CreateContactInput {
  entity_id: string;
  contact_type: ContactType;
  name: string;
  company_name?: string;
  email?: string;
  phone?: string;
  address_line_1?: string;
  city?: string;
  country?: string;
  tax_number?: string;
}

export interface UpdateInvoiceStatusInput {
  status: InvoiceStatus;
}

// =============================================================================
// FILTER / STATS
// =============================================================================

export interface InvoiceFilters {
  invoice_type?: InvoiceType;
  status?: InvoiceStatus;
  entity_id?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}

export interface InvoiceStats {
  total: number;
  sales: {
    total: number;
    open: number;
    paid: number;
    overdue: number;
    outstanding: number;
  };
  purchases: {
    total: number;
    open: number;
    paid: number;
    overdue: number;
    payable: number;
  };
}

// =============================================================================
// UPLOAD / PROCESSING
// =============================================================================

export interface UploadProgress {
  fileName: string;
  progress: number;
  status: 'uploading' | 'processing' | 'complete' | 'error';
  error?: string;
}

/** Result returned by the backend invoice processing pipeline */
export interface InvoiceProcessResult {
  invoice: Invoice;
  contact: Contact;
  line_items: InvoiceLineItem[];
  journal: Record<string, unknown> | null;
  journal_error: string | null;
  extraction: {
    invoice_type: InvoiceType;
    confidence_score: number;
    invoice_number: string | null;
  };
}
