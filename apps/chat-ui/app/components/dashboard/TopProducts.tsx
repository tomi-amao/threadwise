import { Link } from 'react-router';
import { ArrowSquareOut, Package } from 'phosphor-react';
import type { ProductPerformance } from '~/types/dashboard';

interface TopProductsProps {
  products: ProductPerformance[];
  currency?: string;
}

const formatCurrency = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

export function TopProducts({ products, currency = 'GBP' }: TopProductsProps) {
  const maxRevenue = products.length > 0 ? products[0].totalRevenue : 1;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Top Products</h3>
          <p className="text-xs text-muted-foreground mt-0.5">By revenue</p>
        </div>
        <Link
          to="/products"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
        >
          View all <ArrowSquareOut size={12} />
        </Link>
      </div>

      {products.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground text-sm">No product data</div>
      ) : (
        <div className="space-y-3">
          {products.slice(0, 8).map((product, i) => (
            <div key={product.id || product.name} className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground w-5 text-right font-medium">
                {i + 1}
              </span>
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Package size={14} className="text-primary" weight="duotone" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{product.name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary/60 rounded-full transition-all"
                      style={{ width: `${(product.totalRevenue / maxRevenue) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {product.totalQuantity} sold
                  </span>
                </div>
              </div>
              <span className="text-sm font-semibold text-foreground whitespace-nowrap">
                {formatCurrency(product.totalRevenue, currency)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
