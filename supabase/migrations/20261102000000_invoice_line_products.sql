-- What an invoice bought, kept on the invoice's own lines.
--
-- Invoices no longer touch stock: the invoice drawer's Stock section, which created products,
-- inventory items and PURCHASE movements from invoice lines, is gone. What a line bought is
-- now recorded on the line instead, and shown in the drawer only: a product of the business
-- (linked), a sample (never a product), or something else (freight, fees, services). Nothing
-- here is read by stock levels, inventory valuation or the ledger.

alter table public.invoice_line_items
  add column line_kind text not null default 'other'
    check (line_kind in ('product', 'sample', 'other')),
  add column product_id uuid references public.products(id) on delete set null;

comment on column public.invoice_line_items.line_kind is
  'What the line bought: product (goods the business sells), sample, or other (freight, fees, services). Display only: never read by stock or the ledger.';
comment on column public.invoice_line_items.product_id is
  'The product a product line bought, for linking from the invoice. Display only: setting it changes no product or stock record.';

create index invoice_line_items_product_id
  on public.invoice_line_items (product_id)
  where product_id is not null;

-- Lines the old Stock section recorded as stock keep that as their kind, read from the
-- movement each one made. The movements themselves stay as they are (plain stock records).
update public.invoice_line_items l
set line_kind = case ii.item_type
      when 'sellable' then 'product'
      when 'sample' then 'sample'
      else 'other'
    end,
    product_id = case when ii.item_type = 'sellable' then ii.product_id end
from public.inventory_movements m
join public.inventory_items ii on ii.id = m.inventory_item_id
where m.reference_table = 'invoice_line_items'
  and m.reference_id = l.id
  and m.transaction_type = 'PURCHASE'
  and m.superseded_at is null;
