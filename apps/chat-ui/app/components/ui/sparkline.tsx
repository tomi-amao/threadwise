import { cn } from '~/lib/utils';

/**
 * Tiny trend line for a KPI tile. Decorative (`aria-hidden`): the tile's own text carries the
 * number, so nothing is lost to a screen reader. Needs at least two points.
 */
export function Sparkline({
  data,
  width = 88,
  height = 30,
  fluid = false,
  className,
}: {
  data: number[];
  /** Drawing width. In `fluid` mode this is only the coordinate space, not the rendered size. */
  width?: number;
  height?: number;
  /** Stretch to the container's width (no end dot, since it would distort). */
  fluid?: boolean;
  className?: string;
}) {
  if (data.length < 2) return null;
  const pad = 3;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (data.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const path = data
    .map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');
  const last = data.length - 1;

  return (
    <svg
      aria-hidden
      width={fluid ? '100%' : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={fluid ? 'none' : undefined}
      className={cn('overflow-visible', fluid ? 'block w-full' : 'shrink-0', className)}
    >
      <path
        d={path}
        fill="none"
        stroke="var(--ramp-1)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {!fluid && <circle cx={x(last)} cy={y(data[last])} r={2.5} fill="var(--ramp-1)" />}
    </svg>
  );
}
