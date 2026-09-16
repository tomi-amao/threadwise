import { useState, useCallback, useEffect } from 'react';
import { useRevalidator } from 'react-router';
import { DashboardHeader } from './DashboardHeader';
import { KPICards } from './KPICards';
import { RevenueChart } from './RevenueChart';
import { OrderStatusCards } from './OrderStatusCards';
import { TopProducts } from './TopProducts';
import { TopCustomers } from './TopCustomers';
import { PaymentBreakdown } from './PaymentBreakdown';
import { CustomerInsights } from './CustomerInsights';
import { BankAccounts } from './BankAccounts';
import { RecentOrders } from './RecentOrders';
import { OnboardingModal } from '~/components/onboarding/OnboardingModal';
import { useAuth } from '~/providers/AuthProvider';
import type { DashboardData } from '~/types/dashboard';

interface DashboardViewProps {
  data: DashboardData;
}

export function DashboardView({ data }: DashboardViewProps) {
  const revalidator = useRevalidator();
  const { needsOnboarding, refreshProfile } = useAuth();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(
    data.lastUpdated ? new Date(data.lastUpdated) : new Date()
  );

  useEffect(() => {
    if (needsOnboarding) {
      setShowOnboarding(true);
    }
  }, [needsOnboarding]);

  const handleOnboardingComplete = useCallback(async () => {
    setShowOnboarding(false);
    await refreshProfile();
  }, [refreshProfile]);

  const currency = data.entity?.currency || 'GBP';
  const entityName = data.entity?.name || 'Your Business';

  const handleRefresh = useCallback(() => {
    revalidator.revalidate();
    setLastUpdated(new Date());
  }, [revalidator]);

  return (
    <div className="min-h-screen bg-background pb-20">
      <OnboardingModal open={showOnboarding} onComplete={handleOnboardingComplete} />

      <DashboardHeader
        onRefresh={handleRefresh}
        lastUpdated={lastUpdated}
        entityName={entityName}
        isLoading={revalidator.state === 'loading'}
      />

      <main className="px-4 md:px-6 lg:px-8 py-6 space-y-6">
        {/* KPI Cards Row */}
        <KPICards kpis={data.kpis} currency={currency} />

        {/* Revenue Chart + Order Status */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <RevenueChart data={data.revenueByMonth} currency={currency} />
          </div>
          <OrderStatusCards
            statuses={data.ordersByStatus}
            totalOrders={data.kpis.totalOrders}
          />
        </div>

        {/* Top Products + Payment Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TopProducts products={data.topProducts} currency={currency} />
          <PaymentBreakdown data={data.paymentMethods} currency={currency} />
        </div>

        {/* Top Customers + Customer Insights */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TopCustomers customers={data.topCustomers} currency={currency} />
          <CustomerInsights
            customerStats={data.customerStats}
            kpis={data.kpis}
            currency={currency}
          />
        </div>

        {/* Bank Accounts */}
        <BankAccounts accounts={data.bankAccounts} />

        {/* Recent Orders */}
        <RecentOrders orders={data.recentOrders} currency={currency} />
      </main>
    </div>
  );
}
