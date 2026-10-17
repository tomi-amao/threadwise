import { useCallback, useEffect, useState } from 'react';
import { useRevalidator } from 'react-router';
import { ArrowClockwise, CircleNotch } from 'phosphor-react';
import { OnboardingModal } from '~/components/onboarding/OnboardingModal';
import { Button } from '~/components/ui/button';
import { Hero, Page, PageSection } from '~/components/ui/page-header';
import { Stat, StatStrip } from '~/components/ui/stat-strip';
import { useAuth } from '~/providers/AuthProvider';
import type { DashboardData } from '~/types/dashboard';
import { CashSection } from './CashSection';
import { CustomersSection } from './CustomersSection';
import { OrdersSection } from './OrdersSection';
import { ProductsSection } from './ProductsSection';
import { RevenueSection } from './RevenueSection';
import { int, money, pct } from './format';

interface DashboardViewProps {
  data: DashboardData;
}

export function DashboardView({ data }: DashboardViewProps) {
  const revalidator = useRevalidator();
  const { needsOnboarding, refreshProfile, entity } = useAuth();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(
    data.lastUpdated ? new Date(data.lastUpdated) : new Date()
  );

  useEffect(() => {
    if (needsOnboarding) setShowOnboarding(true);
  }, [needsOnboarding]);

  const handleOnboardingComplete = useCallback(async () => {
    setShowOnboarding(false);
    await refreshProfile();
  }, [refreshProfile]);

  const handleRefresh = useCallback(() => {
    revalidator.revalidate();
    setLastUpdated(new Date());
  }, [revalidator]);

  const { kpis, customerStats } = data;
  const currency = data.entity?.currency || 'GBP';
  // The loader resolves the business from the auth cookie; the client-side entity is only a
  // fallback for the instant before it arrives.
  const businessName = data.entity?.name || entity?.name || 'Your business';
  const refreshing = revalidator.state === 'loading';
  const hasSales = kpis.totalOrders > 0;
  const feesAndRefunds = kpis.processingFees + kpis.totalRefunds;

  return (
    <div className="pb-8">
      <OnboardingModal open={showOnboarding} onComplete={handleOnboardingComplete} />

      <Page className="pb-0">
        <Hero
          eyebrow={`${businessName} · All time`}
          title={
            <>
              Where the business <em>stands today.</em>
            </>
          }
          lead={
            hasSales
              ? `${money(kpis.grossRevenue, currency)} sold across ${int(kpis.totalOrders)} orders, with ${money(kpis.totalBankBalance, currency)} in the bank.`
              : 'No orders yet. Connect a store and the numbers appear here.'
          }
          actions={
            <>
              <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
                {refreshing ? (
                  <CircleNotch size={16} weight="light" className="animate-spin" aria-hidden />
                ) : (
                  <ArrowClockwise size={16} weight="light" aria-hidden />
                )}
                Refresh
              </Button>
              <span className="font-mono text-xs tracking-[0.04em] text-muted-foreground">
                {refreshing
                  ? 'REFRESHING…'
                  : `UPDATED ${lastUpdated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`}
              </span>
            </>
          }
        />

        <PageSection>
          <StatStrip>
            <Stat
              label="Gross revenue"
              value={money(kpis.grossRevenue, currency)}
              title="All orders"
              caption={`${int(kpis.totalOrders)} orders · ${money(kpis.avgOrderValue, currency, 2)} average`}
            />
            <Stat
              label="Net revenue"
              value={money(kpis.netRevenue, currency)}
              title="After fees and refunds"
              caption={`${money(feesAndRefunds, currency)} in fees and refunds`}
            />
            <Stat
              label="In the bank"
              value={money(kpis.totalBankBalance, currency)}
              title={`${data.bankAccounts.length} ${data.bankAccounts.length === 1 ? 'account' : 'accounts'}`}
              caption={
                [...new Set(data.bankAccounts.map(a => a.source))].join(', ') || 'None connected'
              }
            />
            <Stat
              label="Customers"
              value={int(kpis.totalCustomers)}
              title={`${int(customerStats.withOrders)} have bought`}
              caption={`${pct(customerStats.repeatRate)} come back`}
            />
          </StatStrip>
        </PageSection>
      </Page>

      <div className="mt-16">
        <RevenueSection
          months={data.revenueByMonth}
          statuses={data.ordersByStatus}
          kpis={kpis}
          currency={currency}
        />
        <ProductsSection
          products={data.topProducts}
          payments={data.paymentMethods}
          grossRevenue={kpis.grossRevenue}
          currency={currency}
        />
        <CustomersSection
          customers={data.topCustomers}
          stats={customerStats}
          kpis={kpis}
          currency={currency}
        />
        <CashSection accounts={data.bankAccounts} currency={currency} />
        <OrdersSection orders={data.recentOrders} currency={currency} />
      </div>
    </div>
  );
}
