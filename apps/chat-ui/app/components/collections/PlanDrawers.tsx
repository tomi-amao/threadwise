/**
 * Drawers that edit a plan: its terms, a product line, and an "other cost". Each saves through
 * the collection route's action and closes when it works.
 */

import { useState } from 'react';
import { Plus, Trash } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Drawer } from '~/components/ui/drawer';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/native-select';
import { FIELD_TRIGGER_CLASS, SearchableSelect } from '~/components/ui/searchable-select';
import { Segmented } from '~/components/ui/segmented';
import { Textarea } from '~/components/ui/textarea';
import type { PlanData, ProductOption } from '~/lib/api/collections.server';
import {
  COLLABORATION_TYPES,
  CURRENCY_OPTIONS,
  PLAN_COST_CATEGORIES,
  getCustomTerms,
  type CollectionPlanCost,
  type CollectionPlanLine,
} from '~/lib/collection-plans';
import { useCollectionAction } from './use-collection-action';

// ─── Terms ────────────────────────────────────────────────────────────

export function TermsDrawer({
  plan,
  open,
  onClose,
}: {
  plan: PlanData['plan'];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={o => !o && onClose()}
      eyebrow="Plan"
      title="Collaboration and terms."
      description="The type of collaboration, its partner and its terms"
      className="w-[min(560px,100vw)]"
    >
      {open && <TermsForm plan={plan} onDone={onClose} />}
    </Drawer>
  );
}

