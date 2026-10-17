import React from 'react';
import { gbp } from '../collections-v2/ui';
import type { MonthPoint } from './data';

const k = (v: number) => `£${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`;

function niceMax(v: number) {
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const W = 720;
const H = 240;
const PAD = { l: 44, r: 4, t: 12, b: 28 };

/** Monthly revenue bars. The peak month is full amber; the rest sit on the lighter ramp step. */
export function RevenueBars({ data }: { data: MonthPoint[] }) {
  const peak = Math.max(...data.map(d => d.revenue));
  const max = niceMax(peak);
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const gap = data.length > 9 ? 8 : 14;
  const bw = (iw - gap * (data.length - 1)) / data.length;
  const y = (v: number) => PAD.t + (1 - v / max) * ih;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Monthly gross revenue">
      {[0, max / 2, max].map(t => (
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
            {k(t)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const x = PAD.l + i * (bw + gap);
        const h = Math.max(2, ih - (y(d.revenue) - PAD.t));
        return (
          <g key={d.month}>
            <rect
              x={x}
              y={y(d.revenue)}
              width={bw}
              height={h}
              rx="4"
              fill={d.revenue === peak ? 'var(--ramp-1)' : 'var(--ramp-3)'}
            >
              <title>{`${d.label} · ${gbp(d.revenue)} · ${d.orders} orders`}</title>
            </rect>
            <text
              x={x + bw / 2}
              y={H - 8}
              textAnchor="middle"
              fontSize="11"
              fontFamily="var(--font-mono)"
              fill="var(--text-muted)"
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
