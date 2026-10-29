-- Invoices become a register of documents, each saying where it came from and which money
-- movements settled it.
--
-- Invoices no longer post to the ledger (the transaction that settles one is journaled), so what
-- an invoice needs is provenance and a link to its payment:
--
--   * `origin` says where the record came from: a document someone uploaded, a Revolut Merchant
--     payment request (a sales invoice sent from Revolut), or a receipt attached to a Revolut
--     expense. `external_id` is the provider's id for it, so a sync can upsert. `source` is left
--     as it was: the platform the extraction thinks the invoice was paid through.
--   * `attachment_id` points at the stored receipt an invoice was read from, when it came from
--     a transaction attachment rather than an upload (`file_path` is the upload's own copy).
--   * `invoice_payments` links an invoice to the transactions that paid it. It replaces writing
--     the invoice number into financial_transactions.metadata.invoice_id, which is also where
--     providers put their own references (PayPal invoice ids, Shopify order numbers), so a match
--     there could not be told apart from provider data and collided on reused numbers. Existing
--     matches are copied across below; metadata is left untouched.
--
-- Users read their own business's rows. Only the service role (the agent) writes, as for every
-- other table here.

alter table public.invoices
  add column origin text not null default 'upload'
    check (origin in ('upload', 'revolut_merchant', 'revolut_expense')),
  add column external_id text,
  add column attachment_id uuid references public.transaction_attachments (id) on delete set null;

-- NULLs are distinct, so uploads (no external id) never collide; synced rows are unique per
-- business and origin.
alter table public.invoices
  add constraint invoices_origin_external_id_key unique (entity_id, origin, external_id);

comment on column public.invoices.origin is
  'Where the record came from: upload, revolut_merchant (a payment request sent from Revolut) or revolut_expense (a receipt on a Revolut expense). Synced invoices are read-only in the app.';
comment on column public.invoices.external_id is
  'The provider''s id for a synced invoice (a Merchant order id, a receipt id). Null for uploads.';
comment on column public.invoices.attachment_id is
  'The transaction attachment this invoice was read from, if any.';

create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  financial_transaction_id uuid not null
    references public.financial_transactions (id) on delete cascade,
  -- What the transaction contributed, in its own currency (an invoice can be part paid).
  amount numeric(18, 4) not null check (amount > 0),
  currency_code character(3) not null,
  matched_by text not null check (matched_by in ('user', 'reconciliation', 'sync', 'backfill')),
  created_at timestamptz not null default now(),
  -- A transaction pays one invoice, as before.
  unique (financial_transaction_id)
);

create index invoice_payments_invoice on public.invoice_payments (invoice_id);
create index invoice_payments_entity on public.invoice_payments (entity_id);

alter table public.invoice_payments enable row level security;

create policy "users can view their entity invoice payments"
  on public.invoice_payments
  for select to authenticated
  using (entity_id in (select id from public.entities where owner_user_id = (select auth.uid())));

grant select on public.invoice_payments to authenticated;

-- Copy the matches that already exist: a transaction whose metadata.invoice_id is the number of
-- an invoice of the same business, in the direction that pays it, and not left out of the books.
-- Where a number matched more than one transaction the earliest wins (none do today).
insert into public.invoice_payments
  (entity_id, invoice_id, financial_transaction_id, amount, currency_code, matched_by)
select distinct on (t.id)
  i.entity_id, i.id, t.id, t.amount, t.currency_code, 'backfill'
from public.invoices i
join public.financial_transactions t
  on t.entity_id = i.entity_id
 and t.metadata ->> 'invoice_id' = i.invoice_number
 and t.excluded_reason is null
 and t.direction = (case when i.invoice_type = 'SALE' then 'in' else 'out' end)::public.txn_direction
order by t.id, i.created_at;
