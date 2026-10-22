/**
 * The rollout setting for the assistant (app/lib/assistant-flag.ts). Logic only, so no
 * browser: the server's own value is pinned to "true" in playwright.config.ts.
 */

import { test, expect } from './fixtures';
import { assistantEnabled } from '../app/lib/assistant-flag';

test.describe('assistant rollout flag', () => {
  test('is on in development and tests when nothing is set', () => {
    expect(assistantEnabled({})).toBe(true);
    expect(assistantEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(assistantEnabled({ NODE_ENV: 'test' })).toBe(true);
  });

  test('is off in production until it is switched on', () => {
    expect(assistantEnabled({ NODE_ENV: 'production' })).toBe(false);
    for (const on of ['true', 'TRUE', ' 1 ', 'on', 'yes']) {
      expect(assistantEnabled({ NODE_ENV: 'production', ASSISTANT_ENABLED: on }), on).toBe(true);
    }
  });

  test('can be switched off anywhere', () => {
    for (const off of ['false', 'FALSE', '0', 'off', ' no ']) {
      expect(assistantEnabled({ ASSISTANT_ENABLED: off }), off).toBe(false);
      expect(assistantEnabled({ NODE_ENV: 'development', ASSISTANT_ENABLED: off }), off).toBe(
        false
      );
    }
  });

  test('an empty setting means "not set", not "off"', () => {
    expect(assistantEnabled({ ASSISTANT_ENABLED: '' })).toBe(true);
    expect(assistantEnabled({ NODE_ENV: 'production', ASSISTANT_ENABLED: '  ' })).toBe(false);
  });
});
