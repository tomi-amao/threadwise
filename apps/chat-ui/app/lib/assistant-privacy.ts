/**
 * What the assistant keeps and what it sends away, in one place so every screen says the same.
 *
 * Retention is set on the LangGraph server (`checkpointer.ttl` in apps/ai_agent/langgraph.json,
 * in minutes); `e2e/assistant-privacy.spec.ts` fails if that and RETENTION_DAYS disagree.
 */

export const RETENTION_DAYS = 90;

/** Who runs the model the questions go to. Set VITE_ASSISTANT_PROVIDER if the model changes. */
export const MODEL_PROVIDER: string =
  (import.meta.env?.VITE_ASSISTANT_PROVIDER as string | undefined) || 'Google (Gemini)';

export const PRIVACY_NOTE =
  `Your questions and the records needed to answer them are sent to ${MODEL_PROVIDER}, which runs ` +
  `the AI model. Conversations are kept for ${RETENTION_DAYS} days, then deleted. You can ` +
  'delete them sooner.';
