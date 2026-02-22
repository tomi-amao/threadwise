/**
 * Dashboard API Service
 *
 * Server-side data fetching for dashboard metrics.
 * Uses Supabase to query financial data from the double-entry accounting system.
 */

import { getServerSupabaseClient } from '~/lib/supabase';

// Types for database schema
export interface Account {
  id: string;
  entity_id: string;
  code: number;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
}

export interface AccountBalance extends Account {
  total_debit: number;
  total_credit: number;
  balance: number;
}

export interface MonthlyFinancials {
  month: string;
  revenue: number;
  cogs: number;
  gross_profit: number;
  operating_expenses: number;
  net_income: number;
}

export interface BalanceSheetData {
  assets: { name: string; balance: number; code: number }[];
  liabilities: { name: string; balance: number; code: number }[];
  equity: { name: string; balance: number; code: number }[];
  total_assets: number;
  total_liabilities: number;
  total_equity: number;
}

export interface CashFlowData {
  operating: number;
  investing: number;
  financing: number;
  net_change: number;
  beginning_balance: number;
  ending_balance: number;
}

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

export interface HealthMetric {
  name: string;
  value: number;
  target: number;
  unit: string;
  status: 'healthy' | 'warning' | 'critical';
  description: string;
}

// Use shared Supabase client
const getSupabaseClient = getServerSupabaseClient;

/**
 * Get account balances from journal entry lines
 * Following double-entry accounting rules:
 * - Assets & Expenses: Debit increases, Credit decreases (balance = debit - credit)
 * - Liabilities, Equity & Revenue: Credit increases, Debit decreases (balance = credit - debit)
 */
export async function getAccountBalances(): Promise<AccountBalance[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc('get_account_balances');

  if (error) {
    // console.error('Error fetching account balances:', error);
    // Fallback: calculate manually
    return calculateAccountBalancesManually();
  }

  return data || [];
}

async function calculateAccountBalancesManually(): Promise<AccountBalance[]> {
  const supabase = getSupabaseClient();

  // Get all accounts
  const { data: accountsData } = await supabase.from('accounts').select('*').order('code');

  const accounts = accountsData as Account[] | null;
  if (!accounts) return [];

  // Get all journal entry lines
  const { data: linesData } = await supabase
    .from('journal_entry_lines')
    .select('account_id, debit, credit');

  interface JournalLine {
    account_id: string;
    debit: number | string | null;
    credit: number | string | null;
  }

  const lines = linesData as JournalLine[] | null;

  if (!lines) {
    return accounts.map((a: Account) => ({
      ...a,
      total_debit: 0,
      total_credit: 0,
      balance: 0,
    }));
  }

  // Calculate balances
  const balanceMap = new Map<string, { debit: number; credit: number }>();

  for (const line of lines) {
    const current = balanceMap.get(line.account_id) || { debit: 0, credit: 0 };
    current.debit += Number(line.debit) || 0;
    current.credit += Number(line.credit) || 0;
    balanceMap.set(line.account_id, current);
  }

  return accounts.map((account: Account) => {
    const totals = balanceMap.get(account.id) || { debit: 0, credit: 0 };
    const balance = ['asset', 'expense'].includes(account.type)
      ? totals.debit - totals.credit
      : totals.credit - totals.debit;

    return {
      ...account,
      total_debit: totals.debit,
      total_credit: totals.credit,
      balance,
    };
  });
}

/**
 * Get monthly financial summary for income statement trends
 */
