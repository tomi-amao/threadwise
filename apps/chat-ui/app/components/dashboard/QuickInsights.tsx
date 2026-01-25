import React from 'react';
import { Link } from 'react-router';
import {
  ChatCircle,
  Lightbulb,
  TrendUp,
  TrendDown,
  Sparkle,
  Users,
  ShoppingCart,
  Package,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { BarChartViz, type BarChartProps } from '~/components/visualizations/BarChartViz';

interface OrderAnalytics {
  total_orders: number;
  total_revenue: number;
  avg_order_value: number;
  top_customers: { name: string; total: number }[];
  top_products: { name: string; qty: number; revenue: number }[];
}

interface QuickInsightsProps {
  revenueByCategory: BarChartProps;
  expenseBreakdown: BarChartProps;
  orderAnalytics?: OrderAnalytics;
}

interface InsightItem {
  id: string;
  type: 'positive' | 'negative' | 'neutral';
  title: string;
  description: string;
  suggestedAction?: string;
}

function generateInsights(orderAnalytics?: OrderAnalytics): InsightItem[] {
  const insights: InsightItem[] = [];

  if (orderAnalytics) {
    if (orderAnalytics.total_orders > 0) {
      insights.push({
        id: 'orders',
        type: 'positive',
        title: `${orderAnalytics.total_orders} Orders Completed`,
        description: `Total revenue of $${orderAnalytics.total_revenue.toLocaleString()} with avg order value of $${orderAnalytics.avg_order_value.toFixed(2)}.`,
        suggestedAction: 'Show me order trends',
      });
    }

    if (orderAnalytics.top_customers.length > 0) {
      const topCustomer = orderAnalytics.top_customers[0];
      insights.push({
        id: 'customer',
        type: 'neutral',
        title: `Top Customer: ${topCustomer.name}`,
        description: `Generated $${topCustomer.total.toLocaleString()} in revenue. Consider loyalty programs.`,
        suggestedAction: 'Analyze customer segments',
      });
    }

    if (orderAnalytics.top_products.length > 0) {
      const topProduct = orderAnalytics.top_products[0];
      insights.push({
        id: 'product',
        type: 'positive',
        title: `Best Seller: ${topProduct.name}`,
        description: `Sold ${topProduct.qty} units for $${topProduct.revenue.toLocaleString()} in revenue.`,
        suggestedAction: 'Show product performance',
      });
    }
  }

  // Add some default insights if we don't have enough
  if (insights.length < 3) {
    insights.push({
      id: 'cashflow',
      type: 'neutral',
      title: 'Monitor Cash Flow',
      description: 'Regularly review your cash position to ensure operational stability.',
      suggestedAction: 'Show cash flow analysis',
    });
  }

  if (insights.length < 4) {
    insights.push({
      id: 'ar',
      type: 'neutral',
      title: 'Review Receivables',
      description: 'Check accounts receivable aging to optimize collection.',
      suggestedAction: 'Show AR aging report',
    });
  }

  return insights.slice(0, 4);
}

export function QuickInsights({
  revenueByCategory,
  expenseBreakdown,
  orderAnalytics,
}: QuickInsightsProps) {
  const insights = generateInsights(orderAnalytics);

  const getInsightIcon = (type: InsightItem['type']) => {
    switch (type) {
      case 'positive':
        return <TrendUp size={18} weight="bold" className="text-green-400" />;
      case 'negative':
        return <TrendDown size={18} weight="bold" className="text-red-400" />;
      case 'neutral':
        return <Lightbulb size={18} weight="bold" className="text-amber-400" />;
    }
  };

  const getInsightBorder = (type: InsightItem['type']) => {
    switch (type) {
      case 'positive':
        return 'border-l-green-500';
      case 'negative':
        return 'border-l-red-500';
      case 'neutral':
        return 'border-l-amber-500';
    }
  };

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(value);

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkle size={22} weight="duotone" className="text-primary" />
          <h2 className="text-lg font-semibold text-foreground">Insights & Analysis</h2>
        </div>
      </div>

      {/* Order Summary Cards */}
      {orderAnalytics && orderAnalytics.total_orders > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <ShoppingCart size={20} className="text-primary" weight="duotone" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{orderAnalytics.total_orders}</p>
              <p className="text-xs text-muted-foreground">Total Orders</p>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center">
              <TrendUp size={20} className="text-green-500" weight="duotone" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">
                {formatCurrency(orderAnalytics.total_revenue)}
              </p>
              <p className="text-xs text-muted-foreground">Order Revenue</p>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <Package size={20} className="text-amber-500" weight="duotone" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">
                {formatCurrency(orderAnalytics.avg_order_value)}
              </p>
              <p className="text-xs text-muted-foreground">Avg Order Value</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* AI Insights */}
        <div className="lg:col-span-1 space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            AI-Generated Insights
          </h3>

          <div className="space-y-3">
            {insights.map(insight => (
              <div
                key={insight.id}
                className={`rounded-lg border border-border bg-card p-4 border-l-4 ${getInsightBorder(
                  insight.type
                )}`}
              >
                <div className="flex items-start gap-3">
                  <div className="shrink-0 mt-0.5">{getInsightIcon(insight.type)}</div>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-foreground text-sm">{insight.title}</h4>
                    <p className="text-xs text-muted-foreground mt-1">{insight.description}</p>
                    {insight.suggestedAction && (
                      <Link
                        to={`/?view=chat&q=${encodeURIComponent(insight.suggestedAction)}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-2"
                      >
                        <ChatCircle size={12} />
                        {insight.suggestedAction}
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <Link to="/?view=chat">
            <Button variant="outline" size="sm" className="w-full gap-2">
              <ChatCircle size={16} />
              Ask AI for more insights
            </Button>
          </Link>
        </div>

        {/* Revenue & Expense Charts */}
        <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <BarChartViz {...revenueByCategory} />
          </div>
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <BarChartViz {...expenseBreakdown} />
          </div>
        </div>
      </div>
    </section>
  );
}
