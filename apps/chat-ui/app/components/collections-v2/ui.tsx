import React, { useEffect } from 'react';
import { X } from 'phosphor-react';
import type { Status } from './data';

export const gbp = (n: number, digits = 0) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);

export const int = (n: number) => new Intl.NumberFormat('en-GB').format(Math.round(n));

export const pct = (n: number | null, digits = 1) => (n == null ? '—' : `${n.toFixed(digits)}%`);

export function fmtDate(value: string | null, short = false) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(short ? {} : { year: 'numeric' }),
  });
}

export function Eyebrow({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`cv2-eyebrow ${className}`}>{children}</div>;
}

export function StatusChip({ status }: { status: Status }) {
  return <span className={`cv2-chip cv2-chip-${status}`}>{status}</span>;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="cv2-seg" role="group" aria-label={label}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="cv2-field">
      <span className="cv2-eyebrow">{label}</span>
      {children}
      {hint && (
        <span style={{ fontSize: 13 }} className="cv2-muted">
          {hint}
        </span>
      )}
    </label>
  );
}

export function Meter({ value, over = false }: { value: number; over?: boolean }) {
  return (
    <div className={`cv2-meter ${over ? 'cv2-meter-over' : ''}`} aria-hidden>
      <span style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Sparkline({
  data,
  width = 96,
  height = 28,
}: {
  data: number[];
  width?: number;
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <span className="cv2-muted cv2-mono" style={{ fontSize: 12 }}>
        —
      </span>
    );
  }
  const max = Math.max(...data);
  const step = width / (data.length - 1);
  const d = data
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`
    )
    .join(' ');
  return (
    <svg
      className="cv2-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

export function Drawer({
  title,
  eyebrow,
  onClose,
  children,
  footer,
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="cv2-overlay" onClick={onClose} aria-hidden />
      <aside className="cv2-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="cv2-between" style={{ padding: '24px 28px 8px' }}>
          <div>
            <Eyebrow>{eyebrow}</Eyebrow>
            <h2 className="cv2-h3" style={{ marginTop: 6 }}>
              {title}
            </h2>
          </div>
          <button type="button" className="cv2-icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} weight="light" />
          </button>
        </div>
        <div className="cv2-drawer-body">{children}</div>
        <div className="cv2-drawer-foot">{footer}</div>
      </aside>
    </>
  );
}

/** Ramp colours for category / share visuals, amber first then plum. */
export const RAMP = [
  'var(--ramp-1)',
  'var(--ramp-2)',
  'var(--ramp-3)',
  'var(--ramp-4)',
  'var(--plum)',
  'var(--ramp-5)',
];