export async function getMonthlyFinancials(months: number = 12): Promise<MonthlyFinancials[]> {
  const supabase = getSupabaseClient();

  // Get journal entries with their lines and account types
  const { data: entries } = await supabase
    .from('journal_entries')
    .select(
      `
      entry_date,
      journal_entry_lines (
        debit,
        credit,
        accounts (
          code,
          name,
          type
        )
      )
    `
    )
    .order('entry_date', { ascending: true });

  if (!entries || entries.length === 0) {
    return generateEmptyMonthlyData(months);
  }

  // Aggregate by month
  const monthlyData = new Map<string, MonthlyFinancials>();

  for (const entry of entries) {
    const month = entry.entry_date.substring(0, 7); // YYYY-MM

    if (!monthlyData.has(month)) {
      monthlyData.set(month, {
        month,
        revenue: 0,
        cogs: 0,
        gross_profit: 0,
        operating_expenses: 0,
        net_income: 0,
      });
    }

    const data = monthlyData.get(month)!;

    for (const line of entry.journal_entry_lines || []) {
      const account = (line as any).accounts;
      if (!account) continue;

      const amount = Number(line.credit) - Number(line.debit);

      if (account.type === 'revenue') {
        data.revenue += amount;
      } else if (account.type === 'expense') {
        // COGS: accounts 5000-5499 (sub_type='cogs')
        if (account.code >= 5000 && account.code < 5500) {
          data.cogs += Math.abs(amount);
        } else {
          data.operating_expenses += Math.abs(amount);
        }
      }
    }
  }

  // Calculate derived values
  const results = Array.from(monthlyData.values()).map(m => ({
    ...m,
    gross_profit: m.revenue - m.cogs,
    net_income: m.revenue - m.cogs - m.operating_expenses,
  }));

  return results.length > 0 ? results : generateEmptyMonthlyData(months);
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

/**
 * Get balance sheet data
 */
export async function getBalanceSheet(): Promise<BalanceSheetData> {
  const balances = await getAccountBalances();

  const assets = balances
    .filter(a => a.type === 'asset')
    .map(a => ({ name: a.name, balance: a.balance, code: a.code }))
    .sort((a, b) => a.code - b.code);

  const liabilities = balances
    .filter(a => a.type === 'liability')
    .map(a => ({ name: a.name, balance: a.balance, code: a.code }))
    .sort((a, b) => a.code - b.code);

  const equity = balances
    .filter(a => a.type === 'equity')
    .map(a => ({ name: a.name, balance: a.balance, code: a.code }))
    .sort((a, b) => a.code - b.code);

  // Calculate retained earnings (Revenue - Expenses)
  const revenueTotal = balances
    .filter(a => a.type === 'revenue')
    .reduce((sum, a) => sum + a.balance, 0);

  const expenseTotal = balances
    .filter(a => a.type === 'expense')
    .reduce((sum, a) => sum + a.balance, 0);

  const retainedEarnings = revenueTotal - expenseTotal;

  // Add retained earnings to equity if not already there
  if (!equity.find(e => e.name.toLowerCase().includes('retained'))) {
    equity.push({ name: 'Retained Earnings', balance: retainedEarnings, code: 3900 });
  }

  const total_assets = assets.reduce((sum, a) => sum + a.balance, 0);
  const total_liabilities = liabilities.reduce((sum, a) => sum + a.balance, 0);
  const total_equity = equity.reduce((sum, a) => sum + a.balance, 0);

  return {
    assets,
    liabilities,
    equity,
    total_assets,
    total_liabilities,
    total_equity,
  };
}

/**
 * Get cash flow summary
 */
export async function getCashFlow(): Promise<CashFlowData> {
  const supabase = getSupabaseClient();

  // Get cash account (typically code 1000)
  const { data: cashAccount } = await supabase
    .from('accounts')
    .select('id')
    .eq('code', 1000)
    .single();

  if (!cashAccount) {
    return {
      operating: 0,
      investing: 0,
      financing: 0,
      net_change: 0,
      beginning_balance: 0,
      ending_balance: 0,
    };
  }

  // Get all cash movements
  const { data: cashLines } = await supabase
    .from('journal_entry_lines')
    .select(
      `
      debit,
      credit,
      journal_entries (
        entry_date,
        reference_type
      )
    `
    )
    .eq('account_id', cashAccount.id);

  let operating = 0;
  let investing = 0;
  let financing = 0;

  for (const line of cashLines || []) {
    const netCash = Number(line.debit) - Number(line.credit);
    const refType = (line as any).journal_entries?.reference_type || '';

    // Classify based on reference type
    if (refType.includes('sales') || refType.includes('supplier') || refType.includes('payment')) {
      operating += netCash;
    } else if (refType.includes('investment') || refType.includes('asset')) {
      investing += netCash;
    } else if (
      refType.includes('loan') ||
      refType.includes('dividend') ||
      refType.includes('equity')
    ) {
      financing += netCash;
    } else {
      operating += netCash; // Default to operating
    }
  }

  const ending_balance = operating + investing + financing;

  return {
    operating,
    investing,
    financing,
    net_change: ending_balance,
    beginning_balance: 0, // Would need historical data
    ending_balance,
  };
}

/**
 * Get key dashboard metrics
 */
export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const balances = await getAccountBalances();
  const monthlyData = await getMonthlyFinancials(3);

  // Current period (latest month)
  const current = monthlyData[monthlyData.length - 1] || { revenue: 0, cogs: 0, net_income: 0 };
  const previous = monthlyData[monthlyData.length - 2] || { revenue: 0, cogs: 0, net_income: 0 };

  // Calculate changes
  const calcChange = (curr: number, prev: number) =>
    prev === 0 ? 0 : ((curr - prev) / prev) * 100;

  // Get specific account balances
  const getBalance = (code: number) => balances.find(b => b.code === code)?.balance || 0;

  const cash = getBalance(1000);
  const ar = getBalance(1100);
  const inventory = getBalance(1200);
  const ap = getBalance(2000);

  // Total revenue and COGS from all time
  const totalRevenue = balances
    .filter(b => b.type === 'revenue')
    .reduce((sum, b) => sum + b.balance, 0);

  // COGS: accounts 5000-5499 (sub_type='cogs')
  const totalCogs = balances
    .filter(b => b.type === 'expense' && b.code >= 5000 && b.code < 5500)
    .reduce((sum, b) => sum + b.balance, 0);

  // Operating Expenses: accounts 6000+ (sub_type='opex')
  const totalOpEx = balances
    .filter(b => b.type === 'expense' && b.code >= 6000)
    .reduce((sum, b) => sum + b.balance, 0);

  const grossMargin = totalRevenue > 0 ? ((totalRevenue - totalCogs) / totalRevenue) * 100 : 0;

  return {
    revenue: totalRevenue,
    revenue_change: calcChange(current.revenue, previous.revenue),
    net_income:
      totalRevenue -
      balances.filter(b => b.type === 'expense').reduce((sum, b) => sum + b.balance, 0),
    net_income_change: calcChange(current.net_income, previous.net_income),
    cash_balance: cash,
    cash_change: 0, // Would need historical data
    gross_margin: grossMargin,
    gross_margin_change: 0,
    cogs: totalCogs,
    operating_expenses: totalOpEx,
    accounts_receivable: ar,
    ar_change: 0,
    accounts_payable: ap,
    inventory,
  };
}

