/**
 * Collection planning — single-collection fetch used by the printable plan
 * pack (api.collections.plan-pack.tsx).
 *
 * Shared types/constants/projection math live in app/lib/collection-plans.ts
 * (no `.server` suffix, since CollectionPlanPanel — a client component —
 * needs them too); only the actual Supabase I/O lives here, mirroring how
 * reports.server.ts relates to api.reports.cash-flow-pack.tsx.
 */

import { getServerSupabaseClient } from '~/lib/supabase';
import {
  computePlanProjections,
  type CollectionPlanCost,
  type CollectionPlanLine,
  type CollectionPlanRecord,
  type CollectionPlanWithProjections,
} from '~/lib/collection-plans';

export interface CollectionPlanPackData {
  collection: {
    id: string;
    name: string;
    slug: string | null;
    status: string;
    collectionType: string | null;
    startsAt: string | null;
    endsAt: string | null;
    launchDate: string | null;
    plannedBudgetAmount: number | null;
    budgetCurrency: string | null;
  };
  planData: CollectionPlanWithProjections | null;
  /** The logged-in entity's own name — it's them that holds any
   * collaboration agreement, not the ThreadWise platform. Null until a plan
   * exists (that's the only place entity_id is currently available from). */
  entityName: string | null;
}

export async function getCollectionPlanPackData(
  collectionId: string
): Promise<CollectionPlanPackData | null> {
  const supabase = getServerSupabaseClient();

  const { data: collectionRow } = await supabase
    .from('collections')
    .select(
      'id, name, slug, status, collection_type, starts_at, ends_at, launch_date, planned_budget_amount, budget_currency'
    )
    .eq('id', collectionId)
    .maybeSingle();

  if (!collectionRow) return null;

  const collection = {
    id: collectionRow.id,
    name: collectionRow.name || 'Untitled collection',
    slug: collectionRow.slug ?? null,
    status: collectionRow.status ?? 'draft',
    collectionType: collectionRow.collection_type ?? null,
    startsAt: collectionRow.starts_at ?? null,
    endsAt: collectionRow.ends_at ?? null,
    launchDate: collectionRow.launch_date ?? null,
    plannedBudgetAmount:
      collectionRow.planned_budget_amount != null
        ? Number(collectionRow.planned_budget_amount)
        : null,
    budgetCurrency: collectionRow.budget_currency ?? 'GBP',
  };

  const { data: planRow } = await supabase
    .from('collection_plans')
    .select(
      'id, collection_id, entity_id, collaboration_type, partner_name, currency, partner_currency, notes, metadata, created_at, updated_at'
    )
    .eq('collection_id', collectionId)
    .maybeSingle();

  if (!planRow) {
    return { collection, planData: null, entityName: null };
  }

  const [linesRes, costsRes, entityRes] = await Promise.all([
    supabase
      .from('collection_plan_lines')
      .select(
        'id, plan_id, product_id, product_name, planned_quantity, gifted_units, unit_cost, unit_selling_price, expected_sell_through_pct, notes, display_order, unit_cost_currency, unit_cost_original, products(name)'
      )
      .eq('plan_id', planRow.id)
      .order('display_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true }),
    supabase
      .from('collection_plan_costs')
      .select('id, plan_id, cost_category, description, planned_amount, notes, created_at')
      .eq('plan_id', planRow.id)
      .order('created_at', { ascending: true }),
    // It's the logged-in entity that actually holds any collaboration
    // agreement, not the ThreadWise platform — payout labels use this name.
    supabase.from('entities').select('name').eq('id', planRow.entity_id).maybeSingle(),
  ]);

  const entityName: string | null =
    (entityRes.data as { name: string | null } | null)?.name ?? null;

  interface RawPlanLineRow {
    id: string;
    plan_id: string;
    product_id: string | null;
    product_name: string | null;
    planned_quantity: number | string | null;
    gifted_units: number | string | null;
    unit_cost: number | string | null;
    unit_selling_price: number | string | null;
    expected_sell_through_pct: number | string | null;
    notes: string | null;
    display_order: number | string | null;
    unit_cost_currency: string | null;
    unit_cost_original: number | string | null;
    products: { name: string | null } | null;
  }

  const lines: CollectionPlanLine[] = ((linesRes.data ?? []) as unknown as RawPlanLineRow[]).map(
    row => ({
      id: row.id,
      planId: row.plan_id,
      productId: row.product_id ?? null,
      productName: row.product_name ?? null,
      linkedProductName: row.products?.name ?? null,
      plannedQuantity: Number(row.planned_quantity || 0),
      giftedUnits: Number(row.gifted_units || 0),
      unitCost: Number(row.unit_cost || 0),
      unitSellingPrice: Number(row.unit_selling_price || 0),
      expectedSellThroughPct: Number(row.expected_sell_through_pct ?? 100),
      notes: row.notes ?? null,
      displayOrder: row.display_order != null ? Number(row.display_order) : null,
      unitCostCurrency: row.unit_cost_currency ?? null,
      unitCostOriginal: row.unit_cost_original != null ? Number(row.unit_cost_original) : null,
    })
  );

  interface RawPlanCostRow {
    id: string;
    plan_id: string;
    cost_category: string;
    description: string | null;
    planned_amount: number | string | null;
    notes: string | null;
  }

  const costs: CollectionPlanCost[] = ((costsRes.data ?? []) as RawPlanCostRow[]).map(row => ({
    id: row.id,
    planId: row.plan_id,
    costCategory: row.cost_category,
    description: row.description ?? null,
    plannedAmount: row.planned_amount != null ? Number(row.planned_amount) : null,
    notes: row.notes ?? null,
  }));

  const plan: CollectionPlanRecord = {
    id: planRow.id,
    collectionId: planRow.collection_id,
    entityId: planRow.entity_id,
    collaborationType: planRow.collaboration_type || 'in_house',
    partnerName: planRow.partner_name ?? null,
    currency: planRow.currency || 'GBP',
    partnerCurrency: planRow.partner_currency ?? null,
    notes: planRow.notes ?? null,
    metadata: planRow.metadata ?? {},
    createdAt: planRow.created_at,
    updatedAt: planRow.updated_at,
  };

  const projections = computePlanProjections(
    plan.collaborationType,
    entityName,
    plan.partnerName,
    plan.metadata,
    lines,
    costs
  );

  return { collection, planData: { plan, lines, costs, projections }, entityName };
}

// ─── Live FX rate (for display only — nothing is stored) ──────────────────

export interface FxRateResult {
  rate: number;
  /** As reported by the provider — a plain date/time string, not re-parsed,
   * since all we do with it is show it verbatim in an "as of" caption. */
  asOf: string;
  baseCurrency: string;
  targetCurrency: string;
}

// open.er-api.com: free, no API key, ~166 currencies (confirmed to include
// ones a 30-currency ECB-only provider like frankfurter.app does not, e.g.
// NGN) — chosen specifically because this feature's whole point is
// partners in countries a narrower provider doesn't cover. Rates refresh
// roughly daily, which is exactly the "indicative of today" precision a
// forward-looking plan needs — anything near-real-time would be false
// precision here.
const FX_API_BASE = 'https://open.er-api.com/v6/latest';
const FX_FETCH_TIMEOUT_MS = 5000;

/** Returns null (never throws) if the currencies match, the code is
 * unsupported, or the request fails/times out — the plan document must
 * still render without the conversion rather than break on a third-party
 * API hiccup. */
export async function fetchFxRate(
  baseCurrency: string,
  targetCurrency: string
): Promise<FxRateResult | null> {
  const base = baseCurrency.trim().toUpperCase();
  const target = targetCurrency.trim().toUpperCase();
  if (!base || !target || base === target) return null;

  try {
    const response = await fetch(`${FX_API_BASE}/${encodeURIComponent(base)}`, {
      signal: AbortSignal.timeout(FX_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (data?.result !== 'success') return null;

    const rate = data?.rates?.[target];
    if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;

    return {
      rate,
      asOf: String(data.time_last_update_utc || ''),
      baseCurrency: base,
      targetCurrency: target,
    };
  } catch {
    return null;
  }
}
