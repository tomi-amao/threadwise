/**
 * What the user is looking at, sent with each question so "why is this invoice unmatched?"
 * works without naming it.
 *
 * Only a name is sent: the page, its URL filters and the id of a record open in a drawer. The
 * agent never believes it: the server re-reads the record as the signed-in user and describes
 * that (see `agents/page_context.py`), so a wrong or forged id finds nothing. The `label` is
 * only for the chip the user sees ("Invoices, INV-0042"); it is never sent.
 */

export type RecordType = 'invoice' | 'order' | 'customer' | 'product' | 'transaction';

export interface PageRecord {
  type: RecordType;
  id: string;
  /** What the chip says, e.g. the invoice number. Not sent to the agent. */
  label: string | null;
}

export interface PageContext {
  route: string;
  page: string;
  filters: Record<string, string>;
  record: PageRecord | null;
}

const PAGES: [prefix: string, name: string][] = [
  ['/dashboard', 'Dashboard'],
  ['/invoices', 'Invoices'],
  ['/transactions', 'Transactions'],
  ['/reports', 'Reports'],
  ['/journals', 'Journals'],
  ['/tax', 'Tax'],
  ['/orders', 'Orders'],
  ['/products', 'Products'],
  ['/collections', 'Collections'],
  ['/inventory', 'Inventory'],
  ['/customers', 'Customers'],
  ['/integrations', 'Integrations'],
  ['/account', 'Account'],
];

/** URL parameters that name a record rather than filter a list. */
const RECORD_PARAMS = new Set(['invoice', 'order', 'customer', 'product', 'transactionId']);

export function pageName(pathname: string): string | null {
  return PAGES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? null;
}

/** The page and its filters, from the URL. null where the assistant has no page to speak of. */
export function contextFromUrl(
  pathname: string,
  search: URLSearchParams
): Omit<PageContext, 'record'> | null {
  const page = pageName(pathname);
  if (!page) return null;
  const filters: Record<string, string> = {};
  for (const [key, value] of search) {
    if (RECORD_PARAMS.has(key) || !value || Object.keys(filters).length >= 8) continue;
    filters[key.slice(0, 20)] = value.slice(0, 80);
  }
  return { route: pathname, page, filters };
}

/** What the chip says: "Invoices", or "Invoices, INV-0042". */
export function chipLabel(context: PageContext): string {
  return context.record?.label ? `${context.page}, ${context.record.label}` : context.page;
}

/** The context as the agent receives it (without the chip's label). */
export function toRunContext(context: PageContext) {
  return {
    route: context.route,
    page: context.page,
    filters: context.filters,
    record: context.record ? { type: context.record.type, id: context.record.id } : null,
  };
}
