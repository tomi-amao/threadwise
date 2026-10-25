/**
 * Reports API Service
 *
 * Server-side data fetching for the Financial Reports page.
 * Supports date-range filtering for accurate period-specific reporting.
 *
 * Principle: JOURNAL-FIRST for accrual-based metrics (P&L, Balance Sheet).
 * Use transactional tables (orders, payments) for cash/operational metrics.
 *
 * Data sources:
 * - Revenue Analysis: orders, payments, payment_fees, order_line_items
 * - Profit & Loss: journals (posted) → journal_line_items → chart_of_accounts
 * - Balance Sheet: journals (posted, cumulative) → journal_line_items → chart_of_accounts
 * - Cash Flow: financial_transactions (direct method), bank_accounts
 *
 * Every function takes the Supabase client to read with. Callers pass the signed-in user's
 * (see getRequestSupabaseClient), so row-level security limits each read to their own business.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getDerivedBankBalances } from './bank-balance.server';
import { fetchAllRows } from './paginate.server';
import { getRevenueMetricsData } from './revenue-metrics.server';

// ─── Types ────────────────────────────────────────────────────────────

export interface RevenueReport {
  grossRevenue: number;
  grossSales: number;
  discounts: number;
  netSales: number;
  shippingCollected: number;
  shippingCost: number;
  shippingMargin: number;
  taxCollected: number;
  refunds: number;
  returns: number;
  totalSales: number;
  processingFees: number;
  soldCogs: number;
  giftedStockCost: number;
  netRevenue: number;
  orderCount: number;
  avgOrderValue: number;
}

export interface MonthlyRow {
  month: string;
  totalSales: number;
  discounts: number;
  returns: number;
  processingFees: number;
  cogs: number;
  shippingCost: number;
  otherOutbound: number;
  grossProfit: number;
  operatingExpenses: number;
  netIncome: number;
  orders: number;
}

export interface CogsDetailLine {
  month: string;
  orderId: string;
  /** What the shop calls the order, e.g. #1001. */
  orderNumber: string | null;
  /** The product as named on the order line. */
  productName: string | null;
  orderCreatedAt: string;
  lineItemId: string;
  productId: string | null;
  quantity: number;
  resolvedCogs: number;
  source: 'sale_snapshot';
}

export interface MonthlyCogsDetails {
  month: string;
  totalCogs: number;
  lineCount: number;
  lines: CogsDetailLine[];
}

export interface ExpenseDetailLine {
  month: string;
  transactionId: string;
  occurredAt: string;
  description: string | null;
  transactionType: string;
  amount: number;
  bucket: 'shipping' | 'other_expenses' | 'other_outbound';
  excluded: boolean;
}

export interface MonthlyExpenseDetails {
  month: string;
  totalAmount: number;
  lineCount: number;
  lines: ExpenseDetailLine[];
}

export interface AccountLine {
  id?: string;
  name: string;
  code: number;
  balance: number;
}

export interface PnLSection {
  type: string;
  label: string;
  accounts: AccountLine[];
  total: number;
}

export interface AccountingPnL {
  sections: PnLSection[];
  grossProfit: number;
  netIncome: number;
}

export interface BalanceSheetReport {
  assets: AccountLine[];
  liabilities: AccountLine[];
  equity: AccountLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanceCheck: number;
}

export interface CashFlowLine {
  label: string;
  amount: number;
  accountNumber: string | null;
  txnCount: number;
}

export interface CashFlowReport {
  operating: CashFlowLine[];
  investing: CashFlowLine[];
  financing: CashFlowLine[];
  totalOperating: number;
  totalInvesting: number;
  totalFinancing: number;

  /**
   * Cash that moved through the bank but has no posted journal yet, so the
   * ledger can't say what it was for. Included in netChange — the money did
   * move — but held apart from the classified sections rather than being
   * silently dropped into operating.
   */
  unclassified: CashFlowLine[];
  totalUnclassified: number;

  netChange: number;

  /** Bank balance at the start of the period, rolled back from the bank's own snapshot. */
  openingBalance: number;
  /** openingBalance + netChange — what the statement itself implies. */
  closingBalance: number;
  /** Independently derived from the bank's snapshot; the figure to trust. */
  closingBalancePerBank: number;
  /** closingBalance − closingBalancePerBank. Zero when the statement is coherent. */
  reconciliationVariance: number;
  reconciles: boolean;
  /**
   * Whether the variance is big enough to distrust the statement over.
   *
   * A small residual is expected: the bank-balance derivation counts a
   * currency conversion's surviving leg as an inflow when its opposite leg was
   * excluded as noise, so a period containing one drifts by that leg's value.
   * Worth disclosing, not worth alarming over.
   */
  varianceIsMaterial: boolean;
  /**
   * True when an all-time statement implies a negative or materially non-zero
   * opening balance — impossible for a real bank account, and therefore a sign
   * that transaction history is incomplete before the earliest bank snapshot.
   */
  openingBalanceImplausible: boolean;

  /** Internal moves between the entity's own accounts, netted out of the statement. */
  internalTransfersEliminated: number;

  coverage: {
    cashTxns: number;
    journalledTxns: number;
    /** Cash movements with no posted journal — the sum of the two below. */
    unjournalledTxns: number;
    /** Has a draft journal: needs reviewing and posting, not generating. */
    draftTxns: number;
    /** No journal of any kind yet. */
    noJournalTxns: number;
  };

  endingBalanceAsOf: string | null;
  endingBalanceIsLive: boolean;
}

/** One month of cash movement, classified the same way as the statement. */
export interface CashMonthPoint {
  month: string;
  label: string;
  operating: number;
  financing: number;
  investing: number;
  net: number;
  /** The calendar month still in progress — partial, so not comparable to the rest. */
  isPartial: boolean;
}

export interface SafeToSpendLine {
  label: string;
  amount: number;
  detail: string;
}

/**
 * Forward-looking read on cash, always over a trailing window ending today —
 * deliberately independent of the statement's date filter, because "how much
 * can I spend" is a question about now, not about a historical period.
 */
export interface CashInsights {
  monthly: CashMonthPoint[];
  /** Complete months only — the current partial month is excluded from every average. */
  completeMonths: number;
  trailing6Operating: number;
  trailing12Operating: number;
  trailing12Financing: number;
  avgMonthlyOperating: number;
  bestMonth: { label: string; amount: number } | null;
  worstMonth: { label: string; amount: number } | null;

  verdict: 'generating' | 'breakeven' | 'consuming' | 'insufficient_data';
  verdictHeadline: string;
  verdictDetail: string;

  cashOnHand: number;
  safeToSpend: number;
  safeToSpendLines: SafeToSpendLine[];

  /** Months of cover at the trailing average burn — only when actually consuming cash. */
  runwayMonths: number | null;

  selfFunding: {
    tradingCumulative: number;
    directorCumulative: number;
    pctFromTrading: number | null;
    trailing12Covered: boolean;
  };
}

export interface ReportsData {
  dateRange: { from: string; to: string };
  cashInsights: CashInsights;
  revenue: RevenueReport;
  monthly: MonthlyRow[];
  cogsDetailsByMonth: Record<string, MonthlyCogsDetails>;
  shippingDetailsByMonth: Record<string, MonthlyExpenseDetails>;
  otherExpensesDetailsByMonth: Record<string, MonthlyExpenseDetails>;
  otherOutboundDetailsByMonth: Record<string, MonthlyExpenseDetails>;
  accountingPnL: AccountingPnL;
  balanceSheet: BalanceSheetReport;
  cashFlow: CashFlowReport;
}

export type ReportStatement = 'pnl' | 'balance';

export interface AccountDrilldownLine {
  id: string;
  accountId: string;
  accountName: string;
  accountCode: number;
  debit: number;
  credit: number;
  currency: string | null;
  gbpEquivalent: number | null;
  description: string | null;
}

export interface AccountDrilldownEntry {
  journalId: string;
  journalDate: string;
  journalType: string;
  journalDescription: string | null;
  postedAt: string | null;
  createdAt: string | null;
  sourceType: string | null;
  sourceKind: 'transaction' | 'payment' | 'order' | 'manual' | 'other';
  sourceLabel: string;
  sourceId: string | null;
  sourceReference: string | null;
  sourceExternalId: string | null;
  sourceSubtitle: string | null;
  amount: number;
  debit: number;
  credit: number;
  lineDescription: string | null;
  lines: AccountDrilldownLine[];
}

