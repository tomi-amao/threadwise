# Architecture

## One service, three jobs

All code is under `src/ai_agent/`. Three largely independent subsystems share one FastAPI app and
one Supabase (Postgres) database:

| Subsystem         | What it does                                                          | Main code                                                    | Page                                 |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| Chat agent        | Answers the owner's questions about their own business. Read-only.    | `agents/`, `tools/`, `core/scoped_sql.py`                    | [chat-agent.md](chat-agent.md)       |
| Data pipeline     | Pulls data from providers, normalises it, stores canonical records.   | `integrations/`, `normalization/`                            | [data-pipeline.md](data-pipeline.md) |
| Accounting engine | Turns payments, transactions and invoices into double-entry journals. | `services/journal_service.py`, `services/account_mapping.py` | [accounting.md](accounting.md)       |

Shared pieces: `core/config.py` (settings), `core/auth.py` and `api/deps.py` (who is calling,
see [security.md](security.md)), `core/supabase_client.py` (the service-role database client) and
`api/routes/` (the REST API, see [api.md](api.md)).

## Processes

```
                      ┌──────────────────────────── LangGraph server (langgraph dev, :2024) ───┐
browser ── chat ────▶ │  /threads, /runs  ──▶  auth.py  ──▶  chat agent (agents/chat_graph.py) │
  (Supabase token)    │                                                                        │
browser / app server ▶│  /accounting, /integrations, ... ──▶ FastAPI app (main.py, http.app)   │
  (Supabase token)    │  /api/inngest  ◀──── Inngest (signed requests)                         │
                      └────────────────────────────────────────────────────────────────────────┘
                                      │                         │
                       psycopg2 as the user (RLS)     PostgREST, service role
                                      ▼                         ▼
                                     Supabase Postgres (one database)
```

- **`langgraph dev` / LangGraph Platform** is the main process. `langgraph.json` registers the
  chat graph, the auth handler (`src/ai_agent/auth.py`), CORS, checkpoint retention (90 days), and
  mounts the FastAPI app under `http.app`, so one server answers both the agent API and the REST
  API.
- **`uvicorn ai_agent.main:app`** runs the FastAPI app alone (port 8000). It serves the REST API
  and the Inngest endpoint but not the chat agent. Use it when you are only working on REST routes.
- **Inngest** (`inngest-cli dev` locally) runs the background functions: provider syncs,
  normalisation, journal generation, scheduled jobs. It calls back into `/api/inngest`.

`pnpm dev:all` at the repo root starts the frontend, `langgraph dev` and the Inngest dev server
together. See [development.md](development.md).

## Two database paths: do not mix them up

| Path                | Code                                  | Runs as                                                              | Used by                                      |
| ------------------- | ------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| Service-role client | `core/supabase_client.py`             | The service key. **Bypasses row-level security.**                    | Nearly all business logic: pipeline, ledger. |
| User-scoped SQL     | `core/scoped_sql.py` (`DATABASE_URL`) | The signed-in user, inside a READ ONLY transaction, **with RLS on.** | The chat agent's tools only.                 |

Because the service-role client sees every business, a route that uses it must have checked who
the caller is first (`api/deps.py`). The agent never uses it: what the agent can read is decided
by the database's own row-level-security policies, the same ones the app's pages are held to.

The service-role client is synchronous; calls are wrapped in `asyncio.to_thread(...)` everywhere.
`get_supabase_client()` is an `@lru_cache` singleton that returns `None` when Supabase is not
configured, so handle that.

## Conventions that hold across the service

- **Lazy, cached clients.** Models and API clients are built on first use (`@lru_cache` or a
  factory), never at import, so modules import cleanly in tests and CI without keys.
- **Absolute imports in `auth.py`.** The server loads it by file path, so relative imports fail.
- **No blocking calls in async code on the LangGraph server.** The dev server rejects them
  (blockbuster). Wrap synchronous I/O in `asyncio.to_thread`.
- **Environment beats `.env`.** `load_dotenv(override=False)`: a variable set in the real
  environment wins over the file.
- **Inngest is the processing path.** `normalization/service.py` and
  `JournalService.generate_all_journals` run the same logic synchronously for tests, scripts and
  when Inngest is not running; new processing logic goes in the Inngest functions.

## Notifications

What needs the user is a row in `notifications` (migration `20261107000000_notifications.sql`),
shown under the bell in the app's sidebar and phone header. The agent writes them with
`services/notifications.py`:

- `notify(entity_id, kind, key, title, body, link)` opens a notification about `key` (the thing
  it is about, such as `integration_access:<source id>`), or refreshes the open one. Only one per
  business and key is open at a time (a partial unique index), so a check that runs every day
  does not pile up copies, and refreshing does not mark a read notification unread again.
- `resolve(entity_id, key)` closes it when the problem is gone; the bell no longer lists it.
- `link` is a path inside the app; anything else is refused (and the column checks it too).

Users read their business's notifications in the browser through row-level security and may
change only `read_at` (a column grant); they cannot create, reword or delete one.

What opens and closes them is `services/integration_checks.py`, run by the Inngest functions in
`integrations/inngest/notification_functions.py`:

| Key                              | Opened when                                          | Resolved when         |
| -------------------------------- | ---------------------------------------------------- | --------------------- |
| `integration_access:<source id>` | the provider refuses the stored key                  | a check succeeds      |
| `integration_stale:<source id>`  | no sync for 14 days (the page's amber "Last synced") | a sync within 14 days |
| `journals_needed`                | Generate journals would still journal something      | nothing is left       |

- `check_integrations_daily` (cron, 06:00 UTC) sends `notifications/integrations.check.requested`
  for each business with an integration; `check_business_integrations` checks each source (one
  step per source) and the journals count. Hidden integrations are checked like the rest.
- The provider checks are `services/source_access.py`, shared with the page's Check key button.
  Each answers works (`True`), refused (`False`: 401/403, an unknown shop, a revoked Zoho token,
  a missing or malformed key) or no answer (`None`: a timeout, a 5xx, a rate limit). No answer
  changes nothing, so a provider's bad night does not tell anyone their connection broke.
- A refused key also sets `api_key_status` to `invalid`, so the page agrees with the bell; a
  source whose key is refused gets no "hasn't synced" notification on top.
- The journals count (`JournalService.count_awaiting_journals`, the pipeline's own four finders,
  read only) is also refreshed after every load (`normalize_source` sends
  `notifications/journals.check.requested`) and after Generate journals, debounced per business
  for two minutes (`check_journals_after_load`). It links to `/integrations?journals=1`, which
  opens Generate journals. Something the pipeline cannot journal stays counted until it is fixed.
