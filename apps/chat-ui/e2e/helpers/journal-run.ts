/**
 * Stands in for everything the Generate Journals modal talks to, so a spec can walk a run
 * through its stages: the agent's REST routes (`page.route`) and Inngest's realtime socket
 * (`page.routeWebSocket`, in the wire format `TokenSubscription` parses).
 *
 * `journal-run-contract.json` holds what the agent answers with. The backend's
 * `tests/test_journal_run_contract.py` checks it against what the agent really produces, so a
 * change on either side fails rather than leaving this fake to drift.
 */

import type { Page, Route, WebSocketRoute } from '@playwright/test';
import { expect } from '../fixtures';
import contract from './journal-run-contract.json' with { type: 'json' };

export { contract };

const CORS = {
  'access-control-allow-origin': '*',
  // `*` does not cover Authorization, so it is named.
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': '*',
};

/** Nothing listens here: a socket the spec did not route fails instead of reaching Inngest. */
const DEAD_REALTIME = 'http://127.0.0.1:8097';

export interface SummaryRequest {
  entity_id: string;
  since: string;
  include_narrative?: boolean;
}

type SummaryReply = { status?: number; body: unknown };

const reply = (stats: unknown, narrative: unknown): SummaryReply => ({
  body: { entity_id: 'entity', since: contract.since, stats, narrative },
});

export const replies = {
  full: reply(contract.stats, contract.narrative),
  noNarrative: reply(contract.stats, null),
  emptyRun: reply(contract.statsOfEmptyRun, null),
  secondRun: reply(contract.stats, contract.secondNarrative),
  /** What a figures-only re-read returns once the run's draft has been posted. */
  afterPosting: reply(contract.statsAfterPostingDraft, null),
  /** A re-read in which this run's figures have not moved (an older draft was posted). */
  unchanged: reply(contract.stats, null),
  failure: { status: 500, body: { detail: 'The summary fell over' } } as SummaryReply,
};

export async function fakeJournalAgent(page: Page) {
  let socket: WebSocketRoute | undefined;
  let channel = '';
  const summaryRequests: SummaryRequest[] = [];
  const posted: string[] = [];
  let summaryReply = replies.full;
  const draft = contract.journals.find(j => j.status === 'draft')!;

  await page.routeWebSocket(/\/v1\/realtime\/connect/, ws => {
    socket = ws;
  });

  await page.route(
    url => url.port !== '5180' && /^\/(integrations|realtime|accounting)\//.test(url.pathname),
    async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      // The agent refuses anyone who is not signed in: so does this stand-in.
      if (!/^Bearer \S+/.test(request.headers()['authorization'] ?? ''))
        return json({ detail: 'Missing bearer token' }, 401);

      if (path === '/integrations/summary') return json([]);
      if (path === '/realtime/subscription-token') {
        channel = `journals:${request.postDataJSON().source_id}`;
        return json({
          channel,
          topics: ['progress', 'status'],
          token: 'fake-subscription-token',
          api_base_url: DEAD_REALTIME,
        });
      }
      if (path === '/accounting/journals/generate-all')
        return json({ entity_id: 'entity', scope: 'all', status: 'triggered', message: 'ok' });
      if (path === '/accounting/journals/run-summary') {
        summaryRequests.push(request.postDataJSON());
        return json(summaryReply.body, summaryReply.status ?? 200);
      }
      if (path === '/accounting/journals/review-summary')
        return json({
          entity_id: 'entity',
          summary: { draft_journals_total: 1, needs_review: true },
          draft_journals: [draft],
          draft_journals_by_type: { [draft.journal_type]: 1 },
        });
      if (path === '/accounting/chart-of-accounts')
        return json({ entity_id: 'entity', accounts: contract.accounts });
      if (path === '/accounting/journals/suggest-accounts')
        return json({
          suggestions: {
            [draft.id]: {
              account_id: contract.postedDraft.accountId,
              confidence: 0.9,
              reasoning: 'A software subscription.',
            },
          },
        });
      const post = /^\/accounting\/journals\/([^/]+)\/post-draft$/.exec(path);
      if (post) {
        posted.push(post[1]);
        return json({ id: post[1], status: 'posted' });
      }
      return json({});
    }
  );

  const publish = (topic: 'status' | 'progress', data: object) =>
    socket!.send(
      JSON.stringify({ kind: 'data', channel, topic, data, created_at: new Date().toISOString() })
    );

  const status = (overrides: object) => publish('status', { ...contract.status, ...overrides });

  return {
    summaryRequests,
    posted,
    answerSummaryWith: (next: SummaryReply) => {
      summaryReply = next;
    },
    /** The modal's realtime connection is up, so what is published next reaches it. */
    connected: () => expect.poll(() => socket !== undefined && channel !== '').toBe(true),
    running: (startedAt: string = contract.since) =>
      status({ status: 'running', steps_completed: 1, started_at: startedAt }),
    completed: (startedAt: string = contract.since) =>
      status({ status: 'completed', started_at: startedAt }),
    /** Inngest replays a function from the top, re-publishing what it already sent. */
    replayedRunning: (startedAt: string = contract.since) =>
      status({ status: 'running', steps_completed: 0, started_at: startedAt }),
  };
}
