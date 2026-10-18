import { Moon, Sun } from 'phosphor-react';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/ThemeProvider';

/** Light/Dark switch. Light is the default; the choice is stored in a cookie. */
export function ThemeToggle({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const item = (value: 'light' | 'dark', Icon: typeof Sun, label: string) => (
    <button
      type="button"
      aria-pressed={theme === value}
      aria-label={compact ? label : undefined}
      onClick={() => setTheme(value)}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        theme === value ? 'bg-foreground text-background' : 'text-text-2 hover:text-foreground'
      )}
    >
      <Icon size={14} weight="light" aria-hidden />
      {!compact && label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Theme"
      className={cn(
        'inline-flex gap-0.5 rounded-full border border-border-strong bg-card p-[3px]',
        className
      )}
    >
      {item('light', Sun, 'Light')}
      {item('dark', Moon, 'Dark')}
    </div>
  );
}
