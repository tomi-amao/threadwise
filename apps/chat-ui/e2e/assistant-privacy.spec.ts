/**
 * Retention is promised in the UI (lib/assistant-privacy.ts) and enforced by the LangGraph
 * server's checkpointer TTL (apps/ai_agent/langgraph.json). They must say the same thing.
 */

import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import { PRIVACY_NOTE, RETENTION_DAYS } from '../app/lib/assistant-privacy';

test('the retention promised on screen is the retention the server enforces', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../ai_agent/langgraph.json', import.meta.url), 'utf8')
  ) as { checkpointer: { ttl: { strategy: string; default_ttl: number } } };
  expect(config.checkpointer.ttl.strategy).toBe('delete');
  expect(config.checkpointer.ttl.default_ttl).toBe(RETENTION_DAYS * 24 * 60); // minutes
});

test('the privacy note says what is sent, to whom, and for how long', () => {
  expect(PRIVACY_NOTE).toContain('sent to');
  expect(PRIVACY_NOTE).toContain(`${RETENTION_DAYS} days`);
});
