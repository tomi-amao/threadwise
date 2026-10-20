-- A collection plan line can say how its planned quantity splits by size:
--   [{"size": "S", "quantity": 20}, {"size": "M", "quantity": 40}]
-- Null means the line has no breakdown (one quantity, as before). When it is set, the app keeps
-- planned_quantity equal to the sum, so every projection reads planned_quantity unchanged.
alter table public.collection_plan_lines
  add column if not exists size_quantities jsonb
  check (size_quantities is null or jsonb_typeof(size_quantities) = 'array');

comment on column public.collection_plan_lines.size_quantities is
  'Optional split of planned_quantity by size: [{"size": "S", "quantity": 20}, ...]. Null = no split.';
