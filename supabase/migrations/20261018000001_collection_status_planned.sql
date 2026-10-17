-- A collection can be "planned": scheduled but not live yet.
--
-- The Collections form always offered it (and the status chip had a colour for it), but the
-- check constraint only allowed draft, active, archived and completed, so choosing "planned"
-- failed with a constraint error.

alter table public.collections drop constraint if exists collections_status_check;
alter table public.collections
  add constraint collections_status_check
  check (status = any (array['draft', 'planned', 'active', 'completed', 'archived']));
