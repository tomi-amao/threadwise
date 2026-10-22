/**
 * Collections: server-side reads.
 *
 * Every read runs as the signed-in user (row-level security), so a business only ever sees its
 * own collections, products, costs and sales. What a collection has sold is worked out in the
 * database (`collection_sales_rollup`), which returns totals rather than every order line.
 *
 * A collection's *revenue* is the sales of its products. Its *costs* are bank transactions that
 * were linked to it. Its *plan* is a forecast, kept apart from both, so the page can show plan
 * against actual.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computePlanProjections,
  type CollectionPlanCost,
  type CollectionPlanLine,
  type CollectionPlanProjections,
  type CollectionPlanRecord,
  parseSizeQuantities,
} from '~/lib/collection-plans';
import { COLLECTION_STATUSES, type CollectionStatus } from '~/lib/collection-status';
import { fetchFxRate, type FxRateResult } from './collection-plans.server';
import { fetchAllRows } from './paginate.server';

export { COLLECTION_STATUSES, type CollectionStatus };

export interface CollectionRow {
  id: string;
  name: string;
  slug: string | null;
  status: CollectionStatus;
  type: string | null;
  startsAt: string | null;
  endsAt: string | null;
  launchDate: string | null;
  budget: number | null;
  budgetCurrency: string;
  externalRef: string | null;
}

export interface CollectionSummary {
  collection: CollectionRow;
  productCount: number;
  costCount: number;
  units: number;
  revenue: number;
  orders: number;
  cost: number;
  profit: number;
  /** Gross margin in percent, or null when nothing has sold (a margin on zero is meaningless). */
  margin: number | null;
  /** Weekly revenue, oldest first, for the list's trend line. */
  trend: number[];
  hasPlan: boolean;
}

export interface CollectionsIndex {
  summaries: CollectionSummary[];
  totals: {
    collections: number;
    active: number;
    products: number;
    costs: number;
    units: number;
    revenue: number;
    cost: number;
    profit: number;
    margin: number | null;
  };
}

export interface ProductOption {
  id: string;
  name: string;
  provider: string | null;
  productType: string | null;
  thumbnailUrl: string | null;
  /** Sizes on the product's variants (the SIZE attribute), for the plan line's size split. */
  sizes: string[];
}

export interface MembershipRow {
  id: string;
  productId: string | null;
  sku: string | null;
  variantExternalId: string | null;
  displayOrder: number | null;
  inclusionReason: string | null;
  allocationWeight: number | null;
  product: ProductOption | null;
  units: number;
  revenue: number;
}

export interface CostRow {
  id: string;
  transactionId: string;
  costType: string;
  notes: string | null;
  vendor: string | null;
  description: string | null;
  occurredAt: string | null;
  amount: number;
  currency: string;
}

export interface WeekPoint {
  weekStart: string;
  revenue: number;
}

export interface PlanData {
  plan: CollectionPlanRecord;
  lines: CollectionPlanLine[];
  costs: CollectionPlanCost[];
  projections: CollectionPlanProjections;
}

