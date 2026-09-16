import { ResponsivePie } from '@nivo/pie';
import type { PaymentMethodBreakdown } from '~/types/dashboard';

interface PaymentBreakdownProps {
  data: PaymentMethodBreakdown[];
  currency?: string;
}

const formatCurrency = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

const COLORS = [
  'hsl(221, 83%, 53%)', // blue
  'hsl(262, 83%, 58%)', // violet
  'hsl(142, 71%, 45%)', // green
  'hsl(38, 92%, 50%)',  // amber
  'hsl(0, 84%, 60%)',   // red
  'hsl(199, 89%, 48%)', // cyan
  'hsl(330, 81%, 60%)', // pink
];

function formatLabel(gateway: string, method: string): string {
  const g = gateway.charAt(0).toUpperCase() + gateway.slice(1);
  if (method === 'Unknown' || method === gateway) return g;
  const m = method.charAt(0).toUpperCase() + method.slice(1);
  return `${g} (${m})`;
}

export function PaymentBreakdown({ data, currency = 'GBP' }: PaymentBreakdownProps) {
  const pieData = data.map((d, i) => ({
    id: formatLabel(d.gateway, d.method),
    label: formatLabel(d.gateway, d.method),
    value: d.totalAmount,
    color: COLORS[i % COLORS.length],
  }));

  const total = data.reduce((sum, d) => sum + d.totalAmount, 0);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-foreground">Payment Methods</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {formatCurrency(total, currency)} captured
        </p>
      </div>

      {pieData.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground text-sm">No payment data</div>
      ) : (
        <>
          <div className="h-[200px] w-full">
            <ResponsivePie
              data={pieData}
              margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
              innerRadius={0.6}
              padAngle={1.5}
              cornerRadius={4}
              activeOuterRadiusOffset={4}
              colors={{ datum: 'data.color' }}
              borderWidth={0}
              enableArcLinkLabels={false}
              enableArcLabels={false}
              tooltip={({ datum }) => (
                <div className="bg-popover text-popover-foreground border border-border rounded-lg px-3 py-2 shadow-lg text-xs">
                  <p className="font-medium">{datum.label}</p>
                  <p style={{ color: datum.color }} className="font-semibold">
                    {formatCurrency(datum.value, currency)}
                  </p>
                </div>
              )}
            />
          </div>
          <div className="mt-3 space-y-2">
            {pieData.map((d) => (
              <div key={d.id} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <div
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: d.color }}
                  />
                  <span className="text-muted-foreground">{d.label}</span>
                </div>
                <span className="font-medium text-foreground">
                  {formatCurrency(d.value, currency)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
