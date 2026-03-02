import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from '~/providers/AuthProvider';
import { getSupabaseBrowserClient } from '~/lib/supabase';
import { fetchChartOfAccounts } from '~/lib/api/accounting';
import {
  Receipt,
  MagnifyingGlass,
  X,
  ArrowsClockwise,
  TrendUp,
  TrendDown,
  Users,
} from 'phosphor-react';
import { toast } from 'sonner';
import { InvoiceUpload } from './InvoiceUpload';
import { InvoiceList } from './InvoiceList';
import { ProductSelectionModal } from './ProductSelectionModal';
import type { ProductCandidate } from './ProductSelectionModal';
import { InvoiceEditModal } from './InvoiceEditModal';
import type { InvoiceEditPayload } from './InvoiceEditModal';
import { GlAccountReviewModal } from './GlAccountReviewModal';
import type {
  Contact,
  Invoice,
  InvoiceLineItem,
  InvoiceStatus,
  InvoiceStats,
  InvoiceType,
  UploadProgress,
} from '~/types/invoice';

interface InvoicesSectionProps {
  invoices: Invoice[];
  contacts?: Contact[];
  stats: InvoiceStats;
  onRefresh?: () => void;
}

const STATUS_FILTERS: { value: InvoiceStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'OPEN', label: 'Open' },
  { value: 'PAID', label: 'Paid' },
  { value: 'PARTIALLY_PAID', label: 'Partial' },
  { value: 'OVERDUE', label: 'Overdue' },
];

function formatMoney(n: number, currency = 'EUR') {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(n);
}