export interface CollectionDetail {
  collection: CollectionRow;
  entityName: string | null;
  memberships: MembershipRow[];
  costs: CostRow[];
  sales: { units: number; revenue: number; orders: number; weekly: WeekPoint[] };
  /** Every non-archived product, for the add-product and plan-line pickers. */
  productOptions: ProductOption[];
  plan: PlanData | null;
  fxRate: FxRateResult | null;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

const COLLECTION_COLUMNS =
  'id, name, slug, status, collection_type, starts_at, ends_at, launch_date, ' +
  'planned_budget_amount, budget_currency, external_ref';

interface DbCollection {
  id: string;
  name: string | null;
  slug: string | null;
  status: string | null;
  collection_type: string | null;
  starts_at: string | null;
  ends_at: string | null;
  launch_date: string | null;
  planned_budget_amount: number | string | null;
  budget_currency: string | null;
  external_ref: string | null;
}

function toCollection(row: DbCollection): CollectionRow {
  return {
    id: row.id,
    name: row.name || 'Untitled collection',
    slug: row.slug ?? null,
    status: (COLLECTION_STATUSES as string[]).includes(row.status ?? '')
      ? (row.status as CollectionStatus)
      : 'draft',
    type: row.collection_type ?? null,
    startsAt: row.starts_at ?? null,
    endsAt: row.ends_at ?? null,
    launchDate: row.launch_date ?? null,
    budget: row.planned_budget_amount != null ? Number(row.planned_budget_amount) : null,
    budgetCurrency: (row.budget_currency ?? 'GBP').trim() || 'GBP',
    externalRef: row.external_ref ?? null,
  };
}

interface RollupRow {
  collection_id: string;
  level: 'total' | 'product' | 'week';
  product_id: string | null;
  week_start: string | null;
  units: number | string;
  revenue: number | string;
  orders: number | string;
}

async function readRollup(supabase: SupabaseClient, collectionId?: string): Promise<RollupRow[]> {
  return fetchAllRows<RollupRow>('collection sales', (from, to) =>
    supabase
      .rpc('collection_sales_rollup', { p_collection_id: collectionId ?? null })
      .order('collection_id')
      .order('level')
      .order('product_id', { nullsFirst: true })
      .order('week_start', { nullsFirst: true })
      .range(from, to)
  );
}

/** What a linked bank transaction counts as in a collection's costs: its amount in the base currency. */
const costAmount = (t: { base_amount: unknown; amount: unknown } | null): number =>
  Math.abs(num(t?.base_amount ?? t?.amount));

interface DbCostWithTxn {
  id: string;
  collection_id: string;
  financial_transaction_id: string;
  cost_type: string | null;
  notes: string | null;
  financial_transactions: {
    description: string | null;
    counterparty_name: string | null;
    amount: number | string | null;
    base_amount: number | string | null;
    occurred_at: string | null;
    currency_code: string | null;
    base_currency_code: string | null;
  } | null;
}

/** The weekly revenue as a trend: the latest eight weeks that had any sales, oldest first. */
function trendOf(weeks: { weekStart: string; revenue: number }[]): number[] {
  return weeks
    .slice()
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .slice(-8)
    .map(w => w.revenue);
}

// ─── The list ─────────────────────────────────────────────────────────

export async function getCollectionsIndex(supabase: SupabaseClient): Promise<CollectionsIndex> {
  const [collectionRows, memberships, costRows, plans, rollup] = await Promise.all([
    fetchAllRows<DbCollection>('collections', (from, to) =>
      supabase
        .from('collections')
        .select(COLLECTION_COLUMNS)
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to)
    ),
    fetchAllRows<{ id: string; collection_id: string }>('collection products', (from, to) =>
      supabase.from('collection_products').select('id, collection_id').order('id').range(from, to)
    ),
    fetchAllRows<DbCostWithTxn>('collection costs', (from, to) =>
      supabase
        .from('collection_costs')
        .select(
          'id, collection_id, financial_transaction_id, cost_type, notes, ' +
            'financial_transactions(description, counterparty_name, amount, base_amount, occurred_at, currency_code, base_currency_code)'
        )
        .order('id')
        .range(from, to)
    ),
    fetchAllRows<{ id: string; collection_id: string }>('collection plans', (from, to) =>
      supabase.from('collection_plans').select('id, collection_id').order('id').range(from, to)
    ),
    readRollup(supabase),
  ]);

  const productCounts = new Map<string, number>();
  for (const m of memberships) {
    productCounts.set(m.collection_id, (productCounts.get(m.collection_id) ?? 0) + 1);
  }
  const costTotals = new Map<string, { count: number; total: number }>();
  for (const c of costRows) {
    const entry = costTotals.get(c.collection_id) ?? { count: 0, total: 0 };
    entry.count += 1;
    entry.total += costAmount(c.financial_transactions);
    costTotals.set(c.collection_id, entry);
  }
  const planned = new Set(plans.map(p => p.collection_id));