/**
 * Calculate business health indicators
 */
export async function getHealthIndicators(): Promise<HealthMetric[]> {
  const balances = await getAccountBalances();

  const getBalance = (code: number) => balances.find(b => b.code === code)?.balance || 0;

  const cash = getBalance(1000);
  const ar = getBalance(1100);
  const inventory = getBalance(1200);
  const ap = getBalance(2000);

  // Calculate current assets and liabilities
  const currentAssets = balances
    .filter(b => b.type === 'asset' && b.code < 2000)
    .reduce((sum, b) => sum + b.balance, 0);

  const currentLiabilities = balances
    .filter(b => b.type === 'liability' && b.code < 3000)
    .reduce((sum, b) => sum + b.balance, 0);

  // Calculate ratios
  const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0;
  const quickRatio = currentLiabilities > 0 ? (currentAssets - inventory) / currentLiabilities : 0;

  // Get revenue for DSO calculation
  const totalRevenue = balances
    .filter(b => b.type === 'revenue')
    .reduce((sum, b) => sum + b.balance, 0);

  const dso = totalRevenue > 0 ? ar / (totalRevenue / 365) : 0;

  // Inventory turnover (simplified)
  const cogs = balances
    .filter(b => b.type === 'expense' && b.code >= 5000 && b.code < 5500)
    .reduce((sum, b) => sum + b.balance, 0);

  const inventoryTurnover = inventory > 0 ? cogs / inventory : 0;

  const determineStatus = (
    value: number,
    target: number,
    lowerIsBetter: boolean
  ): 'healthy' | 'warning' | 'critical' => {
    if (lowerIsBetter) {
      if (value <= target) return 'healthy';
      if (value <= target * 1.5) return 'warning';
      return 'critical';
    } else {
      if (value >= target) return 'healthy';
      if (value >= target * 0.7) return 'warning';
      return 'critical';
    }
  };

  return [
    {
      name: 'Current Ratio',
      value: Math.round(currentRatio * 100) / 100,
      target: 2.0,
      unit: 'x',
      status: determineStatus(currentRatio, 2.0, false),
      description: 'Ability to pay short-term obligations',
    },
    {
      name: 'Quick Ratio',
      value: Math.round(quickRatio * 100) / 100,
      target: 1.5,
      unit: 'x',
      status: determineStatus(quickRatio, 1.5, false),
      description: 'Liquid assets vs current liabilities',
    },
    {
      name: 'Days Sales Outstanding',
      value: Math.round(dso),
      target: 45,
      unit: 'days',
      status: determineStatus(dso, 45, true),
      description: 'Average collection period',
    },
    {
      name: 'Inventory Turnover',
      value: Math.round(inventoryTurnover * 10) / 10,
      target: 6.0,
      unit: 'x',
      status: determineStatus(inventoryTurnover, 6.0, false),
      description: 'Times inventory sold per year',
    },
    {
      name: 'Cash Position',
      value: cash,
      target: currentLiabilities,
      unit: '$',
      status:
        cash >= currentLiabilities
          ? 'healthy'
          : cash >= currentLiabilities * 0.5
            ? 'warning'
            : 'critical',
      description: 'Cash available vs short-term debts',
    },
    {
      name: 'Accounts Payable',
      value: ap,
      target: 0,
      unit: '$',
      status: ap === 0 ? 'healthy' : ap < currentAssets * 0.5 ? 'warning' : 'critical',
      description: 'Outstanding supplier payments',
    },
  ];
}

