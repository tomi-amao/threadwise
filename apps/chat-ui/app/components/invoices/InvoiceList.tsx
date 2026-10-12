import React, { useState } from 'react';
import {
  Receipt,
  Eye,
  Trash,
  Download,
  CaretDown,
  CaretUp,
  ArrowUUpLeft,
  Tag,
  PencilSimple,
} from 'phosphor-react';
import { SearchableSelect } from '~/components/ui/searchable-select';
import type { Invoice, InvoiceStatus, InvoiceType } from '~/types/invoice';

interface InvoiceListProps {
  invoices: Invoice[];
  onView: (invoice: Invoice) => void;
  onUpdateStatus: (id: string, status: InvoiceStatus) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDownload: (invoice: Invoice) => void;
  onEdit?: (invoice: Invoice) => void;
  isLoading?: boolean;
}

// ─── Type Badge ────────────────────────────────────────────────────────────────
function TypeBadge({ type }: { type: InvoiceType }) {
  const isSale = type === 'SALE';
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
        isSale
          ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
          : 'bg-orange-500/15 text-orange-400 border-orange-500/30'
      }`}
    >
      <Tag size={11} weight="bold" />
      {isSale ? 'Sale' : 'Purchase'}
    </span>
  );
}

// ─── Status Badge ──────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<InvoiceStatus, { label: string; className: string }> = {
  DRAFT: { label: 'Draft', className: 'bg-slate-500/20 text-slate-400 border-slate-500/30' },
  OPEN: { label: 'Open', className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  PAID: { label: 'Paid', className: 'bg-green-500/20 text-green-400 border-green-500/30' },
  PARTIALLY_PAID: {
    label: 'Partial',
    className: 'bg-teal-500/20 text-teal-400 border-teal-500/30',
  },
  OVERDUE: { label: 'Overdue', className: 'bg-red-500/20 text-red-400 border-red-500/30' },
  CANCELLED: { label: 'Cancelled', className: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
  VOID: { label: 'Void', className: 'bg-gray-600/20 text-gray-500 border-gray-600/30' },
};

function StatusBadge({ status }: { status: InvoiceStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.DRAFT;
  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}

// ─── Status Select (quick update) ─────────────────────────────────────────────
const STATUS_OPTIONS = (Object.keys(STATUS_CONFIG) as InvoiceStatus[]).map(s => ({
  value: s,
  label: STATUS_CONFIG[s].label,
}));

function StatusSelect({
  current,
  onChange,
}: {
  current: InvoiceStatus;
  onChange: (s: InvoiceStatus) => void;
}) {
  return (
    <SearchableSelect
      options={STATUS_OPTIONS}
      value={current}
      onChange={s => onChange(s as InvoiceStatus)}
      searchable={false}
      stopPropagation
      className="px-2 py-1"
      renderValue={opt => {
        if (!opt) return null;
        const cfg = STATUS_CONFIG[opt.value as InvoiceStatus];
        const textClass = cfg?.className.split(' ').find(c => c.startsWith('text-')) ?? '';
        return (
          <span className={`text-xs font-medium ${textClass}`}>{cfg?.label ?? opt.label}</span>
        );
      }}
      renderOption={opt => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
            STATUS_CONFIG[opt.value as InvoiceStatus]?.className ?? ''
          }`}
        >
          {STATUS_CONFIG[opt.value as InvoiceStatus]?.label ?? opt.label}
        </span>
      )}
    />
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatCurrency(amount: number | null | undefined, currency: string = 'EUR'): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(amount);
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function contactDisplayName(invoice: Invoice): string {
  if (!invoice.contacts) return '—';
  return invoice.contacts.company_name || invoice.contacts.name || '—';
}

