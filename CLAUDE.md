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

A 2026-09 codebase health pass fixed most of the monorepo-wiring bugs that used
to live in this section (broken root pnpm scripts, `apps/ai-agent`/`apps/ai_agent`
path typos in `.gitignore`/`.pre-commit-config.yaml`, an empty stray
`apps/ai_agent/__init__.py` that broke all of pytest, `bandit`/`flake8` not being
real dependencies, a production-build-breaking route naming issue). What's left:

- Frontend `typecheck` is clean, so a new error is yours. ESLint reports one error, in
  `app/types/invoice.ts`, which nobody has touched: two Prettier versions are installed (the app's
  CLI resolves 3.6, `eslint-plugin-prettier` resolves 3.9 from the root) and they format a union
  type differently. Staging that file makes the `lint-staged` hook (`eslint --fix`) reformat it.
- `apps/chat-ui/.env.local` is committed to git with live Supabase/LangSmith/Google
  API keys despite `.gitignore` listing `**/.env.local` — the ignore rule was added
  after the file was already tracked. Don't add new secrets to it, and flag this to
  the user rather than assuming it's fine to leave real credentials in a tracked file.
- Docker (`docker-compose*.yml`, `apps/ai_agent/Dockerfile`) is marked
  experimental/non-functional (see the warning comment at the top of
  `docker-compose.yml`) — stale paths from before an app rename, and the backend
  Dockerfile is unmodified `langgraph build` template output. Not part of the
  day-to-day dev workflow; don't try to fix it as a side effect of an unrelated task.
- Frontend tests are Playwright end-to-end tests (see "Frontend tests" below); there is no
  unit-test runner. Backend has one test file (`apps/ai_agent/tests/test_normalization.py`); most
  services are untested.

## Commands (run from repo root unless noted)

Node 24 and Python 3.13 are pinned (`.nvmrc`, `apps/ai_agent/.python-version`) —
both current LTS as of 2026-09.

```bash
# Install everything (pnpm workspace + Poetry env for ai_agent)
make setup                    # or: pnpm setup

# Dev servers
pnpm dev:react-router          # chat-ui, http://localhost:5174 (or --filter threadwise-chat-ui dev)
pnpm dev:ai-agent               # FastAPI, http://localhost:8000, --reload
pnpm dev:all                    # or: make dev-all — chat-ui + langgraph dev (:2024) + inngest-cli dev
                                 # together in one mprocs TUI (mprocs.yaml); this is the workflow
                                 # that exercises realtime/Inngest — dev:ai-agent's plain uvicorn does not

# Frontend-specific (cd apps/chat-ui, or --filter threadwise-chat-ui from root)
pnpm typecheck                # react-router typegen && tsc
pnpm build                    # react-router build

# Local database and end-to-end tests (from repo root; needs Docker and the Supabase CLI)
pnpm db:start                 # supabase start: applies supabase/migrations to the local stack
pnpm db:fresh                 # reset the local DB, write .env.test, reseed (run after changing the seed)
pnpm e2e                      # Playwright: 3 widths x 2 themes (starts its own server on :5180)
pnpm e2e:quick                # desktop-light only (~2 min); `-- --last-failed` re-runs just failures
pnpm e2e:changed              # desktop-light, only specs changed vs main
pnpm e2e:mutations            # only the data-changing specs (~1.5 min)
supabase migration up         # apply a new migration to the running local stack

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
`--filter`/`working-directory` — mirror the workflow file, not `package.json`,
when checking "what CI actually runs." A `changes` job (via `dorny/paths-filter`)
skips the frontend or backend job group entirely when nothing under its path
changed. Pre-commit hooks (root `.pre-commit-config.yaml`, invoked via Husky) run
Black/isort/flake8/mypy/bandit on changed Python files and Prettier/ESLint on
everything else at commit time.

Only `apps/ai_agent/tests/test_normalization.py` exists — most backend services
(journal_service, account_mapping, mcp_client, etc.) and the entire frontend have
no automated test coverage yet.

## Architecture

### Two apps, three communication paths

The frontend does **not** talk to the FastAPI backend for everything — it has three
distinct data paths, and it matters which one a given feature uses:

1. **Chat/agent streaming** — `providers/AssistantProvider.tsx` uses `@langchain/langgraph-sdk`'s
   `useStream` hook to talk directly to the **LangGraph server** (`langgraph dev`,
   `VITE_LANGGRAPH_API_URL`, default `http://localhost:2024`), not the FastAPI app on :8000,
   signing every request with the user's token. This is how the assistant panel, its cards
   (generative UI pushed mid-stream) and clarifying questions (interrupts) work.
