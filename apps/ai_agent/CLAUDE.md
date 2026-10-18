# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`apps/ai_agent` is the Python/FastAPI backend of ThreadWise, a conversational AI
platform that replaces dashboards with a chat interface for business intelligence
and accounting. It lives in a pnpm/Poetry hybrid monorepo — the frontend
(`apps/chat-ui`, React Router 7) is a sibling directory and out of scope here
unless a task explicitly touches it.

This service does three distinct jobs:

1. **Chat agent** — a LangGraph StateGraph that answers analytics questions
   (SQL), generic questions, and extracts structured data from uploaded documents.
2. **ETL / normalization pipeline** — pulls transactions from external providers
   (Shopify, Revolut, PayPal, Squarespace) via Inngest, normalizes them into a
   canonical schema, and persists them to Supabase/Postgres. Zoho Calendar is
   the one provider that also goes the other way — see "OAuth providers" below.
3. **Accounting engine** — turns normalized payments/transactions/invoices into
   double-entry journals against a chart of accounts.

## Commands

All commands run from `apps/ai_agent/` (Poetry is _not_ usable from the repo root).

```bash
# Install deps
poetry install

# Run the API with hot reload
poetry run uvicorn ai_agent.main:app --host 0.0.0.0 --port 8000 --reload

# Run the LangGraph dev server (serves the graph defined in langgraph.json)
poetry run langgraph dev

# Tests
poetry run pytest                          # full suite
poetry run pytest tests/test_normalization.py -v   # single file
poetry run pytest -k test_name             # single test by name

# Lint / format / type-check (must all pass — matches CI exactly)
poetry run black --check src/ tests/
poetry run isort --check-only src/ tests/
poetry run flake8 src/ tests/ --max-line-length=90
poetry run mypy src/
poetry run bandit -r src/ -ll

# Auto-fix formatting
poetry run black src/ tests/
poetry run isort src/ tests/
```

CI (`.github/workflows/ci.yml`) runs the backend-lint/typecheck/security/test jobs
above against `apps/ai_agent` with `--max-line-length=90` for flake8 — note this
differs from the `.flake8` file's own default and from what the README describes;
the CI invocation is authoritative. Pre-commit hooks (root `.pre-commit-config.yaml`,
invoked via Husky) run Black/isort/flake8/mypy/bandit on changed Python files at
commit time.

Only `tests/test_normalization.py` exists today — most services (journal_service,
account_mapping, langgraph_service, etc.) have no test coverage yet. Auth and the agent's
database scoping are covered by `tests/test_auth.py`, `tests/test_api_auth.py`,
`tests/test_scoped_sql.py` and `tests/test_agent_scoping.py` (the last two use the local
Supabase database when it is running, and skip that part otherwise).

## Architecture

### Entry points

- `src/ai_agent/main.py` — FastAPI app factory. Wires up the Inngest ASGI endpoint
  (`/api/inngest`, via `inngest.fast_api.serve`) and mounts `api/routes/__init__.py`'s
  combined router (chat, embeddings, inngest, integrations, realtime, normalization,
  accounting, health). Service/Inngest imports are wrapped in try/except with a
  relative-then-absolute import fallback — this is intentional so the module works
  both under `poetry run uvicorn` and under the LangGraph CLI's own import context.
- `langgraph.json` — declares the standalone LangGraph graph
  (`ai_agent.agents.graph_agent:agent`) served independently of `main.py`'s FastAPI
  app when run via `langgraph dev`/LangGraph Platform. It also registers the auth
  handler (`auth.path` -> `src/ai_agent/auth.py`) and the CORS origins.

### Authentication and authorization (every request)

Nothing here trusts the caller's word about who they are or which business they mean.

- **Users:** a Supabase access token in `Authorization: Bearer`, verified locally against
  the project's JWKS (`core/auth.py`; `SUPABASE_JWT_SECRET` only for legacy HS256 projects).
  The business is looked up from the verified user id (`entities.owner_user_id`), never taken
  from the request.
- **LangGraph API** (threads, runs): `auth.py` rejects requests without a valid token (401),
  stamps new threads with their owner and filters every thread/run to it. The auth file is
  loaded by path, so it uses absolute imports; token verification runs in a thread because
  the dev server rejects blocking calls on the event loop.