export interface AccountDrilldownData {
  statement: ReportStatement;
  accountId: string;
  accountName: string;
  accountCode: number;
  accountType: string;
  normalBalance: string;
  total: number;
  entryCount: number;
  rangeLabel: string;
  entries: AccountDrilldownEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Money formatting for narrative text built server-side. */
function formatGbp(value: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function dateGte(date: string): string {
  return date + 'T00:00:00Z';
}
/** The calendar day before `date` (YYYY-MM-DD). */
function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
function dateLte(date: string): string {
  return date + 'T23:59:59.999Z';
}

function isTimestampInRange(
  timestamp: string | null | undefined,
  from: string | null,
  to: string | null
): boolean {
  if (!timestamp) return false;
  if (from && timestamp < dateGte(from)) return false;
  if (to && timestamp > dateLte(to)) return false;
  return true;
}

function getStatementLineAmounts(line: {
  debit?: number | string | null;
  credit?: number | string | null;
  currency?: string | null;
  gbp_equivalent?: number | string | null;
}): { debit: number; credit: number; skipped: boolean } {
  const rawDebit = Number(line.debit || 0);
  const rawCredit = Number(line.credit || 0);
  const gbpEquivalent =
    line.gbp_equivalent != null && line.gbp_equivalent !== '' ? Number(line.gbp_equivalent) : null;
  const currency = typeof line.currency === 'string' ? line.currency.toUpperCase() : null;
  const isNonGbp = currency && currency !== 'GBP';

  if (isNonGbp && gbpEquivalent == null) {
    return { debit: 0, credit: 0, skipped: true };
  }

  if (isNonGbp && gbpEquivalent != null) {
    const isDebit = rawDebit > 0;
    return {
      debit: isDebit ? gbpEquivalent : 0,
      credit: isDebit ? 0 : gbpEquivalent,
      skipped: false,
    };
  }

  return { debit: rawDebit, credit: rawCredit, skipped: false };
}

function getNaturalBalanceAmount(
  normalBalance: string | null | undefined,
  debit: number,
  credit: number
) {
  return (normalBalance || '').trim() === 'credit' ? credit - debit : debit - credit;
}

function toTitleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// ─── Cash-flow classification ─────────────────────────────────────────

type CfSection = 'operating' | 'investing' | 'financing';

/**
 * Does this payee look like a shipping / fulfilment provider?
 *
 * Used only to split outbound spend into the monthly expense buckets on the
 * revenue report. Cash-flow classification deliberately does NOT use payee
 * names — see classifyContraAccount.
 */
function isShippingVendor(description?: string | null): boolean {
  if (!description) return false;
  const d = description.toLowerCase();
  return (
    d.includes('fedex') ||
    d.includes('ups') ||
    d.includes('royal mail') ||
    d.includes('parcel2go') ||
    d.includes('dhl') ||
    d.includes('click and drop') ||
    d.includes('click & drop') ||
    d.includes('easyship') ||
    d.includes('shippo') ||
    d.includes('4filment') ||
    d.includes('4filmentltd') ||
    d.includes('evri') ||
    d.includes('dpd') ||
    d.includes('delivery services')
  );
}

/**
 * Accounts that count as cash for cash-flow purposes.
 *
 * Only the real bank accounts qualify. Merchant Services Clearing (1012) and
 * the PayPal accounts (1013/1019) are money owed to the business or in
 * transit, not money it holds — and PayPal records in particular are
 * pass-through views of cash that also moves through the bank, so treating
 * them as cash would count the same money twice.
 */
const CASH_ACCOUNT_NUMBERS = new Set(['1010', '1011', '1014', '1015', '1016']);

/**
 * Classify a cash movement by the account on the other side of its journal.
 *
 * This replaces vendor-name string matching. The ledger already knows what a
 * payment was for — a Shopify payout settles merchant clearing, a director
 * transfer moves the loan account — so the contra account is a far more
 * reliable signal than the payee's name, and it doesn't silently
 * misclassify the first time a new supplier appears.
 */
function classifyContraAccount(accountNumber: string, accountType: string): CfSection {
  // Fixed assets — buying or disposing of productive capacity.
  if (accountNumber >= '1200' && accountNumber <= '1299') return 'investing';
  // Long-term debt, lease obligations, director's loan account.
  if (accountNumber === '2210' || accountNumber === '2220' || accountNumber === '2230') {
    return 'financing';
  }
  // Share capital, drawings, capital introduced.
  if (accountType === 'equity') return 'financing';
  // Revenue, COGS, expenses, working capital — the trading cycle.
  return 'operating';
}

// ─── Rows as the queries below select them ────────────────────────────

type Num = number | string | null;

interface TxnRow {
  id: string;
  amount: Num;
  base_amount: Num;
  direction: string | null;
  transaction_type: string | null;
  status: string | null;
  occurred_at: string | null;
  description: string | null;
  excluded_reason: string | null;
  bank_account_id: string | null;
}

interface OrderLineRow {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string | null;
  quantity: Num;
  created_at: string | null;
}

interface MovementRow {
  id: string;
  inventory_item_id: string | null;
  reference_id: string | null;
  reference_table: string | null;
  transaction_type: string;
  quantity: Num;
  unit_cost: Num;
  movement_date: string | null;
}

interface JournalHeadRow {
  id: string;
  journal_date: string;
  status: string;
  source_type: string | null;
  source_id: string | null;
}

interface JournalLineRow {
  journal_id: string;
  account_id: string;
  debit: Num;
  credit: Num;
  currency: string | null;
  gbp_equivalent: Num;
}

interface TaxPeriodRow {
  status: string;
  ledger_basis: boolean;
  tax_due: Num;
  label: string;
  effective_rate: Num;
  taxable_profit: Num;
  payment_due: string;
}

/** A journal as the account drill-down selects it (more columns than the statements need). */
interface DrilldownJournalRow extends JournalHeadRow {
  journal_type: string | null;
  description: string | null;
  posted_at: string | null;
  created_at: string | null;
}

interface DrilldownLineRow extends JournalLineRow {
  id: string;
  description: string | null;
}

/** A row from a lookup table (orders, payments, transactions) where only some columns are read. */
type LookupRow = Record<string, string | null>;

interface AccountRow {
  id: string;
  name: string;
  account_type: string;
  account_number: string | number;
  normal_balance: string;
  is_header: boolean;
}

// ─── Main Function ────────────────────────────────────────────────────

export async function getReportsData(
  supabase: SupabaseClient,
  from: string | null,
  to: string | null
): Promise<ReportsData> {
  // ── Build date-filtered queries ──
  const revenueDataPromise = getRevenueMetricsData(supabase, { from, to });

  // Financial transactions, all of them: fetched unfiltered, then narrowed to the reporting
  // period in memory. The cash insights below always look at a trailing window regardless of
  // which period the statement is showing, so both need the full set. Read in full (paged by id):
  // PostgREST caps a response at 1,000 rows whatever .limit() says.
  const txnsQ = fetchAllRows<TxnRow>('financial transactions', (from, to) =>
    supabase
      .from('financial_transactions')
      .select(
        'id, amount, base_amount, direction, transaction_type, status, occurred_at, description, excluded_reason, bank_account_id'
      )
      .order('id')
      .range(from, to)
  ).then(data => ({ data }));

  // Order line items for order-driven monthly grouping. (This used `.limit(50000)`, which the API
  // cuts to 1,000, so COGS was silently computed from the first 1,000 lines only.)
  const orderLineItemsQ = fetchAllRows<OrderLineRow>('order line items', (from, to) =>
    supabase
      .from('order_line_items')
      .select('id, order_id, product_id, product_name, quantity, created_at')
      .order('id')
      .range(from, to)
  ).then(data => ({ data }));

  // Inventory movements carry the sale-time cost snapshots used for stable historical COGS.
  // superseded_at IS NULL excludes voided/duplicate movements (e.g. from order
  // re-syncs) — without this filter, voided rows were being summed into COGS.
  // RETURN carries a full-refund's stock coming back, at the same unit_cost as
  // the SALE it reverses, so netting SALE+RETURN per line naturally zeroes out
  // a refunded line's cost — no separate refund-handling logic needed here.
  const inventoryMovementsQ = fetchAllRows<MovementRow>('inventory movements', (from, to) =>
    supabase
      .from('inventory_movements')
      .select(
        'id, inventory_item_id, reference_id, reference_table, transaction_type, quantity, unit_cost, movement_date'
      )
      .in('transaction_type', ['PURCHASE', 'SALE', 'RETURN', 'GIFT'])
      .is('superseded_at', null)
      .order('id')
      .range(from, to)
  ).then(data => ({ data }));

  // Posted journals, all of them (paged by id: see above).
  const postedJournalsQ = fetchAllRows<JournalHeadRow>('journals', (from, to) =>
    supabase
      .from('journals')
      .select('id, journal_date, status, source_type, source_id')
      .eq('status', 'posted')
      .order('id')
      .range(from, to)
  );

  // Draft journals stay out of every statement — posting is the act of
  // asserting the categorisation is right — but a cash movement that already
  // has a draft needs a different fix from one with no journal at all, so the
  // cash flow report distinguishes them rather than lumping both together.
  const draftJournalsQ = supabase
    .from('journals')
    .select('source_id')
    .eq('status', 'draft')
    .eq('source_type', 'financial_transaction');

  // Every journal line (paged by id: see above).
  const lineItemsQ = fetchAllRows<JournalLineRow>('journal lines', (from, to) =>
    supabase
      .from('journal_line_items')
      .select('journal_id, account_id, debit, credit, currency, gbp_equivalent')
      .order('id')
      .range(from, to)
  );

  // Bank balances at the end of the period, and the day before it starts (for opening cash).
  const closingBalancesQ = getDerivedBankBalances(supabase, { asOf: to });
  const openingBalancesQ = from
    ? getDerivedBankBalances(supabase, { asOf: dayBefore(from) })
    : Promise.resolve(null);

  // Corporation tax periods for the safe-to-spend reserve. null means the tax engine was
  // unavailable, which must not block the page.
  const taxRowsQ = (async (): Promise<TaxPeriodRow[] | null> => {
    try {
      const { data: entityRow } = await supabase.from('entities').select('id').limit(1).single();
      if (!entityRow?.id) return [];
      const { data: taxRows } = await supabase.rpc('compute_corporation_tax', {
        p_entity_id: entityRow.id,
      });
      return (taxRows || []) as TaxPeriodRow[];
    } catch {
      return null;
    }
  })();

  // Supplier invoices raised but not yet settled.
  const openBillsQ = supabase
    .from('invoices')
    .select('gross_amount, status, invoice_type')
    .eq('invoice_type', 'PURCHASE')
    .not('status', 'in', '("PAID","CANCELLED","VOID","DRAFT")');

  // None of these depend on each other, and each is at least one round trip to the database,
  // so they all go at once rather than one after another.
  const [
    revenueData,
    accountsRes,
    txnsRes,
    orderLineItemsRes,
    inventoryMovementsRes,
    allPostedJournals,
    { data: draftJournalRows },
    allLineItems,
    derivedBankBalances,
    openingBalances,
    taxRows,
    { data: openBills },
  ] = await Promise.all([
    revenueDataPromise,
    supabase
      .from('chart_of_accounts')
      .select('id, name, account_type, account_number, normal_balance, is_header')
      .eq('status', 'active')
      .eq('is_header', false),
    txnsQ,
    orderLineItemsQ,
    inventoryMovementsQ,
    postedJournalsQ,
    draftJournalsQ,
    lineItemsQ,
    closingBalancesQ,
    openingBalancesQ,
    taxRowsQ,
    openBillsQ,
  ]);

  const txnIdsWithDraftJournal = new Set(
    (draftJournalRows || []).map(row => String(row.source_id || '')).filter(Boolean)
  );
  const orders = revenueData.orders;
  const accounts = (accountsRes.data || []) as unknown as AccountRow[];
  const postedJournals = allPostedJournals;
  const allTxns = txnsRes.data || [];
  // The statement covers the selected period; the insights use allTxns.
  const txns = allTxns.filter(txn => {
    const occurred = txn.occurred_at as string | null;
    if (!occurred) return false;
    if (from && occurred < dateGte(from)) return false;
    if (to && occurred > dateLte(to)) return false;
    return true;
  });
  const orderLineItems = orderLineItemsRes.data || [];
  const inventoryMovements = inventoryMovementsRes.data || [];

  // Build lookup maps
  const accountMap = new Map(accounts.map(a => [a.id, a]));
  const orderIds = new Set(orders.map(o => o.id));

  const sortedInventoryMovements = [...inventoryMovements].sort((a, b) =>
    String(a.movement_date || '').localeCompare(String(b.movement_date || ''))
  );
  const lastKnownUnitCostByInventoryItemId = new Map<string, number>();
  const saleSnapshotCogsByLineItemId = new Map<string, number>();
  let giftedStockCost = 0;

  for (const movement of sortedInventoryMovements) {
    const inventoryItemId = movement.inventory_item_id as string | null;
    const rawUnitCost = Number(movement.unit_cost || 0);
    const knownUnitCost = inventoryItemId
      ? (lastKnownUnitCostByInventoryItemId.get(inventoryItemId) ?? 0)
      : 0;
    const effectiveUnitCost = rawUnitCost > 0 ? rawUnitCost : knownUnitCost;
    const signedQuantity = Number(movement.quantity || 0);
    const transactionType = movement.transaction_type;

    if (inventoryItemId && rawUnitCost > 0) {
      lastKnownUnitCostByInventoryItemId.set(inventoryItemId, rawUnitCost);
    }

    if (effectiveUnitCost <= 0 || signedQuantity === 0) continue;

    // SALE (negative qty) and RETURN (positive qty, written when a full
    // refund reverses a sale) both reference an order line item. Netting
    // -quantity*cost across both means a fully-refunded line's cost is zero
    // automatically. These are the same live movements
    // create_inventory_cogs_journal sums to build the posted COGS journal,
    // so this and the accounting P&L agree by construction, not coincidence.
    if (
      (transactionType === 'SALE' || transactionType === 'RETURN') &&
      movement.reference_table === 'order_line_items'
    ) {
      const lineItemId = movement.reference_id as string | null;
      if (lineItemId) {
        const contribution = -signedQuantity * effectiveUnitCost;
        saleSnapshotCogsByLineItemId.set(
          lineItemId,
          (saleSnapshotCogsByLineItemId.get(lineItemId) || 0) + contribution
        );
      }
    }

    if (transactionType === 'GIFT' && isTimestampInRange(movement.movement_date, from, to)) {
      giftedStockCost += Math.abs(signedQuantity) * effectiveUnitCost;
    }
  }

  // The single source of cost for a line: the live SALE/RETURN movements
  // written for it (create_inventory_cogs_journal reads the exact same rows
  // to build the posted journal). No fallback to a stored or current-price
  // estimate — a line with no movement is uncosted, full stop, and shows as
  // such rather than as an invented number. Uncosted lines are tracked
  // separately by the accounting_health_checks sales_costed_* views.
  function resolveLineItemCogs(lineItem: OrderLineRow): {
    amount: number;
    source: 'sale_snapshot' | 'none';
  } {
    const lineItemId = lineItem.id as string | null;
    if (lineItemId && saleSnapshotCogsByLineItemId.has(lineItemId)) {
      return { amount: saleSnapshotCogsByLineItemId.get(lineItemId) || 0, source: 'sale_snapshot' };
    }
    return { amount: 0, source: 'none' };
  }

  function getLineItemCogs(lineItem: OrderLineRow): number {
    return resolveLineItemCogs(lineItem).amount;
  }

  // ── 1–5. Revenue Report (from orders + payment_fees) ──

  const revenueSnapshot = revenueData.snapshot;

  const revenue: RevenueReport = {
    grossRevenue: revenueSnapshot.grossRevenue,
    grossSales: revenueSnapshot.grossSales,
    discounts: revenueSnapshot.discounts,
    netSales: revenueSnapshot.netSales,
    shippingCollected: revenueSnapshot.shippingCollected,
    shippingCost: 0,
    shippingMargin: revenueSnapshot.shippingCollected,
    taxCollected: revenueSnapshot.taxCollected,
    refunds: revenueSnapshot.refunds,
    returns: revenueSnapshot.returns,
    totalSales: revenueSnapshot.totalSales,
    processingFees: revenueSnapshot.processingFees,
    soldCogs: 0,
    giftedStockCost,
    netRevenue: revenueSnapshot.netRevenue,
    orderCount: revenueSnapshot.orderCount,
    avgOrderValue: revenueSnapshot.avgOrderValue,
  };

  // ── 8. Sold COGS and gifted inventory cost for Revenue Analysis ──

  // Filter order_line_items to orders in this period
  const periodLineItems = orderLineItems.filter(li => orderIds.has(li.order_id));

  let soldCogs = 0;
  for (const li of periodLineItems) {
    soldCogs += getLineItemCogs(li);
  }

  revenue.soldCogs = soldCogs;

  // ── Monthly Breakdown ──

  // Group orders by month
  const orderMonthById = new Map<string, string>();
  const orderCreatedAtById = new Map<string, string>();
  const orderNumberById = new Map<string, string>();
  for (const o of orders) {
    if (o.order_number) orderNumberById.set(o.id, String(o.order_number));
    if (!o.created_at) continue;
    const month = (o.created_at as string).substring(0, 7);
    orderMonthById.set(o.id, month);
    orderCreatedAtById.set(o.id, String(o.created_at));
  }

  const monthCogsMap = new Map<string, number>();
  const cogsDetailsByMonth = new Map<string, MonthlyCogsDetails>();
  for (const li of periodLineItems) {
    const lineItemId = li.id as string | null;
    const orderId = li.order_id as string;
    const resolved = resolveLineItemCogs(li);
    const lineCogs = resolved.amount;
    const month = orderMonthById.get(orderId);
    if (!month) continue;
    monthCogsMap.set(month, (monthCogsMap.get(month) || 0) + lineCogs);

    if (lineCogs <= 0 || !lineItemId) continue;

    const existingMonthDetails = cogsDetailsByMonth.get(month) || {
      month,
      totalCogs: 0,
      lineCount: 0,
      lines: [],
    };

    existingMonthDetails.totalCogs += lineCogs;
    existingMonthDetails.lineCount += 1;
    existingMonthDetails.lines.push({
      month,
      orderId,
      orderNumber: orderNumberById.get(orderId) ?? null,
      productName: (li.product_name as string | null) || null,
      orderCreatedAt: orderCreatedAtById.get(orderId) || '',
      lineItemId,
      productId: (li.product_id as string | null) || null,
      quantity: Number(li.quantity || 0),
      resolvedCogs: lineCogs,
      source: 'sale_snapshot',
    });

    cogsDetailsByMonth.set(month, existingMonthDetails);
  }

  // Operating expenses per month from financial_transactions.
  const monthShippingCostMap = new Map<string, number>();
  const monthOtherOpexMap = new Map<string, number>();
  const monthOtherOutboundMap = new Map<string, number>();
  const shippingDetailsByMonth = new Map<string, MonthlyExpenseDetails>();
  const otherExpensesDetailsByMonth = new Map<string, MonthlyExpenseDetails>();
  const otherOutboundDetailsByMonth = new Map<string, MonthlyExpenseDetails>();
  let shippingCostTotal = 0;

  function pushExpenseDetail(
    detailsMap: Map<string, MonthlyExpenseDetails>,
    line: ExpenseDetailLine,
    includeInTotal: boolean
  ) {
    const existing = detailsMap.get(line.month) || {
      month: line.month,
      totalAmount: 0,
      lineCount: 0,
      lines: [],
    };
    if (includeInTotal) {
      existing.totalAmount += line.amount;
    }
    existing.lineCount += 1;
    existing.lines.push(line);
    detailsMap.set(line.month, existing);
  }

  for (const txn of txns) {
    const dir = txn.direction;
    const type = txn.transaction_type ?? '';
    const occurred = txn.occurred_at as string | null;
    if (dir !== 'out' || !occurred) continue;
    const month = occurred.substring(0, 7);
    const amount = Number(txn.base_amount || 0);
    if (amount <= 0) continue;
    const isExcluded = String(txn.status || '').toLowerCase() === 'excluded';
    const isShipping = isShippingVendor(txn.description);
    const detailLine: ExpenseDetailLine = {
      month,
      transactionId: String(txn.id || ''),
      occurredAt: occurred,
      description: (txn.description as string | null) || null,
      transactionType: String(type || 'other'),
      amount,
      bucket: 'other_outbound',
      excluded: isExcluded,
    };

    if (isShipping) {
      if (!isExcluded) {
        monthShippingCostMap.set(month, (monthShippingCostMap.get(month) || 0) + amount);
        shippingCostTotal += amount;
      }
      if (detailLine.transactionId) {
        pushExpenseDetail(
          shippingDetailsByMonth,
          { ...detailLine, bucket: 'shipping' },
          !isExcluded
        );
      }
      continue;
    }

    if (['fee', 'other'].includes(type)) {
      if (!isExcluded) {
        monthOtherOpexMap.set(month, (monthOtherOpexMap.get(month) || 0) + amount);
      }
      if (detailLine.transactionId) {
        pushExpenseDetail(
          otherExpensesDetailsByMonth,
          { ...detailLine, bucket: 'other_expenses' },
          !isExcluded
        );
      }
      continue;
    }

    if (!isExcluded) {
      monthOtherOutboundMap.set(month, (monthOtherOutboundMap.get(month) || 0) + amount);
    }
    if (detailLine.transactionId) {
      pushExpenseDetail(
        otherOutboundDetailsByMonth,
        { ...detailLine, bucket: 'other_outbound' },
        !isExcluded
      );
    }
  }

  revenue.shippingCost = shippingCostTotal;
  revenue.shippingMargin = revenue.shippingCollected - shippingCostTotal;

  const monthly: MonthlyRow[] = Array.from(
    new Set([
      ...Object.keys(revenueData.monthly),
      ...monthCogsMap.keys(),
      ...monthShippingCostMap.keys(),
      ...monthOtherOpexMap.keys(),
      ...monthOtherOutboundMap.keys(),
    ])
  )
    .map(month => {
      const monthMetrics = revenueData.monthly[month] || {
        grossSales: 0,
        discounts: 0,
        returns: 0,
        netSales: 0,
        shippingCollected: 0,
        taxCollected: 0,
        totalSales: 0,
        processingFees: 0,
        orderCount: 0,
      };
      const monthCogs = monthCogsMap.get(month) || 0;
      const shippingCost = monthShippingCostMap.get(month) || 0;
      const otherOutbound = monthOtherOutboundMap.get(month) || 0;
      const opex = (monthOtherOpexMap.get(month) || 0) + shippingCost;
      const grossProfit = monthMetrics.totalSales - monthCogs;
      return {
        month,
        totalSales: monthMetrics.totalSales,
        discounts: monthMetrics.discounts,
        returns: monthMetrics.returns,
        processingFees: monthMetrics.processingFees,
        cogs: monthCogs,
        shippingCost,
        otherOutbound,
        grossProfit,
        operatingExpenses: opex,
        netIncome: grossProfit - opex,
        orders: monthMetrics.orderCount,
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month));

  const cogsDetailsByMonthRecord: Record<string, MonthlyCogsDetails> = {};
  for (const [month, details] of cogsDetailsByMonth) {
    cogsDetailsByMonthRecord[month] = {
      ...details,
      lines: [...details.lines].sort((a, b) => a.orderCreatedAt.localeCompare(b.orderCreatedAt)),
    };
  }

  const shippingDetailsByMonthRecord: Record<string, MonthlyExpenseDetails> = {};
  for (const [month, details] of shippingDetailsByMonth) {
    shippingDetailsByMonthRecord[month] = {
      ...details,
      lines: [...details.lines].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
    };
  }

  const otherExpensesDetailsByMonthRecord: Record<string, MonthlyExpenseDetails> = {};
  for (const [month, details] of otherExpensesDetailsByMonth) {
    otherExpensesDetailsByMonthRecord[month] = {
      ...details,
      lines: [...details.lines].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
    };
  }

  const otherOutboundDetailsByMonthRecord: Record<string, MonthlyExpenseDetails> = {};
  for (const [month, details] of otherOutboundDetailsByMonth) {
    otherOutboundDetailsByMonthRecord[month] = {
      ...details,
      lines: [...details.lines].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
    };
  }

  // ── Journal filtering ──
  // Only use posted journals. Already filtered by status='posted' in query.

  // P&L journals: within the date range
  const pnlJournalIds = new Set(
    postedJournals
      .filter(j => {
        const d = j.journal_date as string;
        if (from && d < dateGte(from)) return false;
        if (to && d > dateLte(to)) return false;
        return true;
      })
      .map(j => j.id)
  );

  // Balance sheet journals: ALL posted journals up to the 'to' date (cumulative from inception)
  // NOTE: 'from' is intentionally NOT applied — balance sheet is always cumulative from inception.
  // Only the end date matters: it shows the company's position "as of" that date.
  const bsJournalIds = new Set(
    postedJournals.filter(j => !to || (j.journal_date as string) <= dateLte(to)).map(j => j.id)
  );

  // ── Accounting P&L ──

  const pnlBalanceMap = new Map<string, { debit: number; credit: number }>();
  for (const li of allLineItems) {
    if (!pnlJournalIds.has(li.journal_id)) continue;
    // For non-GBP entries: use gbp_equivalent if available, otherwise skip.
    // NULL currency is treated as GBP (legacy rows before currency column was added).
    const liCurrency: string | null = li.currency;
    const gbpEquiv: number | null = li.gbp_equivalent != null ? Number(li.gbp_equivalent) : null;
    const isNonGbp = liCurrency && liCurrency.toUpperCase() !== 'GBP';
    if (isNonGbp && gbpEquiv == null) continue;
    const acctId = li.account_id;
    const existing = pnlBalanceMap.get(acctId) || { debit: 0, credit: 0 };
    if (isNonGbp && gbpEquiv != null) {
      // Use GBP equivalent, preserving the debit/credit direction
      const isDebit = Number(li.debit || 0) > 0;
      existing.debit += isDebit ? gbpEquiv : 0;
      existing.credit += isDebit ? 0 : gbpEquiv;
    } else {
      existing.debit += Number(li.debit || 0);
      existing.credit += Number(li.credit || 0);
    }
    pnlBalanceMap.set(acctId, existing);
  }

  const revenueAccounts: AccountLine[] = [];
  const cogsAccounts: AccountLine[] = [];
  const expenseAccounts: AccountLine[] = [];

  for (const [accountId, totals] of pnlBalanceMap) {
    const acct = accountMap.get(accountId);
    if (!acct) continue;
    const type = acct.account_type as string;
    const code = Number(acct.account_number || 0);
    const normalBalance = (acct.normal_balance as string)?.trim();

    // Revenue-type accounts ALWAYS net as credit - debit, even the contra-revenue
    // ones (4100/4110/4120/4130, which carry normal_balance='debit' because their
    // expected entries are debits). Branching on normal_balance here would make a
    // debited contra-revenue account produce a *positive* balance that then gets
    // summed straight into totalRevAccounting below — inflating revenue by the
    // refund/discount amount instead of reducing it. Every other type in this
    // chart is uniformly debit-normal (cogs, expense) or uniformly credit-normal
    // (liability, equity), so only revenue needs the special case.
    const balance =
      type === 'revenue'
        ? totals.credit - totals.debit
        : normalBalance === 'credit'
          ? totals.credit - totals.debit
          : totals.debit - totals.credit;

    if (balance === 0) continue;

    const entry = { id: accountId, name: acct.name, code, balance };
    switch (type) {
      case 'revenue':
        revenueAccounts.push(entry);
        break;
      case 'cogs':
        cogsAccounts.push(entry);
        break;
      case 'expense':
        expenseAccounts.push(entry);
        break;
    }
  }

  revenueAccounts.sort((a, b) => a.code - b.code);
  cogsAccounts.sort((a, b) => a.code - b.code);
  expenseAccounts.sort((a, b) => a.code - b.code);

  const totalRevAccounting = revenueAccounts.reduce((s, a) => s + a.balance, 0);
  const totalCOGS = cogsAccounts.reduce((s, a) => s + a.balance, 0);
  const totalExpenses = expenseAccounts.reduce((s, a) => s + a.balance, 0);
  const grossProfit = totalRevAccounting - totalCOGS;
  const netIncome = grossProfit - totalExpenses;

  const accountingPnL: AccountingPnL = {
    sections: [
      { type: 'revenue', label: 'Revenue', accounts: revenueAccounts, total: totalRevAccounting },
      { type: 'cogs', label: 'Cost of Goods Sold', accounts: cogsAccounts, total: totalCOGS },
      {
        type: 'expense',
        label: 'Operating Expenses',
        accounts: expenseAccounts,
        total: totalExpenses,
      },
    ],
    grossProfit,
    netIncome,
  };

  // ── Balance Sheet (cumulative from inception up to 'to' date) ──

  const bsBalanceMap = new Map<string, { debit: number; credit: number }>();
  for (const li of allLineItems) {
    if (!bsJournalIds.has(li.journal_id)) continue;
    // For non-GBP entries: use gbp_equivalent if available, otherwise skip.
    const liCurrencyBs: string | null = li.currency;
    const gbpEquivBs: number | null = li.gbp_equivalent != null ? Number(li.gbp_equivalent) : null;
    const isNonGbpBs = liCurrencyBs && liCurrencyBs.toUpperCase() !== 'GBP';
    if (isNonGbpBs && gbpEquivBs == null) continue;
    const acctId = li.account_id;
    const existing = bsBalanceMap.get(acctId) || { debit: 0, credit: 0 };
    if (isNonGbpBs && gbpEquivBs != null) {
      const isDebit = Number(li.debit || 0) > 0;
      existing.debit += isDebit ? gbpEquivBs : 0;
      existing.credit += isDebit ? 0 : gbpEquivBs;
    } else {
      existing.debit += Number(li.debit || 0);
      existing.credit += Number(li.credit || 0);
    }
    bsBalanceMap.set(acctId, existing);
  }

  const bsAssets: AccountLine[] = [];
  const bsLiabilities: AccountLine[] = [];
  const bsEquity: AccountLine[] = [];

  // Also compute all-time net income for Retained Earnings
  let allTimeRevenue = 0;
  let allTimeCogs = 0;
  let allTimeExpenses = 0;
  let explicitRetainedEarningsBalance = 0;

  for (const [accountId, totals] of bsBalanceMap) {
    const acct = accountMap.get(accountId);
    if (!acct) continue;
    const type = acct.account_type as string;
    const code = Number(acct.account_number || 0);
    // Every asset nets as debit - credit and every liability/equity nets as
    // credit - debit, regardless of that specific account's own
    // normal_balance. Branching per-account instead (as the P&L's revenue
    // total once did) would compute a POSITIVE balance for a debited
    // contra-asset or contra-equity account, which then sums straight into
    // totalAssets/totalEquity below and inflates the total instead of
    // reducing it. Dormant today only because no contra-asset (2 accounts,
    // credit-normal) or contra-equity (1 account, debit-normal) has ever
    // been posted to — same bug class as the P&L fix above, same fix.
    const balance = type === 'asset' ? totals.debit - totals.credit : totals.credit - totals.debit;

    // Accumulate all-time P&L for retained earnings
    if (type === 'revenue') allTimeRevenue += totals.credit - totals.debit;
    if (type === 'cogs') allTimeCogs += totals.debit - totals.credit;
    if (type === 'expense') allTimeExpenses += totals.debit - totals.credit;

    // The app synthesizes retained earnings from lifetime P&L because nominal
    // accounts are not year-end closed. If there are explicit postings to 3030,
    // fold them into that synthetic line rather than showing a duplicate.
    if (type === 'equity' && code === 3030) {
      explicitRetainedEarningsBalance += balance;
      continue;
    }

    if (balance === 0) continue;
    const entry = { id: accountId, name: acct.name, code, balance };

    switch (type) {
      case 'asset':
        bsAssets.push(entry);
        break;
      case 'liability':
        bsLiabilities.push(entry);
        break;
      case 'equity':
        bsEquity.push(entry);
        break;
    }
  }

  // Add Retained Earnings as a synthetic equity line
  const retainedEarnings =
    allTimeRevenue - allTimeCogs - allTimeExpenses + explicitRetainedEarningsBalance;
  if (retainedEarnings !== 0) {
    bsEquity.push({ name: 'Retained Earnings', code: 9999, balance: retainedEarnings });
  }

  bsAssets.sort((a, b) => a.code - b.code);
  bsLiabilities.sort((a, b) => a.code - b.code);
  bsEquity.sort((a, b) => a.code - b.code);

  const totalAssets = bsAssets.reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = bsLiabilities.reduce((s, a) => s + a.balance, 0);
  const totalEquity = bsEquity.reduce((s, a) => s + a.balance, 0);

  const balanceSheet: BalanceSheetReport = {
    assets: bsAssets,
    liabilities: bsLiabilities,
    equity: bsEquity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    // Should be ~0 if books are balanced: assets - (liabilities + equity)
    balanceCheck: Math.round((totalAssets - totalLiabilities - totalEquity) * 100) / 100,
  };

  // ── Cash Flow (direct method, ledger-classified) ──
  //
  // Three rules govern this statement, and they're what make it reconcile:
  //
  //  1. The cash perimeter is the real bank accounts only. PayPal records are
  //     pass-through views of money that also moves through the bank, so
  //     counting them would count the same cash twice; they carry no
  //     bank_account_id and drop out here.
  //  2. Movement comes from the bank transactions, filtered identically to the
  //     balance derivation — same population in, so the statement can close.
  //  3. Classification comes from each transaction's journal, via the account
  //     on the other side of the entry, rather than from the payee's name.

  const perimeterAccountIds = new Set(derivedBankBalances.accounts.map(account => account.id));

  // Must mirror getDerivedBankBalances' own filter exactly (status <> 'excluded',
  // active bank account) or the closing balance won't tie to the movement.
  const cashTxns = txns.filter(txn => {
    if (String(txn.status || '').toLowerCase() === 'excluded') return false;
    const bankAccountId = txn.bank_account_id;
    return bankAccountId != null && perimeterAccountIds.has(bankAccountId);
  });

  const postedJournalIds = new Set(postedJournals.map(journal => journal.id));
  const journalIdByTxnId = new Map<string, string>();
  for (const journal of postedJournals) {
    const sourceId = journal.source_id;
    if (journal.source_type === 'financial_transaction' && sourceId) {
      journalIdByTxnId.set(String(sourceId), String(journal.id));
    }
  }

  const cashFlowLinesByJournal = new Map<string, JournalLineRow[]>();
  for (const lineItem of allLineItems) {
    const journalId = String(lineItem.journal_id || '');
    if (!postedJournalIds.has(journalId)) continue;
    const existing = cashFlowLinesByJournal.get(journalId);
    if (existing) existing.push(lineItem);
    else cashFlowLinesByJournal.set(journalId, [lineItem]);
  }

  /**
   * Split one cash movement into the sections its journal says it belongs to.
   *
   * Shared by the statement and the trailing-window insights so the two can
   * never drift apart — a month in the chart is the same arithmetic as the
   * same month in the statement.
   */
  type CashTxnClassification =
    | { kind: 'unjournalled'; label: string; signed: number }
    | { kind: 'internal'; signed: number }
    | {
        kind: 'classified';
        signed: number;
        shares: Array<{ section: CfSection; account: AccountRow; share: number }>;
      };

  const classifyCashTxn = (txn: TxnRow): CashTxnClassification | null => {
    const amount = Number(txn.base_amount || txn.amount || 0);
    const signed = txn.direction === 'in' ? amount : -amount;
    if (Math.round(signed * 100) === 0) return null;

    const journalId = journalIdByTxnId.get(String(txn.id));
    const lines = journalId ? cashFlowLinesByJournal.get(journalId) : undefined;

    if (!lines || lines.length === 0) {
      // Real cash movement with no posted journal behind it. Keep it visible
      // rather than guessing a category — but say which fix it needs: a draft
      // journal is waiting to be reviewed and posted, no journal at all needs
      // generating first.
      return {
        kind: 'unjournalled',
        signed,
        label: txnIdsWithDraftJournal.has(String(txn.id))
          ? 'Draft journal awaiting review'
          : 'No journal yet',
      };
    }

    // The contra side is everything that isn't cash. Weighting by its absolute
    // value lets a mixed journal (say a payout that also books a fee) split
    // across sections in proportion to what it actually paid for.
    const contra: Array<{ account: AccountRow; weight: number }> = [];
    let contraWeightTotal = 0;
    for (const lineItem of lines) {
      const account = accountMap.get(String(lineItem.account_id));
      if (!account) continue;
      if (CASH_ACCOUNT_NUMBERS.has(String(account.account_number))) continue;
      const weight = Math.abs(Number(lineItem.debit || 0) - Number(lineItem.credit || 0));
      if (weight === 0) continue;
      contra.push({ account, weight });
      contraWeightTotal += weight;
    }

    if (contra.length === 0 || contraWeightTotal === 0) {
      // Cash on both sides only — an internal move between the entity's own
      // accounts (an FX conversion, a sweep). No cash entered or left the
      // business, so it belongs in no section.
      return { kind: 'internal', signed };
    }

    return {
      kind: 'classified',
      signed,
      shares: contra.map(({ account, weight }) => ({
        account,
        section: classifyContraAccount(
          String(account.account_number),
          String(account.account_type)
        ),
        share: signed * (weight / contraWeightTotal),
      })),
    };
  };

  const cfOperating = new Map<string, { amount: number; accountNumber: string; count: number }>();
  const cfInvesting = new Map<string, { amount: number; accountNumber: string; count: number }>();
  const cfFinancing = new Map<string, { amount: number; accountNumber: string; count: number }>();
  const cfUnclassified = new Map<string, { amount: number; count: number }>();

  let internalTransfersEliminated = 0;
  let journalledTxnCount = 0;

  const bucketFor = (section: CfSection) =>
    section === 'operating' ? cfOperating : section === 'investing' ? cfInvesting : cfFinancing;

  for (const txn of cashTxns) {
    const classification = classifyCashTxn(txn);
    if (!classification) continue;

    if (classification.kind === 'unjournalled') {
      const entry = cfUnclassified.get(classification.label) || { amount: 0, count: 0 };
      entry.amount += classification.signed;
      entry.count += 1;
      cfUnclassified.set(classification.label, entry);
      continue;
    }

    journalledTxnCount += 1;

    if (classification.kind === 'internal') {
      internalTransfersEliminated += 1;
      continue;
    }

    for (const { account, section, share } of classification.shares) {
      if (Math.round(share * 100) === 0) continue;
      const bucket = bucketFor(section);
      const label = String(account.name || 'Unallocated');
      const entry = bucket.get(label) || {
        amount: 0,
        accountNumber: String(account.account_number),
        count: 0,
      };
      entry.amount += share;
      entry.count += 1;
      bucket.set(label, entry);
    }
  }

  const toArray = (
    m: Map<string, { amount: number; accountNumber: string; count: number }>
  ): CashFlowLine[] =>
    Array.from(m.entries())
      .map(([label, v]) => ({
        label,
        amount: Math.round(v.amount * 100) / 100,
        accountNumber: v.accountNumber,
        txnCount: v.count,
      }))
      .filter(({ amount }) => Math.round(amount * 100) !== 0)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const operating = toArray(cfOperating);
  const investing = toArray(cfInvesting);
  const financing = toArray(cfFinancing);
  const unclassified: CashFlowLine[] = Array.from(cfUnclassified.entries())
    .map(([label, v]) => ({
      label,
      amount: Math.round(v.amount * 100) / 100,
      accountNumber: null,
      txnCount: v.count,
    }))
    .filter(({ amount }) => Math.round(amount * 100) !== 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const round2 = (value: number) => Math.round(value * 100) / 100;

  const totalOperating = round2(operating.reduce((s, a) => s + a.amount, 0));
  const totalInvesting = round2(investing.reduce((s, a) => s + a.amount, 0));
  const totalFinancing = round2(financing.reduce((s, a) => s + a.amount, 0));
  const totalUnclassified = round2(unclassified.reduce((s, a) => s + a.amount, 0));
  const netChange = round2(totalOperating + totalInvesting + totalFinancing + totalUnclassified);

  // Opening cash: roll the bank's own snapshot back to the day before the
  // period starts. For an all-time view there is no prior day, so the opening
  // is whatever the closing balance and the period's movement imply.
  const closingBalancePerBank = derivedBankBalances.totalBalance;
  let openingBalance: number;
  if (openingBalances) {
    openingBalance = openingBalances.totalBalance;
  } else {
    openingBalance = round2(closingBalancePerBank - netChange);
  }

  const closingBalance = round2(openingBalance + netChange);
  const reconciliationVariance = round2(closingBalance - closingBalancePerBank);

  // On an all-time statement the business began with nothing, so any material
  // opening balance means the transaction history doesn't reach back far
  // enough to explain the bank's own figures. A negative one is impossible
  // outright. Either way it's a data-coverage problem worth showing.
  const openingBalanceImplausible = !from && Math.abs(openingBalance) >= 1;

  const cashFlow: CashFlowReport = {
    operating,
    investing,
    financing,
    totalOperating,
    totalInvesting,
    totalFinancing,
    unclassified,
    totalUnclassified,
    netChange,
    openingBalance,
    closingBalance,
    closingBalancePerBank,
    reconciliationVariance,
    reconciles: Math.abs(reconciliationVariance) < 0.01,
    varianceIsMaterial:
      Math.abs(reconciliationVariance) > Math.max(1, Math.abs(closingBalancePerBank) * 0.001),
    openingBalanceImplausible,
    internalTransfersEliminated,
    coverage: {
      cashTxns: cashTxns.length,
      journalledTxns: journalledTxnCount,
      // journalledTxnCount already includes the internal transfers, so they
      // must not be subtracted a second time.
      unjournalledTxns: cashTxns.length - journalledTxnCount,
      draftTxns: unclassified.find(l => l.label === 'Draft journal awaiting review')?.txnCount ?? 0,
      noJournalTxns: unclassified.find(l => l.label === 'No journal yet')?.txnCount ?? 0,
    },
    endingBalanceAsOf: derivedBankBalances.balanceAsOf,
    endingBalanceIsLive: derivedBankBalances.isLive,
  };

  // ── Cash insights (trailing window, independent of the statement's period) ──
  //
  // "Is cash healthy" and "what can I spend" are questions about now, so these
  // always look back from today regardless of which period the statement above
  // is showing. Same classification as the statement, so a month here is the
  // same arithmetic as that month there.

  const insightCashTxns = allTxns.filter(txn => {
    if (String(txn.status || '').toLowerCase() === 'excluded') return false;
    const bankAccountId = txn.bank_account_id;
    return bankAccountId != null && perimeterAccountIds.has(bankAccountId);
  });

  const now = new Date();
  const currentMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const monthlyAgg = new Map<string, { operating: number; financing: number; investing: number }>();
  // Cumulative split of where the money in the bank came from.
  let tradingCumulative = 0;
  let directorCumulative = 0;

  for (const txn of insightCashTxns) {
    const occurred = txn.occurred_at as string | null;
    if (!occurred) continue;
    const monthKey = occurred.slice(0, 7);

    const classification = classifyCashTxn(txn);
    if (!classification) continue;
    if (classification.kind === 'internal') continue;

    const bucket = monthlyAgg.get(monthKey) || { operating: 0, financing: 0, investing: 0 };

    if (classification.kind === 'unjournalled') {
      // Uncategorised cash still moved, so it belongs in the month's total.
      // Operating is the honest default: it is overwhelmingly where trading
      // spend lands, and parking it in financing would flatter the trading view.
      bucket.operating += classification.signed;
      tradingCumulative += classification.signed;
      monthlyAgg.set(monthKey, bucket);
      continue;
    }

    for (const { section, share } of classification.shares) {
      bucket[section] += share;
      if (section === 'financing') directorCumulative += share;
      else tradingCumulative += share;
    }
    monthlyAgg.set(monthKey, bucket);
  }

  const monthKeys = Array.from(monthlyAgg.keys()).sort();
  const recentKeys = monthKeys.slice(-13);
  const monthly12: CashMonthPoint[] = recentKeys.map(key => {
    const value = monthlyAgg.get(key)!;
    const [year, month] = key.split('-');
    const net = value.operating + value.financing + value.investing;
    return {
      month: key,
      label: new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString('en-GB', {
        month: 'short',
        year: '2-digit',
        timeZone: 'UTC',
      }),
      operating: round2(value.operating),
      financing: round2(value.financing),
      investing: round2(value.investing),
      net: round2(net),
      isPartial: key === currentMonthKey,
    };
  });

  // Every average and extreme below uses complete months only — a month that is
  // three weeks old would drag the picture down for no real reason.
  const completeMonths = monthly12.filter(m => !m.isPartial);
  const sumOperating = (points: CashMonthPoint[]) =>
    round2(points.reduce((sum, point) => sum + point.operating, 0));

  const trailing6Operating = sumOperating(completeMonths.slice(-6));
  const trailing12Operating = sumOperating(completeMonths.slice(-12));
  const trailing12Financing = round2(
    completeMonths.slice(-12).reduce((sum, point) => sum + point.financing, 0)
  );
  const avgMonthlyOperating =
    completeMonths.length > 0
      ? round2(trailing12Operating / Math.min(completeMonths.length, 12))
      : 0;

  const sortedByOperating = [...completeMonths].sort((a, b) => a.operating - b.operating);
  const worstMonth = sortedByOperating[0]
    ? { label: sortedByOperating[0].label, amount: sortedByOperating[0].operating }
    : null;
  const bestMonth = sortedByOperating[sortedByOperating.length - 1]
    ? {
        label: sortedByOperating[sortedByOperating.length - 1].label,
        amount: sortedByOperating[sortedByOperating.length - 1].operating,
      }
    : null;

  // The verdict leans on six months rather than one. This business trades in
  // release cycles — a single month swings from heavily negative to heavily
  // positive — so a one-month read would be noise dressed up as a signal.
  let verdict: CashInsights['verdict'] = 'insufficient_data';
  let verdictHeadline = 'Not enough history yet';
  let verdictDetail =
    'At least three complete months of bank activity are needed before the trend means anything.';

  if (completeMonths.length >= 3) {
    const window = completeMonths.slice(-6);
    const windowLabel = `the last ${window.length} complete month${window.length === 1 ? '' : 's'}`;
    const threshold = Math.max(250, Math.abs(cashFlow.closingBalancePerBank) * 0.02);
    if (trailing6Operating > threshold) {
      verdict = 'generating';
      verdictHeadline = 'Trading is generating cash';
      verdictDetail = `Over ${windowLabel} the business brought in ${formatGbp(trailing6Operating)} more than it spent, before any funding you put in.`;
    } else if (trailing6Operating < -threshold) {
      verdict = 'consuming';
      verdictHeadline = 'Trading is consuming cash';
      verdictDetail = `Over ${windowLabel} the business spent ${formatGbp(Math.abs(trailing6Operating))} more than it brought in, so the balance is being supported from elsewhere.`;
    } else {
      verdict = 'breakeven';
      verdictHeadline = 'Trading is roughly breaking even';
      verdictDetail = `Over ${windowLabel} money in and money out were within ${formatGbp(threshold)} of each other.`;
    }
  }

  // Runway only makes sense while cash is actually draining. Showing a countdown
  // for a business that is net cash-generative would invent an alarm.
  const runwayMonths =
    avgMonthlyOperating < 0 && cashFlow.closingBalancePerBank > 0
      ? Math.round((cashFlow.closingBalancePerBank / Math.abs(avgMonthlyOperating)) * 10) / 10
      : null;

  // ── Safe to spend ──
  const cashOnHand = cashFlow.closingBalancePerBank;

  // Corporation tax already accrued on this period's profit. Reuses the tax
  // engine rather than re-deriving it, so the two pages can't disagree.
  let taxReserve = 0;
  let taxReserveDetail = 'No corporation tax accrued on the current period yet.';
  if (taxRows) {
    const openPeriod = taxRows.find(row => row.status === 'open' && row.ledger_basis);
    if (openPeriod?.tax_due != null) {
      taxReserve = round2(Number(openPeriod.tax_due));
      taxReserveDetail = `Corporation tax accrued so far on ${openPeriod.label}, at ${(Number(openPeriod.effective_rate) * 100).toFixed(0)}% of ${formatGbp(Number(openPeriod.taxable_profit))} taxable profit. Payable ${new Date(`${openPeriod.payment_due}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.`;
    }
  } else {
    // The tax engine is a nice-to-have here; if it is unavailable the reserve
    // stays at zero and the note below says so rather than blocking the page.
    taxReserveDetail = 'Corporation tax figure unavailable — treat safe-to-spend as optimistic.';
  }

  // Supplier invoices raised but not yet settled.
  let unpaidBills = 0;
  for (const bill of openBills || []) {
    unpaidBills += Number(bill.gross_amount || 0);
  }
  unpaidBills = round2(unpaidBills);

  // The buffer is this business's own worst complete month, not a generic rule
  // of thumb — it is defensible precisely because you can point at the month.
  const buffer = worstMonth && worstMonth.amount < 0 ? round2(Math.abs(worstMonth.amount)) : 0;

  const safeToSpendLines: SafeToSpendLine[] = [
    {
      label: 'Cash in the bank',
      amount: cashOnHand,
      detail:
        "Derived from the bank's own reported balance, rolled forward through later transactions.",
    },
    { label: 'Less: corporation tax set aside', amount: -taxReserve, detail: taxReserveDetail },
    {
      label: 'Less: unpaid supplier bills',
      amount: -unpaidBills,
      detail:
        unpaidBills > 0
          ? 'Purchase invoices raised and still outstanding.'
          : 'No outstanding purchase invoices on the books.',
    },
    {
      label: 'Less: one bad month held back',
      amount: -buffer,
      detail: worstMonth
        ? `${worstMonth.label} was your worst trading month in the last year at ${formatGbp(worstMonth.amount)}. Holding that much back means a repeat of it would not leave you short.`
        : 'Not enough complete months yet to size a buffer from your own trading.',
    },
  ];

  const safeToSpend = round2(cashOnHand - taxReserve - unpaidBills - buffer);

  const fundingTotal = tradingCumulative + directorCumulative;
  const cashInsights: CashInsights = {
    monthly: monthly12,
    completeMonths: completeMonths.length,
    trailing6Operating,
    trailing12Operating,
    trailing12Financing,
    avgMonthlyOperating,
    bestMonth,
    worstMonth,
    verdict,
    verdictHeadline,
    verdictDetail,
    cashOnHand,
    safeToSpend,
    safeToSpendLines,
    runwayMonths,
    selfFunding: {
      tradingCumulative: round2(tradingCumulative),
      directorCumulative: round2(directorCumulative),
      pctFromTrading:
        fundingTotal > 0 ? Math.round((tradingCumulative / fundingTotal) * 1000) / 10 : null,
      trailing12Covered: trailing12Operating > 0,
    },
  };

  return {
    dateRange: { from: from || '', to: to || '' },
    cashInsights,
    revenue,
    monthly,
    cogsDetailsByMonth: cogsDetailsByMonthRecord,
    shippingDetailsByMonth: shippingDetailsByMonthRecord,
    otherExpensesDetailsByMonth: otherExpensesDetailsByMonthRecord,
    otherOutboundDetailsByMonth: otherOutboundDetailsByMonthRecord,
    accountingPnL,
    balanceSheet,
    cashFlow,
  };
}

export async function getAccountDrilldown({
  supabase,
  accountId,
  statement,
  from,
  to,
}: {
  supabase: SupabaseClient;
  accountId: string;
  statement: ReportStatement;
  from: string | null;
  to: string | null;
}): Promise<AccountDrilldownData> {
  const { data: account, error: accountError } = await supabase
    .from('chart_of_accounts')
    .select('id, name, account_type, account_number, normal_balance')
    .eq('id', accountId)
    .single();

  if (accountError || !account) {
    throw new Error(accountError?.message ?? 'Account not found');
  }

  // Paged by id: an unordered range() can repeat or skip rows between pages.
  const relevantJournals = await fetchAllRows<DrilldownJournalRow>(
    'journals',
    (rangeFrom, rangeTo) => {
      let query = supabase
        .from('journals')
        .select(
          'id, journal_date, journal_type, description, source_type, source_id, status, posted_at, created_at'
        )
        .eq('status', 'posted');
      if (statement === 'pnl') {
        if (from) query = query.gte('journal_date', dateGte(from));
        if (to) query = query.lte('journal_date', dateLte(to));
      } else if (to) {
        query = query.lte('journal_date', dateLte(to));
      }
      return query.order('id').range(rangeFrom, rangeTo);
    }
  );

  const journalMap = new Map(relevantJournals.map(journal => [journal.id, journal]));

  const selectedAccountLines = await fetchAllRows<DrilldownLineRow>(
    'account lines',
    (rangeFrom, rangeTo) =>
      supabase
        .from('journal_line_items')
        .select('id, journal_id, account_id, debit, credit, currency, gbp_equivalent, description')
        .eq('account_id', accountId)
        .order('id')
        .range(rangeFrom, rangeTo)
  );

  const relevantAccountLines = selectedAccountLines.filter(line => journalMap.has(line.journal_id));

  const accountCode = Number(account.account_number || 0);
  const accountName = String(account.name || 'Unknown Account');
  const normalBalance = String(account.normal_balance || 'debit');
  const accountType = String(account.account_type || 'other');

  const rangeLabel =
    statement === 'balance'
      ? to
        ? `As of ${to}`
        : 'All time'
      : from && to
        ? `${from} to ${to}`
        : from
          ? `From ${from}`
          : to
            ? `Through ${to}`
            : 'All time';

  if (relevantAccountLines.length === 0) {
    return {
      statement,
      accountId,
      accountName,
      accountCode,
      accountType,
      normalBalance,
      total: 0,
      entryCount: 0,
      rangeLabel,
      entries: [],
    };
  }

  const relatedJournalIds = Array.from(
    new Set(relevantAccountLines.map(line => String(line.journal_id)))
  );

  const { data: accounts, error: accountsError } = await supabase
    .from('chart_of_accounts')
    .select('id, name, account_number')
    .eq('status', 'active')
    .eq('is_header', false);

  if (accountsError) {
    throw new Error(`Failed to load chart of accounts: ${accountsError.message}`);
  }

  const detailAccountMap = new Map((accounts || []).map(entry => [entry.id, entry]));
  const relatedJournalLines: DrilldownLineRow[] = [];

  for (const batch of chunkArray(relatedJournalIds, 100)) {
    const { data: batchLines, error: batchError } = await supabase
      .from('journal_line_items')
      .select('id, journal_id, account_id, debit, credit, currency, gbp_equivalent, description')
      .in('journal_id', batch);

    if (batchError) {
      throw new Error(`Failed to load journal details: ${batchError.message}`);
    }

    relatedJournalLines.push(...(batchLines || []));
  }

  const sourceIdsByType = {
    order: new Set<string>(),
    payment: new Set<string>(),
    financial_transaction: new Set<string>(),
  };

  for (const journalId of relatedJournalIds) {
    const journal = journalMap.get(journalId);
    const sourceType = journal?.source_type;
    const sourceId = journal?.source_id ? String(journal.source_id) : null;

    if (!sourceType || !sourceId) continue;
    if (sourceType === 'order') sourceIdsByType.order.add(sourceId);
    if (sourceType === 'payment') sourceIdsByType.payment.add(sourceId);
    if (sourceType === 'financial_transaction') {
      sourceIdsByType.financial_transaction.add(sourceId);
    }
  }

  async function fetchLookupRows(table: string, select: string, ids: string[]) {
    if (ids.length === 0) return [] as LookupRow[];

    const rows: LookupRow[] = [];
    for (const batch of chunkArray(ids, 200)) {
      const { data, error } = await supabase.from(table).select(select).in('id', batch);
      if (error) {
        throw new Error(`Failed to load ${table} lookup data: ${error.message}`);
      }
      rows.push(...((data || []) as unknown as LookupRow[]));
    }

    return rows;
  }

  const [orders, payments, financialTransactions] = await Promise.all([
    fetchLookupRows(
      'orders',
      'id, external_id, order_number, provider, created_at',
      Array.from(sourceIdsByType.order)
    ),
    fetchLookupRows(
      'payments',
      'id, external_id, external_payment_id, order_external_id, transaction_id, gateway, paid_on',
      Array.from(sourceIdsByType.payment)
    ),
    fetchLookupRows(
      'financial_transactions',
      'id, external_transaction_id, description, counterparty_name, source, transaction_type, occurred_at',
      Array.from(sourceIdsByType.financial_transaction)
    ),
  ]);

  const orderMap = new Map(orders.map(row => [row.id, row]));
  const paymentMap = new Map(payments.map(row => [row.id, row]));
  const financialTransactionMap = new Map(financialTransactions.map(row => [row.id, row]));

  const linesByJournalId = new Map<string, AccountDrilldownLine[]>();
  for (const line of relatedJournalLines) {
    const detailAccount = detailAccountMap.get(line.account_id);
    const normalized = getStatementLineAmounts(line);

    const detailLine: AccountDrilldownLine = {
      id: String(line.id),
      accountId: String(line.account_id),
      accountName: detailAccount?.name || 'Unknown Account',
      accountCode: Number(detailAccount?.account_number || 0),
      debit: normalized.debit,
      credit: normalized.credit,
      currency: (line.currency as string | null) ?? null,
      gbpEquivalent: line.gbp_equivalent != null ? Number(line.gbp_equivalent) : null,
      description: (line.description as string | null) ?? null,
    };

    const journalId = String(line.journal_id);
    const existing = linesByJournalId.get(journalId) || [];
    existing.push(detailLine);
    linesByJournalId.set(journalId, existing);
  }

  for (const lines of linesByJournalId.values()) {
    lines.sort((left, right) => left.accountCode - right.accountCode);
  }

  const selectedLinesByJournalId = new Map<string, DrilldownLineRow[]>();
  for (const line of relevantAccountLines) {
    const journalId = String(line.journal_id);
    const existing = selectedLinesByJournalId.get(journalId) || [];
    existing.push(line);
    selectedLinesByJournalId.set(journalId, existing);
  }

  function getSourceSummary(
    journal: DrilldownJournalRow | undefined
  ): Pick<
    AccountDrilldownEntry,
    | 'sourceKind'
    | 'sourceLabel'
    | 'sourceId'
    | 'sourceReference'
    | 'sourceExternalId'
    | 'sourceSubtitle'
  > {
    const sourceType = (journal?.source_type as string | null) ?? null;
    const sourceId = journal?.source_id ? String(journal.source_id) : null;

    if (sourceType === 'financial_transaction' && sourceId) {
      const txn = financialTransactionMap.get(sourceId);
      const subtitle = [
        txn?.source ? toTitleCase(String(txn.source)) : null,
        txn?.transaction_type ? toTitleCase(String(txn.transaction_type)) : null,
        txn?.counterparty_name || txn?.description || null,
      ]
        .filter(Boolean)
        .join(' • ');

      return {
        sourceKind: 'transaction' as const,
        sourceLabel: 'Transaction',
        sourceId,
        sourceReference: txn?.external_transaction_id || sourceId,
        sourceExternalId: txn?.external_transaction_id || null,
        sourceSubtitle: subtitle || null,
      };
    }

    if (sourceType === 'payment' && sourceId) {
      const payment = paymentMap.get(sourceId);
      const externalId = payment?.external_payment_id || payment?.external_id || null;
      const subtitle = [
        payment?.gateway ? toTitleCase(String(payment.gateway)) : null,
        payment?.order_external_id ? `Order ${payment.order_external_id}` : null,
      ]
        .filter(Boolean)
        .join(' • ');

      return {
        sourceKind: 'payment' as const,
        sourceLabel: 'Payment',
        sourceId,
        sourceReference:
          payment?.transaction_id || payment?.order_external_id || externalId || sourceId,
        sourceExternalId: externalId,
        sourceSubtitle: subtitle || null,
      };
    }

    if (sourceType === 'order' && sourceId) {
      const order = orderMap.get(sourceId);
      return {
        sourceKind: 'order' as const,
        sourceLabel: 'Order',
        sourceId,
        sourceReference: order?.order_number
          ? `#${order.order_number}`
          : order?.external_id || sourceId,
        sourceExternalId: order?.external_id || null,
        sourceSubtitle: order?.provider ? toTitleCase(String(order.provider)) : null,
      };
    }

    if (sourceType === 'manual' || sourceType === 'manual_adjustment') {
      return {
        sourceKind: 'manual' as const,
        sourceLabel: sourceType === 'manual_adjustment' ? 'Manual Adjustment' : 'Manual Journal',
        sourceId,
        sourceReference: sourceId,
        sourceExternalId: null,
        sourceSubtitle: null,
      };
    }

    return {
      sourceKind: 'other' as const,
      sourceLabel: sourceType ? toTitleCase(sourceType) : 'Journal',
      sourceId,
      sourceReference: sourceId,
      sourceExternalId: null,
      sourceSubtitle: null,
    };
  }

  const entries: AccountDrilldownEntry[] = [];

  for (const journalId of relatedJournalIds) {
    const journal = journalMap.get(journalId);
    if (!journal) continue;

    const selectedLines = selectedLinesByJournalId.get(journalId) || [];
    let debit = 0;
    let credit = 0;
    let lineDescription: string | null = null;

    for (const line of selectedLines) {
      const normalized = getStatementLineAmounts(line);
      if (normalized.skipped) continue;
      debit += normalized.debit;
      credit += normalized.credit;
      if (!lineDescription && line.description) {
        lineDescription = String(line.description);
      }
    }

    const amount = getNaturalBalanceAmount(normalBalance, debit, credit);
    const source = getSourceSummary(journal);

    const entry: AccountDrilldownEntry = {
      journalId,
      journalDate: String(journal.journal_date),
      journalType: String(journal.journal_type || 'journal'),
      journalDescription: (journal.description as string | null) ?? null,
      postedAt: (journal.posted_at as string | null) ?? null,
      createdAt: (journal.created_at as string | null) ?? null,
      sourceType: (journal.source_type as string | null) ?? null,
      amount,
      debit,
      credit,
      lineDescription,
      lines: linesByJournalId.get(journalId) || [],
      ...source,
    };

    entries.push(entry);
  }

  entries.sort((left, right) => {
    const dateCompare = right.journalDate.localeCompare(left.journalDate);
    if (dateCompare !== 0) return dateCompare;
    return (right.createdAt || '').localeCompare(left.createdAt || '');
  });

  const total = entries.reduce((sum, entry) => sum + entry.amount, 0);

  return {
    statement,
    accountId,
    accountName,
    accountCode,
    accountType,
    normalBalance,
    total,
    entryCount: entries.length,
    rangeLabel,
    entries,
  };
}
