import { CHART_COLORS } from '~/components/charts';
import { Panel, PanelLink } from '~/components/ui/panel';
import type { OrderStatusBreakdown } from '~/types/dashboard';
import { int, pct, share, titleCase } from './format';

export function StatusPanel({
  statuses,
  totalOrders,
}: {
  statuses: OrderStatusBreakdown[];
  totalOrders: number;
}) {
  const color = (i: number) => CHART_COLORS[i % CHART_COLORS.length];
  return (
    <Panel
      testId="panel-status"
      className="xl:col-span-4"
      title="Orders by status"
      note={totalOrders > 0 ? `${int(totalOrders)} orders in total.` : undefined}
      action={<PanelLink to="/orders">All orders</PanelLink>}
    >
      {statuses.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No orders yet.</p>
      ) : (
        <>
          <div
            className="mb-4 mt-1 flex h-3 gap-0.5 overflow-hidden rounded-full bg-border"
            aria-hidden
          >
            {statuses.map((s, i) => (
              <span
                key={s.status}
                title={`${titleCase(s.status)}: ${s.count}`}
                className="h-full min-w-[3px]"
                style={{ flexGrow: s.count, background: color(i) }}
              />
            ))}
          </div>
          <dl className="divide-y">
            {statuses.map((s, i) => (
              <div key={s.status} className="flex items-center justify-between gap-4 py-2">
                <dt className="flex items-center gap-2.5 text-text-2">
                  <span
                    aria-hidden
                    className="size-2 rounded-sm"
                    style={{ background: color(i) }}
                  />
                  {titleCase(s.status)}
                </dt>
                <dd className="tabular-nums">
                  {int(s.count)}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {pct(share(s.count, totalOrders))}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Panel>
  );
}
