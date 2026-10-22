/**
 * Plain helpers for the conversation: message text, tool-step labels, starter prompts.
 */

import type { Message } from '@langchain/langgraph-sdk';
import { formatDate } from './format';

/** The text of a message, whatever shape its content takes. */
export function messageText(message: Message): string {
  const content = message.content as unknown;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block =>
        typeof block === 'string'
          ? block
          : block && typeof block === 'object' && (block as { type?: string }).type === 'text'
            ? String((block as { text?: unknown }).text ?? '')
            : ''
      )
      .join('');
  }
  return '';
}

export interface ToolCallLike {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export function toolCalls(message: Message): ToolCallLike[] {
  if (message.type !== 'ai') return [];
  return ((message as { tool_calls?: ToolCallLike[] }).tool_calls ?? []).filter(c => c?.name);
}

/** What a tool did, in words: "Read the ledger, 1 Apr 2026 to 31 Mar 2027". */
const STEP_LABELS: Record<string, string> = {
  get_business_profile: 'Checked the business profile',
  profit_and_loss: 'Read the ledger',
  sales_summary: 'Read orders',
  top_products: 'Ranked products',
  top_customers: 'Ranked customers',
  outstanding_invoices: 'Read unpaid invoices',
  cash_position: 'Read bank balances',
  search_transactions: 'Searched bank transactions',
  search_documents: 'Searched your documents',
  list_tables: 'Listed the data available',
  describe_tables: 'Read table columns',
  run_sql: 'Ran a custom query',
  ask_user: 'Asked you a question',
  set_invoice_status: 'Proposed an invoice change',
  categorise_transaction: 'Proposed a categorisation',
  remember: 'Offered to remember something',
  forget: 'Offered to forget something',
};

export function stepLabel(call: ToolCallLike): string {
  const base = STEP_LABELS[call.name] ?? `Used ${call.name.replace(/_/g, ' ')}`;
  const start = call.args?.start_date;
  const end = call.args?.end_date;
  if (typeof start === 'string' && typeof end === 'string') {
    return `${base}, ${formatDate(start)} to ${formatDate(end)}`;
  }
  if (typeof call.args?.text === 'string' && call.args.text) {
    return `${base} for “${call.args.text}”`;
  }
  return base;
}

/**
 * Questions to start with, depending on the page. Each is one the tools can answer (the
 * agent has no tax or VAT tool, so the Tax page starts from profit).
 */
const STARTERS: [prefix: string, prompts: string[]][] = [
  [
    '/invoices',
    ['Which invoices are overdue?', 'How much do customers owe me?', 'What do I owe suppliers?'],
  ],
  [
    '/transactions',
    [
      'What came into the bank this month?',
      'What were my largest payments out this month?',
      'How much cash do I have?',
    ],
  ],
  [
    '/reports',
    [
      'What is my profit this financial year?',
      'How does this financial year compare with last year?',
      'What were my biggest expenses this year?',
    ],
  ],
  [
    '/tax',
    ['What is my profit so far this financial year?', 'What were my biggest expenses this year?'],
  ],
  ['/orders', ['How are sales going month by month?', 'How many orders did I get last month?']],
  ['/products', ['Which products sell best?', 'Which products sold the most units this year?']],
  ['/customers', ['Who are my best customers?', 'Who spent the most this financial year?']],
];

const DEFAULT_STARTERS = [
  'How is the business doing this financial year?',
  'How much cash do I have?',
  'Which invoices are overdue?',
];

export function startersFor(pathname: string): string[] {
  return STARTERS.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? DEFAULT_STARTERS;
}

/** After this long a turn says it is taking longer than usual (and offers Stop). */
export const SLOW_AFTER_MS = 25_000;

/**
 * What to tell the user when a run fails, in plain words, and whether trying again makes
 * sense. The cause is read from the HTTP status or the provider's error name; the raw message
 * is never shown (it can quote the prompt).
 */
export function explainError(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const text = `${(error as { name?: string } | null)?.name ?? ''} ${
    (error as { message?: string } | null)?.message ?? ''
  }`;
  if (status === 429) return 'You are asking too fast. Wait a moment, then try again.';
  if (
    /RateLimit|RESOURCE_EXHAUSTED|quota|overloaded|UNAVAILABLE|DEADLINE|timeout|\b50[234]\b/i.test(
      text
    )
  ) {
    return "The assistant's AI model is busy or unavailable right now. Try again in a minute.";
  }
  return 'The assistant could not answer. Try again.';
}
