-- Files attached to bank transactions, starting with Revolut expense receipts.
--
-- Revolut keeps receipts (and the bills attached to transfers, and its own invoices for fees) on
-- the expense linked to a transaction. The sync copies each file into the private
-- `transaction-attachments` bucket and records it here, so the Transactions drawer can show it
-- without calling Revolut.
--
-- Rows name their transaction by the provider's id (source, external_transaction_id), the same
-- natural key financial_transactions is upserted on, rather than by financial_transactions.id: a
-- receipt can then be stored before its transaction has been normalised, and re-normalising a
-- transaction never touches its attachments.
--
-- Users read their own business's rows. Only the service role (the sync) writes, and the files
-- are opened through short-lived signed links made on the server after the row was read as the
-- user, so the bucket has no policies of its own.

create table public.transaction_attachments (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id) on delete cascade,
  source text not null check (source in ('revolut')),
  external_transaction_id text not null,
  -- The provider's id for the file (a Revolut receipt id), and what it hangs off (the expense).
  external_id text not null,
  external_parent_id text,
  file_path text not null,
  file_name text not null,
  content_type text not null,
  size_bytes integer not null check (size_bytes >= 0),
  created_at timestamptz not null default now(),
  unique (source, external_id)
);

create index transaction_attachments_transaction
  on public.transaction_attachments (entity_id, source, external_transaction_id);

alter table public.transaction_attachments enable row level security;

create policy "users can view their entity transaction attachments"
  on public.transaction_attachments
  for select to authenticated
  using (entity_id in (select id from public.entities where owner_user_id = (select auth.uid())));

grant select on public.transaction_attachments to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('transaction-attachments', 'transaction-attachments', false, 20971520)
on conflict (id) do nothing;
