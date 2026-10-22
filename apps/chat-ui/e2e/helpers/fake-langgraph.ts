/**
 * A stand-in for the LangGraph API, answered inside the browser with `page.route`.
 *
 * The assistant panel talks to the LangGraph server directly (`useStream`), so its tests mock
 * that server's HTTP API: threads (create, search, get, update, delete), state and history,
 * and runs streamed as server-sent events. It keeps threads and a checkpoint tree the way the
 * real server does (an empty checkpoint at creation, one after the input, one after the
 * answer), so edit-and-resend and regenerate fork from the same parents they would in
 * production. Like the real server it refuses a request without a user token.
 *
 * Each question the test sends is answered from a `Plan` keyed by its exact text: tool
 * steps (with their results and the cards built from them), the answer, follow-up chips, an
 * optional clarifying question to pause on, a delay, or a failure. The cards come from the
 * UI contract's own examples, so they are what the backend would really send.
 */

import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';

export const AGENT_ORIGIN = 'http://127.0.0.1:8098';

const contract = JSON.parse(
  readFileSync(new URL('../../app/components/assistant/ui-contract.json', import.meta.url), 'utf8')
) as { examples: Record<string, Record<string, unknown>[]> };

/** The contract's example props for a component, e.g. `example('summary-list', 0)`. */
export function example(name: string, index = 0): Record<string, unknown> {
  const found = contract.examples[name]?.[index];
  if (!found) throw new Error(`no contract example ${name}#${index}`);
  return found;
}

export interface Step {
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  /** Cards pushed for this step's result. */
  ui?: { name: string; props: Record<string, unknown> }[];
  progress?: string;
}

export interface Plan {
  steps?: Step[];
  /** One answer, or several used in turn (for "answer again"). */
  answer: string | string[];
  followUps?: { label: string; prompt: string }[];
  /** Pause on a clarifying question; `then` runs after the user answers. */
  clarify?: { question: string; options: string[]; then: Plan };
  /**
   * Pause on a proposed change. Nothing happens (`effects` stays empty) until the user
   * approves; `approved` or `declined` then runs. `saves` is a memory kept on approval.
   */
  proposal?: {
    tool: string;
    args?: Record<string, unknown>;
    payload: Record<string, unknown>;
    approved: Plan;
    declined: Plan;
    saves?: string;
  };
  /** Hold the response this long (for the loading state and Stop). */
  delayMs?: number;
  /**
   * The run fails inside the agent: the server streams an `error` event, as the real one does.
   * Give the error's name and message to look like a provider failure.
   */
  fail?: boolean | { error: string; message: string };
  /** The server refuses the run with HTTP 429, as the rate limit does. */
  rateLimited?: boolean;
}

type Msg = Record<string, unknown> & { id: string; type: string };
type Ui = {
  type: 'ui';
  id: string;
  name: string;
  props: unknown;
  metadata: Record<string, unknown>;
};

interface Snapshot {
  checkpoint_id: string;
  parent: string | null;
  values: { messages: Msg[]; ui: Ui[] };
  next: string[];
  tasks: unknown[];
  created_at: string;
}

