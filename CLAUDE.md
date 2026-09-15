# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ThreadWise is a conversational, agent-centric business-intelligence platform: it
replaces dashboards with a chat interface backed by a LangGraph agent that answers
financial/analytics questions, ingests data from Shopify/Revolut/PayPal/Squarespace,
and generates double-entry accounting journals. It's a two-app pnpm/Poetry hybrid
monorepo:

- `apps/chat-ui/` — React Router 7 (SSR) frontend, package name `threadwise-chat-ui`.
- `apps/ai_agent/` — Python/FastAPI + LangGraph backend, package name `threadwise-ai-agent`.
  It has its own [CLAUDE.md](apps/ai_agent/CLAUDE.md) with detailed backend
  architecture (chat graph, ETL/normalization pipeline, accounting engine) — read
  that before working in `apps/ai_agent`.

`packages/` and `components/` are declared in `pnpm-workspace.yaml` but don't exist
yet; docs and root scripts referencing them describe aspirational, not current, state.

## ⚠️ Known issues to work around

- **Root pnpm scripts targeting the frontend are broken.** `package.json`'s
  `dev:react-router`, `build:react-router`, `typecheck:react-router`, and
  `test:react-router` all run `pnpm --filter threadwise-react-router ...`, but
  `apps/chat-ui/package.json`'s `name` is `threadwise-chat-ui` — the filter matches
  no package and pnpm no-ops or errors. Use `pnpm --filter threadwise-chat-ui <script>`,
  or `cd apps/chat-ui && pnpm <script>`, directly instead. This means `pnpm dev`,
  `pnpm build`, `pnpm test`, and `pnpm typecheck` at the root are all currently
  broken for the frontend half.
- Frontend `typecheck` currently fails on pre-existing errors (stale `tsconfig`
  `module` target rejecting `import.meta.env`/dynamic imports in several files,
  plus a couple of real type mismatches) — these predate any given task; don't
  assume you broke typecheck unless your diff touches those files.
- `.github/copilot-instructions.md` describes an older layout (`apps/react-router/`,
  empty `packages/*`, port 3000/8100 Docker mapping) that no longer matches the
  codebase in several places — cross-check against actual files rather than
  trusting it verbatim.
- `apps/chat-ui/.env.local` is committed to git with live Supabase/LangSmith/Google
  API keys despite `.gitignore` listing `**/.env.local` — the ignore rule was added
  after the file was already tracked. Don't add new secrets to it, and flag this to
  the user rather than assuming it's fine to leave real credentials in a tracked file.

## Commands (run from repo root unless noted)

```bash
# Install everything (pnpm workspace + Poetry env for ai_agent)
make setup                    # or: pnpm setup

# Dev servers (see "broken scripts" above — these two work)
pnpm --filter threadwise-chat-ui dev     # chat-ui, http://localhost:5174
pnpm dev:ai-agent                        # FastAPI, http://localhost:8000, --reload

# Frontend-specific (cd apps/chat-ui, or --filter threadwise-chat-ui from root)
pnpm typecheck                # react-router typegen && tsc
pnpm build                    # react-router build

# Backend (cd apps/ai_agent — Poetry is not usable from repo root)
poetry install
poetry run uvicorn ai_agent.main:app --reload --host 0.0.0.0 --port 8000
poetry run langgraph dev      # serves the LangGraph graph from langgraph.json directly
poetry run pytest                                    # full suite
poetry run pytest tests/test_normalization.py -v     # single file
poetry run pytest -k test_name                       # single test by name
poetry run black --check src/ tests/ && poetry run isort --check-only src/ tests/
poetry run flake8 src/ tests/ --max-line-length=90    # CI uses 90, not the repo default
poetry run mypy src/
poetry run bandit -r src/ -ll

# Root-level, cross-cutting
pnpm lint                     # eslint . --fix (whole repo)
pnpm format                   # prettier --write .
```

CI (`.github/workflows/ci.yml`) runs frontend lint/typecheck/build and backend
lint/typecheck/security/test as separate jobs, invoking pnpm/poetry directly with
`--filter`/`working-directory` (not the broken root aggregate scripts) — mirror the
workflow file, not `package.json`, when checking "what CI actually runs."
Pre-commit hooks (root `.pre-commit-config.yaml`, invoked via Husky) run
Black/isort/flake8/mypy/bandit on changed Python files and Prettier/ESLint on
everything else at commit time.

