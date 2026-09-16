/**
 * Dashboard API Service
 *
 * Server-side data fetching for the dashboard.
 * Queries actual database tables: orders, order_line_items, customers,
 * products, payments, payment_fees, bank_accounts, financial_transactions,
 * chart_of_accounts, journals, journal_line_items.
 */

import { getServerSupabaseClient, getAuthenticatedServerClient } from '~/lib/supabase';
import { getDerivedBankBalances } from './bank-balance.server';
import { getRevenueMetricsData } from './revenue-metrics.server';
import type {
  DashboardData,
  EntityInfo,
  KPIData,
  MonthlyRevenue,
  OrderStatusBreakdown,
  ProductPerformance,
  CustomerSummary,
  CustomerStats,
  PaymentMethodBreakdown,
  BankAccountSummary,
  RecentOrder,
  HealthIndicator,
  MonthlyFinancials,
} from '~/types/dashboard';

const getSupabase = getServerSupabaseClient;

// ─── Entity Info ──────────────────────────────────────────────────────

export async function getEntityInfo(request: Request): Promise<EntityInfo | null> {
  try {
    const supabase = getAuthenticatedServerClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) return null;

    const { data, error } = await supabase
      .from('entities')
      .select('id, name, currency, industry')
      .eq('owner_user_id', user.id)
      .single();

    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

// ─── Main Dashboard Data ──────────────────────────────────────────────

export async function getDashboardData(request: Request): Promise<DashboardData> {
  const supabase = getSupabase();
  const revenueDataPromise = getRevenueMetricsData(supabase);

  // Fetch all data in parallel
  const [
    revenueData,
    ordersRaw,
    lineItemsRaw,
    paymentsRaw,
    derivedBankBalances,
    recentOrdersRaw,
    customerCountRaw,
    entity,
  ] = await Promise.all([
    revenueDataPromise,
    supabase
      .from('orders')
      .select(
        'id, grand_total_amount, refunded_total_amount, shipping_total_amount, discount_total_amount, status, created_at, customer_id, customer_email, customers(id, first_name, last_name, email)'
      ),
    supabase
      .from('order_line_items')
      .select('product_id, product_name, quantity, total_price_amount, order_id'),
    supabase.from('payments').select('gateway, payment_method, net_amount, status'),
    getDerivedBankBalances(supabase),
    supabase
      .from('orders')
      .select(
        'id, order_number, status, grand_total_amount, currency, created_at, customer_email, customers(first_name, last_name)'
      )
      .order('created_at', { ascending: false })
      .limit(10),
    supabase.from('customers').select('id', { count: 'exact', head: true }),
    getEntityInfo(request),
  ]);

  const orders = ordersRaw.data || [];
  const lineItems = lineItemsRaw.data || [];
  const payments = paymentsRaw.data || [];
  const recentOrdersData = recentOrdersRaw.data || [];
  const totalCustomerCount = customerCountRaw.count || 0;
  const revenueMetrics = revenueData.snapshot;

  // Compute KPIs
  const activeOrders = orders.filter((o: any) => o.status !== 'cancelled');
  const capturedPayments = payments.filter((p: any) => p.status === 'captured');
  const totalBankBalance = derivedBankBalances.totalBalance;

  const kpis: KPIData = {
    grossRevenue: revenueMetrics.grossRevenue,
    netRevenue: revenueMetrics.netRevenue,
    totalOrders: revenueMetrics.orderCount,
    avgOrderValue: revenueMetrics.avgOrderValue,
    totalCustomers: totalCustomerCount,
    totalBankBalance,
    totalRefunds: revenueMetrics.refunds,
    processingFees: revenueMetrics.processingFees,
  };

  // Revenue by month
  const monthMap = new Map<string, { revenue: number; count: number }>();
  for (const order of activeOrders) {
    if (!order.created_at) continue;
    const month = (order.created_at as string).substring(0, 7);
    const existing = monthMap.get(month) || { revenue: 0, count: 0 };
    existing.revenue += Number(order.grand_total_amount || 0);
    existing.count += 1;
    monthMap.set(month, existing);
  }
  const revenueByMonth: MonthlyRevenue[] = Array.from(monthMap.entries())
    .map(([month, data]) => ({
      month,
      revenue: data.revenue,
      orderCount: data.count,
      avgOrderValue: data.count > 0 ? data.revenue / data.count : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Orders by status
  const statusMap = new Map<string, number>();
  for (const order of orders) {
    const s = (order as any).status || 'unknown';
    statusMap.set(s, (statusMap.get(s) || 0) + 1);
  }
  const ordersByStatus: OrderStatusBreakdown[] = Array.from(statusMap.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  // Top products
  const productMap = new Map<
    string,
    { id: string | null; name: string; qty: number; revenue: number; orders: Set<string> }
  >();
  for (const item of lineItems) {
    const key = (item as any).product_name || 'Unknown';
    const existing = productMap.get(key) || {
      id: (item as any).product_id,
      name: key,
      qty: 0,
      revenue: 0,
      orders: new Set<string>(),
    };
    existing.qty += Number((item as any).quantity || 0);
    existing.revenue += Number((item as any).total_price_amount || 0);
    existing.orders.add((item as any).order_id);
    productMap.set(key, existing);
  }
  const topProducts: ProductPerformance[] = Array.from(productMap.values())
    .map(p => ({
      id: p.id,
      name: p.name,
      totalQuantity: p.qty,
      totalRevenue: p.revenue,
      orderCount: p.orders.size,
    }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 10);

  // Top customers
  const customerMap = new Map<
    string,
    {
      id: string;
      name: string;
      email: string | null;
      orderCount: number;
      totalSpent: number;
      lastOrderDate: string | null;
    }
  >();
  for (const order of activeOrders) {
    const cust = (order as any).customers;
    const custId = (order as any).customer_id;
    if (!custId) continue;

    const existing = customerMap.get(custId) || {
      id: custId,
      name: cust
        ? [cust.first_name, cust.last_name].filter(Boolean).join(' ')
        : (order as any).customer_email || 'Unknown',
      email: cust?.email || (order as any).customer_email || null,
      orderCount: 0,
      totalSpent: 0,
      lastOrderDate: null,
    };
    existing.orderCount += 1;
    existing.totalSpent += Number((order as any).grand_total_amount || 0);
    if (
      !existing.lastOrderDate ||
      (order.created_at && order.created_at > existing.lastOrderDate)
    ) {
      existing.lastOrderDate = order.created_at as string;
    }
    customerMap.set(custId, existing);
  }
  const topCustomers: CustomerSummary[] = Array.from(customerMap.values())
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, 10);

  // Customer stats
  const uniqueOrderCustomers = new Set(activeOrders.map((o: any) => o.customer_id).filter(Boolean));
  const repeatCustomers = Array.from(customerMap.values()).filter(c => c.orderCount > 1);
  const customerStats: CustomerStats = {
    total: totalCustomerCount,
    withOrders: uniqueOrderCustomers.size,
    repeat: repeatCustomers.length,
    repeatRate:
      uniqueOrderCustomers.size > 0
        ? (repeatCustomers.length / uniqueOrderCustomers.size) * 100
        : 0,
  };

  // Payment methods
  const pmMap = new Map<string, { count: number; total: number }>();
  for (const p of capturedPayments) {
    const key = `${(p as any).gateway || 'Unknown'}|${(p as any).payment_method || 'Unknown'}`;
    const existing = pmMap.get(key) || { count: 0, total: 0 };
    existing.count += 1;
    existing.total += Number((p as any).net_amount || 0);
    pmMap.set(key, existing);
  }
  const paymentMethods: PaymentMethodBreakdown[] = Array.from(pmMap.entries())
    .map(([key, data]) => {
      const [gateway, method] = key.split('|');
      return { gateway, method, count: data.count, totalAmount: data.total };
    })
    .sort((a, b) => b.totalAmount - a.totalAmount);

  // Bank accounts
  const bankAccountsSummary: BankAccountSummary[] = derivedBankBalances.accounts.map(account => ({
    id: account.id,
    name: account.name,
    currency: account.currency || 'GBP',
    balance: account.balance,
    source: account.source || 'bank',
  }));

  // Recent orders
  const recentOrders: RecentOrder[] = recentOrdersData.map((o: any) => {
    const cust = o.customers;
    const name = cust ? [cust.first_name, cust.last_name].filter(Boolean).join(' ') : null;
    return {
      id: o.id,
      orderNumber: o.order_number,
      customerName: name,
      customerEmail: o.customer_email,
      status: o.status,
      grandTotal: Number(o.grand_total_amount || 0),
      currency: o.currency || 'GBP',
      createdAt: o.created_at,
      itemCount: 0,
    };
  });

  return {
    entity,
    kpis,
    revenueByMonth,
    ordersByStatus,
    topProducts,
    topCustomers,
    paymentMethods,
    bankAccounts: bankAccountsSummary,
    recentOrders,
    customerStats,
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Legacy exports for reports page compatibility ────────────────────

export interface DashboardMetrics {
  revenue: number;
  revenue_change: number;
  net_income: number;
  net_income_change: number;
  cash_balance: number;
  cash_change: number;
  gross_margin: number;
  gross_margin_change: number;
  cogs: number;
  operating_expenses: number;
  accounts_receivable: number;
  ar_change: number;
  accounts_payable: number;
  inventory: number;
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const supabase = getSupabase();
  const revenueDataPromise = getRevenueMetricsData(supabase);

  const [
    revenueData,
    derivedBankBalances,
    lineItemsRes,
    inventoryItemsRes,
    arRes,
    apRes,
    inventoryMovRes,
    txnsRes,
  ] = await Promise.all([
    revenueDataPromise,
    getDerivedBankBalances(supabase),
    supabase.from('order_line_items').select('order_id, product_id, quantity, cost_of_goods'),
    supabase.from('inventory_items').select('product_id, unit_cost'),
    // Accounts Receivable: outstanding SALE invoices
    supabase
      .from('invoices')
      .select('gross_amount')
      .eq('invoice_type', 'SALE')
      .in('status', ['OPEN', 'OVERDUE', 'PARTIALLY_PAID']),
    // Accounts Payable: outstanding PURCHASE invoices
    supabase
      .from('invoices')
      .select('gross_amount')
      .eq('invoice_type', 'PURCHASE')
      .in('status', ['OPEN', 'OVERDUE', 'PARTIALLY_PAID']),
    // Inventory value from movements
    supabase.from('inventory_movements').select('inventory_item_id, quantity, unit_cost'),
    // Operating expenses from financial_transactions (direction=out, type fee/other)
    supabase
      .from('financial_transactions')
      .select('base_amount, direction, transaction_type, status')
      .neq('status', 'excluded')
      .eq('direction', 'out'),
  ]);

  const orders = revenueData.orders;
  const revenueMetrics = revenueData.snapshot;
  const grossRevenue = revenueMetrics.grossRevenue;
  const cashBalance = derivedBankBalances.totalBalance;
  const processingFees = revenueMetrics.processingFees;
  const netRevenue = revenueMetrics.netRevenue;

  // COGS from order_line_items.cost_of_goods, fallback to inventory_items.unit_cost
  const orderIdSet = new Set(orders.map((o: any) => o.id));
  const invCostMap = new Map<string, number>();
  for (const ii of inventoryItemsRes.data || []) {
    const pid = (ii as any).product_id;
    const cost = Number((ii as any).unit_cost || 0);
    if (pid && cost > 0) invCostMap.set(pid, cost);
  }
  let cogs = 0;
  for (const li of lineItemsRes.data || []) {
    if (!orderIdSet.has((li as any).order_id)) continue;
    const cog = Number((li as any).cost_of_goods || 0);
    if (cog > 0) {
      cogs += cog;
    } else {
      const pid = (li as any).product_id;
      const qty = Number((li as any).quantity || 0);
      if (pid && invCostMap.has(pid)) cogs += qty * invCostMap.get(pid)!;
    }
  }

  const grossProfit = netRevenue - cogs;

  // Operating expenses from outbound financial transactions (fee + other) + processing fees
  let opex = processingFees;
  for (const txn of txnsRes.data || []) {
    const type = (txn as any).transaction_type;
    if (['fee', 'other'].includes(type)) {
      opex += Number((txn as any).base_amount || 0);
    }
  }

  const netIncome = grossProfit - opex;

  // AR & AP from invoices
  const accountsReceivable = (arRes.data || []).reduce(
    (s: number, i: any) => s + Number(i.gross_amount || 0),
    0
  );
  const accountsPayable = (apRes.data || []).reduce(
    (s: number, i: any) => s + Number(i.gross_amount || 0),
    0
  );

  // Inventory value from movements: SUM(quantity × unit_cost)
  const inventoryValue = (inventoryMovRes.data || []).reduce(
    (s: number, m: any) => s + Number(m.quantity || 0) * Number(m.unit_cost || 0),
    0
  );

  return {
    revenue: grossRevenue,
    revenue_change: 0,
    net_income: netIncome,
    net_income_change: 0,
    cash_balance: cashBalance,
    cash_change: 0,
    gross_margin: netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0,
    gross_margin_change: 0,
    cogs,
    operating_expenses: opex,
    accounts_receivable: accountsReceivable,
    ar_change: 0,
    accounts_payable: accountsPayable,
    inventory: inventoryValue,
  };
}

export async function getHealthIndicators(): Promise<HealthIndicator[]> {
  const supabase = getSupabase();
  const revenueDataPromise = getRevenueMetricsData(supabase);

  const [revenueData, derivedBankBalances, customersRes] = await Promise.all([
    revenueDataPromise,
    getDerivedBankBalances(supabase),
    supabase.from('customers').select('id', { count: 'exact', head: true }),
  ]);

  const orders = revenueData.orders;
  const totalRevenue = revenueData.snapshot.grossRevenue;
  const cashBalance = derivedBankBalances.totalBalance;
  const totalFees = revenueData.snapshot.processingFees;
  const refundRate =
    orders.length > 0
      ? (orders.filter((o: any) => o.status === 'refunded').length / orders.length) * 100
      : 0;
  const feeRate = totalRevenue > 0 ? (totalFees / totalRevenue) * 100 : 0;
  const avgOrderValue = orders.length > 0 ? totalRevenue / orders.length : 0;

  return [
    {
      name: 'Cash Balance',
      value: Math.round(cashBalance),
      target: 5000,
      unit: '£',
      status: cashBalance >= 5000 ? 'healthy' : cashBalance >= 2000 ? 'warning' : 'critical',
      description: 'Available cash across all accounts',
    },
    {
      name: 'Refund Rate',
      value: Math.round(refundRate * 10) / 10,
      target: 3,
      unit: '%',
      status: refundRate <= 3 ? 'healthy' : refundRate <= 5 ? 'warning' : 'critical',
      description: 'Percentage of orders refunded',
    },
    {
      name: 'Processing Fee Rate',
      value: Math.round(feeRate * 10) / 10,
      target: 3,
      unit: '%',
      status: feeRate <= 3 ? 'healthy' : feeRate <= 5 ? 'warning' : 'critical',
      description: 'Payment processing fees as % of revenue',
    },
    {
      name: 'Avg Order Value',
      value: Math.round(avgOrderValue),
      target: 70,
      unit: '£',
      status: avgOrderValue >= 70 ? 'healthy' : avgOrderValue >= 50 ? 'warning' : 'critical',
      description: 'Average revenue per order',
    },
    {
      name: 'Customer Base',
      value: customersRes.count || 0,
      target: 1000,
      unit: '',
      status:
        (customersRes.count || 0) >= 1000
          ? 'healthy'
          : (customersRes.count || 0) >= 500
            ? 'warning'
            : 'critical',
      description: 'Total registered customers',
    },
  ];
}

export async function getMonthlyFinancials(months: number = 12): Promise<MonthlyFinancials[]> {
  const supabase = getSupabase();

  const [ordersRes, lineItemsRes, inventoryRes, txnsRes] = await Promise.all([
    supabase
      .from('orders')
      .select(
        'id, grand_total_amount, refunded_total_amount, discount_total_amount, created_at, status'
      )
      .neq('status', 'cancelled'),
    supabase.from('order_line_items').select('order_id, product_id, quantity, cost_of_goods'),
    supabase.from('inventory_items').select('product_id, unit_cost'),
    supabase
      .from('financial_transactions')
      .select('base_amount, direction, transaction_type, status, occurred_at')
      .neq('status', 'excluded')
      .eq('direction', 'out'),
  ]);

  const orders = ordersRes.data || [];
  if (orders.length === 0) return generateEmptyMonthlyData(months);

  // Inventory cost lookup
  const invCostMap = new Map<string, number>();
  for (const ii of inventoryRes.data || []) {
    const pid = (ii as any).product_id;
    const cost = Number((ii as any).unit_cost || 0);
    if (pid && cost > 0) invCostMap.set(pid, cost);
  }

  // COGS per order
  const cogsPerOrder = new Map<string, number>();
  for (const li of lineItemsRes.data || []) {
    const orderId = (li as any).order_id as string;
    const cog = Number((li as any).cost_of_goods || 0);
    let lineCogs = 0;
    if (cog > 0) {
      lineCogs = cog;
    } else {
      const pid = (li as any).product_id;
      const qty = Number((li as any).quantity || 0);
      if (pid && invCostMap.has(pid)) lineCogs = qty * invCostMap.get(pid)!;
    }
    cogsPerOrder.set(orderId, (cogsPerOrder.get(orderId) || 0) + lineCogs);
  }

  // Group orders by month
  const monthMap = new Map<
    string,
    { revenue: number; refunds: number; discounts: number; cogs: number; orderIds: Set<string> }
  >();
  for (const order of orders) {
    if (!order.created_at) continue;
    const month = (order.created_at as string).substring(0, 7);
    const existing = monthMap.get(month) || {
      revenue: 0,
      refunds: 0,
      discounts: 0,
      cogs: 0,
      orderIds: new Set<string>(),
    };
    existing.revenue += Number(order.grand_total_amount || 0);
    existing.refunds += Number(order.refunded_total_amount || 0);
    existing.discounts += Number(order.discount_total_amount || 0);
    existing.orderIds.add((order as any).id);
    monthMap.set(month, existing);
  }

  // Sum COGS per month
  for (const [, data] of monthMap) {
    for (const oid of data.orderIds) {
      data.cogs += cogsPerOrder.get(oid) || 0;
    }
  }

  // Operating expenses per month from financial_transactions (direction=out, type fee/other)
  const monthOpexMap = new Map<string, number>();
  for (const txn of txnsRes.data || []) {
    const type = (txn as any).transaction_type;
    if (!['fee', 'other'].includes(type)) continue;
    const occurred = (txn as any).occurred_at as string | null;
    if (!occurred) continue;
    const month = occurred.substring(0, 7);
    monthOpexMap.set(month, (monthOpexMap.get(month) || 0) + Number((txn as any).base_amount || 0));
  }

  const sortedMonths = Array.from(monthMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-months);

  return sortedMonths.map(([month, data]) => {
    const grossProfit = data.revenue - data.refunds - data.discounts - data.cogs;
    const opex = monthOpexMap.get(month) || 0;
    return {
      month,
      revenue: data.revenue,
      cogs: data.cogs,
      gross_profit: grossProfit,
      operating_expenses: opex,
      net_income: grossProfit - opex,
    };
  });
}

function generateEmptyMonthlyData(months: number): MonthlyFinancials[] {
  const result: MonthlyFinancials[] = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push({
      month: date.toISOString().substring(0, 7),
      revenue: 0,
      cogs: 0,
      gross_profit: 0,
      operating_expenses: 0,
      net_income: 0,
    });
  }
  return result;
}

export interface BalanceSheetData {
  assets: { name: string; balance: number; code: number }[];
  liabilities: { name: string; balance: number; code: number }[];
  equity: { name: string; balance: number; code: number }[];
  total_assets: number;
  total_liabilities: number;
  total_equity: number;
}

export async function getBalanceSheet(): Promise<BalanceSheetData> {
  const supabase = getSupabase();

  const [accountsRes, journalsRes, lineItemsRes] = await Promise.all([
    supabase
      .from('chart_of_accounts')
      .select('id, name, account_type, account_number, normal_balance, is_header')
      .eq('status', 'active')
      .eq('is_header', false),
    supabase.from('journals').select('id').eq('status', 'posted'),
    supabase.from('journal_line_items').select('journal_id, account_id, debit, credit'),
  ]);

  const accounts = accountsRes.data || [];
  if (accounts.length === 0) {
    return {
      assets: [],
      liabilities: [],
      equity: [],
      total_assets: 0,
      total_liabilities: 0,
      total_equity: 0,
    };
  }

  // Only include line items from posted journals (cumulative, no date filter)
  const postedIds = new Set((journalsRes.data || []).map((j: any) => j.id));

  const balanceMap = new Map<string, { debit: number; credit: number }>();
  for (const line of lineItemsRes.data || []) {
    if (!postedIds.has((line as any).journal_id)) continue;
    const acctId = (line as any).account_id;
    const existing = balanceMap.get(acctId) || { debit: 0, credit: 0 };
    existing.debit += Number((line as any).debit || 0);
    existing.credit += Number((line as any).credit || 0);
    balanceMap.set(acctId, existing);
  }

  const assets: { name: string; balance: number; code: number }[] = [];
  const liabilities: { name: string; balance: number; code: number }[] = [];
  const equity: { name: string; balance: number; code: number }[] = [];

  // Track all-time P&L for retained earnings
  let allTimeRevenue = 0;
  let allTimeCogs = 0;
  let allTimeExpenses = 0;

  for (const acct of accounts) {
    const totals = balanceMap.get(acct.id) || { debit: 0, credit: 0 };
    const type = acct.account_type as string;
    const code = Number(acct.account_number || 0);
    const normalBalance = ((acct as any).normal_balance as string)?.trim();

    // Use normal_balance for sign:
    // debit-normal (asset): debit - credit
    // credit-normal (liability, equity): credit - debit
    const balance =
      normalBalance === 'debit' ? totals.debit - totals.credit : totals.credit - totals.debit;

    // Accumulate P&L for retained earnings
    if (type === 'revenue') allTimeRevenue += totals.credit - totals.debit;
    if (type === 'cogs') allTimeCogs += totals.debit - totals.credit;
    if (type === 'expense') allTimeExpenses += totals.debit - totals.credit;

    if (balance === 0) continue;
    const entry = { name: acct.name, balance, code };

    switch (type) {
      case 'asset':
        assets.push(entry);
        break;
      case 'liability':
        liabilities.push(entry);
        break;
      case 'equity':
        equity.push(entry);
        break;
    }
  }

  // Add retained earnings as synthetic equity line
  const retainedEarnings = allTimeRevenue - allTimeCogs - allTimeExpenses;
  if (retainedEarnings !== 0) {
    equity.push({ name: 'Retained Earnings', balance: retainedEarnings, code: 9999 });
  }

  assets.sort((a, b) => a.code - b.code);
  liabilities.sort((a, b) => a.code - b.code);
  equity.sort((a, b) => a.code - b.code);

  return {
    assets,
    liabilities,
    equity,
    total_assets: assets.reduce((s, a) => s + a.balance, 0),
    total_liabilities: liabilities.reduce((s, a) => s + a.balance, 0),
    total_equity: equity.reduce((s, a) => s + a.balance, 0),
  };
}

export interface CashFlowData {
  operating: number;
  investing: number;
  financing: number;
  net_change: number;
  beginning_balance: number;
  ending_balance: number;
}

export async function getCashFlow(): Promise<CashFlowData> {
  const supabase = getSupabase();

  const [txnsRes, derivedBankBalances] = await Promise.all([
    supabase
      .from('financial_transactions')
      .select('amount, base_amount, direction, transaction_type, status')
      .neq('status', 'excluded'),
    getDerivedBankBalances(supabase),
  ]);

  let operating = 0;
  let investing = 0;
  let financing = 0;

  for (const txn of txnsRes.data || []) {
    const amount = Number((txn as any).base_amount || 0);
    const dir = ((txn as any).direction || 'out') as string;
    const signed = dir === 'in' ? amount : -amount;
    const type = ((txn as any).transaction_type || 'other') as string;

    // Operating: payment, refund, fee, interest, reserve_hold, reserve_release, other
    // Financing: transfer, fx_conversion, funding
    if (['transfer', 'fx_conversion', 'funding'].includes(type)) {
      financing += signed;
    } else {
      operating += signed;
    }
  }

  const endingBalance = derivedBankBalances.totalBalance;

  return {
    operating,
    investing,
    financing,
    net_change: operating + investing + financing,
    beginning_balance: 0,
    ending_balance: endingBalance,
  };
}

export async function getOrderAnalytics(): Promise<{
  total_orders: number;
  total_revenue: number;
  avg_order_value: number;
  top_customers: { name: string; total: number }[];
  top_products: { name: string; qty: number; revenue: number }[];
}> {
  const supabase = getSupabase();

  const [ordersRes, itemsRes] = await Promise.all([
    supabase
      .from('orders')
      .select('id, grand_total_amount, customer_id, customers(first_name, last_name)')
      .neq('status', 'cancelled'),
    supabase.from('order_line_items').select('product_name, quantity, total_price_amount'),
  ]);

  const orders = ordersRes.data || [];
  const items = itemsRes.data || [];

  const total_orders = orders.length;
  const total_revenue = orders.reduce(
    (s: number, o: any) => s + Number(o.grand_total_amount || 0),
    0
  );
  const avg_order_value = total_orders > 0 ? total_revenue / total_orders : 0;

  // Top customers
  const custMap = new Map<string, { name: string; total: number }>();
  for (const o of orders) {
    const cust = (o as any).customers;
    const name = cust ? [cust.first_name, cust.last_name].filter(Boolean).join(' ') : 'Unknown';
    const existing = custMap.get(name) || { name, total: 0 };
    existing.total += Number((o as any).grand_total_amount || 0);
    custMap.set(name, existing);
  }
  const top_customers = Array.from(custMap.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Top products
  const prodMap = new Map<string, { name: string; qty: number; revenue: number }>();
  for (const item of items) {
    const name = (item as any).product_name || 'Unknown';
    const existing = prodMap.get(name) || { name, qty: 0, revenue: 0 };
    existing.qty += Number((item as any).quantity || 0);
    existing.revenue += Number((item as any).total_price_amount || 0);
    prodMap.set(name, existing);
  }
  const top_products = Array.from(prodMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return { total_orders, total_revenue, avg_order_value, top_customers, top_products };
}
