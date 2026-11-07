-- Notifications: what needs the user, shown under the bell in the app.
--
-- The agent writes them (services/notifications.py, with the service role): a lost connection,
-- a source that stopped syncing, payments that need journals. Each has a `dedupe_key` naming
-- the thing it is about ("integration_access:<source id>"). Only one notification per business
-- and key is open at a time (`resolved_at` null), so a check that runs every day updates the
-- open one instead of piling up copies; when the problem goes away the agent resolves it, and
-- the bell stops showing it.
--
-- The signed-in user reads the notifications of a business they own, and can mark them read:
-- `read_at` is the only column they may change (a column grant, below). They cannot create,
-- delete or reword one. `anon` gets nothing (20261017000000_row_level_security.sql).

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id) on delete cascade,
  kind text not null check (length(kind) between 1 and 60),
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  title text not null check (length(title) between 1 and 200),
  body text check (length(body) <= 1000),
  -- Where to act on it: a path inside the app, never another site.
  link text check (link ~ '^/[^/\\]' or link = '/'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  read_at timestamptz,
  resolved_at timestamptz
);

-- One open notification per business and key.
create unique index notifications_one_open_per_key
  on public.notifications (entity_id, dedupe_key)
  where resolved_at is null;

-- The bell's list: a business's open notifications, newest first.
create index notifications_open_by_business
  on public.notifications (entity_id, created_at desc)
  where resolved_at is null;

alter table public.notifications enable row level security;

create policy "users can view their entity notifications" on public.notifications
  for select to authenticated
  using (entity_id in (select id from public.entities where owner_user_id = (select auth.uid())));

create policy "users can mark their entity notifications read" on public.notifications
  for update to authenticated
  using (entity_id in (select id from public.entities where owner_user_id = (select auth.uid())))
  with check (
    entity_id in (select id from public.entities where owner_user_id = (select auth.uid()))
  );

revoke all on public.notifications from authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

comment on table public.notifications is
  'What needs the user, shown under the bell. Written by the agent; one open notification per business and dedupe_key; users may only set read_at.';
