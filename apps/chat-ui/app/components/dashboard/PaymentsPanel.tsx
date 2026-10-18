import { ShareChart } from '~/components/charts';
import { Panel } from '~/components/ui/panel';
import type { PaymentMethodBreakdown } from '~/types/dashboard';
import { money, paymentName } from './format';

export function PaymentsPanel({
  payments,
  currency,
}: {
  payments: PaymentMethodBreakdown[];
  currency: string;
}) {
  const captured = payments.reduce((s, p) => s + p.totalAmount, 0);
  return (
    <Panel
      testId="panel-payments"
      className="xl:col-span-3"
      title="Payment methods"
      note="Captured, not charged."
    >
      <div className="mb-3 font-serif text-[30px] tabular-nums">{money(captured, currency)}</div>
      <ShareChart
        stacked
        height={150}
        ariaLabel="Payment methods"
        format={v => money(v, currency)}
        data={payments.map(p => ({
          id: `${p.gateway}|${p.method}`,
          label: paymentName(p.gateway, p.method),
          value: p.totalAmount,
        }))}
      />
    </Panel>
  );
}
