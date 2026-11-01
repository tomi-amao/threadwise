-- Receipts are read: each transaction attachment is classified, and the supplier invoices among
-- them become PURCHASE invoices in the register (origin 'revolut_expense').
--
-- The sync stores every file Revolut keeps on an expense: card and till receipts, supplier
-- invoices and bills, Revolut's own invoices for its fees, and the odd photo. Only invoices
-- belong in the register, so after a file is stored the agent reads it once and records what
-- it is here. A file that could not be read (the model failed, the file is unreadable) is tried
-- again on later runs, up to three attempts, with the last error kept for a person to see.
--
-- Written only by the service role (the agent), like the rest of the table; the existing select
-- policy covers the new columns.

alter table public.transaction_attachments
  add column document_kind text check (document_kind in ('invoice', 'receipt', 'other')),
  add column read_at timestamptz,
  add column read_attempts integer not null default 0 check (read_attempts >= 0),
  add column read_error text;

comment on column public.transaction_attachments.document_kind is
  'What the file is, as read by the agent: invoice (a supplier''s invoice or bill), receipt (proof of a payment that is not an invoice) or other. Null until read.';
comment on column public.transaction_attachments.read_at is
  'When the agent read the file. Null means not read yet (or every attempt so far failed).';
comment on column public.transaction_attachments.read_attempts is
  'Failed attempts to read the file. Reading stops after three.';
comment on column public.transaction_attachments.read_error is
  'Why the last attempt to read the file failed.';

-- The reader looks for unread files per business.
create index transaction_attachments_unread
  on public.transaction_attachments (entity_id)
  where read_at is null;
