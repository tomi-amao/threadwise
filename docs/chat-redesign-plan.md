# Chat and agent redesign plan

Status: agreed plan, 2026-10-18. Nothing here is built yet. Decisions in section 7 are settled.
To be executed in a separate session: read "Start here" first, it is written for a session with no
prior context.

## 0. Start here (context for a fresh session)

**Read first:** root `CLAUDE.md`, `apps/ai_agent/CLAUDE.md`, `docs/design-language.md` (its "As built"
section is the rule set for any UI), and `docs/frontend-redesign-plan.md` (how the last big piece of
work was planned and phased; follow the same style: a PR per phase, tests with each).

**State of the repo.** The frontend redesign (every page except chat) is merged to `main`. Chat was
deliberately left out because it is being rebuilt by this plan. Chat code that will be replaced:
`apps/chat-ui/app/routes/app.chat.tsx`, `app/providers/ChatProvider.tsx` (434 lines, wraps
`useStream` from `@langchain/langgraph-sdk/react`), `app/components/thread/*` (about 3,200 lines;
`messages/MessageBubble.tsx` renders the generative UI messages). It accounts for the repo's only
type errors (4) and lint errors; committing those files needs `--no-verify` until they are gone.

**Backend facts that matter (all under `apps/ai_agent/src/ai_agent/`):**

- `agents/graph_agent.py` is the live graph, served by `langgraph.json` as
  `threadwise-financial-agent` (`ai_agent.agents.graph_agent:agent`). `langgraph.json` also mounts
  the FastAPI app (`ai_agent.main:app`) via `http.app`, has CORS `*` and no `auth` block.
- Analytics tools: `tools/sql_tools.py` (`SQLDatabaseToolkit` over `core/database.py::get_db()`,
  a direct psycopg2 connection from `settings.database_url`, no tenant scoping) and
  `services/mcp_client.py` (Supabase MCP). Both are replaced in Phase 1 and 2.
- Likely dead (verify with grep before deleting): `core/nodes.py`, `core/state.py`,
  `tools/sub_agents.py`, `agents/middleware.py`, and the thread/assistant routes in
  `api/routes/chat.py`.
- Prompts (including a hand-written schema description) are in `agents/prompts.py` (895 lines).
- Business data access elsewhere uses `core/supabase_client.py::get_supabase_client()` (PostgREST,
  synchronous, wrapped in `asyncio.to_thread`). Config is `core/config.py` (`pydantic_settings`).
- Installed (2026-10): langgraph 1.2.11, langchain 1.4.0, langchain-core 1.6.3, langgraph-sdk 0.4.4,
  langgraph-api 0.14.1, langchain-mcp-adapters 0.2.2, supabase 2.31.0. Python 3.13, Poetry (run from
  `apps/ai_agent`, not the repo root).
- Tests: pytest, one file today (`tests/test_normalization.py`). CI runs black, isort, flake8
  (`--max-line-length=90`), mypy and bandit on `apps/ai_agent`; all must pass.

**Frontend facts:** React Router 7 SSR, Tailwind v4, the shared kit is `app/components/ui` (browse
at `/ui-kit` in dev), shell is `app/components/layout/AppLayout.tsx` (route `routes/app.tsx`). Loaders
read Supabase as the signed-in user (`getRequestSupabaseClient`, `requireUser`, `getUserEntity` in
`app/lib/supabase-server.ts`); RLS migrations are `supabase/migrations/20261017000000_*` and
`20261017000001_*`. The chat connects straight to the LangGraph server (`:2024` in dev) with
`useStream`, not through the React Router server.

**How to run things:** `pnpm db:start` / `pnpm db:fresh` (local Supabase, needs Docker),
`pnpm dev:all` (chat-ui + `langgraph dev` + Inngest in one mprocs TUI), `pnpm e2e:quick` (desktop
light only, about 2 minutes), `pnpm e2e` (full matrix), `pnpm typecheck`. The Playwright setup uses a
stand-in agent (`apps/chat-ui/e2e/stand-in-agent.ts`, port 8099) and a seeded business plus a rival
business (`e2e/seed`, manifest of known totals via `readManifest()`); extend those rather than
inventing new fixtures. Never change the seeded user's password in a test.

