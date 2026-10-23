/**
 * Whether the assistant is switched on. The panel is being rolled out behind a setting:
 *
 * - `ASSISTANT_ENABLED=true` (or 1, on, yes) turns it on, `false` (or 0, off, no) turns it off;
 * - with nothing set it is on in development and tests, and **off in production**, so
 *   deploying this code shows nothing new until the setting is switched on.
 *
 * Off means no launcher, no panel, no keyboard shortcut, no "Ask about this" in drawers, no
 * product insights, and `/chat` goes to the dashboard. Read on the server (a loader), so it
 * needs no rebuild: change the environment variable and restart.
 */

const OFF = new Set(['false', '0', 'off', 'no']);

export function assistantEnabled(env: Record<string, string | undefined>): boolean {
  const flag = env.ASSISTANT_ENABLED?.trim().toLowerCase();
  if (flag) return !OFF.has(flag);
  return env.NODE_ENV !== 'production';
}
