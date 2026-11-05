-- Splitting a payment's journal by the invoice it paid.
--
-- A payment is journaled on its own, usually before its invoice arrives, to one account (an
-- expense, or Miscellaneous when it could not be categorised). Once the invoice is matched,
-- its lines say what the money was really for, so the payment's journal can be replaced by
-- one that splits it across those lines' accounts (services/invoice_split.py works it out).
-- The invoice itself still posts nothing: this is the transaction's journal, re-cut.
--
-- apply_invoice_split posts the split and voids ('reversed') the journal it replaces in one
-- statement, so the books never hold both or neither, and records what it replaced so
-- undo_invoice_split can put that back exactly. The accounting-period lock trigger on journals
-- refuses either in a locked period, and the whole call rolls back.

alter type public.journal_type add value if not exists 'invoice_split';

create or replace function public.apply_invoice_split(
  p_entity_id uuid,
  p_transaction_id uuid,
  p_journal_date date,
  p_description text,
  p_metadata jsonb,
  p_line_items jsonb,
  p_replaces uuid[]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_replaced jsonb;
  v_journal_id uuid;
begin
  if exists (
    select 1 from journals
    where entity_id = p_entity_id
      and source_type = 'financial_transaction'
      and source_id = p_transaction_id
      and journal_type = 'invoice_split'
      and status = 'posted'
  ) then
    raise exception 'This payment''s journal is already split by an invoice.'
      using errcode = 'P0001';
  end if;

  -- The live journals being replaced, and how they stood, for an undo.
  select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'status', j.status)), '[]'::jsonb)
    into v_replaced
  from journals j
  where j.id = any(p_replaces)
    and j.entity_id = p_entity_id
    and j.source_type = 'financial_transaction'
    and j.source_id = p_transaction_id
    and j.status <> 'reversed'
    and j.journal_type <> 'invoice_split';
  if jsonb_array_length(v_replaced) <> coalesce(array_length(p_replaces, 1), 0) then
    raise exception 'The payment''s journal has changed since the split was worked out. Look again.'
      using errcode = 'P0001';
  end if;

  update journals set status = 'reversed' where id = any(p_replaces);

  v_journal_id := upsert_journal_with_lines(
    p_entity_id, p_journal_date, 'invoice_split', p_description,
    'financial_transaction', p_transaction_id, 'posted',
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('replaces', v_replaced),
    p_line_items
  );
  return v_journal_id;
end;
$$;

create or replace function public.undo_invoice_split(
  p_entity_id uuid,
  p_journal_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_split journals%rowtype;
  v_previous jsonb;
begin
  select * into v_split from journals
  where id = p_journal_id and entity_id = p_entity_id and journal_type = 'invoice_split';
  if not found or v_split.status <> 'posted' then
    raise exception 'That is not an applied invoice split.' using errcode = 'P0001';
  end if;

  update journals set status = 'reversed' where id = p_journal_id;
  for v_previous in select * from jsonb_array_elements(coalesce(v_split.metadata->'replaces', '[]'::jsonb))
  loop
    update journals
    set status = (v_previous->>'status')::journal_status
    where id = (v_previous->>'id')::uuid
      and entity_id = p_entity_id
      and status = 'reversed';
  end loop;
end;
$$;

-- Like the other journal writers: for the agent's service role only.
revoke execute on function public.apply_invoice_split(uuid, uuid, date, text, jsonb, jsonb, uuid[])
  from public, anon, authenticated;
revoke execute on function public.undo_invoice_split(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_invoice_split(uuid, uuid, date, text, jsonb, jsonb, uuid[])
  to service_role;
grant execute on function public.undo_invoice_split(uuid, uuid) to service_role;

comment on function public.apply_invoice_split is
  'Replace a payment''s live journal(s) with a split by the invoice it paid, in one statement: the replaced journals are voided and recorded in the split''s metadata.replaces. Refused if the payment is already split or its journals changed. Service role only.';
comment on function public.undo_invoice_split is
  'Void an applied invoice split and restore the journals it replaced to how they stood. Service role only.';
