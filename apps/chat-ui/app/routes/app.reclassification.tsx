/**
 * Inventory Reclassification Tools (Temporary Page)
 *
 * Phase 0 — Product Unit Cost Manager: view and set unit costs on products
 *            that have post-incorporation sales but no costed inventory item.
 *
 * Phase 1 — Supplier Transaction Matcher: review the 54 historical COGS
 *            purchase journals and see which ones can be matched to an invoice
 *            record via metadata.invoice_id.
 */

import React, { useState } from 'react';
import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData, useFetcher } from 'react-router';
import {
  Package,
  Receipt,
  CheckCircle,
  XCircle,
  Warning,
  CaretDown,
  CaretRight,
  FloppyDisk,
  Wrench,
  Spinner,
  LinkBreak,
  Link,
  X,
} from 'phosphor-react';
import { getServerSupabaseClient } from '~/lib/supabase';
import { cn } from '~/lib/utils';

export const meta: MetaFunction = () => [
  { title: 'Reclassification Tools - ThreadWise' },
  { name: 'description', content: 'Temporary tools for inventory reclassification' },
];

const ENTITY_ID = 'f49f608d-0868-4e63-b0bb-d4c60d74db68';
const INCORP_DATE = '2023-04-12';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductCost {
  id: string;
  name: string;
  provider: string | null;
  inventoryItemId: string | null;
  unitCost: number | null;
  sku: string | null;
  postIncorpUnits: number;
  postIncorpRevenue: number;
}

interface InvoiceLineItem {
  id: string;
  description: string | null;
  quantity: number;
  unitCost: number | null;
  lineNet: number | null;
  lineGross: number | null;
  sku: string | null;
  isFee: boolean;
}

interface MatchedInvoice {
  id: string;
  invoiceNumber: string;
  netAmount: number;
  grossAmount: number;
  currency: string;
  invoiceDate: string;
  lineItems: InvoiceLineItem[];
  goodsTotal: number;
  feesTotal: number;
}

type MatchStatus = 'matched' | 'ref_missing' | 'no_invoice';

interface AvailableInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  netAmount: number;
  counterparty: string | null;
}

interface CogsTransaction {
  transactionId: string;
  journalId: string;
  journalDate: string;
  journalDesc: string;
  counterparty: string;
  transactionAmount: number;
  gbpAmount: number;
  currency: string;
  occurredAt: string;
  cogsAccountNumber: string;
  cogsAccountName: string;
  cogsDebit: number;
  metadataInvoiceId: string | null;
  matchStatus: MatchStatus;
  matchedInvoice: MatchedInvoice | null;
}

// ─── Loader helpers ───────────────────────────────────────────────────────────

