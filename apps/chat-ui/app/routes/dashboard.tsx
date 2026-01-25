import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData } from 'react-router';
import { DashboardView } from '~/components/dashboard/DashboardView';
import {
  getDashboardMetrics,
  getHealthIndicators,
  getMonthlyFinancials,
  getBalanceSheet,
  getCashFlow,
  getOrderAnalytics,
  getEntityInfo,
} from '~/lib/api/dashboard.server';
import { listInvoices, getInvoiceStats } from '~/lib/api/invoices.server';
import type { DashboardLoaderData } from '~/types/dashboard';

export const meta: MetaFunction = () => {
  return [
    { title: 'ThreadWise Dashboard - Business Intelligence' },
    {
      name: 'description',
      content: 'Monitor your business health with key metrics and financial reports',
    },
  ];
};

export async function loader({ request }: LoaderFunctionArgs): Promise<DashboardLoaderData> {
  // Fetch all dashboard data in parallel
  const [
    entity,
    metrics,
    healthIndicators,
    monthlyData,
    balanceSheetData,
    cashFlowData,
    orderAnalytics,
    invoicesResult,
    invoiceStats,
  ] = await Promise.all([
    getEntityInfo(),
    getDashboardMetrics(),
    getHealthIndicators(),
    getMonthlyFinancials(12),
    getBalanceSheet(),
    getCashFlow(),
    getOrderAnalytics(),
    listInvoices(),
    getInvoiceStats(),
  ]);

  // Transform metrics to KPI card format
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
      trend:
        metrics.net_income_change !== 0
          ? {
              direction: metrics.net_income_change > 0 ? ('up' as const) : ('down' as const),
              value: Math.abs(metrics.net_income_change),
              period: 'vs last period',
            }
          : undefined,
      description: 'Profit after all expenses',
    },
    cashBalance: {
      title: 'Cash Balance',
      value: metrics.cash_balance,
      format: 'currency' as const,
      trend:
        metrics.cash_change !== 0
          ? {
              direction: metrics.cash_change > 0 ? ('up' as const) : ('down' as const),
              value: Math.abs(metrics.cash_change),
              period: 'vs last period',
            }
          : undefined,
      description: 'Current cash on hand',
    },
    grossMargin: {
      title: 'Gross Margin',
      value: metrics.gross_margin,
      format: 'percentage' as const,
      trend:
        metrics.gross_margin_change !== 0
          ? {
              direction: metrics.gross_margin_change > 0 ? ('up' as const) : ('down' as const),
              value: Math.abs(metrics.gross_margin_change),
              period: 'vs last period',
            }
          : undefined,
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
      trend:
        metrics.ar_change !== 0
          ? {
              direction: metrics.ar_change > 0 ? ('up' as const) : ('down' as const),
              value: Math.abs(metrics.ar_change),
              period: 'vs last period',
            }
          : undefined,
      description: 'Outstanding customer payments',
    },
  };

  // Transform monthly data to income statement chart
  const incomeChart = {
    title: 'Income Statement Trend',
    xAxisLabel: 'Month',
    yAxisLabel: 'Amount ($)',
    format: 'currency' as const,
    data: [
      {
        id: 'Revenue',
        data: monthlyData.map(m => ({
          x: formatMonth(m.month),
          y: m.revenue,
        })),
      },
      {
        id: 'Net Income',
        data: monthlyData.map(m => ({
          x: formatMonth(m.month),
          y: m.net_income,
        })),
      },
      {
        id: 'COGS',
        data: monthlyData.map(m => ({
          x: formatMonth(m.month),
          y: m.cogs,
        })),
      },
    ],
  };

  // Income statement table
  const currentMonth = monthlyData[monthlyData.length - 1];
  const prevMonth = monthlyData[monthlyData.length - 2] || currentMonth;

  const incomeTable = {
    title: `Income Statement - ${currentMonth ? formatMonth(currentMonth.month) : 'Current Period'}`,
    format: 'currency' as const,
    data: {
      headers: ['Description', 'Current', 'Previous', 'Change'],
      rows: [
        {
          label: 'Revenue',
          values: [
            currentMonth?.revenue || 0,
            prevMonth?.revenue || 0,
            (currentMonth?.revenue || 0) - (prevMonth?.revenue || 0),
          ],
          isTotal: false,
          indent: 0,
        },
        {
          label: 'Cost of Goods Sold',
          values: [
            -(currentMonth?.cogs || 0),
            -(prevMonth?.cogs || 0),
            -((currentMonth?.cogs || 0) - (prevMonth?.cogs || 0)),
          ],
          isTotal: false,
          indent: 1,
        },
        {
          label: 'Gross Profit',
          values: [
            currentMonth?.gross_profit || 0,
            prevMonth?.gross_profit || 0,
            (currentMonth?.gross_profit || 0) - (prevMonth?.gross_profit || 0),
          ],
          isTotal: true,
          indent: 0,
        },
        {
          label: 'Operating Expenses',
          values: [
            -(currentMonth?.operating_expenses || 0),
            -(prevMonth?.operating_expenses || 0),
            -((currentMonth?.operating_expenses || 0) - (prevMonth?.operating_expenses || 0)),
          ],
          isTotal: false,
          indent: 1,
        },
        {
          label: 'Net Income',
          values: [
            currentMonth?.net_income || 0,
            prevMonth?.net_income || 0,
            (currentMonth?.net_income || 0) - (prevMonth?.net_income || 0),
          ],
          isTotal: true,
          indent: 0,
        },
      ],
    },
  };

  // Balance sheet chart
  const balanceChart = {
    title: 'Assets vs Liabilities',
    xAxisLabel: 'Category',
    yAxisLabel: 'Amount ($)',
    format: 'currency' as const,
    data: [
      ...balanceSheetData.assets.slice(0, 3).map((a, i) => ({
        id: String(i + 1),
        label: a.name,
        value: a.balance,
      })),
      ...balanceSheetData.liabilities.slice(0, 2).map((l, i) => ({
        id: String(i + 4),
        label: l.name,
        value: l.balance,
      })),
    ],
  };

  // Balance sheet table
  const balanceTable = {
    title: 'Balance Sheet',
    format: 'currency' as const,
    data: {
      headers: ['Description', 'Balance'],
      rows: [
        { label: 'ASSETS', values: [''], isTotal: false, indent: 0 },
        ...balanceSheetData.assets.map(a => ({
          label: a.name,
          values: [a.balance],
          isTotal: false,
          indent: 1,
        })),
        {
          label: 'Total Assets',
          values: [balanceSheetData.total_assets],
          isTotal: true,
          indent: 0,
        },
        { label: '', values: [''], isTotal: false, indent: 0 },
        { label: 'LIABILITIES', values: [''], isTotal: false, indent: 0 },
        ...balanceSheetData.liabilities.map(l => ({
          label: l.name,
          values: [l.balance],
          isTotal: false,
          indent: 1,
        })),
        {
          label: 'Total Liabilities',
          values: [balanceSheetData.total_liabilities],
          isTotal: true,
          indent: 0,
        },
        { label: '', values: [''], isTotal: false, indent: 0 },
        { label: 'EQUITY', values: [''], isTotal: false, indent: 0 },
        ...balanceSheetData.equity.map(e => ({
          label: e.name,
          values: [e.balance],
          isTotal: false,
          indent: 1,
        })),
        {
          label: 'Total Equity',
          values: [balanceSheetData.total_equity],
          isTotal: true,
          indent: 0,
        },
      ],
    },
  };

  // Cash flow chart (simplified - using monthly net income as proxy for operating cash flow)
  const cashFlowChart = {
    title: 'Cash Flow Trend',
    xAxisLabel: 'Month',
    yAxisLabel: 'Cash Flow ($)',
    format: 'currency' as const,
    data: [
      {
        id: 'Operating',
        data: monthlyData.map(m => ({
          x: formatMonth(m.month),
          y: m.net_income + m.cogs * 0.1, // Simplified: net income + depreciation estimate
        })),
      },
      {
        id: 'Net Cash Flow',
        data: monthlyData.map(m => ({
          x: formatMonth(m.month),
          y: m.net_income,
        })),
      },
    ],
  };

  // Cash flow table
  const cashFlowTable = {
    title: 'Cash Flow Statement',
    format: 'currency' as const,
    data: {
      headers: ['Description', 'Amount'],
      rows: [
        { label: 'Operating Activities', values: [''], isTotal: false, indent: 0 },
        { label: 'Net Income', values: [metrics.net_income], isTotal: false, indent: 1 },
        {
          label: 'Net Cash from Operations',
          values: [cashFlowData.operating],
          isTotal: true,
          indent: 0,
        },
        { label: '', values: [''], isTotal: false, indent: 0 },
        { label: 'Investing Activities', values: [''], isTotal: false, indent: 0 },
        {
          label: 'Net Cash from Investing',
          values: [cashFlowData.investing],
          isTotal: true,
          indent: 0,
        },
        { label: '', values: [''], isTotal: false, indent: 0 },
        { label: 'Financing Activities', values: [''], isTotal: false, indent: 0 },
        {
          label: 'Net Cash from Financing',
          values: [cashFlowData.financing],
          isTotal: true,
          indent: 0,
        },
        { label: '', values: [''], isTotal: false, indent: 0 },
        {
          label: 'Net Change in Cash',
          values: [cashFlowData.net_change],
          isTotal: true,
          indent: 0,
        },
        { label: 'Ending Cash Balance', values: [metrics.cash_balance], isTotal: true, indent: 0 },
      ],
    },
  };

  // Revenue by category (from products)
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
    entity,
    kpis,
    healthIndicators,
    incomeStatement: {
      chart: incomeChart,
      table: incomeTable,
    },
    balanceSheet: {
      chart: balanceChart,
      table: balanceTable,
    },
    cashFlow: {
      chart: cashFlowChart,
      table: cashFlowTable,
    },
    revenueByCategory,
    orderAnalytics,
    invoices: invoicesResult.invoices,
    invoiceStats,
    lastUpdated: new Date().toISOString(),
  };
}

function formatMonth(monthStr: string): string {
  const date = new Date(monthStr + '-01');
  return date.toLocaleDateString('en-US', { month: 'short' });
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  return <DashboardView data={data} />;
}
