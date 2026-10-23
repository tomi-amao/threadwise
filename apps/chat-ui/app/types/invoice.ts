/**
 * Invoice types, matching the database.
 *
 * invoices: invoice_number (required), net/tax/gross_amount, currency, invoice_date, due_date,
 *   status (invoice_status enum), invoice_type (SALE | PURCHASE), counterparty_id, source,
 *   file_path (the uploaded document in storage), notes.
 * invoice_line_items: quantity, unit_cost, vat_rate (a fraction: 0.2 is 20%), gl_account_id,
 *   and generated line_net / line_vat / line_gross.
 *
 * SALE is money owed to the business (a receivable); PURCHASE is money the business owes.
 */

export type InvoiceType = 'SALE' | 'PURCHASE';

export type InvoiceStatus =
  'DRAFT' | 'OPEN' | 'PAID' | 'PARTIALLY_PAID' | 'OVERDUE' | 'CANCELLED' | 'VOID';

export interface InvoiceContact {
  id: string;
  name: string;
  company_name: string | null;
  email: string | null;
  contact_type: 'supplier' | 'customer' | 'both';
}

export interface InvoiceLineItem {
  id: string;
  invoice_id: string;
  description: string;
  sku: string | null;
  quantity: number;
  unit_cost: number;
  gl_account_id: string | null;
  tax_code: string;
  vat_rate: number;
  line_net: number | null;
  line_vat: number | null;
  line_gross: number | null;
}

/** An invoice as the list shows it: no line items. */
export interface InvoiceRow {
  id: string;
  entity_id: string;
  invoice_number: string;
  invoice_type: InvoiceType;
  status: InvoiceStatus;
  currency: string;
  net_amount: number;
  tax_amount: number;
  gross_amount: number;
  invoice_date: string;
  due_date: string | null;
  source: string | null;
  notes: string | null;
  created_at: string;
  has_document: boolean;
  contacts: InvoiceContact | null;
}

export interface GlAccountOption {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
}

export interface ProductOption {
  id: string;
  name: string;
}

/** A bank transaction that might be the payment for an invoice. */
export interface PaymentCandidate {
  id: string;
  occurred_at: string;
  description: string | null;
  counterparty: string | null;
  amount: number;
  currency: string;
}

/** Everything the drawer shows for one invoice. */
export interface InvoiceDetail {
  invoice: InvoiceRow & { contacts: InvoiceContact | null };
  lines: InvoiceLineItem[];
  /** Journals posted for this invoice (accrual and payment). */
  journals: { id: string; journal_type: string; journal_date: string; status: string }[];
  /** A bank transaction already matched to this invoice, if any. */
  matched_transaction_id: string | null;
  /** Bank transactions that could be this invoice's payment, nearest in amount first. */
  payment_candidates: PaymentCandidate[];
  /** Line items that already have a purchase movement recorded. */
  stocked_line_ids: string[];
  gl_accounts: GlAccountOption[];
  products: ProductOption[];
}

/** One line's stock handling, sent to the agent (see POST /accounting/invoices/{id}/stock). */
export type StockAction = 'expense' | 'link' | 'new' | 'track';

export interface StockDecision {
  line_item_id: string;
  action: StockAction;
  product_id?: string;
  name?: string;
  sku?: string;
  asset_account_id?: string;
  cogs_account_id?: string;
}
