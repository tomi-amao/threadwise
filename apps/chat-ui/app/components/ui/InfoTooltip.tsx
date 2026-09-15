import { Info } from 'phosphor-react';

interface InfoTooltipProps {
  text: string;
}

/**
 * Info icon that shows a descriptive tooltip on hover.
 * Used to explain how financial metrics are calculated.
 */
export function InfoTooltip({ text }: InfoTooltipProps) {
  return (
    <span className="relative group/tip inline-flex items-center ml-1.5">
      <Info
        size={14}
        className="text-muted-foreground/50 hover:text-muted-foreground cursor-help transition-colors"
        weight="regular"
      />
      <span
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2
          bg-popover text-popover-foreground text-xs rounded-lg border border-border shadow-lg
          opacity-0 invisible group-hover/tip:opacity-100 group-hover/tip:visible
          transition-all duration-150 pointer-events-none w-64 z-50 leading-relaxed
          text-left font-normal"
      >
        {text}
      </span>
    </span>
  );
}
