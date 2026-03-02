import React from 'react';
import { CheckCircle, Warning, XCircle, Info } from 'phosphor-react';
import type { HealthIndicator } from '~/lib/mock-dashboard-data';

interface HealthIndicatorsProps {
  indicators: HealthIndicator[];
}

export function HealthIndicators({ indicators }: HealthIndicatorsProps) {
  const getStatusIcon = (status: HealthIndicator['status']) => {
    switch (status) {
      case 'healthy':
        return <CheckCircle size={20} weight="fill" className="text-green-400" />;
      case 'warning':
        return <Warning size={20} weight="fill" className="text-amber-400" />;
      case 'critical':
        return <XCircle size={20} weight="fill" className="text-red-400" />;
    }
  };

  const getStatusColor = (status: HealthIndicator['status']) => {
    switch (status) {
      case 'healthy':
        return 'border-green-500/30 bg-green-500/5';
      case 'warning':
        return 'border-amber-500/30 bg-amber-500/5';
      case 'critical':
        return 'border-red-500/30 bg-red-500/5';
    }
  };

  const getProgressColor = (status: HealthIndicator['status']) => {
    switch (status) {
      case 'healthy':
        return 'bg-green-500';
      case 'warning':
        return 'bg-amber-500';
      case 'critical':
        return 'bg-red-500';
    }
  };

  // Calculate progress percentage (capped at 100%)
  const getProgress = (indicator: HealthIndicator) => {
    // For metrics where lower is better (like debt-to-equity, DSO)
    const lowerIsBetter = ['Debt-to-Equity', 'Days Sales Outstanding'].includes(indicator.name);

    if (lowerIsBetter) {
      // If we're at or below target, show 100%
      if (indicator.value <= indicator.target) return 100;
      // Otherwise show how far we are from target (inverted)
      return Math.max(0, Math.min(100, (indicator.target / indicator.value) * 100));
    } else {
      // For metrics where higher is better
      return Math.min(100, (indicator.value / indicator.target) * 100);
    }
  };

  const healthyCount = indicators.filter(i => i.status === 'healthy').length;
  const warningCount = indicators.filter(i => i.status === 'warning').length;
  const criticalCount = indicators.filter(i => i.status === 'critical').length;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">Business Health</h2>
          <div className="flex items-center gap-2 text-sm">
            <span className="flex items-center gap-1 text-green-400">
              <CheckCircle size={14} weight="fill" /> {healthyCount}
            </span>
            <span className="flex items-center gap-1 text-amber-400">
              <Warning size={14} weight="fill" /> {warningCount}
            </span>
            {criticalCount > 0 && (
              <span className="flex items-center gap-1 text-red-400">
                <XCircle size={14} weight="fill" /> {criticalCount}
              </span>
            )}
          </div>
        </div>
        <button className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          <Info size={14} />
          What do these mean?
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {indicators.map((indicator, index) => (
          <div
            key={index}
            className={`rounded-lg border p-4 transition-colors ${getStatusColor(indicator.status)}`}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  {getStatusIcon(indicator.status)}
                  <h3 className="font-medium text-foreground">{indicator.name}</h3>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{indicator.description}</p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold text-foreground">
                  {indicator.value}
                  <span className="text-sm font-normal text-muted-foreground ml-1">
                    {indicator.unit}
                  </span>
                </span>
                <span className="text-sm text-muted-foreground">
                  Target: {indicator.target}
                  {indicator.unit}
                </span>
              </div>

              {/* Progress bar */}
              <div className="h-2 bg-neutral-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${getProgressColor(
                    indicator.status
                  )}`}
                  style={{ width: `${getProgress(indicator)}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
