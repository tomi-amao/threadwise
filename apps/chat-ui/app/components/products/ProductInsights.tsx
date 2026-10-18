/**
 * ProductInsights
 *
 * Three questions to put to the AI agent about one product: its pricing, demand, and some
 * marketing copy. Each sends a prompt built from the product's own numbers to the LangGraph
 * server (the same one the chat uses) as the signed-in user, and shows the reply in place.
 * The server refuses a request without the user's token, so these go through `agentFetch`.
 * Nothing is stored here.
 */

import { useState } from 'react';
import { ChartLineUp, CircleNotch, Megaphone, Sparkle, TrendUp } from 'phosphor-react';
import { Eyebrow } from '~/components/ui/eyebrow';
import { agentFetch } from '~/lib/api/agent-auth';
import type { ProductDetail } from '~/lib/api/products.server';
import { cn } from '~/lib/utils';
import { money } from './model';

interface Sales {
  revenue: number;
  units: number;
}

interface Insight {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  prompt: (p: ProductDetail, s: Sales) => string;
}

const variantLabel = (v: ProductDetail['variants'][number]) =>
  Object.values(v.attributes).join('/') || v.sku || 'default';

const INSIGHTS: Insight[] = [
  {
    id: 'pricing',
    label: 'Pricing analysis',
    description: 'Is it priced right, given how it sells?',
    icon: <ChartLineUp size={18} weight="light" aria-hidden />,
    prompt: (p, s) =>
      `Analyze the pricing strategy for "${p.name}". It has ${p.variants.length} variant(s) with prices: ${p.variants.map(v => `${variantLabel(v)}: ${v.price != null ? `£${v.price}` : 'N/A'}`).join(', ')}. Total revenue: ${money(s.revenue, 'GBP', 2)}, units sold: ${s.units}. Suggest pricing optimizations, competitive positioning, and potential margin improvements. Be concise and actionable.`,
  },
  {
    id: 'demand',
    label: 'Demand forecast',
    description: 'What is likely to happen next?',
    icon: <TrendUp size={18} weight="light" aria-hidden />,
    prompt: (p, s) =>
      `Forecast demand for "${p.name}". Current data: ${s.units} units sold generating ${money(s.revenue, 'GBP', 2)} revenue across ${p.variants.length} variant(s). Product type: ${p.product_type || 'general'}. Provider: ${p.provider || 'unknown'}. Based on this, predict demand trends, identify seasonality, and recommend inventory stocking levels. Be concise.`,
  },
  {
    id: 'marketing',
    label: 'Marketing copy',
    description: 'A description and three captions',
    icon: <Megaphone size={18} weight="light" aria-hidden />,
    prompt: p =>
      `Write a compelling product description and three variations of marketing copy for "${p.name}". Product type: ${p.product_type || 'general'}. Variants: ${p.variants.map(variantLabel).join(', ')}. ${p.description ? `Current description: "${p.description}".` : ''} Provide a main description plus three short social-media-ready captions. Be creative and brand-aware.`,
  },
];

const apiUrl = () => import.meta.env?.VITE_LANGGRAPH_API_URL || 'http://localhost:2024';
const assistantId = () =>
  import.meta.env?.VITE_LANGGRAPH_ASSISTANT_ID || 'threadwise-financial-agent';

async function ask(prompt: string): Promise<string> {
  const base = apiUrl();
  const thread = await agentFetch(`${base}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!thread.ok) throw new Error('The assistant is not reachable. Is the agent running?');
  const { thread_id } = (await thread.json()) as { thread_id: string };

  const run = await agentFetch(`${base}/threads/${thread_id}/runs/wait`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assistant_id: assistantId(),
      input: { messages: [{ role: 'user', content: prompt }] },
    }),
  });
  if (!run.ok) throw new Error('The assistant could not answer that. Try again.');
  const data = (await run.json()) as {
    messages?: { type?: string; role?: string; content?: unknown; text?: string }[];
    values?: { messages?: { type?: string; role?: string; content?: unknown; text?: string }[] };
  };
  const messages = data.messages ?? data.values?.messages ?? [];
  const last = [...messages].reverse().find(m => m.type === 'ai' || m.role === 'assistant');
  const content = last?.content ?? last?.text;
  // Some models answer in blocks ([{ type: 'text', text }]) rather than a plain string.
  const text = Array.isArray(content)
    ? content.map(b => (typeof b === 'string' ? b : ((b as { text?: string }).text ?? ''))).join('')
    : content;
  return typeof text === 'string' && text.trim() ? text : 'No response was generated.';
}

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; text: string }
  | { status: 'error'; message: string };

export function ProductInsights({ product, sales }: { product: ProductDetail; sales: Sales }) {
  const [state, setState] = useState<Record<string, State>>({});

  const run = async (insight: Insight) => {
    const current = state[insight.id];
    if (current?.status === 'loading') return;
    // A second press hides the answer.
    if (current?.status === 'done') {
      setState(s => ({ ...s, [insight.id]: { status: 'idle' } }));
      return;
    }
    setState(s => ({ ...s, [insight.id]: { status: 'loading' } }));
    try {
      const text = await ask(insight.prompt(product, sales));
      setState(s => ({ ...s, [insight.id]: { status: 'done', text } }));
    } catch (error) {
      setState(s => ({
        ...s,
        [insight.id]: {
          status: 'error',
          message: error instanceof Error ? error.message : 'Something went wrong',
        },
      }));
    }
  };

  return (
    <section aria-label="Insights" className="space-y-3 border-t pt-5">
      <Eyebrow>Ask the assistant</Eyebrow>
      <ul className="space-y-2">
        {INSIGHTS.map(insight => {
          const s = state[insight.id] ?? { status: 'idle' as const };
          return (
            <li key={insight.id} className="space-y-2">
              <button
                type="button"
                onClick={() => run(insight)}
                disabled={s.status === 'loading'}
                aria-expanded={s.status === 'done'}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors',
                  'hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70'
                )}
              >
                <span className="shrink-0 text-accent-text">
                  {s.status === 'loading' ? (
                    <CircleNotch size={18} className="animate-spin" aria-hidden />
                  ) : (
                    insight.icon
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px]">{insight.label}</span>
                  <span className="block text-[13px] text-text-2">{insight.description}</span>
                </span>
                <Sparkle
                  size={14}
                  aria-hidden
                  className="shrink-0 text-muted-foreground transition-colors group-hover:text-accent-text"
                />
              </button>
              {s.status === 'error' && (
                <p
                  role="alert"
                  className="rounded-xl bg-destructive/10 px-3.5 py-2.5 text-[14px] text-destructive"
                >
                  {s.message}
                </p>
              )}
              {s.status === 'done' && (
                <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border bg-card px-3.5 py-3 text-[14px] leading-relaxed">
                  {s.text}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
