/**
 * Dashboard Data Types
 *
 * Shared types for dashboard data between server and client
 */

import type { MetricCardProps } from '~/components/visualizations/MetricCardViz';
import type { LineChartProps } from '~/components/visualizations/LineChartViz';
import type { BarChartProps } from '~/components/visualizations/BarChartViz';
import type { FinancialTableProps } from '~/components/visualizations/FinancialTableViz';
import type { Invoice, InvoiceStats } from '~/types/invoice';

export interface DashboardLoaderData {
  entity: {
    id: string;
    name: string;
  } | null;
  kpis: {
    revenue: MetricCardProps;
    netIncome: MetricCardProps;
    cashBalance: MetricCardProps;
    grossMargin: MetricCardProps;
    cogs: MetricCardProps;
    accountsReceivable: MetricCardProps;
  };
  healthIndicators: HealthIndicator[];
  // Financial reports - optional (used in reports page)
  incomeStatement?: {
    chart: LineChartProps;
    table: FinancialTableProps;
  };
  balanceSheet?: {
    chart: BarChartProps;
    table: FinancialTableProps;
  };
  cashFlow?: {
    chart: LineChartProps;
    table: FinancialTableProps;
  };
  revenueByCategory: BarChartProps;
  orderAnalytics?: {
    total_orders: number;
    total_revenue: number;
    avg_order_value: number;
    top_customers: { name: string; total: number }[];
    top_products: { name: string; qty: number; revenue: number }[];
  };
  // Invoice data - optional (used in invoices page)
  invoices?: Invoice[];
  invoiceStats?: InvoiceStats;
  lastUpdated: string;
}

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
