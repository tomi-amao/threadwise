import { ArrowRight } from 'phosphor-react';
import { Chip } from './chip';

export interface JumpItem {
  key: string;
  count: number;
  label: string;
  /** Brick instead of amber: a real problem rather than something to look at. */
  severe?: boolean;
  onSelect: () => void;
}

/**
 * "Jump to" shortcuts: a row of counts that each open the view they describe. They are
 * buttons, so they look like buttons: a border, an arrow, and a lift on hover. Items with a
 * zero count are left out.
 */
export function JumpTo({ items }: { items: JumpItem[] }) {
  const shown = items.filter(i => i.count > 0);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="eyebrow mr-1">Jump to</span>
      {shown.map(item => (
        <button
          key={item.key}
          type="button"
          onClick={item.onSelect}
          className="group cursor-pointer rounded-full transition-all hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chip
            tone={item.severe ? 'negative' : 'active'}
            dot
            className="border-current/40 pr-2 group-hover:border-current"
          >
            {item.count} {item.label}
            <ArrowRight
              size={12}
              weight="bold"
              aria-hidden
              className="transition-transform group-hover:translate-x-0.5"
            />
          </Chip>
        </button>
      ))}
    </div>
  );
}
