import React from 'react';
import { gbp } from '../collections-v2/ui';

const k = (v: number) =>
  `${v < 0 ? '−' : ''}£${Math.abs(v) >= 1000 ? `${Math.round(Math.abs(v) / 1000)}k` : Math.abs(v)}`;

/** Round the axis maximum up to a friendly step so gridlines land on clean values. */
function niceMax(v: number) {
  if (v <= 0) return 1000;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const W = 720;
const H = 240;
const PAD = { l: 44, r: 8, t: 12, b: 28 };

export interface TrendPoint {
  label: string;
  sales: number;
  income: number;
}

/** Two-series line chart: total sales (amber) against net income (plum). */
export function TrendChart({ data }: { data: TrendPoint[] }) {
  const max = niceMax(Math.max(...data.map(d => Math.max(d.sales, d.income))));
  const min = Math.min(0, ...data.map(d => d.income));
  const minNice = min < 0 ? -niceMax(-min) : 0;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => PAD.t + (1 - (v - minNice) / (max - minNice)) * ih;
  const path = (f: (d: TrendPoint) => number) =>
    data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(f(d)).toFixed(1)}`).join(' ');
  const ticks = [minNice, ...[1, 2, 3].map(i => minNice + ((max - minNice) * i) / 3), max].filter(
    (v, i, a) => a.indexOf(v) === i
  );
  const step = Math.ceil(data.length / 8);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="Total sales and net income by month"
    >
      {ticks.map(t => (
        <g key={t}>
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--border)"
            strokeDasharray={t === 0 ? undefined : '2 4'}
          />
          <text
            x={PAD.l - 8}
            y={y(t) + 4}
            textAnchor="end"
            fontSize="11"
            fontFamily="var(--font-mono)"
            fill="var(--text-muted)"
          >
            {k(Math.round(t))}
          </text>
        </g>
      ))}
      <path
        d={path(d => d.sales)}
        fill="none"
        stroke="var(--ramp-1)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d={path(d => d.income)}
        fill="none"
        stroke="var(--plum)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {data.map((d, i) => (
        <g key={d.label}>
          <circle
            cx={x(i)}
            cy={y(d.sales)}
            r="3.5"
            fill="var(--surface)"
            stroke="var(--ramp-1)"
            strokeWidth="2"
          >
            <title>{`${d.label} · Total sales ${gbp(d.sales)}`}</title>
          </circle>
          <circle
            cx={x(i)}
            cy={y(d.income)}
            r="3.5"
            fill="var(--surface)"
            stroke="var(--plum)"
            strokeWidth="2"
          >
            <title>{`${d.label} · Net income ${gbp(d.income)}`}</title>
          </circle>
          {i % step === 0 && (
            <text
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              fontSize="11"
              fontFamily="var(--font-mono)"
              fill="var(--text-muted)"
            >
              {d.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

export interface CashPoint {
  label: string;
  operating: number;
  partial: boolean;
}

/** Monthly operating cash as bars from a zero line. The current month is shown lighter. */
export function CashBars({ data }: { data: CashPoint[] }) {
  const maxAbs = niceMax(Math.max(...data.map(d => Math.abs(d.operating))));
  const hasNeg = data.some(d => d.operating < 0);
  const lo = hasNeg ? -maxAbs : 0;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + (1 - (v - lo) / (maxAbs - lo)) * ih;
  const gap = 10;
  const bw = (iw - gap * (data.length - 1)) / data.length;
  const ticks = hasNeg ? [-maxAbs, 0, maxAbs] : [0, maxAbs / 2, maxAbs];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Operating cash by month">
      {ticks.map(t => (
        <g key={t}>
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--border)"
            strokeDasharray={t === 0 ? undefined : '2 4'}
          />
          <text
            x={PAD.l - 8}
            y={y(t) + 4}
            textAnchor="end"
            fontSize="11"
            fontFamily="var(--font-mono)"
            fill="var(--text-muted)"
          >
            {k(Math.round(t))}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const x0 = PAD.l + i * (bw + gap);
        const top = y(Math.max(d.operating, 0));
        const h = Math.max(2, Math.abs(y(d.operating) - y(0)));
        return (
          <g key={d.label} opacity={d.partial ? 0.45 : 1}>
            <rect
              x={x0}
              y={d.operating >= 0 ? top : y(0)}
              width={bw}
              height={h}
              rx="3"
              fill={d.operating >= 0 ? 'var(--ramp-1)' : 'var(--plum)'}
            >
              <title>{`${d.label}${d.partial ? ' (in progress)' : ''} · ${gbp(d.operating)}`}</title>
            </rect>
            <text
              x={x0 + bw / 2}
              y={H - 8}
              textAnchor="middle"
              fontSize="11"
              fontFamily="var(--font-mono)"
              fill="var(--text-muted)"
            >
              {d.label.split(' ')[0]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
