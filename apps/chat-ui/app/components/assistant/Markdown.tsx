/**
 * The assistant's text. Markdown with tables (GFM); no raw HTML is rendered, so text from the
 * model (or data it quotes) cannot inject markup. Links inside the app stay in the app (the
 * panel stays open); anything else opens in a new tab.
 */

import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router';

const components: Components = {
  a: ({ href, children }) =>
    href && href.startsWith('/') && !href.startsWith('//') ? (
      <Link to={href} className="font-medium text-accent-text underline underline-offset-4">
        {children}
      </Link>
    ) : (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-accent-text underline underline-offset-4"
      >
        {children}
      </a>
    ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  h1: ({ children }) => <p className="mb-2 mt-3 font-semibold">{children}</p>,
  h2: ({ children }) => <p className="mb-2 mt-3 font-semibold">{children}</p>,
  h3: ({ children }) => <p className="mb-1 mt-3 font-semibold">{children}</p>,
  code: ({ children }) => (
    <code className="rounded bg-card px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border bg-card p-3 text-xs">{children}</pre>
  ),
  table: ({ children }) => (
    // Scrolls inside itself (and can be scrolled from the keyboard) instead of widening the panel.
    <div role="region" aria-label="Table" tabIndex={0} className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="whitespace-nowrap border-b px-2 py-1.5 text-left font-mono text-xs uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b px-2 py-1.5 tabular-nums">{children}</td>,
};

function MarkdownImpl({ children }: { children: string }) {
  return (
    <div className="text-[15px] leading-relaxed text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
