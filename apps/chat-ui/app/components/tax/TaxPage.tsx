/**
 * TaxPage
 *
 * Where the company stands with corporation tax, and what is left to do about it. Tax is worked
 * out per accounting period (never per calendar year); a period that is still open shows a
 * projection and says so wherever it appears. The page ends in the CT600 working paper, which is
 * a computation for review, not a filing.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useFetcher } from 'react-router';
import { toast } from 'sonner';
import { FileArrowDown, Trash } from 'phosphor-react';
import { Button, buttonVariants } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { Input } from '~/components/ui/input';
import { KpiTile } from '~/components/ui/kpi-tile';
import { Meter } from '~/components/ui/meter';
import { CompactHeader } from '~/components/ui/page-header';
import { Panel } from '~/components/ui/panel';
import { Segmented } from '~/components/ui/segmented';
import { Statement, type StatementRow } from '~/components/ui/statement';
import { Term } from '~/components/ui/term';
import type {
  TaxAdjustment,
  TaxData,
  TaxDeadline,
  TaxPeriod,
  TaxReviewItem,
} from '~/lib/api/tax.server';
import { useUrlParams } from '~/lib/use-url-params';
import { AdjustmentDrawer } from './AdjustmentDrawer';
import { BreakdownDrawer } from './BreakdownDrawer';
import { CompanyDrawer } from './CompanyDrawer';
import {
  CATEGORY_LABEL,
  deadlineTitle,
  defaultPeriod,
  longDate,
  money,
  nextDeadline,
  shortDate,
  unresolvedItems,
  whenText,
} from './model';

type ActionResult = { ok: boolean; error?: string; message?: string };

/** Submit a one-field action and toast the result. */
function useTaxAction() {
  const fetcher = useFetcher<ActionResult>();
  const handled = useRef<ActionResult | null>(null);
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok) toast.success(fetcher.data.message ?? 'Done');
    else toast.error(fetcher.data.error ?? 'That did not work');
  }, [fetcher.state, fetcher.data]);
  return {
    busy: fetcher.state !== 'idle',
    run: (fields: Record<string, string>) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      fetcher.submit(form, { method: 'POST' });
    },
  };
}

