import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from 'react-router';
import { Link, useFetcher, useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import {
  ArrowLeft,
  Calendar,
  CaretRight,
  ChartLineUp,
  CurrencyGbp,
  ListChecks,
  Package,
  Plus,
  Receipt,
  Sparkle,
  StackSimple,
  Tag,
  Trash,
  TrendUp,
  Users,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { getServerSupabaseClient } from '~/lib/supabase';
import { cn } from '~/lib/utils';

export const meta: MetaFunction = () => [
  { title: 'Collections - ThreadWise' },
  { name: 'description', content: 'Track collection membership, costs, and performance' },
];

interface CollectionRow {
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
  externalRef: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface ProductRow {
  id: string;
  name: string;
  provider: string | null;
  status: string;
  productType: string | null;
  thumbnailUrl: string | null;
}

interface CollectionProductRow {
  id: string;
  collectionId: string;
  productId: string | null;
  sku: string | null;
  variantExternalId: string | null;
  displayOrder: number | null;
  inclusionReason: string | null;
  allocationWeight: number | null;
  createdAt: string;
  product: ProductRow | null;
}

interface FinancialTransactionRow {
  id: string;
  entityId: string;
  description: string | null;
  counterpartyName: string | null;
  amount: number | null;
  baseAmount: number | null;
  occurredAt: string | null;
  currencyCode: string | null;
  baseCurrencyCode: string | null;
  metadata: Record<string, unknown> | null;
  metadataAccountCode: string | null;
  metadataExpenseCategory: string | null;
  expenseAccountId: string | null;
  expenseAccountNumber: string | null;
  expenseAccountName: string | null;
  inferredCostType: string | null;
}

interface CollectionCostRow {
  id: string;
  collectionId: string;
  financialTransactionId: string;
  costType: string | null;
  notes: string | null;
  createdAt: string;
  transaction: FinancialTransactionRow | null;
}

interface SalesAggregate {
  units: number;
  revenue: number;
  orders: Set<string>;
}

function normalizeProductKey(value: string | null | undefined) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeLooseProductKey(value: string | null | undefined) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface CollectionSummary {
  collection: CollectionRow;
  products: CollectionProductRow[];
  costs: CollectionCostRow[];
  units: number;
  revenue: number;
  orders: number;
  costTotal: number;
  grossProfit: number;
  grossMargin: number;
  budgetRemaining: number | null;
}

interface LoaderData {
  stats: {
    collections: number;
    active: number;
    linkedProducts: number;
    linkedCosts: number;
    totalRevenue: number;
    totalCost: number;
  };
  summaries: CollectionSummary[];
  selectedCollectionId: string | null;
  selectedCollection: CollectionSummary | null;
  productOptions: ProductRow[];
  transactionOptions: FinancialTransactionRow[];
}

function formatCurrency(value: number, currency = 'GBP') {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDecimal(value: number, digits = 0) {
  return new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatMoneyValue(transaction: FinancialTransactionRow | null) {
  if (!transaction) return '—';
  const currency = transaction.baseCurrencyCode || transaction.currencyCode || 'GBP';
  const value = transaction.baseAmount ?? transaction.amount ?? 0;
  return formatCurrency(Math.abs(Number(value || 0)), currency);
}

function statusTone(status: string) {
  switch (status) {
    case 'active':
      return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';
    case 'completed':
      return 'bg-sky-500/10 text-sky-600 border-sky-500/20';
    case 'planned':
      return 'bg-violet-500/10 text-violet-600 border-violet-500/20';
    case 'archived':
      return 'bg-muted text-muted-foreground border-border';
    default:
      return 'bg-amber-500/10 text-amber-600 border-amber-500/20';
  }
}

function toSlug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function toCostTypeFromAccount(accountName: string | null, accountNumber: string | null) {
  const source = `${accountName || ''} ${accountNumber || ''}`.trim();
  if (!source) return 'other';
  return source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'other';
}

function isExpenseAccount(account: any) {
  const accountType = String(account?.account_type || '').toLowerCase();
  const accountNumber = String(account?.account_number || '').trim();
  const accountName = String(account?.name || '').toLowerCase();

  return (
    accountType.includes('expense') ||
    /^([5-9])/.test(accountNumber) ||
    accountName.includes('expense') ||
    accountName.includes('cogs')
  );
}

function isInventoryAccount(account: any) {
  const accountType = String(account?.account_type || '').toLowerCase();
  const accountName = String(account?.name || '').toLowerCase();

  return (
    accountType.includes('asset') ||
    accountName.includes('inventory') ||
    accountName.includes('finished goods')
  );
}

function deriveCollectionCostTypeFromAccount(account: any) {
  const accountName = String(account?.name || '').trim() || null;
  const accountNumber = String(account?.account_number || '').trim() || null;

  if (isExpenseAccount(account) || isInventoryAccount(account)) {
    return toCostTypeFromAccount(accountName, accountNumber);
  }

  return 'other';
}

function pickExpenseAccountFromJournal(lines: any[], accountMap: Map<string, any>) {
  if (!lines.length) {
    return null;
  }

  const enriched = lines
    .map((line) => ({
      line,
      account: accountMap.get(line.account_id) || null,
      debit: Number(line.debit || 0),
    }))
    .filter((item) => item.account);

  const expenseCandidates = enriched
    .filter((item) => isExpenseAccount(item.account))
    .sort((a, b) => b.debit - a.debit);

  if (expenseCandidates[0]) {
    return expenseCandidates[0].account;
  }

  const fallback = enriched.sort((a, b) => b.debit - a.debit)[0];
  return fallback?.account || null;
}

async function paginateAll<T = unknown>(
  queryFn: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
  pageSize = 1000
) {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data } = await queryFn(from, from + pageSize - 1);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function resolveEntityId(supabase: ReturnType<typeof getServerSupabaseClient>) {
  const { data: entities } = await supabase
    .from('entities')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1);

  if (entities?.[0]?.id) return entities[0].id as string;

  const [collectionsEntity, productsEntity, transactionsEntity] = await Promise.all([
    supabase.from('collections').select('entity_id').limit(1),
    supabase.from('products').select('entity_id').limit(1),
    supabase.from('financial_transactions').select('entity_id').limit(1),
  ]);

  const fallbackEntity =
    (collectionsEntity.data?.[0] as any)?.entity_id ||
    (productsEntity.data?.[0] as any)?.entity_id ||
    (transactionsEntity.data?.[0] as any)?.entity_id ||
    null;

  return fallbackEntity;
}

async function inferTransactionCostInfo(
  supabase: ReturnType<typeof getServerSupabaseClient>,
  entityId: string | null,
  transactionId: string
) {
  let txnEntityId = entityId;
  const { data: transaction } = await supabase
    .from('financial_transactions')
    .select('entity_id, metadata')
    .eq('id', transactionId)
    .maybeSingle();

  if ((transaction as any)?.entity_id) {
    txnEntityId = String((transaction as any).entity_id);
  }

  if (!txnEntityId) {
    return {
      accountId: null as string | null,
      accountNumber: null as string | null,
      accountName: null as string | null,
      inferredCostType: 'other',
    };
  }

  const metadata = (transaction as any)?.metadata ?? null;
  const metadataExpenseCategory = metadata?.expense_category
    ? String(metadata.expense_category).trim()
    : null;
  const metadataAccountCode = metadata?.account_code ? String(metadata.account_code).trim() : null;

  const { data: journal } = await supabase
    .from('journals')
    .select('id')
    .eq('entity_id', txnEntityId)
    .eq('source_type', 'financial_transaction')
    .eq('source_id', transactionId)
    .neq('status', 'reversed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!journal?.id) {
    return {
      accountId: null as string | null,
      accountNumber: null as string | null,
      accountName: null as string | null,
      inferredCostType: 'other',
    };
  }

  const { data: lines } = await supabase
    .from('journal_line_items')
    .select('account_id, debit')
    .eq('journal_id', journal.id);

  const accountIds = Array.from(new Set((lines ?? []).map((line: any) => line.account_id).filter(Boolean)));
  if (!accountIds.length) {
    return {
      accountId: null,
      accountNumber: null,
      accountName: null,
      inferredCostType: 'other',
    };
  }

  const { data: accounts } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number, name, account_type')
    .in('id', accountIds);

  const accountMap = new Map<string, any>((accounts ?? []).map((account: any) => [account.id, account]));
  const expenseAccount = pickExpenseAccountFromJournal(lines ?? [], accountMap);
  if (expenseAccount?.id) {
    const { data: account } = await supabase
      .from('chart_of_accounts')
      .select('id, account_number, name, account_type')
      .eq('id', expenseAccount.id)
      .maybeSingle();

    const accountName = (account as any)?.name ?? null;
    const accountNumber = (account as any)?.account_number ?? null;
    const accountType = (account as any)?.account_type ?? null;

    return {
      accountId: (account as any)?.id ?? null,
      accountNumber,
      accountName,
      inferredCostType: deriveCollectionCostTypeFromAccount({
        name: accountName,
        account_number: accountNumber,
        account_type: accountType,
      }),
    };
  }

  if (metadataAccountCode) {
    const { data: accountByCode } = await supabase
      .from('chart_of_accounts')
      .select('id, account_number, name, account_type')
      .eq('account_number', metadataAccountCode)
      .maybeSingle();

    const accountName = (accountByCode as any)?.name ?? null;
    const accountNumber = (accountByCode as any)?.account_number ?? metadataAccountCode;
    const accountType = (accountByCode as any)?.account_type ?? null;

    return {
      accountId: (accountByCode as any)?.id ?? null,
      accountNumber,
      accountName,
      inferredCostType:
        deriveCollectionCostTypeFromAccount({
          name: accountName,
          account_number: accountNumber,
          account_type: accountType,
        }) || metadataExpenseCategory || toCostTypeFromAccount(accountName, accountNumber),
    };
  }

  if (metadataExpenseCategory) {
    return {
      accountId: null as string | null,
      accountNumber: metadataAccountCode,
      accountName: null as string | null,
      inferredCostType: metadataExpenseCategory,
    };
  }

  return {
    accountId: null as string | null,
    accountNumber: null as string | null,
    accountName: null as string | null,
    inferredCostType: 'other',
  };
}

export async function loader({ request }: LoaderFunctionArgs): Promise<LoaderData> {
  const supabase = getServerSupabaseClient();
  const url = new URL(request.url);
  const selectedCollectionId = url.searchParams.get('collection');
  const entityId = await resolveEntityId(supabase);

  if (!entityId) {
    return {
      stats: {
        collections: 0,
        active: 0,
        linkedProducts: 0,
        linkedCosts: 0,
        totalRevenue: 0,
        totalCost: 0,
      },
      summaries: [],
      selectedCollectionId: null,
      selectedCollection: null,
      productOptions: [],
      transactionOptions: [],
    };
  }

  const [collectionsRes, membershipsRes, costsRes, productsRes, lineItems, transactions] =
    await Promise.all([
      supabase
        .from('collections')
        .select(
          'id, name, slug, status, collection_type, starts_at, ends_at, launch_date, planned_budget_amount, budget_currency, external_ref, metadata, created_at, updated_at'
        )
        .eq('entity_id', entityId)
        .order('created_at', { ascending: false }),
      supabase
        .from('collection_products')
        .select(
          'id, collection_id, product_id, sku, variant_external_id, display_order, inclusion_reason, allocation_weight, created_at, products(id, name, provider, status, product_type, metadata)'
        )
        .order('display_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true }),
      supabase
        .from('collection_costs')
        .select(
          'id, collection_id, financial_transaction_id, cost_type, notes, created_at, financial_transactions(id, description, counterparty_name, amount, base_amount, occurred_at, currency_code, base_currency_code)'
        )
        .eq('entity_id', entityId)
        .order('created_at', { ascending: false }),
      supabase
        .from('products')
        .select('id, name, provider, status, product_type, metadata, variants')
        .eq('entity_id', entityId)
        .neq('status', 'archived')
        .order('name'),
      paginateAll<{
        id: string;
        product_id: string | null;
        product_name: string | null;
        order_id: string;
        quantity: number;
        total_price_amount: number | null;
      }>(
        (from, to) =>
          supabase
            .from('order_line_items')
            .select('id, product_id, product_name, order_id, quantity, total_price_amount')
            .range(from, to)
      ),
      paginateAll<{
        id: string;
        entity_id: string;
        description: string | null;
        counterparty_name: string | null;
        amount: number | null;
        base_amount: number | null;
        occurred_at: string | null;
        currency_code: string | null;
        base_currency_code: string | null;
        metadata: Record<string, unknown> | null;
      }>((from, to) =>
        supabase
          .from('financial_transactions')
          .select('id, entity_id, description, counterparty_name, amount, base_amount, occurred_at, currency_code, base_currency_code, metadata')
          .eq('entity_id', entityId)
          .range(from, to)
      ),
    ]);

  const metadataAccountCodes = Array.from(
    new Set(
      (transactions ?? [])
        .map((transaction: any) => {
          const code = transaction?.metadata?.account_code;
          return code ? String(code).trim() : null;
        })
        .filter(Boolean)
    )
  ) as string[];

  const metadataAccountRows = metadataAccountCodes.length
    ? await supabase
        .from('chart_of_accounts')
        .select('id, account_number, name, account_type')
        .in('account_number', metadataAccountCodes)
    : { data: [] as any[] };

  const accountByNumber = new Map<string, any>(
    (metadataAccountRows.data ?? []).map((account: any) => [String(account.account_number), account])
  );

  const transactionEntityIds = Array.from(
    new Set((transactions ?? []).map((transaction: any) => transaction.entity_id).filter(Boolean))
  ) as string[];

  const transactionIds = (transactions ?? []).map((transaction: any) => transaction.id);
  const journalsData: any[] = [];
  if (transactionIds.length && transactionEntityIds.length) {
    const txnIdChunks = chunkArray(transactionIds, 150);
    for (const txnIdChunk of txnIdChunks) {
      const journalsChunk = await supabase
        .from('journals')
        .select('id, source_id, status, created_at')
        .in('entity_id', transactionEntityIds)
        .eq('source_type', 'financial_transaction')
        .neq('status', 'reversed')
        .in('source_id', txnIdChunk)
        .order('created_at', { ascending: false });
      journalsData.push(...(journalsChunk.data ?? []));
    }
  }

  const journalIds = journalsData.map((journal: any) => journal.id);
  const journalLinesData: any[] = [];
  if (journalIds.length) {
    const journalIdChunks = chunkArray(journalIds, 300);
    for (const journalIdChunk of journalIdChunks) {
      const linesChunk = await supabase
        .from('journal_line_items')
        .select('journal_id, account_id, debit, credit')
        .in('journal_id', journalIdChunk);
      journalLinesData.push(...(linesChunk.data ?? []));
    }
  }

  const accountIds = Array.from(
    new Set(journalLinesData.map((line: any) => line.account_id).filter(Boolean))
  );
  const accountsData: any[] = [];
  if (accountIds.length) {
    const accountIdChunks = chunkArray(accountIds, 300);
    for (const accountIdChunk of accountIdChunks) {
      const accountsChunk = await supabase
        .from('chart_of_accounts')
        .select('id, account_number, name, account_type')
        .in('id', accountIdChunk);
      accountsData.push(...(accountsChunk.data ?? []));
    }
  }

  const accountMap = new Map<string, any>(accountsData.map((account: any) => [account.id, account]));
  const journalBySourceId = new Map<string, any>();
  for (const journal of journalsData) {
    const sourceId = (journal as any).source_id;
    if (!journalBySourceId.has(sourceId)) {
      journalBySourceId.set(sourceId, journal);
    }
  }
  const journalLinesByJournalId = new Map<string, any[]>();
  for (const line of journalLinesData) {
    const key = (line as any).journal_id;
    const existing = journalLinesByJournalId.get(key) ?? [];
    existing.push(line);
    journalLinesByJournalId.set(key, existing);
  }

  const productOptions: ProductRow[] = (productsRes.data ?? []).map((product: any) => {
    const meta = product.metadata ?? {};
    const images = Array.isArray(meta.images) ? meta.images : [];
    return {
      id: product.id,
      name: product.name || 'Unnamed product',
      provider: product.provider ?? null,
      status: product.status,
      productType: product.product_type ?? null,
      thumbnailUrl: images[0]?.url ?? null,
    };
  });

  const productMap = new Map(productOptions.map((product) => [product.id, product]));

  const normalizedLineItems = lineItems.map((item) => ({
    id: item.id,
    productId: item.product_id,
    orderId: item.order_id,
    units: Number(item.quantity || 0),
    revenue: Number(item.total_price_amount || 0),
    normalizedName: normalizeProductKey(item.product_name),
    normalizedLooseName: normalizeLooseProductKey(item.product_name),
  }));

  const collections: CollectionRow[] = (collectionsRes.data ?? []).map((collection: any) => ({
    id: collection.id,
    name: collection.name || 'Untitled collection',
    slug: collection.slug ?? null,
    status: collection.status ?? 'draft',
    collectionType: collection.collection_type ?? null,
    startsAt: collection.starts_at ?? null,
    endsAt: collection.ends_at ?? null,
    launchDate: collection.launch_date ?? null,
    plannedBudgetAmount:
      collection.planned_budget_amount != null ? Number(collection.planned_budget_amount) : null,
    budgetCurrency: collection.budget_currency ?? 'GBP',
    externalRef: collection.external_ref ?? null,
    metadata: collection.metadata ?? null,
    createdAt: collection.created_at,
    updatedAt: collection.updated_at,
  }));

  const memberships: CollectionProductRow[] = (membershipsRes.data ?? []).map((membership: any) => ({
    id: membership.id,
    collectionId: membership.collection_id,
    productId: membership.product_id ?? null,
    sku: membership.sku ?? null,
    variantExternalId: membership.variant_external_id ?? null,
    displayOrder: membership.display_order != null ? Number(membership.display_order) : null,
    inclusionReason: membership.inclusion_reason ?? null,
    allocationWeight: membership.allocation_weight != null ? Number(membership.allocation_weight) : null,
    createdAt: membership.created_at,
    product: membership.products
      ? {
          id: membership.products.id,
          name: membership.products.name || 'Unnamed product',
          provider: membership.products.provider ?? null,
          status: membership.products.status,
          productType: membership.products.product_type ?? null,
          thumbnailUrl: Array.isArray(membership.products.metadata?.images)
            ? membership.products.metadata.images[0]?.url ?? null
            : null,
        }
      : membership.product_id
        ? productMap.get(membership.product_id) ?? null
        : null,
  }));

  const costs: CollectionCostRow[] = (costsRes.data ?? []).map((cost: any) => ({
    id: cost.id,
    collectionId: cost.collection_id,
    financialTransactionId: cost.financial_transaction_id,
    costType: cost.cost_type ?? null,
    notes: cost.notes ?? null,
    createdAt: cost.created_at,
    transaction: cost.financial_transactions
      ? {
          id: cost.financial_transactions.id,
          entityId: entityId,
          description: cost.financial_transactions.description ?? null,
          counterpartyName: cost.financial_transactions.counterparty_name ?? null,
          amount:
            cost.financial_transactions.amount != null
              ? Number(cost.financial_transactions.amount)
              : null,
          baseAmount:
            cost.financial_transactions.base_amount != null
              ? Number(cost.financial_transactions.base_amount)
              : null,
          occurredAt: cost.financial_transactions.occurred_at ?? null,
          currencyCode: cost.financial_transactions.currency_code ?? null,
          baseCurrencyCode: cost.financial_transactions.base_currency_code ?? null,
          metadata: null,
          metadataAccountCode: null,
          metadataExpenseCategory: null,
          expenseAccountId: null,
          expenseAccountNumber: null,
          expenseAccountName: null,
          inferredCostType: cost.cost_type ?? null,
        }
      : null,
  }));

  const transactionOptions: FinancialTransactionRow[] = transactions.map((transaction: any) => {
    const metadata = transaction.metadata ?? null;
    const metadataAccountCode = metadata?.account_code ? String(metadata.account_code).trim() : null;
    const metadataExpenseCategory = metadata?.expense_category
      ? String(metadata.expense_category).trim()
      : null;

    const metadataAccount = metadataAccountCode ? accountByNumber.get(metadataAccountCode) : null;

    const journal = journalBySourceId.get(transaction.id);
    const lines = journal ? journalLinesByJournalId.get(journal.id) ?? [] : [];
    const journalExpenseAccount = pickExpenseAccountFromJournal(lines, accountMap);
    const expenseAccount = journalExpenseAccount || metadataAccount;
    const expenseAccountName = expenseAccount?.name ?? null;
    const expenseAccountNumber = expenseAccount?.account_number ?? metadataAccountCode ?? null;
    const expenseAccountType = expenseAccount?.account_type ?? null;

    return {
      id: transaction.id,
      entityId: transaction.entity_id,
      description: transaction.description ?? null,
      counterpartyName: transaction.counterparty_name ?? null,
      amount: transaction.amount != null ? Number(transaction.amount) : null,
      baseAmount: transaction.base_amount != null ? Number(transaction.base_amount) : null,
      occurredAt: transaction.occurred_at ?? null,
      currencyCode: transaction.currency_code ?? null,
      baseCurrencyCode: transaction.base_currency_code ?? null,
      metadata,
      metadataAccountCode,
      metadataExpenseCategory,
      expenseAccountId: expenseAccount?.id ?? null,
      expenseAccountNumber,
      expenseAccountName,
      inferredCostType:
        journalExpenseAccount
          ? deriveCollectionCostTypeFromAccount({
              name: expenseAccountName,
              account_number: expenseAccountNumber,
              account_type: expenseAccountType,
            })
          : metadataExpenseCategory ||
            deriveCollectionCostTypeFromAccount({
              name: expenseAccountName,
              account_number: expenseAccountNumber,
              account_type: expenseAccountType,
            }),
    };
  });

  const summaries = collections.map<CollectionSummary>((collection) => {
    const collectionMemberships = memberships
      .filter((membership) => membership.collectionId === collection.id)
      .sort(
        (a, b) =>
          (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER)
      );
    const collectionCosts = costs.filter((cost) => cost.collectionId === collection.id);

    const membershipProductIds = new Set(
      collectionMemberships
        .map((membership) => membership.productId)
        .filter((productId): productId is string => Boolean(productId))
    );
    const membershipNames = new Set(
      collectionMemberships
        .map((membership) => normalizeProductKey(membership.product?.name))
        .filter((name) => Boolean(name))
    );
    const membershipLooseNames = new Set(
      collectionMemberships
        .map((membership) => normalizeLooseProductKey(membership.product?.name))
        .filter((name) => Boolean(name))
    );

    const matchedLineIds = new Set<string>();
    const orderIds = new Set<string>();
    let units = 0;
    let revenue = 0;

    for (const item of normalizedLineItems) {
      const lineKey = item.id || `${item.orderId}:${item.productId || item.normalizedName}`;
      if (matchedLineIds.has(lineKey)) continue;

      const byId = item.productId ? membershipProductIds.has(item.productId) : false;
      const byExactName = item.normalizedName ? membershipNames.has(item.normalizedName) : false;
      const byLooseName = item.normalizedLooseName
        ? membershipLooseNames.has(item.normalizedLooseName)
        : false;

      if (!byId && !byExactName && !byLooseName) continue;

      matchedLineIds.add(lineKey);
      units += item.units;
      revenue += item.revenue;
      orderIds.add(item.orderId);
    }

    const costTotal = collectionCosts.reduce((sum, cost) => {
      const transaction = cost.transaction;
      const value = transaction?.baseAmount ?? transaction?.amount ?? 0;
      return sum + Math.abs(Number(value || 0));
    }, 0);

    const grossProfit = revenue - costTotal;
    const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
    const budgetRemaining =
      collection.plannedBudgetAmount != null ? collection.plannedBudgetAmount - costTotal : null;

    return {
      collection,
      products: collectionMemberships,
      costs: collectionCosts,
      units,
      revenue,
      orders: orderIds.size,
      costTotal,
      grossProfit,
      grossMargin,
      budgetRemaining,
    };
  });

  const selectedCollection =
    summaries.find((summary) => summary.collection.id === selectedCollectionId) ?? summaries[0] ?? null;

  const stats = {
    collections: summaries.length,
    active: summaries.filter((summary) => summary.collection.status === 'active').length,
    linkedProducts: memberships.length,
    linkedCosts: costs.length,
    totalRevenue: summaries.reduce((sum, summary) => sum + summary.revenue, 0),
    totalCost: summaries.reduce((sum, summary) => sum + summary.costTotal, 0),
  };

  return {
    stats,
    summaries,
    selectedCollectionId: selectedCollection?.collection.id ?? null,
    selectedCollection,
    productOptions,
    transactionOptions,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const supabase = getServerSupabaseClient();
  const body = await request.formData();
  const intent = String(body.get('intent') || '');

  const collectionIdFromBody = String(body.get('collectionId') || '').trim();
  let entityId: string | null = null;
  if (collectionIdFromBody) {
    const { data: collectionRow } = await supabase
      .from('collections')
      .select('entity_id')
      .eq('id', collectionIdFromBody)
      .maybeSingle();
    entityId = (collectionRow as any)?.entity_id ?? null;
  }

  if (!entityId && intent !== 'create_collection') {
    return { ok: false, error: 'No entity found for selected collection' };
  }

  if (!entityId && intent === 'create_collection') {
    entityId = await resolveEntityId(supabase);
    if (!entityId) {
      return { ok: false, error: 'No entity found to create collection under' };
    }
  }

  if (intent === 'create_collection') {
    const name = String(body.get('name') || '').trim();
    const slugInput = String(body.get('slug') || '').trim();
    const status = String(body.get('status') || 'draft').trim();
    const collectionType = String(body.get('collectionType') || '').trim();
    const launchDate = String(body.get('launchDate') || '').trim();
    const startsAt = String(body.get('startsAt') || '').trim();
    const endsAt = String(body.get('endsAt') || '').trim();
    const plannedBudgetRaw = String(body.get('plannedBudgetAmount') || '').trim();
    const budgetCurrency = String(body.get('budgetCurrency') || 'GBP').trim();

    if (!name) {
      return { ok: false, error: 'Collection name is required' };
    }

    const slug = toSlug(slugInput || name);
    if (!slug) {
      return { ok: false, error: 'A valid slug could not be generated' };
    }

    if (plannedBudgetRaw && Number.isNaN(Number(plannedBudgetRaw))) {
      return { ok: false, error: 'Planned budget must be a valid number' };
    }

    const { data, error } = await supabase
      .from('collections')
      .insert({
        entity_id: entityId,
        name,
        slug,
        status,
        collection_type: collectionType || null,
        launch_date: launchDate || null,
        starts_at: startsAt || null,
        ends_at: endsAt || null,
        planned_budget_amount: plannedBudgetRaw ? Number(plannedBudgetRaw) : null,
        budget_currency: budgetCurrency || 'GBP',
      })
      .select('id')
      .single();

    if (error) return { ok: false, error: error.message };
    return { ok: true, intent: 'create_collection', collectionId: data.id };
  }

  if (intent === 'add_product') {
    const collectionId = String(body.get('collectionId') || '');
    const productId = String(body.get('productId') || '');
    const inclusionReason = String(body.get('inclusionReason') || '').trim();
    const displayOrderRaw = String(body.get('displayOrder') || '').trim();
    const allocationWeightRaw = String(body.get('allocationWeight') || '').trim();

    if (!collectionId || !productId) {
      return { ok: false, error: 'collectionId and productId are required' };
    }

    const payload: Record<string, unknown> = {
      collection_id: collectionId,
      product_id: productId,
      inclusion_reason: inclusionReason || null,
      display_order: displayOrderRaw ? Number(displayOrderRaw) : null,
      allocation_weight: allocationWeightRaw ? Number(allocationWeightRaw) : null,
    };

    if (displayOrderRaw && Number.isNaN(Number(displayOrderRaw))) {
      return { ok: false, error: 'Display order must be a number' };
    }

    if (allocationWeightRaw && Number.isNaN(Number(allocationWeightRaw))) {
      return { ok: false, error: 'Allocation weight must be a number' };
    }

    const { data: existingMembership } = await supabase
      .from('collection_products')
      .select('id')
      .eq('collection_id', collectionId)
      .eq('product_id', productId)
      .maybeSingle();

    if (existingMembership) {
      return { ok: true, intent: 'add_product' };
    }

    const { error } = await supabase.from('collection_products').insert(payload);
    if (error) return { ok: false, error: error.message };
    return { ok: true, intent: 'add_product' };
  }

  if (intent === 'add_cost') {
    const collectionId = String(body.get('collectionId') || '');
    const financialTransactionId = String(body.get('financialTransactionId') || '');
    const costTypeInput = String(body.get('costType') || '').trim();
    const notes = String(body.get('notes') || '').trim();

    if (!collectionId || !financialTransactionId) {
      return { ok: false, error: 'collectionId and financialTransactionId are required' };
    }

    const { data: existingCost } = await supabase
      .from('collection_costs')
      .select('id')
      .eq('collection_id', collectionId)
      .eq('financial_transaction_id', financialTransactionId)
      .maybeSingle();

    if (existingCost) {
      return { ok: true, intent: 'add_cost' };
    }

    const inferred = await inferTransactionCostInfo(supabase, entityId, financialTransactionId);
    const costType = costTypeInput || inferred.inferredCostType || 'other';

    const { error } = await supabase.from('collection_costs').insert({
      entity_id: entityId,
      collection_id: collectionId,
      financial_transaction_id: financialTransactionId,
      cost_type: costType,
      notes: notes || null,
    });

    if (error) return { ok: false, error: error.message };
    return { ok: true, intent: 'add_cost' };
  }

  if (intent === 'remove_product') {
    const membershipId = String(body.get('membershipId') || '');
    const collectionIdFromForm = String(body.get('collectionId') || '');

    if (!membershipId || !collectionIdFromForm) {
      return { ok: false, error: 'membershipId and collectionId are required' };
    }

    const { data: membership } = await supabase
      .from('collection_products')
      .select('collection_id')
      .eq('id', membershipId)
      .maybeSingle();

    if (!membership || (membership as any).collection_id !== collectionIdFromForm) {
      return { ok: false, error: 'Membership does not belong to this collection' };
    }

    const { error } = await supabase
      .from('collection_products')
      .delete()
      .eq('id', membershipId);

    if (error) return { ok: false, error: error.message };
    return { ok: true, intent: 'remove_product' };
  }

  if (intent === 'remove_cost') {
    const costId = String(body.get('costId') || '');
    const collectionIdFromForm = String(body.get('collectionId') || '');

    if (!costId || !collectionIdFromForm) {
      return { ok: false, error: 'costId and collectionId are required' };
    }

    const { data: cost } = await supabase
      .from('collection_costs')
      .select('collection_id, entity_id')
      .eq('id', costId)
      .maybeSingle();

    if (!cost || (cost as any).collection_id !== collectionIdFromForm) {
      return { ok: false, error: 'Cost does not belong to this collection' };
    }

    if ((cost as any).entity_id !== entityId) {
      return { ok: false, error: 'Unauthorized' };
    }

    const { error } = await supabase
      .from('collection_costs')
      .delete()
      .eq('id', costId);

    if (error) return { ok: false, error: error.message };
    return { ok: true, intent: 'remove_cost' };
  }

  return { ok: false, error: `Unknown intent: ${intent}` };
}

function CreateCollectionForm({
  onCreated,
}: {
  onCreated: (collectionId: string) => void;
}) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [status, setStatus] = useState('draft');
  const [collectionType, setCollectionType] = useState('');
  const [launchDate, setLaunchDate] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [plannedBudgetAmount, setPlannedBudgetAmount] = useState('');
  const [budgetCurrency, setBudgetCurrency] = useState('GBP');
  const lastState = useRef(fetcher.state);

  useEffect(() => {
    if (lastState.current !== 'idle' && fetcher.state === 'idle' && (fetcher.data as any)?.ok) {
      const collectionId = String((fetcher.data as any).collectionId || '');
      if (collectionId) {
        onCreated(collectionId);
      }
      revalidator.revalidate();
      setName('');
      setSlug('');
      setSlugManuallyEdited(false);
      setStatus('draft');
      setCollectionType('');
      setLaunchDate('');
      setStartsAt('');
      setEndsAt('');
      setPlannedBudgetAmount('');
      setBudgetCurrency('GBP');
    }
    lastState.current = fetcher.state;
  }, [fetcher.data, fetcher.state, onCreated, revalidator]);

  useEffect(() => {
    if (slugManuallyEdited) return;
    setSlug(toSlug(name));
  }, [name, slugManuallyEdited]);

  return (
    <fetcher.Form method="post" className="rounded-2xl border border-border bg-card p-4 space-y-4 shadow-sm">
      <input type="hidden" name="intent" value="create_collection" />

      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-foreground">Create collection</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Start a new collection, then attach products and cost transactions.
          </p>
        </div>
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <Plus size={18} />
        </div>
      </div>

      <div className="grid gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <input
            type="text"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="AW26 Core Drop"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Slug</label>
            <input
              type="text"
              name="slug"
              value={slug}
              onChange={(event) => {
                const nextSlug = toSlug(event.target.value);
                setSlug(nextSlug);
                setSlugManuallyEdited(nextSlug !== toSlug(name));
              }}
              placeholder="aw26-core-drop"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <select
              name="status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {['draft', 'active', 'planned', 'completed', 'archived'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Collection type</label>
            <input
              type="text"
              name="collectionType"
              value={collectionType}
              onChange={(event) => setCollectionType(event.target.value)}
              placeholder="seasonal / capsule / drop"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Launch date</label>
            <input
              type="date"
              name="launchDate"
              value={launchDate}
              onChange={(event) => setLaunchDate(event.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Starts at</label>
            <input
              type="date"
              name="startsAt"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Ends at</label>
            <input
              type="date"
              name="endsAt"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Planned budget</label>
            <input
              type="number"
              step="0.01"
              min="0"
              name="plannedBudgetAmount"
              value={plannedBudgetAmount}
              onChange={(event) => setPlannedBudgetAmount(event.target.value)}
              placeholder="Optional"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Currency</label>
            <input
              type="text"
              name="budgetCurrency"
              value={budgetCurrency}
              onChange={(event) => setBudgetCurrency(event.target.value.toUpperCase().slice(0, 3))}
              placeholder="GBP"
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm uppercase text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs text-muted-foreground">After creation, the new collection is selected automatically.</p>
        <Button type="submit" disabled={fetcher.state !== 'idle'}>
          Create collection
        </Button>
      </div>

      {((fetcher.data as any)?.error as string | undefined) && (
        <p className="text-xs text-destructive">{(fetcher.data as any).error}</p>
      )}
    </fetcher.Form>
  );
}

function MetricCard({
  label,
  value,
  helper,
  icon,
}: {
  label: string;
  value: string;
  helper: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-4 mb-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          {icon}
        </div>
      </div>
      <p className="text-2xl font-semibold text-foreground tabular-nums">{value}</p>
      <p className="text-xs font-medium text-foreground/90 mt-1">{label}</p>
      <p className="text-xs text-muted-foreground mt-1.5">{helper}</p>
    </div>
  );
}

function CollectionCard({ summary, active }: { summary: CollectionSummary; active: boolean }) {
  return (
    <Link
      to={`/collections?collection=${summary.collection.id}`}
      className={cn(
        'block rounded-2xl border p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md',
        active ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-card'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-foreground truncate">{summary.collection.name}</h3>
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize',
                statusTone(summary.collection.status)
              )}
            >
              {summary.collection.status}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {summary.collection.collectionType || 'General collection'}
          </p>
        </div>
        <CaretRight size={16} className="text-muted-foreground shrink-0 mt-0.5" />
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Products</p>
          <p className="font-medium text-foreground tabular-nums">{summary.products.length}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Revenue</p>
          <p className="font-medium text-foreground tabular-nums">{formatCurrency(summary.revenue)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Costs</p>
          <p className="font-medium text-foreground tabular-nums">{formatCurrency(summary.costTotal)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Margin</p>
          <p className="font-medium text-foreground tabular-nums">{formatDecimal(summary.grossMargin, 1)}%</p>
        </div>
      </div>
    </Link>
  );
}

function RemoveProductButton({ membershipId, collectionId, productName }: { membershipId: string; collectionId: string; productName: string }) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [showConfirm, setShowConfirm] = useState(false);
  const data = (fetcher.data as any);
  const error = data?.error;

  const handleDelete = () => {
    fetcher.submit(
      { intent: 'remove_product', membershipId, collectionId },
      { method: 'post' }
    );
  };

  useEffect(() => {
    if (fetcher.state === 'idle' && data?.ok) {
      setShowConfirm(false);
      revalidator.revalidate();
    }
  }, [fetcher.data, fetcher.state, revalidator]);

  if (error && showConfirm) {
    return (
      <div className="flex gap-2 items-center">
        <div className="text-xs text-red-600 bg-red-500/20 px-2 py-1 rounded">
          {error}
        </div>
        <button
          type="button"
          onClick={() => { setShowConfirm(false); fetcher.data = null; }}
          disabled={fetcher.state !== 'idle'}
          className="px-2 py-1 text-xs rounded bg-muted hover:bg-muted/80 text-foreground disabled:opacity-50"
        >
          Close
        </button>
      </div>
    );
  }

  if (showConfirm) {
    return (
      <div className="flex gap-2 items-center">
        <button
          type="button"
          onClick={handleDelete}
          disabled={fetcher.state !== 'idle'}
          className="px-2 py-1 text-xs rounded bg-red-500/20 text-red-600 hover:bg-red-500/30 disabled:opacity-50"
        >
          Remove
        </button>
        <button
          type="button"
          onClick={() => setShowConfirm(false)}
          disabled={fetcher.state !== 'idle'}
          className="px-2 py-1 text-xs rounded bg-muted hover:bg-muted/80 text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setShowConfirm(true)}
      disabled={fetcher.state !== 'idle'}
      className="p-1.5 text-red-600 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
      title={`Remove ${productName}`}
    >
      <Trash size={16} />
    </button>
  );
}

function RemoveCostButton({ costId, collectionId, transactionName }: { costId: string; collectionId: string; transactionName: string }) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [showConfirm, setShowConfirm] = useState(false);
  const data = (fetcher.data as any);
  const error = data?.error;

  const handleDelete = () => {
    fetcher.submit(
      { intent: 'remove_cost', costId, collectionId },
      { method: 'post' }
    );
  };

  useEffect(() => {
    if (fetcher.state === 'idle' && data?.ok) {
      setShowConfirm(false);
      revalidator.revalidate();
    }
  }, [fetcher.data, fetcher.state, revalidator]);

  if (error && showConfirm) {
    return (
      <div className="flex gap-2 items-center">
        <div className="text-xs text-red-600 bg-red-500/20 px-2 py-1 rounded">
          {error}
        </div>
        <button
          type="button"
          onClick={() => { setShowConfirm(false); fetcher.data = null; }}
          disabled={fetcher.state !== 'idle'}
          className="px-2 py-1 text-xs rounded bg-muted hover:bg-muted/80 text-foreground disabled:opacity-50"
        >
          Close
        </button>
      </div>
    );
  }

  if (showConfirm) {
    return (
      <div className="flex gap-2 items-center">
        <button
          type="button"
          onClick={handleDelete}
          disabled={fetcher.state !== 'idle'}
          className="px-2 py-1 text-xs rounded bg-red-500/20 text-red-600 hover:bg-red-500/30 disabled:opacity-50"
        >
          Remove
        </button>
        <button
          type="button"
          onClick={() => setShowConfirm(false)}
          disabled={fetcher.state !== 'idle'}
          className="px-2 py-1 text-xs rounded bg-muted hover:bg-muted/80 text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setShowConfirm(true)}
      disabled={fetcher.state !== 'idle'}
      className="p-1.5 text-red-600 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
      title={`Remove ${transactionName}`}
    >
      <Trash size={16} />
    </button>
  );
}

function AddProductForm({ collectionId, productOptions }: { collectionId: string; productOptions: ProductRow[] }) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [query, setQuery] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [displayOrder, setDisplayOrder] = useState('');
  const [allocationWeight, setAllocationWeight] = useState('');
  const [inclusionReason, setInclusionReason] = useState('');
  const lastState = useRef(fetcher.state);

  const filteredProducts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return productOptions.filter((product) => {
      if (!q) return true;
      const searchable = [product.name, product.provider, product.productType]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchable.includes(q);
    });
  }, [productOptions, query]);

  useEffect(() => {
    if (lastState.current !== 'idle' && fetcher.state === 'idle' && (fetcher.data as any)?.ok) {
      revalidator.revalidate();
      setSelectedProductId('');
      setDisplayOrder('');
      setAllocationWeight('');
      setInclusionReason('');
      setQuery('');
    }
    lastState.current = fetcher.state;
  }, [fetcher.data, fetcher.state, revalidator]);

  return (
    <fetcher.Form method="post" className="rounded-2xl border border-border bg-card p-4 space-y-4 shadow-sm">
      <input type="hidden" name="intent" value="add_product" />
      <input type="hidden" name="collectionId" value={collectionId} />

      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-foreground">Add product</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Attach a product to this collection and keep membership metadata together.
          </p>
        </div>
        <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-600">
          <Plus size={18} />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Search products</label>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Type a product name or provider..."
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Product</label>
        <select
          name="productId"
          value={selectedProductId}
          onChange={(event) => setSelectedProductId(event.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          required
        >
          <option value="">Choose a product</option>
          {filteredProducts.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
              {product.provider ? ` · ${product.provider}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Display order</label>
          <input
            type="number"
            name="displayOrder"
            min="0"
            value={displayOrder}
            onChange={(event) => setDisplayOrder(event.target.value)}
            placeholder="Optional"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Allocation weight</label>
          <input
            type="number"
            name="allocationWeight"
            min="0"
            step="0.01"
            value={allocationWeight}
            onChange={(event) => setAllocationWeight(event.target.value)}
            placeholder="Optional"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Inclusion reason</label>
        <textarea
          name="inclusionReason"
          value={inclusionReason}
          onChange={(event) => setInclusionReason(event.target.value)}
          placeholder="Why is this product in the collection?"
          rows={3}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none"
        />
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs text-muted-foreground">
          Membership rows keep collection metadata separate from product data.
        </p>
        <Button type="submit" disabled={fetcher.state !== 'idle'}>
          Add product
        </Button>
      </div>

      {((fetcher.data as any)?.error as string | undefined) && (
        <p className="text-xs text-destructive">{(fetcher.data as any).error}</p>
      )}
    </fetcher.Form>
  );
}

function AddCostForm({
  collectionId,
  transactionOptions,
}: {
  collectionId: string;
  transactionOptions: FinancialTransactionRow[];
}) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [query, setQuery] = useState('');
  const [selectedTransactionId, setSelectedTransactionId] = useState('');
  const [costType, setCostType] = useState('other');
  const [notes, setNotes] = useState('');
  const [notesManuallyEdited, setNotesManuallyEdited] = useState(false);
  const lastState = useRef(fetcher.state);

  const selectedTransaction = useMemo(
    () => transactionOptions.find((transaction) => transaction.id === selectedTransactionId) ?? null,
    [selectedTransactionId, transactionOptions]
  );

  const debugInference = useMemo(() => {
    if (!selectedTransaction) return null;

    let source = 'fallback_other';
    if (selectedTransaction.expenseAccountId || selectedTransaction.expenseAccountName) {
      source = 'journal -> journal_line_items -> chart_of_accounts';
    } else if (selectedTransaction.metadataAccountCode) {
      source = selectedTransaction.expenseAccountId
        ? 'metadata.account_code -> chart_of_accounts'
        : 'metadata.account_code (no chart_of_accounts match)';
    } else if (selectedTransaction.metadataExpenseCategory) {
      source = 'metadata.expense_category';
    }

    return {
      source,
      transactionId: selectedTransaction.id,
      metadataExpenseCategory: selectedTransaction.metadataExpenseCategory || 'null',
      metadataAccountCode: selectedTransaction.metadataAccountCode || 'null',
      expenseAccountId: selectedTransaction.expenseAccountId || 'null',
      expenseAccountNumber: selectedTransaction.expenseAccountNumber || 'null',
      expenseAccountName: selectedTransaction.expenseAccountName || 'null',
      inferredCostType: selectedTransaction.inferredCostType || 'other',
    };
  }, [selectedTransaction]);

  const filteredTransactions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return transactionOptions.filter((transaction) => {
      if (!q) return true;
      const searchable = [
        transaction.description,
        transaction.counterpartyName,
        transaction.occurredAt,
        transaction.currencyCode,
        transaction.baseCurrencyCode,
        String(transaction.amount ?? ''),
        String(transaction.baseAmount ?? ''),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchable.includes(q);
    });
  }, [query, transactionOptions]);

  useEffect(() => {
    if (lastState.current !== 'idle' && fetcher.state === 'idle' && (fetcher.data as any)?.ok) {
      revalidator.revalidate();
      setSelectedTransactionId('');
      setCostType('other');
      setNotes('');
      setNotesManuallyEdited(false);
      setQuery('');
    }
    lastState.current = fetcher.state;
  }, [fetcher.data, fetcher.state, revalidator]);

  useEffect(() => {
    if (!selectedTransactionId || !selectedTransaction) return;

    const accountLabel =
      [selectedTransaction.expenseAccountNumber, selectedTransaction.expenseAccountName]
        .filter(Boolean)
        .join(' - ') ||
      selectedTransaction.metadataAccountCode ||
      selectedTransaction.metadataExpenseCategory ||
      'Unmapped expense account';

    setCostType(selectedTransaction.inferredCostType || 'other');

    if (!notesManuallyEdited) {
      const suggestedNotes = [
        `Account: ${accountLabel}`,
        selectedTransaction.metadataExpenseCategory
          ? `Expense category: ${selectedTransaction.metadataExpenseCategory}`
          : null,
        selectedTransaction.counterpartyName ? `Counterparty: ${selectedTransaction.counterpartyName}` : null,
        selectedTransaction.description ? `Transaction: ${selectedTransaction.description}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      setNotes(suggestedNotes);
    }
  }, [notesManuallyEdited, selectedTransaction, selectedTransactionId]);

  return (
    <fetcher.Form method="post" className="rounded-2xl border border-border bg-card p-4 space-y-4 shadow-sm">
      <input type="hidden" name="intent" value="add_cost" />
      <input type="hidden" name="collectionId" value={collectionId} />
      <input type="hidden" name="costType" value={costType} />

      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-foreground">Add cost transaction</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Reference an existing financial transaction rather than duplicating spend.
          </p>
        </div>
        <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center text-violet-600">
          <Receipt size={18} />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Search transactions</label>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Description, counterparty, amount, or date..."
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Transaction</label>
        <select
          name="financialTransactionId"
          value={selectedTransactionId}
          onChange={(event) => {
            setSelectedTransactionId(event.target.value);
            setNotesManuallyEdited(false);
          }}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          required
        >
          <option value="">Choose a transaction</option>
          {filteredTransactions.map((transaction) => (
            <option key={transaction.id} value={transaction.id}>
              {formatDate(transaction.occurredAt)}
              {transaction.counterpartyName ? ` · ${transaction.counterpartyName}` : ''}
              {transaction.expenseAccountName
                ? ` · ${transaction.expenseAccountNumber ? `${transaction.expenseAccountNumber} ` : ''}${transaction.expenseAccountName}`
                : ''}
              {transaction.description ? ` · ${transaction.description}` : ''}
              {` · ${formatMoneyValue(transaction)}`}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Cost type (from expense account)</label>
          <div className="mt-1 w-full rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
            {selectedTransaction
              ? `${costType} (${selectedTransaction.expenseAccountNumber ? `${selectedTransaction.expenseAccountNumber} - ` : ''}${selectedTransaction.expenseAccountName || selectedTransaction.metadataAccountCode || selectedTransaction.metadataExpenseCategory || 'Unmapped expense account'})`
              : 'Select a transaction to derive cost type'}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Notes (editable)</label>
          <input
            type="text"
            name="notes"
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
              setNotesManuallyEdited(true);
            }}
            placeholder="Auto-suggested from account/transaction"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {debugInference && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <p className="text-[11px] font-semibold text-amber-700">Debug inference (temporary)</p>
            <p className="text-[11px] text-amber-700 mt-1 break-all">
              source={debugInference.source} | txn={debugInference.transactionId}
            </p>
            <p className="text-[11px] text-amber-700 break-all">
              expense_category={debugInference.metadataExpenseCategory} | account_code={debugInference.metadataAccountCode}
            </p>
            <p className="text-[11px] text-amber-700 break-all">
              expense_account_id={debugInference.expenseAccountId} | account_number={debugInference.expenseAccountNumber}
            </p>
            <p className="text-[11px] text-amber-700 break-all">
              account_name={debugInference.expenseAccountName} | inferred_cost_type={debugInference.inferredCostType}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs text-muted-foreground">
          Costs stay linked to the original transaction for accurate profitability.
        </p>
        <Button type="submit" disabled={fetcher.state !== 'idle'}>
          Add cost
        </Button>
      </div>

      {((fetcher.data as any)?.error as string | undefined) && (
        <p className="text-xs text-destructive">{(fetcher.data as any).error}</p>
      )}
    </fetcher.Form>
  );
}

function CollectionDetail({
  summary,
  productOptions,
  transactionOptions,
}: {
  summary: CollectionSummary;
  productOptions: ProductRow[];
  transactionOptions: FinancialTransactionRow[];
}) {
  const collection = summary.collection;
  const budgetCurrency = collection.budgetCurrency || 'GBP';
  const budgetLabel =
    collection.plannedBudgetAmount != null
      ? formatCurrency(collection.plannedBudgetAmount, budgetCurrency)
      : '—';
  const budgetRemainingLabel =
    summary.budgetRemaining != null
      ? formatCurrency(summary.budgetRemaining, budgetCurrency)
      : '—';

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-border bg-linear-to-br from-card via-card to-primary/5 p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize',
                  statusTone(collection.status)
                )}
              >
                {collection.status}
              </span>
              {collection.collectionType && (
                <span className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground capitalize">
                  {collection.collectionType}
                </span>
              )}
            </div>
            <div>
              <h2 className="text-3xl font-semibold text-foreground tracking-tight">
                {collection.name}
              </h2>
              <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
                This view answers the core collection questions directly: what belongs in the
                collection, what spend is attributed to it, and what the resulting performance
                looks like.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded-full bg-background/80 border border-border px-2.5 py-1">
                <Calendar size={12} />
                Launch {formatDate(collection.launchDate)}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-background/80 border border-border px-2.5 py-1">
                <Tag size={12} />
                {collection.slug || 'no slug'}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-background/80 border border-border px-2.5 py-1">
                <Sparkle size={12} />
                {collection.externalRef || 'no external ref'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:w-[280px]">
            <MetricCard
              label="Products"
              value={formatDecimal(summary.products.length)}
              helper="linked to the collection"
              icon={<StackSimple size={18} weight="duotone" />}
            />
            <MetricCard
              label="Orders"
              value={formatDecimal(summary.orders)}
              helper="unique order count"
              icon={<Users size={18} weight="duotone" />}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
          <MetricCard
            label="Revenue"
            value={formatCurrency(summary.revenue)}
            helper="derived from linked product sales"
            icon={<ChartLineUp size={18} weight="duotone" />}
          />
          <MetricCard
            label="Costs"
            value={formatCurrency(summary.costTotal)}
            helper="linked financial transactions"
            icon={<Receipt size={18} weight="duotone" />}
          />
          <MetricCard
            label="Gross profit"
            value={formatCurrency(summary.grossProfit)}
            helper="revenue minus linked costs"
            icon={<TrendUp size={18} weight="duotone" />}
          />
          <MetricCard
            label="Margin"
            value={`${formatDecimal(summary.grossMargin, 1)}%`}
            helper={`Budget remaining: ${budgetRemainingLabel} of ${budgetLabel}`}
            icon={<CurrencyGbp size={18} weight="duotone" />}
          />
        </div>
      </div>

      <div className="grid lg:grid-cols-[1.2fr_0.8fr] gap-6 items-start">
        <div className="space-y-6">
          <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl bg-sky-500/10 flex items-center justify-center text-sky-600">
                <ListChecks size={18} />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">What this collection answers</h3>
                <p className="text-xs text-muted-foreground">
                  The page mirrors the schema's reporting questions so the business logic stays
                  visible to users.
                </p>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              {[
                'Which products are in each collection?',
                'How many orders, units, and revenue came from the collection?',
                'Which financial transactions count as collection costs?',
                'What is the collection-level profitability?',
              ].map((question) => (
                <div key={question} className="rounded-xl border border-border bg-background p-4">
                  <p className="text-sm text-foreground leading-6">{question}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm">
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
              <div>
                <h3 className="font-semibold text-foreground">Products in collection</h3>
                <p className="text-xs text-muted-foreground">
                  Membership rows can carry display order, reason, and allocation metadata.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{summary.products.length} rows</span>
            </div>

            {summary.products.length === 0 ? (
              <div className="p-10 text-center text-muted-foreground">
                No products have been linked yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 font-medium">Product</th>
                      <th className="px-4 py-3 font-medium">Order</th>
                      <th className="px-4 py-3 font-medium">Reason</th>
                      <th className="px-4 py-3 font-medium">Weight</th>
                      <th className="px-4 py-3 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.products.map((membership) => {
                      const product = membership.product;
                      return (
                        <tr key={membership.id} className="border-t border-border/60 hover:bg-muted/20">
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center overflow-hidden shrink-0">
                                {product?.thumbnailUrl ? (
                                  <img
                                    src={product.thumbnailUrl}
                                    alt={product.name}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <Package size={16} className="text-primary" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="font-medium text-foreground truncate">
                                  {product?.name || membership.sku || membership.variantExternalId || 'Unmapped product'}
                                </p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {product?.provider || membership.sku || membership.variantExternalId || 'Collection membership'}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4 text-muted-foreground tabular-nums">
                            {membership.displayOrder != null ? membership.displayOrder : '—'}
                          </td>
                          <td className="px-4 py-4 text-muted-foreground max-w-[260px]">
                            {membership.inclusionReason || '—'}
                          </td>
                          <td className="px-4 py-4 text-muted-foreground tabular-nums">
                            {membership.allocationWeight != null
                              ? formatDecimal(membership.allocationWeight, 2)
                              : '—'}
                          </td>
                          <td className="px-4 py-4">
                            <RemoveProductButton membershipId={membership.id} collectionId={collection.id} productName={product?.name || 'Product'} />
                          </td>
                       </tr>
                     );
                   })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm">
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
              <div>
                <h3 className="font-semibold text-foreground">Cost breakdown</h3>
                <p className="text-xs text-muted-foreground">
                  Each row links back to the original financial transaction.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{summary.costs.length} rows</span>
            </div>

            {summary.costs.length === 0 ? (
              <div className="p-10 text-center text-muted-foreground">
                No cost transactions have been linked yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 font-medium">Transaction</th>
                      <th className="px-4 py-3 font-medium">Type</th>
                      <th className="px-4 py-3 font-medium">Amount</th>
                      <th className="px-4 py-3 font-medium">Notes</th>
                      <th className="px-4 py-3 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.costs.map((cost) => (
                      <tr key={cost.id} className="border-t border-border/60 hover:bg-muted/20">
                        <td className="px-5 py-4">
                          <div>
                            <p className="font-medium text-foreground">
                              {cost.transaction?.counterpartyName || cost.transaction?.description || 'Transaction'}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {formatDate(cost.transaction?.occurredAt ?? null)}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium capitalize text-foreground">
                            {cost.costType || 'other'}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-foreground tabular-nums">
                          {formatMoneyValue(cost.transaction)}
                        </td>
                        <td className="px-4 py-4 text-muted-foreground max-w-[260px]">
                          {cost.notes || '—'}
                        </td>
                        <td className="px-4 py-4">
                          <RemoveCostButton costId={cost.id} collectionId={collection.id} transactionName={cost.transaction?.counterpartyName || 'Cost'} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-6">
          <AddProductForm collectionId={collection.id} productOptions={productOptions} />
          <AddCostForm collectionId={collection.id} transactionOptions={transactionOptions} />

          <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-600">
                <Sparkle size={18} />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">Quick interpretation</h3>
                <p className="text-xs text-muted-foreground">Useful for reviews and planning.</p>
              </div>
            </div>

            <div className="space-y-3 text-sm text-foreground/90">
              <div className="rounded-xl bg-background border border-border p-3">
                {summary.products.length} products are currently tied to the collection.
              </div>
              <div className="rounded-xl bg-background border border-border p-3">
                {summary.orders} orders and {formatDecimal(summary.units)} units are attributed to it.
              </div>
              <div className="rounded-xl bg-background border border-border p-3">
                Profitability is shown as revenue less linked spend, using the original transaction values.
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

export default function CollectionsPage() {
  const { stats, summaries, selectedCollectionId, selectedCollection, productOptions, transactionOptions } =
    useLoaderData<LoaderData>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const handleCollectionCreated = (collectionId: string) => {
    setSearchParams({ collection: collectionId });
  };

  const filteredSummaries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return summaries;
    return summaries.filter((summary) => {
      return [
        summary.collection.name,
        summary.collection.slug,
        summary.collection.collectionType,
        summary.collection.status,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [query, summaries]);

  const activeCollectionId = searchParams.get('collection') || selectedCollectionId || '';

  useEffect(() => {
    if (!activeCollectionId && summaries[0]?.collection.id) {
      setSearchParams({ collection: summaries[0].collection.id }, { replace: true });
    }
  }, [activeCollectionId, setSearchParams, summaries]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/90 backdrop-blur-sm sticky top-0 z-30">
        <div className="px-4 md:px-6 lg:px-8 py-4 lg:py-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex items-start gap-3">
              <Link
                to="/dashboard"
                className="mt-1 inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft size={18} />
              </Link>
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground mb-3">
                  <Sparkle size={12} />
                  Collection tracking
                </div>
                <h1 className="text-2xl lg:text-3xl font-semibold tracking-tight text-foreground">
                  Collections
                </h1>
                <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
                  Manage collection membership, link collection-specific costs, and inspect the
                  revenue, orders, and profit story in one place.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 w-full lg:w-auto">
              <MetricCard
                label="Collections"
                value={formatDecimal(stats.collections)}
                helper={`${stats.active} active`}
                icon={<StackSimple size={18} weight="duotone" />}
              />
              <MetricCard
                label="Linked products"
                value={formatDecimal(stats.linkedProducts)}
                helper="membership rows"
                icon={<Package size={18} weight="duotone" />}
              />
              <MetricCard
                label="Linked costs"
                value={formatDecimal(stats.linkedCosts)}
                helper="transaction references"
                icon={<Receipt size={18} weight="duotone" />}
              />
              <MetricCard
                label="Net balance"
                value={formatCurrency(stats.totalRevenue - stats.totalCost)}
                helper="revenue less linked costs"
                icon={<CurrencyGbp size={18} weight="duotone" />}
              />
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 md:px-6 lg:px-8 py-6 lg:py-8 grid xl:grid-cols-[380px_1fr] gap-6">
        <section className="space-y-4">
          <CreateCollectionForm onCreated={handleCollectionCreated} />

          <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <label className="text-xs font-medium text-muted-foreground">Search collections</label>
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, status, type, or slug..."
              className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div className="space-y-3">
            {filteredSummaries.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-card p-8 text-center text-muted-foreground">
                No collections match your search.
              </div>
            ) : (
              filteredSummaries.map((summary) => (
                <CollectionCard
                  key={summary.collection.id}
                  summary={summary}
                  active={summary.collection.id === activeCollectionId}
                />
              ))
            )}
          </div>
        </section>

        <section>
          {selectedCollection ? (
            <CollectionDetail
              summary={selectedCollection}
              productOptions={productOptions}
              transactionOptions={transactionOptions}
            />
          ) : (
            <div className="rounded-3xl border border-dashed border-border bg-card p-12 text-center text-muted-foreground">
              No collections found yet.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
