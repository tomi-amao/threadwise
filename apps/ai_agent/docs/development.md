# Development

## Setup

Python 3.13 (`.python-version`) and Poetry. **Run Poetry from `apps/ai_agent`**, not the repo
root.

```bash
make setup            # from the repo root: pnpm workspace + poetry install
# or, here:
poetry install
```

Configuration is read from the environment and `apps/ai_agent/.env` (a variable set in the real
environment wins). The root `.env.example` lists the names.

For the chat agent and the tests that use data, start the local Supabase stack and seed it (needs
Docker and the Supabase CLI), from the repo root:

```bash
pnpm db:start         # local Supabase, applies supabase/migrations
pnpm db:fresh         # reset, seed two businesses, write the seed manifest
```

## Running

| Command (from `apps/ai_agent` unless noted)                                | What runs                                                                                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:all` (repo root)                                                 | Frontend, `langgraph dev` (:2024) and the Inngest dev server in one mprocs window. Use this for chat, realtime and background jobs. |
| `poetry run langgraph dev`                                                 | The LangGraph server: chat agent plus the REST API on :2024                                                                         |
| `poetry run uvicorn ai_agent.main:app --reload --host 0.0.0.0 --port 8000` | The REST API and `/api/inngest` only (no chat agent)                                                                                |

The REST API's OpenAPI page is `/docs` on either port. Every route needs a user token or the
internal key (see [security.md](security.md)).

## Configuration

`core/config.py` (`pydantic_settings`). Unknown variables are ignored.

| Setting                                                                             | Purpose                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                                      | Direct Postgres for the agent's user-scoped SQL. Must be able to `SET ROLE authenticated` (`postgres` on Supabase). Local: `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| `SUPABASE_URL`, `SUPABASE_KEY`                                                      | PostgREST with the service key (bypasses RLS; see [architecture.md](architecture.md#two-database-paths-do-not-mix-them-up))                                                          |
| `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`                                          | Token verification; the secret only for legacy HS256 projects                                                                                                                        |
| `GOOGLE_API_KEY`                                                                    | Gemini, the default chat and extraction models                                                                                                                                       |
| `AGENT_MODEL`, `AGENT_FALLBACK_MODEL`, `AGENT_SMALL_MODEL`                          | The chat agent's models ([chat-agent.md](chat-agent.md#models))                                                                                                                      |
| `DEFAULT_CHAT_MODEL`                                                                | Invoice extraction and account suggestions                                                                                                                                           |
| `LOCAL_LLM_BASE_URL`, `DEFAULT_MODEL`                                               | An OpenAI-compatible local server (LM Studio); development only                                                                                                                      |
| `PINECONE_API_KEY`                                                                  | Document embeddings and search                                                                                                                                                       |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_DEV`                           | Background jobs; never set `INNGEST_DEV` in production                                                                                                                               |
| `INTERNAL_API_KEY`                                                                  | `X-Internal-Key` for machine-only routes; unset means they are closed                                                                                                                |
| `CORS_ALLOW_ORIGINS`                                                                | Comma-separated app origins (both the REST API and the LangGraph API; `langgraph.json` must not set `http.cors`, which would override it)                                            |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`, `ZOHO_ACCOUNTS_DOMAIN` | ThreadWise's Zoho OAuth app                                                                                                                                                          |
| `FRONTEND_URL`                                                                      | Where the OAuth callback sends the browser back to                                                                                                                                   |
| `LANGSMITH_API_KEY`                                                                 | Tracing                                                                                                                                                                              |

## Tests

```bash
poetry run pytest                                   # everything
poetry run pytest tests/test_chat_agent.py -v       # one file
poetry run pytest -k cash_position                  # by name
```

| File                                               | Covers                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `test_auth.py`                                     | Token verification and the LangGraph auth handler                                                       |
| `test_api_auth.py`                                 | Every REST route has a guard and refuses anonymous callers                                              |
| `test_scoped_sql.py`                               | The SQL checker (30 refused statements) and RLS-scoped execution                                        |
| `test_chat_agent.py`                               | The chat agent end to end with a scripted model; every tool against the seed manifest                   |
| `test_actions.py`                                  | Page context, actions that wait for approval (two against the real endpoint), memory, the store handler |
| `test_ui_contract.py`                              | The generative UI catalogue, presenters and the contract file                                           |
| `test_limits.py`                                   | The per-turn token cap and the turn log                                                                 |
| `test_evals.py`                                    | The eval scorer, the golden set, that the harness can fail, and the review queue                        |
| `test_invoice_rules.py`, `test_invoice_service.py` | Invoice lifecycle and processing                                                                        |
| `test_normalization.py`                            | Provider normalisers                                                                                    |

Tests that need the local database and seed (`test_scoped_sql.py`, `test_chat_agent.py`,
`test_actions.py`, `test_evals.py`) skip those cases when it is not running, which is why the normal
backend CI job (no database) skips them. `.github/workflows/backend-data.yml` starts the local
stack, seeds it, and runs them plus the oracle evals on every relevant PR. Point the tests elsewhere
with `TEST_DATABASE_URL`.

Run the golden-set evals with `poetry run python -m ai_agent.evals` (see [evals.md](evals.md)).

Assert figures from the seed manifest (`apps/chat-ui/e2e/.seed-manifest.json`, written by
`pnpm db:fresh`), not from numbers you work out by hand.

Known failure: `TestSquarespaceNormalizer::test_normalize_profile` fails on `main` and is not yet
fixed.

## Lint, types and CI

CI (`.github/workflows/ci.yml`) runs these on `apps/ai_agent`; the commit hook runs them on changed
files:

```bash
poetry run black --check src/ tests/
poetry run isort --check-only src/ tests/
poetry run flake8 src/ tests/ --max-line-length=90     # 90, not the .flake8 default
poetry run mypy src/
poetry run bandit -r src/ -ll
```

The existing code has a backlog (black would reformat many old files and mypy reports a few
hundred errors). New and changed files are held to all five; do not fix the backlog as a side
effect of other work.

## Troubleshooting

- **401 from every request.** Send `Authorization: Bearer <Supabase access token>`; for machine
  routes, `X-Internal-Key`.
- **403 "No business set up yet".** The user has no `entities` row with `owner_user_id` = their id.
- **The agent says it has no data, or tests skip.** Is `DATABASE_URL` the local stack, and has
  `pnpm db:fresh` run? A value in `.env` pointing at the hosted project is overridden only by the
  real environment.
- **`BlockingError` under `langgraph dev`.** A synchronous call in async code; wrap it in
  `asyncio.to_thread`.
- **Import error loading `auth.py`.** It is loaded by path; use absolute imports.
- **`API key required for Gemini`** when importing. Something built a model at import time; build
  models lazily (see `agents/chat_graph.py`).
- Docker files here are experimental and not part of the workflow.
