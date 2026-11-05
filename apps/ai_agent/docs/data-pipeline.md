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

All are registered on `/api/inngest` (32 in total).

| Group         | Function                                                                                 | Trigger                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Shopify       | `shopify_sync_all`, `shopify_sync_endpoint`, `shopify_sync_order_transactions`           | `shopify/sync.requested`, `.endpoint`, `.order_transactions.requested`     |
| Revolut       | `revolut_sync_all`, `revolut_sync_endpoint`                                              | `revolut/sync.requested`, `revolut/sync.endpoint`                          |
|               | `revolut_sync_receipts` (invoked by `revolut_sync_all`)                                  | `revolut/sync.receipts`                                                    |
|               | `revolut_read_receipts` (sent by `revolut_sync_receipts`; one per integration at a time) | `revolut/receipts.read`                                                    |
|               | `revolut_merchant_sync` (invoices; invoked by `revolut_sync_all` and `_endpoint`)        | `revolut/sync.payment_requests`                                            |
| PayPal        | `paypal_sync_all`, `paypal_sync_endpoint`                                                | `paypal/sync.requested`, `paypal/sync.endpoint`                            |
| Squarespace   | `squarespace_sync_all`, `squarespace_sync_endpoint`, `squarespace_sync_single_endpoint`  | `squarespace/sync.requested`, ...                                          |
| Zoho Calendar | `zoho_calendar_sync_all`, `zoho_calendar_sync_endpoint`                                  | `zoho_calendar/sync.requested`, `.endpoint`                                |
|               | `zoho_calendar_push_daily`                                                               | cron `0 6 * * *`                                                           |
| Normalisation | `normalize_raw_event`, `normalize_batch`, `normalize_source`                             | `normalization/event.received`, `batch.requested`, `source.requested`      |
|               | `normalize_after_sync` (Squarespace), `normalize_after_<provider>_sync`                  | `<provider>/sync.completed`                                                |
|               | `reprocess_failed_events`                                                                | cron `0 */6 * * *`                                                         |
|               | `reprocess_stuck_processing_events`                                                      | cron `0 */2 * * *`                                                         |
|               | `reprocess_failed_manual`                                                                | `normalization/reprocess.requested`                                        |
| Accounting    | `generate_all_journals`                                                                  | `accounting/journals.generate.requested`                                   |
|               | `match_invoice_payments` (sent after a Revolut or PayPal sync is normalised)             | `invoices/match.requested`                                                 |
| Other         | `process_chat_message`, `process_document_embedding`, `cleanup_old_threads`              | `chat/message.received`, `documents/embedding.completed`, cron `0 2 * * *` |

## Attachments (Revolut receipts)

Revolut keeps receipts on expenses, not transactions: an expense names its `transaction_id` and
lists `receipt_ids`. That covers card receipts, bills attached to transfers, and Revolut's own
invoices for its fees. After the Revolut endpoints, `revolut_sync_all` invokes
`revolut_sync_receipts` (`integrations/revolut/receipts.py`), which:

- lists expenses since its own `receipts` watermark less 90 days (a receipt is often attached
  weeks after the payment), skipping receipts already stored;
- downloads each new file and copies it into the private `transaction-attachments` bucket, and
  records it in `transaction_attachments`, keyed by the provider's transaction id, so it does not
  depend on the transaction being normalised first and re-normalising never drops it.

Expenses are not stored as raw events and are not normalised. The Expenses API must be enabled
for the business by Revolut; without it (401/403) the step stops and the sync of transactions
carries on. The Transactions drawer lists the files and opens one through
`/api/transactions?attachment=<id>`, which reads the row as the user and redirects to a
five-minute signed link.

### Reading receipts into the invoice register

At the end of each run `revolut_sync_receipts` sends `revolut/receipts.read`, and does not wait
for it: `revolut_read_receipts` (`services/receipt_invoices.py`) reads the stored files in the
background, at most one run per integration at a time, 5 files a step and 100 a run (a full run
starts the next). For each file whose transaction has been normalised (the others wait for a
later run):

- the model classifies it as `invoice` (a supplier's invoice or bill, Revolut's fee invoices
  included), `receipt` (proof of payment that is not an invoice) or `other`, recorded in
  `transaction_attachments.document_kind` with `read_at`;
- an invoice on money going out is read with the same extraction as an upload and stored as a
  `PURCHASE` invoice with `origin = 'revolut_expense'`, `external_id` = the receipt id,
  `attachment_id` = the file and status `PAID`, linked to its transaction (`matched_by =
'sync'`). The register needs a number and a date: a document without them gets `RCPT-<receipt
id>` and the transaction's date, and one with no readable amounts takes the transaction's;
- if the transaction already pays an invoice (uploaded, or another file on the same expense),
  no second one is made: the file becomes that invoice's document if it has none.

A failed read is kept (`read_attempts`, `read_error`) and retried on later runs, three times in
all. These invoices cannot have their status or direction changed (the transaction paid them),
but they can be deleted, which is how a misread file is dismissed: the file stays on its
transaction and is not read again. Bills paid through Revolut BillPay keep their file on the
bill, which no Revolut API exposes, so they need an upload.

## Invoices sent from Revolut (Merchant payment requests)