interface FakeThread {
  thread_id: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  snapshots: Snapshot[];
  head: string;
  /** The plan to continue with when a clarifying question is answered. */
  pending?: {
    plan: Plan;
    callId: string;
    tool: string;
    proposal?: { approved: Plan; declined: Plan; saves?: string };
  };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

const CORS = {
  'access-control-allow-origin': '*',
  // `*` does not cover Authorization, so it is named.
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

let counter = 0;
const nextId = (prefix: string) =>
  `${prefix}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date(Date.now() + counter).toISOString();

function textOf(message: Msg | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (typeof b === 'object' && b ? String(b.text ?? '') : '')).join('');
  }
  return '';
}

function state(thread: FakeThread, snapshot: Snapshot | undefined) {
  const checkpoint = (id: string) => ({
    thread_id: thread.thread_id,
    checkpoint_ns: '',
    checkpoint_id: id,
    checkpoint_map: null,
  });
  return {
    values: snapshot?.values ?? {},
    next: snapshot?.next ?? [],
    tasks: snapshot?.tasks ?? [],
    checkpoint: snapshot ? checkpoint(snapshot.checkpoint_id) : null,
    parent_checkpoint: snapshot?.parent ? checkpoint(snapshot.parent) : null,
    metadata: { step: thread.snapshots.indexOf(snapshot as Snapshot) - 1 },
    created_at: snapshot?.created_at ?? thread.created_at,
  };
}

function asThread(thread: FakeThread) {
  const head = thread.snapshots.find(s => s.checkpoint_id === thread.head);
  return {
    thread_id: thread.thread_id,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    metadata: thread.metadata,
    status: head?.next.length ? 'interrupted' : 'idle',
    values: head?.values ?? {},
    interrupts: {},
  };
}

function sse(events: [string, unknown][]): string {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

export interface FakeAgent {
  calls: Call[];
  /** Changes the stand-in agent has made: one entry per approved proposal, never before. */
  effects: string[];
  /** What the assistant remembers (the store behind the Memory view). */
  memories: Map<string, string>;
  threads: Map<string, FakeThread>;
  /** Replace the plan for a question (e.g. make a failed one succeed on retry). */
  setPlan: (question: string, plan: Plan) => void;
  /** The run requests the browser made, in order. */
  runs: () => Call[];
}

const DEFAULT_PLAN: Plan = { answer: 'I can answer from your own records.' };

export async function mockAgent(page: Page, plans: Record<string, Plan> = {}): Promise<FakeAgent> {
  const calls: Call[] = [];
  const effects: string[] = [];
  const memories = new Map<string, string>();
  const threads = new Map<string, FakeThread>();
  const runCounts = new Map<string, number>();
  const table = { ...plans };

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  function runPlan(
    thread: FakeThread,
    base: Snapshot,
    question: string,
    plan: Plan,
    prefix: Msg[]
  ): { events: [string, unknown][]; final: Snapshot } {
    const messages: Msg[] = [...base.values.messages, ...prefix];
    const ui: Ui[] = [...base.values.ui];
    const events: [string, unknown][] = [];
    for (const step of plan.steps ?? []) {
      const callId = nextId('call');
      const ai: Msg = {
        id: nextId('ai'),
        type: 'ai',
        content: '',
        tool_calls: [{ id: callId, name: step.name, args: step.args ?? {}, type: 'tool_call' }],
      };
      messages.push(ai, {
        id: nextId('tool'),
        type: 'tool',
        name: step.name,
        tool_call_id: callId,
        content: JSON.stringify(step.result ?? {}),
        status: 'success',
      });
      if (step.progress) events.push(['custom', { progress: step.progress }]);
      (step.ui ?? []).forEach((card, i) => {
        const message: Ui = {
          type: 'ui',
          id: `${callId}-${i}`,
          name: card.name,
          props: card.props,
          metadata: { message_id: ai.id, catalogue: 1, tool: step.name },
        };
        ui.push(message);
        events.push(['custom', message]);
      });
    }

    const parent = base.checkpoint_id;
    if (plan.proposal) {
      const callId = nextId('call');
      messages.push({
        id: nextId('ai'),
        type: 'ai',
        content: '',
        tool_calls: [
          {
            id: callId,
            name: plan.proposal.tool,
            args: plan.proposal.args ?? {},
            type: 'tool_call',
          },
        ],
      });
      const value = { kind: 'proposal', ...plan.proposal.payload };
      const interruptId = nextId('interrupt');
      const final: Snapshot = {
        checkpoint_id: nextId('cp'),
        parent,
        values: { messages, ui },
        next: ['tools'],
        tasks: [{ id: nextId('task'), name: 'tools', interrupts: [{ value, id: interruptId }] }],
        created_at: now(),
      };
      thread.pending = {
        plan: plan.proposal.approved,
        callId,
        tool: plan.proposal.tool,
        proposal: plan.proposal,
      };
      events.push(['values', { ...final.values, __interrupt__: [{ value, id: interruptId }] }]);
      return { events, final };
    }
    if (plan.clarify) {
      const callId = nextId('call');
      messages.push({
        id: nextId('ai'),
        type: 'ai',
        content: '',
        tool_calls: [
          {
            id: callId,
            name: 'ask_user',
            args: { question: plan.clarify.question, options: plan.clarify.options },
            type: 'tool_call',
          },
        ],
      });
      const value = {
        kind: 'clarify',
        question: plan.clarify.question,
        options: plan.clarify.options.map(label => ({ label })),
      };
      const interruptId = nextId('interrupt');
      const final: Snapshot = {
        checkpoint_id: nextId('cp'),
        parent,
        values: { messages, ui },
        next: ['tools'],
        tasks: [{ id: nextId('task'), name: 'tools', interrupts: [{ value, id: interruptId }] }],
        created_at: now(),
      };
      thread.pending = { plan: plan.clarify.then, callId, tool: 'ask_user' };
      events.push(['values', { ...final.values, __interrupt__: [{ value, id: interruptId }] }]);
      return { events, final };
    }

    const answers = Array.isArray(plan.answer) ? plan.answer : [plan.answer];
    const count = runCounts.get(question) ?? 0;
    runCounts.set(question, count + 1);
    const answer: Msg = {
      id: nextId('ai'),
      type: 'ai',
      content: answers[Math.min(count, answers.length - 1)],
    };
    messages.push(answer);
    if (plan.followUps) {
      const message: Ui = {
        type: 'ui',
        id: `follow-ups-${answer.id}`,
        name: 'follow-ups',
        props: { items: plan.followUps },
        metadata: { message_id: answer.id, catalogue: 1 },
      };
      ui.push(message);
      events.push(['custom', message]);
    }
    const final: Snapshot = {
      checkpoint_id: nextId('cp'),
      parent,
      values: { messages, ui },
      next: [],
      tasks: [],
      created_at: now(),
    };
    thread.pending = undefined;
    events.push(['values', final.values]);
    return { events, final };
  }

  await page.route(
    url => url.origin === AGENT_ORIGIN,
    async route => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const url = new URL(request.url());
      const path = url.pathname;
      let body: Record<string, unknown> = {};
      try {
        body = (request.postDataJSON() as Record<string, unknown>) ?? {};
      } catch {
        // no body
      }
      calls.push({ method: request.method(), path, body });
      // The real server refuses anyone who is not signed in: so does this stand-in.
      if (!/^Bearer \S+/.test(request.headers()['authorization'] ?? '')) {
        return json(route, { detail: 'Missing bearer token' }, 401);
      }

      if (path === '/threads' && request.method() === 'POST') {
        const created = now();
        const initial: Snapshot = {
          checkpoint_id: nextId('cp'),
          parent: null,
          values: { messages: [], ui: [] },
          next: [],
          tasks: [],
          created_at: created,
        };
        const thread: FakeThread = {
          thread_id: nextId('thread'),
          created_at: created,
          updated_at: created,
          metadata: (body.metadata as Record<string, unknown>) ?? {},
          snapshots: [initial],
          head: initial.checkpoint_id,
        };
        threads.set(thread.thread_id, thread);
        return json(route, asThread(thread));
      }
      if (path === '/threads/search') {
        const list = [...threads.values()]
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .map(asThread);
        return json(route, list);
      }

      // The store behind the Memory view (the real server scopes it to the user).
      if (path === '/store/items/search') {
        const items = [...memories].map(([key, fact], i) => ({
          namespace: ['user', 'memories'],
          key,
          value: { fact, saved_at: `2026-10-0${(i % 9) + 1}T00:00:00Z` },
          created_at: now(),
          updated_at: now(),
        }));
        return json(route, { items });
      }
      if (path === '/store/items' && request.method() === 'DELETE') {
        memories.delete(String(body.key));
        return route.fulfill({ status: 204, headers: CORS });
      }

      const match = /^\/threads\/([^/]+)(\/.*)?$/.exec(path);
      const thread = match ? threads.get(match[1]) : undefined;
      if (!match || !thread) return json(route, { detail: 'Thread not found' }, 404);
      const rest = match[2] ?? '';

      if (rest === '' && request.method() === 'GET') return json(route, asThread(thread));
      if (rest === '' && request.method() === 'PATCH') {
        thread.metadata = { ...thread.metadata, ...((body.metadata as object) ?? {}) };
        thread.updated_at = now();
        return json(route, asThread(thread));
      }
      if (rest === '' && request.method() === 'DELETE') {
        threads.delete(thread.thread_id);
        return route.fulfill({ status: 204, headers: CORS });
      }
      if (rest === '/state' && request.method() === 'GET') {
        return json(
          route,
          state(
            thread,
            thread.snapshots.find(s => s.checkpoint_id === thread.head)
          )
        );
      }
      if (rest === '/history') {
        const limit = Number(body.limit ?? 10);
        const newest = [...thread.snapshots].reverse().slice(0, limit);
        return json(
          route,
          newest.map(s => state(thread, s))
        );
      }
      if (/^\/runs\/[^/]+\/cancel$/.test(rest))
        return route.fulfill({ status: 204, headers: CORS });

      if (rest === '/runs/stream') {
        const checkpointId = (body.checkpoint as { checkpoint_id?: string } | undefined)
          ?.checkpoint_id;
        const base =
          thread.snapshots.find(s => s.checkpoint_id === (checkpointId ?? thread.head)) ??
          thread.snapshots[0];
        const input = body.input as { messages?: Msg[] } | null | undefined;
        const resume = (
          body.command as { resume?: { answer?: string; decision?: string } } | undefined
        )?.resume;

        let plan: Plan;
        let question: string;
        let prefix: Msg[] = [];
        let afterInput: Snapshot = base;
        if (resume && thread.pending?.proposal) {
          const { approved, declined, saves } = thread.pending.proposal;
          const approve = resume.decision === 'approve';
          plan = approve ? approved : declined;
          question = `resume:${resume.decision}`;
          if (approve) {
            effects.push(thread.pending.tool);
            if (saves) memories.set(nextId('memory'), saves);
          }
          prefix = [
            {
              id: nextId('tool'),
              type: 'tool',
              name: thread.pending.tool,
              tool_call_id: thread.pending.callId,
              content: JSON.stringify(
                approve ? { done: true } : { done: false, declined: true, note: 'Declined.' }
              ),
              status: 'success',
            },
          ];
        } else if (resume && thread.pending) {
          plan = thread.pending.plan;
          question = `resume:${resume.answer}`;
          prefix = [
            {
              id: nextId('tool'),
              type: 'tool',
              name: 'ask_user',
              tool_call_id: thread.pending.callId,
              content: `The user answered: ${resume.answer}`,
              status: 'success',
            },
          ];
        } else {
          const human = input?.messages?.at(-1);
          question = human
            ? textOf(human)
            : textOf([...base.values.messages].reverse().find(m => m.type === 'human'));
          plan = table[question] ?? DEFAULT_PLAN;
          if (human) {
            // A checkpoint after the input, as the real server makes: the question is first
            // seen here, so editing it forks from this checkpoint's parent.
            afterInput = {
              checkpoint_id: nextId('cp'),
              parent: base.checkpoint_id,
              values: { messages: [...base.values.messages, human], ui: base.values.ui },
              next: ['model'],
              tasks: [],
              created_at: now(),
            };
            thread.snapshots.push(afterInput);
          }
        }

        if (plan.rateLimited) {
          return route
            .fulfill({
              status: 429,
              headers: { ...CORS, 'content-type': 'application/json', 'retry-after': '30' },
              body: JSON.stringify({ detail: 'You are asking too fast. Try again in 30 seconds.' }),
            })
            .catch(() => undefined);
        }
        if (plan.delayMs) await new Promise(resolve => setTimeout(resolve, plan.delayMs));
        if (plan.fail) {
          return route
            .fulfill({
              status: 200,
              headers: { ...CORS, 'content-type': 'text/event-stream' },
              body: sse([
                ['metadata', { run_id: nextId('run'), attempt: 1 }],
                ['values', afterInput.values],
                [
                  'error',
                  typeof plan.fail === 'object'
                    ? plan.fail
                    : { error: 'ModelError', message: 'The model did not answer.' },
                ],
              ]),
            })
            .catch(() => undefined);
        }

        const runId = nextId('run');
        const { events, final } = runPlan(thread, afterInput, question, plan, prefix);
        thread.snapshots.push(final);
        thread.head = final.checkpoint_id;
        thread.updated_at = now();
        const stream = sse([
          ['metadata', { run_id: runId, attempt: 1 }],
          ['values', afterInput.values],
          ...events,
        ]);
        // The browser may have stopped waiting (Stop): fulfilling an aborted request throws.
        return route
          .fulfill({
            status: 200,
            headers: {
              ...CORS,
              'content-type': 'text/event-stream',
              'content-location': `/threads/${thread.thread_id}/runs/${runId}`,
            },
            body: stream,
          })
          .catch(() => undefined);
      }

      return json(route, { detail: `not mocked: ${request.method()} ${path}` }, 404);
    }
  );

  return {
    calls,
    effects,
    memories,
    threads,
    setPlan: (question, plan) => {
      table[question] = plan;
    },
    runs: () => calls.filter(c => c.path.endsWith('/runs/stream')),
  };
}
