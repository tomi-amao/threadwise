-- Collection plans — optional partner currency
--
-- A plan's own `currency` is the entity's base reporting currency; a
-- collaboration partner often thinks in their own currency instead. This
-- is purely a display annotation — no FX conversion is stored, since a
-- future-dated plan has no "real" settlement rate yet. The live rate is
-- fetched fresh at document-generation time and clearly marked as
-- indicative (see app/lib/api/collection-plans.server.ts::fetchFxRate).

alter table public.collection_plans
  add column partner_currency text;
