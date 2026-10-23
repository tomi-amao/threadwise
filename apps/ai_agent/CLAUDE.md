# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`apps/ai_agent` is the Python/FastAPI backend of ThreadWise, a conversational AI
platform that replaces dashboards with a chat interface for business intelligence
and accounting. It lives in a pnpm/Poetry hybrid monorepo — the frontend
(`apps/chat-ui`, React Router 7) is a sibling directory and out of scope here
unless a task explicitly touches it.

This service does three distinct jobs:

1. **Chat agent** — a `create_agent` tool-calling loop that answers questions about
   the signed-in user's business from typed data tools (SQL as a fallback). Read-only.
2. **ETL / normalization pipeline** — pulls transactions from external providers
   (Shopify, Revolut, PayPal, Squarespace) via Inngest, normalizes them into a
   canonical schema, and persists them to Supabase/Postgres. Zoho Calendar is
   the one provider that also goes the other way — see "OAuth providers" below.
3. **Accounting engine** — turns normalized payments/transactions/invoices into
   double-entry journals against a chart of accounts.

Longer explanations for people are in `docs/` (start at `docs/README.md`): architecture,
security, chat agent, data pipeline, accounting, the route list, development. Update the matching
page when you change one of those areas.

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
above against `apps/ai_agent` with `--max-line-length=90` for flake8, the same value as
`.flake8`, which also ignores E501 because Black owns line length (it cannot wrap long SQL, prompt
or description strings). All of Black, isort, flake8, mypy and bandit are clean today, so a new
finding is yours. Pre-commit hooks (root `.pre-commit-config.yaml`, invoked via Husky) run
Black/isort/flake8/mypy/bandit on changed Python files at commit time.

There are 11 test files (about 260 tests): `test_normalization.py`, `test_invoice_rules.py`,
`test_invoice_service.py`, `test_limits.py`, `test_auth.py`, `test_api_auth.py`,
`test_ui_contract.py`, and the database-backed `test_scoped_sql.py`, `test_chat_agent.py`,
`test_actions.py` and `test_evals.py`. The database-backed ones use the local Supabase stack and the
e2e seed manifest and skip those parts when they are absent. Most services (journal_service,
account_mapping, langgraph_service, etc.) have no direct coverage yet.

`tests/conftest.py` sets `INNGEST_DEV=1`. CI has no `.env`, and without dev mode the Inngest SDK
raises `SigningKeyMissingError` as soon as the app is imported, which fails the whole run at
collection. Keep tests independent of a developer's `.env`; to check, move it aside and run pytest.

## Architecture

### Entry points

- `src/ai_agent/main.py` — FastAPI app factory. Wires up the Inngest ASGI endpoint
  (`/api/inngest`, via `inngest.fast_api.serve`) and mounts `api/routes/__init__.py`'s
  combined router (chat, embeddings, inngest, integrations, realtime, normalization,
  accounting, health). Service/Inngest imports are wrapped in try/except with a
  relative-then-absolute import fallback — this is intentional so the module works
  both under `poetry run uvicorn` and under the LangGraph CLI's own import context.
- `langgraph.json` — declares the LangGraph graph (`threadwise-financial-agent` =
  `ai_agent.agents.chat_graph:agent`) served by `langgraph dev`/LangGraph Platform,
  which also mounts `main.py`'s FastAPI app (`http.app`). It registers the auth handler
  (`auth.path` -> `src/ai_agent/auth.py`), the CORS origins, and thread retention
  (`checkpointer.ttl`: 90 days, in minutes).

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

### Chat agent (`agents/chat_agent.py`)

One `create_agent` loop (langchain 1.x): system prompt (`agents/chat_prompt.py`), the
tools below, and middleware. The model decides which tools to call; there is no
classifier, router or second "what chart?" LLM call.

- **Identity.** Every tool takes `runtime: ToolRuntime` (hidden from the model) and reads
  the user from `runtime.config["configurable"]["langgraph_auth_user"]`, which the server
  sets from `auth.py` and overrides if a client sends it (`tools/identity.py`). Never add
  a tool argument for the user or business, and never name an argument `config` or
  `runtime` (reserved).
