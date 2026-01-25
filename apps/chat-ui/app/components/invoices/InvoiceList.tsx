import React, { useState } from 'react';
import {
  File,
  Eye,
  Trash,
  PencilSimple,
  Check,
  X,
  Clock,
  Warning,
  CheckCircle,
  XCircle,
  DotsThreeVertical,
  Download,
  CaretDown,
  CaretUp,
  Brain,
  CircleNotch,
  Sparkle,
} from 'phosphor-react';
import type { Invoice, InvoiceStatus, UpdateInvoiceInput, ExtractionStatus } from '~/types/invoice';

interface InvoiceListProps {
  invoices: Invoice[];
  onView: (invoice: Invoice) => void;
  onEdit: (id: string, data: UpdateInvoiceInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDownload: (invoice: Invoice) => void;
  isLoading?: boolean;
}

// Status badge component
function StatusBadge({ status }: { status: InvoiceStatus }) {
  const configs: Record<
    InvoiceStatus,
    { icon: React.ReactNode; label: string; className: string }
  > = {
    pending: {
      icon: <Clock size={14} weight="bold" />,
      label: 'Pending',
      className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    },
    paid: {
      icon: <CheckCircle size={14} weight="bold" />,
      label: 'Paid',
      className: 'bg-green-500/20 text-green-400 border-green-500/30',
    },
    overdue: {
      icon: <Warning size={14} weight="bold" />,
      label: 'Overdue',
      className: 'bg-red-500/20 text-red-400 border-red-500/30',
    },
    cancelled: {
      icon: <XCircle size={14} weight="bold" />,
      label: 'Cancelled',
      className: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    },
  };

  const config = configs[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${config.className}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
}

// Extraction status badge component
function ExtractionBadge({
  status,
  confidence,
}: {
  status: ExtractionStatus | null;
  confidence: number | null;
}) {
  if (!status) return null;

  const configs: Record<
    ExtractionStatus,
    { icon: React.ReactNode; label: string; className: string }
  > = {
    pending: {
      icon: <Clock size={12} weight="bold" />,
      label: 'Awaiting AI',
      className: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
    },
    processing: {
      icon: <CircleNotch size={12} weight="bold" className="animate-spin" />,
      label: 'Processing',
      className: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    },
    completed: {
      icon: <Sparkle size={12} weight="bold" />,
      label: confidence ? `AI ${Math.round(confidence * 100)}%` : 'AI Extracted',
      className: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    },
    failed: {
      icon: <XCircle size={12} weight="bold" />,
      label: 'AI Failed',
      className: 'bg-red-500/20 text-red-400 border-red-500/30',
    },
  };

  const config = configs[status];

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${config.className}`}
      title={`Document extraction: ${status}${confidence ? ` (${Math.round(confidence * 100)}% confidence)` : ''}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
}

// Inline edit form for quick edits
function InlineEditForm({
  invoice,
  onSave,
  onCancel,
}: {
  invoice: Invoice;
  onSave: (data: UpdateInvoiceInput) => void;
  onCancel: () => void;
}) {
  const [formData, setFormData] = useState({
    vendor_name: invoice.vendor_name || '',
    invoice_number: invoice.invoice_number || '',
    amount: invoice.amount?.toString() || '',
    status: invoice.status,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      vendor_name: formData.vendor_name || undefined,
      invoice_number: formData.invoice_number || undefined,
      amount: formData.amount ? parseFloat(formData.amount) : undefined,
      status: formData.status,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 flex-wrap">
      <input
        type="text"
        value={formData.vendor_name}
        onChange={e => setFormData({ ...formData, vendor_name: e.target.value })}
        placeholder="Vendor"
        className="px-2 py-1 text-sm bg-background border border-border rounded w-32"
      />
      <input
        type="text"
        value={formData.invoice_number}
        onChange={e => setFormData({ ...formData, invoice_number: e.target.value })}
        placeholder="Invoice #"
        className="px-2 py-1 text-sm bg-background border border-border rounded w-24"
      />
      <input
        type="number"
        step="0.01"
        value={formData.amount}
        onChange={e => setFormData({ ...formData, amount: e.target.value })}
        placeholder="Amount"
        className="px-2 py-1 text-sm bg-background border border-border rounded w-24"
      />
      <select
        value={formData.status}
        onChange={e => setFormData({ ...formData, status: e.target.value as InvoiceStatus })}
        className="px-2 py-1 text-sm bg-background border border-border rounded"
      >
        <option value="pending">Pending</option>
        <option value="paid">Paid</option>
        <option value="overdue">Overdue</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <button type="submit" className="p-1.5 hover:bg-green-500/20 rounded text-green-400">
        <Check size={16} weight="bold" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="p-1.5 hover:bg-red-500/20 rounded text-red-400"
      >
        <X size={16} weight="bold" />
      </button>
    </form>
  );
}

// Format currency
function formatCurrency(amount: number | null, currency: string = 'USD'): string {
  if (amount === null) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
}

// Format date
function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Format file size
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * InvoiceList Component
 *
 * Displays list of invoices with:
 * - Sortable columns
 * - Status badges
 * - Inline editing
 * - Actions (view, edit, delete, download)
 */
export function InvoiceList({
  invoices,
  onView,
  onEdit,
  onDelete,
  onDownload,
  isLoading,
}: InvoiceListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sortField, setSortField] = useState<keyof Invoice>('uploaded_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const handleSort = (field: keyof Invoice) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const sortedInvoices = [...invoices].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    if (aVal === null || aVal === undefined) return 1;
    if (bVal === null || bVal === undefined) return -1;
    if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const handleEditSave = async (id: string, data: UpdateInvoiceInput) => {
    await onEdit(id, data);
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    await onDelete(id);
    setDeletingId(null);
  };

  const SortIcon = ({ field }: { field: keyof Invoice }) => {
    if (sortField !== field) return null;
    return sortDir === 'asc' ? (
      <CaretUp size={14} weight="bold" />
    ) : (
      <CaretDown size={14} weight="bold" />
    );
  };

  if (invoices.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <File size={48} className="mx-auto mb-4 opacity-50" />
        <p className="text-lg font-medium">No invoices yet</p>
        <p className="text-sm mt-1">Upload your first invoice to get started</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="pb-3 font-medium text-muted-foreground">
              <button
                onClick={() => handleSort('file_name')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                File <SortIcon field="file_name" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground">
              <button
                onClick={() => handleSort('vendor_name')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                Vendor <SortIcon field="vendor_name" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">
              <button
                onClick={() => handleSort('invoice_number')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                Invoice # <SortIcon field="invoice_number" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground">
              <button
                onClick={() => handleSort('amount')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                Amount <SortIcon field="amount" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground hidden lg:table-cell">
              <button
                onClick={() => handleSort('invoice_date')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                Date <SortIcon field="invoice_date" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground">
              <button
                onClick={() => handleSort('status')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                Status <SortIcon field="status" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sortedInvoices.map(invoice => (
            <React.Fragment key={invoice.id}>
              <tr
                className={`border-b border-border/50 hover:bg-muted/30 transition-colors ${
                  deletingId === invoice.id ? 'opacity-50' : ''
                }`}
              >
                {editingId === invoice.id ? (
                  <td colSpan={7} className="py-3 px-2">
                    <InlineEditForm
                      invoice={invoice}
                      onSave={data => handleEditSave(invoice.id, data)}
                      onCancel={() => setEditingId(null)}
                    />
                  </td>
                ) : (
                  <>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <File size={18} className="text-primary" weight="duotone" />
                        <div className="min-w-0">
                          <p className="font-medium truncate max-w-[150px]">{invoice.file_name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(invoice.file_size)}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3">
                      {invoice.vendor_name || (
                        <span className="text-muted-foreground italic">Unknown</span>
                      )}
                    </td>
                    <td className="py-3 hidden md:table-cell">{invoice.invoice_number || '-'}</td>
                    <td className="py-3 font-medium">
                      {formatCurrency(invoice.amount, invoice.currency)}
                    </td>
                    <td className="py-3 hidden lg:table-cell">
                      {formatDate(invoice.invoice_date)}
                    </td>
                    <td className="py-3">
                      <div className="flex flex-col gap-1">
                        <StatusBadge status={invoice.status} />
                        <ExtractionBadge
                          status={invoice.extraction_status ?? null}
                          confidence={invoice.extraction_confidence ?? null}
                        />
                      </div>
                    </td>
                    <td className="py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => onView(invoice)}
                          className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
                          title="View"
                        >
                          <Eye size={16} />
                        </button>
                        <button
                          onClick={() => onDownload(invoice)}
                          className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
                          title="Download"
                        >
                          <Download size={16} />
                        </button>
                        <button
                          onClick={() => setEditingId(invoice.id)}
                          className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
                          title="Edit"
                        >
                          <PencilSimple size={16} />
                        </button>
                        <button
                          onClick={() => handleDelete(invoice.id)}
                          disabled={deletingId === invoice.id}
                          className="p-1.5 hover:bg-destructive/20 rounded text-muted-foreground hover:text-destructive"
                          title="Delete"
                        >
                          <Trash size={16} />
                        </button>
                        <button
                          onClick={() =>
                            setExpandedRow(expandedRow === invoice.id ? null : invoice.id)
                          }
                          className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground lg:hidden"
                          title="More details"
                        >
                          <DotsThreeVertical size={16} />
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
              {/* Mobile expanded row */}
              {expandedRow === invoice.id && (
                <tr className="lg:hidden bg-muted/20">
                  <td colSpan={7} className="py-3 px-4 text-sm">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-muted-foreground">Invoice #:</span>
                        <span className="ml-2">{invoice.invoice_number || '-'}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Date:</span>
                        <span className="ml-2">{formatDate(invoice.invoice_date)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Due:</span>
                        <span className="ml-2">{formatDate(invoice.due_date)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Uploaded:</span>
                        <span className="ml-2">{formatDate(invoice.uploaded_at)}</span>
                      </div>
                      {invoice.document_category && (
                        <div>
                          <span className="text-muted-foreground">Category:</span>
                          <span className="ml-2 capitalize">{invoice.document_category}</span>
                        </div>
                      )}
                      {invoice.extraction_status === 'completed' && invoice.subtotal && (
                        <div>
                          <span className="text-muted-foreground">Subtotal:</span>
                          <span className="ml-2">
                            {formatCurrency(invoice.subtotal, invoice.currency)}
                          </span>
                        </div>
                      )}
                      {invoice.extraction_status === 'completed' && invoice.tax_amount && (
                        <div>
                          <span className="text-muted-foreground">Tax:</span>
                          <span className="ml-2">
                            {formatCurrency(invoice.tax_amount, invoice.currency)}
                          </span>
                        </div>
                      )}
                      {invoice.notes && (
                        <div className="col-span-2">
                          <span className="text-muted-foreground">Notes:</span>
                          <p className="mt-1">{invoice.notes}</p>
                        </div>
                      )}
                      {invoice.line_items && invoice.line_items.length > 0 && (
                        <div className="col-span-2">
                          <span className="text-muted-foreground">
                            Line Items ({invoice.line_items.length}):
                          </span>
                          <ul className="mt-1 space-y-1">
                            {invoice.line_items.slice(0, 3).map((item, idx) => (
                              <li key={idx} className="text-xs">
                                {item.description} {item.quantity && `x${item.quantity}`} -{' '}
                                {formatCurrency(item.total_price, invoice.currency)}
                              </li>
                            ))}
                            {invoice.line_items.length > 3 && (
                              <li className="text-xs text-muted-foreground">
                                +{invoice.line_items.length - 3} more items...
                              </li>
                            )}
                          </ul>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