**Docs tooling:** this project has two MCP servers configured for the LangChain docs
(`docs-langchain` and `reference-langchain`; check `claude mcp list`, they load at session start).
Phase 0 is to verify every LangGraph/LangChain assumption below against them. Where they disagree
with this plan, the docs win; update this plan in the same PR.

**Working rules from the previous project:** commit with explicit paths; one PR per phase; add or
extend an e2e/pytest test with each change; do not touch `.env.example` or `mprocs.log` (the owner's
local files); `apps/chat-ui/.env.local` is a tracked file with live keys (do not add to it, and
raise it with the owner); run `pnpm typecheck` and lint before each commit.

## 1. Goal

A business owner asks questions about their own business from any page, gets figures they can
trust, and is guided to the next question. Today chat is a page (`/chat`) in front of an agent that
has not been touched since the first version.

Success means:

- The assistant is a right-hand panel available on every authenticated page, and it knows which page
  (and which invoice, order and so on) the user is looking at.
- Every figure it states comes from a tool call against that business's data, and the answer links
  to where the numbers live.
- Each answer ends with clickable follow-up questions.
- An agent request can never read another business's data (see 2.1).

## 2. What is there today (findings)

### 2.1 Problems that decide the shape of the work

| #   | Finding                                                                                                                                                                                                                            | Why it matters                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The analytics agent uses `SQLDatabaseToolkit` on a direct Postgres connection (`core/database.py`, `settings.database_url`) with no tenant scoping. The model writes free-form SQL and the prompt only says "filter by entity_id". | A user (or a prompt injection inside an imported order note) can ask for another business's rows. RLS does not apply to this connection. This is the most serious issue in the app. |
| 2   | The browser talks to the LangGraph server directly (`useStream` to `:2024`) and the agent trusts the `entity_id` it is sent. There is no `auth` block in `langgraph.json`, and CORS is `*`.                                        | Anyone who can reach the server can impersonate a business, and anyone can read any thread.                                                                                         |
| 3   | One 1,394-line graph with a hand-built pipeline: classify, retrieve context, evaluate sufficiency, route, then analytics, then a second LLM call that reads the agent's prose to guess a chart (`push_visualization_node`).        | Four to six LLM calls before an answer. Charts are guessed from text, so they can disagree with the answer. Latency and cost are high and behaviour is hard to predict.             |
| 4   | Document extraction, general chat, retrieval and analytics share one graph and one state.                                                                                                                                          | Unrelated concerns share a failure surface. Invoice upload already has its own service (`invoice_service.py`).                                                                      |
| 5   | `core/nodes.py`, `core/state.py`, `tools/sub_agents.py` and `agents/middleware.py` look like dead or abandoned earlier attempts (a second `State`, a second classifier).                                                           | Confusion about what is live. Verify, then delete.                                                                                                                                  |
| 6   | The model is an LM Studio-style local model by default (`get_local_llm("qwen/qwen3-vl-4b")` is hard-coded in `sql_tools.py`).                                                                                                      | Not production-suitable for tool use and SQL. Model choice must be configuration with a fallback.                                                                                   |
| 7   | The MCP path (`services/mcp_client.py`, Supabase MCP `execute_sql`) is a second route to arbitrary SQL.                                                                                                                            | Same tenancy problem as finding 1, plus an extra moving part.                                                                                                                       |
| 8   | No checkpointer or store is configured by the app (it relies on the dev server's in-memory one), no tests, no evals.                                                                                                               | Threads vanish when the dev server restarts, and nothing catches regressions in answers.                                                                                            |
| 9   | Frontend: 3,235 lines in `components/thread/*` on the old styling, 4 type errors, lint errors that force `--no-verify`, a page-only layout.                                                                                        | Rebuilt on the design kit, this clears the last exception in the repo.                                                                                                              |

### 2.2 What is worth keeping

- `push_ui_message` generative UI as the transport (component name plus props, streamed mid-run).
- Lazy, cached model and client construction (`@lru_cache`), the `asyncio.to_thread` pattern for
  Supabase calls, and the chart/metric/table component vocabulary.
- The document search (Pinecone and embeddings) as a tool, not a mandatory pre-step.
- Using the LangGraph SDK's `useStream` on the client. Messages, interrupts and UI messages already
  flow through it, and `ChatProvider` already treats it as the single source of truth.

## 3. Target architecture

```
Browser (right-hand panel)
   |  useStream  (Supabase access token in Authorization header)
   v
LangGraph server  ──  Auth handler: verify JWT -> user + entity_id; threads are owner-scoped
   |
   v
Agent graph (create_agent, tool-calling loop + middleware)
   |-- data tools (typed)  ──>  Supabase client carrying the USER's JWT (RLS applies)
   |-- run_sql (guarded)   ──>  read-only role, RLS-enforced, timeout and row cap
   |-- search_documents    ──>  vector store, filtered by entity
   |-- show_* UI tools     ──>  push_ui_message (chart, table, metric, link card)
   |-- propose_action      ──>  interrupt() -> user approves -> call existing FastAPI endpoint
   `-- follow-ups          ──>  one structured-output step at the end of every turn
```

### 3.1 Identity and tenancy (do first)

- Add a LangGraph custom auth handler (`langgraph_sdk.Auth`, registered under `auth` in
  `langgraph.json`). It validates the Supabase access token, returns the user identity, and the
  business is looked up server-side from `entities.owner_id`, never read from the request.
- Add `@auth.on` handlers so threads and runs are filtered by owner. Another user's thread id then
  returns 404.
- The agent receives `entity_id` and the user's JWT through the run `context` (langgraph 1.x
  `context_schema` and `Runtime`), set by the auth layer, not by the client.
- Restrict CORS to the app origin(s) from config.

### 3.2 Data access (replaces free-form superuser SQL)

Order of preference, and the agent should reach for them in this order:

1. **Typed tools** for the common questions, each a small function over the Supabase client built
   from the user's JWT, so RLS decides the rows: revenue and spend by period, top products and
   customers, outstanding invoices, cash position, tax summary, inventory low stock, order and
   transaction search, journal lookups. These return structured data, not prose. This reuses the
   same aggregates the pages show, so the chat and the page cannot disagree (see 4.3).
2. **`run_sql` as a fallback**, not the default. It connects as a dedicated read-only role
   (`agent_readonly`), and for each call opens a transaction that sets the JWT claims and
   `SET LOCAL ROLE authenticated`, so the same RLS policies as the pages apply. SELECT-only
   (parsed, not pattern-matched), `statement_timeout` of a few seconds, a row cap, and an
   allow-list of tables and views. The schema shown to the model is generated from that allow-list,
   not hand-written in `prompts.py`.
3. Drop the Supabase MCP data path. Two routes to arbitrary SQL is one too many.

An e2e/security test is part of this phase: ask the agent for the rival business's data and assert
nothing comes back (extends the existing `rls.spec.ts` approach).

### 3.3 The agent

- Replace the hand-built graph with a single `create_agent` (langchain 1.x) loop: system prompt,
  tools, `context_schema`, and a checkpointer. The model decides when to call tools; the classify,
  retrieve, sufficiency and route nodes go away. Retrieval becomes the `search_documents` tool.
- Use middleware for the cross-cutting parts instead of nodes: summarise long threads, cap tool
  calls per turn, retry transient tool failures, model fallback, and inject page context and the
  business profile (currency, country, financial year) into the system prompt.
- Model configuration: one place (`core/config.py`), provider-prefixed ids through
  `init_chat_model`, a main model for the loop and a small cheap model for follow-ups. A local model
  stays available behind a setting for development only.
- Persistence: the LangGraph platform/server checkpointer for threads, plus the Postgres
  checkpointer if we self-host the FastAPI mount. A `Store` for per-user preferences (see 5.5).
- Document extraction leaves the chat graph. It becomes its own endpoint that the invoice upload
  flow already half-has; chat can still accept an attachment and hand it to that service as a tool.
- Streaming: `messages` for tokens, `updates` for tool steps, `custom` for progress, so the UI can
  show "Reading transactions for September" while it works. Stop (cancel the run) must work.

### 3.4 Generative UI

- **Tools produce the UI, not a second LLM call.** A data tool returns structured data. A `show_*`
  tool (or the data tool itself) calls `push_ui_message(name, props)` with exactly those rows, so the
  chart cannot disagree with the answer. `push_visualization_node` is deleted.
- A small, versioned catalogue, defined once as Pydantic models on the backend and mirrored as Zod
  schemas on the frontend (props are validated on both sides; unknown or invalid components render
  nothing and log, never crash the thread):
  `metric` (value, delta, period), `bar-chart`, `line-chart`, `table` (with row links),
  `link-card` ("Open in Transactions, filtered to September"), `summary-list`, `proposal`
  (an action awaiting approval).
- The components are built on the design kit and the chart theme from the redesign, so they work in
  light and dark and meet the contrast rules. They are rendered from a local registry keyed by
  name (not loaded as remote bundles), so styling and accessibility stay under our control.
- Every UI component that shows data carries a **source** (which tool, which period, a deep link to
  the page), shown as a quiet "Source" row. That is the audit trail for trust.

### 3.5 Follow-up questions (the important feature)

- At the end of every turn a final step produces 2 to 4 follow-ups with a small model and structured
  output (`{label, prompt}`), given the question, the tool results from this turn, and the page
  context. They must be answerable with the tools we have (no suggesting questions the agent cannot
  answer), and distinct from each other and from what was just asked.
- They are delivered as a `follow-ups` UI message attached to that turn, so they stream with the
  answer and are stored with the thread. Only the latest turn's chips are shown, and clicking one
  sends its `prompt` as the next user message (the label can be shorter than the prompt).
- Starter prompts for an empty thread depend on the page (on Invoices: "Which invoices are overdue?";
  on Tax: "What do I owe this quarter?"), from a static map first, personalised later.
- Clarifying questions use the same chip UI through `interrupt()` with options ("Which period?
  This month / Last month / This financial year"), so the user answers with a click and the run
  resumes. This is the human-in-the-loop path and also serves action approval (5.3).
- Quality rules, tested by evals: never repeat the question just asked, never offer something that
  would return an empty result when we can tell in advance, and degrade to no chips (not bad chips)
  if the step fails.

## 4. Frontend

### 4.1 Panel, not page

- Mount `ChatProvider` once in `AppLayout`, so the conversation survives navigation. The panel is a
  dock on the right: at 1280px and above it pushes the page content; below that it overlays with a
  scrim; on mobile it is a full-height sheet. Width is resizable and remembered, open/closed is
  remembered, and `⌘/Ctrl+J` toggles it (plus a visible launcher button in the app header).
- `/chat` stays as a route that opens the same thread full-width ("expand"), so existing links work
  and the thread list has a home. History (switch, rename, delete threads) lives in a popover in the
  panel header.
- Follows the design language: tokens only, kit components, state in the URL where it is shareable
  (`?thread=`), light and dark, reduced-motion respected, focus management (focus moves to the
  composer when opened, returns to the launcher when closed, Escape closes the overlay form),
  `aria-live` for streaming text, and axe/overflow tests at three widths in both themes like every
  other page.

### 4.2 Pieces

- Message list with tool-step rows ("Looked up revenue, Sept 2026"), markdown with tables, copy,
  thumbs up/down (stored, feeds evals), regenerate, edit-and-resend (a checkpoint fork), and clear
  error and retry states.
- Composer: multi-line, send/stop, attachment (images and PDFs go to the extraction tool), a
  removable **page context chip** ("Invoices, INV-0042") showing what the assistant can see.
- Generative UI renderer and registry (3.4), follow-up chips (3.5), proposal card with
  Approve/Dismiss (5.3).
- Delete the old `components/thread/*` (about 3,200 lines) and the 4 type errors with it.

### 4.3 One source of truth for figures

The page loaders and the agent's typed tools should call the same aggregate (a SQL view or function
in Supabase, which the redesign already moved toward). Where a page computes a number in a loader,
move that into the database and have both read it. Otherwise the assistant and the Reports page will
eventually disagree about revenue, which is the fastest way to lose trust.

## 5. Further inclusions

1. **Page awareness.** The panel sends `{route, entity ids in view, filters}` as run context. "Why
   is this invoice unmatched?" works without the user naming it.
2. **Deep links everywhere.** Answers link to the filtered page (`/transactions?month=2026-09`).
   Pages already keep state in the URL, so this is cheap and makes the chat a navigator.
3. **Actions with approval.** Phase it: read-only first. Then `propose_action` (match a payment to an
   invoice, mark a tax period, create a journal) shows a proposal card, pauses on `interrupt()`, and
   on Approve calls the existing FastAPI endpoint with the user's identity. Nothing is written
   without a click, and the endpoint, not the agent, enforces the rules.
4. **Prompt-injection hygiene.** Imported text (order notes, product titles, bank references) is
   untrusted. Tool results are wrapped and labelled as data in the prompt, tools cannot be chosen by
   text found in data, and write actions always need a user click.
5. **Memory.** A `Store` for stable per-user facts the user can see and delete ("my financial year
   starts in April", "show amounts in £k"), not a hidden profile.
6. **Limits and cost.** Per-user rate limit, a per-turn tool-call and token cap, and a visible
   "this is taking longer than usual" state.
7. **Observability.** LangSmith tracing with the entity id hashed, plus a latency/cost/error
   dashboard. Thumbs-down feeds a review queue.
8. **Evals.** A golden set of about 50 questions with expected figures computed from the seeded test
   business (the e2e seed already writes a manifest of known totals). Runs in CI against a fake or
   cheap model for tool selection and with the real model nightly. Checks: right tool, right figure,
   no cross-tenant data, useful follow-ups.
9. **Privacy and retention.** Decide how long threads are kept, offer "delete my chat history", and
   state what is sent to the model provider.
10. **Empty and failure states.** No data yet, integration not connected (link to Integrations),
    model down (fallback, then a clear message), and stale data ("last synced 3 days ago") on
    anything time-sensitive.

## 6. Phases

Each phase is a mergeable PR with tests.

| Phase                  | Work                                                                                                                                                                                                                      | Done when                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 0. Verify and decide   | Check this plan against the LangGraph docs (auth handlers, `context_schema`, `interrupt`, `create_agent` middleware, UI messages, Postgres checkpointer). Confirm open decisions (section 7). Delete confirmed-dead code. | Decisions recorded; dead code removed; spike shows an authed stream end to end.                                |
| 1. Tenancy             | Auth handler, owner-scoped threads, entity from JWT, CORS, RLS-scoped data access, `agent_readonly` role, remove MCP and superuser SQL.                                                                                   | Cross-tenant e2e test passes; old tools cannot be reached.                                                     |
| 2. Agent core          | `create_agent` loop, typed data tools, guarded `run_sql`, middleware, model config, checkpointer, extraction split out.                                                                                                   | Pytest with a fake chat model covers tools and routing; answers match the seeded manifest.                     |
| 3. UI contract         | Component catalogue (Pydantic and Zod), tool-driven UI, sources, follow-up step, `interrupt` options.                                                                                                                     | Contract tests on both sides; follow-ups appear and are clickable in a harness.                                |
| 4. Panel               | `AppLayout` dock, provider move, thread history, message/composer/step/chip components on the kit, `/chat` as expand, delete old components.                                                                              | Playwright (stand-in LangGraph stream) with axe and overflow at 3 widths x 2 themes; typecheck and lint clean. |
| 5. Context and actions | Page context, deep links, proposal cards with approval, memory.                                                                                                                                                           | Approve/dismiss e2e restores state; nothing writes without a click.                                            |
| 6. Quality and rollout | Evals in CI, tracing, limits, feedback, retention, docs (`CLAUDE.md`, `apps/ai_agent/CLAUDE.md`), flag to ship the panel behind a setting first.                                                                          | Eval thresholds set; docs current.                                                                             |

Phases 1 and 2 are backend-only and can start before any UI work. Phase 1 is worth shipping even if
the rest slips, because it closes finding 1 and 2.

## 7. Decisions (settled with the owner, 2026-10-18)

1. **Model for the main loop:** a hosted model with strong tool use (Claude or Gemini through
   `init_chat_model`), chosen by configuration, with the cheaper model for follow-ups. The local
   model stays available for development only. Pick the concrete default in Phase 0 after checking
   current model ids and the `GOOGLE_API_KEY`/Anthropic key already present in the environment.
2. **Hosting:** keep the LangGraph server mounting the FastAPI app (as `langgraph.json` does now) and
   put authentication in the LangGraph auth layer so both are covered.
3. **Write actions in v1:** none. v1 is read-only. Approval-gated actions arrive in Phase 5.
4. **`/chat` route:** kept, as the expanded view of the same thread the panel shows.
5. **Thread retention:** 90 days by default (the owner wrote "90s", read as 90 days; confirm if a
   shorter period was meant), with a "delete my chat history" control.
6. **Panel behaviour:** at 1280px and above it pushes the page content; below that it overlays;
   on mobile it is a full-height sheet.

## 8. Risks

- RLS-scoped SQL through a role switch is easy to get subtly wrong. The cross-tenant test and a
  review of the transaction wrapper come before anything else ships.
- Streaming UI messages plus interrupts plus checkpoint forks are the least-trodden parts of the
  SDK. Phase 0's spike should exercise all three.
- A guarded `run_sql` still lets a model write an expensive query. Timeouts, row caps and an
  allow-list contain it, but monitor it.
- Moving aggregates into the database (4.3) touches pages that already work. Do it per page, guarded
  by the existing e2e figures.

## 9. Phase 0 results and corrections (2026-10-18)

Checked against docs.langchain.com (the MCP servers were not loaded in that session, so the pages
were read directly) and against the installed packages. Branch: `feat/chat-agent-redesign`.

### 9.1 Confirmed as planned

- Custom auth: `Auth()` from `langgraph_sdk`, `@auth.authenticate` (returns `identity` plus any
  fields; they are readable in the graph at `config["configurable"]["langgraph_auth_user"]`),
  `@auth.on` handlers that mutate `value["metadata"]` on create and return a filter dict such as
  `{"owner": ...}`. Most specific handler wins (`@auth.on.threads.create`, then `@auth.on.threads`,
  then `@auth.on`). Proven live on `langgraph dev`: no token and bad token give 401, a second
  business's user gets 404 on the first one's thread and an empty search.
- `create_agent` takes middleware; built-ins exist for summarisation, model fallback, model/tool
  retry, model/tool call limits, context editing, PII, and human-in-the-loop. Custom hooks are
  `before_agent/before_model/after_model/after_agent` (state, runtime) and
  `wrap_model_call/wrap_tool_call` (request, handler); the system prompt is changed with
  `request.override(system_message=...)`; state is extended by subclassing `AgentState`.
- `interrupt()` needs a checkpointer and a stable `thread_id`; resume with `Command(resume=...)`;
  the node restarts from its top on resume, so side effects go after the interrupt.
- `push_ui_message(name, props, message=..., id=..., merge=True)` streams and updates UI messages;
  the React client can render registered local components through the `components` prop of
  `LoadExternalComponent` instead of fetching bundles.
- Thread retention: `checkpointer.ttl` in `langgraph.json` (`strategy: "delete"`,
  `default_ttl`, `sweep_interval_minutes`).

### 9.2 Corrections to the plan

1. **The REST API is not covered by LangGraph auth.** Custom routes in the mounted FastAPI app
   (`/accounting`, `/integrations`, `/chat`, `/oauth`, `/api/inngest`, ...) are not authenticated
   unless `http.enable_custom_route_auth` is set (confirmed: `GET /chat/data-sources` returns 200
   with no token). Section 3.1 assumed they were. The frontend also calls them with no credentials
   and passes `entity_id` in the body (`app/lib/api/*.ts`, `app/routes/api.inventory.tsx`), so any
   caller who can reach the backend can post journals for any business. This is a separate and
   larger hole than chat; see 9.4.
2. The auth module is loaded **by file path**, so it must use absolute imports
   (`from ai_agent.core.auth import ...`); a relative import fails at startup.
3. Anything blocking inside an async auth handler is rejected by the dev server (blockbuster).
   Fetching the JWKS is a blocking HTTP call, so verification runs in `asyncio.to_thread`.
4. `ai_agent/core/config.py` and `services/embedding_service.py` called
   `load_dotenv(..., override=True)`, so a value in `.env` silently beat the real environment
   (this pointed a "local" run at the hosted Supabase project). Changed to `override=False`.
5. TTL is in **minutes**, not days: 90 days is `129600`.
6. `interrupt(..., response_schema=...)` needs langgraph 1.2.12 or later; installed is 1.2.11.
   `langgraph-api` 0.14.1 is end-of-life (0.16.x current): upgrade both in Phase 2.
7. `HumanInTheLoopMiddleware(interrupt_on={tool: {"allowed_decisions": [...]}})` already provides
   approve / edit / reject for tool calls. Phase 5 action approval should use it rather than a
   hand-rolled `propose_action` where it fits; plain `interrupt()` stays for clarifying questions.
8. Store handlers (`@auth.on.store...`) isolate by rewriting `namespace`, not by returning a filter.
   Memory (section 5.5) needs them.
9. Not verifiable from the docs fetched: how `useStream` surfaces and resumes interrupts and forks
   from a checkpoint. The installed SDK (1.11.0) exposes `interrupt`, `interrupts`, `setBranch` and
   `getMessagesMetadata`; check the exact fork/resume call shapes at the start of Phase 4.

### 9.3 State of the backend baseline (before any of this work)

Backend CI cannot be green today, independent of this plan: `black --check` would reformat 50 of
74 files, `mypy` reports about 244 errors, and `tests/test_normalization.py::TestSquarespaceNormalizer::
test_normalize_profile` fails. New and changed files in this plan are held to black, isort, flake8,
mypy and bandit; the old backlog is not fixed as a side effect.

### 9.4 The rest of the backend (done: commits `aaadad4`, `6446084`, `2846b1a`)

Resolved as option (a). Every REST route now needs a signed-in user, a caller whose business
matches any `entity_id` it names, or the internal key; the app forwards the user's token. See
`apps/ai_agent/CLAUDE.md`, "Authentication and authorization". The analysis that led to it:

Securing `/accounting`, `/integrations` and the rest requires the frontend to forward the signed-in
user's access token (its server already has it via the session cookie) and each route to take the
business from the verified token instead of the request body. Webhook/Inngest/OAuth-callback routes
must stay reachable by their callers, so they need their own checks (Inngest signing key, the signed
OAuth `state`). Options: (a) a FastAPI dependency per router, applied route group by route group;
(b) `enable_custom_route_auth` plus an allow-list for the exempt paths. Recommendation: (a), as a
separate PR right after the chat work, because (b) cannot tell a browser route from a webhook.

### 9.5 Model

Only `GOOGLE_API_KEY` is configured (no Anthropic or OpenAI key). Default for the main loop and the
follow-up step: Gemini through `init_chat_model("google_genai:...")`, with the model id checked at the
start of Phase 2. Switching to Claude later is a config change.

### 9.6 Progress

| Item                                                                                                               | State                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verify plan against docs                                                                                           | Done (9.1 and 9.2)                                                                                                                                                                                                                                                                                                                   |
| Delete confirmed-dead modules (`core/nodes.py`, `core/state.py`, `tools/sub_agents.py`, `agents/middleware.py`)    | Done, commit `4937f32`                                                                                                                                                                                                                                                                                                               |
| Auth handler, owner-scoped threads, CORS limited to the app origins                                                | Done, commit `835eed4`, 15 tests                                                                                                                                                                                                                                                                                                     |
| Chat UI sends the access token                                                                                     | Interim fix in `ChatProvider` (client `onRequest` hook, `agentFetch`), commit `2846b1a`; Phase 4 replaces it                                                                                                                                                                                                                         |
| REST API authentication and authorization                                                                          | Done: `api/deps.py`, a guard on every router, ownership checks on id-only routes, internal key for machine routes, CORS limited; `tests/test_api_auth.py` (24 tests) fails on any unguarded route; the app forwards tokens; the e2e stand-ins refuse unauthenticated calls. Checked live against the local stack with two businesses |
| RLS-scoped data access (`agent_readonly` role, per-call transaction) and removal of the unscoped SQL and MCP paths | **Not done**: this is the rest of Phase 1. Until it lands, an authenticated user's questions can still read any business through `run_sql`.                                                                                                                                                                                          |
| Cross-tenant test on data access                                                                                   | Not done (needs the item above)                                                                                                                                                                                                                                                                                                      |