2. **Domain APIs proxied to the AI agent** — modules like `app/lib/api/accounting.ts`
   call the FastAPI backend's REST routes (`/accounting`, `/invoices`, etc., mounted
   in `apps/ai_agent/.../api/routes/__init__.py`) via `AI_AGENT_URL`/`VITE_AI_AGENT_URL`
   (also defaults to `:2024` in some files — check the actual env var before assuming
   which port a given call hits). **The agent authenticates every request with the signed-in
   user's Supabase token and takes the business from it**, so always send the token: browser
   code calls `agentFetch` (`app/lib/api/agent-auth.ts`), server routes pass
   `await requestAccessToken(request)` (`agent-auth.server.ts`) to `callAgent`. A plain
   `fetch` to the agent gets 401. Links and redirects cannot carry a header, so they go
   through an app route that asks the agent as the user (see `api.integrations.zoho.connect`).
   Details and the machine-only routes: `apps/ai_agent/CLAUDE.md`.
3. **Direct-to-Supabase reads** — `.server.ts` loaders (`dashboard.server.ts`,
   `inventory.server.ts`, `orders.server.ts`, `invoices.server.ts`, etc.) query Supabase
   directly, bypassing the AI agent, **as the signed-in user**:
   `getRequestSupabaseClient(request)` (`app/lib/supabase-server.ts`) builds a client from the
   `sb-*-auth-token` cookie, so Postgres row-level security decides what each read can see.
   Call `requireUser(request)` first: with no valid session every RLS read quietly returns
   nothing, and an empty page is worse than a 401. Never read business data with
   `getServerSupabaseClient()` (service-role key, bypasses RLS). It is only for what a user
   session must not do: storage (invoice documents) and writes that go to tables with no write
   policy, and only _after_ the same row was read as the user. Writes that touch the ledger go to
   the agent. The business comes from `getUserEntity(request)`, never from the request.
   Policies (`supabase/migrations/20261017000000_row_level_security.sql`): every table the app
   reads has an owner-of-the-entity SELECT policy, views are `security_invoker`, `anon` has no
   privileges, and SECURITY DEFINER functions are service-role only
   (`20261017000001_lock_down_functions.sql`). `e2e/rls.spec.ts` proves it against a second
   seeded business; add a table to its list when you add one to the app.

### Frontend structure (`apps/chat-ui/`)

- Routing is config-based (`app/routes.ts`, `@react-router/dev/routes`), not
  file-system convention — check that file to find which route module backs a URL.
  Two layouts: `routes/auth.tsx` (login/signup) and `routes/app.tsx` (the
  authenticated app shell with sidebar: dashboard, chat, invoices, transactions,
  collections (`/collections` and `/collections/:id`), reports, orders, products, inventory,
  customers, integrations, account, journals, tax).
  `api.*.tsx` routes (no `.server` suffix — see below) are resource routes (no
  UI) that the frontend's own `fetch` calls hit as a thin proxy/aggregation
  layer in front of the AI agent or Supabase.
  **Naming convention:** don't suffix a route file registered in `routes.ts`
  with `.server.tsx`, even if it only exports `loader`/`action` — React
  Router's Vite plugin treats that suffix as "server-only helper imported by a
  route," not "the route module itself," and fails production builds ("server-only
  module referenced by client") when it tries to generate the route's client-side
  stub. Plain `.ts`/`.tsx` is correct; `loader`/`action` exports are already
  server-only by framework convention regardless of filename. (Helper modules
  under `lib/api/*.server.ts` that are only ever _imported by_ a route, not
  registered as one themselves, are a different case and fine to suffix.)
  A client component must not import a _value_ from a `*.server.ts` module (the module is
  stripped from the client bundle and the page fails to load with a 500 on that file); type-only
  imports are fine. Shared constants belong in a plain `lib/*.ts` file.
