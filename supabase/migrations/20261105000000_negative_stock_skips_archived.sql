-- Negative stock: leave out items whose product is archived.
--
-- An archived product is one the business has put away: its items are already hidden on the
-- Inventory page, and a negative count on one is the leftover of sales recorded before stock
-- was ever tracked ("sales recorded but stock never received"), not something to act on. They
-- still showed here, and in accounting_health_checks' no_negative_stock (which reads this
-- view), as a negative value that never clears. An item with no product at all still shows.
--
-- The columns are unchanged. inventory_gl_reconciliation is not affected: it floors negatives
-- at zero and counts every item.

create or replace view public.inventory_negative_stock
with (security_invoker = true) as
select
  ioh.inventory_item_id,
  ioh.sku,
  ioh.product_id,
  p.name as product_name,
  p.status as product_status,
  ioh.item_type,
  ioh.quantity_source,
  ioh.on_hand,
  ioh.unit_cost,
  round(ioh.on_hand * coalesce(ioh.unit_cost, 0::numeric), 2) as negative_value,
  ioh.units_purchased,
  ioh.units_sold,
  case
    when ioh.units_purchased = 0::numeric then 'sales recorded but stock never received'
    when ioh.quantity_source = 'shopify' then 'Shopify reports oversold'
    else 'movements net negative'
  end as reason
from public.inventory_on_hand ioh
left join public.products p on p.id = ioh.product_id
where ioh.on_hand < 0::numeric
  and p.status is distinct from 'archived';

comment on view public.inventory_negative_stock is
  'Items showing impossible negative stock, except items of archived products (put away, and hidden on the Inventory page). inventory_gl_reconciliation floors these at zero, so they do not distort the GL tie, but each one hides a real gap in the movement history.';
