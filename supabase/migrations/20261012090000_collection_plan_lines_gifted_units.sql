-- Units of a planned product line given away for free (e.g. PR/influencer
-- gifting), rather than sold. Tracked per-line so projected revenue can be
-- reduced by the actual units gifted, instead of an undifferentiated
-- "gifting" cost-category placeholder.
alter table public.collection_plan_lines
  add column gifted_units numeric not null default 0;
