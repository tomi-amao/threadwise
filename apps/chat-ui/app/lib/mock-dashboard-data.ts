/**
 * Dashboard Mock Data Service
 *
 * Provides sample financial data for the dashboard visualizations.
 * In production, this will be replaced by API calls to the AI Agent backend.
 */

import type { MetricCardProps } from '~/components/visualizations/MetricCardViz';
import type { LineChartProps } from '~/components/visualizations/LineChartViz';
import type { BarChartProps } from '~/components/visualizations/BarChartViz';
import type { FinancialTableProps } from '~/components/visualizations/FinancialTableViz';

// =============================================================================
// KPI METRICS DATA
// =============================================================================

export interface DashboardKPIs {
  revenue: MetricCardProps;
  netIncome: MetricCardProps;
  cashBalance: MetricCardProps;
  grossMargin: MetricCardProps;
  operatingExpenses: MetricCardProps;
  accountsReceivable: MetricCardProps;
}

export function getDashboardKPIs(): DashboardKPIs {
  return {
    revenue: {
      title: 'Total Revenue',
      value: 2450000,
      format: 'currency',
      trend: {
        direction: 'up',
        value: 12.5,
        period: 'vs last quarter',
      },
      description: 'Year-to-date revenue from all sources',
    },
    netIncome: {
      title: 'Net Income',
      value: 385000,
      format: 'currency',
      trend: {
        direction: 'up',
        value: 8.2,
        period: 'vs last quarter',
      },
      description: 'Profit after all expenses and taxes',
    },
    cashBalance: {
      title: 'Cash Balance',
      value: 892000,
      format: 'currency',
      trend: {
        direction: 'down',
        value: 3.1,
        period: 'vs last month',
      },
      description: 'Current available cash on hand',
    },
    grossMargin: {
      title: 'Gross Margin',
      value: 42.8,
      format: 'percentage',
      trend: {
        direction: 'up',
        value: 2.3,
        period: 'vs last quarter',
      },
      description: 'Revenue minus cost of goods sold',
    },
    operatingExpenses: {
      title: 'Operating Expenses',
      value: 675000,
      format: 'currency',
      trend: {
        direction: 'up',
        value: 5.4,
        period: 'vs last quarter',
      },
      description: 'Total operational costs this quarter',
    },
    accountsReceivable: {
      title: 'Accounts Receivable',
      value: 312000,
      format: 'currency',
      trend: {
        direction: 'down',
        value: 8.7,
        period: 'vs last month',
      },
      description: 'Outstanding customer payments',
    },
  };
}

// =============================================================================
// BUSINESS HEALTH INDICATORS
// =============================================================================

export interface HealthIndicator {
  name: string;
  status: 'healthy' | 'warning' | 'critical';
  value: number;
  target: number;
  unit: string;
  description: string;
}

export function getBusinessHealthIndicators(): HealthIndicator[] {
  return [
    {
      name: 'Current Ratio',
      status: 'healthy',
      value: 2.4,
      target: 2.0,
      unit: 'x',
      description: 'Ability to pay short-term obligations',
    },
    {
      name: 'Quick Ratio',
      status: 'healthy',
      value: 1.8,
      target: 1.5,
      unit: 'x',
      description: 'Liquid assets vs current liabilities',
    },
    {
      name: 'Debt-to-Equity',
      status: 'warning',
      value: 0.85,
      target: 0.5,
      unit: 'x',
      description: 'Total debt vs shareholder equity',
    },
    {
      name: 'Days Sales Outstanding',
      status: 'healthy',
      value: 32,
      target: 45,
      unit: 'days',
      description: 'Average collection period',
    },
    {
      name: 'Inventory Turnover',
      status: 'warning',
      value: 4.2,
      target: 6.0,
      unit: 'x',
      description: 'Times inventory sold per year',
    },
    {
      name: 'Operating Cash Flow Ratio',
      status: 'healthy',
      value: 1.35,
      target: 1.0,
      unit: 'x',
      description: 'Cash flow vs current liabilities',
    },
  ];
}

// =============================================================================
// INCOME STATEMENT DATA
// =============================================================================

