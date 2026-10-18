-- Row-level security for everything the app reads.
--
-- Before this, most business tables (orders, customers, payments, journals, bank accounts,
-- financial transactions, inventory movements ...) had RLS switched on but no policy, so a
-- signed-in user's own session could read none of them. The app worked around that by reading
-- with the service-role key, which bypasses RLS entirely: every business's data, filtered only
-- by whatever the query remembered to ask for.
--
-- This gives each of those tables a SELECT policy ("the entity belongs to me", the rule the
-- invoices, products and inventory_items policies already use), so loaders can read as the
-- signed-in user and let the database enforce the boundary. Writes to these tables stay
-- service-role only (the agent and the sync pipeline), so no INSERT/UPDATE/DELETE policies are
-- added.
--
-- It also closes three holes found while doing it:
--   1. `anon` (the public key shipped to every browser) had ALL privileges on every table and
--      view in `public`, and 14 tables had RLS off entirely (including the _backup_* tables, the
--      accounting period tables and tax adjustments): readable and writable with the public key.
--   2. Views run with their owner's rights by default, so a view over RLS-protected tables
--      returns every business's rows to whoever may select from it. They now run with the
--      caller's rights (security_invoker), so the policies below apply through them.
--   3. New tables inherited the same wide grants. Default privileges no longer give `anon`
--      anything.

-- ── 1. Nothing in public is reachable without signing in ─────────────────────────────────────
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- ── 2. RLS on for every table (no policy means service-role only) ────────────────────────────
alter table public._backup_charcoal_merge enable row level security;
alter table public._backup_charcoal_order_merge enable row level security;
alter table public._backup_phase1_items enable row level security;
alter table public._backup_phase1_movements enable row level security;
alter table public._backup_phase2_count enable row level security;
alter table public._backup_sale_movement_dates enable row level security;
alter table public.accounting_period_locks enable row level security;
alter table public.accounting_periods enable row level security;
alter table public.corporation_tax_rates enable row level security;
alter table public.tax_adjustments enable row level security;

-- ── 3. SELECT policies: rows of businesses the signed-in user owns ───────────────────────────
-- Tables with their own entity_id.
do $$
declare
  t text;
begin
  foreach t in array array[
    'accounting_period_locks',
    'accounting_periods',
    'bank_accounts',
    'calendar_events',
    'customers',
    'financial_transactions',
    'journals',
    'orders',
    'payments'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using (entity_id in (select id from public.entities where owner_user_id = (select auth.uid())))',
      'users can view their entity ' || replace(t, '_', ' '),
      t
    );
  end loop;
end $$;

-- Tables that belong to a business through a parent row.
create policy "users can view their order line items" on public.order_line_items
  for select to authenticated
  using (order_id in (select id from public.orders));

create policy "users can view their payment fees" on public.payment_fees
  for select to authenticated
  using (payment_id in (select id from public.payments));

create policy "users can view their inventory movements" on public.inventory_movements
  for select to authenticated
  using (inventory_item_id in (select id from public.inventory_items));

create policy "users can view their journal line items" on public.journal_line_items
  for select to authenticated
  using (journal_id in (select id from public.journals));

create policy "users can view their tax adjustments" on public.tax_adjustments
  for select to authenticated
  using (period_id in (select id from public.accounting_periods));

-- Reference data shared by every business.
create policy "signed-in users can view the chart of accounts" on public.chart_of_accounts
  for select to authenticated using (true);

create policy "signed-in users can view corporation tax rates" on public.corporation_tax_rates
  for select to authenticated using (true);

-- ── 4. Views run as the person asking, so the policies above apply through them ──────────────
alter view public.accounting_health_checks set (security_invoker = true);
alter view public.accounting_period_results set (security_invoker = true);
alter view public.clearing_account_breakdown set (security_invoker = true);
alter view public.inventory_gl_reconciliation set (security_invoker = true);
alter view public.inventory_negative_stock set (security_invoker = true);
alter view public.inventory_on_hand set (security_invoker = true);
alter view public.inventory_uncosted_sales set (security_invoker = true);
alter view public.tax_account_positions set (security_invoker = true);
alter view public.tax_period_account_breakdown set (security_invoker = true);
alter view public.tax_review_items set (security_invoker = true);
