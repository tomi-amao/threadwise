/**
 * Dashboard API Service
 *
 * Server-side data fetching for the dashboard.
 * Queries actual database tables: orders, order_line_items, customers,
 * products, payments, payment_fees, bank_accounts, financial_transactions,
 * chart_of_accounts, journals, journal_line_items.
 */

import { getServerSupabaseClient } from '~/lib/supabase';
import { getRequestSupabaseClient } from '~/lib/supabase-server';
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
} from '~/types/dashboard';

const getSupabase = getServerSupabaseClient;

// Row shapes for the four queries below. The Supabase client is untyped here (no generated
// database types), so these document what each select returns and keep the aggregation typed.
interface OrderRow {
  id: string;
  grand_total_amount: number | null;
  status: string | null;
  created_at: string | null;
  customer_id: string | null;
  customer_email: string | null;
  customers: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;
}
interface LineItemRow {
  product_id: string | null;
  product_name: string | null;
  quantity: number | null;
  total_price_amount: number | null;
  order_id: string;
}
interface PaymentRow {
  gateway: string | null;
  payment_method: string | null;
  net_amount: number | null;
  status: string;
}
interface RecentOrderRow {
  id: string;
  order_number: string;
  status: string;
  grand_total_amount: number | null;
  currency: string | null;
  created_at: string;
  customer_email: string | null;
  customers: { first_name: string | null; last_name: string | null } | null;
}

// ─── Entity Info ──────────────────────────────────────────────────────

export async function getEntityInfo(request: Request): Promise<EntityInfo | null> {
  try {
    const supabase = getRequestSupabaseClient(request);
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

  if (ordersRaw.error) throw new Error(`Failed to load orders: ${ordersRaw.error.message}`);
  if (lineItemsRaw.error)
    throw new Error(`Failed to load order line items: ${lineItemsRaw.error.message}`);
  if (paymentsRaw.error) throw new Error(`Failed to load payments: ${paymentsRaw.error.message}`);
  if (recentOrdersRaw.error)
    throw new Error(`Failed to load recent orders: ${recentOrdersRaw.error.message}`);
  if (customerCountRaw.error)
    throw new Error(`Failed to load customer count: ${customerCountRaw.error.message}`);

  const orders = (ordersRaw.data || []) as unknown as OrderRow[];
  const lineItems = (lineItemsRaw.data || []) as LineItemRow[];
  const payments = (paymentsRaw.data || []) as PaymentRow[];
  const recentOrdersData = (recentOrdersRaw.data || []) as unknown as RecentOrderRow[];
  const totalCustomerCount = customerCountRaw.count || 0;
  const revenueMetrics = revenueData.snapshot;

  // Compute KPIs
  const activeOrders = orders.filter(o => o.status !== 'cancelled');
  const capturedPayments = payments.filter(p => p.status === 'captured');
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
    const month = order.created_at.substring(0, 7);
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
    const s = order.status || 'unknown';
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
    const key = item.product_name || 'Unknown';
    const existing = productMap.get(key) || {
      id: item.product_id,
      name: key,
      qty: 0,
      revenue: 0,
      orders: new Set<string>(),
    };
    existing.qty += Number(item.quantity || 0);
    existing.revenue += Number(item.total_price_amount || 0);
    existing.orders.add(item.order_id);
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
    const cust = order.customers;
    const custId = order.customer_id;
    if (!custId) continue;

    const existing = customerMap.get(custId) || {
      id: custId,
      name: cust
        ? [cust.first_name, cust.last_name].filter(Boolean).join(' ')
        : order.customer_email || 'Unknown',
      email: cust?.email || order.customer_email || null,
      orderCount: 0,
      totalSpent: 0,
      lastOrderDate: null,
    };
    existing.orderCount += 1;
    existing.totalSpent += Number(order.grand_total_amount || 0);
    if (
      !existing.lastOrderDate ||
      (order.created_at && order.created_at > existing.lastOrderDate)
    ) {
      existing.lastOrderDate = order.created_at;
    }
    customerMap.set(custId, existing);
  }
  const topCustomers: CustomerSummary[] = Array.from(customerMap.values())
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, 10);

  // Customer stats
  const uniqueOrderCustomers = new Set(activeOrders.map(o => o.customer_id).filter(Boolean));
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
    const key = `${p.gateway || 'Unknown'}|${p.payment_method || 'Unknown'}`;
    const existing = pmMap.get(key) || { count: 0, total: 0 };
    existing.count += 1;
    existing.total += Number(p.net_amount || 0);
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
  const recentOrders: RecentOrder[] = recentOrdersData.map(o => {
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
