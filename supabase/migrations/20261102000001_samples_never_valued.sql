-- Samples are never valued.
--
-- A sample is counted (it has on-hand stock and movements) but carries no stock value: it is
-- not capitalised, so it is not on the balance sheet and its gift or write-off posts nothing
-- (journal_service.record_inventory_disposal). The Inventory page already left samples out
-- of its totals; this makes the stock-versus-ledger check agree: its stock side counts
-- sellable stock only. 1035 "Inventory - Samples" stays on the ledger side, so anything that
-- ever posts to it shows up here as a variance.

create or replace view public.inventory_gl_reconciliation
with (security_invoker = true) as
with gl as (
  select round(coalesce(sum(coalesce(jli.debit, 0) - coalesce(jli.credit, 0)), 0), 2) as gl_balance
  from public.journal_line_items jli
  join public.journals j on j.id = jli.journal_id
  join public.chart_of_accounts coa on coa.id = jli.account_id
  where coa.account_number::text = any (array['1031', '1032', '1033', '1034', '1035'])
    and j.status = 'posted'::public.journal_status
), sub as (
  select
    round(coalesce(sum(greatest(on_hand, 0) * unit_cost)
      filter (where item_type is distinct from 'sample'), 0), 2) as subledger_value,
    coalesce(sum(greatest(on_hand, 0))
      filter (where item_type is distinct from 'sample'), 0) as units_on_hand,
    count(*) filter (where item_type = 'sellable') as sellable_items,
    count(*) filter (where item_type = 'sample') as sample_items
  from public.inventory_on_hand
)
select
  gl.gl_balance,
  sub.subledger_value,
  round(gl.gl_balance - sub.subledger_value, 2) as variance,
  abs(gl.gl_balance - sub.subledger_value) < 0.01 as reconciled,
  sub.units_on_hand,
  sub.sellable_items,
  sub.sample_items,
  now() as computed_at
from gl, sub;

comment on view public.inventory_gl_reconciliation is
  'Inventory subledger vs GL control accounts (1031-1035). The subledger side is valued stock only: samples are counted but never valued, so they are left out of subledger_value and units_on_hand (sample_items still counts them), and any balance on 1035 shows as a variance. GL side is posted-only: reversed journals are soft voids and must never be counted. Debit/credit are coalesced because some line items store NULL rather than 0. reconciled = true means the balance sheet stock figure ties to inventory_on_hand.';
