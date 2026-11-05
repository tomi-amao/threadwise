-- Matching uploaded invoices to their payments, and refusing duplicate uploads.
--
-- An upload is linked to its payment automatically when one transaction carries its invoice
-- number and its exact amount (services/invoice_matching.py); such a link is recorded as
-- matched_by 'auto', so the matcher can take it away again if its transaction is later left
-- out of the books. A person's links ('user') are never changed by it.
--
-- An upload keeps the SHA-256 of its file, so the same file is refused before the model reads
-- it again. Uploads made before this have no hash; they are still caught by their number.

alter table public.invoice_payments
  drop constraint invoice_payments_matched_by_check,
  add constraint invoice_payments_matched_by_check
    check (matched_by in ('user', 'reconciliation', 'sync', 'backfill', 'auto'));

alter table public.invoices add column file_sha256 text;

comment on column public.invoices.file_sha256 is
  'SHA-256 of the uploaded file, to refuse the same file twice. Null for synced invoices and uploads made before it was kept.';

create index invoices_entity_file_sha256
  on public.invoices (entity_id, file_sha256)
  where file_sha256 is not null;