export function getIncomeStatementChart(): LineChartProps {
  return {
    title: 'Income Statement Trend',
    xAxisLabel: 'Month',
    yAxisLabel: 'Amount ($)',
    format: 'currency',
    data: [
      {
        id: 'Revenue',
        data: [
          { x: 'Jan', y: 380000 },
          { x: 'Feb', y: 420000 },
          { x: 'Mar', y: 395000 },
          { x: 'Apr', y: 450000 },
          { x: 'May', y: 480000 },
          { x: 'Jun', y: 510000 },
          { x: 'Jul', y: 485000 },
          { x: 'Aug', y: 520000 },
          { x: 'Sep', y: 545000 },
          { x: 'Oct', y: 560000 },
          { x: 'Nov', y: 590000 },
          { x: 'Dec', y: 615000 },
        ],
      },
      {
        id: 'Net Income',
        data: [
          { x: 'Jan', y: 45000 },
          { x: 'Feb', y: 58000 },
          { x: 'Mar', y: 42000 },
          { x: 'Apr', y: 67000 },
          { x: 'May', y: 78000 },
          { x: 'Jun', y: 85000 },
          { x: 'Jul', y: 72000 },
          { x: 'Aug', y: 89000 },
          { x: 'Sep', y: 95000 },
          { x: 'Oct', y: 102000 },
          { x: 'Nov', y: 115000 },
          { x: 'Dec', y: 137000 },
        ],
      },
      {
        id: 'Operating Expenses',
        data: [
          { x: 'Jan', y: 165000 },
          { x: 'Feb', y: 172000 },
          { x: 'Mar', y: 168000 },
          { x: 'Apr', y: 175000 },
          { x: 'May', y: 180000 },
          { x: 'Jun', y: 185000 },
          { x: 'Jul', y: 182000 },
          { x: 'Aug', y: 188000 },
          { x: 'Sep', y: 192000 },
          { x: 'Oct', y: 198000 },
          { x: 'Nov', y: 205000 },
          { x: 'Dec', y: 212000 },
        ],
      },
    ],
  };
}

export function getIncomeStatementTable(): FinancialTableProps {
  return {
    title: 'Income Statement - Q4 2025',
    format: 'currency',
    data: {
      headers: ['Description', 'Q4 2025', 'Q3 2025', 'Change'],
      rows: [
        { label: 'Revenue', values: [1765000, 1550000, 215000], isTotal: false, indent: 0 },
        {
          label: 'Cost of Goods Sold',
          values: [-1010000, -890000, -120000],
          isTotal: false,
          indent: 1,
        },
        { label: 'Gross Profit', values: [755000, 660000, 95000], isTotal: true, indent: 0 },
        { label: 'Operating Expenses', values: [], isTotal: false, indent: 0 },
        {
          label: 'Sales & Marketing',
          values: [-185000, -165000, -20000],
          isTotal: false,
          indent: 1,
        },
        {
          label: 'General & Administrative',
          values: [-125000, -115000, -10000],
          isTotal: false,
          indent: 1,
        },
        {
          label: 'Research & Development',
          values: [-95000, -85000, -10000],
          isTotal: false,
          indent: 1,
        },
        { label: 'Depreciation', values: [-45000, -42000, -3000], isTotal: false, indent: 1 },
        {
          label: 'Total Operating Expenses',
          values: [-450000, -407000, -43000],
          isTotal: true,
          indent: 0,
        },
        { label: 'Operating Income', values: [305000, 253000, 52000], isTotal: true, indent: 0 },
        { label: 'Interest Expense', values: [-22000, -20000, -2000], isTotal: false, indent: 1 },
        { label: 'Other Income', values: [8000, 5000, 3000], isTotal: false, indent: 1 },
        {
          label: 'Income Before Taxes',
          values: [291000, 238000, 53000],
          isTotal: false,
          indent: 0,
        },
        {
          label: 'Income Tax Expense',
          values: [-58000, -48000, -10000],
          isTotal: false,
          indent: 1,
        },
        { label: 'Net Income', values: [233000, 190000, 43000], isTotal: true, indent: 0 },
      ],
    },
  };
}

// =============================================================================
// BALANCE SHEET DATA
// =============================================================================