- `providers/AuthProvider.tsx` wraps the whole app (in `root.tsx`) and owns
  Supabase auth state, profile, and entity (the business/org record) — most
  authenticated pages read from `useAuth()` rather than querying Supabase themselves.
- **The assistant** is a right-hand panel on every authenticated page, not a page:
  `providers/AssistantProvider.tsx` is mounted once in `AppLayout` (so a conversation
  survives navigation) and is the single source of truth for chat state, using LangGraph SDK
  types directly (no conversion layer). The panel and conversation UI are in
  `components/assistant/` (`AssistantPanel`, `Conversation`, `ThreadList`, the generative UI
  `cards.tsx`/`chips.tsx` and their Zod `catalogue.ts`, mirrored from the backend and checked by
  `e2e/assistant-contract.spec.ts`). It docks beside the page from 1700px, overlays below that,
  and is a sheet on a phone; its open state and width are a cookie (`lib/assistant-panel.ts`)
  read by the `routes/app.tsx` loader. `/chat` shows the same conversation full width.
  Pages tell it which record is open (`useAssistantRecord`); the agent can propose changes
  (invoice status, a transaction's account) and remember preferences, but only after the user
  approves a proposal card: nothing writes without a click. The panel is behind a setting
  (`ASSISTANT_ENABLED`, `app/lib/assistant-flag.ts`): on in development, **off in production** until
  set. Operating notes (limits, logs, tracing, retention): `apps/ai_agent/docs/operations.md`.
  Details: `docs/chat-redesign-plan.md` (sections 3, 4 and 12).
- `components/dashboard/`, `components/reports/`, etc. are organized by feature/domain,
  mirroring the route list above.

### Design system

Tokens are in `app/globals.css` (light and dark, one value each, components use tokens only,
never raw colours); the shared kit is `app/components/ui` (browse it at `/ui-kit` in development).
`docs/design-language.md` has the reference design and, at the end, the "As built" decisions and
rules (contrast values, one job per colour, compact vs hero headers, state in the URL, drawers and
confirm dialogs, accessibility rules). Build a page from the kit before adding a component.

### Frontend tests (`apps/chat-ui/e2e/`)

Playwright against a local Supabase stack and a seeded business (plus a second, rival business to
prove the security boundary). Import `test`/`expect` from `./fixtures`, assert on counts and
figures from `readManifest()` (written by the seed), never on dates or invented numbers. Every
page spec also runs axe and an overflow check. Files named `*-edit.spec.ts` change data and run
last, in the `mutations` project, restoring what they change (helpers in `e2e/helpers/db.ts`);
don't change the seeded user's password (it signs every session out; use a throwaway user), and
don't remove seeded rows. The stand-in agent (`e2e/stand-in-agent.ts`) answers the server-side
agent calls; calls the browser makes to the agent are mocked in the spec with `page.route`. The
assistant's LangGraph calls go to `VITE_LANGGRAPH_API_URL=http://127.0.0.1:8098` in tests (nothing
listens there, so an unmocked call fails rather than reaching a real agent) and are answered by
`e2e/helpers/fake-langgraph.ts` (threads, history, streamed runs, interrupts; plans per question).
Both refuse a request without a user token, as the real agent does (the browser mocks must also
allow the `authorization` header in their CORS reply: `*` does not cover it).
`e2e/README.md` has the layout.

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