// ─── Main Component ────────────────────────────────────────────────────────────
export function InvoiceList({
  invoices,
  onView,
  onUpdateStatus,
  onDelete,
  onDownload,
  onEdit,
  isLoading,
}: InvoiceListProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingStatusId, setEditingStatusId] = useState<string | null>(null);
  const [sortField, setSortField] = useState<keyof Invoice>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleSort = (field: keyof Invoice) => {
    if (sortField === field) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const sorted = [...invoices].sort((a, b) => {
    const av = a[sortField],
      bv = b[sortField];
    if (av == null) return 1;
    if (bv == null) return -1;
    return av < bv ? (sortDir === 'asc' ? -1 : 1) : av > bv ? (sortDir === 'asc' ? 1 : -1) : 0;
  });

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    await onDelete(id);
    setDeletingId(null);
  };

  const handleStatusChange = async (id: string, status: InvoiceStatus) => {
    setEditingStatusId(id);
    await onUpdateStatus(id, status);
    setEditingStatusId(null);
  };

  const SortIcon = ({ field }: { field: keyof Invoice }) =>
    sortField !== field ? null : sortDir === 'asc' ? (
      <CaretUp size={13} weight="bold" />
    ) : (
      <CaretDown size={13} weight="bold" />
    );

  if (!isLoading && invoices.length === 0) {
    return (
      <div className="text-center py-14 text-muted-foreground">
        <Receipt size={48} className="mx-auto mb-3 opacity-40" />
        <p className="text-base font-medium">No invoices yet</p>
        <p className="text-sm mt-1">Upload an invoice to get started</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="pb-3 font-medium text-muted-foreground pr-4">
              <button
                onClick={() => handleSort('invoice_type')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                Type <SortIcon field="invoice_type" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground pr-4">
              <button
                onClick={() => handleSort('invoice_number')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                Invoice # <SortIcon field="invoice_number" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground pr-4 hidden sm:table-cell">
              Contact
            </th>
            <th className="pb-3 font-medium text-muted-foreground pr-4">
              <button
                onClick={() => handleSort('gross_amount')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                Total <SortIcon field="gross_amount" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground pr-4 hidden md:table-cell">
              <button
                onClick={() => handleSort('invoice_date')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                Date <SortIcon field="invoice_date" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground pr-4 hidden md:table-cell">
              <button
                onClick={() => handleSort('due_date')}
                className="flex items-center gap-1 hover:text-foreground"
              >
                Due <SortIcon field="due_date" />
              </button>
            </th>
            <th className="pb-3 font-medium text-muted-foreground pr-4">
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
          {sorted.map(invoice => (
            <React.Fragment key={invoice.id}>
              <tr
                className={`border-b border-border/50 hover:bg-muted/20 transition-colors cursor-pointer ${
                  deletingId === invoice.id ? 'opacity-40' : ''
                }`}
                onClick={() => setExpandedId(expandedId === invoice.id ? null : invoice.id)}
              >
                {/* Type */}
                <td className="py-3 pr-4">
                  <TypeBadge type={invoice.invoice_type} />
                </td>

                {/* Invoice # */}
                <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">
                  {invoice.invoice_number || <span className="italic">—</span>}
                </td>

                {/* Contact */}
                <td className="py-3 pr-4 hidden sm:table-cell max-w-40">
                  <span className="truncate block">{contactDisplayName(invoice)}</span>
                </td>

                {/* Total (gross) */}
                <td className="py-3 pr-4 font-semibold tabular-nums">
                  {formatCurrency(invoice.gross_amount, invoice.currency)}
                </td>

                {/* Invoice date */}
                <td className="py-3 pr-4 text-muted-foreground hidden md:table-cell">
                  {formatDate(invoice.invoice_date)}
                </td>

                {/* Due date */}
                <td className="py-3 pr-4 text-muted-foreground hidden md:table-cell">
                  {formatDate(invoice.due_date)}
                </td>

                {/* Status */}
                <td className="py-3 pr-4" onClick={e => e.stopPropagation()}>
                  {editingStatusId === invoice.id ? (
                    <span className="text-xs text-muted-foreground">Saving…</span>
                  ) : (
                    <StatusSelect
                      current={invoice.status}
                      onChange={s => handleStatusChange(invoice.id, s)}
                    />
                  )}
                </td>

                {/* Actions */}
                <td className="py-3" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    {onEdit && (
                      <button
                        onClick={() => onEdit(invoice)}
                        className="p-1.5 hover:bg-primary/10 rounded text-muted-foreground hover:text-primary"
                        title="Edit invoice"
                      >
                        <PencilSimple size={16} />
                      </button>
                    )}
                    <button
                      onClick={() => onView(invoice)}
                      className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
                      title="View document"
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
                      onClick={() => handleDelete(invoice.id)}
                      disabled={deletingId === invoice.id}
                      className="p-1.5 hover:bg-destructive/20 rounded text-muted-foreground hover:text-destructive disabled:opacity-40"
                      title="Delete"
                    >
                      <Trash size={16} />
                    </button>
                  </div>
                </td>
              </tr>

              {/* ── Expanded row: amounts breakdown + line items ── */}
              {expandedId === invoice.id && (
                <tr className="bg-muted/10">
                  <td colSpan={8} className="px-4 py-4">
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-4 text-xs">
                      <div>
                        <p className="text-muted-foreground mb-0.5">Net</p>
                        <p className="font-medium tabular-nums">
                          {formatCurrency(invoice.net_amount, invoice.currency)}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-0.5">Tax</p>
                        <p className="font-medium tabular-nums">
                          {formatCurrency(invoice.tax_amount, invoice.currency)}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-0.5">Gross</p>
                        <p className="font-semibold tabular-nums">
                          {formatCurrency(invoice.gross_amount, invoice.currency)}
                        </p>
                      </div>
                      <div className="sm:hidden">
                        <p className="text-muted-foreground mb-0.5">Date</p>
                        <p>{formatDate(invoice.invoice_date)}</p>
                      </div>
                      {invoice.contacts && (
                        <div className="sm:hidden">
                          <p className="text-muted-foreground mb-0.5">Contact</p>
                          <p>{contactDisplayName(invoice)}</p>
                        </div>
                      )}
                      {invoice.notes && (
                        <div className="col-span-2 sm:col-span-3 lg:col-span-5">
                          <p className="text-muted-foreground mb-0.5">Notes</p>
                          <p>{invoice.notes}</p>
                        </div>
                      )}
                    </div>

                    {/* Line items */}
                    {invoice.invoice_line_items && invoice.invoice_line_items.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-2">
                          Line Items ({invoice.invoice_line_items.length})
                        </p>
                        <table className="w-full text-xs border border-border/40 rounded">
                          <thead>
                            <tr className="border-b border-border/40 bg-muted/20">
                              <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                                Description
                              </th>
                              <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                                Qty
                              </th>
                              <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                                Unit
                              </th>
                              <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                                Net
                              </th>
                              <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                                VAT
                              </th>
                              <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                                Gross
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {invoice.invoice_line_items.map(li => (
                              <tr key={li.id} className="border-b border-border/20 last:border-0">
                                <td className="px-3 py-2">{li.description}</td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {li.quantity ?? '—'}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {formatCurrency(li.unit_cost, invoice.currency)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {formatCurrency(li.line_net, invoice.currency)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {formatCurrency(li.line_vat, invoice.currency)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums font-medium">
                                  {formatCurrency(li.line_gross, invoice.currency)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
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
