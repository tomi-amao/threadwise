import { Link } from 'react-router';
import {
  CurrencyGbp,
  ShoppingCart,
  Users,
  Wallet,
  TrendUp,
  TrendDown,
  ArrowSquareOut,
  Receipt,
  ArrowsClockwise,
} from 'phosphor-react';
import type { KPIData } from '~/types/dashboard';

interface KPICardsProps {
  kpis: KPIData;
  currency?: string;
}

const formatCurrency = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

const formatNumber = (value: number) =>
  new Intl.NumberFormat('en-GB').format(value);

interface CardDef {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  iconBg: string;
  link?: string;
}

export function KPICards({ kpis, currency = 'GBP' }: KPICardsProps) {
  const cards: CardDef[] = [
    {
      title: 'Gross Revenue',
      value: formatCurrency(kpis.grossRevenue, currency),
      subtitle: `${formatNumber(kpis.totalOrders)} orders`,
      icon: <CurrencyGbp size={22} weight="duotone" />,
      iconBg: 'bg-emerald-500/10 text-emerald-500',
      link: '/orders',
    },
    {
      title: 'Net Revenue',
      value: formatCurrency(kpis.netRevenue, currency),
      subtitle: 'After fees & refunds',
      icon: <TrendUp size={22} weight="duotone" />,
      iconBg: 'bg-blue-500/10 text-blue-500',
    },
    {
      title: 'Total Orders',
      value: formatNumber(kpis.totalOrders),
      subtitle: `Avg ${formatCurrency(kpis.avgOrderValue, currency)}`,
      icon: <ShoppingCart size={22} weight="duotone" />,
      iconBg: 'bg-violet-500/10 text-violet-500',
      link: '/orders',
    },
    {
      title: 'Customers',
      value: formatNumber(kpis.totalCustomers),
      icon: <Users size={22} weight="duotone" />,
      iconBg: 'bg-amber-500/10 text-amber-500',
      link: '/customers',
    },
    {
      title: 'Bank Balance',
      value: formatCurrency(kpis.totalBankBalance, currency),
      icon: <Wallet size={22} weight="duotone" />,
      iconBg: 'bg-cyan-500/10 text-cyan-500',
    },
    {
      title: 'Processing Fees',
      value: formatCurrency(kpis.processingFees, currency),
      subtitle: kpis.grossRevenue > 0
        ? `${((kpis.processingFees / kpis.grossRevenue) * 100).toFixed(1)}% of revenue`
        : undefined,
      icon: <Receipt size={22} weight="duotone" />,
      iconBg: 'bg-rose-500/10 text-rose-500',
    },
  ];

  return (
    <section>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {cards.map((card) => {
          const content = (
            <div
              key={card.title}
              className="rounded-xl border border-border bg-card p-5 hover:border-primary/30 transition-all group"
            >
              <div className="flex items-start justify-between mb-3">
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center ${card.iconBg}`}
                >
                  {card.icon}
                </div>
                {card.link && (
                  <ArrowSquareOut
                    size={16}
                    className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                )}
              </div>
              <p className="text-sm text-muted-foreground mb-1">{card.title}</p>
              <p className="text-2xl font-bold text-foreground tracking-tight">
                {card.value}
              </p>
              {card.subtitle && (
                <p className="text-xs text-muted-foreground mt-1">{card.subtitle}</p>
              )}
            </div>
          );

          return card.link ? (
            <Link key={card.title} to={card.link} className="block">
              {content}
            </Link>
          ) : (
            <div key={card.title}>{content}</div>
          );
        })}
      </div>
    </section>
  );
}
