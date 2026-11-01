/**
 * Invoice types, matching the database.
 *
 * invoices: invoice_number (required), net/tax/gross_amount, currency, invoice_date, due_date,
 *   status (invoice_status enum), invoice_type (SALE | PURCHASE), counterparty_id, source,
 *   file_path (the uploaded document in storage), notes, origin (where the record came from),
 *   attachment_id (the transaction attachment it was read from).
 * invoice_line_items: quantity, unit_cost, vat_rate (a fraction: 0.2 is 20%), gl_account_id,
 *   and generated line_net / line_vat / line_gross.
 *
 * SALE is money owed to the business (a receivable); PURCHASE is money the business owes.
 */

export type InvoiceType = 'SALE' | 'PURCHASE';

/**
 * Where the record came from: an upload, a payment request sent from Revolut, or a supplier
 * invoice read from a receipt on a Revolut expense. Synced ones (not uploads) have a status and
 * direction the app does not set.
 */
export type InvoiceOrigin = 'upload' | 'revolut_merchant' | 'revolut_expense';

/**
 * The document behind an invoice: the uploaded file, the receipt it was read from, or a
 * printable copy made from the invoice itself (Revolut offers no file for a payment request).
 * An uploaded original always wins.
 */
export type DocumentSource = 'upload' | 'receipt' | 'generated';

export type InvoiceStatus =
  'DRAFT' | 'OPEN' | 'PAID' | 'PARTIALLY_PAID' | 'OVERDUE' | 'CANCELLED' | 'VOID';

export interface InvoiceContact {
  id: string;
  name: string;
  company_name: string | null;
  email: string | null;
  contact_type: 'supplier' | 'customer' | 'both';
}

/**
 * What a line bought: a product the business sells, a sample (never a product), or something
 * else (freight, fees, services). Shown on the invoice only; it never changes stock.
 */
export type LineKind = 'product' | 'sample' | 'other';

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
  line_kind: LineKind;
  /** The product a product line bought, when it is linked to one. */
  product: ProductOption | null;
}

/** A change to what a line bought, sent to the agent with the invoice update. */
export interface LineUpdate {
  line_kind?: LineKind;
  /** A product of this business; null unlinks it. Only on a product line. */
  product_id?: string | null;
}

/** How a paid invoice was paid when no bank transaction is behind it. */
export type PaidOutsideBank = 'cash' | 'paid_personally' | 'other';

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
  origin: InvoiceOrigin;
  /** Paid with no bank transaction behind it (cash, personally), and how; null otherwise. */
  paid_outside_bank: PaidOutsideBank | null;
  paid_outside_bank_note: string | null;
  /** The document to show, or null if there is none. */
  document: DocumentSource | null;
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

/** A bank transaction that might be the payment for an invoice, scored by the agent. */
export interface PaymentCandidate {
  id: string;
  occurred_at: string;
  description: string | null;
  counterparty: string | null;
  amount: number;
  currency: string;
  /** Why it fits, in plain words: "Invoice number on the transaction", "Exact amount"… */
  reasons: string[];
  /** The invoice number and the exact amount agree. */
  confident: boolean;
}

/** Who matched an invoice to its payment. */
export type MatchedBy = 'user' | 'reconciliation' | 'sync' | 'backfill' | 'auto';

/** Everything the drawer shows for one invoice. */
export interface InvoiceDetail {
  invoice: InvoiceRow & { contacts: InvoiceContact | null };
  lines: InvoiceLineItem[];
  /** A bank transaction already matched to this invoice, if any. */
  matched_transaction_id: string | null;
  /** How that match was made: 'auto' when the number and amount agreed on upload or sync. */
  matched_by: MatchedBy | null;
  /** Bank transactions that could be this invoice's payment, nearest in amount first. */
  payment_candidates: PaymentCandidate[];
  gl_accounts: GlAccountOption[];
  /** The business's products (not archived), to link a line to. */
  products: ProductOption[];
}