- **REST routes** (`api/routes`, mounted by both `main.py` and `langgraph.json`'s `http.app`):
  `api/deps.py` provides `current_user`, `entity_guard` (any `entity_id` in the query, path,
  JSON body or form must be the caller's, else 403), `owned_*` dependencies for routes that
  name a record by id alone (404 if it is another business's), and `require_internal`
  (`X-Internal-Key` = `INTERNAL_API_KEY`; with no key configured those routes are closed).
  Machine-only routes (`/integrations/entities`, `/embeddings/*`, `/normalization/*` except
  `reprocess-failed`, `/inngest/*`, `/accounting/health-checks`) use the internal key.
  Public: `/`, `/health`, `/stats`, the Zoho OAuth callback (signed `state`), and
  `/api/inngest` (the Inngest SDK verifies request signatures; set `INNGEST_SIGNING_KEY` and
  not `INNGEST_DEV` in production).
- **Adding a route:** put it on a router that already carries a guard, or add one.
  `tests/test_api_auth.py` walks the whole API and fails on any route without a guard, and
  on any anonymous request that is not refused. Its route walk depends on FastAPI's private
  `effective_route_contexts()`; a count assertion fails loudly if that changes.
- Settings: `INTERNAL_API_KEY`, `CORS_ALLOW_ORIGINS` (comma-separated, default the local dev
  origins), `SUPABASE_JWT_SECRET` (legacy only). A variable set in the real environment wins
  over `.env` (`load_dotenv(override=False)`).
- The browser app forwards the user's token (see root CLAUDE.md); the old chat page signs its
  LangGraph requests with a client `onRequest` hook until the chat panel replaces it.

### Chat agent (`agents/graph_agent.py`)

A single LangGraph `StateGraph` (`AgentState` TypedDict) implements this flow:

```
START → classify_query → retrieve_context → evaluate_context_sufficiency
    → [sufficient?]
        → yes: context_response → END
        → no:  route by query_type
            → extract_document → END        (file attachments)
            → generic_response → END         (conversational)
            → analytics_agent → push_visualization → END  (data queries)
```

- Query classification, context-sufficiency evaluation, and document-category
  inference are all separate structured-output LLM calls (Pydantic models),
  not a single monolithic prompt — read the node docstrings before changing
  the routing logic, each node has specific confidence thresholds it enforces
  (e.g. context is only treated as sufficient above 0.7 confidence).
- `analytics_agent_node` builds its database tools per request from the authenticated user
  (`config["configurable"]["langgraph_auth_user"]`, set by `auth.py`; the server rejects a
  client that tries to set it): `tools/sql_tools.py::build_sql_tools`. Every query runs through
  `core/scoped_sql.py` (see "Agent database access"). A run with no signed-in user gets a
  refusal and no tools. `retrieve_context_node` searches the vector namespace of the
  caller's business only. The Supabase MCP path is gone (it was a second route to arbitrary
  SQL).
- `push_visualization_node` uses `langgraph.graph.ui.push_ui_message` (generative UI)
  to stream chart/table/metric components to the frontend — it re-analyzes the
  agent's own text output with another LLM call to decide what to visualize, it
  does not receive structured chart data from the analytics step directly.
- All LLM singletons (`_get_local_model`, `_get_gemini`, `_get_classifier`, etc.)
  are `@lru_cache`d module-level functions — graph construction itself
  (`create_analytics_agent_graph`) is cheap and does no I/O; heavy clients are
  created lazily on first request. Preserve this pattern for any new node.
- The "local" LLM (`core/config.py:get_local_llm`) is an OpenAI-compatible client
  pointed at `local_llm_base_url` (default `http://localhost:1234/v1`, e.g. LM
  Studio) — it is not literally OpenAI. `get_chat_model` uses LangChain's
  `init_chat_model` with provider-prefixed model strings (e.g.
  `"google_genai:gemini-2.5-flash-lite"`).

### Two separate DB access paths — don't conflate them

- `core/supabase_client.py::get_supabase_client()` — Supabase Python client
  (PostgREST) with the **service key**, used by nearly all business logic (normalization,
  journal_service, account_mapping, services/*). It bypasses row-level security, so a route
  that uses it must already have checked who the caller is (`api/deps.py`). Table calls are
  synchronous and wrapped in `asyncio.to_thread(...)` throughout — follow this pattern.
  It is an `@lru_cache` singleton that returns `None` when unconfigured; handle that.
- `core/scoped_sql.py` — the analytics agent's read-only SQL over `DATABASE_URL` (psycopg2),
  below.

### Agent database access (`core/scoped_sql.py`)

The model writes SQL, so access cannot rely on it behaving. Two layers:

1. `check_query` parses with Postgres's own parser (pglast) and accepts one plain SELECT over
   an allow-list of business tables and views (`ALLOWED_RELATIONS`; not `external_sources`,
   raw events, sync state, backups) calling only allow-listed functions
   (`ALLOWED_FUNCTIONS`). The function list is what matters: `set_config` could rewrite the
   identity RLS reads, `pg_read_file`/`dblink` reach out of the database. Add a function
   to the list only when a real question needs it. CTE names are scoped properly, so
   `WITH external_sources AS (SELECT * FROM external_sources)` is refused.
2. `run_query` opens a READ ONLY transaction, `SET LOCAL ROLE authenticated`, sets the
   user's id as the JWT claim, applies a statement timeout, and fetches at most 200 rows
   through a server-side cursor. The same RLS policies as the app's pages therefore decide
   which rows exist; the model is never trusted to filter by business.

`DATABASE_URL` must be a role that can `SET ROLE authenticated` (the `postgres` role on
Supabase). Add a table to `ALLOWED_RELATIONS` only with an RLS policy on it, and cover it in
`tests/test_scoped_sql.py` and `e2e/rls.spec.ts`.

### ETL / normalization pipeline

Provider sync (Shopify/Revolut/PayPal/Squarespace) → normalization → persistence
is Inngest-orchestrated, under `integrations/inngest/`:

- `<provider>_sync_functions.py` — pulls raw data from each provider's API and
  writes to `external_raw_events`.
- `events.py` — typed Inngest event senders (`send_<provider>_sync_event`, etc.)
  that trigger the pipeline steps.
- `normalization/inngest_functions.py` — the canonical processing path: consumes
  raw events, dispatches to the provider-specific normalizer, persists canonical
  records. Chained via `normalize_after_<provider>_sync` triggers.
- `normalization/service.py` (`NormalizationService`) is explicitly **not** the
  main processing path — read its module docstring: it exists for stats/monitoring
  and a direct-processing fallback for when Inngest is unavailable. New processing
  logic belongs in the Inngest functions, not here.
- Per-provider normalizers (`normalization/<provider>_normalizer.py`) all implement
  the same `normalize(entity_type, external_id, payload, raw_event_id) -> NormalizationResult`
  contract and are registered in `NORMALIZER_REGISTRY` (`normalization/service.py`).
  Canonical output tables include `customers`, `orders`, `products`,
  `inventory_items`, `payments`, `bank_accounts`, `financial_transactions`,
  `calendar_events`.

### OAuth providers (Zoho Calendar)

Every provider above authenticates via a credentials-only grant — Shopify/
PayPal exchange an app-supplied `client_id`/`client_secret` for a token with
no user consent screen. Zoho Calendar is the only exception, since there's
no credentials-only path to a specific person's own calendar; it needs real
3-legged OAuth2, which is new infrastructure, not an extension of the
existing pattern:

- `api/routes/oauth.py` — `/oauth/zoho_calendar/authorize-url` (signed-in user; returns
  Zoho's consent URL) and `/oauth/zoho_calendar/callback` (exchanges the code,
  creates the "ThreadWise Deadlines" calendar, persists the `external_sources`
  row). Any future OAuth provider's routes belong here too, not a new file.
- `integrations/zoho_calendar/oauth.py` — the OAuth2 mechanics: authorize-URL
  building, code↔token exchange, and a signed `state` param
  (`base64(entity_id|nonce|exp)` + `.` + `hmac_sha256(zoho_client_secret, payload)`,
  10-minute TTL). The signing matters because the callback is reached by Zoho
  redirecting the browser, so it carries no bearer token — an unsigned `state` would
  let anyone attach their own Zoho calendar to someone else's `entity_id`. The `state` is only
  minted by `GET /oauth/zoho_calendar/authorize-url`, which requires a signed-in user and
  uses the business from their token (the app's `/api/integrations/zoho/connect` route calls
  it and redirects, since a plain link cannot send a token).
- **`zoho_client_id`/`zoho_client_secret` are app-wide config (`core/config.py`/
  `.env`), not a per-connection secret** — the first exception to the pattern
  `docs/secure-api-key-workflow.md` documents, where every other provider's
  credentials are something each user supplies and that gets Vault-encrypted
  per `external_sources` row. Here, ThreadWise itself is the registered OAuth
  client (one Zoho API Console app), and many different entities each
  authorize it independently — the client_id/secret identify the
  _application_ to Zoho, not any one user's calendar, the same relationship
  as any "Sign in with Google" button on a multi-tenant SaaS. Each entity's
  own secret — the refresh token Zoho issues after their own consent — still
  goes through the exact same per-source Vault storage as every other
  provider's `api_key` field, just as a `{"refresh_token": ..., "api_domain":
...}` JSON blob instead of a `client_id`/`client_secret` pair.
- Zoho-specific quirks handled explicitly rather than assumed, each the kind
  of thing that fails silently if you don't know to check for it: the token
  endpoint returns HTTP 200 with an `{"error": ...}` body on failure (so
  `raise_for_status()` won't catch it — see `_raise_with_body` in
  `integrations/zoho_calendar/__init__.py`); `access_type=offline` +
  `prompt=consent` must both be in the authorize URL or a reconnect silently
  returns no refresh token; refresh tokens are capped at 20 per client per
  user with silent eviction of the oldest, so `delete_external_source`
  revokes on disconnect; write endpoints (create/update calendar or event)
  take a single query param whose value is a JSON string (e.g.
  `calendarData`, `eventdata`), never a JSON request body; and the
  events-list response's `start`/`end` live only in a nested `dateandtime`
  object whose own format differs by event type, despite Zoho's docs
  describing (non-existent, in practice) top-level `start`/`end` fields.
- Two-directional, unlike every other provider: `integrations/zoho_calendar/`
  both pulls the user's own calendar events (`zoho_calendar_sync_functions.py`'s
  `calendar_events` endpoint, into `calendar_events`/`CanonicalCalendarEvent`
  via `normalization/zoho_calendar_normalizer.py`) and pushes ThreadWise's
  own data out (`tax_deadlines`/`collection_launches` endpoints, via
  `services/calendar_push_service.py`, `tax_deadline_service.py`,
  `collection_launch_service.py`) into a dedicated "ThreadWise Deadlines"
  calendar created at connect time — excluded from the pull (by
  `external_account_id`) so pushed events are never re-imported as new
  ones. `persistence.py`'s `reconcile_calendar_events` marks a
  `calendar_events` row `cancelled` when a pull run's own window no longer
  returns it, since upsert-only storage otherwise never notices a deletion.

### Accounting engine (`services/journal_service.py`, `services/account_mapping.py`)

Double-entry journals are generated from normalized records:

- **Accrual journal**: from a captured payment — debits clearing (net of gateway
  fees) + bank charges, credits revenue/shipping/tax from the linked order.
- **Settlement journal**: from an inbound gateway payout (Stripe/PayPal → Revolut)
  — debits cash, credits clearing. No fee entry (fees are captured at accrual time).
- **Expense journal**: from an outbound financial transaction — debits the resolved
  expense account, credits cash.
- Purchase/Sale/Payment journals are created from invoices.

`account_mapping.py` is the single source of truth for resolving logical account
purposes to real `chart_of_accounts.account_number` values — **all** journal code
must resolve accounts through it rather than hard-coding account numbers. Header
accounts (`is_header = True`) are never valid posting targets. Legacy normalizer
`metadata.account_code` values (e.g. `6200`) are translated via `NORMALISER_CODE_MAP`;
`6999` is not a valid fallback — unresolvable entries are marked `draft` for human
review rather than mis-posted. Debits must equal credits within `BALANCE_TOLERANCE`
(`Decimal("0.01")`); accrual journals support `reverse_journal()`.

### Tools

`tools/sql_tools.py` builds the analytics agent's four database tools for one user
(`sql_db_list_tables`, `sql_db_schema`, `sql_db_query_checker`, `sql_db_query`, the names the
prompts use). The old `tools/sub_agents.py`, `agents/middleware.py`, `core/nodes.py`,
`core/state.py`, `core/database.py` and `services/mcp_client.py` were unused or unsafe and
have been removed.

## Environment

Config is centralized in `core/config.py` (`pydantic_settings.BaseSettings`,
loaded from `.env`, unknown keys ignored). Notable settings: `database_url`
(direct Postgres), `supabase_url`/`supabase_key` (PostgREST), `local_llm_base_url`, `inngest_event_key`/`inngest_signing_key`,
`pinecone_api_key` (vector store for embeddings/RAG), `internal_api_key` and
`cors_allow_origins` (see "Authentication and authorization"), `zoho_client_id`/
`zoho_client_secret`/`zoho_redirect_uri`/`zoho_accounts_domain` (see "OAuth
providers" above — app-wide, not per-connection), `frontend_url` (where the
Zoho OAuth callback redirects the browser back to after connecting — this
backend has no other reason to know the frontend's origin, and a bare path
would resolve against the wrong host since the callback itself runs here,
not on the frontend).
