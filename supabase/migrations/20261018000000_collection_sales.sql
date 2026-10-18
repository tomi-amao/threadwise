-- What each collection has sold.
--
-- The Collections page used to download every order line in the database and match it to each
-- collection in the browser's server process: slow, and (because it read with the service key
-- and did not filter by business) it counted other businesses' sales too. This does the matching
-- in the database, as the caller, so row-level security limits it to their own collections,
-- products and orders, and only the totals come back.
--
-- An order line belongs to a collection when its product is one of the collection's products,
-- or its product name equals one (ignoring case and spacing, then ignoring punctuation too: so a
-- line with no product link, or a renamed product, still counts). A line counts once per
-- collection. Cancelled and fully refunded orders are not sales.
--
-- One result set, three levels, told apart by `level`:
--   'total'   one row per collection (product_id and week_start are null)
--   'product' one row per collection and product
--   'week'    one row per collection and week (Monday), for the trend
-- `orders` is the number of distinct orders at that level.

create or replace function public.collection_sales_rollup(p_collection_id uuid default null)
returns table (
  collection_id uuid,
  level text,
  product_id uuid,
  week_start date,
  units numeric,
  revenue numeric,
  orders bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with members as (
    select
      cp.collection_id,
      cp.product_id,
      lower(btrim(regexp_replace(p.name, '\s+', ' ', 'g'))) as exact_name,
      btrim(regexp_replace(regexp_replace(lower(p.name), '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g'))
        as loose_name
    from collection_products cp
    join products p on p.id = cp.product_id
    where p_collection_id is null or cp.collection_id = p_collection_id
  ),
  lines as (
    select
      l.id as line_id,
      l.order_id,
      l.product_id,
      l.quantity,
      l.total_price_amount,
      o.created_at,
      lower(btrim(regexp_replace(l.product_name, '\s+', ' ', 'g'))) as exact_name,
      btrim(regexp_replace(regexp_replace(lower(l.product_name), '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g'))
        as loose_name
    from order_line_items l
    join orders o on o.id = l.order_id
    where o.status not in ('cancelled', 'refunded')
  ),
  matched as (
    select distinct on (m.collection_id, l.line_id)
      m.collection_id,
      m.product_id,
      l.order_id,
      l.quantity,
      l.total_price_amount,
      (date_trunc('week', l.created_at))::date as week_start
    from members m
    join lines l
      on l.product_id = m.product_id
      or (l.exact_name <> '' and l.exact_name = m.exact_name)
      or (l.loose_name <> '' and l.loose_name = m.loose_name)
    order by m.collection_id, l.line_id, (l.product_id = m.product_id) desc nulls last
  )
  select
    x.collection_id,
    case grouping(x.product_id, x.week_start)
      when 3 then 'total'
      when 1 then 'product'
      else 'week'
    end as level,
    x.product_id,
    x.week_start,
    coalesce(sum(x.quantity), 0)::numeric as units,
    coalesce(sum(x.total_price_amount), 0)::numeric as revenue,
    count(distinct x.order_id) as orders
  from matched x
  group by grouping sets (
    (x.collection_id),
    (x.collection_id, x.product_id),
    (x.collection_id, x.week_start)
  )
  order by 1, 2, 3, 4;
$$;

grant execute on function public.collection_sales_rollup(uuid) to authenticated, service_role;
