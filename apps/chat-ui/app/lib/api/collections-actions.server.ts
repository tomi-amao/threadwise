/**
 * Collections: the writes.
 *
 * Every write runs as the signed-in user. The collection tables carry owner-of-the-business
 * policies for all operations, so the database refuses a row that is not theirs; the checks here
 * are for correctness and for kind error messages (and each child row is looked up under the
 * collection named in the URL, so a mismatched id fails cleanly instead of editing something
 * else).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_PLAN_COST_CATEGORIES,
  PLAN_COST_CATEGORIES,
  COLLABORATION_TYPES,
  MAX_PLAN_SIZES,
  MAX_SIZE_LABEL_LENGTH,
  parseSizeQuantities,
  sizesTotal,
  type PlanSizeQuantity,
} from '~/lib/collection-plans';
import { COLLECTION_STATUSES, inferCostTypes } from './collections.server';
import { fetchFxRate } from './collection-plans.server';

export type CollectionActionResult =
  { ok: true; message: string; id?: string } | { ok: false; error: string };

const fail = (error: string): CollectionActionResult => ({ ok: false, error });
const ok = (message: string, id?: string): CollectionActionResult => ({ ok: true, message, id });

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const isNumber = (raw: string) => raw !== '' && Number.isFinite(Number(raw));
const isDay = (raw: string) => /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw));
const isCurrency = (raw: string) => /^[A-Z]{3}$/.test(raw);

export const toSlug = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

// ─── The collection ───────────────────────────────────────────────────

interface CollectionFields {
  name: string;
  slug: string;
  status: string;
  collection_type: string | null;
  launch_date: string | null;
  starts_at: string | null;
  ends_at: string | null;
  planned_budget_amount: number | null;
  budget_currency: string;
  external_ref: string | null;
}

/** Read and check the fields a collection is made of; the same rules for creating and editing. */
function readCollectionFields(form: FormData): CollectionFields | CollectionActionResult {
  const name = text(form, 'name');
  if (!name) return fail('Give the collection a name.');
  if (name.length > 120) return fail('Keep the name under 120 characters.');
  const slug = toSlug(text(form, 'slug') || name);
  if (!slug)
    return fail('A web-friendly name could not be made from that. Try letters or numbers.');

  const status = text(form, 'status') || 'draft';
  if (!(COLLECTION_STATUSES as string[]).includes(status))
    return fail('Choose a status from the list.');

  const launch = text(form, 'launchDate');
  const startsAt = text(form, 'startsAt');
  const endsAt = text(form, 'endsAt');
  for (const [label, value] of [
    ['launch date', launch],
    ['start date', startsAt],
    ['end date', endsAt],
  ] as const) {
    if (value && !isDay(value)) return fail(`Enter the ${label} as a date.`);
  }
  if (startsAt && endsAt && endsAt < startsAt)
    return fail('The end date is before the start date.');

  const budgetRaw = text(form, 'plannedBudgetAmount');
  if (budgetRaw && (!isNumber(budgetRaw) || Number(budgetRaw) < 0)) {
    return fail('The budget must be a number, zero or more.');
  }
  const currency = (text(form, 'budgetCurrency') || 'GBP').toUpperCase();
  if (!isCurrency(currency)) return fail('A currency is a three-letter code, such as GBP.');

  return {
    name,
    slug,
    status,
    collection_type: text(form, 'collectionType') || null,
    launch_date: launch || null,
    starts_at: startsAt || null,
    ends_at: endsAt || null,
    planned_budget_amount: budgetRaw ? Number(budgetRaw) : null,
    budget_currency: currency,
    external_ref: text(form, 'externalRef') || null,
  };
}

const isFields = (v: CollectionFields | CollectionActionResult): v is CollectionFields =>
  'slug' in v;

export async function createCollection(
  supabase: SupabaseClient,
  entityId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const fields = readCollectionFields(form);
  if (!isFields(fields)) return fields;
  const { data, error } = await supabase
    .from('collections')
    .insert({ entity_id: entityId, ...fields })
    .select('id')
    .single();
  if (error) {
    return fail(
      error.code === '23505' ? 'A collection with that name already exists.' : error.message
    );
  }
  return ok(`${fields.name} created`, data.id);
}

