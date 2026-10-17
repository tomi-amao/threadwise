import { ArrowLeft, ArrowRight } from 'phosphor-react';
import { Button } from './button';

const int = (n: number) => new Intl.NumberFormat('en-GB').format(n);

/**
 * "1–50 OF 1,200" with Previous and Next, for a list that is paged on the client. Renders
 * nothing when everything fits on one page.
 */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3"
    >
      <span className="font-mono text-xs tracking-[0.04em] text-muted-foreground">
        {int(from)}–{int(to)} OF {int(total)}
      </span>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ArrowLeft size={14} weight="light" aria-hidden /> Previous
        </Button>
        <span className="font-mono text-[13px] text-text-2">
          {page} / {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next <ArrowRight size={14} weight="light" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
