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
| Invoice split      | A payment's expense journal re-cut by the lines of the invoice it paid (approved by a person; see below)                          | `invoice_split.apply_split`      |
| Disposal           | A gift or write-off of stock: one dated movement plus its journal (a sample: the movement only, as samples are never valued)      | `record_inventory_disposal`      |

A Revolut merchant payment (`reserve_release`) is a funding journal, and carries Revolut's fee
when the transaction has one (`metadata.fee`, taken from the leg by the normaliser): debit cash
with what reached the account, debit 8020 Bank charges with the fee, credit 4030 Wholesale
revenue with what the customer paid (`merchant_fee`; a foreign payment's fee is scaled to its GBP
amount). The settlement and payout that take the money on to the main account are moves between
the business's own accounts, excluded at normalisation, so the one journal is the whole of it.
Each journal stands on its own, so the order the three arrive in does not matter.

### Splitting a payment's journal by its invoice

A payment is journaled on its own, usually before its invoice arrives, to one account. Once an
invoice is matched to it, `services/invoice_split.py` works out how its journal would be re-cut
by the invoice's lines (`GET /accounting/invoices/{id}/split`), and a person approves it
(`POST .../split`, undone with `DELETE .../split/{transaction_id}`). The journal stays the
transaction's: same date, same cash line, journal type `invoice_split`.

- The debit side becomes one line per invoice line, on that line's account, or on the account the
  payment was journaled to when the line has none.
- Lines are weighted by their gross and scaled to add up exactly to the payment (rounding on the
  largest line), so a part payment, a currency difference and a fee are all the same rule. In a
  non-GBP journal each line's GBP equivalent is its share of the GBP the payment was booked at.
- VAT is folded into each line (the business is not VAT registered); each line's VAT share is kept
  in the journal's `metadata.lines`.
- Only a payment journaled as one expense (posted, or an uncategorised draft) can be split, and
  purchases only for now.

Applying is one database call (`apply_invoice_split`): it voids the journal it replaces, posts the
split and records what it replaced in `metadata.replaces`, so the books never hold both or
neither. `undo_invoice_split` puts the replaced journal back as it was. Both are refused in a
locked accounting period. A split payment counts as journaled, so journal generation does not
make it a second expense journal. Changing the transaction's account in its drawer reverses the
split and journals it afresh, as for any journal.

In the app, the invoice drawer's "In your books" section shows the payment's journal now, the
split its lines suggest, and Split / Undo (`components/invoices/SplitSection.tsx`); the
transaction's drawer says when its journal is split and links back to the invoice.

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

`POST /accounting/journals/run-summary` (`services/journal_run_summary.py`) feeds the modal's
Summary tab. The job stamps `started_at` once (a memoised step, so replays send the same value) on
every status message, and the run is every journal the business created since then. The figures
(counts by type and status, total value, the accounts that moved most, the largest journals) are
computed in `build_run_stats`. A model writes only a short narrative from those figures, and if it
fails, `narrative` is `null` and the figures still come back. An empty run never calls the model.
Read-only. With `include_narrative: false` it re-reads the figures without calling the model, which
the tab does after a draft is posted from Review.

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
each, and `matched_by`: `user`, `reconciliation`, `sync`, `backfill` or `auto`). A transaction pays one
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

An invoice paid with no bank transaction behind it says how (`invoices.paid_outside_bank`: `cash`,
`paid_personally` or `other`, with an optional note), set with the move to `PAID`
(`set_invoice_status(..., paid_outside_bank=...)`) and only when no payment is linked. It is then
never matched, linking a payment to it is refused, and undoing the payment clears it (a check
constraint keeps it on `PAID` invoices only). Nothing is posted: the books follow bank
transactions, so a payment made personally belongs in the director's loan, recorded by hand.

### Matching an upload to its payment

`services/invoice_matching.py` scores the business's transactions against an upload: the right
direction and currency, counted in the books, not paying another invoice, from 15 days before
the invoice date to 120 after, and either within 10% of the total or carrying the invoice number
(a part payment). It scores up the invoice number on the transaction (its text or provider data,
punctuation aside), the exact amount, the counterparty's name (a long word on its first six
letters, for cut-short card merchants) and a close date. Each candidate says why it fits.

A candidate is **confident** when it carries the invoice number and the exact amount. When
exactly one is, the upload is linked to it automatically (`matched_by = 'auto'`); otherwise the
drawer offers the candidates, drafts included (`GET /accounting/invoices/{id}/payment-candidates`).
Matching runs on upload and after each Revolut or PayPal sync (`match_invoice_payments`, also
`POST /accounting/invoices/match` on demand) for every upload that is a draft, open or overdue
with no payment linked. That pass first removes automatic links whose transaction has since been
excluded (the PayPal clean-up excludes a PayPal payment a Revolut one covers), so the next match
finds the one that counts; a person's links are never touched. Against the 35 linked uploads in
production (2026-11-01) it chose the linked payment for 31 automatically, put it first for the
other 4, and chose a wrong one for none.

An upload is refused (409, nothing written) when it is the same file as one already held (its
SHA-256, `invoices.file_sha256`, checked before the model reads it) or carries the same number as
an invoice from the same counterparty (`same_number`: case and punctuation aside).

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

## Stock value against the books

Stock has two sides that are filled separately. The books' stock accounts (1031 to 1035) are
debited when a supplier payment is journaled to them (the day it is paid, whether or not the goods
have arrived) and credited by cost of goods sold. The stock records are the count in the store
(`inventory_on_hand`, see [Stock quantities](data-pipeline.md#stock-quantities)) at each item's
unit cost, sellable items only: samples are counted but never valued.

`inventory_gl_reconciliation` is the database view that compares them: `gl_balance` (posted
journals only), `subledger_value`, `variance` and `reconciled`. It is one of the
`accounting_health_checks` (`/accounting/health-checks`, internal key), and the Inventory page
shows it ("Stock against your books", `getBooksVsStock`, read as the signed-in user: the view is
`security_invoker`, so it counts only their business).

A difference is usually stock paid for and not yet in the counts. The panel lists the journals on
the stock accounts after the last posted `adjustment` journal that touches them (a stock-count
true-up, say), each with the invoice the payment settled, and says how far they account for the
difference. It closes by itself once the store's counts catch up. A difference with no journals
behind it is the stock records moving on their own, a count or a cost that changed with no
journal, and a stock-count adjustment journal brings the books to the count. Nothing is posted
from the panel.

`inventory_negative_stock` (and so the `no_negative_stock` health check) leaves out items of
archived products, which the Inventory page hides; the reconciliation still counts every item,
floored at zero.