function TermsForm({ plan, onDone }: { plan: PlanData['plan']; onDone: () => void }) {
  const action = useCollectionAction(onDone);
  const [type, setType] = useState(plan.collaborationType);
  const [partner, setPartner] = useState(plan.partnerName ?? '');
  const [currency, setCurrency] = useState(plan.currency || 'GBP');
  const [partnerCurrency, setPartnerCurrency] = useState(plan.partnerCurrency ?? '');
  const [notes, setNotes] = useState(plan.notes ?? '');
  // Everything except custom_terms (a list) and costs_paid_upfront (a boolean) is edited as text.
  const [meta, setMeta] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(plan.metadata ?? {})
        .filter(([k]) => k !== 'custom_terms' && k !== 'costs_paid_upfront')
        .map(([k, v]) => [k, String(v)])
    )
  );
  const [terms, setTerms] = useState(() =>
    getCustomTerms(plan.metadata).map((t, i) => ({ key: i + 1, label: t.label, value: t.value }))
  );
  const [upfront, setUpfront] = useState(plan.metadata?.costs_paid_upfront !== false);
  const collab = type !== 'in_house';

  const set = (key: string, value: string) => setMeta(m => ({ ...m, [key]: value }));
  const field = (
    key: string,
    label: string,
    opts: { type?: string; placeholder?: string } = {}
  ) => (
    <Field key={key} label={label}>
      <Input
        type={opts.type ?? 'text'}
        step={opts.type === 'number' ? 'any' : undefined}
        placeholder={opts.placeholder}
        value={meta[key] ?? ''}
        onChange={e => set(key, e.target.value)}
      />
    </Field>
  );

  const payload = (): Record<string, unknown> => {
    const number = (k: string) => {
      const raw = meta[k];
      if (raw === undefined || raw === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const str = (k: string) => (meta[k] ? meta[k] : undefined);
    const byType: Record<string, unknown> = (() => {
      switch (type) {
        case 'wholesale':
          return {
            minimum_order_quantity: number('minimum_order_quantity'),
            payment_terms: str('payment_terms'),
            purchase_order_reference: str('purchase_order_reference'),
          };
        case 'co_branded':
          return {
            cost_split_pct: number('cost_split_pct'),
            revenue_split_pct: number('revenue_split_pct'),
            co_brand_credit_notes: str('co_brand_credit_notes'),
            marketing_commitment_notes: str('marketing_commitment_notes'),
            costs_paid_upfront: upfront,
          };
        case 'revenue_share':
          return {
            revenue_share_pct: number('revenue_share_pct'),
            minimum_guarantee_amount: number('minimum_guarantee_amount'),
            reporting_cadence: str('reporting_cadence'),
          };
        case 'pop_up':
          return {
            venue_cost_amount: number('venue_cost_amount'),
            venue_cost_period: str('venue_cost_period') || 'flat',
            duration_days: number('duration_days'),
            staffing_cost_amount: number('staffing_cost_amount'),
            fixtures_cost_amount: number('fixtures_cost_amount'),
            expected_foot_traffic: number('expected_foot_traffic'),
          };
        default:
          return {};
      }
    })();
    const custom = terms
      .map(t => ({ label: t.label.trim(), value: t.value.trim() }))
      .filter(t => t.label !== '');
    if (custom.length > 0 && collab) byType.custom_terms = custom;
    return byType;
  };

  return (
    <>
      <Field label="Collaboration type">
        <NativeSelect
          shape="field"
          aria-label="Collaboration type"
          className="w-full"
          value={type}
          onChange={e => setType(e.target.value)}
        >
          {COLLABORATION_TYPES.map(t => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </NativeSelect>
      </Field>

      {collab && (
        <Field label="Partner name">
          <Input
            value={partner}
            placeholder="Brand or venue name"
            onChange={e => setPartner(e.target.value)}
          />
        </Field>
      )}

      <div className={collab ? 'grid gap-4 sm:grid-cols-2' : ''}>
        <Field label="Plan currency">
          <Input
            value={currency}
            maxLength={3}
            onChange={e => setCurrency(e.target.value.toUpperCase())}
          />
        </Field>
        {collab && (
          <Field
            label="Partner's currency"
            hint="Optional. Payouts also show a live estimate in it."
          >
            <SearchableSelect
              options={CURRENCY_OPTIONS}
              value={partnerCurrency}
              onChange={setPartnerCurrency}
              emptyOption="None, same as the plan"
              placeholder="Search currency…"
              aria-label="Partner's currency"
              className={FIELD_TRIGGER_CLASS}
            />
          </Field>
        )}
      </div>

      {type === 'wholesale' && (
        <div className="space-y-4 rounded-xl border bg-background p-4">
          {field('minimum_order_quantity', 'Minimum order quantity', { type: 'number' })}
          {field('payment_terms', 'Payment terms', {
            placeholder: 'e.g. 50% deposit, 50% on delivery',
          })}
          {field('purchase_order_reference', 'Purchase order reference')}
        </div>
      )}
      {type === 'co_branded' && (
        <div className="space-y-4 rounded-xl border bg-background p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {field('revenue_split_pct', 'Your revenue split %', { type: 'number' })}
            {field('cost_split_pct', 'Your cost split %', { type: 'number' })}
          </div>
          <label className="flex items-start gap-2.5 text-[14px]">
            <input
              type="checkbox"
              checked={upfront}
              onChange={e => setUpfront(e.target.checked)}
              className="mt-1 size-4 accent-[var(--primary)]"
            />
            <span>
              Partner pays their cost share upfront
              <span className="block text-[13px] text-text-2">
                {upfront
                  ? 'They contribute cash before launch, whatever sales do.'
                  : 'Their share comes out of their revenue split instead, so you front the full planned cost.'}
              </span>
            </span>
          </label>
          {field('co_brand_credit_notes', 'Co-brand credit', {
            placeholder: 'e.g. 50/50 branding on packaging',
          })}
          {field('marketing_commitment_notes', 'Marketing commitments')}
        </div>
      )}
      {type === 'revenue_share' && (
        <div className="space-y-4 rounded-xl border bg-background p-4">
          {field('revenue_share_pct', 'Revenue share paid to partner %', { type: 'number' })}
          {field('minimum_guarantee_amount', 'Minimum guarantee', { type: 'number' })}
          {field('reporting_cadence', 'Reporting cadence', { placeholder: 'e.g. monthly' })}
        </div>
      )}
      {type === 'pop_up' && (
        <div className="space-y-4 rounded-xl border bg-background p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {field('venue_cost_amount', 'Venue cost', { type: 'number' })}
            <Field label="Venue cost period">
              <NativeSelect
                shape="field"
                aria-label="Venue cost period"
                className="w-full"
                value={meta.venue_cost_period ?? 'flat'}
                onChange={e => set('venue_cost_period', e.target.value)}
              >
                <option value="flat">Flat fee</option>
                <option value="per_day">Per day</option>
                <option value="per_week">Per week</option>
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {field('duration_days', 'Duration (days)', { type: 'number' })}
            {field('expected_foot_traffic', 'Expected foot traffic', { type: 'number' })}
          </div>
          {field('staffing_cost_amount', 'Staffing cost', { type: 'number' })}
          {field('fixtures_cost_amount', 'Fixtures and fit-out cost', { type: 'number' })}
        </div>
      )}

      {collab && (
        <section aria-label="Additional terms" className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Additional terms</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setTerms(t => [
                  ...t,
                  { key: Math.max(0, ...t.map(x => x.key)) + 1, label: '', value: '' },
                ])
              }
            >
              <Plus size={14} weight="bold" aria-hidden /> Add term
            </Button>
          </div>
          {terms.length === 0 && (
            <p className="text-[13px] text-text-2">
              Anything specific to this deal that does not fit the fields above.
            </p>
          )}
          {terms.map((t, i) => (
            <div key={t.key} className="flex items-center gap-2">
              <Input
                aria-label={`Term ${i + 1} name`}
                placeholder="Term, e.g. Exclusivity"
                value={t.label}
                className="w-2/5"
                onChange={e =>
                  setTerms(ts =>
                    ts.map(x => (x.key === t.key ? { ...x, label: e.target.value } : x))
                  )
                }
              />
              <Input
                aria-label={`Term ${i + 1} detail`}
                placeholder="Detail, e.g. UK and Ireland only"
                value={t.value}
                onChange={e =>
                  setTerms(ts =>
                    ts.map(x => (x.key === t.key ? { ...x, value: e.target.value } : x))
                  )
                }
              />
              <button
                type="button"
                onClick={() => setTerms(ts => ts.filter(x => x.key !== t.key))}
                aria-label={`Remove term ${i + 1}`}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Trash size={15} weight="light" aria-hidden />
              </button>
            </div>
          ))}
        </section>
      )}

      <Field label="Notes">
        <Textarea
          rows={3}
          value={notes}
          placeholder="Anything else worth recording about this plan"
          onChange={e => setNotes(e.target.value)}
        />
      </Field>

      {action.error && (
        <p role="alert" className="text-[14px] text-destructive">
          {action.error}
        </p>
      )}
      <Button
        disabled={action.busy}
        onClick={() =>
          action.submit({
            intent: 'updatePlan',
            collaborationType: type,
            partnerName: partner,
            currency,
            partnerCurrency,
            notes,
            metadata: JSON.stringify(payload()),
          })
        }
      >
        {action.busy ? 'Saving…' : 'Save plan details'}
      </Button>
    </>
  );
}

// ─── A product line ───────────────────────────────────────────────────

export function LineDrawer({
  line,
  planCurrency,
  products,
  open,
  onClose,
}: {
  /** The line to edit; null adds a new one. */
  line: CollectionPlanLine | null;
  planCurrency: string;
  products: ProductOption[];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={o => !o && onClose()}
      eyebrow="Planned range"
      title={line ? 'Edit this line.' : 'Add a product line.'}
      description="Quantity, cost, price and sell-through for one product"
    >
      {open && (
        <LineForm
          key={line?.id ?? 'new'}
          line={line}
          planCurrency={planCurrency}
          products={products}
          onDone={onClose}
        />
      )}
    </Drawer>
  );
}

function LineForm({
  line,
  planCurrency,
  products,
  onDone,
}: {
  line: CollectionPlanLine | null;
  planCurrency: string;
  products: ProductOption[];
  onDone: () => void;
}) {
  const action = useCollectionAction(onDone);
  const [mode, setMode] = useState<'existing' | 'new'>(
    line ? (line.productId ? 'existing' : 'new') : products.length > 0 ? 'existing' : 'new'
  );
  const [productId, setProductId] = useState(line?.productId ?? '');
  const [name, setName] = useState(line?.productName ?? '');
  const [qty, setQty] = useState(line ? String(line.plannedQuantity) : '');
  const [gifted, setGifted] = useState(
    line && line.giftedUnits > 0 ? String(line.giftedUnits) : ''
  );
  const [sell, setSell] = useState(line ? String(line.expectedSellThroughPct) : '100');
  const [price, setPrice] = useState(line ? String(line.unitSellingPrice) : '');
  // A cost quoted in another currency is shown as quoted; it is converted when saved.
  const quoted = line?.unitCostCurrency && line.unitCostOriginal != null;
  const [costCurrency, setCostCurrency] = useState(
    quoted ? line!.unitCostCurrency! : line ? planCurrency : 'USD'
  );
  const [cost, setCost] = useState(
    line ? String(quoted ? line.unitCostOriginal : Number(line.unitCost.toFixed(4))) : ''
  );
  const [notes, setNotes] = useState(line?.notes ?? '');

  const options = products.map(p => ({
    value: p.id,
    label: p.name,
    meta: [p.provider, p.productType].filter(Boolean).join(' · ') || undefined,
  }));
  const ready =
    (mode === 'existing' ? !!productId : name.trim() !== '') &&
    qty !== '' &&
    cost !== '' &&
    price !== '';

  return (
    <>
      <Segmented<'existing' | 'new'>
        label="Product"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'existing', label: 'Existing product' },
          { value: 'new', label: 'Not launched yet' },
        ]}
      />
      {mode === 'existing' ? (
        <Field label="Product">
          <SearchableSelect
            options={options}
            value={productId}
            onChange={setProductId}
            placeholder="Choose a product"
            aria-label="Product"
            className={FIELD_TRIGGER_CLASS}
          />
        </Field>
      ) : (
        <Field label="Working name" hint="For a product that is not in the catalogue yet.">
          <Input value={name} onChange={e => setName(e.target.value)} />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Planned quantity">
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={qty}
            onChange={e => setQty(e.target.value)}
          />
        </Field>
        <Field label="Gifted units" hint="PR or free to a partner. Still costs, earns nothing.">
          <Input
            type="number"
            min={0}
            max={qty || undefined}
            step={1}
            inputMode="numeric"
            value={gifted}
            onChange={e => setGifted(e.target.value)}
          />
        </Field>
        <Field label="Expected sell-through %">
          <Input
            type="number"
            min={0}
            max={100}
            inputMode="decimal"
            value={sell}
            onChange={e => setSell(e.target.value)}
          />
        </Field>
        <Field label={`Selling price (${planCurrency})`}>
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={price}
            onChange={e => setPrice(e.target.value)}
          />
        </Field>
      </div>

      <div className="space-y-1.5">
        <span className="eyebrow">Unit cost (what the supplier charges)</span>
        <div className="flex gap-2">
          <SearchableSelect
            options={CURRENCY_OPTIONS}
            value={costCurrency}
            onChange={setCostCurrency}
            aria-label="Supplier currency"
            className="h-10 w-28 shrink-0 rounded-xl border-input bg-card px-3.5 text-[15px] hover:bg-card"
          />
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            aria-label="Unit cost"
            value={cost}
            onChange={e => setCost(e.target.value)}
          />
        </div>
        {costCurrency && costCurrency !== planCurrency && (
          <p className="text-[13px] text-text-2">
            Converted to {planCurrency} at today&apos;s live rate when saved, and kept at that rate.
          </p>
        )}
      </div>

      <Field label="Notes">
        <Input value={notes} maxLength={300} onChange={e => setNotes(e.target.value)} />
      </Field>

      {action.error && (
        <p role="alert" className="text-[14px] text-destructive">
          {action.error}
        </p>
      )}
      <Button
        disabled={action.busy || !ready}
        onClick={() =>
          action.submit({
            intent: line ? 'updatePlanLine' : 'addPlanLine',
            ...(line ? { lineId: line.id } : {}),
            productId: mode === 'existing' ? productId : '',
            productName: mode === 'new' ? name : '',
            plannedQuantity: qty,
            giftedUnits: gifted || '0',
            expectedSellThroughPct: sell,
            unitSellingPrice: price,
            unitCost: cost,
            unitCostCurrency: costCurrency,
            notes,
          })
        }
      >
        {action.busy ? 'Saving…' : line ? 'Save line' : 'Add line'}
      </Button>
    </>
  );
}

// ─── Another planned cost ─────────────────────────────────────────────

export function PlanCostDrawer({
  cost,
  currency,
  open,
  onClose,
}: {
  cost: CollectionPlanCost | null;
  currency: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={o => !o && onClose()}
      eyebrow="Other planned costs"
      title={cost ? 'Edit this cost.' : 'Add a planned cost.'}
      description="A planned cost beyond product cost"
    >
      {open && (
        <CostForm key={cost?.id ?? 'new'} cost={cost} currency={currency} onDone={onClose} />
      )}
    </Drawer>
  );
}

function CostForm({
  cost,
  currency,
  onDone,
}: {
  cost: CollectionPlanCost | null;
  currency: string;
  onDone: () => void;
}) {
  const action = useCollectionAction(onDone);
  const known = PLAN_COST_CATEGORIES.some(c => c.value === cost?.costCategory);
  const [category, setCategory] = useState(cost?.costCategory ?? PLAN_COST_CATEGORIES[0].value);
  const [amount, setAmount] = useState(
    cost?.plannedAmount != null ? String(cost.plannedAmount) : ''
  );
  const [estimated, setEstimated] = useState(cost?.isEstimated ?? false);
  const [description, setDescription] = useState(cost?.description ?? '');

  return (
    <>
      <Field label="Category">
        <NativeSelect
          shape="field"
          aria-label="Category"
          className="w-full"
          value={category}
          onChange={e => setCategory(e.target.value)}
        >
          {!known && cost && <option value={cost.costCategory}>{cost.costCategory}</option>}
          {PLAN_COST_CATEGORIES.map(c => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field
        label={`Planned amount (${currency})`}
        hint="Leave blank if it is still to be determined."
      >
        <Input
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          value={amount}
          onChange={e => setAmount(e.target.value)}
        />
      </Field>
      {amount !== '' && (
        <label className="flex items-center gap-2.5 text-[14px]">
          <input
            type="checkbox"
            checked={estimated}
            onChange={e => setEstimated(e.target.checked)}
            className="size-4 accent-[var(--primary)]"
          />
          This is a rough estimate, not a firm quote
        </label>
      )}
      <Field label="Description">
        <Input value={description} maxLength={200} onChange={e => setDescription(e.target.value)} />
      </Field>
      {action.error && (
        <p role="alert" className="text-[14px] text-destructive">
          {action.error}
        </p>
      )}
      <Button
        disabled={action.busy}
        onClick={() =>
          action.submit({
            intent: cost ? 'updatePlanCost' : 'addPlanCost',
            ...(cost ? { costId: cost.id } : {}),
            costCategory: category,
            plannedAmount: amount,
            isEstimated: amount !== '' && estimated ? 'true' : 'false',
            description,
          })
        }
      >
        {action.busy ? 'Saving…' : cost ? 'Save cost' : 'Add cost'}
      </Button>
    </>
  );
}
