# Operating the assistant

What to set, what it costs, what is written down, and how to roll it out. The behaviour is in
[chat-agent.md](chat-agent.md); how it is checked is in [evals.md](evals.md).

## Rollout: the panel behind a setting

The frontend reads `ASSISTANT_ENABLED` on the server (`apps/chat-ui/app/lib/assistant-flag.ts`):

| Setting                   | Result                                             |
| ------------------------- | -------------------------------------------------- |
| `true`, `1`, `on`, `yes`  | On                                                 |
| `false`, `0`, `off`, `no` | Off                                                |
| not set                   | On in development and tests, **off in production** |

Off means no launcher, no panel, no Ctrl/Cmd+J, no "Ask about this" in drawers, no product
insights, and `/chat` goes to the dashboard. It needs a restart, not a rebuild. So deploying this
code shows nothing new until `ASSISTANT_ENABLED=true` is set in production.

## Settings (backend, `core/config.py`)

| Setting                     | Default                              | What it does                                                                                                                                                                                |
| --------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_MODEL`               | `google_genai:gemini-2.5-flash`      | The loop                                                                                                                                                                                    |
| `AGENT_FALLBACK_MODEL`      | `google_genai:gemini-3.5-flash`      | When the main model fails (the other family: separate quota)                                                                                                                                |
| `AGENT_SMALL_MODEL`         | `google_genai:gemini-2.5-flash-lite` | Summaries and follow-ups                                                                                                                                                                    |
| `ASSISTANT_RUNS_PER_WINDOW` | 30                                   | How many runs one user may start in the window                                                                                                                                              |
| `ASSISTANT_RATE_WINDOW_S`   | 600                                  | The window, in seconds                                                                                                                                                                      |
| `ASSISTANT_TURN_TOKEN_CAP`  | 150,000                              | Model tokens one question may use before it stops                                                                                                                                           |
| `TRACE_HASH_SALT`           | unset (a development key)            | Key for the hashed ids in traces and metadata. **Set it in production** and never change it casually: it also names each thread's owner, so changing it makes existing threads unreachable. |

The models were chosen by measurement, not by name: on 2026-10-22 the 3.5 models took 18-22 s per
question and 20-34 s for the follow-up step; the 2.5 models took 6-9 s and about 1 s. Re-measure
when changing them (`poetry run python -m ai_agent.evals --model <id>`). A one-tool question uses
about 7,000 to 10,000 tokens.

## Limits and cost

- **Per turn**: at most 12 model calls and 20 tool calls (`ModelCallLimit`, `ToolCallLimit`), and
  a token cap (`TurnBudgetMiddleware`). The token cap is checked before the next model call, never
  after one that asked for tools, so a stopped turn never leaves a tool call without its result.
  The user is told it needed more than one go and to ask something narrower.
- **Per user**: `ASSISTANT_RUNS_PER_WINDOW` runs per `ASSISTANT_RATE_WINDOW_S`, enforced in
  `auth.py`'s `threads.create_run` handler (an approval or a clarifying answer is a run too). Over
  it the server answers HTTP 429 with `Retry-After`, and the panel says "You are asking too fast".
  The count is **per server process**: with several servers a user could get that many times the
  limit. It protects the model bill and the quota, not security (tenancy never depends on it);
  move the counts to the database or Redis if that starts to matter.
- **Model clients retry once** (`chat_agent.CLIENT_MAX_RETRIES`), with a 90 s timeout. A provider
  quota error is not cured by retrying, and the default (six retries backing off to 16 s) held a
  turn up for minutes while the fallback model sat idle.
- **Slow turns**: after 25 s the panel says "This is taking longer than usual" and offers Stop.
  A follow-up step that takes over 12 s is dropped (no chips, never bad ones).

## Observability

Three layers, all free of questions, answers and figures by design:

1. **The turn log.** One structured line per turn from `TurnLogMiddleware`, logger
   `ai_agent.turns`: `assistant_turn {...}` with the business (hashed), seconds, model calls, tool
   calls by name, tool errors, tokens, and how it ended (`answered` or `guarded`). One
   `assistant_model_error {...}` per model failure, with the exception **type** only (a provider's
   message can quote the prompt). Over budget logs `assistant_turn_over_budget`. This is the
   latency, cost and error dashboard:

   ```bash
   # turns, total tokens and slowest turn per business, from the server's log
   grep -h 'assistant_turn {' app.log | sed 's/.*assistant_turn //' | jq -s \
     'group_by(.business) | map({business: .[0].business, turns: length,
       tokens: (map(.tokens) | add), slowest: (map(.seconds) | max)})'
   ```

2. **Hashed ids.** Thread and run metadata carry `owner` and `entity_hash`, both HMAC-SHA256 of the
   real id (`core/tracing.py`), so a trace can be grouped by business and a thread filtered to its
   owner, but no raw user or business id is in any trace. `thread_id` is added by LangGraph.
3. **LangSmith, when switched on.** Tracing is the standard LangSmith environment
   (`LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`). A trace holds the
   question, the tool results and the answer, so **it is business data leaving for another
   provider**. Leave it off in production unless that is agreed; if on, set
   `LANGSMITH_HIDE_INPUTS=true` and `LANGSMITH_HIDE_OUTPUTS=true` unless the team needs the
   content to review a conversation.

## Privacy and retention

- Conversations are kept **90 days**, then deleted: `checkpointer.ttl` in `langgraph.json`
  (129,600 minutes, swept hourly). The panel says so, and a test fails if the figure on screen and
  the figure in the config disagree.
- The panel's Conversations view has **Delete all conversations** (with a confirmation), and each
  conversation can be deleted on its own.
- What the assistant remembers is kept until the user deletes it (Memory view), separately from
  conversations.
- A question and the records needed to answer it are sent to the model provider (Google, Gemini).
  The panel says so in an empty conversation and under Conversations. Change
  `VITE_ASSISTANT_PROVIDER` if the model's provider changes.
- **Ratings** are rows of ids (`assistant_feedback`), kept until the user takes the rating back or
  the business is deleted.

## When things go wrong

| What the user sees                                  | Why, and what to look at                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "You are asking too fast"                           | The per-user limit (HTTP 429). Raise `ASSISTANT_RUNS_PER_WINDOW`.                                                                                                 |
| "The AI model is busy or unavailable"               | The provider refused or timed out (quota, overload). The log has `assistant_model_error` with the type. Check the key's quota; the fallback model is tried first. |
| "That question needed more than I can work through" | The token cap. Look at `assistant_turn_over_budget`.                                                                                                              |
| "This is taking longer than usual"                  | A slow model or slow tool. `assistant_turn` shows which.                                                                                                          |
| Figures that look old, or "no data yet"             | The prompt names each connected source and when it last synced (or that none is connected) and the assistant says so, pointing to Integrations.                   |
| No follow-up chips                                  | The follow-up step failed or timed out (logged); never a bad chip.                                                                                                |
