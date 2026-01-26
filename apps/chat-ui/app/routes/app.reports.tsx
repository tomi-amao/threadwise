/**
 * Financial Reports Route (Protected)
 *
 * Detailed financial reports page with income statement, balance sheet, and cash flow.
 */

import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData, useRevalidator } from 'react-router';
import { useState, useCallback } from 'react';
import { ArrowClockwise } from 'phosphor-react';
import { FinancialReportsSection } from '~/components/dashboard/FinancialReportsSection';
import { Button } from '~/components/ui/button';
import {
  getMonthlyFinancials,
  getBalanceSheet,
  getCashFlow,
  getDashboardMetrics,
} from '~/lib/api/dashboard.server';

export const meta: MetaFunction = () => {
  return [
    { title: 'Financial Reports - ThreadWise' },
    { name: 'description', content: 'View detailed financial reports' },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const [monthlyData, balanceSheetData, cashFlowData, metrics] = await Promise.all([
    getMonthlyFinancials(12),
    getBalanceSheet(),
    getCashFlow(),
    getDashboardMetrics(),
  ]);

  const formatMonth = (monthStr: string): string => {
    const date = new Date(monthStr + '-01');
    return date.toLocaleDateString('en-US', { month: 'short' });
  };

  const incomeChart = {
    title: 'Income Statement Trend',
    xAxisLabel: 'Month',
    yAxisLabel: 'Amount ($)',
    format: 'currency' as const,
    data: [
      {
        id: 'Revenue',
        data: monthlyData.map(m => ({ x: formatMonth(m.month), y: m.revenue })),
      },
      {
        id: 'Net Income',
        data: monthlyData.map(m => ({ x: formatMonth(m.month), y: m.net_income })),
      },
    ],
  };

  const currentMonth = monthlyData[monthlyData.length - 1];
  const prevMonth = monthlyData[monthlyData.length - 2] || currentMonth;

  const incomeTable = {
    title: 'Income Statement',
    format: 'currency' as const,
    data: {
      headers: ['Description', 'Current', 'Previous'],
      rows: [
        {
          label: 'Revenue',
          values: [currentMonth?.revenue || 0, prevMonth?.revenue || 0],
          isTotal: false,
          indent: 0,
        },
        {
          label: 'Cost of Goods Sold',
          values: [-(currentMonth?.cogs || 0), -(prevMonth?.cogs || 0)],
          isTotal: false,
          indent: 1,
        },
        {
          label: 'Gross Profit',
          values: [currentMonth?.gross_profit || 0, prevMonth?.gross_profit || 0],
          isTotal: true,
          indent: 0,
        },
        {
          label: 'Net Income',
          values: [currentMonth?.net_income || 0, prevMonth?.net_income || 0],
          isTotal: true,
          indent: 0,
        },
      ],
    },
  };

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

  const cashFlowChart = {
    title: 'Cash Flow Trend',
    xAxisLabel: 'Month',
    yAxisLabel: 'Cash Flow ($)',
    format: 'currency' as const,
    data: [
      {
        id: 'Net Cash Flow',
        data: monthlyData.map(m => ({ x: formatMonth(m.month), y: m.net_income })),
      },
    ],
  };

  const cashFlowTable = {
    title: 'Cash Flow Statement',
    format: 'currency' as const,
    data: {
      headers: ['Description', 'Amount'],
      rows: [
        { label: 'Operating Activities', values: [''], isTotal: false, indent: 0 },
        {
          label: 'Net Cash from Operations',
          values: [cashFlowData.operating],
          isTotal: true,
          indent: 0,
        },
        { label: 'Investing Activities', values: [''], isTotal: false, indent: 0 },
        {
          label: 'Net Cash from Investing',
          values: [cashFlowData.investing],
          isTotal: true,
          indent: 0,
        },
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

  return {
    incomeChart,
    incomeTable,
    balanceChart,
    balanceTable,
    cashFlowChart,
    cashFlowTable,
  };
}

export default function ReportsPage() {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const handleRefresh = useCallback(() => {
    revalidator.revalidate();
    setLastUpdated(new Date());
  }, [revalidator]);

  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Financial Reports</h1>
          <p className="text-muted-foreground mt-2">
            Detailed financial statements and analysis for your business.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={revalidator.state === 'loading'}
          className="gap-2"
        >
          <ArrowClockwise
            size={16}
            className={revalidator.state === 'loading' ? 'animate-spin' : ''}
          />
          Refresh
        </Button>
      </div>

      <FinancialReportsSection
        incomeChart={data.incomeChart}
        incomeTable={data.incomeTable}
        balanceChart={data.balanceChart}
        balanceTable={data.balanceTable}
        cashFlowChart={data.cashFlowChart}
        cashFlowTable={data.cashFlowTable}
      />
    </div>
  );
}
