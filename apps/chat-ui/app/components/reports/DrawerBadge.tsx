import type React from 'react';

export function DrawerBadge({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'emerald' | 'blue' | 'amber';
}) {
  const className =
    tone === 'emerald'
      ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
      : tone === 'blue'
        ? 'bg-blue-500/10 text-blue-500 border-blue-500/20'
        : tone === 'amber'
          ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
          : 'bg-muted text-muted-foreground border-border';

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}
    >
      {children}
    </span>
  );
}
