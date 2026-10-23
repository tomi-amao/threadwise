-- Thumbs up and down on the assistant's answers.
--
-- The panel writes a row when someone rates an answer (and removes or changes it when they
-- change their mind). It holds ids only, never a question or an answer: the review queue is
-- "which thread, which message, rated how", and the team finds the conversation through the
-- trace (the run carries the thread id and a hashed business id) when tracing is on.
--
-- A user reads and writes only their own ratings, for a business they own. Anyone else, and
-- anyone not signed in, gets nothing. The review queue is read with the service role
-- (`python -m ai_agent.evals.feedback`).

create table public.assistant_feedback (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  thread_id text not null check (length(thread_id) between 1 and 100),
  message_id text not null check (length(message_id) between 1 and 100),
  rating text not null check (rating in ('up', 'down')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, thread_id, message_id)
);

create index assistant_feedback_review on public.assistant_feedback (created_at desc)
  where rating = 'down';

alter table public.assistant_feedback enable row level security;

create policy "users can view their own ratings" on public.assistant_feedback
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "users can rate as themselves, for a business they own" on public.assistant_feedback
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and entity_id in (select id from public.entities where owner_user_id = (select auth.uid()))
  );

create policy "users can change their own ratings" on public.assistant_feedback
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and entity_id in (select id from public.entities where owner_user_id = (select auth.uid()))
  );

create policy "users can remove their own ratings" on public.assistant_feedback
  for delete to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.assistant_feedback to authenticated;
