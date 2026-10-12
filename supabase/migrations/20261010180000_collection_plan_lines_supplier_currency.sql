-- Collection plan lines — optional supplier currency for unit cost
--
-- unit_cost remains the authoritative base-currency figure used in every
-- projection calculation, unchanged — these two columns only remember what
-- the user actually entered before conversion, so the plan can display
-- "£8.50 (≈ $10.00)" using the real entered amount rather than a
-- live-recomputed estimate. Unlike the partner-currency conversion (which
-- is deliberately live and re-fetched at view time, since it's purely
-- informational), this is frozen at entry time: a planning number that
-- silently drifted with daily FX every time the page loaded would make
-- projected margins unreliable to plan against.

alter table public.collection_plan_lines
  add column unit_cost_currency text,
  add column unit_cost_original numeric;