export async function updateCollection(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const fields = readCollectionFields(form);
  if (!isFields(fields)) return fields;
  const { data, error } = await supabase
    .from('collections')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', collectionId)
    .select('id');
  if (error) {
    return fail(
      error.code === '23505' ? 'Another collection already has that name.' : error.message
    );
  }
  if (!data || data.length === 0) return fail('That collection was not found.');
  return ok('Collection saved');
}

// ─── Products ─────────────────────────────────────────────────────────

export async function addProducts(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  let ids: string[];
  try {
    ids = [...new Set((JSON.parse(text(form, 'productIds') || '[]') as unknown[]).map(String))];
  } catch {
    return fail('The products could not be read.');
  }
  if (ids.length === 0) return fail('Choose at least one product.');

  const { data: existing } = await supabase
    .from('collection_products')
    .select('product_id')
    .eq('collection_id', collectionId)
    .in('product_id', ids);
  const have = new Set((existing ?? []).map(e => e.product_id as string));
  const fresh = ids.filter(id => !have.has(id));
  if (fresh.length === 0) return ok('Already in this collection');

  // Products must be ones this business can see.
  const { data: visible, error: visibleError } = await supabase
    .from('products')
    .select('id')
    .in('id', fresh);
  if (visibleError) return fail(visibleError.message);
  const allowed = new Set((visible ?? []).map(v => v.id as string));
  if (fresh.some(id => !allowed.has(id))) return fail('One of those products was not found.');

  const { error } = await supabase
    .from('collection_products')
    .insert(fresh.map(product_id => ({ collection_id: collectionId, product_id })));
  if (error) return fail(error.message);
  return ok(fresh.length === 1 ? 'Product added' : `${fresh.length} products added`);
}

