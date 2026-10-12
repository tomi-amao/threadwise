/**
 * Shared AI Agent API base URL resolution.
 *
 * Isomorphic: works from both client components (import.meta.env) and
 * server-only modules (process.env). Do not rename this file to
 * `*.server.ts` — client components import it directly.
 */
export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return import.meta.env?.VITE_AI_AGENT_URL || 'http://localhost:2024';
  }
  return process.env.AI_AGENT_URL || process.env.VITE_AI_AGENT_URL || 'http://localhost:2024';
}
