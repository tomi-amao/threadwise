/**
 * Invoice Types
 *
 * TypeScript interfaces for invoice management
 */

// Invoice status options
export type InvoiceStatus = 'pending' | 'paid' | 'overdue' | 'cancelled';

// Extraction status for AI-parsed invoices
export type ExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed';

// Line item from extracted invoice
export interface ExtractedLineItem {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total_price: number | null;
}

// Main invoice interface
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
  // Optional signed URL for viewing
  signedUrl?: string;
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
}

// Filter options for listing invoices
export interface InvoiceFilters {
  status?: InvoiceStatus;
  entity_id?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}

// Invoice statistics
export interface InvoiceStats {
  total: number;
  pending: number;
  paid: number;
  overdue: number;
  totalAmount: number;
  pendingAmount: number;
}

// Upload progress state
export interface UploadProgress {
  fileName: string;
  progress: number;
  status: 'uploading' | 'processing' | 'complete' | 'error';
  error?: string;
}

// Invoice form data for editing
export interface InvoiceFormData {
  invoice_number: string;
  vendor_name: string;
  invoice_date: string;
  due_date: string;
  amount: string;
  currency: string;
  status: InvoiceStatus;
  notes: string;
}
