# Accounting engine

ThreadWise keeps a double-entry ledger for each business, generated from the canonical records the
pipeline writes. The Reports, Journals and Tax pages, and the chat agent's `profit_and_loss`, all
read it.

Code: `services/journal_service.py` (`JournalService`, the journals), `services/account_mapping.py`
(which account each entry goes to), `services/invoice_service.py` and `services/invoice_rules.py`
(invoices), `services/reconciliation_service.py` (matching and duplicates). Routes are under
`/accounting` ([api.md](api.md)).

## Tables

- `chart_of_accounts`: one per business; `account_number`, `account_type` (`asset`, `liability`,
  `equity`, `revenue`, `cogs`, `expense`), `normal_balance`, `is_header`, `status`. Seeded with the
  standard chart by `POST /accounting/chart-of-accounts/seed`.
- `journals`: one entry, with `journal_date`, `status` (`draft`, `posted`, `reversed`), and its
  source (`source_type`, `source_id`).
- `journal_line_items`: the lines, each a debit or a credit on one account, with `currency` and,
  for non-GBP lines, `gbp_equivalent`. The ledger reports in GBP.

## Journal types

| Journal            | From                                                                                                                              | Method                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Accrual            | A captured payment: debit clearing (net of gateway fees) and bank charges; credit revenue, shipping and tax from the linked order | `create_accrual_journal`         |
| Settlement         | An inbound gateway payout (Stripe or PayPal to Revolut): debit cash, credit clearing. No fee line (fees were taken at accrual)    | `create_settlement_journal`      |
| Funding            | An inbound personal or external transfer; a Revolut merchant payment books its fee (below)                                        | `create_funding_journal`         |
| Sales receipt      | A direct PayPal sale                                                                                                              | `create_sales_receipt_journal`   |
| Refund             | An inbound refund transaction                                                                                                     | `create_refund_journal`          |
| Refund reversal    | A refunded order: reverses its revenue, cost and stock                                                                            | `create_refund_reversal_journal` |
| FX conversion      | A currency conversion between accounts                                                                                            | `create_fx_conversion_journal`   |
| Expense            | An outbound bank transaction: debit the resolved expense account, credit cash                                                     | `create_expense_journal`         |
| Cost of goods sold | A fulfilled order                                                                                                                 | `create_inventory_cogs_journal`  |
| Disposal           | A gift or write-off of stock: one dated movement plus its journal                                                                 | `record_inventory_disposal`      |

A Revolut merchant payment (`reserve_release`) is a funding journal, and carries Revolut's fee
when the transaction has one (`metadata.fee`, taken from the leg by the normaliser): debit cash
with what reached the account, debit 8020 Bank charges with the fee, credit 4030 Wholesale
revenue with what the customer paid (`merchant_fee`; a foreign payment's fee is scaled to its GBP
amount). The settlement and payout that take the money on to the main account are moves between
the business's own accounts, excluded at normalisation, so the one journal is the whole of it.
Each journal stands on its own, so the order the three arrive in does not matter.

Every journal comes from a money movement (a payment, a bank transaction, a stock movement) or a
manual adjustment. Invoices are not a source: see [Invoices](#invoices).

Rules every journal follows:

- **Debits equal credits** within `BALANCE_TOLERANCE` (`Decimal("0.01")`), or it is not written.
- **Idempotent:** a source record gets its journal once; running generation again does not
  duplicate it.
- **Accounts come from `account_mapping.py`**, never hard-coded numbers (below).
- A posted journal is never edited. `reverse_journal` voids it (`status = 'reversed'`). This is a
  soft void: every balance reader filters to `posted`, so no opposite entry is written (that would
  remove the amount twice). A draft can be fixed with `update_draft_journal_account`, which then
  posts it.

## Account mapping

`account_mapping.py` is the single source of truth for which account a purpose resolves to.

- `resolve_cash_account(provider, currency)`: the bank or clearing account.
- `resolve_expense_account(...)`, first match wins:
  1. `metadata.expense_category` via `CATEGORY_ACCOUNT_MAP`
  2. `metadata.account_code` via `NORMALISER_CODE_MAP` (legacy normaliser codes such as `6200`)
  3. Known reference patterns in `metadata.invoice_id`: Royal Mail Click & Drop (outbound
     shipping), a `PISSX` prefix (a stock purchase, or a sampling run under 300), UPS tracking
  4. Keywords in the description or counterparty
  5. The transaction type (fee → bank charges, refund → returns)
  6. `UNCATEGORISED_FALLBACK` (8090 Miscellaneous Expense), and the journal is written as **draft**
     for a person to review, rather than posted to a guess.
- Header accounts (`is_header = true`) are never posting targets. `6999` is not a valid fallback.
- Account ids are cached in memory; call `clear_account_cache()` after changing the chart.

`POST /accounting/journals/suggest-accounts` asks an LLM for a better account for each draft; the
user accepts or changes it before it is posted.

## Generating journals

The Journals page triggers `accounting/journals.generate.requested`, which runs
`generate_all_journals_job` (`integrations/inngest/journal_generation_functions.py`) in the
background with step-level retries and realtime progress:

1. Accrue payments (`auto_journal_payments`)
2. Settle payouts (`auto_journal_settlements`)
3. Journal inbound transactions (`auto_journal_inbound`)
4. Journal expenses (`auto_journal_expenses`)

`JournalService.generate_all_journals(entity_id, scope)` runs the same sequence synchronously
(`scope` = `payments`, `transactions` or all), for tests, scripts and when Inngest is not running.
`GET /accounting/journals/review-summary` lists what needs a person afterwards.

## Invoices

Invoices are documents, not ledger entries. The money an invoice describes reaches the books
through the transaction that settles it (an expense, receipt or settlement journal above), so an
invoice never posts, and changing its status or deleting it changes no balance. Matching an
invoice to its transaction links the two; it does not post either.

### Where an invoice comes from

`invoices.origin` says where the record came from:

| `origin`           | What it is                                                  | Who changes it                       |
| ------------------ | ----------------------------------------------------------- | ------------------------------------ |
| `upload`           | A document someone uploaded on the Invoices page            | The business                         |
| `revolut_merchant` | A payment request sent from Revolut (a sales invoice)       | The sync; status follows Revolut     |
| `revolut_expense`  | A supplier invoice read from a receipt on a Revolut expense | The sync; status follows the payment |

`external_id` is the provider's id (unique per business and origin, so a sync upserts), and
`attachment_id` points at the stored receipt it was read from. A synced invoice's status and
direction are not the app's (`check_editable` refuses them with a 409, per `LOCKED` in
`invoice_rules.py`): a payment request's follow Revolut, and an invoice read from a receipt was
paid by the transaction the receipt is on. A payment request cannot be deleted either (the next
sync would bring it back); an invoice read from a receipt can, whatever its status, which is how
a misread file is dismissed (the file stays on its transaction and is not read again). Notes and
line accounts stay editable. How receipts are read: `data-pipeline.md`. `source` is a different thing: the
platform the extraction thinks an uploaded invoice was paid through.