Only `apps/ai_agent/tests/test_normalization.py` exists — most backend services
(journal_service, account_mapping, mcp_client, etc.) and the entire frontend have
no automated test coverage yet.

## Architecture

### Two apps, three communication paths

The frontend does **not** talk to the FastAPI backend for everything — it has three
distinct data paths, and it matters which one a given feature uses:

1. **Chat/agent streaming** — `ChatProvider.tsx` uses `@langchain/langgraph-sdk`'s
   `useStream` hook to talk directly to the **LangGraph dev server** (`langgraph dev`,
   default `http://localhost:2024`), not the FastAPI app on :8000. This is how
   generative UI (charts/tables pushed mid-stream) and the conversational agent work.
2. **Domain APIs proxied to the AI agent** — modules like `app/lib/api/accounting.ts`
   call the FastAPI backend's REST routes (`/accounting`, `/invoices`, etc., mounted
   in `apps/ai_agent/.../api/routes/__init__.py`) via `AI_AGENT_URL`/`VITE_AI_AGENT_URL`
   (also defaults to `:2024` in some files — check the actual env var before assuming
   which port a given call hits).
3. **Direct-to-Supabase reads** — `.server.ts` loaders (`dashboard.server.ts`,
   `bank-balance.server.ts`, `revenue-metrics.server.ts`, etc.) query Supabase
   directly via `getServerSupabaseClient()`/`getAuthenticatedServerClient()`
   (`app/lib/supabase.ts`), bypassing the AI agent entirely for read-heavy dashboard
   data. `getAuthenticatedServerClient` forwards the caller's session (Authorization
   header or `sb-*-auth-token` cookie) so Postgres RLS applies; `getServerSupabaseClient`
   uses the service-role key and bypasses RLS — don't use it for user-scoped reads.

### Frontend structure (`apps/chat-ui/`)

- Routing is config-based (`app/routes.ts`, `@react-router/dev/routes`), not
  file-system convention — check that file to find which route module backs a URL.
  Two layouts: `routes/auth.tsx` (login/signup) and `routes/app.tsx` (the
  authenticated app shell with sidebar: dashboard, chat, invoices, transactions,
  collections, reports, orders, products, inventory, customers, integrations,
  account, reclassification, journals, tax).
  `api.*.server.tsx` routes are resource routes (no UI) that the frontend's own
  `fetch` calls hit as a thin proxy/aggregation layer in front of the AI agent or Supabase.
- `providers/AuthProvider.tsx` wraps the whole app (in `root.tsx`) and owns
  Supabase auth state, profile, and entity (the business/org record) — most
  authenticated pages read from `useAuth()` rather than querying Supabase themselves.
- `providers/ChatProvider.tsx` is the single source of truth for chat state; it
  intentionally uses LangGraph SDK types directly rather than an app-specific
  message shape, to avoid a conversion layer.
- `components/dashboard/`, `components/visualizations/`, etc. are organized by
  feature/domain, mirroring the route list above.

### Backend structure (`apps/ai_agent/`)

See [apps/ai_agent/CLAUDE.md](apps/ai_agent/CLAUDE.md) for the full breakdown. In short:
the LangGraph chat agent (`agents/graph_agent.py`), the Inngest-orchestrated
ETL/normalization pipeline for external providers, and the double-entry accounting
engine (`services/journal_service.py` + `services/account_mapping.py`) are three
largely independent subsystems sharing one FastAPI app and one Supabase database —
read that file before making non-trivial backend changes, it documents node-level
routing logic, the two separate DB access paths (Supabase PostgREST vs. direct
`psycopg2`/`SQLDatabase`), and account-resolution invariants that aren't obvious
from any single file.

## Environment

- `.env.example` (root) documents the shared variable names; `apps/chat-ui/.env.local`
  holds the frontend's actual dev values (see the tracked-secrets caveat above).
- Backend config is centralized in `apps/ai_agent/src/ai_agent/core/config.py`
  (`pydantic_settings.BaseSettings`) — see its own CLAUDE.md for the notable settings.
- `.mcp.json` (repo root, gitignored, not tracked) configures the `github`,
  `supabase`, and `inngest-dev` MCP servers for local Claude Code use.