export function TaxPage({ data }: { data: TaxData }) {
  const [sp, apply] = useUrlParams();
  const set = (patch: Record<string, string | null>) =>
    apply(p => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) p.delete(k);
        else p.set(k, v);
      }
      return p;
    });

  const requested = sp.get('period');
  const selected =
    data.periods.find(p => p.periodId === requested) ?? defaultPeriod(data) ?? undefined;
  const adjust = sp.get('adjust'); // '1' or an account number
  const unresolved = unresolvedItems(data);
  const periodReview = unresolved.filter(r => r.periodId === selected?.periodId);
  const adjustItem: TaxReviewItem | null =
    adjust && adjust !== '1' ? (periodReview.find(r => r.accountNumber === adjust) ?? null) : null;
  const next = nextDeadline(data.deadlines);
  const last = data.lastClosedPeriod;
  const current = data.currentPeriod;

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Tax"
        title={
          <>
            What you owe, <em>and when.</em>
          </>
        }
        description={`UK corporation tax for ${data.entity.name}${data.entity.yearEndLabel ? `, year end ${data.entity.yearEndLabel}` : ''}. Worked out per accounting period.`}
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Last completed period"
            value={last ? money(last.taxDue ?? 0, 0) : 'None yet'}
            caption={
              last ? `${last.label}, due ${shortDate(last.paymentDue)}` : 'Nothing to compute'
            }
          />
          <KpiTile
            label="This year so far"
            value={current ? money(current.taxDue ?? 0, 0) : 'None'}
            caption={
              current
                ? `projection, ${current.monthsElapsed.toFixed(0)} of ${current.monthsInPeriod} months`
                : 'No open period'
            }
          />
          <KpiTile
            label="Next deadline"
            tone={next?.status === 'overdue' ? 'negative' : 'default'}
            value={next ? shortDate(next.dueDate) : 'All clear'}
            caption={
              next
                ? `${next.kind === 'payment' ? 'Pay' : 'File'} ${whenText(next.daysRemaining)}`
                : 'Nothing outstanding'
            }
          />
          <KpiTile
            label="Needs your judgement"
            tone={unresolved.length > 0 ? 'negative' : 'default'}
            value={String(unresolved.length)}
            caption={
              unresolved.length === 0
                ? 'nothing to review'
                : unresolved.length === 1
                  ? 'item to review'
                  : 'items to review'
            }
          />
        </div>

        <DeadlinesPanel deadlines={data.deadlines} />

        {data.periods.length > 0 && selected && (
          <Panel
            title="Tax computation"
            testId="tax-computation"
            note={
              selected.isProjection
                ? `This period is still open, ${selected.monthsElapsed.toFixed(0)} of ${selected.monthsInPeriod} months. Every figure below is a projection, not a liability.`
                : selected.ledgerBasis
                  ? 'From posted journals, with adjustments applied.'
                  : undefined
            }
          >
            <div className="mb-5">
              <Segmented
                label="Accounting period"
                value={selected.periodId}
                onChange={id => set({ period: id, adjust: null, breakdown: null })}
                options={data.periods.map(p => ({
                  value: p.periodId,
                  label: p.status === 'open' ? `${p.label} (open)` : p.label,
                }))}
              />
            </div>
            <Computation
              period={selected}
              adjustments={data.adjustmentsByPeriod[selected.periodId] ?? []}
              onBreakdown={() => set({ breakdown: '1' })}
              onAdjust={() => set({ adjust: '1' })}
            />
          </Panel>
        )}

        {periodReview.length > 0 && selected && (
          <Panel
            title="Needs your judgement"
            testId="tax-review"
            note="These sit in accounts that often hold spending tax does not allow. Nothing is added back automatically, because the split depends on facts the ledger does not record."
          >
            <ul className="divide-y rounded-xl border">
              {periodReview.map(item => (
                <li
                  key={`${item.periodId}-${item.accountNumber}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1 basis-64">
                    <div className="flex items-baseline justify-between gap-3 text-[15px]">
                      <span>
                        <span className="font-mono text-xs text-text-2">{item.accountNumber}</span>{' '}
                        {item.accountName}
                      </span>
                      <span className="tabular-nums">{money(item.amount)}</span>
                    </div>
                    <p className="mt-1 text-[13px] text-text-2">{item.guidance}</p>
                  </div>
                  {selected.status !== 'filed' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => set({ adjust: item.accountNumber })}
                      aria-label={`Record an adjustment for ${item.accountName}`}
                    >
                      Record an adjustment
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <VatPanel vat={data.vat} />
          <LoanPanel loan={data.directorsLoan} />
          <ProvisionPanel provision={data.provision} />
        </div>

        <Ct600Panel data={data} period={selected} onCompany={() => set({ company: '1' })} />
      </div>

      <AdjustmentDrawer
        period={selected}
        item={adjustItem}
        open={!!adjust}
        onClose={() => set({ adjust: null })}
      />
      <CompanyDrawer
        entity={data.entity}
        open={sp.get('company') === '1'}
        onClose={() => set({ company: null })}
      />
      <BreakdownDrawer
        period={selected}
        lines={selected ? (data.profitBreakdownByPeriod[selected.periodId] ?? []) : []}
        open={sp.get('breakdown') === '1'}
        onClose={() => set({ breakdown: null })}
      />
    </div>
  );
}

// ─── Deadlines ────────────────────────────────────────────────────────

const STATUS: Record<
  TaxDeadline['status'],
  { tone: 'negative' | 'active' | 'plain' | 'done'; text: string }
> = {
  overdue: { tone: 'negative', text: 'Not recorded' },
  due_soon: { tone: 'active', text: 'Due soon' },
  upcoming: { tone: 'plain', text: 'Upcoming' },
  satisfied: { tone: 'done', text: 'Done' },
};

function DeadlinesPanel({ deadlines }: { deadlines: TaxDeadline[] }) {
  const overdue = deadlines.filter(d => d.status === 'overdue').length;
  return (
    <Panel
      title="Deadlines"
      testId="tax-deadlines"
      note={
        overdue > 0
          ? 'A past date means this app holds no record of it being done. It cannot see HMRC. If your accountant already filed, mark the period as filed below.'
          : undefined
      }
    >
      {deadlines.length === 0 ? (
        <p className="text-[15px] text-text-2">No deadlines yet.</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {deadlines.map(d => (
            <li
              key={`${d.label}-${d.kind}`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="text-[15px]">{deadlineTitle(d)}</div>
                <div className="text-[13px] text-text-2">
                  {longDate(d.dueDate)}
                  {d.status !== 'satisfied' && `, ${whenText(d.daysRemaining)}`}
                  {d.amount !== null && d.kind === 'payment' && `, ${money(d.amount)}`}
                </div>
              </div>
              <Chip tone={STATUS[d.status].tone} dot>
                {STATUS[d.status].text}
              </Chip>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ─── Computation ──────────────────────────────────────────────────────

function Computation({
  period,
  adjustments,
  onBreakdown,
  onAdjust,
}: {
  period: TaxPeriod;
  adjustments: TaxAdjustment[];
  onBreakdown: () => void;
  onAdjust: () => void;
}) {
  if (!period.ledgerBasis) {
    return (
      <div className="space-y-2 text-[15px]">
        <p>{period.label} predates reliable bookkeeping in this app, so it is not restated here.</p>
        <p className="text-text-2">
          Its figures live in the accounts filed at Companies House and your accountant&apos;s
          records.
          {period.filedNetAssets !== null &&
            ` Net assets as filed: ${money(period.filedNetAssets)}.`}
        </p>
        {period.notes && <p className="text-[13px] text-text-2">{period.notes}</p>}
      </div>
    );
  }

  const num = (v: number | null) => v ?? 0;
  const rows: StatementRow[] = [
    {
      kind: 'line',
      label: 'Profit per the accounts',
      amount: num(period.accountingProfit),
      onSelect: onBreakdown,
      selectLabel: 'Profit per the accounts, see the accounts behind it',
    },
    {
      kind: 'line',
      label: (
        <Term definition="Spending the accounts deducted that tax does not allow, such as entertainment. It raises taxable profit.">
          Add backs
        </Term>
      ),
      amount: num(period.addBacks),
    },
    {
      kind: 'line',
      label: (
        <Term definition="Reliefs and allowances tax gives that the accounts do not show, such as capital allowances.">
          Deductions
        </Term>
      ),
      amount: num(period.deductions),
      deduct: true,
    },
    {
      kind: 'total',
      label: (
        <Term definition="Profit per the accounts, plus add backs, less deductions.">
          Adjusted profit
        </Term>
      ),
      amount: num(period.adjustedProfit),
    },
  ];
  if (num(period.lossBroughtForward) > 0 || num(period.lossReliefUsed) > 0) {
    rows.push({
      kind: 'line',
      label: (
        <Term definition="A trading loss from an earlier period, set against this period's profit.">
          Losses used
        </Term>
      ),
      amount: num(period.lossReliefUsed),
      deduct: true,
    });
  }
  rows.push({
    kind: 'total',
    label: <Term definition="The profit corporation tax is charged on.">Taxable profit</Term>,
    amount: num(period.taxableProfit),
  });
  if (num(period.marginalRelief) > 0) {
    rows.push({
      kind: 'line',
      label: (
        <Term definition="Between £50,000 and £250,000 of profit the rate rises gradually from 19% to 25%. This is the relief that smooths it.">
          Marginal relief
        </Term>
      ),
      amount: num(period.marginalRelief),
      deduct: true,
    });
  }
  rows.push({
    kind: 'grand',
    label: period.isProjection ? 'Projected corporation tax' : 'Corporation tax due',
    amount: num(period.taxDue),
  });

  return (
    <div className="space-y-6">
      <Statement rows={rows} currency="GBP" />
      <p className="text-[13px] text-text-2">
        Effective rate{' '}
        <span className="tabular-nums">
          {period.effectiveRate !== null ? `${(period.effectiveRate * 100).toFixed(1)}%` : 'n/a'}
        </span>
        . Payment due {longDate(period.paymentDue)}, return due {longDate(period.filingDue)}.
      </p>

      <Adjustments period={period} adjustments={adjustments} onAdd={onAdjust} />
      <FilingStatus period={period} />
    </div>
  );
}

function Adjustments({
  period,
  adjustments,
  onAdd,
}: {
  period: TaxPeriod;
  adjustments: TaxAdjustment[];
  onAdd: () => void;
}) {
  const action = useTaxAction();
  const editable = period.status !== 'filed';
  return (
    <section aria-label="Adjustments" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="eyebrow">Adjustments</h3>
        {editable && (
          <Button variant="outline" size="sm" onClick={onAdd}>
            Add adjustment
          </Button>
        )}
      </div>
      {adjustments.length === 0 ? (
        <p className="text-[14px] text-text-2">None recorded for this period.</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {adjustments.map(a => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-[15px]">{a.description}</div>
                <div className="text-[13px] text-text-2">
                  {a.direction === 'add_back' ? 'Add back' : 'Deduction'},{' '}
                  {CATEGORY_LABEL[a.category] ?? a.category}
                  {a.source === 'auto' && ', worked out from the ledger'}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="tabular-nums">{money(a.amount)}</span>
                {a.source === 'manual' && editable && (
                  <button
                    type="button"
                    disabled={action.busy}
                    onClick={() => action.run({ intent: 'deleteAdjustment', adjustmentId: a.id })}
                    aria-label={`Remove adjustment: ${a.description}`}
                    className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash size={15} weight="light" aria-hidden />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FilingStatus({ period }: { period: TaxPeriod }) {
  const action = useTaxAction();
  const [filedOn, setFiledOn] = useState(new Date().toISOString().slice(0, 10));
  if (period.status === 'open') return null;
  return (
    <section
      aria-label="Filing"
      className="flex flex-wrap items-end justify-between gap-3 rounded-xl border bg-background px-4 py-3.5"
    >
      {period.status === 'filed' ? (
        <>
          <div>
            <Chip tone="done" dot>
              Marked as filed
            </Chip>
            <p className="mt-1.5 text-[13px] text-text-2">
              Its figures are locked. Put it back to change an adjustment.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={action.busy}
            onClick={() => action.run({ intent: 'reopen', periodId: period.periodId })}
          >
            Put back to open for edits
          </Button>
        </>
      ) : (
        <>
          <div className="text-[14px] text-text-2">
            Already filed with HMRC? Record it so the deadline stops flagging.
          </div>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="eyebrow">Filed on</span>
              <Input
                type="date"
                value={filedOn}
                min={period.endDate}
                onChange={e => setFiledOn(e.target.value)}
                className="h-9 w-40"
              />
            </label>
            <Button
              size="sm"
              disabled={action.busy}
              onClick={() =>
                action.run({ intent: 'markFiled', periodId: period.periodId, filedOn })
              }
            >
              Mark as filed
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// ─── Monitors ─────────────────────────────────────────────────────────

function VatPanel({ vat }: { vat: TaxData['vat'] }) {
  const pct = vat.percentOfThreshold;
  return (
    <Panel title="VAT registration" testId="tax-vat">
      <div className="font-serif text-[28px] tabular-nums">{money(vat.rollingTurnover, 0)}</div>
      <p className="mt-1 text-[13px] text-text-2">
        <Term definition="Sales over the last 12 months, checked every month. Registering becomes compulsory when it passes the threshold, not at year end.">
          rolling 12-month turnover
        </Term>
        , {pct.toFixed(0)}% of the {money(vat.threshold, 0)} threshold
      </p>
      <Meter
        className="mt-3"
        value={pct / 100}
        over={pct > 85}
        label={`${pct.toFixed(0)}% of the VAT threshold`}
      />
      <p className="mt-2 text-[13px] text-text-2">
        {vat.registered
          ? 'Registered for VAT.'
          : `${money(vat.headroom, 0)} of headroom before registration is compulsory.`}
      </p>
    </Panel>
  );
}

function LoanPanel({ loan }: { loan: TaxData['directorsLoan'] }) {
  return (
    <Panel title="Director's loan" testId="tax-loan">
      <div className="font-serif text-[28px] tabular-nums">{money(Math.abs(loan.balance), 0)}</div>
      <p className="mt-1 text-[13px] text-text-2">
        {loan.balance === 0
          ? 'no balance either way'
          : loan.overdrawn
            ? 'owed by you to the company'
            : 'owed by the company to you'}
      </p>
      <p className="mt-3 text-[13px]">
        {loan.overdrawn ? (
          <>
            <Term definition="A charge on a director's loan still owed 9 months and 1 day after the period ends. Repaying in time avoids it.">
              Section 455 charge
            </Term>{' '}
            of <span className="tabular-nums">{money(loan.s455Charge)}</span> (33.75%) if not repaid
            in time.
          </>
        ) : (
          <span className="text-text-2">In credit or clear, so no charge arises.</span>
        )}
      </p>
    </Panel>
  );
}

function ProvisionPanel({ provision }: { provision: TaxData['provision'] }) {
  return (
    <Panel title="Tax provision" testId="tax-provision">
      <div className="font-serif text-[28px] tabular-nums">
        {money(provision.accruedLiability, 0)}
      </div>
      <p className="mt-1 text-[13px] text-text-2">
        <Term definition="Tax owed but not yet paid, held as a liability on the balance sheet.">
          accrued on the balance sheet
        </Term>
      </p>
      <dl className="mt-3 space-y-1 text-[14px]">
        <div className="flex justify-between gap-3">
          <dt className="text-text-2">Recorded as paid</dt>
          <dd className="tabular-nums">{money(provision.taxRecordedAsPaid)}</dd>
        </div>
        {provision.unprovided === null ? (
          <p className="pt-1.5 text-[13px] text-text-2">
            No completed period can be computed, so there is nothing to compare paid tax against.
          </p>
        ) : (
          <>
            <div className="flex justify-between gap-3">
              <dt className="text-text-2">Tax on completed periods</dt>
              <dd className="tabular-nums">{money(provision.taxOnClosedPeriods)}</dd>
            </div>
            {Math.abs(provision.unprovided) > 0.5 && (
              <div className="flex justify-between gap-3 border-t pt-1">
                <dt>Unprovided</dt>
                <dd className="tabular-nums">{money(provision.unprovided)}</dd>
              </div>
            )}
          </>
        )}
      </dl>
    </Panel>
  );
}

// ─── CT600 ────────────────────────────────────────────────────────────

function Ct600Panel({
  data,
  period,
  onCompany,
}: {
  data: TaxData;
  period: TaxPeriod | undefined;
  onCompany: () => void;
}) {
  const missing = data.entity.missingForFiling;
  return (
    <Panel
      title="CT600 working paper"
      testId="tax-ct600"
      note="Every figure of the computation mapped to its CT600 box number, ready to hand to your accountant or type in. It is a working paper, not a filing: submitting needs HMRC-recognised software and tagged accounts."
      action={
        <Button variant="outline" size="sm" onClick={onCompany}>
          Company details
        </Button>
      }
    >
      {missing.length > 0 && (
        <div className="mb-4 rounded-xl border bg-background px-4 py-3">
          <p className="text-[14px] font-medium">Still needed before the pack is complete</p>
          <ul className="mt-1 text-[14px] text-text-2">
            {missing.map(m => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {period?.ledgerBasis ? (
        <a
          href={`/api/tax/ct600-pack?periodId=${period.periodId}`}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: 'default' })}
        >
          <FileArrowDown size={16} weight="light" aria-hidden /> Generate for {period.label}
        </a>
      ) : (
        <p className="text-[14px] text-text-2">
          Choose a period with figures computed from the ledger to generate its working paper.
        </p>
      )}
      <p className="mt-3 text-[13px] text-text-2">
        Have your accountant check the figures, particularly any judgement calls above.{' '}
        <Link to="/reports?tab=pnl" className="underline underline-offset-4 hover:text-accent-text">
          See the full profit and loss
        </Link>
        .
      </p>
    </Panel>
  );
}
