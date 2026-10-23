# REST API

The FastAPI app in `main.py` mounts the routers in `api/routes/__init__.py`. Under `langgraph dev`
it is served next to the LangGraph API on the same port (`:2024`); alone with uvicorn on `:8000`.
OpenAPI docs are at `/docs`.

**Every route has a guard** (see [security.md](security.md#the-rest-api)). The browser sends the
user's Supabase token: client code uses `agentFetch` (`apps/chat-ui/app/lib/api/agent-auth.ts`),
server routes pass `requestAccessToken(request)` to `callAgent`. A plain `fetch` gets 401.

Guards below: **user** = `current_user`; **entity** = `entity_guard` (any `entity_id` must be the
caller's); **owned** = also an `owned_*` check on the id in the path; **internal** = `X-Internal-Key`;
**public** = none, on purpose.

## Health (`api/routes/health.py`)

| Method | Path      | Guard  |
| ------ | --------- | ------ |
| GET    | `/`       | public |
| GET    | `/health` | public |
| GET    | `/stats`  | public |

## Accounting (`/accounting`, `api/routes/accounting.py`)

Router guard: **entity**, except `/health-checks` (**internal**).

| Method | Path                                | Notes                                         |
| ------ | ----------------------------------- | --------------------------------------------- |
| GET    | `/chart-of-accounts`                |                                               |
| POST   | `/chart-of-accounts/seed`           | Standard chart for a new business             |
| GET    | `/health-checks`                    | **internal**                                  |
| POST   | `/inventory/disposal`               | Gift or write-off, with its journal           |
| POST   | `/clean-paypal`                     |                                               |
| POST   | `/reconcile-invoices`               | Mark invoices paid from matching transactions |
| POST   | `/detect-duplicates`                | Cross-provider duplicates                     |
| GET    | `/journals`                         |                                               |
| GET    | `/journals/review-summary`          | What needs a person                           |
| POST   | `/journals/accrue`                  |                                               |
| POST   | `/journals/suggest-accounts`        | LLM suggestions for drafts                    |
| POST   | `/journals/{journal_id}/reverse`    | owned                                         |
| POST   | `/journals/{journal_id}/post-draft` | owned                                         |
| POST   | `/journals/purchase-invoice`        |                                               |
| POST   | `/journals/sale-invoice`            |                                               |
| POST   | `/journals/invoice-payment`         |                                               |
| POST   | `/journals/expense`                 |                                               |
| POST   | `/journals/generate-all`            | Synchronous; the UI uses the Inngest job      |
| POST   | `/invoices/process`                 | Upload and extract                            |
| GET    | `/invoices`                         |                                               |
| GET    | `/invoices/{invoice_id}`            | owned                                         |
| PATCH  | `/invoices/{invoice_id}`            | owned                                         |
| PATCH  | `/invoices/{invoice_id}/status`     | owned; lifecycle rules, 409 if not allowed    |
| DELETE | `/invoices/{invoice_id}`            | owned                                         |
| POST   | `/invoices/{invoice_id}/stock`      | owned                                         |
| GET    | `/contacts`                         |                                               |
| POST   | `/contacts`                         |                                               |
| GET    | `/transactions`                     |                                               |
| GET    | `/transactions/{transaction_id}`    | Filtered by the guarded `entity_id`           |
| PATCH  | `/transactions/{transaction_id}`    | Filtered by the guarded `entity_id`           |

## Integrations (`/integrations`, `api/routes/integrations.py`)

Router guard: **entity**, except `/entities` (**internal**).

| Method   | Path                                      | Notes                            |
| -------- | ----------------------------------------- | -------------------------------- |
| POST/GET | `/entities`                               | **internal**                     |
| POST     | `/sources`                                | Connect a provider               |
| GET      | `/sources`                                |                                  |
| GET      | `/sources/{source_id}`                    | owned                            |
| DELETE   | `/sources/{source_id}`                    | owned                            |
| PUT      | `/sources/{source_id}/api-key`            | owned                            |
| POST     | `/sources/{source_id}/sync`               | owned; sends the sync event      |
| POST     | `/sources/{source_id}/validate`           | owned                            |
| GET      | `/sources/{source_id}/stats`              | owned                            |
| POST     | `/sources/{source_id}/normalize`          | owned                            |
| GET      | `/transactions/incomplete`                | owned (`source_id` in the query) |
| PUT      | `/transactions/{transaction_id}/category` | owned                            |
| POST     | `/transactions/ai-categorize`             |                                  |
| GET      | `/chart-of-accounts`                      |                                  |
| GET      | `/summary`                                |                                  |

## OAuth (`/oauth`, `api/routes/oauth.py`)

| Method | Path                           | Guard                  |
| ------ | ------------------------------ | ---------------------- |
| GET    | `/zoho_calendar/authorize-url` | user                   |
| GET    | `/zoho_calendar/callback`      | public; signed `state` |

## Realtime (`/realtime`, `api/routes/realtime.py`)

Router guard: **user**; the source is checked with `assert_owned`.

| Method | Path                    | Notes                                   |
| ------ | ----------------------- | --------------------------------------- |
| POST   | `/subscription-token`   | Token for one source's progress channel |
| GET    | `/channels/{source_id}` | owned                                   |

## Normalisation (`/normalization`, `api/routes/normalization.py`)

Router guard: **internal**, except `/reprocess-failed` (**user**, own sources only).

| Method | Path                      |
| ------ | ------------------------- |
| POST   | `/process`                |
| POST   | `/batch`                  |
| POST   | `/normalize-source`       |
| POST   | `/reprocess-failed`       |
| POST   | `/trigger/{raw_event_id}` |
| GET    | `/stats`                  |
| GET    | `/canonical-counts`       |

## Embeddings (`/embeddings`, `api/routes/embeddings.py`)

Router guard: **internal**. `GET /health`, `POST /embed`, `POST /search`, `POST /hybrid-search`,
`DELETE ""`, `GET /categories`, `GET /stats`, `DELETE /namespace`.

## Inngest (`/inngest` and `/api/inngest`)

- `/inngest/health`, `/inngest/trigger-cleanup`: **internal**.
- `/api/inngest` (GET, POST, PUT): the Inngest SDK endpoint; requests are signature-checked.

## Chat (`/chat`, `api/routes/chat.py`) — legacy

Router guard: **user**. Only `GET /chat/data-sources` is used (by the current chat page). The
others (`POST ""`, `/threads`, `/threads/{thread_id}/messages`, `/assistants`, `/health`) go
through `services/langgraph_service.py`, which calls the LangGraph server without the user's
token, so the auth layer refuses them. The chat UI talks to the LangGraph API directly instead
(`/threads`, `/runs`, with the user's token). Expect these routes to be removed.

## Keeping this page current

`tests/test_api_auth.py` fails on a route with no guard, so a new route cannot slip in unguarded,
but it does not update this page. Add the route here in the same change.
