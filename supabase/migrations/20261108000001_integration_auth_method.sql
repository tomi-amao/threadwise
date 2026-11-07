-- Integrations: how a source signs in to its provider, so the page can say it without the key.
--
-- 'key'   a key or token the user pasted (every provider until now).
-- 'oauth' a sign-in through the provider's consent page (Revolut Business: the refresh token
--         from it renews the access token, so nothing is pasted again).
-- The secret itself stays in the Vault (api_key_secret_id); this column holds nothing secret.
-- Written only by the agent, which checks the source is the caller's; external_sources has no
-- write policy for users.

alter table public.external_sources
  add column if not exists auth_method text not null default 'key';

alter table public.external_sources
  drop constraint if exists external_sources_auth_method_check;

alter table public.external_sources
  add constraint external_sources_auth_method_check check (auth_method in ('key', 'oauth'));

comment on column public.external_sources.auth_method is
  'How the source signs in: key (pasted key or token) or oauth (provider sign-in, renews itself). Not secret; the credential is in the Vault.';