/**
 * Get entity information
 */
export async function getEntityInfo(): Promise<{ id: string; name: string } | null> {
  const supabase = getSupabaseClient();

  const { data } = await supabase.from('entities').select('id, name').limit(1).single();

  return data;
}

/**
 * Get order analytics
 */
export async function getOrderAnalytics(): Promise<{
  total_orders: number;
  total_revenue: number;
  avg_order_value: number;
  top_customers: { name: string; total: number }[];
  top_products: { name: string; qty: number; revenue: number }[];
}> {
  const supabase = getSupabaseClient();

  // Get order summary
  const { data: orders } = await supabase
    .from('orders')
    .select('id, total_amount, customer_id, customers(name)');

  // Get order items with products
  const { data: orderItems } = await supabase
    .from('order_items')
    .select('qty, sale_price, products(name)');

  const total_orders = orders?.length || 0;
  const total_revenue = orders?.reduce((sum, o) => sum + Number(o.total_amount || 0), 0) || 0;
  const avg_order_value = total_orders > 0 ? total_revenue / total_orders : 0;

  // Aggregate by customer
  const customerMap = new Map<string, number>();
  for (const order of orders || []) {
    const name = (order as any).customers?.name || 'Unknown';
    customerMap.set(name, (customerMap.get(name) || 0) + Number(order.total_amount || 0));
  }
  const top_customers = Array.from(customerMap.entries())
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Aggregate by product
  const productMap = new Map<string, { qty: number; revenue: number }>();
  for (const item of orderItems || []) {
    const name = (item as any).products?.name || 'Unknown';
    const current = productMap.get(name) || { qty: 0, revenue: 0 };
    current.qty += item.qty;
    current.revenue += item.qty * Number(item.sale_price);
    productMap.set(name, current);
  }
  const top_products = Array.from(productMap.entries())
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return {
    total_orders,
    total_revenue,
    avg_order_value,
    top_customers,
    top_products,
  };
}