- **Middleware, in order:** `BusinessContextMiddleware` (refuses a run with no signed-in
  user before the model is called; answers a file attachment with a pointer to the
  Invoices page, since extraction is not part of chat; loads the business profile into
  state each turn and appends it and today's date to the system prompt), summarisation
  (small model), model and tool call caps per turn, model fallback, model retry, tool
  errors returned to the model as text (`tool_error_message`), and tool retry on a
  dropped database connection.
- **Models** are settings: `agent_model`, `agent_fallback_model`, `agent_small_model`
  (provider-prefixed ids for `init_chat_model`; Gemini by default since only
  `GOOGLE_API_KEY` is configured). The Gemini client refuses to construct without its key,
  so `build_agent()` builds nothing at import; `agents/chat_graph.py` (what langgraph.json
  points at) calls it. Tests import `build_agent` and pass a scripted fake model.
- **No checkpointer in code**: the LangGraph server supplies one (TTL in langgraph.json).
- **Limits, logs, evals** (details: `docs/operations.md`, `docs/evals.md`): a per-user run limit
  (`auth.py`, per process), a per-turn token cap and a structured turn log
  (`agents/limits_middleware.py`; no questions, answers or figures in logs), ids in thread and run
  metadata are keyed hashes (`core/tracing.py`, set `TRACE_HASH_SALT`), model clients retry once.
  The golden set (`python -m ai_agent.evals`) has 56 cases with expected figures taken from the
  seed manifest, never typed; its oracle (a scripted perfect model) must score 100% and runs in CI
  (`.github/workflows/backend-data.yml`); a real model is measured nightly. Measure before
  changing a model default: the 3.5 Gemini models were 3 to 17 times slower than the 2.5 ones.
- **Page context, actions, memory**: the browser's page context is a name only: the server
  re-reads the record as the user (`agents/page_context.py`) and the label is never used. Action
  tools (`tools/action_tools.py`) read, build a `Proposal` from the read, pause on an interrupt,
  and only on `{"decision": "approve"}` call the existing endpoint through the app with the
  user's token (`call_app`). Memory (`tools/memory_tools.py`) is saved only after approval, in the
  store under `(user_id, "memories")`, which `auth.py` scopes per user. Nothing writes without a
  click: keep it that way, and test it. Details: `docs/chat-agent.md`.
- **Generative UI** (`ui/`): cards come from tool results through pure presenters
  (`ui/presenters.py`), never from a model, pushed by `GenerativeUIMiddleware`; follow-up chips
  come from one small-model call at the end of the turn (`FollowUpsMiddleware`); `ask_user`
  pauses on an interrupt for a clarifying question. The props are Pydantic models
  (`ui/catalogue.py`) mirrored as Zod in the frontend. After changing one, run
  `poetry run python -m ai_agent.ui.contract` and update the Zod side:
  `tests/test_ui_contract.py` and the frontend's `assistant-contract.spec.ts` fail otherwise.
  Details: `docs/chat-agent.md`.
- The "local" LLM (`core/config.py:get_local_llm`) is an OpenAI-compatible client
  pointed at `local_llm_base_url` (e.g. LM Studio); still used by one integrations route,
  not by the chat agent.

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

`run_trusted(user_id, sql, params)` is the same transaction without the parser, for the
fixed, parameterised SQL in `tools/data_tools.py` (psycopg2 placeholders do not parse).
Never pass it text the model wrote.

`DATABASE_URL` must be a role that can `SET ROLE authenticated` (the `postgres` role on
Supabase). Add a table to `ALLOWED_RELATIONS` only with an RLS policy on it, and cover it in
`tests/test_scoped_sql.py` and `e2e/rls.spec.ts`.

### ETL / normalization pipeline

Provider sync (Shopify/Revolut/PayPal/Squarespace) → normalization → persistence
is Inngest-orchestrated, under `integrations/inngest/`:

- `<provider>_sync_functions.py` — pulls raw data from each provider's API and
  writes to `external_raw_events`.
- `events.py` — typed Inngest event senders (`send_<provider>_sync_event`, etc.)
  that trigger the pipeline steps. `client.send()` takes `inngest.Event(name=..., data=...)`,
  not a dict: a dict raises `AttributeError` (inngest 0.5), which these helpers catch and report
  as `False`, so a malformed send fails silently.
- Inngest handler conventions (inngest 0.5): a handler takes only `ctx` and uses `ctx.step`
  (`async def f(ctx: inngest.Context)`, not `(ctx, step)`); `ctx.event.data` is typed as broad JSON,
  so read it into a `Dict[str, Any]`; and a function wrapped by `@client.create_function` becomes an
  Inngest `Function`, which is **not callable**, so shared logic goes in a plain undecorated helper
  (see `_sync_squarespace_endpoint`). `step.run` accepts handler args and sync callables.
- Known gap: the PayPal normalizer leaves `base_amount` empty for foreign-currency transactions on
  purpose, but `CanonicalFinancialTransaction.base_amount` and the `financial_transactions` column
  are required, so those rows fail validation. Marked with a `type: ignore` in
  `normalization/paypal_normalizer.py`; it needs a decision on how to convert them to GBP.
- `normalization/inngest_functions.py` — the canonical processing path: consumes
  raw events, dispatches to the provider-specific normalizer, persists canonical
  records. Chained via `normalize_after_<provider>_sync` triggers.
- `normalization/service.py` (`NormalizationService`) is explicitly **not** the
  main processing path — read its module docstring: it exists for stats/monitoring
  and a direct-processing fallback for when Inngest is unavailable. New processing
  logic belongs in the Inngest functions, not here.
- Per-provider normalizers (`normalization/<provider>_normalizer.py`) all implement
  the same `normalize(entity_type, external_id, payload, raw_event_id) -> NormalizationResult`
  contract and are registered in `PROVIDER_NORMALIZERS`
  (`normalization/inngest_functions.py`, the processing path; all five providers).
  `NORMALIZER_REGISTRY` in `normalization/service.py` is the synchronous fallback and
  lists only Squarespace, Revolut and PayPal.
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
- Also: funding (inbound personal transfer), sales receipt (direct PayPal sale), refund
  and refund reversal, FX conversion, inventory cost of goods sold, and stock disposal.
  All 13 types, with their `JournalService` methods, are in `docs/accounting.md`.
- Journals follow the same rules throughout: debits equal credits, one journal per source
  record (idempotent), and `reverse_journal` is a soft void (`status = 'reversed'`), not an
  opposite entry.

`account_mapping.py` is the single source of truth for resolving logical account
purposes to real `chart_of_accounts.account_number` values — **all** journal code
must resolve accounts through it rather than hard-coding account numbers. Header
accounts (`is_header = True`) are never valid posting targets. Legacy normalizer
`metadata.account_code` values (e.g. `6200`) are translated via `NORMALISER_CODE_MAP`;
`6999` is not a valid fallback — unresolvable entries are marked `draft` for human
review rather than mis-posted. Debits must equal credits within `BALANCE_TOLERANCE`
(`Decimal("0.01")`); accrual journals support `reverse_journal()`.

### Tools

- `tools/data_tools.py` — typed tools, each returning a dict that names its period,
  currency and a `link` to the page (using that page's own URL filters):
  `get_business_profile` (also today's date and data coverage), `profit_and_loss`,
  `sales_summary`, `top_products`, `top_customers`, `outstanding_invoices`,
  `cash_position`, `search_transactions`. Their SQL uses **the same definitions as the
  pages** (the module docstring lists them and the frontend file each comes from); change
  one and you must change the other, or the chat and the page will disagree.
  `tests/test_chat_agent.py` checks every tool against the e2e seed manifest.
- `tools/sql_tools.py` — the fallback: `list_tables`, `describe_tables`, `run_sql`
  (checked, `run_query`). A refusal comes back to the model as `{"error": ...}`.
- `tools/document_tools.py` — `search_documents`, the caller's vector namespace only.

The old hand-built graph (`agents/graph_agent.py`, `agents/prompts.py`) and earlier dead
modules were removed.

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