export function getBalanceSheetChart(): BarChartProps {
  return {
    title: 'Assets vs Liabilities',
    xAxisLabel: 'Category',
    yAxisLabel: 'Amount ($)',
    format: 'currency',
    data: [
      { id: '1', label: 'Current Assets', value: 1450000 },
      { id: '2', label: 'Fixed Assets', value: 2100000 },
      { id: '3', label: 'Current Liabilities', value: 605000 },
      { id: '4', label: 'Long-term Debt', value: 850000 },
      { id: '5', label: 'Shareholders Equity', value: 2095000 },
    ],
  };
}

export function getBalanceSheetTable(): FinancialTableProps {
  return {
    title: 'Balance Sheet - December 31, 2025',
    format: 'currency',
    data: {
      headers: ['Description', '2025', '2024'],
      rows: [
        { label: 'ASSETS', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Current Assets', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Cash & Equivalents', values: [892000, 820000], isTotal: false, indent: 1 },
        { label: 'Accounts Receivable', values: [312000, 285000], isTotal: false, indent: 1 },
        { label: 'Inventory', values: [185000, 165000], isTotal: false, indent: 1 },
        { label: 'Prepaid Expenses', values: [61000, 52000], isTotal: false, indent: 1 },
        { label: 'Total Current Assets', values: [1450000, 1322000], isTotal: true, indent: 0 },
        { label: 'Property & Equipment', values: [1850000, 1720000], isTotal: false, indent: 1 },
        { label: 'Less: Depreciation', values: [-450000, -380000], isTotal: false, indent: 1 },
        { label: 'Net Fixed Assets', values: [1400000, 1340000], isTotal: false, indent: 0 },
        { label: 'Intangible Assets', values: [700000, 680000], isTotal: false, indent: 1 },
        { label: 'Total Assets', values: [3550000, 3342000], isTotal: true, indent: 0 },
        { label: '', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'LIABILITIES & EQUITY', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Current Liabilities', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Accounts Payable', values: [245000, 218000], isTotal: false, indent: 1 },
        { label: 'Accrued Expenses', values: [165000, 145000], isTotal: false, indent: 1 },
        { label: 'Current Debt', values: [195000, 175000], isTotal: false, indent: 1 },
        { label: 'Total Current Liabilities', values: [605000, 538000], isTotal: true, indent: 0 },
        { label: 'Long-term Debt', values: [850000, 920000], isTotal: false, indent: 1 },
        { label: 'Total Liabilities', values: [1455000, 1458000], isTotal: true, indent: 0 },
        { label: 'Shareholders Equity', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Common Stock', values: [500000, 500000], isTotal: false, indent: 1 },
        { label: 'Retained Earnings', values: [1595000, 1384000], isTotal: false, indent: 1 },
        { label: 'Total Equity', values: [2095000, 1884000], isTotal: true, indent: 0 },
        {
          label: 'Total Liabilities & Equity',
          values: [3550000, 3342000],
          isTotal: true,
          indent: 0,
        },
      ],
    },
  };
}

// =============================================================================
// CASH FLOW STATEMENT DATA
// =============================================================================

export function getCashFlowChart(): LineChartProps {
  return {
    title: 'Cash Flow Trend',
    xAxisLabel: 'Month',
    yAxisLabel: 'Cash Flow ($)',
    format: 'currency',
    data: [
      {
        id: 'Operating',
        data: [
          { x: 'Jan', y: 65000 },
          { x: 'Feb', y: 78000 },
          { x: 'Mar', y: 52000 },
          { x: 'Apr', y: 85000 },
          { x: 'May', y: 92000 },
          { x: 'Jun', y: 98000 },
          { x: 'Jul', y: 88000 },
          { x: 'Aug', y: 102000 },
          { x: 'Sep', y: 108000 },
          { x: 'Oct', y: 115000 },
          { x: 'Nov', y: 125000 },
          { x: 'Dec', y: 142000 },
        ],
      },
      {
        id: 'Investing',
        data: [
          { x: 'Jan', y: -35000 },
          { x: 'Feb', y: -42000 },
          { x: 'Mar', y: -28000 },
          { x: 'Apr', y: -55000 },
          { x: 'May', y: -38000 },
          { x: 'Jun', y: -45000 },
          { x: 'Jul', y: -32000 },
          { x: 'Aug', y: -48000 },
          { x: 'Sep', y: -52000 },
          { x: 'Oct', y: -58000 },
          { x: 'Nov', y: -62000 },
          { x: 'Dec', y: -75000 },
        ],
      },
      {
        id: 'Financing',
        data: [
          { x: 'Jan', y: -15000 },
          { x: 'Feb', y: -15000 },
          { x: 'Mar', y: -15000 },
          { x: 'Apr', y: -15000 },
          { x: 'May', y: -25000 },
          { x: 'Jun', y: -15000 },
          { x: 'Jul', y: -15000 },
          { x: 'Aug', y: -15000 },
          { x: 'Sep', y: -15000 },
          { x: 'Oct', y: -25000 },
          { x: 'Nov', y: -15000 },
          { x: 'Dec', y: -15000 },
        ],
      },
    ],
  };
}

export function getCashFlowTable(): FinancialTableProps {
  return {
    title: 'Cash Flow Statement - Q4 2025',
    format: 'currency',
    data: {
      headers: ['Description', 'Q4 2025', 'Q3 2025'],
      rows: [
        { label: 'Operating Activities', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Net Income', values: [233000, 190000], isTotal: false, indent: 1 },
        { label: 'Depreciation & Amortization', values: [45000, 42000], isTotal: false, indent: 1 },
        { label: 'Changes in Working Capital', values: ['', ''], isTotal: false, indent: 1 },
        { label: 'Accounts Receivable', values: [-27000, -18000], isTotal: false, indent: 2 },
        { label: 'Inventory', values: [-20000, -12000], isTotal: false, indent: 2 },
        { label: 'Accounts Payable', values: [27000, 15000], isTotal: false, indent: 2 },
        { label: 'Accrued Expenses', values: [20000, 8000], isTotal: false, indent: 2 },
        { label: 'Net Cash from Operations', values: [278000, 225000], isTotal: true, indent: 0 },
        { label: '', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Investing Activities', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Capital Expenditures', values: [-130000, -98000], isTotal: false, indent: 1 },
        { label: 'Purchase of Intangibles', values: [-20000, -15000], isTotal: false, indent: 1 },
        { label: 'Net Cash from Investing', values: [-150000, -113000], isTotal: true, indent: 0 },
        { label: '', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Financing Activities', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Debt Repayment', values: [-70000, -45000], isTotal: false, indent: 1 },
        { label: 'Dividends Paid', values: [-25000, 0], isTotal: false, indent: 1 },
        { label: 'Net Cash from Financing', values: [-95000, -45000], isTotal: true, indent: 0 },
        { label: '', values: ['', ''], isTotal: false, indent: 0 },
        { label: 'Net Change in Cash', values: [33000, 67000], isTotal: true, indent: 0 },
        { label: 'Beginning Cash Balance', values: [859000, 792000], isTotal: false, indent: 1 },
        { label: 'Ending Cash Balance', values: [892000, 859000], isTotal: true, indent: 0 },
      ],
    },
  };
}

// =============================================================================
// REVENUE BREAKDOWN
// =============================================================================

export function getRevenueByCategory(): BarChartProps {
  return {
    title: 'Revenue by Category',
    xAxisLabel: 'Category',
    yAxisLabel: 'Revenue ($)',
    format: 'currency',
    data: [
      { id: '1', label: 'Product Sales', value: 1250000 },
      { id: '2', label: 'Services', value: 680000 },
      { id: '3', label: 'Subscriptions', value: 420000 },
      { id: '4', label: 'Licensing', value: 100000 },
    ],
  };
}

export function getExpenseBreakdown(): BarChartProps {
  return {
    title: 'Expense Breakdown',
    xAxisLabel: 'Category',
    yAxisLabel: 'Amount ($)',
    format: 'currency',
    data: [
      { id: '1', label: 'COGS', value: 1010000 },
      { id: '2', label: 'Sales & Marketing', value: 185000 },
      { id: '3', label: 'G&A', value: 125000 },
      { id: '4', label: 'R&D', value: 95000 },
      { id: '5', label: 'Depreciation', value: 45000 },
    ],
  };
}
