/**
 * The generative UI catalogue: what the agent can show, mirrored from the backend.
 *
 * The props are defined once in Python (`apps/ai_agent/src/ai_agent/ui/catalogue.py`) and
 * mirrored here as Zod schemas. Both sides validate. `ui-contract.json` (generated from the
 * Python models) is checked against these schemas by `e2e/assistant-contract.spec.ts`, so a
 * change on one side without the other fails a test.
 *
 * A UI message that names an unknown component, carries a newer catalogue version, or fails
 * validation renders nothing (and logs), so a bad message can never break the thread.
 */

import { z } from 'zod';

export const CATALOGUE_VERSION = 1;

export const format = z.enum(['money', 'number', 'percent', 'date', 'text']);
export type Format = z.infer<typeof format>;

/** A path inside the app. Links come from tool results; they never leave the app. */
const internalLink = z.string().regex(/^\/(?!\/)/, 'links must be paths inside the app');

const period = z.strictObject({ start: z.string(), end: z.string() });

export const source = z.strictObject({
  tool: z.string(),
  label: z.string(),
  period: period.nullish(),
  as_of: z.string().nullish(),
  link: internalLink.nullish(),
});
export type Source = z.infer<typeof source>;

const metricDetail = z.strictObject({
  label: z.string(),
  value: z.number(),
  format: format.default('number'),
});

export const metric = z.strictObject({
  label: z.string(),
  value: z.number(),
  format: format.default('money'),
  currency: z.string().nullish(),
  details: z.array(metricDetail).max(4).default([]),
  source,
});

const barPoint = z.strictObject({ label: z.string(), value: z.number() });

export const barChart = z.strictObject({
  title: z.string(),
  format: format.default('money'),
  currency: z.string().nullish(),
  points: z.array(barPoint).min(1).max(60),
  source,
});

const column = z.strictObject({
  key: z.string(),
  label: z.string(),
  format: format.default('text'),
});

export const cell = z.union([z.string(), z.number(), z.null()]);
export type Cell = z.infer<typeof cell>;

export const table = z
  .strictObject({
    title: z.string(),
    columns: z.array(column).min(1).max(8),
    rows: z.array(z.record(z.string(), cell)).max(50),
    row_links: z.array(internalLink.nullable()).nullish(),
    total_rows: z.number().int().nullish(),
    currency: z.string().nullish(),
    source,
  })
  .superRefine((t, ctx) => {
    const keys = new Set(t.columns.map(c => c.key));
    t.rows.forEach((row, i) => {
      for (const key of Object.keys(row)) {
        if (!keys.has(key)) ctx.addIssue({ code: 'custom', message: `row ${i}: no column ${key}` });
      }
    });
    if (t.row_links && t.row_links.length !== t.rows.length) {
      ctx.addIssue({ code: 'custom', message: 'row_links must have one entry per row' });
    }
  });

const summaryRow = z.strictObject({
  label: z.string(),
  value: z.number(),
  kind: z.enum(['line', 'total', 'grand']).default('line'),
  deduct: z.boolean().default(false),
  indent: z.boolean().default(false),
});

export const summaryList = z.strictObject({
  title: z.string(),
  currency: z.string().nullish(),
  format: format.default('money'),
  rows: z.array(summaryRow).min(1).max(20),
  source,
});

const followUp = z.strictObject({
  label: z.string().min(1).max(60),
  prompt: z.string().min(1).max(300),
});

export const followUps = z.strictObject({ items: z.array(followUp).min(2).max(4) });

const clarifyOption = z.strictObject({ label: z.string().min(1).max(60) });

export const clarify = z.strictObject({
  kind: z.literal('clarify').default('clarify'),
  question: z.string().min(1).max(200),
  options: z.array(clarifyOption).min(2).max(4),
});

const change = z.strictObject({
  label: z.string().max(60),
  before: z.string().max(120).nullish(),
  after: z.string().max(120),
});

/** A change the agent proposes; it only happens if the user approves (the run is paused). */
export const proposal = z.strictObject({
  kind: z.literal('proposal').default('proposal'),
  action: z.string().max(40),
  title: z.string().min(1).max(120),
  description: z.string().max(300).nullish(),
  changes: z.array(change).min(1).max(6),
  link: internalLink.nullish(),
  approve_label: z.string().max(30).default('Approve'),
  dismiss_label: z.string().max(30).default('Dismiss'),
});

/** name -> props schema, for every component the agent can push. */
export const COMPONENTS = {
  metric,
  'bar-chart': barChart,
  table,
  'summary-list': summaryList,
  'follow-ups': followUps,
} as const;

/** kind -> payload schema, for every interrupt the browser can answer. */
export const INTERRUPTS = { clarify, proposal } as const;

export type ComponentName = keyof typeof COMPONENTS;
export type ComponentProps = { [K in ComponentName]: z.infer<(typeof COMPONENTS)[K]> };
export type Clarify = z.infer<typeof clarify>;
export type Proposal = z.infer<typeof proposal>;

/** A UI message the registry can render, already validated. */
export type ParsedUi = {
  [K in ComponentName]: { id: string; name: K; props: ComponentProps[K] };
}[ComponentName];

interface RawUiMessage {
  id: string;
  name: string;
  props: unknown;
  metadata?: Record<string, unknown>;
}

/** Validate one UI message; null (and a console warning) if it cannot be shown. */
export function parseUiMessage(message: RawUiMessage): ParsedUi | null {
  const version = message.metadata?.catalogue;
  if (typeof version === 'number' && version > CATALOGUE_VERSION) {
    console.warn(`UI message ${message.id}: catalogue v${version} is newer than this app`);
    return null;
  }
  const schema = COMPONENTS[message.name as ComponentName];
  if (!schema) {
    console.warn(`UI message ${message.id}: unknown component "${message.name}"`);
    return null;
  }
  const parsed = schema.safeParse(message.props);
  if (!parsed.success) {
    console.warn(`UI message ${message.id} (${message.name}): invalid props`, parsed.error.issues);
    return null;
  }
  return { id: message.id, name: message.name, props: parsed.data } as ParsedUi;
}

/** Validate a proposal payload; null if the browser cannot show it (so it is never approved blind). */
export function parseProposal(value: unknown): Proposal | null {
  const parsed = proposal.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Validate an interrupt payload; null if the browser cannot answer it. */
export function parseClarify(value: unknown): Clarify | null {
  const parsed = clarify.safeParse(value);
  return parsed.success ? parsed.data : null;
}
