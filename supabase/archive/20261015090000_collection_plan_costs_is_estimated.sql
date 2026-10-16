-- Lets a planned cost's figure be flagged as a rough guess rather than a
-- firm quote/invoice amount, so the printed plan can make that clear
-- instead of presenting every number with equal confidence.
alter table public.collection_plan_costs
  add column is_estimated boolean not null default false;
