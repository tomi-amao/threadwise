import React, { useState, useCallback } from 'react';
import { useRevalidator } from 'react-router';
import { DashboardHeader } from './DashboardHeader';
import { KPIMetricsGrid } from './KPIMetricsGrid';
import { HealthIndicators } from './HealthIndicators';
import { QuickInsights } from './QuickInsights';
import type { DashboardLoaderData } from '~/types/dashboard';

// Fallback mock data imports for standalone usage
import {
  getDashboardKPIs,
  getBusinessHealthIndicators,
  getRevenueByCategory,
  getExpenseBreakdown,
} from '~/lib/mock-dashboard-data';

interface DashboardViewProps {
  data?: DashboardLoaderData;
}

/**
 * DashboardView Component
 *
 * Main dashboard view that displays:
 * - Key Performance Indicators (KPIs)
 * - Business Health Indicators
 * - Financial Reports (Income Statement, Balance Sheet, Cash Flow)
 * - Quick Insights and actions
 *
 * Accepts real data from loader or falls back to mock data
 */
export function DashboardView({ data }: DashboardViewProps) {
  const revalidator = useRevalidator();
  const [lastUpdated, setLastUpdated] = useState(
    data?.lastUpdated ? new Date(data.lastUpdated) : new Date()
  );

  // Use real data if provided, otherwise fall back to mock data
  const kpis = data?.kpis || getDashboardKPIs();
  const healthIndicators = data?.healthIndicators || getBusinessHealthIndicators();
  const revenueByCategory = data?.revenueByCategory || getRevenueByCategory();
  const expenseBreakdown = getExpenseBreakdown(); // Always use mock for now

  const entityName = data?.entity?.name || 'Your Business';

  const handleRefresh = useCallback(() => {
    // Revalidate loader data
    revalidator.revalidate();
    setLastUpdated(new Date());
  }, [revalidator]);

  return (
    <div className="min-h-screen bg-background pb-20">
      <DashboardHeader
        onRefresh={handleRefresh}
        lastUpdated={lastUpdated}
        entityName={entityName}
        isLoading={revalidator.state === 'loading'}
      />

      <main className="px-4 md:px-6 lg:px-8 py-6 space-y-8">
        {/* KPI Metrics */}
        <KPIMetricsGrid kpis={kpis} />

        {/* Business Health Indicators */}
        <HealthIndicators indicators={healthIndicators} />

        {/* Insights & Analysis */}
        <QuickInsights
          revenueByCategory={revenueByCategory}
          expenseBreakdown={expenseBreakdown}
          orderAnalytics={data?.orderAnalytics}
        />
      </main>
    </div>
  );
}
