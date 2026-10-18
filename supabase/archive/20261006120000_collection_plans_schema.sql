-- Collection planning documents — schema
--
-- Three tables that let a user plan a collection before it launches:
-- collection_plans (1:1 with collections — collaboration type, partner,
-- collaboration-specific terms as jsonb), collection_plan_lines (planned
-- product lines: quantity, unit cost, unit selling price, expected
-- sell-through), collection_plan_costs (planned non-product costs, using
-- the same cost-category vocabulary collection_costs already slugifies
-- real transactions into). Planning-only — no accounting postings.
--
-- RLS copies the exact shape already verified on collections/
-- collection_products/collection_costs: one owner-scoped policy per table,
-- keyed through entities.owner_user_id = auth.uid(), direct or transitive
-- depending on whether the table carries entity_id itself.

-- =============================================================================
-- collection_plans
-- =============================================================================

create table public.collection_plans (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null unique references public.collections(id) on delete cascade,
  entity_id uuid not null references public.entities(id),
  -- Free text, not an enum — matches collections.collection_type and
  -- collection_costs.cost_type, both already plain text in this schema.
  -- UI offers: in_house | wholesale | co_branded | revenue_share | pop_up.
  collaboration_type text not null default 'in_house',
  partner_name text,
  currency text not null default 'GBP',
  notes text,
  -- Collaboration-specific terms (revenue_share_pct, venue_cost_amount,
  -- minimum_order_quantity, etc.) — shape depends on collaboration_type,
  -- validated in the route action rather than the database.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index collection_plans_entity_id_idx on public.collection_plans (entity_id);

alter table public.collection_plans enable row level security;

create policy "collection_plans_owner_policy"
  on public.collection_plans
  for all
  using (
    exists (
      select 1 from public.entities e
      where e.id = collection_plans.entity_id
        and e.owner_user_id = auth.uid()
    )
  );

-- =============================================================================
-- collection_plan_lines — planned product lines
-- =============================================================================

create table public.collection_plan_lines (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.collection_plans(id) on delete cascade,
  -- Exactly one of product_id/product_name should be set — enforced in the
  -- route action, not a CHECK constraint, matching how this codebase
  -- already favors app-level validation for this kind of thing. A planned
  -- SKU often doesn't exist as a real products row yet (products only
  -- exist once synced from Shopify/Squarespace).
  product_id uuid references public.products(id),
  product_name text,
  planned_quantity numeric not null,
  unit_cost numeric not null,
  unit_selling_price numeric not null,
  -- % of planned_quantity expected to actually sell — lets COGS (paid on
  -- every unit produced) and revenue (earned only on units sold) diverge
  -- correctly instead of assuming 100% sell-through.
  expected_sell_through_pct numeric not null default 100,
  notes text,
  display_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index collection_plan_lines_plan_id_idx on public.collection_plan_lines (plan_id);

alter table public.collection_plan_lines enable row level security;

create policy "collection_plan_lines_owner_policy"
  on public.collection_plan_lines
  for all
  using (
    exists (
      select 1 from public.collection_plans p
      join public.entities e on e.id = p.entity_id
      where p.id = collection_plan_lines.plan_id
        and e.owner_user_id = auth.uid()
    )
  );

-- =============================================================================
-- collection_plan_costs — planned non-product costs
-- =============================================================================

create table public.collection_plan_costs (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.collection_plans(id) on delete cascade,
  -- Free text, deliberately the same vocabulary toCostTypeFromAccount()
  -- (app.collections.tsx) already slugifies real transactions into
  -- (fabric, cmt, packaging, freight_in, samples, marketing, social_media,
  -- paid_ads, outbound_shipping, marketplace_fees, other), so a later
  -- planned-vs-actual-by-category comparison lines up without a
  -- translation layer.
  cost_category text not null,
  description text,
  planned_amount numeric not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index collection_plan_costs_plan_id_idx on public.collection_plan_costs (plan_id);

alter table public.collection_plan_costs enable row level security;

create policy "collection_plan_costs_owner_policy"
  on public.collection_plan_costs
  for all
  using (
    exists (
      select 1 from public.collection_plans p
      join public.entities e on e.id = p.entity_id
      where p.id = collection_plan_costs.plan_id
        and e.owner_user_id = auth.uid()
    )
  );
