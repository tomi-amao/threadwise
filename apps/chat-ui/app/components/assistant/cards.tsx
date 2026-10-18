/**
 * The generative UI components, one per catalogue entry, on the design kit.
 *
 * Each shows exactly the rows a tool returned, and ends with a quiet Source row: what was
 * read, for which period, and a link to the page where the figures live.
 */

import { Link } from 'react-router';
import { ArrowUpRight } from 'phosphor-react';
import { BarChart, compactMoney } from '~/components/charts';
import { DataTable } from '~/components/ui/data-table';
import { Statement } from '~/components/ui/statement';
import { cn } from '~/lib/utils';
import type { ComponentProps, ParsedUi, Source } from './catalogue';
import { formatCell, formatDate, formatMonth, isNumeric, pageName } from './format';

function Frame({
  title,
  source,
  children,
  className,
}: {
  title: string;
  source: Source;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn('min-w-0 rounded-2xl border bg-card px-4 pb-3 pt-4', className)}
    >
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-3">{children}</div>
      <SourceRow source={source} />
    </section>
  );
}

/** "Source · Posted journals · 1 Apr 2026 to 31 Mar 2027 · Open in Reports" */
export function SourceRow({ source }: { source: Source }) {
  const when = source.period
    ? `${formatDate(source.period.start)} to ${formatDate(source.period.end)}`
    : source.as_of
      ? `as of ${formatDate(source.as_of)}`
      : null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2.5 text-xs text-muted-foreground">
      <span className="font-mono uppercase tracking-[0.08em]">Source</span>
      <span>{source.label}</span>
      {when && <span>· {when}</span>}
      {source.link && (
        <Link
          to={source.link}
          className="inline-flex items-center gap-1 text-accent-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open in {pageName(source.link)}
          <ArrowUpRight size={12} aria-hidden />
        </Link>
      )}
    </p>
  );
}

function MetricCard({ data }: { data: ComponentProps['metric'] }) {
  const currency = data.currency ?? 'GBP';
  return (
    <Frame title={data.label} source={data.source}>
      <p className="font-serif text-3xl tabular-nums">
        {formatCell(data.value, data.format, currency)}
      </p>
      {data.details.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          {data.details.map(d => (
            <div key={d.label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{d.label}</dt>
              <dd className="tabular-nums">{formatCell(d.value, d.format, currency)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Frame>
  );
}

function BarChartCard({ data }: { data: ComponentProps['bar-chart'] }) {
  const currency = data.currency ?? 'GBP';
  const money = data.format === 'money';
  return (
    <Frame title={data.title} source={data.source}>
      <BarChart
        ariaLabel={data.title}
        height={200}
        data={data.points.map(p => ({ label: formatMonth(p.label), value: p.value }))}
        format={v => formatCell(v, data.format, currency)}
        axisFormat={v => (money ? compactMoney(v, currency) : v.toLocaleString('en-GB'))}
      />
    </Frame>
  );
}

function TableCard({ data }: { data: ComponentProps['table'] }) {
  const currency = data.currency ?? 'GBP';
  const shown = data.rows.length;
  return (
    <Frame title={data.title} source={data.source}>
      <DataTable label={data.title} dense bare className="-mx-4">
        <thead>
          <tr>
            {data.columns.map(c => (
              <th key={c.key} scope="col" className={cn(isNumeric(c.format) && 'text-right')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => {
            const link = data.row_links?.[i];
            return (
              <tr key={i}>
                {data.columns.map((c, j) => {
                  const text = formatCell(row[c.key], c.format, currency);
                  return (
                    <td
                      key={c.key}
                      className={cn(
                        'text-sm',
                        isNumeric(c.format) && 'text-right tabular-nums',
                        // Dates, figures and a record's reference read badly broken over lines;
                        // the table scrolls sideways inside itself instead.
                        (c.format !== 'text' || j === 0) && 'whitespace-nowrap'
                      )}
                    >
                      {j === 0 && link ? (
                        <Link
                          to={link}
                          className="underline decoration-dotted underline-offset-4 hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {text}
                        </Link>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </DataTable>
      {data.total_rows != null && data.total_rows > shown && (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing {shown} of {data.total_rows.toLocaleString('en-GB')}.
        </p>
      )}
    </Frame>
  );
}

function SummaryListCard({ data }: { data: ComponentProps['summary-list'] }) {
  const currency = data.currency ?? 'GBP';
  return (
    <Frame title={data.title} source={data.source}>
      {data.format === 'money' ? (
        <Statement
          currency={currency}
          digits={2}
          className="text-sm"
          rows={data.rows.map(r => ({
            kind: r.kind,
            label: r.label,
            amount: r.value,
            deduct: r.deduct,
            indent: r.indent,
          }))}
        />
      ) : (
        <dl className="text-sm">
          {data.rows.map(r => (
            <div key={r.label} className="flex justify-between gap-4 border-b py-2 last:border-0">
              <dt className="text-text-2">{r.label}</dt>
              <dd className="tabular-nums">{formatCell(r.value, data.format, currency)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Frame>
  );
}

/** One validated UI message (anything but follow-ups, which the thread places itself). */
export function AssistantCard({ ui }: { ui: ParsedUi }) {
  switch (ui.name) {
    case 'metric':
      return <MetricCard data={ui.props} />;
    case 'bar-chart':
      return <BarChartCard data={ui.props} />;
    case 'table':
      return <TableCard data={ui.props} />;
    case 'summary-list':
      return <SummaryListCard data={ui.props} />;
    default:
      return null;
  }
}
