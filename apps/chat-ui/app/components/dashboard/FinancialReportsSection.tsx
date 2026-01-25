import React, { useState } from 'react';
import { ChartLine, Scales, CurrencyCircleDollar, Table, ChartBar } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { LineChartViz, type LineChartProps } from '~/components/visualizations/LineChartViz';
import { BarChartViz, type BarChartProps } from '~/components/visualizations/BarChartViz';
import {
  FinancialTableViz,
  type FinancialTableProps,
} from '~/components/visualizations/FinancialTableViz';

interface FinancialReport {
  id: 'income' | 'balance' | 'cashflow';
  name: string;
  icon: React.ReactNode;
  chartData: LineChartProps | BarChartProps;
  tableData: FinancialTableProps;
}

interface FinancialReportsSectionProps {
  incomeChart: LineChartProps;
  incomeTable: FinancialTableProps;
  balanceChart: BarChartProps;
  balanceTable: FinancialTableProps;
  cashFlowChart: LineChartProps;
  cashFlowTable: FinancialTableProps;
}

type ViewMode = 'chart' | 'table';

export function FinancialReportsSection({
  incomeChart,
  incomeTable,
  balanceChart,
  balanceTable,
  cashFlowChart,
  cashFlowTable,
}: FinancialReportsSectionProps) {
  const [activeReport, setActiveReport] = useState<'income' | 'balance' | 'cashflow'>('income');
  const [viewMode, setViewMode] = useState<ViewMode>('chart');

  const reports: FinancialReport[] = [
    {
      id: 'income',
      name: 'Income Statement',
      icon: <ChartLine size={20} weight="duotone" />,
      chartData: incomeChart,
      tableData: incomeTable,
    },
    {
      id: 'balance',
      name: 'Balance Sheet',
      icon: <Scales size={20} weight="duotone" />,
      chartData: balanceChart,
      tableData: balanceTable,
    },
    {
      id: 'cashflow',
      name: 'Cash Flow',
      icon: <CurrencyCircleDollar size={20} weight="duotone" />,
      chartData: cashFlowChart,
      tableData: cashFlowTable,
    },
  ];

  const currentReport = reports.find(r => r.id === activeReport)!;

  const isLineChart = (data: LineChartProps | BarChartProps): data is LineChartProps => {
    // LineChartProps has data array with objects containing 'id' and 'data' (nested array)
    // BarChartProps has data array with objects containing 'id', 'label', 'value'
    return (
      'data' in data && Array.isArray(data.data) && data.data.length > 0 && 'data' in data.data[0]
    );
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-foreground">Financial Reports</h2>

        {/* View toggle */}
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-border bg-card p-1">
            <Button
              variant={viewMode === 'chart' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('chart')}
              className="gap-2 h-8 px-3"
            >
              <ChartBar size={16} />
              <span className="hidden sm:inline">Chart</span>
            </Button>
            <Button
              variant={viewMode === 'table' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('table')}
              className="gap-2 h-8 px-3"
            >
              <Table size={16} />
              <span className="hidden sm:inline">Table</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Report tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {reports.map(report => (
          <Button
            key={report.id}
            variant={activeReport === report.id ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveReport(report.id)}
            className="gap-2 whitespace-nowrap"
          >
            {report.icon}
            {report.name}
          </Button>
        ))}
      </div>

      {/* Report content */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {viewMode === 'chart' ? (
          <div className="p-4 md:p-6">
            {isLineChart(currentReport.chartData) ? (
              <LineChartViz {...currentReport.chartData} />
            ) : (
              <BarChartViz {...(currentReport.chartData as BarChartProps)} />
            )}
          </div>
        ) : (
          <div className="p-4 md:p-6">
            <FinancialTableViz {...currentReport.tableData} />
          </div>
        )}
      </div>
    </section>
  );
}
