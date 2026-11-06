-- Integrations: hide one from the page without disconnecting it.
--
-- A hidden integration moves to a collapsed "Hidden" row on the Integrations page. It is still
-- connected: it keeps syncing, and later checks of its access and notifications still run.
-- Null means shown. Written only by the agent (PUT /integrations/sources/{id}/hidden), which
-- checks the source is the caller's; external_sources has no write policy for users.

alter table public.external_sources
  add column if not exists hidden_at timestamptz;

comment on column public.external_sources.hidden_at is
  'When the user hid this integration on the Integrations page; null when shown. Hiding changes nothing else: syncs and checks carry on.';