  const sales = new Map<
    string,
    {
      units: number;
      revenue: number;
      orders: number;
      weeks: { weekStart: string; revenue: number }[];
    }
  >();
  for (const r of rollup) {
    const entry = sales.get(r.collection_id) ?? { units: 0, revenue: 0, orders: 0, weeks: [] };
    if (r.level === 'total') {
      entry.units = num(r.units);
      entry.revenue = num(r.revenue);
      entry.orders = num(r.orders);
    } else if (r.level === 'week' && r.week_start) {
      entry.weeks.push({ weekStart: r.week_start, revenue: num(r.revenue) });
    }
    sales.set(r.collection_id, entry);
  }

  const summaries = collectionRows.map<CollectionSummary>(row => {
    const collection = toCollection(row);
    const s = sales.get(collection.id);
    const c = costTotals.get(collection.id);
    const revenue = s?.revenue ?? 0;
    const cost = c?.total ?? 0;
    const profit = revenue - cost;
    return {
      collection,
      productCount: productCounts.get(collection.id) ?? 0,
      costCount: c?.count ?? 0,
      units: s?.units ?? 0,
      revenue,
      orders: s?.orders ?? 0,
      cost,
      profit,
      margin: revenue > 0 ? (profit / revenue) * 100 : null,
      trend: s ? trendOf(s.weeks) : [],
      hasPlan: planned.has(collection.id),
    };
  });

  const revenue = summaries.reduce((t, s) => t + s.revenue, 0);
  const cost = summaries.reduce((t, s) => t + s.cost, 0);
  return {
    summaries,
    totals: {
      collections: summaries.length,
      active: summaries.filter(s => s.collection.status === 'active').length,
      products: memberships.length,
      costs: costRows.length,
      units: summaries.reduce((t, s) => t + s.units, 0),
      revenue,
      cost,
      profit: revenue - cost,
      margin: revenue > 0 ? ((revenue - cost) / revenue) * 100 : null,
    },
  };
}

// ─── One collection ───────────────────────────────────────────────────

interface DbProduct {
  id: string;
  name: string | null;
  provider: string | null;
  product_type: string | null;
  metadata: { images?: { url?: string }[] } | null;
  variants?: unknown;
}

const SIZE_ORDER = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl'];

/** The distinct SIZE values on a product's variants, in the usual size order where known. */
export function sizesOfVariants(variants: unknown): string[] {
  if (!Array.isArray(variants)) return [];
  const found: string[] = [];
  for (const variant of variants) {
    const attributes = (variant as { attributes?: Record<string, unknown> } | null)?.attributes;
    if (!attributes || typeof attributes !== 'object') continue;
    for (const [key, value] of Object.entries(attributes)) {
      if (key.toLowerCase() !== 'size' || typeof value !== 'string') continue;
      const label = value.trim();
      if (label && !found.some(f => f.toLowerCase() === label.toLowerCase())) found.push(label);
    }
  }
  const rank = (s: string) => {
    const i = SIZE_ORDER.indexOf(s.toLowerCase());
    return i === -1 ? SIZE_ORDER.length : i;
  };
  return found
    .map((label, index) => ({ label, index }))
    .sort((a, b) => rank(a.label) - rank(b.label) || a.index - b.index)
    .map(item => item.label);
}

function toProductOption(p: DbProduct): ProductOption {
  const images = Array.isArray(p.metadata?.images) ? p.metadata.images : [];
  return {
    id: p.id,
    name: p.name || 'Unnamed product',
    provider: p.provider ?? null,
    productType: p.product_type ?? null,
    thumbnailUrl: images[0]?.url ?? null,
    sizes: sizesOfVariants(p.variants),
  };
}

