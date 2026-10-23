# Data pipeline: sync and normalisation

Each business connects its providers on the Integrations page. The pipeline pulls their data,
stores it raw, normalises it into one canonical schema, and writes the canonical tables the rest of
the app (pages, ledger, chat agent) reads.

```
connect (POST /integrations/sources)        credentials into Vault, one external_sources row
        │
sync requested  ─▶  <provider>_sync_all  ─▶  <provider>_sync_endpoint  (one per endpoint, paginated)
                                                    │
                                                    ▼
                                        external_raw_events   (raw payload, processing_status = pending)
                                                    │  <provider>/sync.completed
                                                    ▼
                                        normalize_after_<provider>_sync  ─▶  normalize_source
                                                    │  provider normaliser → canonical models
                                                    ▼
                                        PersistenceService: idempotent upserts, parents first
                                                    │
                                                    ▼
          customers, orders, order_line_items, products, inventory_items, payments, payment_fees,
          bank_accounts, financial_transactions, calendar_events
```

Progress streams to the browser over Inngest realtime channels (`integrations/inngest/channels.py`,
one channel per source), which the frontend subscribes to with a token from
`POST /realtime/subscription-token`.

## Where things are

| Path                                                | What                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `integrations/<provider>/`                          | The provider's API client                                                                  |
| `integrations/inngest/<provider>_sync_functions.py` | Pull from the API, write `external_raw_events` (Squarespace is in `sync_functions.py`)     |
| `integrations/inngest/events.py`                    | Typed senders: `send_<provider>_sync_event`, ...                                           |
| `normalization/<provider>_normalizer.py`            | Raw payload → canonical models                                                             |
| `normalization/models.py`                           | The canonical models (`CanonicalOrder`, `CanonicalFinancialTransaction`, ...) and statuses |
| `normalization/inngest_functions.py`                | **The processing path**: dispatches to normalisers, persists, retries                      |
| `normalization/persistence.py`                      | `PersistenceService`: idempotent upserts, referential order, state updates                 |
| `normalization/service.py`                          | Stats and a synchronous fallback only (read its docstring); not the main path              |

## Inngest functions

All are registered on `/api/inngest` (28 in total).

| Group         | Function                                                                                | Trigger                                                                    |
| ------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Shopify       | `shopify_sync_all`, `shopify_sync_endpoint`, `shopify_sync_order_transactions`          | `shopify/sync.requested`, `.endpoint`, `.order_transactions.requested`     |
| Revolut       | `revolut_sync_all`, `revolut_sync_endpoint`                                             | `revolut/sync.requested`, `revolut/sync.endpoint`                          |
| PayPal        | `paypal_sync_all`, `paypal_sync_endpoint`                                               | `paypal/sync.requested`, `paypal/sync.endpoint`                            |
| Squarespace   | `squarespace_sync_all`, `squarespace_sync_endpoint`, `squarespace_sync_single_endpoint` | `squarespace/sync.requested`, ...                                          |
| Zoho Calendar | `zoho_calendar_sync_all`, `zoho_calendar_sync_endpoint`                                 | `zoho_calendar/sync.requested`, `.endpoint`                                |
|               | `zoho_calendar_push_daily`                                                              | cron `0 6 * * *`                                                           |
| Normalisation | `normalize_raw_event`, `normalize_batch`, `normalize_source`                            | `normalization/event.received`, `batch.requested`, `source.requested`      |
|               | `normalize_after_sync` (Squarespace), `normalize_after_<provider>_sync`                 | `<provider>/sync.completed`                                                |
|               | `reprocess_failed_events`                                                               | cron `0 */6 * * *`                                                         |
|               | `reprocess_stuck_processing_events`                                                     | cron `0 */2 * * *`                                                         |
|               | `reprocess_failed_manual`                                                               | `normalization/reprocess.requested`                                        |
| Accounting    | `generate_all_journals`                                                                 | `accounting/journals.generate.requested`                                   |
| Other         | `process_chat_message`, `process_document_embedding`, `cleanup_old_threads`             | `chat/message.received`, `documents/embedding.completed`, cron `0 2 * * *` |

## Raw events and their state

`external_raw_events.processing_status` is one of `pending`, `processing`, `completed`, `failed`,
`needs_review`. Raw payloads are never modified. `normalize_source` takes a mode:

- `soft` (default): only events still `pending`.
- `hard`: resets every event of the source to `pending` first, then reprocesses all of them.

Failed events are retried every six hours, and events stuck in `processing` every two;
`POST /normalization/reprocess-failed` lets a signed-in user retry their own.

## Normalisers

Every normaliser implements `BaseNormalizer.normalize(entity_type, external_id, payload,
raw_event_id) -> NormalizationResult`. The registry the Inngest path uses is
`PROVIDER_NORMALIZERS` in `normalization/inngest_functions.py`: Squarespace, Revolut, PayPal,
Shopify, Zoho Calendar. (`NORMALIZER_REGISTRY` in `service.py`, the fallback, has only the first
three.)

Persistence must be idempotent (the same input gives the same database state), write parents
before children, link each canonical row to its raw event, and update the raw event's state on
success and failure.

## Zoho Calendar (OAuth)

Every other provider uses credentials the user pastes in. Zoho Calendar needs a real three-legged
OAuth2 flow, because there is no credentials-only way into a person's own calendar:

- `GET /oauth/zoho_calendar/authorize-url` (signed-in user) returns Zoho's consent URL with a
  signed `state`: `base64(entity_id|nonce|exp)` + `.` + `hmac_sha256(zoho_client_secret, payload)`,
  valid for 10 minutes. The app's `/api/integrations/zoho/connect` route calls it and redirects,
  since a link cannot carry a token.
- `GET /oauth/zoho_calendar/callback` is reached by Zoho redirecting the browser (no token), so the
  signed `state` is what proves which business it is for. It exchanges the code, creates the
  "ThreadWise Deadlines" calendar and saves the `external_sources` row, then redirects to
  `FRONTEND_URL`.
- It works both ways: it pulls the user's events into `calendar_events`, and pushes tax deadlines
  and collection launches into the ThreadWise calendar (`services/calendar_push_service.py`). That
  calendar is excluded from the pull so pushed events are not imported back.

Zoho quirks the code handles on purpose (each fails silently if forgotten): errors come back as
HTTP 200 with an `{"error": ...}` body; the authorise URL needs both `access_type=offline` and
`prompt=consent`; refresh tokens are capped at 20 per user and the oldest is evicted, so
disconnecting revokes the token; write endpoints take a JSON string in a query parameter, not a
body; event times are in a nested `dateandtime` object. `reconcile_calendar_events` marks an
event `cancelled` when a pull no longer returns it.

## Adding a provider

1. An API client in `integrations/<provider>/`.
2. `<provider>_sync_functions.py`: `<provider>_sync_all` fanning out to a paginated
   `<provider>_sync_endpoint`, writing `external_raw_events`, sending `<provider>/sync.completed`
   at the end. Add a sender to `events.py`.
3. A normaliser in `normalization/<provider>_normalizer.py` implementing `BaseNormalizer`, added
   to `PROVIDER_NORMALIZERS` (and `NORMALIZER_REGISTRY` if the fallback should handle it).
4. `normalize_after_<provider>_sync` in `normalization/inngest_functions.py`.
5. Export them as `<PROVIDER>_SYNC_FUNCTIONS` and spread that into `FUNCTIONS` in
   `integrations/inngest/functions.py` (the list `main.py` serves on `/api/inngest`); the
   normalisation function goes in `NORMALIZATION_FUNCTIONS`.
6. Tests in `tests/test_normalization.py` with a recorded payload.
