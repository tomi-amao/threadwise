import React, { useState, useCallback, useEffect } from 'react';
import { useFetcher } from 'react-router';
import { Receipt, FunnelSimple, MagnifyingGlass, X, ArrowsClockwise } from 'phosphor-react';
import { InvoiceUpload } from './InvoiceUpload';
import { InvoiceList } from './InvoiceList';
import type {
  Invoice,
  InvoiceStatus,
  InvoiceStats,
  UploadProgress,
  UpdateInvoiceInput,
} from '~/types/invoice';

interface InvoicesSectionProps {
  invoices: Invoice[];
  stats: InvoiceStats;
  onRefresh?: () => void;
}

// Status filter tabs
const STATUS_FILTERS: { value: InvoiceStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'cancelled', label: 'Cancelled' },
];

/**
 * InvoicesSection Component
 *
 * Main invoice management section with:
 * - Upload zone
 * - Stats cards
 * - Filterable invoice list
 * - Search functionality
 */
export function InvoicesSection({
  invoices: initialInvoices,
  stats: initialStats,
  onRefresh,
}: InvoicesSectionProps) {
  const fetcher = useFetcher();
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices);
  const [stats, setStats] = useState<InvoiceStats>(initialStats);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  const [previewInvoice, setPreviewInvoice] = useState<Invoice | null>(null);

  // Update local state when props change
  useEffect(() => {
    setInvoices(initialInvoices);
    setStats(initialStats);
  }, [initialInvoices, initialStats]);

  // Filter invoices
  const filteredInvoices = invoices.filter(invoice => {
    // Status filter
    if (statusFilter !== 'all' && invoice.status !== statusFilter) {
      return false;
    }
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        invoice.file_name.toLowerCase().includes(query) ||
        invoice.vendor_name?.toLowerCase().includes(query) ||
        invoice.invoice_number?.toLowerCase().includes(query)
      );
    }
    return true;
  });

  // Handle file upload
  const handleUpload = useCallback(
    async (files: File[]) => {
      setIsUploading(true);
      const progressItems: UploadProgress[] = files.map(f => ({
        fileName: f.name,
        progress: 0,
        status: 'uploading' as const,
      }));
      setUploadProgress(progressItems);

      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        try {
          // Update progress to uploading
          setUploadProgress(prev =>
            prev.map((p, idx) => (idx === i ? { ...p, progress: 30, status: 'uploading' } : p))
          );

          // Create FormData and submit
          const formData = new FormData();
          formData.append('file', file);
          formData.append('intent', 'upload');
          console.log('Uploading file:', file);

          // Use fetcher to submit
          fetcher.submit(formData, {
            method: 'POST',
            action: '/api/invoices',
            encType: 'multipart/form-data',
          });

          // Simulate progress (actual progress would come from upload)
          setUploadProgress(prev =>
            prev.map((p, idx) => (idx === i ? { ...p, progress: 70, status: 'processing' } : p))
          );

          // Wait a bit for the upload to complete
          await new Promise(resolve => setTimeout(resolve, 500));

          // Mark as complete
          setUploadProgress(prev =>
            prev.map((p, idx) => (idx === i ? { ...p, progress: 100, status: 'complete' } : p))
          );
        } catch (error) {
          setUploadProgress(prev =>
            prev.map((p, idx) =>
              idx === i ? { ...p, status: 'error', error: 'Upload failed' } : p
            )
          );
        }
      }

      setIsUploading(false);

      // Clear progress after a delay
      setTimeout(() => {
        setUploadProgress([]);
        onRefresh?.();
      }, 2000);
    },
    [fetcher, onRefresh]
  );

  // Handle view invoice
  const handleView = useCallback(
    (invoice: Invoice) => {
      setPreviewInvoice(invoice);
      // Open in new tab if we have a signed URL
      if (invoice.signedUrl) {
        window.open(invoice.signedUrl, '_blank');
      } else {
        // Fetch signed URL and open
        fetcher.submit(
          { intent: 'getUrl', invoiceId: invoice.id },
          { method: 'POST', action: '/api/invoices' }
        );
      }
    },
    [fetcher]
  );

  // Handle download invoice
  const handleDownload = useCallback(
    (invoice: Invoice) => {
      if (invoice.signedUrl) {
        const link = document.createElement('a');
        link.href = invoice.signedUrl;
        link.download = invoice.file_name;
        link.click();
      } else {
        fetcher.submit(
          { intent: 'download', invoiceId: invoice.id },
          { method: 'POST', action: '/api/invoices' }
        );
      }
    },
    [fetcher]
  );

  // Handle edit invoice
  const handleEdit = useCallback(
    async (id: string, data: UpdateInvoiceInput) => {
      fetcher.submit(
        { intent: 'update', invoiceId: id, ...data },
        { method: 'POST', action: '/api/invoices' }
      );

      // Optimistic update
      setInvoices(prev =>
        prev.map(inv =>
          inv.id === id ? { ...inv, ...data, updated_at: new Date().toISOString() } : inv
        )
      );
    },
    [fetcher]
  );

  // Handle delete invoice
  const handleDelete = useCallback(
    async (id: string) => {
      fetcher.submit(
        { intent: 'delete', invoiceId: id },
        { method: 'POST', action: '/api/invoices' }
      );

      // Optimistic update
      setInvoices(prev => prev.filter(inv => inv.id !== id));
      setStats(prev => ({
        ...prev,
        total: prev.total - 1,
      }));
    },
    [fetcher]
  );

  return (
    <section className="bg-card rounded-xl border border-border p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Receipt size={24} className="text-primary" weight="duotone" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Invoice Management</h2>
            <p className="text-sm text-muted-foreground">Upload and manage your invoices</p>
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
        >
          <ArrowsClockwise size={20} />
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-muted/30 rounded-lg p-4">
          <p className="text-2xl font-bold">{stats.total}</p>
          <p className="text-sm text-muted-foreground">Total Invoices</p>
        </div>
        <div className="bg-yellow-500/10 rounded-lg p-4">
          <p className="text-2xl font-bold text-yellow-400">{stats.pending}</p>
          <p className="text-sm text-muted-foreground">Pending</p>
        </div>
        <div className="bg-red-500/10 rounded-lg p-4">
          <p className="text-2xl font-bold text-red-400">{stats.overdue}</p>
          <p className="text-sm text-muted-foreground">Overdue</p>
        </div>
        <div className="bg-primary/10 rounded-lg p-4">
          <p className="text-2xl font-bold text-primary">${stats.pendingAmount.toLocaleString()}</p>
          <p className="text-sm text-muted-foreground">Outstanding</p>
        </div>
      </div>

      {/* Upload Zone */}
      <div className="mb-6">
        <InvoiceUpload
          onUpload={handleUpload}
          isUploading={isUploading}
          uploadProgress={uploadProgress}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        {/* Status filter tabs */}
        <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-1 overflow-x-auto">
          {STATUS_FILTERS.map(filter => (
            <button
              key={filter.value}
              onClick={() => setStatusFilter(filter.value)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
                statusFilter === filter.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {filter.label}
              {filter.value === 'all' && (
                <span className="ml-1.5 text-xs opacity-70">({stats.total})</span>
              )}
              {filter.value === 'pending' && (
                <span className="ml-1.5 text-xs opacity-70">({stats.pending})</span>
              )}
              {filter.value === 'paid' && (
                <span className="ml-1.5 text-xs opacity-70">({stats.paid})</span>
              )}
              {filter.value === 'overdue' && (
                <span className="ml-1.5 text-xs opacity-70">({stats.overdue})</span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <MagnifyingGlass
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search invoices..."
            className="w-full pl-9 pr-8 py-2 bg-muted/50 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-muted rounded"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Invoice List */}
      <InvoiceList
        invoices={filteredInvoices}
        onView={handleView}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onDownload={handleDownload}
        isLoading={fetcher.state === 'submitting'}
      />

      {/* Preview Modal */}
      {previewInvoice && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setPreviewInvoice(null)}
        >
          <div
            className="bg-card rounded-xl border border-border max-w-4xl w-full max-h-[90vh] overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="font-semibold">{previewInvoice.file_name}</h3>
              <button
                onClick={() => setPreviewInvoice(null)}
                className="p-2 hover:bg-muted rounded-lg"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-4 h-[70vh]">
              {previewInvoice.signedUrl ? (
                <iframe
                  src={previewInvoice.signedUrl}
                  className="w-full h-full rounded-lg border border-border"
                  title={previewInvoice.file_name}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  Loading preview...
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
