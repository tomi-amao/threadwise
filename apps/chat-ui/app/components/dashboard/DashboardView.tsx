import { useCallback, useEffect, useState } from 'react';
import { useRevalidator } from 'react-router';
import { ArrowClockwise, CircleNotch } from 'phosphor-react';
import { OnboardingModal } from '~/components/onboarding/OnboardingModal';
import { Button } from '~/components/ui/button';
import { KpiTile } from '~/components/ui/kpi-tile';
import { CompactHeader } from '~/components/ui/page-header';
import { useAuth } from '~/providers/AuthProvider';
import type { DashboardData } from '~/types/dashboard';
import { CashPanel } from './CashPanel';
import { CustomersPanel } from './CustomersPanel';
import { OrdersPanel } from './OrdersPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { ProductsPanel } from './ProductsPanel';
import { RevenuePanel } from './RevenuePanel';
import { StatusPanel } from './StatusPanel';
import { int, money, pct, share } from './format';

interface DashboardViewProps {
  data: DashboardData;
}

/**
 * Full-width command-centre layout. The first screen answers "how are we doing?" on its own:
 * six headline numbers (two with trends), then the revenue chart beside the order breakdown.
 * Everything else is a dense panel grid below, read in the order the questions come:
 * what sells, how it is paid, where the cash is, what just happened, who buys.
 */
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
  const accounts = data.bankAccounts.length;

  // Last twelve months, oldest first, for the tile sparklines.
  const recent = data.revenueByMonth.slice(-12);

  return (
    <div className="pb-10">
      <OnboardingModal open={showOnboarding} onComplete={handleOnboardingComplete} />

      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow={`${businessName} · All time`}
        title={
          <>
            Where the business <em>stands today.</em>
          </>
        }
        description={
          hasSales
            ? `${money(kpis.grossRevenue, currency)} sold across ${int(kpis.totalOrders)} orders, with ${money(kpis.totalBankBalance, currency)} in the bank.`
            : 'No orders yet. Connect a store and the numbers appear here.'
        }
        actions={
          <>
            <span className="font-mono text-xs tracking-[0.04em] text-muted-foreground">
              {refreshing
                ? 'REFRESHING…'
                : `UPDATED ${lastUpdated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`}
            </span>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? (
                <CircleNotch size={14} weight="light" className="animate-spin" aria-hidden />
              ) : (
                <ArrowClockwise size={14} weight="light" aria-hidden />
              )}
              Refresh
            </Button>
          </>
        }
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label="Gross revenue"
            value={money(kpis.grossRevenue, currency)}
            caption={`${int(kpis.totalOrders)} orders`}
            trend={recent.map(m => m.revenue)}
          />
          <KpiTile
            label="Net revenue"
            value={money(kpis.netRevenue, currency)}
            caption="After fees and refunds"
          />
          <KpiTile
            label="Orders"
            value={int(kpis.totalOrders)}
            caption={`Avg ${money(kpis.avgOrderValue, currency, 2)}`}
            trend={recent.map(m => m.orderCount)}
          />
          <KpiTile
            label="Customers"
            value={int(kpis.totalCustomers)}
            caption={`${pct(customerStats.repeatRate)} repeat`}
          />
          <KpiTile
            label="In the bank"
            value={money(kpis.totalBankBalance, currency)}
            caption={`${accounts} ${accounts === 1 ? 'account' : 'accounts'}`}
            tone={kpis.totalBankBalance < 0 ? 'negative' : 'default'}
          />
          <KpiTile
            label="Processing fees"
            value={money(kpis.processingFees, currency)}
            caption={`${pct(share(kpis.processingFees, kpis.grossRevenue), 1)} of revenue`}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
          <RevenuePanel months={data.revenueByMonth} currency={currency} />
          <StatusPanel statuses={data.ordersByStatus} totalOrders={kpis.totalOrders} />

          <ProductsPanel
            products={data.topProducts}
            grossRevenue={kpis.grossRevenue}
            currency={currency}
          />
          <PaymentsPanel payments={data.paymentMethods} currency={currency} />
          <CashPanel accounts={data.bankAccounts} currency={currency} />

          <OrdersPanel orders={data.recentOrders} currency={currency} />
          <CustomersPanel
            customers={data.topCustomers}
            stats={customerStats}
            kpis={kpis}
            currency={currency}
          />
        </div>
      </div>
    </div>
  );
}
