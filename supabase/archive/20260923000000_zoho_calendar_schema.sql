-- Zoho Calendar integration — Phase 1: schema
--
-- Two new tables (calendar_events for the pull direction, calendar_event_links
-- for the push direction) plus a tax_deadlines() function that becomes the
-- single source of truth for tax deadline dates, shared between the existing
-- Tax page (apps/chat-ui/app/lib/api/tax.server.ts) and the new calendar push
-- service, so the two can never drift against each other.

-- =============================================================================
-- calendar_events — pull direction: normalized Zoho Calendar events
-- =============================================================================

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id),
  source_id uuid not null references public.external_sources(id) on delete cascade,
  external_id text not null,
  calendar_uid text not null,
  title text not null,
  description text,
  location text,
  start_at timestamptz not null,
  end_at timestamptz,
  all_day boolean not null default false,
  organizer text,
  attendees jsonb not null default '[]'::jsonb,
  status text not null default 'confirmed', -- confirmed | cancelled
  raw_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_id)
);

create index calendar_events_entity_id_idx on public.calendar_events (entity_id);
create index calendar_events_start_at_idx on public.calendar_events (start_at);

-- Derived/normalized data with no direct user mutation — same shape as
-- financial_transactions (RLS on, zero policies: service-role only, read via
-- a .server.ts loader using getServerSupabaseClient(), never
-- getAuthenticatedServerClient()). Confirmed this is financial_transactions'
-- actual shape via pg_policies before copying it, not assumed.
alter table public.calendar_events enable row level security;

-- =============================================================================
-- calendar_event_links — push direction: what ThreadWise has already written
-- to the user's calendar, so re-runs update in place instead of duplicating
-- =============================================================================

create table public.calendar_event_links (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id),
  source_id uuid not null references public.external_sources(id) on delete cascade,
  -- Free-text, not an enum: 'tax_deadline' and 'collection_launch' are wired
  -- up first, but this table is not specific to either — a new push source
  -- later is a new source_type value, not a schema change.
  source_type text not null,
  source_key text not null,
  external_event_uid text, -- null until the first successful Zoho write
  calendar_uid text,
  last_pushed_hash text,
  last_pushed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, source_type, source_key)
);

-- Backend-only bookkeeping, same shape as external_raw_events: RLS on, one
-- service-role-only policy, nothing for authenticated/anon roles.
alter table public.calendar_event_links enable row level security;

create policy "Service role full access on calendar_event_links"
  on public.calendar_event_links
  for all
  using (auth.role() = 'service_role');

-- =============================================================================
-- tax_deadlines() — single source of truth for tax deadline dates
-- =============================================================================
--
-- Reproduces tax.server.ts's getTaxData() deadline derivation exactly (lines
-- ~313-352 as of this migration), so the Tax page and the calendar push
-- service can never show two different dates for the same obligation:
--
--   - Only periods that are NOT 'open' carry a real, due-by-date obligation
--     (an open period's dates are for planning, not yet actionable).
--   - Every qualifying period produces two rows: one 'payment' deadline, one
--     'filing' deadline.
--   - A deadline is 'satisfied' if the period is already 'filed', or (for
--     payment specifically) if the computed tax due is zero.
--   - amount is only populated for the payment kind, and only when the
--     ledger can actually support the figure (ledger_basis = true) —
--     otherwise the deadline is real but the number is the accountant's to
--     supply, not the ledger's.
--   - due_soon is genuinely 90 days out, not a shorter window — matches the
--     Tax page's own threshold.
--
-- SECURITY INVOKER (the default) is correct here, matching
-- compute_corporation_tax itself: both are only ever called by the
-- service-role client in practice (Python for the push service, the
-- service-role Supabase client for tax.server.ts).
create or replace function public.tax_deadlines(p_entity_id uuid)
returns table (
  period_id uuid,
  label text,
  kind text, -- 'payment' | 'filing'
  due_date date,
  amount numeric,
  days_remaining integer,
  status text -- 'satisfied' | 'overdue' | 'due_soon' | 'upcoming'
)
language sql
stable
as $$
  select
    t.period_id,
    t.label,
    k.kind,
    case k.kind when 'payment' then t.payment_due else t.filing_due end as due_date,
    case when k.kind = 'payment' and t.ledger_basis then t.tax_due else null end as amount,
    (case k.kind when 'payment' then t.payment_due else t.filing_due end - current_date)::integer
      as days_remaining,
    case
      when t.status = 'filed' or (k.kind = 'payment' and t.tax_due = 0) then 'satisfied'
      when (case k.kind when 'payment' then t.payment_due else t.filing_due end - current_date) < 0
        then 'overdue'
      when (case k.kind when 'payment' then t.payment_due else t.filing_due end - current_date) <= 90
        then 'due_soon'
      else 'upcoming'
    end as status
  from compute_corporation_tax(p_entity_id) t
  cross join (values ('payment'), ('filing')) as k(kind)
  where t.status <> 'open'
  order by due_date;
$$;
