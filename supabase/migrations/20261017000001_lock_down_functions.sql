-- Database functions: who may call them.
--
-- Functions are executable by PUBLIC unless that is revoked, so with the public (anon) key anyone
-- could call them over the REST API. That included the SECURITY DEFINER ones, which run with the
-- owner's rights and so ignore row-level security:
--   get_api_key_secure / store_api_key_secure / delete_api_key_secure / update_api_key_status
--     read, replace and remove the stored third-party API keys
--   upsert_journal_with_lines / post_draft_journal     write journals into any business's books
--   get_sync_stats_by_source, backfill_sale_cost_snapshots, cleanup_api_key_on_delete
-- Only the agent and the sync pipeline call these, and they use the service-role key.
--
-- After this: nobody without a session can call any function; signed-in users can call the
-- ordinary (SECURITY INVOKER) ones, which run under their own row-level security; the SECURITY
-- DEFINER ones are for the service role alone.

revoke execute on all functions in schema public from public, anon;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('revoke execute on function %s from authenticated', f.signature);
  end loop;
end $$;

alter default privileges in schema public revoke execute on functions from public, anon;