export function InvoicesSection({
  invoices: _initialInvoices,
  contacts: _initialContacts = [],
  stats: _initialStats,
  onRefresh,
}: InvoicesSectionProps) {
  const { entity } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [stats, setStats] = useState<InvoiceStats>({
    total: 0,
    sales: { total: 0, open: 0, paid: 0, overdue: 0, outstanding: 0 },
    purchases: { total: 0, open: 0, paid: 0, overdue: 0, payable: 0 },
  });
  const [typeTab, setTypeTab] = useState<InvoiceType>('SALE');
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  const [showContacts, setShowContacts] = useState(false);
  const fetchIdRef = useRef(0);

  // ── Product selection modal state ──────────────────────────────────────────
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [productModalLineItems, setProductModalLineItems] = useState<InvoiceLineItem[]>([]);
  const [productModalInvoiceId, setProductModalInvoiceId] = useState('');
  const [productModalInvoiceType, setProductModalInvoiceType] = useState<InvoiceType>('PURCHASE');

  // ── Invoice edit modal state ──────────────────────────────────────────────
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);
  const [glAccounts, setGlAccounts] = useState<
    { id: string; account_number: string; name: string; account_type: string }[]
  >([]);

  // ── GL account review modal state (step 2 of upload workflow) ────────────
  const [glReviewModalOpen, setGlReviewModalOpen] = useState(false);
  const [glReviewInvoice, setGlReviewInvoice] = useState<Invoice | null>(null);

  // ── Compute stats from invoice data ──────────────────────────────────────
  const computeStats = useCallback((data: Invoice[]): InvoiceStats => {
    const s: InvoiceStats = {
      total: data.length,
      sales: { total: 0, open: 0, paid: 0, overdue: 0, outstanding: 0 },
      purchases: { total: 0, open: 0, paid: 0, overdue: 0, payable: 0 },
    };
    for (const row of data) {
      const amount = row.gross_amount ?? 0;
      if (row.invoice_type === 'SALE') {
        s.sales.total += 1;
        if (row.status === 'OPEN') {
          s.sales.open += 1;
          s.sales.outstanding += amount;
        }
        if (row.status === 'PAID') s.sales.paid += 1;
        if (row.status === 'OVERDUE') {
          s.sales.overdue += 1;
          s.sales.outstanding += amount;
        }
        if (row.status === 'PARTIALLY_PAID') s.sales.outstanding += amount;
      } else if (row.invoice_type === 'PURCHASE') {
        s.purchases.total += 1;
        if (row.status === 'OPEN') {
          s.purchases.open += 1;
          s.purchases.payable += amount;
        }
        if (row.status === 'PAID') s.purchases.paid += 1;
        if (row.status === 'OVERDUE') {
          s.purchases.overdue += 1;
          s.purchases.payable += amount;
        }
        if (row.status === 'PARTIALLY_PAID') s.purchases.payable += amount;
      }
    }
    return s;
  }, []);

  // ── Fetch all data client-side ──────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!entity?.id) return;

    const fetchId = ++fetchIdRef.current;
    setIsLoading(true);
    const supabase = getSupabaseBrowserClient();

    try {
      // Fetch invoices and contacts in parallel
      const [invoiceResult, contactResult] = await Promise.all([
        supabase
          .from('invoices')
          .select(
            `*, contacts:counterparty_id(id, name, company_name, email, contact_type),
             invoice_line_items(*)`
          )
          .eq('entity_id', entity.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('contacts')
          .select('*')
          .eq('entity_id', entity.id)
          .eq('is_active', true)
          .order('name', { ascending: true }),
      ]);

      // Guard against stale responses
      if (fetchId !== fetchIdRef.current) return;

      if (invoiceResult.error) {
        console.error('Error fetching invoices:', invoiceResult.error);
      } else if (invoiceResult.data) {
        const invoiceData = invoiceResult.data as unknown as Invoice[];
        setInvoices(invoiceData);
        setStats(computeStats(invoiceData));
      }

      if (contactResult.error) {
        console.error('Error fetching contacts:', contactResult.error);
      } else if (contactResult.data) {
        setContacts(contactResult.data as Contact[]);
      }
    } catch (err) {
      console.error('Error fetching data:', err);
    } finally {
      if (fetchId === fetchIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [entity?.id, computeStats]);

  // Fetch data on mount and when entity changes
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Filtering ──────────────────────────────────────────────────────────────
  const filteredInvoices = invoices.filter(inv => {
    if (inv.invoice_type !== typeTab) return false;
    if (statusFilter !== 'all' && inv.status !== statusFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        inv.invoice_number?.toLowerCase().includes(q) ||
        inv.contacts?.name?.toLowerCase().includes(q) ||
        inv.contacts?.company_name?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // ── Upload ─────────────────────────────────────────────────────────────────
  const handleUpload = useCallback(
    async (files: File[], invoiceType: InvoiceType) => {
      setIsUploading(true);
      setUploadProgress(files.map(f => ({ fileName: f.name, progress: 0, status: 'uploading' })));
      const loadingId = toast.loading(
        files.length === 1 ? `Uploading ${files[0].name}…` : `Uploading ${files.length} files…`
      );

      // Track the last successfully processed result for product modal
      let lastResult: {
        invoice?: Invoice;
        line_items?: InvoiceLineItem[];
        extraction?: { invoice_type: InvoiceType };
      } | null = null;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          setUploadProgress(prev =>
            prev.map((p, j) => (j === i ? { ...p, progress: 40, status: 'uploading' } : p))
          );

          const fd = new FormData();
          fd.append('file', file);
          fd.append('intent', 'upload');
          fd.append('invoice_type', invoiceType);
          if (entity?.id) fd.append('entity_id', entity.id);

          const resp = await fetch('/api/invoices', { method: 'POST', body: fd });
          setUploadProgress(prev =>
            prev.map((p, j) => (j === i ? { ...p, progress: 80, status: 'processing' } : p))
          );

          const result = await resp.json();
          if (!resp.ok || result.error) throw new Error(result.error || 'Upload failed');

          setUploadProgress(prev =>
            prev.map((p, j) => (j === i ? { ...p, progress: 100, status: 'complete' } : p))
          );

          toast.success(`${file.name} processed`, {
            description: result.contact
              ? `Contact: ${result.contact.company_name || result.contact.name}`
              : 'Invoice created successfully',
            duration: 4000,
          });

          // Capture result for product selection
          if (result.invoice && result.line_items) {
            lastResult = result;
          }
        } catch (err) {
          setUploadProgress(prev =>
            prev.map((p, j) => (j === i ? { ...p, status: 'error', error: 'Upload failed' } : p))
          );
          toast.error(`Failed: ${file.name}`, {
            description: err instanceof Error ? err.message : 'An error occurred',
          });
        }
      }

      toast.dismiss(loadingId);
      setIsUploading(false);
      setTimeout(() => setUploadProgress([]), 3000);

      // Re-fetch all data to pick up new invoices + contacts from DB
      await fetchData();

      // Open product selection modal ONLY for PURCHASE invoices
      // SALE invoices don't have inventory — all lines are revenue items
      const resultInvoiceType =
        lastResult?.extraction?.invoice_type ?? lastResult?.invoice?.invoice_type;
      if (
        lastResult?.invoice &&
        lastResult.line_items &&
        lastResult.line_items.length > 0 &&
        resultInvoiceType === 'PURCHASE'
      ) {
        setProductModalInvoiceId(lastResult.invoice.id);
        setProductModalInvoiceType(resultInvoiceType);
        setProductModalLineItems(lastResult.line_items as InvoiceLineItem[]);
        setProductModalOpen(true);
      }
    },
    [entity?.id, fetchData]
  );

  // ── Status update (direct fetch, no route revalidation) ────────────────────
  const handleUpdateStatus = useCallback(
    async (id: string, status: InvoiceStatus) => {
      // Optimistic update
      setInvoices(prev => {
        const updated = prev.map(inv => (inv.id === id ? { ...inv, status } : inv));
        setStats(computeStats(updated));
        return updated;
      });

      try {
        const fd = new FormData();
        fd.append('intent', 'updateStatus');
        fd.append('invoiceId', id);
        fd.append('status', status);

        const resp = await fetch('/api/invoices', { method: 'POST', body: fd });
        const result = await resp.json();

        if (!resp.ok || result.error) {
          toast.error('Failed to update status', { description: result.error });
          // Revert: re-fetch from DB
          await fetchData();
          return;
        }
        toast.success('Status updated');
      } catch (err) {
        toast.error('Failed to update status');
        await fetchData();
      }
    },
    [computeStats, fetchData]
  );

  // ── Delete (direct fetch, no route revalidation) ───────────────────────────
  const handleDelete = useCallback(
    async (id: string) => {
      // Optimistic update
      setInvoices(prev => {
        const updated = prev.filter(inv => inv.id !== id);
        setStats(computeStats(updated));
        return updated;
      });

      try {
        const fd = new FormData();
        fd.append('intent', 'delete');
        fd.append('invoiceId', id);

        const resp = await fetch('/api/invoices', { method: 'POST', body: fd });
        const result = await resp.json();

        if (!resp.ok || result.error) {
          toast.error('Failed to delete invoice', { description: result.error });
          await fetchData();
          return;
        }
        toast.success('Invoice deleted');
      } catch (err) {
        toast.error('Failed to delete invoice');
        await fetchData();
      }
    },
    [computeStats, fetchData]
  );

  // ── View (open signed URL in new tab) ──────────────────────────────────────
  const handleView = useCallback(async (invoice: Invoice) => {
    try {
      const fd = new FormData();
      fd.append('intent', 'getUrl');
      fd.append('invoiceId', invoice.id);

      const resp = await fetch('/api/invoices', { method: 'POST', body: fd });
      const result = await resp.json();

      if (!resp.ok || result.error) {
        toast.error('Could not load document', {
          description: result.error || 'No file attached',
        });
        return;
      }

      if (result.signedUrl) {
        window.open(result.signedUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      toast.error('Failed to load document');
    }
  }, []);

  // ── Download (trigger file download) ───────────────────────────────────────
  const handleDownload = useCallback(async (invoice: Invoice) => {
    try {
      const fd = new FormData();
      fd.append('intent', 'getUrl');
      fd.append('invoiceId', invoice.id);

      const resp = await fetch('/api/invoices', { method: 'POST', body: fd });
      const result = await resp.json();

      if (!resp.ok || result.error) {
        toast.error('Could not download', { description: result.error });
        return;
      }

      if (result.signedUrl) {
        const a = document.createElement('a');
        a.href = result.signedUrl;
        a.download = invoice.invoice_number || 'invoice';
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err) {
      toast.error('Failed to download');
    }
  }, []);

  // ── Product creation from line items ───────────────────────────────────────
  const handleCreateProducts = useCallback(
    async (selected: ProductCandidate[]) => {
      if (!entity?.id) return;

      const fd = new FormData();
      fd.append('intent', 'createProducts');
      fd.append('invoiceId', productModalInvoiceId);
      fd.append('entity_id', entity.id);
      fd.append('lineItemIds', JSON.stringify(selected.map(s => s.lineItemId)));
      // Include user-edited name/sku overrides keyed by line item ID
      const overrides = Object.fromEntries(
        selected.map(s => [s.lineItemId, { name: s.name, sku: s.sku }])
      );
      fd.append('overrides', JSON.stringify(overrides));

      const resp = await fetch('/api/invoices', { method: 'POST', body: fd });
      const result = await resp.json();

      if (!resp.ok || result.error) {
        toast.error('Failed to create products', { description: result.error });
        return;
      }

      toast.success(`Created ${result.count ?? selected.length} product(s)`, {
        description: 'Products are in draft status and can be enriched later.',
        duration: 5000,
      });
    },
    [entity?.id, productModalInvoiceId]
  );

  // ── GL account review (step 2 of upload workflow) ─────────────────────────
  const openGlReview = useCallback(
    async (invoiceId: string) => {
      const invoice = invoices.find(inv => inv.id === invoiceId);
      if (!invoice || !invoice.invoice_line_items?.length) return;

      if (glAccounts.length === 0 && entity?.id) {
        try {
          const accounts = await fetchChartOfAccounts(entity.id);
          setGlAccounts(accounts.filter(a => !a.is_header));
        } catch (err) {
          console.error('Failed to fetch GL accounts:', err);
        }
      }

      setGlReviewInvoice(invoice);
      setGlReviewModalOpen(true);
    },
    [invoices, glAccounts.length, entity?.id]
  );

  const handleProductModalOpenChange = useCallback(
    (open: boolean) => {
      setProductModalOpen(open);
      if (!open && productModalInvoiceId) {
        openGlReview(productModalInvoiceId);
      }
    },
    [productModalInvoiceId, openGlReview]
  );

  // ── Invoice editing ────────────────────────────────────────────────────────
  const handleEditInvoice = useCallback(
    async (invoice: Invoice) => {
      setEditingInvoice(invoice);

      // Fetch GL accounts if not already loaded
      if (glAccounts.length === 0 && entity?.id) {
        try {
          const accounts = await fetchChartOfAccounts(entity.id);
          setGlAccounts(accounts.filter(a => !a.is_header));
        } catch (err) {
          console.error('Failed to fetch GL accounts:', err);
        }
      }

      setEditModalOpen(true);
    },
    [entity?.id, glAccounts.length]
  );

  const handleSaveInvoice = useCallback(
    async (payload: InvoiceEditPayload) => {
      const fd = new FormData();
      fd.append('intent', 'updateInvoice');
      fd.append('invoiceId', payload.invoiceId);
      if (payload.invoice_type) fd.append('invoice_type', payload.invoice_type);
      if (payload.notes !== undefined) fd.append('notes', payload.notes ?? '');
      if (payload.lineItemGlAccounts) {
        fd.append('line_item_gl_accounts', JSON.stringify(payload.lineItemGlAccounts));
      }

      const resp = await fetch('/api/invoices', { method: 'POST', body: fd });
      const result = await resp.json();

      if (!resp.ok || result.error) {
        toast.error('Failed to update invoice', { description: result.error });
        throw new Error(result.error || 'Update failed');
      }

      toast.success('Invoice updated');
      await fetchData();
    },
    [fetchData]
  );

  const handleConfirmGlAccounts = useCallback(
    async (lineItemGlAccounts: Record<string, string | null>) => {
      if (!glReviewInvoice) return;
      await handleSaveInvoice({
        invoiceId: glReviewInvoice.id,
        lineItemGlAccounts,
      });
    },
    [glReviewInvoice, handleSaveInvoice]
  );

  const isSale = typeTab === 'SALE';
  const typeStats = isSale ? stats.sales : stats.purchases;

  return (
    <section className="bg-card rounded-xl border border-border p-6 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Receipt size={24} className="text-primary" weight="duotone" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Invoices</h2>
            <p className="text-sm text-muted-foreground">
              {stats.total} total · {contacts.length} contacts
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowContacts(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
              showContacts
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'text-muted-foreground hover:text-foreground border-border hover:bg-muted'
            }`}
          >
            <Users size={16} weight={showContacts ? 'bold' : 'regular'} />
            Contacts
          </button>
          <button
            onClick={() => {
              fetchData();
              onRefresh?.();
            }}
            className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground"
            title="Refresh"
          >
            <ArrowsClockwise size={20} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── SALE / PURCHASE Type Tabs ── */}
      <div className="flex gap-2 border-b border-border">
        {(['SALE', 'PURCHASE'] as InvoiceType[]).map(type => (
          <button
            key={type}
            onClick={() => {
              setTypeTab(type);
              setStatusFilter('all');
            }}
            className={`flex items-center gap-2 px-5 py-2.5 text-sm font-semibold border-b-2 transition-all -mb-px ${
              typeTab === type
                ? type === 'SALE'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-orange-500 text-orange-400'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {type === 'SALE' ? (
              <TrendUp size={16} weight="bold" />
            ) : (
              <TrendDown size={16} weight="bold" />
            )}
            {type === 'SALE' ? 'Sales' : 'Purchases'}
            <span className="text-xs opacity-70 font-normal">
              ({type === 'SALE' ? stats.sales.total : stats.purchases.total})
            </span>
          </button>
        ))}
      </div>

      {/* ── Stats Cards for active type ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className={`rounded-lg p-4 ${isSale ? 'bg-blue-500/10' : 'bg-orange-500/10'}`}>
          <p className={`text-xl font-bold ${isSale ? 'text-blue-400' : 'text-orange-400'}`}>
            {formatMoney(isSale ? stats.sales.outstanding : stats.purchases.payable)}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isSale ? 'Outstanding' : 'Payable'}
          </p>
        </div>
        <div className="bg-yellow-500/10 rounded-lg p-4">
          <p className="text-xl font-bold text-yellow-400">{typeStats.open}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Open</p>
        </div>
        <div className="bg-green-500/10 rounded-lg p-4">
          <p className="text-xl font-bold text-green-400">{typeStats.paid}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Paid</p>
        </div>
        <div className="bg-red-500/10 rounded-lg p-4">
          <p className="text-xl font-bold text-red-400">{typeStats.overdue}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Overdue</p>
        </div>
      </div>

      {/* ── Contacts Panel ── */}
      {showContacts && contacts.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <p className="text-sm font-medium">Contacts ({contacts.length})</p>
            <button
              onClick={() => setShowContacts(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>
          <div className="divide-y divide-border max-h-64 overflow-y-auto">
            {contacts.map(c => (
              <div key={c.id} className="px-4 py-3 flex items-start justify-between text-sm">
                <div>
                  <p className="font-medium">{c.company_name || c.name}</p>
                  {c.company_name && c.name !== c.company_name && (
                    <p className="text-xs text-muted-foreground">{c.name}</p>
                  )}
                  {c.email && <p className="text-xs text-muted-foreground">{c.email}</p>}
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full border ${
                    c.contact_type === 'customer'
                      ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                      : c.contact_type === 'supplier'
                        ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
                        : 'bg-gray-500/10 text-gray-400 border-gray-500/20'
                  }`}
                >
                  {c.contact_type}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Upload Zone ── */}
      <InvoiceUpload
        onUpload={handleUpload}
        isUploading={isUploading}
        uploadProgress={uploadProgress}
      />

      {/* ── Filters ── */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex items-center gap-1 bg-muted/40 rounded-lg p-1 flex-wrap">
          {STATUS_FILTERS.map(f => {
            const count =
              f.value === 'all'
                ? typeStats.total
                : invoices.filter(inv => inv.invoice_type === typeTab && inv.status === f.value)
                    .length;
            return (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  statusFilter === f.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f.label}
                <span className="ml-1 opacity-60">({count})</span>
              </button>
            );
          })}
        </div>

        <div className="relative flex-1 max-w-xs ml-auto">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by invoice # or contact…"
            className="w-full pl-8 pr-8 py-2 bg-muted/40 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-muted rounded"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* ── Invoice List ── */}
      <InvoiceList
        invoices={filteredInvoices}
        onView={handleView}
        onUpdateStatus={handleUpdateStatus}
        onDelete={handleDelete}
        onDownload={handleDownload}
        onEdit={handleEditInvoice}
        isLoading={isLoading}
      />

      {/* ── Product Selection Modal (shown after upload) ── */}
      <ProductSelectionModal
        open={productModalOpen}
        onOpenChange={handleProductModalOpenChange}
        lineItems={productModalLineItems}
        invoiceId={productModalInvoiceId}
        invoiceType={productModalInvoiceType}
        entityId={entity?.id ?? ''}
        onConfirm={handleCreateProducts}
      />

      {/* ── GL Account Review Modal (step 2 of upload workflow) ── */}
      <GlAccountReviewModal
        open={glReviewModalOpen}
        onOpenChange={open => {
          setGlReviewModalOpen(open);
          if (!open) setGlReviewInvoice(null);
        }}
        invoice={glReviewInvoice}
        glAccounts={glAccounts}
        onConfirm={handleConfirmGlAccounts}
      />

      {/* ── Invoice Edit Modal ── */}
      {editingInvoice && (
        <InvoiceEditModal
          open={editModalOpen}
          onOpenChange={open => {
            setEditModalOpen(open);
            if (!open) setEditingInvoice(null);
          }}
          invoice={editingInvoice}
          glAccounts={glAccounts}
          onSave={handleSaveInvoice}
        />
      )}
    </section>
  );
}
