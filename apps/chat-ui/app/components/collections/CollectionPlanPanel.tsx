import React, { useEffect, useRef, useState } from 'react';
import { useFetcher, useRevalidator } from 'react-router';
import {
  ChartBar,
  ChartLineUp,
  ClipboardText,
  Coins,
  CurrencyGbp,
  FilePdf,
  Handshake,
  Plus,
  Receipt,
  Trash,
  TrendUp,
  Wallet,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { SearchableSelect } from '~/components/ui/searchable-select';
import { cn } from '~/lib/utils';
import {
  COLLABORATION_TYPES,
  CURRENCY_OPTIONS,
  PLAN_COST_CATEGORIES,
  collaborationTypeLabel,
  getCustomTerms,
  type CollectionPlanCost,
  type CollectionPlanLine,
  type CollectionPlanProjections,
  type CollectionPlanRecord,
} from '~/lib/collection-plans';
import type { FxRateResult } from '~/lib/api/collection-plans.server';

/** Shared shape of every plan-mutation action's return value (app.collections.tsx) —
 * lets fetcher.data be read without `any` across every form in this file. */
type PlanActionResult = { ok: boolean; error?: string; intent?: string; planId?: string };

interface PlanProductOption {
  id: string;
  name: string;
  provider: string | null;
  productType: string | null;
}

export interface CollectionPlanPanelData {
  plan: CollectionPlanRecord;
  lines: CollectionPlanLine[];
  costs: CollectionPlanCost[];
  projections: CollectionPlanProjections;
}

function formatMoney(value: number, currency = 'GBP') {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNum(value: number, digits = 0) {
  return new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** User-entered currency codes aren't validated against the real ISO 4217
 * list at save time, so Intl.NumberFormat can throw on a typo'd or
 * unsupported one — fall back to a plain "CODE amount" rather than crash
 * the whole panel over a formatting nicety. */
function formatMoneySafe(value: number, currency: string): string {
  try {
    return formatMoney(value, currency);
  } catch {
    return `${currency} ${formatNum(value, 2)}`;
  }
}

function formatFxAsOf(asOf: string): string {
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) return asOf;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function CollectionPlanPanel({
  collectionId,
  plan,
  productOptions,
  fxRate,
}: {
  collectionId: string;
  plan: CollectionPlanPanelData | null;
  productOptions: PlanProductOption[];
  fxRate: FxRateResult | null;
}) {
  if (!plan) {
    return <StartPlanningCard collectionId={collectionId} />;
  }

  return (
    <section className="rounded-3xl border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-border bg-linear-to-br from-card via-card to-violet-500/5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center text-violet-600">
            <ClipboardText size={20} />
          </div>
          <div>
            <h3 className="font-semibold text-foreground text-lg">Collection plan</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Project revenue and cost before launch, then compare against actuals once orders come
              in.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={`/api/collections/plan-pack?collection=${collectionId}&scenarios=1`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Adds an automatic Conservative/Base/Optimistic comparison to the printed plan"
          >
            <ChartBar size={14} />
            Compare scenarios
          </a>
          <a
            href={`/api/collections/plan-pack?collection=${collectionId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <FilePdf size={14} />
            Print plan
          </a>
        </div>
      </div>

      <div className="p-6 space-y-6">
        <PlanSummaryCards plan={plan} currency={plan.plan.currency} fxRate={fxRate} />

        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-6 items-start">
          <div className="space-y-6">
            <PlanLinesSection
              collectionId={collectionId}
              planId={plan.plan.id}
              lines={plan.lines}
              currency={plan.plan.currency}
              productOptions={productOptions}
            />
            <PlanCostsSection
              collectionId={collectionId}
              planId={plan.plan.id}
              costs={plan.costs}
              currency={plan.plan.currency}
            />
          </div>

          <PlanSettingsForm plan={plan.plan} collectionId={collectionId} />
        </div>
      </div>
    </section>
  );
}

function StartPlanningCard({ collectionId }: { collectionId: string }) {
  const fetcher = useFetcher<PlanActionResult>();
  const revalidator = useRevalidator();
  const lastState = useRef(fetcher.state);

  useEffect(() => {
    if (lastState.current !== 'idle' && fetcher.state === 'idle' && fetcher.data?.ok) {
      revalidator.revalidate();
    }
    lastState.current = fetcher.state;
  }, [fetcher.data, fetcher.state, revalidator]);

  return (
    <section className="rounded-3xl border border-dashed border-border bg-card p-8 text-center shadow-sm">
      <div className="mx-auto w-12 h-12 rounded-xl bg-violet-500/10 flex items-center justify-center text-violet-600 mb-4">
        <ClipboardText size={22} />
      </div>
      <h3 className="font-semibold text-foreground text-lg">No plan yet for this collection</h3>
      <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
        Start a plan to lay out product lines, unit costs, and other expected costs before launch —
        including the terms of a brand collaboration, if this collection has one.
      </p>
      <fetcher.Form method="post" className="mt-5">
        <input type="hidden" name="intent" value="create_plan" />
        <input type="hidden" name="collectionId" value={collectionId} />
        <Button type="submit" disabled={fetcher.state !== 'idle'}>
          <Plus size={16} />
          Start planning
        </Button>
      </fetcher.Form>
      {fetcher.data?.error && (
        <p className="text-xs text-destructive mt-3">{fetcher.data?.error}</p>
      )}
    </section>
  );
}

function PlanSummaryCards({
  plan,
  currency,
  fxRate,
}: {
  plan: CollectionPlanPanelData;
  currency: string;
  fxRate: FxRateResult | null;
}) {
  const p = plan.projections;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryStat
          label="Projected revenue"
          value={formatMoney(p.projectedRevenue, currency)}
          icon={<ChartLineUp size={16} weight="duotone" />}
        />
        <SummaryStat
          label="Projected cost"
          value={formatMoney(p.projectedTotalCost, currency)}
          helper={
            p.costsPendingCount > 0
              ? `${formatMoney(p.projectedProductCost, currency)} product + ${formatMoney(p.projectedOtherCost, currency)} other — plus ${p.costsPendingCount} cost${p.costsPendingCount === 1 ? '' : 's'} still TBD`
              : `${formatMoney(p.projectedProductCost, currency)} product + ${formatMoney(p.projectedOtherCost, currency)} other`
          }
          icon={<Receipt size={16} weight="duotone" />}
        />
        <SummaryStat
          label="Projected net profit"
          value={formatMoney(p.projectedNetProfit, currency)}
          icon={<TrendUp size={16} weight="duotone" />}
        />
        <SummaryStat
          label="Net margin"
          value={`${formatNum(p.projectedNetMarginPct, 1)}%`}
          helper={`Gross margin ${formatNum(p.projectedGrossMarginPct, 1)}%`}
          icon={<CurrencyGbp size={16} weight="duotone" />}
        />
      </div>

      {p.partnerPaymentDue && (
        <div
          className={cn(
            'rounded-xl border p-4 flex items-start gap-3',
            p.partnerPaymentDue.amount != null
              ? 'border-emerald-500/20 bg-emerald-500/5'
              : 'border-border bg-muted/20'
          )}
        >
          <Coins
            size={18}
            className={cn(
              'mt-0.5 shrink-0',
              p.partnerPaymentDue.amount != null ? 'text-emerald-600' : 'text-muted-foreground'
            )}
          />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              {plan.plan.partnerName || 'Partner'} needs to pay
            </p>
            {p.partnerPaymentDue.amount != null ? (
              <p className="text-2xl font-semibold text-foreground mt-1 tabular-nums">
                {formatMoney(p.partnerPaymentDue.amount, currency)}
                {fxRate && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    (≈{' '}
                    {formatMoneySafe(
                      p.partnerPaymentDue.amount * fxRate.rate,
                      fxRate.targetCurrency
                    )}
                    )
                  </span>
                )}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground mt-1">Nothing, right now</p>
            )}
            <p className="text-xs text-muted-foreground mt-1">{p.partnerPaymentDue.basis}</p>
          </div>
        </div>
      )}

      {p.entityUpfrontCost != null && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 flex items-start gap-3">
          <Wallet size={18} className="text-amber-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">Your upfront cash outlay</p>
            <p className="text-2xl font-semibold text-foreground mt-1 tabular-nums">
              {formatMoney(p.entityUpfrontCost, currency)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {p.entityUpfrontCost === p.projectedTotalCost
                ? "The full planned cost — their share isn't paid in upfront, so you're fronting all of it until revenue settles."
                : 'Your own cost-split share — the partner is covering theirs separately, upfront.'}
            </p>
          </div>
        </div>
      )}

      {p.payouts.length > 0 && (
        <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4 flex items-start gap-3">
          <Handshake size={18} className="text-violet-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              Who gets paid what ({collaborationTypeLabel(plan.plan.collaborationType)})
            </p>
            <div className="mt-2 space-y-1.5">
              {p.payouts.map((payout, index) => (
                <div
                  key={`${payout.party}-${index}`}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="text-foreground font-medium">{payout.party}</span>
                  <span className="flex-1 text-right text-xs text-muted-foreground">
                    {payout.basis}
                  </span>
                  <span className="tabular-nums font-semibold text-foreground shrink-0">
                    {formatMoney(payout.amount, currency)}
                    {payout.isPartner && fxRate && (
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        (≈ {formatMoneySafe(payout.amount * fxRate.rate, fxRate.targetCurrency)})
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {fxRate && (
              <p className="text-xs text-muted-foreground mt-2">
                Live rate 1 {fxRate.baseCurrency} = {formatNum(fxRate.rate, 4)}{' '}
                {fxRate.targetCurrency}, as of {formatFxAsOf(fxRate.asOf)} — indicative, not a
                settlement rate.
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Estimates from the split/terms below — not a full settlement calculation.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  helper,
  icon,
}: {
  label: string;
  value: string;
  helper?: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <p className="text-xl font-semibold text-foreground mt-2 tabular-nums">{value}</p>
      {helper && <p className="text-xs text-muted-foreground mt-1">{helper}</p>}
    </div>
  );
}

function PlanSettingsForm({
  plan,
  collectionId,
}: {
  plan: CollectionPlanRecord;
  collectionId: string;
}) {
  const fetcher = useFetcher<PlanActionResult>();
  const revalidator = useRevalidator();
  const lastState = useRef(fetcher.state);

  const [collaborationType, setCollaborationType] = useState(plan.collaborationType);
  const [partnerName, setPartnerName] = useState(plan.partnerName || '');
  const [currency, setCurrency] = useState(plan.currency || 'GBP');
  const [partnerCurrency, setPartnerCurrency] = useState(plan.partnerCurrency || '');
  const [notes, setNotes] = useState(plan.notes || '');
  // custom_terms is handled separately below (customTerms state) — it's an
  // array, not a string, so it's excluded here rather than mangled by the
  // String(v) coercion every other metadata field goes through.
  const [metadata, setMetadata] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(plan.metadata || {})
        .filter(([k]) => k !== 'custom_terms')
        .map(([k, v]) => [k, String(v)])
    )
  );
  const [customTerms, setCustomTerms] = useState<{ id: string; label: string; value: string }[]>(
    () =>
      getCustomTerms(plan.metadata).map(term => ({
        id: crypto.randomUUID(),
        label: term.label,
        value: term.value,
      }))
  );
  // co_branded only — a real boolean, so (like custom_terms) it's kept out
  // of the generic string-keyed metadata state below. Defaults true to
  // match computePlanProjections' "missing means paid upfront" fallback.
  const [costsPaidUpfront, setCostsPaidUpfront] = useState(
    plan.metadata?.costs_paid_upfront !== false
  );

  useEffect(() => {
    if (lastState.current !== 'idle' && fetcher.state === 'idle' && fetcher.data?.ok) {
      revalidator.revalidate();
    }
    lastState.current = fetcher.state;
  }, [fetcher.data, fetcher.state, revalidator]);

  const setField = (key: string, value: string) => {
    setMetadata(prev => ({ ...prev, [key]: value }));
  };

  // Numeric fields are coerced to numbers before submit; blank optional
  // fields are dropped rather than submitted as "".
  const buildMetadataPayload = (): Record<string, unknown> => {
    const numeric = (key: string) => {
      const raw = metadata[key];
      if (raw === undefined || raw === '') return undefined;
      const num = Number(raw);
      return Number.isFinite(num) ? num : undefined;
    };
    const text = (key: string) => {
      const raw = metadata[key];
      return raw ? raw : undefined;
    };

    const typeFields: Record<string, unknown> = (() => {
      switch (collaborationType) {
        case 'wholesale':
          return {
            minimum_order_quantity: numeric('minimum_order_quantity'),
            payment_terms: text('payment_terms'),
            purchase_order_reference: text('purchase_order_reference'),
          };
        case 'co_branded':
          return {
            cost_split_pct: numeric('cost_split_pct'),
            revenue_split_pct: numeric('revenue_split_pct'),
            co_brand_credit_notes: text('co_brand_credit_notes'),
            marketing_commitment_notes: text('marketing_commitment_notes'),
            costs_paid_upfront: costsPaidUpfront,
          };
        case 'revenue_share':
          return {
            revenue_share_pct: numeric('revenue_share_pct'),
            minimum_guarantee_amount: numeric('minimum_guarantee_amount'),
            reporting_cadence: text('reporting_cadence'),
          };
        case 'pop_up':
          return {
            venue_cost_amount: numeric('venue_cost_amount'),
            venue_cost_period: text('venue_cost_period') || 'flat',
            duration_days: numeric('duration_days'),
            staffing_cost_amount: numeric('staffing_cost_amount'),
            fixtures_cost_amount: numeric('fixtures_cost_amount'),
            expected_foot_traffic: numeric('expected_foot_traffic'),
          };
        default:
          return {};
      }
    })();

    // Available for every collaboration type (not just co_branded) — a
    // deal often has terms specific to it that no fixed field anticipates.
    const cleanedCustomTerms = customTerms
      .map(t => ({ label: t.label.trim(), value: t.value.trim() }))
      .filter(t => t.label !== '');
    if (cleanedCustomTerms.length > 0) {
      typeFields.custom_terms = cleanedCustomTerms;
    }

    return typeFields;
  };

  return (
    <fetcher.Form
      method="post"
      className="rounded-2xl border border-border bg-card p-5 space-y-4 shadow-sm lg:sticky lg:top-6"
    >
      <input type="hidden" name="intent" value="update_plan" />
      <input type="hidden" name="collectionId" value={collectionId} />
      <input type="hidden" name="planId" value={plan.id} />
      <input type="hidden" name="metadata" value={JSON.stringify(buildMetadataPayload())} />

      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-violet-500/10 flex items-center justify-center text-violet-600">
          <Handshake size={18} />
        </div>
        <div>
          <h4 className="font-semibold text-foreground">Collaboration & terms</h4>
          <p className="text-xs text-muted-foreground">Changes what fields matter for this plan.</p>
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Collaboration type</label>
        <select
          name="collaborationType"
          value={collaborationType}
          onChange={event => setCollaborationType(event.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {COLLABORATION_TYPES.map(type => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </div>

      {collaborationType !== 'in_house' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground">Partner name</label>
          <input
            type="text"
            name="partnerName"
            value={partnerName}
            onChange={event => setPartnerName(event.target.value)}
            placeholder="Brand or venue name"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      )}

      <div className={cn('grid gap-3', collaborationType !== 'in_house' ? 'grid-cols-2' : '')}>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Currency</label>
          <input
            type="text"
            name="currency"
            value={currency}
            onChange={event => setCurrency(event.target.value.toUpperCase())}
            maxLength={3}
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 uppercase"
          />
        </div>
        {collaborationType !== 'in_house' && (
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Partner&apos;s currency (optional)
            </label>
            <input type="hidden" name="partnerCurrency" value={partnerCurrency} />
            <SearchableSelect
              options={CURRENCY_OPTIONS}
              value={partnerCurrency}
              onChange={setPartnerCurrency}
              emptyOption="None — same as currency above"
              placeholder="Search currency…"
              className="mt-1 w-full px-3 py-2"
            />
          </div>
        )}
      </div>
      {collaborationType !== 'in_house' && partnerCurrency && (
        <p className="text-xs text-muted-foreground -mt-2">
          Their payout will also show a live-converted estimate in {partnerCurrency}.
        </p>
      )}

      <CollaborationFields
        collaborationType={collaborationType}
        metadata={metadata}
        setField={setField}
        costsPaidUpfront={costsPaidUpfront}
        setCostsPaidUpfront={setCostsPaidUpfront}
      />

      {collaborationType !== 'in_house' && (
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              Additional terms (optional)
            </label>
            <button
              type="button"
              onClick={() =>
                setCustomTerms(prev => [...prev, { id: crypto.randomUUID(), label: '', value: '' }])
              }
              className="text-xs font-medium text-primary hover:underline"
            >
              + Add term
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Anything specific to this deal that doesn&rsquo;t fit the fields above.
          </p>
          <div className="mt-2 space-y-2">
            {customTerms.map(term => (
              <div key={term.id} className="flex items-start gap-2">
                <input
                  type="text"
                  value={term.label}
                  onChange={event =>
                    setCustomTerms(prev =>
                      prev.map(t => (t.id === term.id ? { ...t, label: event.target.value } : t))
                    )
                  }
                  placeholder="Term, e.g. Exclusivity"
                  className="w-2/5 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <input
                  type="text"
                  value={term.value}
                  onChange={event =>
                    setCustomTerms(prev =>
                      prev.map(t => (t.id === term.id ? { ...t, value: event.target.value } : t))
                    )
                  }
                  placeholder="Detail, e.g. UK & Ireland only"
                  className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  type="button"
                  onClick={() => setCustomTerms(prev => prev.filter(t => t.id !== term.id))}
                  className="mt-2 text-muted-foreground hover:text-destructive transition-colors shrink-0"
                  title="Remove term"
                >
                  <Trash size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="text-xs font-medium text-muted-foreground">Notes</label>
        <textarea
          name="notes"
          value={notes}
          onChange={event => setNotes(event.target.value)}
          rows={3}
          placeholder="Anything else worth recording about this plan"
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none"
        />
      </div>

      <Button type="submit" disabled={fetcher.state !== 'idle'} className="w-full">
        Save plan details
      </Button>

      {fetcher.data?.error && <p className="text-xs text-destructive">{fetcher.data?.error}</p>}
    </fetcher.Form>
  );
}

function CollaborationFields({
  collaborationType,
  metadata,
  setField,
  costsPaidUpfront,
  setCostsPaidUpfront,
}: {
  collaborationType: string;
  metadata: Record<string, string>;
  setField: (key: string, value: string) => void;
  costsPaidUpfront: boolean;
  setCostsPaidUpfront: (value: boolean) => void;
}) {
  const field = (
    key: string,
    label: string,
    opts: { placeholder?: string; type?: string } = {}
  ) => (
    <div key={key}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type={opts.type || 'text'}
        value={metadata[key] ?? ''}
        onChange={event => setField(key, event.target.value)}
        placeholder={opts.placeholder}
        className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
    </div>
  );

  if (collaborationType === 'wholesale') {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-background/60 p-3">
        {field('minimum_order_quantity', 'Minimum order quantity', { type: 'number' })}
        {field('payment_terms', 'Payment terms', {
          placeholder: 'e.g. 50% deposit, 50% on delivery',
        })}
        {field('purchase_order_reference', 'Purchase order reference')}
      </div>
    );
  }

  if (collaborationType === 'co_branded') {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-background/60 p-3">
        <div className="grid grid-cols-2 gap-3">
          {field('revenue_split_pct', 'Your revenue split %', { type: 'number' })}
          {field('cost_split_pct', 'Your cost split %', { type: 'number' })}
        </div>
        <label className="flex items-start gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={costsPaidUpfront}
            onChange={event => setCostsPaidUpfront(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Partner pays their cost share upfront
            <span className="block text-muted-foreground mt-0.5">
              {costsPaidUpfront
                ? 'They contribute cash before launch, independent of sales.'
                : 'Unchecked: their share is deducted from their revenue split instead — you front the full planned cost yourself.'}
            </span>
          </span>
        </label>
        {field('co_brand_credit_notes', 'Co-brand credit', {
          placeholder: 'e.g. 50/50 branding on packaging',
        })}
        {field('marketing_commitment_notes', 'Marketing commitments')}
      </div>
    );
  }

  if (collaborationType === 'revenue_share') {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-background/60 p-3">
        {field('revenue_share_pct', 'Revenue share paid to partner %', { type: 'number' })}
        {field('minimum_guarantee_amount', 'Minimum guarantee amount', { type: 'number' })}
        {field('reporting_cadence', 'Reporting cadence', { placeholder: 'e.g. monthly' })}
      </div>
    );
  }

  if (collaborationType === 'pop_up') {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-background/60 p-3">
        <div className="grid grid-cols-2 gap-3">
          {field('venue_cost_amount', 'Venue cost', { type: 'number' })}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Venue cost period</label>
            <select
              value={metadata.venue_cost_period ?? 'flat'}
              onChange={event => setField('venue_cost_period', event.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="flat">Flat fee</option>
              <option value="per_day">Per day</option>
              <option value="per_week">Per week</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {field('duration_days', 'Duration (days)', { type: 'number' })}
          {field('expected_foot_traffic', 'Expected foot traffic', { type: 'number' })}
        </div>
        {field('staffing_cost_amount', 'Staffing cost', { type: 'number' })}
        {field('fixtures_cost_amount', 'Fixtures / fit-out cost', { type: 'number' })}
      </div>
    );
  }

  return null;
}

function PlanLinesSection({
  collectionId,
  planId,
  lines,
  currency,
  productOptions,
}: {
  collectionId: string;
  planId: string;
  lines: CollectionPlanLine[];
  currency: string;
  productOptions: PlanProductOption[];
}) {
  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm">
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
        <div>
          <h4 className="font-semibold text-foreground">Product lines</h4>
          <p className="text-xs text-muted-foreground">
            Planned quantity, unit cost, and selling price per line.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{lines.length} rows</span>
      </div>

      {lines.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground text-sm">
          No product lines yet. Add one below.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Product</th>
                <th className="px-3 py-3 font-medium text-right">Qty</th>
                <th className="px-3 py-3 font-medium text-right">Gifted</th>
                <th className="px-3 py-3 font-medium text-right">Unit cost</th>
                <th className="px-3 py-3 font-medium text-right">Sell price</th>
                <th className="px-3 py-3 font-medium text-right">Sell-through</th>
                <th className="px-3 py-3 font-medium text-right">Proj. revenue</th>
                <th className="px-3 py-3 font-medium text-right">Proj. COGS</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {lines.map(line => {
                const sellThrough = Math.max(0, Math.min(100, line.expectedSellThroughPct)) / 100;
                const giftedUnits = Math.max(0, Math.min(line.plannedQuantity, line.giftedUnits));
                const sellableUnits = line.plannedQuantity - giftedUnits;
                const projRevenue = sellableUnits * sellThrough * line.unitSellingPrice;
                const projCogs = line.plannedQuantity * line.unitCost;
                return (
                  <tr key={line.id} className="border-t border-border/60 hover:bg-muted/20">
                    <td className="px-5 py-3 font-medium text-foreground">
                      {line.linkedProductName || line.productName || 'Unnamed product'}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                      {formatNum(line.plannedQuantity)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                      {giftedUnits > 0 ? formatNum(giftedUnits) : '—'}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                      {formatMoney(line.unitCost, currency)}
                      {line.unitCostCurrency && line.unitCostOriginal != null && (
                        <span className="block text-xs text-muted-foreground/70">
                          (≈ {formatMoneySafe(line.unitCostOriginal, line.unitCostCurrency)})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                      {formatMoney(line.unitSellingPrice, currency)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
                      {formatNum(line.expectedSellThroughPct, 0)}%
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-foreground font-medium">
                      {formatMoney(projRevenue, currency)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-foreground font-medium">
                      {formatMoney(projCogs, currency)}
                    </td>
                    <td className="px-4 py-3">
                      <RemovePlanLineButton collectionId={collectionId} lineId={line.id} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AddPlanLineForm
        collectionId={collectionId}
        planId={planId}
        productOptions={productOptions}
        planCurrency={currency}
      />
    </section>
  );
}

function AddPlanLineForm({
  collectionId,
  planId,
  productOptions,
  planCurrency,
}: {
  collectionId: string;
  planId: string;
  productOptions: PlanProductOption[];
  planCurrency: string;
}) {
  const fetcher = useFetcher<PlanActionResult>();
  const revalidator = useRevalidator();
  const lastState = useRef(fetcher.state);
  const [mode, setMode] = useState<'existing' | 'new'>(
    productOptions.length > 0 ? 'existing' : 'new'
  );
  const [productId, setProductId] = useState('');
  const [productName, setProductName] = useState('');
  const [plannedQuantity, setPlannedQuantity] = useState('');
  const [giftedUnits, setGiftedUnits] = useState('');
  const [unitCost, setUnitCost] = useState('');
  // Defaults to USD rather than the plan's own currency — most suppliers
  // here are quoted in USD, so this makes the common case zero extra
  // clicks; picking the plan's own currency (or anything else) just means
  // no conversion happens.
  const [unitCostCurrency, setUnitCostCurrency] = useState('USD');
  const [unitSellingPrice, setUnitSellingPrice] = useState('');
  const [sellThrough, setSellThrough] = useState('100');

  useEffect(() => {
    if (lastState.current !== 'idle' && fetcher.state === 'idle' && fetcher.data?.ok) {
      revalidator.revalidate();
      setProductId('');
      setProductName('');
      setPlannedQuantity('');
      setGiftedUnits('');
      setUnitCost('');
      setUnitCostCurrency('USD');
      setUnitSellingPrice('');
      setSellThrough('100');
    }
    lastState.current = fetcher.state;
  }, [fetcher.data, fetcher.state, revalidator]);

  return (
    <fetcher.Form method="post" className="border-t border-border p-5 space-y-3">
      <input type="hidden" name="intent" value="add_plan_line" />
      <input type="hidden" name="collectionId" value={collectionId} />
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="productId" value={mode === 'existing' ? productId : ''} />
      <input type="hidden" name="productName" value={mode === 'new' ? productName : ''} />
      <input type="hidden" name="unitCostCurrency" value={unitCostCurrency} />

      <p className="text-xs font-medium text-muted-foreground">Add a product line</p>

      <div className="flex gap-2 text-xs">
        <button
          type="button"
          onClick={() => setMode('existing')}
          className={cn(
            'rounded-lg border px-2.5 py-1',
            mode === 'existing'
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground'
          )}
        >
          Existing product
        </button>
        <button
          type="button"
          onClick={() => setMode('new')}
          className={cn(
            'rounded-lg border px-2.5 py-1',
            mode === 'new'
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground'
          )}
        >
          Not launched yet
        </button>
      </div>

      {mode === 'existing' ? (
        <select
          value={productId}
          onChange={event => setProductId(event.target.value)}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          required
        >
          <option value="">Choose a product</option>
          {productOptions.map(product => (
            <option key={product.id} value={product.id}>
              {product.name}
              {product.provider ? ` · ${product.provider}` : ''}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={productName}
          onChange={event => setProductName(event.target.value)}
          placeholder="Working name for an unlaunched product"
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          required
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Planned quantity</label>
          <input
            type="number"
            name="plannedQuantity"
            min="0"
            value={plannedQuantity}
            onChange={event => setPlannedQuantity(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            required
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Gifted units (PR, free to partner)
          </label>
          <input
            type="number"
            name="giftedUnits"
            min="0"
            max={plannedQuantity || undefined}
            value={giftedUnits}
            onChange={event => setGiftedUnits(event.target.value)}
            placeholder="0"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <p className="text-xs text-muted-foreground mt-1">Still costs COGS, earns no revenue.</p>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Expected sell-through %
          </label>
          <input
            type="number"
            name="expectedSellThroughPct"
            min="0"
            max="100"
            value={sellThrough}
            onChange={event => setSellThrough(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Unit selling price</label>
          <input
            type="number"
            name="unitSellingPrice"
            min="0"
            step="0.01"
            value={unitSellingPrice}
            onChange={event => setUnitSellingPrice(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            required
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">
          Unit cost (what the supplier charges)
        </label>
        <div className="mt-1 flex gap-2">
          <SearchableSelect
            options={CURRENCY_OPTIONS}
            value={unitCostCurrency}
            onChange={setUnitCostCurrency}
            className="w-28 shrink-0 px-3 py-2"
          />
          <input
            type="number"
            name="unitCost"
            min="0"
            step="0.01"
            value={unitCost}
            onChange={event => setUnitCost(event.target.value)}
            className="flex-1 min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            required
          />
        </div>
        {unitCostCurrency && unitCostCurrency !== planCurrency && (
          <p className="text-xs text-muted-foreground mt-1">
            Converted to {planCurrency} at today&rsquo;s live rate when saved, and kept at that rate
            — it won&rsquo;t drift with FX on later views.
          </p>
        )}
      </div>

      <Button
        type="submit"
        disabled={fetcher.state !== 'idle'}
        variant="outline"
        className="w-full"
      >
        <Plus size={16} />
        Add line
      </Button>

      {fetcher.data?.error && <p className="text-xs text-destructive">{fetcher.data?.error}</p>}
    </fetcher.Form>
  );
}

function RemovePlanLineButton({ collectionId, lineId }: { collectionId: string; lineId: string }) {
  const fetcher = useFetcher<PlanActionResult>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.ok) {
      revalidator.revalidate();
    }
  }, [fetcher.data, fetcher.state, revalidator]);

  return (
    <button
      type="button"
      onClick={() =>
        fetcher.submit({ intent: 'remove_plan_line', collectionId, lineId }, { method: 'post' })
      }
      className="text-muted-foreground hover:text-destructive transition-colors"
      title="Remove line"
    >
      <Trash size={16} />
    </button>
  );
}

function PlanCostsSection({
  collectionId,
  planId,
  costs,
  currency,
}: {
  collectionId: string;
  planId: string;
  costs: CollectionPlanCost[];
  currency: string;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm">
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
        <div>
          <h4 className="font-semibold text-foreground">Other planned costs</h4>
          <p className="text-xs text-muted-foreground">
            Marketing, packaging, freight, and anything else beyond product cost.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{costs.length} rows</span>
      </div>

      {costs.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground text-sm">
          No other costs planned yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Category</th>
                <th className="px-3 py-3 font-medium">Description</th>
                <th className="px-3 py-3 font-medium text-right">Amount</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {costs.map(cost => (
                <tr key={cost.id} className="border-t border-border/60 hover:bg-muted/20">
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium capitalize text-foreground">
                      {cost.costCategory.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{cost.description || '—'}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-medium">
                    {cost.plannedAmount != null ? (
                      <span className="text-foreground">
                        {formatMoney(cost.plannedAmount, currency)}
                      </span>
                    ) : (
                      <span className="italic text-muted-foreground">To be determined</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <RemovePlanCostButton collectionId={collectionId} costId={cost.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddPlanCostForm collectionId={collectionId} planId={planId} />
    </section>
  );
}

function AddPlanCostForm({ collectionId, planId }: { collectionId: string; planId: string }) {
  const fetcher = useFetcher<PlanActionResult>();
  const revalidator = useRevalidator();
  const lastState = useRef(fetcher.state);
  const [costCategory, setCostCategory] = useState<string>(PLAN_COST_CATEGORIES[0].value);
  const [description, setDescription] = useState('');
  const [plannedAmount, setPlannedAmount] = useState('');

  useEffect(() => {
    if (lastState.current !== 'idle' && fetcher.state === 'idle' && fetcher.data?.ok) {
      revalidator.revalidate();
      setDescription('');
      setPlannedAmount('');
    }
    lastState.current = fetcher.state;
  }, [fetcher.data, fetcher.state, revalidator]);

  return (
    <fetcher.Form method="post" className="border-t border-border p-5 space-y-3">
      <input type="hidden" name="intent" value="add_plan_cost" />
      <input type="hidden" name="collectionId" value={collectionId} />
      <input type="hidden" name="planId" value={planId} />

      <p className="text-xs font-medium text-muted-foreground">Add a planned cost</p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Category</label>
          <select
            name="costCategory"
            value={costCategory}
            onChange={event => setCostCategory(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            {PLAN_COST_CATEGORIES.map(category => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Planned amount (optional)
          </label>
          <input
            type="number"
            name="plannedAmount"
            min="0"
            step="0.01"
            value={plannedAmount}
            onChange={event => setPlannedAmount(event.target.value)}
            placeholder="Leave blank if TBD"
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Description</label>
        <input
          type="text"
          name="description"
          value={description}
          onChange={event => setDescription(event.target.value)}
          placeholder="Optional"
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <Button
        type="submit"
        disabled={fetcher.state !== 'idle'}
        variant="outline"
        className="w-full"
      >
        <Plus size={16} />
        Add cost
      </Button>

      {fetcher.data?.error && <p className="text-xs text-destructive">{fetcher.data?.error}</p>}
    </fetcher.Form>
  );
}

function RemovePlanCostButton({ collectionId, costId }: { collectionId: string; costId: string }) {
  const fetcher = useFetcher<PlanActionResult>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.ok) {
      revalidator.revalidate();
    }
  }, [fetcher.data, fetcher.state, revalidator]);

  return (
    <button
      type="button"
      onClick={() =>
        fetcher.submit({ intent: 'remove_plan_cost', collectionId, costId }, { method: 'post' })
      }
      className="text-muted-foreground hover:text-destructive transition-colors"
      title="Remove cost"
    >
      <Trash size={16} />
    </button>
  );
}
