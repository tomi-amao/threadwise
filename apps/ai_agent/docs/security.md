# Security: who a request is for, and what it may see

The rule for the whole service: **nothing trusts the caller's word about who they are or which
business they mean.** The business always comes from a verified token, never from the request body,
the query string or the model.

## Identity

A user signs in to the app with Supabase and sends the access token as
`Authorization: Bearer <jwt>`.

`core/auth.py`:

1. `verify_access_token` checks the signature against the Supabase project's JWKS (asymmetric
   keys; `SUPABASE_JWT_SECRET` only for legacy HS256 projects), the expiry, and
   `aud = authenticated`. Fetching the JWKS is a blocking HTTP call, so it runs in a thread.
2. `entity_id_for_user` looks up the user's business: `entities.owner_user_id = <user id>`.
3. `authenticate_bearer` returns an `AuthenticatedUser` (user id, email, entity id, token) or raises
   `AuthError`.

A user with no business yet gets 403, not an empty answer.

## The LangGraph API (threads, runs)

`src/ai_agent/auth.py` is registered under `auth` in `langgraph.json`:

- `@auth.authenticate` rejects a request without a valid token (401) and returns
  `{identity, entity_id, ...}`. The server makes this available to the graph as
  `config["configurable"]["langgraph_auth_user"]`, and **overrides anything a client sends under
  that key**, so a client cannot claim to be someone else.
- `@auth.on` stamps every new thread, run and assistant with `metadata.owner = <user id>` and
  filters every read to it. Another user's thread id returns 404, and a search returns only your
  own.

The file is loaded by path: use absolute imports (`from ai_agent.core.auth import ...`).

## The REST API

LangGraph auth does not cover the mounted FastAPI routes, so every router carries a FastAPI
dependency from `api/deps.py`:

| Guard                                                                 | Use it for                                                  | Refuses with                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `current_user`                                                        | Any route a signed-in user calls                            | 401 no/bad token, 403 no business                                                                 |
| `entity_guard`                                                        | Routes that take an `entity_id` anywhere                    | 403 if any `entity_id` in the path, query, JSON body (however nested) or form is not the caller's |
| `owned_source`, `owned_invoice`, `owned_journal`, `owned_transaction` | Routes that name a record by id alone                       | 404 if the record belongs to another business                                                     |
| `assert_owned(user, table, id)`                                       | The same check inside a handler, when the id is in the body | 404                                                                                               |
| `require_internal`                                                    | Machine-only routes                                         | 401 unless `X-Internal-Key` equals `INTERNAL_API_KEY`; with no key configured, nobody gets in     |

Routes under `entity_guard` that read by an id **and** an `entity_id` (for example
`GET /accounting/transactions/{transaction_id}?entity_id=...`) must filter their query on both;
the guard checks the `entity_id`, the filter makes the id meaningless for anyone else's rows.

Machine-only (internal key): `/integrations/entities`, `/embeddings/*`, `/normalization/*` except
`reprocess-failed`, `/inngest/*`, `/accounting/health-checks`.

Public on purpose: `/`, `/health`, `/stats`, the Zoho OAuth callback (it checks a signed `state`
instead, see [data-pipeline.md](data-pipeline.md#zoho-calendar-oauth)), and `/api/inngest` (the
Inngest SDK verifies request signatures; set `INNGEST_SIGNING_KEY` and do not set `INNGEST_DEV` in
production).

`tests/test_api_auth.py` walks every route and fails if one has no guard or answers an anonymous
request. See [api.md](api.md) for the full list.

### Adding a route

1. Put it on a router that already has the right guard, or give its router one.
2. If it names a record by id, add the matching `owned_*` dependency (or write one with
   `assert_owned`).
3. If it uses the service-role client, read the record **as scoped by the guard** before writing.
4. Run `poetry run pytest tests/test_api_auth.py`.

## The chat agent's database access

The model writes SQL and reads imported text (order notes, product names, bank references), so
its access must not depend on it behaving. `core/scoped_sql.py` runs everything **as the signed-in
user with row-level security on**:

- A READ ONLY transaction, `SET LOCAL ROLE authenticated`, the user's id set as the JWT claim
  (`request.jwt.claims`), a statement timeout, and at most 200 rows fetched through a server-side
  cursor. Then a rollback. The same RLS policies as the app's pages decide which rows exist.
- `run_query(user_id, sql)` is for SQL the model wrote. It first passes `check_query`, which parses
  with Postgres's own parser (pglast) and accepts exactly one plain SELECT over the tables and views
  in `ALLOWED_RELATIONS`, calling only functions in `ALLOWED_FUNCTIONS`. The function list is the
  important part: `set_config` could rewrite the identity RLS reads, and `pg_read_file` or `dblink`
  reach outside the database. CTE names are scoped, so a CTE cannot shadow a forbidden table.
- `run_trusted(user_id, sql, params)` is for fixed, parameterised SQL written in this codebase (the
  typed tools). It skips the parser, because placeholders do not parse, and keeps everything else.
  **Never pass it text the model wrote.**

There is no separate read-only database role: the RLS policies are written `to authenticated`, so
another role would see no rows. `DATABASE_URL` must be a role that can `SET ROLE authenticated`
(`postgres` on Supabase).

Document search uses the vector namespace of the caller's business (`namespace = entity_id`),
never the default namespace.

`tests/test_scoped_sql.py` (30 refused statements, plus two real businesses) and
`tests/test_chat_agent.py` (every tool, as both seeded businesses) prove this.

### Adding a table the agent can read

1. Make sure it has an owner-of-the-entity RLS policy (`supabase/migrations/`).
2. Add it to `ALLOWED_RELATIONS`.
3. Add a case to `tests/test_scoped_sql.py` and the table to `apps/chat-ui/e2e/rls.spec.ts`.

Leave out credential and raw tables on purpose (`external_sources`, `external_raw_events`, sync
state, logs, backups).

## What the agent can change

By default nothing: its SQL is read-only. The only writes are the proposals in
[chat-agent.md](chat-agent.md#actions-the-user-must-approve), and they hold four lines:

- **A click.** The run pauses before any write; only an explicit `{"decision": "approve"}`
  continues. A dismissal, silence or a malformed answer writes nothing.
- **The user's identity.** The write goes through the existing endpoint with the user's own
  token, so the endpoint's guards, ownership checks and business rules apply. A run without the
  token cannot act at all (`call_app` refuses).
- **A verified description.** What the user is asked to approve is built from a read as that user,
  not from what the model said.
- **No injection into memory.** Saving a memory needs approval too, and memories are per user:
  `auth.py`'s `@auth.on.store` handler nests every namespace under the caller's id.

The page context the browser sends is a name only. The server re-reads the record as the user
(`agents/page_context.py`); another business's id reads as nothing, and the label is never used.

`tests/test_actions.py` proves each of these, including against the real endpoint (an approved
change really happens, a dismissed one does not, another business's token is refused), and puts
the record back afterwards.

## Secrets

- Provider credentials each user enters are stored per `external_sources` row in Supabase Vault
  (see `docs/secure-api-key-workflow.md` at the repo root).
- `ZOHO_CLIENT_ID`/`ZOHO_CLIENT_SECRET` are app-wide (ThreadWise is the registered OAuth client);
  each business's Zoho refresh token still goes into Vault per row.
- `apps/chat-ui/.env.local` is tracked in git with live keys. Do not add to it.