/** The plan for a collection with its projections, or null when none has been started. */
export async function getPlan(
  supabase: SupabaseClient,
  collectionId: string,
  entityName: string | null
): Promise<PlanData | null> {
  const { data: planRow, error } = await supabase
    .from('collection_plans')
    .select(
      'id, collection_id, entity_id, collaboration_type, partner_name, currency, partner_currency, notes, metadata, created_at, updated_at'
    )
    .eq('collection_id', collectionId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the plan: ${error.message}`);
  if (!planRow) return null;

  const [linesRes, costsRes] = await Promise.all([
    supabase
      .from('collection_plan_lines')
      .select(
        'id, plan_id, product_id, product_name, planned_quantity, size_quantities, gifted_units, unit_cost, unit_selling_price, expected_sell_through_pct, notes, display_order, unit_cost_currency, unit_cost_original, products(name)'
      )
      .eq('plan_id', planRow.id)
      .order('display_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .order('id'),
    supabase
      .from('collection_plan_costs')
      .select('id, plan_id, cost_category, description, planned_amount, is_estimated, notes')
      .eq('plan_id', planRow.id)
      .order('created_at', { ascending: true })
      .order('id'),
  ]);
  if (linesRes.error) throw new Error(`Failed to load plan lines: ${linesRes.error.message}`);
  if (costsRes.error) throw new Error(`Failed to load plan costs: ${costsRes.error.message}`);

  interface RawLine {
    id: string;
    plan_id: string;
    product_id: string | null;
    product_name: string | null;
    planned_quantity: number | string | null;
    size_quantities: unknown;
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
  const lines: CollectionPlanLine[] = ((linesRes.data ?? []) as unknown as RawLine[]).map(r => ({
    id: r.id,
    planId: r.plan_id,
    productId: r.product_id ?? null,
    productName: r.product_name ?? null,
    linkedProductName: r.products?.name ?? null,
    plannedQuantity: num(r.planned_quantity),
    sizeQuantities: parseSizeQuantities(r.size_quantities),
    giftedUnits: num(r.gifted_units),
    unitCost: num(r.unit_cost),
    unitSellingPrice: num(r.unit_selling_price),
    expectedSellThroughPct:
      r.expected_sell_through_pct != null ? Number(r.expected_sell_through_pct) : 100,
    notes: r.notes ?? null,
    displayOrder: r.display_order != null ? Number(r.display_order) : null,
    unitCostCurrency: r.unit_cost_currency ?? null,
    unitCostOriginal: r.unit_cost_original != null ? Number(r.unit_cost_original) : null,
  }));

  interface RawCost {
    id: string;
    plan_id: string;
    cost_category: string;
    description: string | null;
    planned_amount: number | string | null;
    is_estimated: boolean | null;
    notes: string | null;
  }
  const costs: CollectionPlanCost[] = ((costsRes.data ?? []) as unknown as RawCost[]).map(r => ({
    id: r.id,
    planId: r.plan_id,
    costCategory: r.cost_category,
    description: r.description ?? null,
    plannedAmount: r.planned_amount != null ? Number(r.planned_amount) : null,
    isEstimated: r.is_estimated ?? false,
    notes: r.notes ?? null,
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
    metadata: (planRow.metadata as Record<string, unknown> | null) ?? {},
    createdAt: planRow.created_at,
    updatedAt: planRow.updated_at,
  };

  return {
    plan,
    lines,
    costs,
    projections: computePlanProjections(
      plan.collaborationType,
      entityName,
      plan.partnerName,
      plan.metadata,
      lines,
      costs
    ),
  };
}

/** Everything the detail page shows for one collection; null when the user cannot see it. */
export async function getCollectionDetail(
  supabase: SupabaseClient,
  collectionId: string
): Promise<CollectionDetail | null> {
  const { data: row, error } = await supabase
    .from('collections')
    .select(COLLECTION_COLUMNS)
    .eq('id', collectionId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the collection: ${error.message}`);
  if (!row) return null;
  const collection = toCollection(row as unknown as DbCollection);

  const { data: entityRow } = await supabase.from('entities').select('name').limit(1).maybeSingle();
  const entityName = (entityRow as { name: string | null } | null)?.name ?? null;

  const [membershipRes, costRes, productRes, rollup, plan] = await Promise.all([
    supabase
      .from('collection_products')
      .select(
        'id, product_id, sku, variant_external_id, display_order, inclusion_reason, allocation_weight, products(id, name, provider, product_type, metadata)'
      )
      .eq('collection_id', collectionId)
      .order('display_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .order('id'),
    supabase
      .from('collection_costs')
      .select(
        'id, collection_id, financial_transaction_id, cost_type, notes, ' +
          'financial_transactions(description, counterparty_name, amount, base_amount, occurred_at, currency_code, base_currency_code)'
      )
      .eq('collection_id', collectionId)
      .order('created_at', { ascending: false })
      .order('id'),
    fetchAllRows<DbProduct>('products', (from, to) =>
      supabase
        .from('products')
        .select('id, name, provider, product_type, metadata, variants')
        .neq('status', 'archived')
        .order('name')
        .order('id')
        .range(from, to)
    ),
    readRollup(supabase, collectionId),
    getPlan(supabase, collectionId, entityName),
  ]);
  if (membershipRes.error)
    throw new Error(`Failed to load products: ${membershipRes.error.message}`);
  if (costRes.error) throw new Error(`Failed to load costs: ${costRes.error.message}`);

  const productSales = new Map<string, { units: number; revenue: number }>();
  const weekly: WeekPoint[] = [];
  let totals = { units: 0, revenue: 0, orders: 0 };
  for (const r of rollup) {
    if (r.level === 'total') {
      totals = { units: num(r.units), revenue: num(r.revenue), orders: num(r.orders) };
    } else if (r.level === 'product' && r.product_id) {
      productSales.set(r.product_id, { units: num(r.units), revenue: num(r.revenue) });
    } else if (r.level === 'week' && r.week_start) {
      weekly.push({ weekStart: r.week_start, revenue: num(r.revenue) });
    }
  }
  weekly.sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  interface DbMembership {
    id: string;
    product_id: string | null;
    sku: string | null;
    variant_external_id: string | null;
    display_order: number | string | null;
    inclusion_reason: string | null;
    allocation_weight: number | string | null;
    products: DbProduct | null;
  }
  const memberships: MembershipRow[] = (
    (membershipRes.data ?? []) as unknown as DbMembership[]
  ).map(m => {
    const sold = m.product_id ? productSales.get(m.product_id) : undefined;
    return {
      id: m.id,
      productId: m.product_id ?? null,
      sku: m.sku ?? null,
      variantExternalId: m.variant_external_id ?? null,
      displayOrder: m.display_order != null ? Number(m.display_order) : null,
      inclusionReason: m.inclusion_reason ?? null,
      allocationWeight: m.allocation_weight != null ? Number(m.allocation_weight) : null,
      product: m.products ? toProductOption(m.products) : null,
      units: sold?.units ?? 0,
      revenue: sold?.revenue ?? 0,
    };
  });

  const costs: CostRow[] = ((costRes.data ?? []) as unknown as DbCostWithTxn[]).map(c => {
    const t = c.financial_transactions;
    return {
      id: c.id,
      transactionId: c.financial_transaction_id,
      costType: c.cost_type || 'other',
      notes: c.notes ?? null,
      vendor: t?.counterparty_name ?? null,
      description: t?.description ?? null,
      occurredAt: t?.occurred_at ?? null,
      amount: costAmount(t),
      currency: t?.base_currency_code || t?.currency_code || 'GBP',
    };
  });

  // Only this one plan needs a live rate, and only when the partner works in another currency.
  const fxRate =
    plan?.plan.partnerCurrency && plan.plan.partnerCurrency !== plan.plan.currency
      ? await fetchFxRate(plan.plan.currency, plan.plan.partnerCurrency)
      : null;

  return {
    collection,
    entityName,
    memberships,
    costs,
    sales: { ...totals, weekly },
    productOptions: productRes.map(toProductOption),
    plan,
    fxRate,
  };
}

// ─── Finding a transaction to link as a cost ──────────────────────────

export interface CostCandidate {
  id: string;
  description: string | null;
  counterparty: string | null;
  occurredAt: string | null;
  amount: number;
  currency: string;
  /** The expense account the transaction was journalled to, when there is one. */
  accountNumber: string | null;
  accountName: string | null;
  /** The cost type the transaction would be filed under. */
  costType: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);

interface AccountRow {
  id: string;
  account_number: string | number;
  name: string;
  account_type: string | null;
}

const isCostAccount = (a: AccountRow): boolean => {
  const type = (a.account_type ?? '').toLowerCase();
  const number = String(a.account_number);
  const name = a.name.toLowerCase();
  return (
    type.includes('expense') ||
    type.includes('cogs') ||
    type.includes('asset') ||
    /^[5-9]/.test(number) ||
    name.includes('expense') ||
    name.includes('cogs') ||
    name.includes('inventory') ||
    name.includes('finished goods')
  );
};

/**
 * The account and cost type each transaction belongs to. The journal written for it is the best
 * evidence (its largest debit to an expense or stock account); failing that, the account code or
 * expense category the bank feed recorded on the transaction.
 */
export async function inferCostTypes(
  supabase: SupabaseClient,
  transactions: { id: string; metadata: Record<string, unknown> | null }[]
): Promise<
  Map<string, { accountNumber: string | null; accountName: string | null; costType: string }>
> {
  const result = new Map<
    string,
    { accountNumber: string | null; accountName: string | null; costType: string }
  >();
  if (transactions.length === 0) return result;
  const ids = transactions.map(t => t.id);

  const { data: journals } = await supabase
    .from('journals')
    .select('id, source_id, created_at')
    .eq('source_type', 'financial_transaction')
    .neq('status', 'reversed')
    .in('source_id', ids)
    .order('created_at', { ascending: false });
  const journalFor = new Map<string, string>();
  for (const j of journals ?? []) {
    if (!journalFor.has(j.source_id as string))
      journalFor.set(j.source_id as string, j.id as string);
  }

  const journalIds = [...journalFor.values()];
  const { data: lineRows } = journalIds.length
    ? await supabase
        .from('journal_line_items')
        .select('journal_id, account_id, debit')
        .in('journal_id', journalIds)
    : { data: [] as { journal_id: string; account_id: string; debit: number | string }[] };

  const metaCodes = [
    ...new Set(
      transactions
        .map(t => (t.metadata?.account_code ? String(t.metadata.account_code).trim() : ''))
        .filter(Boolean)
    ),
  ];
  const accountIds = [...new Set((lineRows ?? []).map(l => l.account_id as string))];
  const [byId, byCode] = await Promise.all([
    accountIds.length
      ? supabase
          .from('chart_of_accounts')
          .select('id, account_number, name, account_type')
          .in('id', accountIds)
      : Promise.resolve({ data: [] as AccountRow[] }),
    metaCodes.length
      ? supabase
          .from('chart_of_accounts')
          .select('id, account_number, name, account_type')
          .in('account_number', metaCodes)
      : Promise.resolve({ data: [] as AccountRow[] }),
  ]);
  const accounts = new Map(((byId.data ?? []) as AccountRow[]).map(a => [a.id, a]));
  const codes = new Map(
    ((byCode.data ?? []) as AccountRow[]).map(a => [String(a.account_number), a])
  );

  for (const t of transactions) {
    const category = t.metadata?.expense_category ? String(t.metadata.expense_category).trim() : '';
    const code = t.metadata?.account_code ? String(t.metadata.account_code).trim() : '';

    let account: AccountRow | null = null;
    const journalId = journalFor.get(t.id);
    if (journalId) {
      const candidates = (lineRows ?? [])
        .filter(l => l.journal_id === journalId)
        .map(l => ({ account: accounts.get(l.account_id as string) ?? null, debit: num(l.debit) }))
        .filter((c): c is { account: AccountRow; debit: number } => c.account !== null)
        .sort((a, b) => b.debit - a.debit);
      account =
        candidates.find(c => isCostAccount(c.account))?.account ?? candidates[0]?.account ?? null;
    }
    account = account ?? (code ? (codes.get(code) ?? null) : null);

    const number = account ? String(account.account_number) : code || null;
    const costType = account
      ? isCostAccount(account)
        ? slug(`${account.name} ${account.account_number}`) || 'other'
        : category || 'other'
      : category || 'other';
    result.set(t.id, { accountNumber: number, accountName: account?.name ?? null, costType });
  }
  return result;
}

/** Outbound bank transactions that could be linked as a cost, newest first, not yet linked here. */
export async function searchCostCandidates(
  supabase: SupabaseClient,
  collectionId: string,
  query: string
): Promise<CostCandidate[]> {
  const { data: linked } = await supabase
    .from('collection_costs')
    .select('financial_transaction_id')
    .eq('collection_id', collectionId);
  const taken = new Set((linked ?? []).map(l => l.financial_transaction_id as string));

  let q = supabase
    .from('financial_transactions')
    .select(
      'id, description, counterparty_name, amount, base_amount, occurred_at, currency_code, base_currency_code, metadata'
    )
    .eq('direction', 'out')
    .is('excluded_reason', null)
    .order('occurred_at', { ascending: false })
    .limit(80);

  // Free text matches the payee or description; a number matches the amount.
  const text = query.trim().replace(/[%,()]/g, ' ');
  if (text) {
    const asNumber = Number(text.replace(/[£$€,]/g, ''));
    q =
      Number.isFinite(asNumber) && /\d/.test(text)
        ? q.or(
            `amount.eq.${asNumber},description.ilike.%${text}%,counterparty_name.ilike.%${text}%`
          )
        : q.or(`description.ilike.%${text}%,counterparty_name.ilike.%${text}%`);
  }
  const { data, error } = await q;
  if (error) throw new Error(`Failed to search transactions: ${error.message}`);

  const rows = (
    (data ?? []) as unknown as {
      id: string;
      description: string | null;
      counterparty_name: string | null;
      amount: number | string | null;
      base_amount: number | string | null;
      occurred_at: string | null;
      currency_code: string | null;
      base_currency_code: string | null;
      metadata: Record<string, unknown> | null;
    }[]
  )
    .filter(r => !taken.has(r.id))
    .slice(0, 25);

  const inferred = await inferCostTypes(supabase, rows);
  return rows.map(r => {
    const i = inferred.get(r.id);
    return {
      id: r.id,
      description: r.description ?? null,
      counterparty: r.counterparty_name ?? null,
      occurredAt: r.occurred_at ?? null,
      amount: Math.abs(num(r.base_amount ?? r.amount)),
      currency: r.base_currency_code || r.currency_code || 'GBP',
      accountNumber: i?.accountNumber ?? null,
      accountName: i?.accountName ?? null,
      costType: i?.costType ?? 'other',
    };
  });
}

// ─── The printable plan ───────────────────────────────────────────────

export interface PackData {
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
  planData: PlanData | null;
  entityName: string | null;
}

/** A collection and its plan for the print pack; null when the user cannot see the collection. */
export async function getPackData(
  supabase: SupabaseClient,
  collectionId: string
): Promise<PackData | null> {
  const { data: row, error } = await supabase
    .from('collections')
    .select(COLLECTION_COLUMNS)
    .eq('id', collectionId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the collection: ${error.message}`);
  if (!row) return null;
  const c = toCollection(row as unknown as DbCollection);
  const { data: entityRow } = await supabase.from('entities').select('name').limit(1).maybeSingle();
  const entityName = (entityRow as { name: string | null } | null)?.name ?? null;
  return {
    collection: {
      id: c.id,
      name: c.name,
      slug: c.slug,
      status: c.status,
      collectionType: c.type,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      launchDate: c.launchDate,
      plannedBudgetAmount: c.budget,
      budgetCurrency: c.budgetCurrency,
    },
    planData: await getPlan(supabase, collectionId, entityName),
    entityName,
  };
}
