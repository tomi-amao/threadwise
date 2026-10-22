/**
 * InvoicesPage
 *
 * What you owe, what you are owed, and what still needs your attention. An invoice moves
 * To review (uploaded, read by the AI, waiting for a person) to Open (finalised and posted)
 * to Paid, so that is how the page is organised: the tiles say where the money stands, the
 * tabs are the stages, and "Jump to" goes straight to what is late or waiting.
 *
 * Tab, direction, search, the overdue filter and the open invoice live in the URL.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, MagnifyingGlass, Plus, X } from 'phosphor-react';
import { useRevalidator } from 'react-router';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import { Input } from '~/components/ui/input';
import { JumpTo } from '~/components/ui/jump-to';
import { KpiTile } from '~/components/ui/kpi-tile';
import { CompactHeader } from '~/components/ui/page-header';
import { Pager } from '~/components/ui/pager';
import { Segmented } from '~/components/ui/segmented';
import { Tabs, tabId } from '~/components/ui/tabs';
import { useListUrlState } from '~/lib/use-list-url-state';
import { cn } from '~/lib/utils';
import type { InvoiceRow, InvoiceType } from '~/types/invoice';
import { AddInvoiceDialog } from './AddInvoiceDialog';
import { InvoiceDrawer } from './InvoiceDrawer';
import {
  DIRECTION,
  STATUS,
  TABS,
  counterpartyName,
  dueText,
  inTab,
  int,
  isTab,
  matchesSearch,
  money,
  shortDate,
  shownStatus,
  sortFor,
  summarise,
  type Tab,
} from './model';
import { useAssistantRecord } from '~/providers/AssistantProvider';

const PAGE_SIZE = 50;

type Direction = 'all' | InvoiceType;

export function InvoicesPage({
  invoices,
  today,
  currency: base,
}: {
  invoices: InvoiceRow[];
  today: string;
  /** The business's own currency: the only one the headline amounts add up. */
  currency: string;
}) {
  const revalidator = useRevalidator();
  const { sp, set, q, page, searchText, setSearchText } = useListUrlState();

  const rawTab = sp.get('tab');
  const tab: Tab = isTab(rawTab)
    ? rawTab
    : invoices.some(i => i.status === 'DRAFT')
      ? 'review'
      : 'open';
  const direction: Direction =
    sp.get('dir') === 'SALE' || sp.get('dir') === 'PURCHASE'
      ? (sp.get('dir') as InvoiceType)
      : 'all';
  const overdueOnly = sp.get('view') === 'overdue';
  const openId = sp.get('invoice');
  useAssistantRecord(
    openId
      ? {
          type: 'invoice',
          id: openId,
          label: invoices.find(i => i.id === openId)?.invoice_number ?? null,
        }
      : null
  );

  const summary = useMemo(() => summarise(invoices, today, base), [invoices, today, base]);
  const counts = useMemo(
    () => Object.fromEntries(TABS.map(t => [t.id, invoices.filter(i => inTab(i, t.id)).length])),
    [invoices]
  );

  const rows = useMemo(
    () =>
      invoices
        .filter(
          i =>
            inTab(i, tab) &&
            (direction === 'all' || i.invoice_type === direction) &&
            (!overdueOnly || shownStatus(i, today) === 'OVERDUE') &&
            matchesSearch(i, q)
        )
        .sort(sortFor(tab)),
    [invoices, tab, direction, overdueOnly, q, today]
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  // Adding invoices: from the button, or by dropping files anywhere on the page.
  const [adding, setAdding] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current += 1;
      setDragOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragOver(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragOver(false);
      // The dialog is open already (it handles its own drops): only the page behind it opens it.
      if ((e.target as HTMLElement | null)?.closest('[role="dialog"]')) return;
      setDropped(Array.from(e.dataTransfer?.files ?? []));
      setAdding(true);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const filtered = q !== '' || direction !== 'all' || overdueOnly;
  const otherCurrency =
    summary.otherCurrency > 0 ? ` · ${summary.otherCurrency} in other currencies not counted` : '';

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Invoices"
        title={
          <>
            What you owe, <em>and what you&rsquo;re owed.</em>
          </>
        }
        description="Add an invoice and it is read for you. Check it, finalise it, and mark it paid."
        actions={
          <Button
            onClick={() => {
              setDropped([]);
              setAdding(true);
            }}
          >
            <Plus size={16} weight="bold" aria-hidden /> Add invoice
          </Button>
        }
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Owed to you"
            tone="income"
            value={money(summary.owedToYou.amount, base, 0)}
            caption={
              summary.owedToYou.count === 0
                ? 'nothing outstanding'
                : `${int(summary.owedToYou.count)} unpaid${summary.owedToYou.overdueCount > 0 ? ` · ${money(summary.owedToYou.overdueAmount, base, 0)} late` : ''}`
            }
          />
          <KpiTile
            label="You owe"
            value={money(summary.youOwe.amount, base, 0)}
            caption={
              summary.youOwe.count === 0
                ? 'nothing outstanding'
                : `${int(summary.youOwe.count)} unpaid${summary.youOwe.overdueCount > 0 ? ` · ${money(summary.youOwe.overdueAmount, base, 0)} late` : ''}`
            }
          />
          <KpiTile
            label="Overdue"
            tone={summary.overdueCount > 0 ? 'negative' : 'default'}
            value={int(summary.overdueCount)}
            caption={
              summary.overdueCount === 0
                ? 'all on time'
                : `${money(summary.owedToYou.overdueAmount, base, 0)} to collect · ${money(summary.youOwe.overdueAmount, base, 0)} to pay`
            }
          />
          <KpiTile
            label="To review"
            value={int(summary.toReview)}
            caption={summary.toReview === 0 ? 'nothing waiting' : 'drafts not yet finalised'}
          />
        </div>
        {otherCurrency && (
          <p className="text-[13px] text-muted-foreground">
            Amounts count invoices in {base}
            {otherCurrency}.
          </p>
        )}

        <JumpTo
          items={[
            {
              key: 'overdue',
              count: summary.overdueCount,
              label: 'overdue',
              severe: true,
              onSelect: () => set({ tab: 'open', view: 'overdue', dir: null, q: null }),
            },
            {
              key: 'review',
              count: summary.toReview,
              label: 'to review',
              onSelect: () => set({ tab: 'review', view: null, dir: null, q: null }),
            },
          ]}
        />

        <Tabs
          tabs={TABS.map(t => ({ id: t.id, label: t.label, count: int(counts[t.id]) }))}
          value={tab}
          onChange={id => set({ tab: id, view: null })}
        />

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-[280px]">
            <MagnifyingGlass
              size={16}
              weight="light"
              aria-hidden
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              placeholder="Search name or number"
              aria-label="Search invoices"
              className="rounded-full pl-10"
            />
          </div>
          <Segmented<Direction>
            label="Direction"
            value={direction}
            onChange={v => set({ dir: v === 'all' ? null : v })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'SALE', label: 'Owed to you' },
              { value: 'PURCHASE', label: 'You owe' },
            ]}
          />
          {overdueOnly && <Chip tone="negative">Overdue only</Chip>}
          {filtered && (
            <button
              type="button"
              onClick={() => set({ q: null, dir: null, view: null })}
              className="inline-flex items-center gap-1 rounded-sm text-sm text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={12} aria-hidden /> Clear filters
            </button>
          )}
        </div>

        <div
          role="tabpanel"
          aria-labelledby={tabId(tab)}
          className="overflow-hidden rounded-2xl border bg-row"
        >
          {rows.length === 0 ? (
            <EmptyState
              title={
                filtered
                  ? 'Nothing matches.'
                  : tab === 'review'
                    ? 'Nothing to review.'
                    : tab === 'open'
                      ? 'Nothing is waiting for payment.'
                      : tab === 'paid'
                        ? 'No paid invoices yet.'
                        : 'No invoices yet.'
              }
              description={
                filtered
                  ? 'No invoices match these filters.'
                  : tab === 'review' || tab === 'all'
                    ? 'Add an invoice and it will be read for you.'
                    : undefined
              }
              action={
                filtered ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => set({ q: null, dir: null, view: null })}
                  >
                    Clear filters
                  </Button>
                ) : (
                  (tab === 'review' || tab === 'all') && (
                    <Button size="sm" onClick={() => setAdding(true)}>
                      <Plus size={14} weight="bold" aria-hidden /> Add invoice
                    </Button>
                  )
                )
              }
            />
          ) : (
            <DataTable label="Invoices" bare surface="page">
              <thead>
                <tr>
                  <th>Counterparty</th>
                  <th className="hidden md:table-cell">Direction</th>
                  <th className="hidden lg:table-cell">Issued</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(inv => {
                  const status = shownStatus(inv, today);
                  const due = dueText(inv, today);
                  const unpaid = ['OPEN', 'OVERDUE', 'PARTIALLY_PAID'].includes(inv.status);
                  const sale = inv.invoice_type === 'SALE';
                  return (
                    <tr
                      key={inv.id}
                      onClick={() => set({ invoice: inv.id })}
                      className={cn('cursor-pointer', inv.id === openId && '[&_td]:bg-accent')}
                    >
                      <td>
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            set({ invoice: inv.id });
                          }}
                          className="block max-w-[300px] rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="block truncate">{counterpartyName(inv)}</span>
                          <span className="block truncate font-mono text-xs text-text-2">
                            {inv.invoice_number}
                          </span>
                        </button>
                      </td>
                      <td className="hidden md:table-cell">
                        <span className="inline-flex items-center gap-1.5 text-[14px] text-text-2">
                          {sale ? (
                            <ArrowDown size={14} className="text-income" aria-hidden />
                          ) : (
                            <ArrowUp size={14} aria-hidden />
                          )}
                          {DIRECTION[inv.invoice_type].label}
                        </span>
                      </td>
                      <td className="hidden whitespace-nowrap text-text-2 lg:table-cell">
                        {shortDate(inv.invoice_date)}
                      </td>
                      <td className="whitespace-nowrap">
                        {unpaid && due ? (
                          <span
                            className={cn(
                              'text-[14px]',
                              due.overdue ? 'text-destructive' : 'text-text-2'
                            )}
                          >
                            {due.text}
                          </span>
                        ) : (
                          <span className="text-[14px] text-text-2">{shortDate(inv.due_date)}</span>
                        )}
                      </td>
                      <td>
                        <Chip tone={STATUS[status].tone} dot>
                          {STATUS[status].label}
                        </Chip>
                      </td>
                      <td
                        className={cn(
                          'whitespace-nowrap text-right tabular-nums',
                          sale && 'text-income'
                        )}
                      >
                        {sale ? '+' : '−'}
                        {money(inv.gross_amount, inv.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
          <Pager
            page={current}
            pageSize={PAGE_SIZE}
            total={rows.length}
            onPage={n => set({ page: n <= 1 ? null : String(n) })}
          />
        </div>
      </div>

      {dragOver && !adding && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-background/80 backdrop-blur-sm"
        >
          <div className="rounded-3xl border-2 border-dashed border-ring bg-card px-12 py-10 text-center">
            <p className="font-serif text-[28px]">Drop to add invoices</p>
            <p className="mt-1 text-text-2">PDFs or photos, up to 10 MB each</p>
          </div>
        </div>
      )}

      <AddInvoiceDialog
        open={adding}
        onOpenChange={setAdding}
        initialFiles={dropped}
        onUploaded={ids => {
          revalidator.revalidate();
          // The new draft is what to look at next.
          set({ tab: 'review', view: null, dir: null, q: null, invoice: ids[0] });
        }}
      />

      <InvoiceDrawer
        invoiceId={openId}
        today={today}
        onClose={() => set({ invoice: null })}
        onChanged={() => revalidator.revalidate()}
      />
    </div>
  );
}
