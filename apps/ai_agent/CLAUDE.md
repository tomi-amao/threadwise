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
   canonical schema, and persists them to Supabase/Postgres.
3. **Accounting engine** — turns normalized payments/transactions/invoices into
   double-entry journals against a chart of accounts.

## Commands

All commands run from `apps/ai_agent/` (Poetry is *not* usable from the repo root).

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
account_mapping, langgraph_service, mcp_client, etc.) have no test coverage yet.

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
  app when run via `langgraph dev`/LangGraph Platform.

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
- `analytics_agent_node` picks its toolset at runtime based on `state["data_source"]`:
  `"sql_toolkit"` (default, via `tools/sql_tools.py` + `core/database.py`'s direct
  Postgres `SQLDatabase` connection) or `"supabase_mcp"` (via `services/mcp_client.py`,
  which connects to Supabase's hosted MCP server through `langchain-mcp-adapters`).
  MCP failures fall back to the SQL toolkit rather than erroring.
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
  (PostgREST), used by nearly all business logic (normalization, journal_service,
  account_mapping, services/*). Table calls are synchronous and wrapped in
  `asyncio.to_thread(...)` throughout — follow this pattern for new Supabase calls.
- `core/database.py::get_db()` — a direct `langchain_community.utilities.SQLDatabase`
  (psycopg2) connection used only by the analytics agent's SQL toolkit for
  free-form read queries against the warehouse.

Both are `@lru_cache` singletons and return `None`/log a warning rather than
raising when unconfigured — callers must handle the `None` case.

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
  `inventory_items`, `payments`, `bank_accounts`, `financial_transactions`.

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

### Sub-agents & tools

`tools/sub_agents.py` and `agents/middleware.py` hold auxiliary agents (e.g. a
query-qualification sub-agent exposed as a `@tool`) that the main graph or
`create_agent`-based analytics agent can call — a different composition pattern
from the StateGraph nodes in `graph_agent.py`. `agents/agent.py` predates
`graph_agent.py`; check which is actually wired into `langgraph.json` /
`main.py` before assuming either is dead code.

## Environment

Config is centralized in `core/config.py` (`pydantic_settings.BaseSettings`,
loaded from `.env`, unknown keys ignored). Notable settings: `database_url`
(direct Postgres), `supabase_url`/`supabase_key` (PostgREST), `supabase_access_token`
(PAT for MCP auth), `local_llm_base_url`, `inngest_event_key`/`inngest_signing_key`,
`pinecone_api_key` (vector store for embeddings/RAG).