export async function updateProduct(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const order = text(form, 'displayOrder');
  const weight = text(form, 'allocationWeight');
  if (order && (!isNumber(order) || Number(order) < 0 || !Number.isInteger(Number(order)))) {
    return fail('The display order must be a whole number, zero or more.');
  }
  if (weight && (!isNumber(weight) || Number(weight) <= 0 || Number(weight) > 1)) {
    return fail('The weight must be above 0 and at most 1.');
  }
  const { data, error } = await supabase
    .from('collection_products')
    .update({
      display_order: order ? Number(order) : null,
      allocation_weight: weight ? Number(weight) : null,
      inclusion_reason: text(form, 'inclusionReason') || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', text(form, 'membershipId'))
    .eq('collection_id', collectionId)
    .select('id');
  if (error) return fail(error.message);
  if (!data || data.length === 0) return fail('That product is not in this collection.');
  return ok('Product saved');
}

export async function removeProduct(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const { data, error } = await supabase
    .from('collection_products')
    .delete()
    .eq('id', text(form, 'membershipId'))
    .eq('collection_id', collectionId)
    .select('id');
  if (error) return fail(error.message);
  if (!data || data.length === 0) return fail('That product is not in this collection.');
  return ok('Product removed');
}

// ─── Linked costs ─────────────────────────────────────────────────────

export async function addCost(
  supabase: SupabaseClient,
  entityId: string,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const transactionId = text(form, 'transactionId');
  if (!transactionId) return fail('Choose a transaction.');

  // The transaction must be one this business can see.
  const { data: txn, error: txnError } = await supabase
    .from('financial_transactions')
    .select('id, metadata')
    .eq('id', transactionId)
    .maybeSingle();
  if (txnError) return fail(txnError.message);
  if (!txn) return fail('That transaction was not found.');

  const { data: existing } = await supabase
    .from('collection_costs')
    .select('id')
    .eq('collection_id', collectionId)
    .eq('financial_transaction_id', transactionId)
    .maybeSingle();
  if (existing) return ok('Already linked');

  const inferred = await inferCostTypes(supabase, [
    { id: txn.id as string, metadata: (txn.metadata as Record<string, unknown> | null) ?? null },
  ]);
  const costType = text(form, 'costType') || inferred.get(transactionId)?.costType || 'other';

  const { error } = await supabase.from('collection_costs').insert({
    entity_id: entityId,
    collection_id: collectionId,
    financial_transaction_id: transactionId,
    cost_type: costType,
    notes: text(form, 'notes') || null,
  });
  if (error) return fail(error.message);
  return ok('Cost linked');
}

export async function updateCost(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const costType = text(form, 'costType');
  if (!costType) return fail('Choose a category.');
  const { data, error } = await supabase
    .from('collection_costs')
    .update({
      cost_type: costType.slice(0, 80),
      notes: text(form, 'notes') || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', text(form, 'costId'))
    .eq('collection_id', collectionId)
    .select('id');
  if (error) return fail(error.message);
  if (!data || data.length === 0) return fail('That cost is not on this collection.');
  return ok('Cost saved');
}

export async function removeCost(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const { data, error } = await supabase
    .from('collection_costs')
    .delete()
    .eq('id', text(form, 'costId'))
    .eq('collection_id', collectionId)
    .select('id');
  if (error) return fail(error.message);
  if (!data || data.length === 0) return fail('That cost is not on this collection.');
  return ok('Cost removed');
}

// ─── The plan ─────────────────────────────────────────────────────────

async function ownPlan(supabase: SupabaseClient, collectionId: string) {
  const { data } = await supabase
    .from('collection_plans')
    .select('id, currency')
    .eq('collection_id', collectionId)
    .maybeSingle();
  return data as { id: string; currency: string } | null;
}

export async function createPlan(
  supabase: SupabaseClient,
  entityId: string,
  collectionId: string
): Promise<CollectionActionResult> {
  const existing = await ownPlan(supabase, collectionId);
  if (existing) return ok('Plan ready', existing.id);

  const { data, error } = await supabase
    .from('collection_plans')
    .insert({ collection_id: collectionId, entity_id: entityId, collaboration_type: 'in_house' })
    .select('id')
    .single();
  if (error) return fail(error.message);

  // A partner should see every cost category from the start, including those with no figure yet
  // ("to be determined"). Best effort: each can still be added by hand.
  await supabase.from('collection_plan_costs').insert(
    DEFAULT_PLAN_COST_CATEGORIES.map(cost_category => ({
      plan_id: data.id,
      cost_category,
      planned_amount: null,
    }))
  );
  return ok('Plan started', data.id);
}

const COLLABORATION_VALUES: string[] = COLLABORATION_TYPES.map(t => t.value);

export async function updatePlan(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const plan = await ownPlan(supabase, collectionId);
  if (!plan) return fail('This collection has no plan yet.');

  const collaborationType = text(form, 'collaborationType') || 'in_house';
  if (!COLLABORATION_VALUES.includes(collaborationType))
    return fail('Choose a collaboration type.');
  const currency = (text(form, 'currency') || 'GBP').toUpperCase();
  if (!isCurrency(currency)) return fail('A currency is a three-letter code, such as GBP.');
  const partnerCurrency = text(form, 'partnerCurrency').toUpperCase();
  if (partnerCurrency && !isCurrency(partnerCurrency)) {
    return fail('The partner currency must be a three-letter code, such as USD.');
  }
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text(form, 'metadata') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    else return fail('The terms could not be read.');
  } catch {
    return fail('The terms could not be read.');
  }
  for (const key of ['revenue_split_pct', 'cost_split_pct', 'revenue_share_pct']) {
    const v = metadata[key];
    if (v != null && (typeof v !== 'number' || v < 0 || v > 100)) {
      return fail('A split or share is a percentage between 0 and 100.');
    }
  }

  const { error } = await supabase
    .from('collection_plans')
    .update({
      collaboration_type: collaborationType,
      partner_name: collaborationType === 'in_house' ? null : text(form, 'partnerName') || null,
      currency,
      partner_currency: collaborationType === 'in_house' ? null : partnerCurrency || null,
      notes: text(form, 'notes') || null,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.id);
  if (error) return fail(error.message);
  return ok('Plan saved');
}

interface LineFields {
  product_id: string | null;
  product_name: string | null;
  planned_quantity: number;
  size_quantities: PlanSizeQuantity[] | null;
  gifted_units: number;
  unit_cost: number;
  unit_cost_currency: string | null;
  unit_cost_original: number | null;
  unit_selling_price: number;
  expected_sell_through_pct: number;
  notes: string | null;
}

/**
 * The size split from the form (a JSON array of {size, quantity}), null when the line has none,
 * or a message for the user when it is not valid. Rows that would be silently dropped (blank
 * sizes, zero units, repeats) are refused instead, so what is saved is what was typed.
 */
function readSizes(form: FormData): PlanSizeQuantity[] | null | string {
  const raw = text(form, 'sizeQuantities');
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'The sizes were not understood.';
  }
  if (!Array.isArray(parsed)) return 'The sizes were not understood.';
  if (parsed.length === 0) return null;
  if (parsed.length > MAX_PLAN_SIZES) return `Use at most ${MAX_PLAN_SIZES} sizes.`;
  const clean = parseSizeQuantities(parsed);
  if (clean.length !== parsed.length) {
    return `Each size needs a name (up to ${MAX_SIZE_LABEL_LENGTH} characters), used once, with a whole number of units above zero.`;
  }
  return clean;
}

/**
 * Read a plan line. A supplier cost quoted in another currency is converted to the plan's own
 * currency once, now, and that result is what every projection uses; the amount as quoted is
 * kept only so the plan can show "£8.50 (≈ $10.00)" from what was actually entered, rather than
 * a figure that drifts with the exchange rate. A failed conversion is an error, not a guess:
 * this feeds real margin maths.
 */
async function readLine(
  form: FormData,
  planCurrency: string
): Promise<LineFields | CollectionActionResult> {
  const productId = text(form, 'productId');
  const productName = text(form, 'productName');
  if (!productId && !productName) return fail('Choose a product or enter a product name.');

  // A size split, when given, decides the quantity: it is their sum.
  const sizeResult = readSizes(form);
  if (typeof sizeResult === 'string') return fail(sizeResult);
  const sizes = sizeResult;
  const qty = sizes ? String(sizesTotal(sizes)) : text(form, 'plannedQuantity');
  const cost = text(form, 'unitCost');
  const price = text(form, 'unitSellingPrice');
  if (![qty, cost, price].every(isNumber)) {
    return fail('Quantity, unit cost and selling price must be numbers.');
  }
  if (Number(qty) <= 0 || !Number.isInteger(Number(qty))) {
    return fail('The planned quantity must be a whole number above zero.');
  }
  if (Number(cost) < 0 || Number(price) < 0) return fail('Costs and prices cannot be negative.');
  const gifted = text(form, 'giftedUnits') || '0';
  if (!isNumber(gifted) || Number(gifted) < 0) return fail('Gifted units must be zero or more.');
  if (Number(gifted) > Number(qty))
    return fail('Gifted units cannot be more than the planned quantity.');
  const sell = text(form, 'expectedSellThroughPct') || '100';
  if (!isNumber(sell) || Number(sell) < 0 || Number(sell) > 100) {
    return fail('Expected sell-through is a percentage between 0 and 100.');
  }

  const quoted = text(form, 'unitCostCurrency').toUpperCase();
  let unitCost = Number(cost);
  let costCurrency: string | null = null;
  let costOriginal: number | null = null;
  if (quoted && quoted !== planCurrency) {
    if (!isCurrency(quoted)) return fail('The supplier currency must be a three-letter code.');
    const fx = await fetchFxRate(quoted, planCurrency);
    if (!fx) {
      return fail(
        `Could not get a live rate for ${quoted} just now. Try again, or enter the cost in ${planCurrency}.`
      );
    }
    unitCost = Number(cost) * fx.rate;
    costCurrency = quoted;
    costOriginal = Number(cost);
  }

  return {
    product_id: productId || null,
    product_name: productId ? null : productName,
    planned_quantity: Number(qty),
    size_quantities: sizes,
    gifted_units: Number(gifted),
    unit_cost: unitCost,
    unit_cost_currency: costCurrency,
    unit_cost_original: costOriginal,
    unit_selling_price: Number(price),
    expected_sell_through_pct: Number(sell),
    notes: text(form, 'notes') || null,
  };
}

const isLine = (v: LineFields | CollectionActionResult): v is LineFields => 'planned_quantity' in v;

export async function addPlanLine(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const plan = await ownPlan(supabase, collectionId);
  if (!plan) return fail('This collection has no plan yet.');
  const line = await readLine(form, plan.currency || 'GBP');
  if (!isLine(line)) return line;
  const { error } = await supabase
    .from('collection_plan_lines')
    .insert({ plan_id: plan.id, ...line });
  if (error) return fail(error.message);
  return ok('Line added');
}

export async function updatePlanLine(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const plan = await ownPlan(supabase, collectionId);
  if (!plan) return fail('This collection has no plan yet.');
  const line = await readLine(form, plan.currency || 'GBP');
  if (!isLine(line)) return line;
  const { data, error } = await supabase
    .from('collection_plan_lines')
    .update({ ...line, updated_at: new Date().toISOString() })
    .eq('id', text(form, 'lineId'))
    .eq('plan_id', plan.id)
    .select('id');
  if (error) return fail(error.message);
  if (!data || data.length === 0) return fail('That line is not on this plan.');
  return ok('Line saved');
}

export async function removePlanLine(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const plan = await ownPlan(supabase, collectionId);
  if (!plan) return fail('This collection has no plan yet.');
  const { data, error } = await supabase
    .from('collection_plan_lines')
    .delete()
    .eq('id', text(form, 'lineId'))
    .eq('plan_id', plan.id)
    .select('id');
  if (error) return fail(error.message);
  if (!data || data.length === 0) return fail('That line is not on this plan.');
  return ok('Line removed');
}

const COST_CATEGORY_VALUES: string[] = PLAN_COST_CATEGORIES.map(c => c.value);

function readPlanCost(form: FormData):
  | {
      cost_category: string;
      description: string | null;
      planned_amount: number | null;
      is_estimated: boolean;
      notes: string | null;
    }
  | CollectionActionResult {
  const category = text(form, 'costCategory');
  // The list, or a category already on the plan (older rows may predate the list).
  if (!COST_CATEGORY_VALUES.includes(category) && !/^[a-z0-9_]{1,40}$/.test(category)) {
    return fail('Choose a category from the list.');
  }
  // An amount is optional: a category can be disclosed before its figure is known ("to be
  // determined"). If something was typed it has to be a number.
  const amountRaw = text(form, 'plannedAmount');
  if (amountRaw && (!isNumber(amountRaw) || Number(amountRaw) < 0)) {
    return fail('The amount must be a number, zero or more.');
  }
  return {
    cost_category: category,
    description: text(form, 'description') || null,
    planned_amount: amountRaw ? Number(amountRaw) : null,
    // With no figure there is nothing to call an estimate.
    is_estimated: amountRaw ? text(form, 'isEstimated') === 'true' : false,
    notes: text(form, 'notes') || null,
  };
}

const isPlanCost = (
  v: ReturnType<typeof readPlanCost>
): v is Exclude<typeof v, CollectionActionResult> => 'cost_category' in v;

export async function addPlanCost(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const plan = await ownPlan(supabase, collectionId);
  if (!plan) return fail('This collection has no plan yet.');
  const cost = readPlanCost(form);
  if (!isPlanCost(cost)) return cost;
  const { error } = await supabase
    .from('collection_plan_costs')
    .insert({ plan_id: plan.id, ...cost });
  if (error) return fail(error.message);
  return ok('Cost added');
}

export async function updatePlanCost(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const plan = await ownPlan(supabase, collectionId);
  if (!plan) return fail('This collection has no plan yet.');
  const cost = readPlanCost(form);
  if (!isPlanCost(cost)) return cost;
  const { data, error } = await supabase
    .from('collection_plan_costs')
    .update({ ...cost, updated_at: new Date().toISOString() })
    .eq('id', text(form, 'costId'))
    .eq('plan_id', plan.id)
    .select('id');
  if (error) return fail(error.message);
  if (!data || data.length === 0) return fail('That cost is not on this plan.');
  return ok('Cost saved');
}

export async function removePlanCost(
  supabase: SupabaseClient,
  collectionId: string,
  form: FormData
): Promise<CollectionActionResult> {
  const plan = await ownPlan(supabase, collectionId);
  if (!plan) return fail('This collection has no plan yet.');
  const { data, error } = await supabase
    .from('collection_plan_costs')
    .delete()
    .eq('id', text(form, 'costId'))
    .eq('plan_id', plan.id)
    .select('id');
  if (error) return fail(error.message);
  if (!data || data.length === 0) return fail('That cost is not on this plan.');
  return ok('Cost removed');
}
