-- A record of each background journal generation run, and which journals it created.
--
-- Until now a run existed only as live progress messages to the open modal, so what it did,
-- skipped and failed on was gone once the modal closed. Rows are written by the agent alone
-- (service role); people can only read their own business's runs.

create table public.journal_generation_runs (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id) on delete cascade,
  scope text not null default 'all' check (scope in ('all', 'payments', 'transactions')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'completed_with_errors', 'failed')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- One entry per pipeline step, saved as each finishes: created, skipped and its errors.
  steps jsonb not null default '[]'::jsonb,
  total_created integer not null default 0,
  total_skipped integer not null default 0,
  total_errors integer not null default 0,
  failure_reason text,
  -- Written by a model the first time the run is opened, then kept.
  narrative jsonb
);

-- One run at a time per business: a second click joins the run already going.
create unique index journal_generation_runs_one_active
  on public.journal_generation_runs (entity_id)
  where status in ('queued', 'running');

-- The Runs list: a business's runs, newest first.
create index journal_generation_runs_by_business
  on public.journal_generation_runs (entity_id, created_at desc);

alter table public.journal_generation_runs enable row level security;

create policy "users can view their entity journal runs" on public.journal_generation_runs
  for select to authenticated
  using (entity_id in (select id from public.entities where owner_user_id = (select auth.uid())));

revoke all on public.journal_generation_runs from anon, authenticated;
grant select on public.journal_generation_runs to authenticated;

comment on table public.journal_generation_runs is
  'One background journal generation run. Written by the agent; what happened is kept as it was, and what is true now is read from the journals that point here.';

-- Null for manual journals and for anything created before runs were recorded.
alter table public.journals
  add column generation_run_id uuid
    references public.journal_generation_runs (id) on delete set null;

create index journals_by_generation_run
  on public.journals (generation_run_id)
  where generation_run_id is not null;

-- The same function with one more argument. A new signature would otherwise sit beside the old
-- one as an overload. The default keeps the callers that pass nine arguments working
-- (apply_invoice_split calls this by position).
drop function public.upsert_journal_with_lines(
  uuid, date, text, text, text, uuid, text, jsonb, jsonb
);

create function public.upsert_journal_with_lines(
  p_entity_id uuid,
  p_journal_date date,
  p_journal_type text,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_status text,
  p_metadata jsonb,
  p_line_items jsonb,
  p_generation_run_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_journal_id uuid;
  v_posted_at timestamptz;
begin
  if p_line_items is null or jsonb_array_length(p_line_items) = 0 then
    raise exception 'Cannot create a % journal with no line items (source_type=%, source_id=%)',
      p_journal_type, p_source_type, p_source_id;
  end if;

  v_posted_at := case when p_status = 'posted' then now() else null end;

  insert into journals (
    entity_id, journal_date, journal_type, description,
    source_type, source_id, status, posted_at, metadata, generation_run_id
  )
  values (
    p_entity_id, p_journal_date, p_journal_type::journal_type, p_description,
    p_source_type, p_source_id, p_status::journal_status, v_posted_at,
    coalesce(p_metadata, '{}'::jsonb), p_generation_run_id
  )
  on conflict (entity_id, source_type, source_id, journal_type)
  do update set
    journal_date = excluded.journal_date,
    description = excluded.description,
    status = excluded.status,
    posted_at = excluded.posted_at,
    metadata = excluded.metadata,
    -- A journal belongs to the run that first created it, even if rewritten later.
    generation_run_id = coalesce(journals.generation_run_id, excluded.generation_run_id)
  returning id into v_journal_id;

  delete from journal_line_items where journal_id = v_journal_id;

  insert into journal_line_items (
    journal_id, account_id, debit, credit, currency, description,
    gbp_equivalent, effective_date
  )
  select
    v_journal_id,
    (item->>'account_id')::uuid,
    coalesce((item->>'debit')::numeric, 0),
    coalesce((item->>'credit')::numeric, 0),
    coalesce(item->>'currency', 'GBP'),
    item->>'description',
    nullif(item->>'gbp_equivalent', '')::numeric,
    p_journal_date
  from jsonb_array_elements(p_line_items) as item;

  if p_source_type = 'financial_transaction' and p_source_id is not null then
    update financial_transactions
    set journalised_at = now()
    where id = p_source_id;
  end if;

  return v_journal_id;
end;
$$;

alter function public.upsert_journal_with_lines(
  uuid, date, text, text, text, uuid, text, jsonb, jsonb, uuid
) owner to postgres;

-- SECURITY DEFINER and writes any business's books: the service role alone.
revoke all on function public.upsert_journal_with_lines(
  uuid, date, text, text, text, uuid, text, jsonb, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.upsert_journal_with_lines(
  uuid, date, text, text, text, uuid, text, jsonb, jsonb, uuid
) to service_role;
