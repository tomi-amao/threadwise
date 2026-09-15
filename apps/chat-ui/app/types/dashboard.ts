/**
 * Dashboard Data Types
 *
 * Types for the business intelligence dashboard, aligned with the actual database schema.
 */

// ─── Entity ───────────────────────────────────────────────────────────

export interface EntityInfo {
  id: string;
  name: string;
  currency: string | null;
  industry: string | null;
}

// ─── KPI Metrics ──────────────────────────────────────────────────────

export interface KPIData {
  grossRevenue: number;
  netRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  totalCustomers: number;
  totalBankBalance: number;
  totalRefunds: number;
  processingFees: number;
}

// ─── Revenue Analytics ────────────────────────────────────────────────

export interface MonthlyRevenue {
  month: string;
  revenue: number;
  orderCount: number;
  avgOrderValue: number;
}

// ─── Product Performance ──────────────────────────────────────────────

export interface ProductPerformance {
  id: string | null;
  name: string;
  totalQuantity: number;
  totalRevenue: number;
  orderCount: number;
}

// ─── Customer Analytics ───────────────────────────────────────────────

export interface CustomerSummary {
  id: string;
  name: string;
  email: string | null;
  orderCount: number;
  totalSpent: number;
  lastOrderDate: string | null;
}

export interface CustomerStats {
  total: number;
  withOrders: number;
  repeat: number;
  repeatRate: number;
}

// ─── Payment Analytics ────────────────────────────────────────────────

export interface PaymentMethodBreakdown {
  gateway: string;
  method: string;
  count: number;
  totalAmount: number;
}

// ─── Order Analytics ──────────────────────────────────────────────────

export interface OrderStatusBreakdown {
  status: string;
  count: number;
}

export interface RecentOrder {
  id: string;
  orderNumber: string;
  customerName: string | null;
  customerEmail: string | null;
  status: string;
  grandTotal: number;
  currency: string;
  createdAt: string;
  itemCount: number;
}

// ─── Bank Accounts ────────────────────────────────────────────────────

export interface BankAccountSummary {
  id: string;
  name: string | null;
  currency: string;
  balance: number;
  source: string;
}

// ─── Aggregate Dashboard Data ─────────────────────────────────────────

export interface DashboardData {
  entity: EntityInfo | null;
  kpis: KPIData;
  revenueByMonth: MonthlyRevenue[];
  ordersByStatus: OrderStatusBreakdown[];
  topProducts: ProductPerformance[];
  topCustomers: CustomerSummary[];
  paymentMethods: PaymentMethodBreakdown[];
  bankAccounts: BankAccountSummary[];
  recentOrders: RecentOrder[];
  customerStats: CustomerStats;
  lastUpdated: string;
}

// ─── Legacy types for reports page compatibility ──────────────────────

export interface HealthIndicator {
  name: string;
  status: 'healthy' | 'warning' | 'critical';
  value: number;
  target: number;
  unit: string;
  description: string;
}

export interface AccountBalance {
  code: number;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
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