An invoice sent from Revolut Business is a Merchant API order of type `payment_request`. The
Merchant API has its own secret key (Revolut Business, Merchant, APIs), separate from the Business
API token. The Integrations page shows one Revolut integration with two keys; behind it, because a
source row holds one Vault key, the Merchant key has its own row: provider `revolut_merchant`,
`external_account_id` = the Revolut row's id (`PUT`/`DELETE
/integrations/sources/{id}/merchant-key` add, replace or remove it; saving checks it; removing the
Revolut integration removes it; `/integrations/summary` folds it into the Revolut card as
`merchant`).

The invoices are the Revolut integration's `payment_requests` endpoint. `revolut_sync_all` runs it
after receipts, so the transactions their payments are matched to are already in, and a failure
there does not fail the sync; "Sync one thing" runs it through `revolut_sync_endpoint`. Both invoke
`revolut_merchant_sync` with the Revolut source id; it reads the key from the child row, is skipped
without one, reports progress on the Revolut card's channel and keeps its sync state on the
Revolut row. It (`integrations/revolut/merchant.py` maps, `services/revolut_invoice_sync.py`
writes):

- reads the whole order list every run (there are few, and a request is paid long after it is
  created, so a watermark would miss the change), keeping `payment_request` orders only;
- upserts each as a SALE invoice with `origin = 'revolut_merchant'`, `external_id` = the order
  id, its reference as the number, its customer as a contact, and Revolut's state as the status
  (`pending` open, `completed` paid or part paid, `cancelled`/`failed` cancelled). The order
  amount is the total: lines describe it but need not add up (a deposit request lists the whole
  order). Lines are only replaced when Revolut's change, so an account chosen for a line stays;
- links each paid order's payment to its inbound "Merchant payment" from the Business sync
  (same gross amount and currency, from 10 minutes before to 2 days after the payment, closest
  first; observed 2 to 3 seconds after), `matched_by = 'sync'`. A payment whose transaction has
  not arrived yet is tried again on the next run.

Orders are not raw events and are not normalised, so the card has no "Load data". Revolut
offers no PDF, due date or tax breakdown for these invoices. The acquiring fee is journaled from
the Business API's merchant payment, which carries it on its leg (see below), not from the order.

## Moves between the business's own Revolut accounts

The normaliser stores a non-exchange transaction from one leg. A move between two of the
business's accounts has two legs, so stored from one it read as money leaving: a merchant
payment's settlement (merchant account to a second merchant account) and payout (to the main
account) would have been journaled as expenses. `internal_move_legs` recognises such a move on
its own, whenever it arrives: two or more legs, each on an account, none with a counterparty, in
one currency, adding up to nothing (every payment to or from someone else has one leg). It is
stored from the side the money left, excluded (`Moved between your own Revolut accounts`), with
`metadata.internal_move` and the legs; the Transactions page shows it as an "Internal move", with
its own status filter. Each leg's `fee` is kept as `metadata.fee`; only merchant payments journal
it so far (card payments abroad carry one too). Migration `20261101000000_revolut_internal_moves`
applied the same to what was already stored, leaving any move that already had a journal.

The list endpoint's paging is undocumented; `MerchantAdapter.list_orders` pages backwards on
`to` = the oldest `created_at` seen and stops when a page brings nothing new. The API version
is pinned (`Revolut-Api-Version: 2024-09-01`), because the response shape depends on it.

## Order lines and products

An order line is linked to its product (`order_line_items.product_id`) when its order is loaded,
by `product_external_id`, and only if the product is already in the app. A product that arrives
later (a sync that starts after the first orders, or a product added to the store afterwards)
would leave those lines unlinked for good, and the Products page would list it twice: once with
the sales since it arrived, once by name with the sales before. So saving a product also links
the unlinked lines of that business and provider that name it (`_link_order_lines`). Lines
that name no product the app has stay unlinked, and the Products page lists them by name as
"No longer sold".

## Stock quantities

The store the business sells through decides how many it has. Nothing in the app asks for a stock
count, and invoices never write one (see [Invoices](accounting.md#invoices)).

- **Shopify:** an item's `available_quantity` is its on-hand (`quantity_source = 'shopify'`),
  kept current by the inventory-level sync. Shopify items record no movement for a count change;
  their movements are sales and disposals, kept for the cost each carried.
  The products sync asks for active products only. **Sync with drafts** (the Sync menu on a
  Shopify card, `include_drafts` on `POST /integrations/sources/{id}/sync`) also fetches drafts, and
  fetches the products in full, because drafts that already exist were never fetched and an
  incremental fetch would skip them. Archived products are never fetched. A draft arrives with
  `products.status = 'draft'`.
- **Squarespace:** an item is `ledger` sourced. The sync stores Squarespace's count and records
  each change as an `ADJUSTMENT` movement (`count_change_note`: "Squarespace sync: 5 → 3"), and
  on-hand is the sum of movements. Another store would take this path too.
- **Samples** are counted on the ledger and never valued.

Product and item rows are keyed by provider, so syncing a product from a second store never
overwrites the first store's: the same product then exists twice, and the older one is put away
by archiving its product (an archived product's items are hidden on the Inventory page and left
out of the negative-stock check) and zeroing its count.

Unit cost comes from the store's own item cost and is filled in only while an item's cost is
zero. A later change in the store does not reach the app unless `SHOPIFY_ALLOW_UNIT_COST_OVERWRITE`
is set; leave it off unless stock should be valued at the store's current cost, because a cost
change moves stock value with no journal, and it shows as a difference in the books-versus-stock
check (see [Stock value against the books](accounting.md#stock-value-against-the-books)).

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
