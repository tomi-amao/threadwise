-- Collection plan costs — allow an unset planned amount
--
-- Default cost categories (import costs, shipping, gifting — see
-- DEFAULT_PLAN_COST_CATEGORIES in app/lib/collection-plans.ts) are seeded
-- onto every new plan so a collaboration partner sees the full cost
-- category list upfront, even before every number is known. A category
-- disclosed with "to be determined" is the whole point — it must be
-- insertable with no amount yet, not blocked until a figure exists.

alter table public.collection_plan_costs
  alter column planned_amount drop not null;
