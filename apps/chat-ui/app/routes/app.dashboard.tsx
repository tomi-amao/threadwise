/**
 * Dashboard Route (Protected)
 *
 * Main dashboard view with KPIs, health indicators, and insights.
 */

import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData } from 'react-router';
import { DashboardView } from '~/components/dashboard/DashboardView';
import {
  getDashboardMetrics,
  getHealthIndicators,
  getOrderAnalytics,
  getEntityInfo,
} from '~/lib/api/dashboard.server';
import type { DashboardLoaderData } from '~/types/dashboard';

export const meta: MetaFunction = () => {
  return [
    { title: 'Dashboard - ThreadWise' },
    { name: 'description', content: 'Your business intelligence dashboard' },
  ];
};

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<{ dashboard: DashboardLoaderData }> {
  // Fetch dashboard data in parallel (only what's needed for KPIs, Health, Insights)
  const [entity, metrics, healthIndicators, orderAnalytics] = await Promise.all([
    getEntityInfo(request),
    getDashboardMetrics(),
    getHealthIndicators(),
    getOrderAnalytics(),
  ]);

  // Transform metrics into KPI cards
  const kpis = {
    revenue: {
      title: 'Total Revenue',
      value: metrics.revenue,
      format: 'currency' as const,
      trend:
        metrics.revenue_change !== 0
          ? {
              direction: metrics.revenue_change > 0 ? ('up' as const) : ('down' as const),
              value: Math.abs(metrics.revenue_change),
              period: 'vs last period',
            }
          : undefined,
      description: 'Total revenue from all sales',
    },
    netIncome: {
      title: 'Net Income',
      value: metrics.net_income,
      format: 'currency' as const,
      description: 'Profit after all expenses',
    },
    cashBalance: {
      title: 'Cash Balance',
      value: metrics.cash_balance,
      format: 'currency' as const,
      description: 'Current cash on hand',
    },
    grossMargin: {
      title: 'Gross Margin',
      value: metrics.gross_margin,
      format: 'percentage' as const,
      description: 'Revenue minus cost of goods sold',
    },
    cogs: {
      title: 'Cost of Goods Sold',
      value: metrics.cogs,
      format: 'currency' as const,
      description: 'Direct costs of products sold',
    },
    accountsReceivable: {
      title: 'Accounts Receivable',
      value: metrics.accounts_receivable,
      format: 'currency' as const,
      description: 'Outstanding customer payments',
    },
  };

  // Revenue by category for insights
  const revenueByCategory = {
    title: 'Revenue by Product',
    xAxisLabel: 'Product',
    yAxisLabel: 'Revenue ($)',
    format: 'currency' as const,
    data:
      orderAnalytics.top_products.length > 0
        ? orderAnalytics.top_products.map((p, i) => ({
            id: String(i + 1),
            label: p.name,
            value: p.revenue,
          }))
        : [{ id: '1', label: 'No data', value: 0 }],
  };

  return {
    dashboard: {
      entity,
      kpis,
      healthIndicators,
      revenueByCategory,
      orderAnalytics,
      lastUpdated: new Date().toISOString(),
    } as DashboardLoaderData,
  };
}

export default function DashboardPage() {
  const { dashboard } = useLoaderData<typeof loader>();

  return <DashboardView data={dashboard} />;
}
