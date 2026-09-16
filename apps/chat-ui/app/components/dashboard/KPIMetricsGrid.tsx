import React from 'react';
import { MetricCardViz, type MetricCardProps } from '~/components/visualizations/MetricCardViz';

interface KPIMetricsGridProps {
  kpis: {
    revenue: MetricCardProps;
    netIncome: MetricCardProps;
    cashBalance: MetricCardProps;
    grossMargin: MetricCardProps;
    cogs?: MetricCardProps;
    operatingExpenses?: MetricCardProps;
    accountsReceivable: MetricCardProps;
  };
}

export function KPIMetricsGrid({ kpis }: KPIMetricsGridProps) {
  const metrics: MetricCardProps[] = [
    kpis.revenue,
    kpis.netIncome,
    kpis.cashBalance,
    kpis.grossMargin,
    kpis.cogs || kpis.operatingExpenses || { title: 'COGS', value: 0, format: 'currency' as const },
    kpis.accountsReceivable,
  ].filter(Boolean);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Key Performance Indicators</h2>
        <span className="text-sm text-muted-foreground">All time</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {metrics.map((metric, index) => (
          <MetricCardViz key={index} {...metric} />
        ))}
      </div>
    </section>
  );
}
