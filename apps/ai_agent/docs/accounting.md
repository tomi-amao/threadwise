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
| Funding            | An inbound personal or external transfer                                                                                          | `create_funding_journal`         |
| Sales receipt      | A direct PayPal sale                                                                                                              | `create_sales_receipt_journal`   |
| Refund             | An inbound refund transaction                                                                                                     | `create_refund_journal`          |
| Refund reversal    | A refunded order: reverses its revenue, cost and stock                                                                            | `create_refund_reversal_journal` |
| FX conversion      | A currency conversion between accounts                                                                                            | `create_fx_conversion_journal`   |
| Expense            | An outbound bank transaction: debit the resolved expense account, credit cash                                                     | `create_expense_journal`         |
| Purchase           | A supplier invoice when it is finalised                                                                                           | `create_purchase_journal`        |
| Sale               | A customer invoice when it is issued                                                                                              | `create_sale_journal`            |
| Invoice payment    | An invoice marked PAID                                                                                                            | `create_invoice_payment_journal` |
| Cost of goods sold | A fulfilled order                                                                                                                 | `create_inventory_cogs_journal`  |
| Disposal           | A gift or write-off of stock: one dated movement plus its journal                                                                 | `record_inventory_disposal`      |

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

Uploaded on the Invoices page. `services/invoice_service.py`:

1. Extract the fields from the PDF or image with a structured-output model call
   (`DEFAULT_CHAT_MODEL`).
2. Upsert the contact (supplier or customer).
3. Create the invoice and its line items.
4. Create its journal through the rules below.

The lifecycle is in `services/invoice_rules.py` (pure functions, no I/O; tested in
`tests/test_invoice_rules.py`):

| From                | May go to                                                                 |
| ------------------- | ------------------------------------------------------------------------- |
| `DRAFT`             | `OPEN`, `PAID`, `CANCELLED`, `VOID`                                       |
| `OPEN`              | `PAID`, `PARTIALLY_PAID`, `OVERDUE`, `CANCELLED`, `VOID`                  |
| `OVERDUE`           | `OPEN`, `PAID`, `PARTIALLY_PAID`, `CANCELLED`, `VOID`                     |
| `PARTIALLY_PAID`    | `OPEN`, `PAID`, `OVERDUE`, `VOID`                                         |
| `PAID`              | `OPEN` (undoes a mistaken payment: its payment journal is voided), `VOID` |
| `CANCELLED`, `VOID` | nothing                                                                   |

- The purchase or sale journal exists while the invoice is finalised (`OPEN`, `OVERDUE`,
  `PARTIALLY_PAID`, `PAID`); the payment journal exists only while it is `PAID`.
- An invoice can be deleted only from `DRAFT`, `CANCELLED` or `VOID`, and only if nothing is posted
  against it.
- A forbidden change raises `InvoiceRuleError`, returned as HTTP 409.
- `effective_status` shows an unpaid, finalised invoice past its due date as `OVERDUE`.

## Reconciliation

`services/reconciliation_service.py`:

- `detect_cross_provider_duplicates`: the same money seen by two providers (a PayPal payout and the
  Revolut deposit it became) is marked with an `excluded_reason`, so it is not counted twice.
  Excluded transactions are left out of balances and journals.
- `reconcile_invoice_payments`: marks an invoice PAID when a matching bank transaction exists.

Routes: `POST /accounting/detect-duplicates`, `POST /accounting/reconcile-invoices`,
`POST /accounting/clean-paypal`.