/** Paginate past PostgREST max_rows by repeatedly calling .range() until exhausted */
async function paginateAll<T = any>(
  queryFn: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
  pageSize = 1000
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data } = await queryFn(from, from + pageSize - 1);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request: _request }: LoaderFunctionArgs) {
  const supabase = getServerSupabaseClient();

  // ── Step 1: Parallel base queries (all < 1000 rows, no pagination needed) ──
  const [productsRes, inventoryRes, coaRes, invoicesRes] = await Promise.all([
    supabase
      .from('products')
      .select('id, name, provider')
      .eq('entity_id', ENTITY_ID)
      .neq('status', 'archived')
      .order('name'),
    supabase
      .from('inventory_items')
      .select('id, product_id, unit_cost, sku')
      .eq('entity_id', ENTITY_ID),
    supabase
      .from('chart_of_accounts')
      .select('id, account_number, name')
      .like('account_number', '50%'),
    supabase
      .from('invoices')
      .select(
        'id, invoice_number, net_amount, gross_amount, currency, invoice_date, invoice_line_items(id, description, quantity, unit_cost, line_net, line_gross, sku)'
      )
      .eq('entity_id', ENTITY_ID)
      .eq('invoice_type', 'PURCHASE'),
  ]);

  // ── Step 2: Paginated queries (> 1000 rows possible) ───────────────────────

  const [orders, journals] = await Promise.all([
    paginateAll<{ id: string; created_at: string; status: string }>((from, to) =>
      supabase
        .from('orders')
        .select('id, created_at, status')
        .eq('entity_id', ENTITY_ID)
        .range(from, to)
    ),
    paginateAll<{ id: string; journal_date: string; description: string; source_type: string; source_id: string; status: string }>(
      (from, to) =>
        supabase
          .from('journals')
          .select('id, journal_date, description, source_type, source_id, status')
          .eq('entity_id', ENTITY_ID)
          .eq('source_type', 'financial_transaction')
          .range(from, to)
    ),
  ]);

  // ── Step 3: Build product cost list ────────────────────────────────────────
  const products = productsRes.data ?? [];
  const inventoryItems = inventoryRes.data ?? [];

  // Map: product_id → best inventory_item
  const invByProduct = new Map<string, (typeof inventoryItems)[0]>();
  for (const ii of inventoryItems) {
    if (ii.product_id && !invByProduct.has(ii.product_id)) {
      invByProduct.set(ii.product_id, ii);
    }
  }

  // Post-incorp non-cancelled order IDs
  const postIncorpOrderIds = new Set(
    orders
      .filter(
        (o) =>
          !['cancelled', 'refunded'].includes(o.status ?? '') &&
          (o.created_at ?? '') >= INCORP_DATE
      )
      .map((o) => o.id)
  );
  const orderIdsList = Array.from(postIncorpOrderIds);

  // Paginated order_line_items — chunked by order IDs.
  // Keep chunks at 100 max to stay under nginx's ~8KB URL limit (100 UUIDs ≈ 3.7KB).
  const lineItems: { product_id: string; quantity: number; total_price_amount: number }[] = [];
  for (let i = 0; i < orderIdsList.length; i += 100) {
    const chunk = orderIdsList.slice(i, i + 100);
    const chunkItems = await paginateAll<{
      product_id: string;
      quantity: number;
      total_price_amount: number;
    }>((from, to) =>
      supabase
        .from('order_line_items')
        .select('product_id, quantity, total_price_amount')
        .in('order_id', chunk)
        .range(from, to)
    );
    lineItems.push(...chunkItems);
  }

  // Aggregate post-incorp sales by product_id
  const salesMap = new Map<string, { units: number; revenue: number }>();
  for (const li of lineItems) {
    if (!li.product_id) continue;
    const cur = salesMap.get(li.product_id) ?? { units: 0, revenue: 0 };
    salesMap.set(li.product_id, {
      units: cur.units + (li.quantity ?? 0),
      revenue: cur.revenue + Number(li.total_price_amount ?? 0),
    });
  }

  const productCosts: ProductCost[] = [];
  for (const p of products) {
    const sales = salesMap.get(p.id);
    if (!sales || sales.units === 0) continue; // skip never-sold products
    const ii = invByProduct.get(p.id) ?? null;
    productCosts.push({
      id: p.id,
      name: p.name,
      provider: p.provider ?? null,
      inventoryItemId: ii?.id ?? null,
      unitCost: ii?.unit_cost != null ? Number(ii.unit_cost) : null,
      sku: ii?.sku ?? null,
      postIncorpUnits: sales.units,
      postIncorpRevenue: sales.revenue,
    });
  }
  productCosts.sort((a, b) => {
    const aMissing = a.unitCost === null ? 0 : 1;
    const bMissing = b.unitCost === null ? 0 : 1;
    if (aMissing !== bMissing) return aMissing - bMissing;
    return b.postIncorpRevenue - a.postIncorpRevenue;
  });

  // ── Step 4: Build COGS transaction list ────────────────────────────────────
  const coaMap = new Map((coaRes.data ?? []).map((c) => [c.id, c]));
  const cogsAccountIdList = (coaRes.data ?? []).map((c) => c.id); // ~6 IDs

  const journalMap = new Map(journals.map((j) => [j.id, j]));
  const journalIdSet = new Set(journals.map((j) => j.id));

  // Query JLIs by COGS account IDs (~6 IDs = tiny URL), then filter to our entity's journals.
  // This avoids chunking by journal_id which produces URLs >8KB and silently fails in PostgREST.
  const allCogsJliRaw = await paginateAll<{
    journal_id: string;
    account_id: string;
    debit: number;
  }>((from, to) =>
    supabase
      .from('journal_line_items')
      .select('journal_id, account_id, debit')
      .in('account_id', cogsAccountIdList)
      .gt('debit', 0)
      .range(from, to)
  );

  // Keep only JLIs whose journal belongs to this entity's FT journals
  const cogsJliMap = new Map<string, { account_id: string; debit: number }>();
  for (const jli of allCogsJliRaw) {
    if (journalIdSet.has(jli.journal_id) && !cogsJliMap.has(jli.journal_id)) {
      cogsJliMap.set(jli.journal_id, { account_id: jli.account_id, debit: Number(jli.debit) });
    }
  }

  // Get financial transactions for COGS journals
  const cogsJournalIds = Array.from(cogsJliMap.keys());
  const cogsJournals = cogsJournalIds.map((id) => journalMap.get(id)).filter(Boolean) as (typeof journals)[0][];
  const ftIds = [...new Set(cogsJournals.map((j) => j.source_id).filter(Boolean))];

  const ftMap = new Map<string, any>();
  for (let i = 0; i < ftIds.length; i += 500) {
    const chunk = ftIds.slice(i, i + 500);
    const { data } = await supabase
      .from('financial_transactions')
      .select('id, description, counterparty_name, amount, base_amount, occurred_at, metadata, currency_code, base_currency_code')
      .in('id', chunk)
      .limit(5000);
    for (const ft of data ?? []) ftMap.set(ft.id, ft);
  }

  // Build invoice lookup by invoice_number (also index a normalised key: strip trailing -1, (1), （1） suffixes)
  const invoiceByNumber = new Map<string, any>();
  for (const inv of invoicesRes.data ?? []) {
    if (!inv.invoice_number) continue;
    invoiceByNumber.set(inv.invoice_number, inv);
    // Also index without revision suffixes so e.g. "PISSX2407006-1" matches "PISSX2407006"
    const stripped = inv.invoice_number.replace(/[-\s（(][（(]?1[）)]?$/, '').trim();
    if (stripped !== inv.invoice_number && !invoiceByNumber.has(stripped)) {
      invoiceByNumber.set(stripped, inv);
    }
  }

  /** Normalise an FT metadata invoice ref for lookup — strips revision suffixes */
  function normaliseRef(ref: string): string {
    return ref.replace(/[-\s（(][（(]?1[）)]?$/, '').trim();
  }

  // Assemble COGS transaction records
  const cogsTransactions: CogsTransaction[] = [];
  for (const journalId of cogsJournalIds) {
    const journal = journalMap.get(journalId);
    const jli = cogsJliMap.get(journalId);
    if (!journal || !jli) continue;

    const coa = coaMap.get(jli.account_id);
    const ft = ftMap.get(journal.source_id);
    if (!ft) continue;

    const metaInvoiceId: string | null = ft.metadata?.invoice_id ?? null;
    const rawInvoice = metaInvoiceId
      ? (invoiceByNumber.get(metaInvoiceId) ?? invoiceByNumber.get(normaliseRef(metaInvoiceId)) ?? null)
      : null;

    let matchedInvoice: MatchedInvoice | null = null;
    if (rawInvoice) {
      const lineItems: InvoiceLineItem[] = (rawInvoice.invoice_line_items ?? []).map((li: any) => {
        const isFee = /fee/i.test(li.description ?? '');
        return {
          id: li.id,
          description: li.description,
          quantity: Number(li.quantity ?? 1),
          unitCost: li.unit_cost != null ? Number(li.unit_cost) : null,
          lineNet: li.line_net != null ? Number(li.line_net) : null,
          lineGross: li.line_gross != null ? Number(li.line_gross) : null,
          sku: li.sku ?? null,
          isFee,
        };
      });
      const goodsTotal = lineItems
        .filter((l) => !l.isFee)
        .reduce((s, l) => s + (l.lineNet ?? l.lineGross ?? 0), 0);
      const feesTotal = lineItems
        .filter((l) => l.isFee)
        .reduce((s, l) => s + (l.lineNet ?? l.lineGross ?? 0), 0);

      matchedInvoice = {
        id: rawInvoice.id,
        invoiceNumber: rawInvoice.invoice_number,
        netAmount: Number(rawInvoice.net_amount ?? 0),
        grossAmount: Number(rawInvoice.gross_amount ?? 0),
        currency: rawInvoice.currency ?? 'GBP',
        invoiceDate: rawInvoice.invoice_date,
        lineItems,
        goodsTotal,
        feesTotal,
      };
    }

    const matchStatus: MatchStatus =
      matchedInvoice !== null ? 'matched' : metaInvoiceId ? 'ref_missing' : 'no_invoice';

    cogsTransactions.push({
      transactionId: ft.id,
      journalId: journal.id,
      journalDate: journal.journal_date,
      journalDesc: journal.description ?? '',
      counterparty: ft.counterparty_name ?? ft.description ?? '',
      transactionAmount: Number(ft.amount ?? 0),
      gbpAmount: Number(ft.base_amount ?? ft.amount ?? 0),
      currency: ft.currency_code ?? 'GBP',
      occurredAt: ft.occurred_at,
      cogsAccountNumber: coa?.account_number ?? '',
      cogsAccountName: coa?.name ?? '',
      cogsDebit: jli.debit,
      metadataInvoiceId: metaInvoiceId,
      matchStatus,
      matchedInvoice,
    });
  }

  cogsTransactions.sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  );

  const availableInvoices: AvailableInvoice[] = (invoicesRes.data ?? []).map((inv) => ({
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    invoiceDate: inv.invoice_date,
    netAmount: Number(inv.net_amount ?? 0),
    counterparty: (inv as any).counterparty_name ?? null,
  }));

  return { productCosts, cogsTransactions, availableInvoices };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return `£${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function shortId(id: string) {
  return id.slice(0, 8);
}

// ─── Product Cost Row ─────────────────────────────────────────────────────────

function ProductCostRow({ product }: { product: ProductCost }) {
  const fetcher = useFetcher();
  const [value, setValue] = useState(product.unitCost?.toFixed(2) ?? '');
  const isSaving = fetcher.state !== 'idle';
  const savedData = fetcher.data as { ok?: boolean; error?: string } | undefined;
  const isDirty = value !== (product.unitCost?.toFixed(2) ?? '');

  const handleSave = () => {
    if (!value || isNaN(parseFloat(value))) return;
    fetcher.submit(
      {
        intent: 'upsertUnitCost',
        productId: product.id,
        inventoryItemId: product.inventoryItemId ?? '',
        entityId: ENTITY_ID,
        unitCost: value,
      },
      { method: 'post', action: '/api/reclassification', encType: 'application/json' }
    );
  };

  return (
    <tr className="border-b border-border hover:bg-muted/30 transition-colors">
      <td className="py-3 px-4">
        <div className="font-medium text-sm text-foreground">{product.name}</div>
        {product.sku && <div className="text-xs text-muted-foreground mt-0.5">{product.sku}</div>}
      </td>
      <td className="py-3 px-4 text-sm text-right tabular-nums text-muted-foreground">
        {product.postIncorpUnits}
      </td>
      <td className="py-3 px-4 text-sm text-right tabular-nums text-foreground">
        {fmt(product.postIncorpRevenue)}
      </td>
      <td className="py-3 px-4">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">£</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.00"
            className={cn(
              'w-24 rounded-md border border-input bg-background px-2 py-1 text-sm tabular-nums',
              'focus:outline-none focus:ring-1 focus:ring-ring',
              savedData?.error && 'border-destructive'
            )}
          />
          <button
            onClick={handleSave}
            disabled={isSaving || !value || !isDirty}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              'bg-primary text-primary-foreground hover:bg-primary/90',
              'disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            {isSaving ? (
              <Spinner size={12} className="animate-spin" />
            ) : (
              <FloppyDisk size={12} />
            )}
            Save
          </button>
          {savedData?.ok && !isSaving && (
            <CheckCircle size={16} className="text-green-500 shrink-0" />
          )}
          {savedData?.error && (
            <span className="text-xs text-destructive">{savedData.error}</span>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── Product Costs Tab ────────────────────────────────────────────────────────

function ProductCostsTab({ products }: { products: ProductCost[] }) {
  const missing = products.filter((p) => p.unitCost === null);
  const costed = products.filter((p) => p.unitCost !== null);
  const [showCosted, setShowCosted] = useState(false);

  const missingRevenue = missing.reduce((s, p) => s + p.postIncorpRevenue, 0);

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Missing Cost</p>
          <p className="text-2xl font-bold text-destructive">{missing.length}</p>
          <p className="text-xs text-muted-foreground mt-1">products</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Uncosted Revenue</p>
          <p className="text-2xl font-bold text-amber-500">{fmt(missingRevenue)}</p>
          <p className="text-xs text-muted-foreground mt-1">post-incorporation</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Costed</p>
          <p className="text-2xl font-bold text-green-500">{costed.length}</p>
          <p className="text-xs text-muted-foreground mt-1">products</p>
        </div>
      </div>

      {/* Missing unit cost table */}
      {missing.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <XCircle size={16} className="text-destructive" />
            <h3 className="font-semibold text-sm text-foreground">Missing Unit Cost ({missing.length})</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="py-2 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Product</th>
                  <th className="py-2 px-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Post-incorp Units</th>
                  <th className="py-2 px-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Post-incorp Revenue</th>
                  <th className="py-2 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Unit Cost (GBP)</th>
                </tr>
              </thead>
              <tbody>
                {missing.map((p) => (
                  <ProductCostRow key={p.id} product={p} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Already costed */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <button
          onClick={() => setShowCosted((v) => !v)}
          className="w-full px-4 py-3 border-b border-border flex items-center gap-2 hover:bg-muted/30 transition-colors text-left"
        >
          {showCosted ? <CaretDown size={14} /> : <CaretRight size={14} />}
          <CheckCircle size={16} className="text-green-500" />
          <h3 className="font-semibold text-sm text-foreground">Costed Products ({costed.length})</h3>
          <span className="ml-auto text-xs text-muted-foreground">click to {showCosted ? 'collapse' : 'expand'}</span>
        </button>
        {showCosted && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="py-2 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Product</th>
                  <th className="py-2 px-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Unit Cost</th>
                  <th className="py-2 px-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Post-incorp Units</th>
                  <th className="py-2 px-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Post-incorp Revenue</th>
                  <th className="py-2 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Update Cost</th>
                </tr>
              </thead>
              <tbody>
                {costed.map((p) => (
                  <ProductCostRow key={p.id} product={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Transaction Row ──────────────────────────────────────────────────────────

function TransactionRow({
  txn,
  availableInvoices,
}: {
  txn: CogsTransaction;
  availableInvoices: AvailableInvoice[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [linking, setLinking] = useState(false);
  const [search, setSearch] = useState('');
  const fetcher = useFetcher();
  const isSaving = fetcher.state !== 'idle';

  // Optimistic: if we just linked successfully, treat as matched
  const optimisticInvoiceNumber =
    (fetcher.data as any)?.ok && (fetcher.data as any)?.invoiceNumber
      ? (fetcher.data as any).invoiceNumber
      : null;

  const isLinked = optimisticInvoiceNumber !== null;
  const effectiveStatus: MatchStatus = isLinked ? 'matched' : txn.matchStatus;

  const filteredInvoices = availableInvoices.filter((inv) =>
    search === '' ||
    inv.invoiceNumber.toLowerCase().includes(search.toLowerCase()) ||
    (inv.counterparty ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const handleLink = (inv: AvailableInvoice) => {
    fetcher.submit(
      {
        intent: 'linkInvoice',
        transactionId: txn.transactionId,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
      },
      { method: 'post', action: '/api/reclassification', encType: 'application/json' }
    );
    setLinking(false);
    setSearch('');
  };

  const statusBadge = {
    matched: (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 border border-green-500/20 font-medium">
        <CheckCircle size={11} weight="fill" />
        {isLinked ? 'Linked ✓' : 'Matched'}
      </span>
    ),
    ref_missing: (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/20 font-medium">
        <LinkBreak size={11} weight="fill" />
        Ref not uploaded
      </span>
    ),
    no_invoice: (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 border border-red-500/20 font-medium">
        <XCircle size={11} weight="fill" />
        No Invoice
      </span>
    ),
  }[effectiveStatus];

  return (
    <>
      <tr
        className={cn(
          'border-b border-border transition-colors',
          (effectiveStatus === 'matched' && !linking) ? 'cursor-pointer' : '',
          expanded ? 'bg-muted/40' : 'hover:bg-muted/20'
        )}
        onClick={() => {
          if (linking) return;
          if (effectiveStatus === 'matched') setExpanded((v) => !v);
        }}
      >
        {/* Expand toggle */}
        <td className="py-3 px-3 w-8">
          {effectiveStatus === 'matched' ? (
            expanded ? (
              <CaretDown size={14} className="text-muted-foreground" />
            ) : (
              <CaretRight size={14} className="text-muted-foreground" />
            )
          ) : (
            <span className="w-3.5 inline-block" />
          )}
        </td>
        <td className="py-3 px-3 text-xs text-muted-foreground whitespace-nowrap">
          {fmtDate(txn.occurredAt)}
        </td>
        <td className="py-3 px-3 text-sm font-medium text-foreground max-w-[200px] truncate">
          {txn.counterparty}
        </td>
        <td className="py-3 px-3 text-sm text-right tabular-nums text-foreground font-medium">
          {fmt(txn.gbpAmount)}
        </td>
        <td className="py-3 px-3 text-xs text-muted-foreground">
          <span className="inline-block rounded px-1.5 py-0.5 bg-muted font-mono">
            {txn.cogsAccountNumber}
          </span>
          <span className="ml-1.5">{txn.cogsAccountName.replace('COGS — ', '').replace('Cost of Goods Sold — ', '')}</span>
        </td>
        <td className="py-3 px-3">{statusBadge}</td>
        <td className="py-3 px-3 text-xs text-muted-foreground">
          {(effectiveStatus === 'matched' || isLinked) && (
            <span className="font-mono">
              {optimisticInvoiceNumber ?? txn.matchedInvoice?.invoiceNumber}
            </span>
          )}
          {effectiveStatus === 'ref_missing' && txn.metadataInvoiceId && !isLinked && (
            <span className="font-mono text-amber-600">{txn.metadataInvoiceId}</span>
          )}
        </td>
        <td className="py-3 px-3 text-xs font-mono text-muted-foreground">
          {shortId(txn.journalId)}…
        </td>
        {/* Link Invoice action */}
        <td className="py-3 px-3" onClick={(e) => e.stopPropagation()}>
          {effectiveStatus !== 'matched' && !isLinked && (
            <button
              onClick={() => setLinking((v) => !v)}
              disabled={isSaving}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-dashed border-muted-foreground/40 text-muted-foreground hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
            >
              {isSaving ? (
                <Spinner size={11} className="animate-spin" />
              ) : (
                <Link size={11} />
              )}
              Link
            </button>
          )}
        </td>
      </tr>

      {/* Inline invoice picker */}
      {linking && (
        <tr className="border-b border-border bg-muted/30">
          <td colSpan={9} className="px-10 py-3">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Select invoice to link to <span className="text-foreground font-semibold">{txn.counterparty}</span> ({fmtDate(txn.occurredAt)}, {fmt(txn.gbpAmount)})
                </p>
                <input
                  autoFocus
                  type="text"
                  placeholder="Search by invoice number or supplier…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full mb-2 px-3 py-1.5 text-xs rounded border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="max-h-48 overflow-y-auto rounded border border-border divide-y divide-border">
                  {filteredInvoices.length === 0 && (
                    <p className="px-3 py-2 text-xs text-muted-foreground">No invoices found</p>
                  )}
                  {filteredInvoices.map((inv) => (
                    <button
                      key={inv.id}
                      onClick={() => handleLink(inv)}
                      className="w-full flex items-center justify-between px-3 py-2 text-left text-xs hover:bg-muted/60 transition-colors"
                    >
                      <span className="font-mono font-medium text-foreground">{inv.invoiceNumber}</span>
                      <span className="text-muted-foreground">{fmtDate(inv.invoiceDate)}</span>
                      <span className="font-medium text-foreground">£{inv.netAmount.toFixed(2)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={() => { setLinking(false); setSearch(''); }}
                className="mt-5 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          </td>
        </tr>
      )}

      {/* Expanded invoice detail */}
      {expanded && txn.matchedInvoice && (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={8} className="px-10 py-4">
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Invoice</span>
                  <p className="font-mono font-semibold text-foreground mt-0.5">
                    {txn.matchedInvoice.invoiceNumber}
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-xs text-muted-foreground">Invoice date</span>
                  <p className="text-sm text-foreground">{fmtDate(txn.matchedInvoice.invoiceDate)}</p>
                </div>
                <div className="text-right">
                  <span className="text-xs text-muted-foreground">Invoice gross</span>
                  <p className="text-sm font-medium text-foreground">
                    {txn.matchedInvoice.currency === 'USD' ? '$' : '£'}
                    {txn.matchedInvoice.grossAmount.toFixed(2)}
                    {txn.matchedInvoice.currency !== 'GBP' && (
                      <span className="text-xs text-muted-foreground ml-1">({txn.matchedInvoice.currency})</span>
                    )}
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-xs text-muted-foreground">Transaction (GBP)</span>
                  <p className="text-sm font-medium text-foreground">{fmt(txn.gbpAmount)}</p>
                </div>
              </div>

              {/* Line items table */}
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="pb-1.5 text-left text-muted-foreground font-medium">Description</th>
                    <th className="pb-1.5 text-right text-muted-foreground font-medium">Qty</th>
                    <th className="pb-1.5 text-right text-muted-foreground font-medium">Unit Cost</th>
                    <th className="pb-1.5 text-right text-muted-foreground font-medium">Line Net</th>
                    <th className="pb-1.5 text-left text-muted-foreground font-medium pl-3">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {txn.matchedInvoice.lineItems.map((li) => (
                    <tr key={li.id} className="border-b border-border/50">
                      <td className="py-1.5 text-foreground">{li.description ?? '—'}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">{li.quantity}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {li.unitCost != null ? `£${li.unitCost.toFixed(4)}` : '—'}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-medium text-foreground">
                        {li.lineNet != null ? `£${li.lineNet.toFixed(2)}` : '—'}
                      </td>
                      <td className="py-1.5 pl-3">
                        <span
                          className={cn(
                            'inline-block px-1.5 py-0.5 rounded text-xs font-medium',
                            li.isFee
                              ? 'bg-orange-500/10 text-orange-600'
                              : 'bg-blue-500/10 text-blue-600'
                          )}
                        >
                          {li.isFee ? 'Fee' : 'Goods'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Totals summary */}
              <div className="flex gap-6 pt-1 text-xs">
                <div>
                  <span className="text-muted-foreground">Goods total: </span>
                  <span className="font-semibold text-blue-600">
                    £{txn.matchedInvoice.goodsTotal.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Fees total: </span>
                  <span className="font-semibold text-orange-600">
                    £{txn.matchedInvoice.feesTotal.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Transaction GBP: </span>
                  <span className="font-semibold text-foreground">{fmt(txn.gbpAmount)}</span>
                </div>
                <div className="ml-auto">
                  <span className="text-muted-foreground">Inventory portion: </span>
                  <span className="font-bold text-green-600">
                    £{txn.matchedInvoice.goodsTotal.toFixed(2)}
                  </span>
                  <span className="text-muted-foreground ml-1">(DR Inventory ← this amount)</span>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Transaction Matcher Tab ──────────────────────────────────────────────────

function TransactionMatcherTab({
  transactions,
  availableInvoices,
}: {
  transactions: CogsTransaction[];
  availableInvoices: AvailableInvoice[];
}) {
  const matched = transactions.filter((t) => t.matchStatus === 'matched');
  const refMissing = transactions.filter((t) => t.matchStatus === 'ref_missing');
  const noInvoice = transactions.filter((t) => t.matchStatus === 'no_invoice');
  const totalCogs = transactions.reduce((s, t) => s + t.cogsDebit, 0);
  const matchedGoodsTotal = matched.reduce(
    (s, t) => s + (t.matchedInvoice?.goodsTotal ?? 0),
    0
  );

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Transactions</p>
          <p className="text-2xl font-bold text-foreground">{transactions.length}</p>
          <p className="text-xs text-muted-foreground mt-1">{fmt(totalCogs)} COGS</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Matched to Invoice</p>
          <p className="text-2xl font-bold text-green-500">{matched.length}</p>
          <p className="text-xs text-muted-foreground mt-1">goods: {fmt(matchedGoodsTotal)}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Invoice Ref (Not Uploaded)</p>
          <p className="text-2xl font-bold text-amber-500">{refMissing.length}</p>
          <p className="text-xs text-muted-foreground mt-1">invoice ID exists in metadata</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">No Invoice</p>
          <p className="text-2xl font-bold text-red-500">{noInvoice.length}</p>
          <p className="text-xs text-muted-foreground mt-1">direct / marketplace purchases</p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Click a <span className="text-green-600 font-medium">Matched</span> row to expand the invoice line item breakdown and see the goods vs fees split.
        Use the <span className="text-primary font-medium">Link</span> button on unmatched rows to manually attach an invoice.
      </p>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="py-2 px-3 w-8" />
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Counterparty</th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount (GBP)</th>
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">COGS Account</th>
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Match Status</th>
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Invoice Ref</th>
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Journal ID</th>
                <th className="py-2 px-3 w-20" />
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <TransactionRow key={t.transactionId} txn={t} availableInvoices={availableInvoices} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReclassificationPage() {
  const { productCosts, cogsTransactions, availableInvoices } = useLoaderData<typeof loader>();
  const [activeTab, setActiveTab] = useState<'products' | 'transactions'>('products');

  const missing = productCosts.filter((p) => p.unitCost === null);
  const matched = cogsTransactions.filter((t) => t.matchStatus === 'matched');

  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Wrench size={16} className="text-amber-500" />
          <span className="text-xs font-semibold uppercase tracking-wider text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
            Temporary Tool
          </span>
        </div>
        <h1 className="text-3xl font-bold text-foreground">Inventory Reclassification</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Phase 0: set missing unit costs on post-incorporation products · Phase 1: review supplier transaction → invoice matches
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border">
        <button
          onClick={() => setActiveTab('products')}
          className={cn(
            'flex items-center gap-2 pb-3 px-4 text-sm font-medium transition-colors border-b-2 -mb-px',
            activeTab === 'products'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          <Package size={15} />
          Product Unit Costs
          {missing.length > 0 && (
            <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive">
              {missing.length} missing
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('transactions')}
          className={cn(
            'flex items-center gap-2 pb-3 px-4 text-sm font-medium transition-colors border-b-2 -mb-px',
            activeTab === 'transactions'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          <Receipt size={15} />
          Supplier Transactions
          <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
            {matched.length}/{cogsTransactions.length} matched
          </span>
        </button>
      </div>

      {activeTab === 'products' && <ProductCostsTab products={productCosts} />}
      {activeTab === 'transactions' && <TransactionMatcherTab transactions={cogsTransactions} availableInvoices={availableInvoices} />}
    </div>
  );
}