### Payments

`invoice_payments` links an invoice to the transactions that paid it (amount and currency of
each, and `matched_by`: `user`, `reconciliation`, `sync` or `backfill`). A transaction pays one
invoice. `InvoiceService.link_payment` and `unlink_payment` (`POST` and
`DELETE /accounting/invoices/{id}/payments[/{transaction_id}]`) are the only writers; they refuse
a transaction in the wrong direction (money in pays a sale, money out a purchase), left out of the
books, or already paying another invoice.

The links decide paid (`status_from_payments`): payments covering at least 95% of the total make
the invoice `PAID` (fees and rounding take a little off), less makes it `PARTIALLY_PAID`, and
removing the last one makes it `OPEN` again. A payment in another currency cannot be compared, so
it counts as paid. A draft keeps its place in To review when a payment is linked, and finalising
it goes straight to what its links say. Marking paid by hand is for money with no transaction
behind it.

Before `invoice_payments`, a match was the invoice number written into the transaction's
`metadata.invoice_id`, the field providers use for their own references. The migration copied
those matches across; metadata is no longer written by matching.

### Uploads

Uploaded on the Invoices page. `services/invoice_service.py`:

1. Extract the fields from the PDF or image with a structured-output model call
   (`DEFAULT_CHAT_MODEL`).
2. Upsert the contact (supplier or customer).
3. Create the invoice and its line items. Each line can carry a GL account, which says what it
   was for; nothing is posted from it. Each line also says what it bought (`line_kind`: a
   product, a sample or something else, proposed by the extraction) and, for a product, the
   business's product it matches (`product_id`: by SKU, then exact name; `match_product`).

Invoices do not touch stock. What a purchase bought is shown in the invoice drawer and can be
corrected there (`PATCH /accounting/invoices/{id}` with `line_items`), but nothing is written to
`products`, `inventory_items` or `inventory_movements`: stock levels and stock value come from
the stock records. (A Stock section that created products and purchase movements from invoice
lines was removed; the 67 movements it made in production stay as plain stock records, and
migration `20261102000000_invoice_line_products` copied what they bought onto their lines.)

The lifecycle is in `services/invoice_rules.py` (pure functions, no I/O; tested in
`tests/test_invoice_rules.py`):

| From                | May go to                                                |
| ------------------- | -------------------------------------------------------- |
| `DRAFT`             | `OPEN`, `PAID`, `CANCELLED`, `VOID`                      |
| `OPEN`              | `PAID`, `PARTIALLY_PAID`, `OVERDUE`, `CANCELLED`, `VOID` |
| `OVERDUE`           | `OPEN`, `PAID`, `PARTIALLY_PAID`, `CANCELLED`, `VOID`    |
| `PARTIALLY_PAID`    | `OPEN`, `PAID`, `OVERDUE`, `VOID`                        |
| `PAID`              | `OPEN` (undoes a mistaken payment), `VOID`               |
| `CANCELLED`, `VOID` | nothing                                                  |

- An invoice can be deleted only from `DRAFT`, `CANCELLED` or `VOID`; a live one is voided, so
  the record stays.
- A forbidden change raises `InvoiceRuleError`, returned as HTTP 409.
- `effective_status` shows an unpaid, finalised invoice past its due date as `OVERDUE`.

## Reconciliation

`services/reconciliation_service.py`:

- `detect_cross_provider_duplicates`: the same money seen by two providers (a PayPal payout and the
  Revolut deposit it became) is marked with an `excluded_reason`, so it is not counted twice.
  Excluded transactions are left out of balances and journals.
- `reconcile_invoice_payments`: links an open invoice to a bank transaction that names it (its
  number in the reference or description, and an amount and date that fit), through
  `link_payment`, so the status follows the link. Cross-provider detection does the same for the
  invoice numbers PayPal carries.

Routes: `POST /accounting/detect-duplicates`, `POST /accounting/reconcile-invoices`,
`POST /accounting/clean-paypal`.
