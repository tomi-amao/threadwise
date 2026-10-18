/**
 * StockSection
 *
 * For a purchase invoice, which lines are stock? Stock lines are capitalised (they sit on the
 * balance sheet as inventory and reach profit when they sell); everything else is an expense.
 * Each line can be an expense, linked to a product you already sell (which sets that product's
 * unit cost from this line), created as a new draft product, or tracked as stock without a
 * product (raw materials, packaging). All decisions are sent together and applied once.
 */

import { useMemo, useState } from 'react';
import { CheckCircle } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { Eyebrow } from '~/components/ui/eyebrow';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/native-select';
import { FIELD_TRIGGER_CLASS, SearchableSelect } from '~/components/ui/searchable-select';
import type {
  GlAccountOption,
  InvoiceLineItem,
  ProductOption,
  StockAction,
  StockDecision,
} from '~/types/invoice';
import { int, money } from './model';

type Choice = StockAction | 'undecided';

interface Draft {
  action: Choice;
  productId: string;
  name: string;
  sku: string;
  assetId: string;
  cogsId: string;
}

const FEE_WORDS = [
  'fee',
  'fees',
  'charge',
  'charges',
  'shipping',
  'postage',
  'delivery',
  'handling',
  'discount',
  'credit',
  'adjustment',
  'surcharge',
  'commission',
  'tax',
  'vat',
  'duty',
  'tariff',
  'insurance',
  'refund',
  'packing',
  'packaging',
];
const FEE_PATTERN = new RegExp(`\\b(?:${FEE_WORDS.join('|')})\\b`, 'i');

/** Lines whose description reads like a fee or a service are probably not stock. */
export const looksLikeStock = (line: Pick<InvoiceLineItem, 'description'>): boolean =>
  !FEE_PATTERN.test(line.description);

const ACTION_LABEL: Record<Choice, string> = {
  undecided: 'Choose…',
  expense: 'Not stock (expense only)',
  link: 'Link to a product I sell',
  new: 'Create a new product',
  track: 'Track stock without a product',
};

const blank = (line: InvoiceLineItem): Draft => ({
  // A line that reads like a fee or a service starts as an expense; the rest wait for a choice.
  action: looksLikeStock(line) ? 'undecided' : 'expense',
  productId: '',
  name: line.description.trim(),
  sku: line.sku ?? '',
  assetId: '',
  cogsId: '',
});

function ready(d: Draft): boolean {
  if (d.action === 'undecided') return false;
  if (d.action === 'link') return !!d.productId;
  if (d.action === 'new') return d.name.trim().length > 0;
  return true;
}

export function StockSection({
  lines,
  stockedIds,
  currency,
  products,
  accounts,
  busy,
  onApply,
}: {
  lines: InvoiceLineItem[];
  stockedIds: string[];
  currency: string;
  products: ProductOption[];
  accounts: GlAccountOption[];
  busy: boolean;
  onApply: (decisions: StockDecision[]) => void;
}) {
  const stocked = useMemo(() => new Set(stockedIds), [stockedIds]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const open = lines.filter(l => !stocked.has(l.id));
  const draftOf = (line: InvoiceLineItem): Draft => drafts[line.id] ?? blank(line);
  const change = (line: InvoiceLineItem, patch: Partial<Draft>) =>
    setDrafts(prev => ({ ...prev, [line.id]: { ...draftOf(line), ...patch } }));

  const productOptions = useMemo(
    () => products.map(p => ({ value: p.id, label: p.name })),
    [products]
  );
  const assetOptions = useMemo(
    () =>
      accounts
        .filter(a => a.account_type === 'asset')
        .map(a => ({ value: a.id, label: `${a.account_number} · ${a.name}` })),
    [accounts]
  );
  const cogsOptions = useMemo(
    () =>
      accounts
        .filter(a => a.account_type === 'cogs')
        .map(a => ({ value: a.id, label: `${a.account_number} · ${a.name}` })),
    [accounts]
  );

  // "Not stock" needs no record, so only lines headed for stock are sent.
  const decisions = open.filter(l => draftOf(l).action !== 'expense' && ready(draftOf(l)));
  const untracked = open.filter(l => looksLikeStock(l) && draftOf(l).action === 'undecided').length;

  const apply = () =>
    onApply(
      decisions.map(line => {
        const d = draftOf(line);
        const decision: StockDecision = {
          line_item_id: line.id,
          action: d.action as StockAction,
        };
        if (d.action === 'link') decision.product_id = d.productId;
        if (d.action === 'new') decision.name = d.name.trim();
        if ((d.action === 'new' || d.action === 'track') && d.sku.trim())
          decision.sku = d.sku.trim();
        if (d.action !== 'expense') {
          if (d.assetId) decision.asset_account_id = d.assetId;
          if (d.cogsId) decision.cogs_account_id = d.cogsId;
        }
        return decision;
      })
    );

  return (
    <section aria-label="Stock" className="space-y-3 border-t pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>Stock</Eyebrow>
        {untracked > 0 && (
          <span className="text-[13px] text-accent-text">
            {untracked} {untracked === 1 ? 'line looks' : 'lines look'} like stock
          </span>
        )}
      </div>
      <p className="text-[13px] text-muted-foreground">
        Stock is held as inventory and reaches profit when it sells. Anything else is an expense.
      </p>

      <ul className="divide-y rounded-xl border">
        {lines.map(line => {
          const done = stocked.has(line.id);
          const d = draftOf(line);
          const name = `Stock handling for ${line.description}`;
          return (
            <li key={line.id} className="space-y-2.5 px-3.5 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[15px]">{line.description}</div>
                  <div className="font-mono text-xs text-text-2">
                    {int(line.quantity)} × {money(line.unit_cost, currency)}
                  </div>
                </div>
                {done && (
                  <Chip tone="done">
                    <CheckCircle size={12} weight="fill" aria-hidden /> Stock recorded
                  </Chip>
                )}
              </div>

              {!done && (
                <>
                  <NativeSelect
                    shape="field"
                    aria-label={name}
                    className="w-full"
                    value={d.action}
                    onChange={e => change(line, { action: e.target.value as Choice })}
                  >
                    {(Object.keys(ACTION_LABEL) as Choice[]).map(a => (
                      <option key={a} value={a}>
                        {ACTION_LABEL[a]}
                      </option>
                    ))}
                  </NativeSelect>

                  {d.action === 'link' && (
                    <SearchableSelect
                      aria-label={`Product for ${line.description}`}
                      options={productOptions}
                      value={d.productId}
                      onChange={productId => change(line, { productId })}
                      placeholder="Search your products"
                      className={FIELD_TRIGGER_CLASS}
                    />
                  )}

                  {d.action === 'new' && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        aria-label={`Product name for ${line.description}`}
                        value={d.name}
                        onChange={e => change(line, { name: e.target.value })}
                        placeholder="Product name"
                      />
                      <Input
                        aria-label={`SKU for ${line.description}`}
                        value={d.sku}
                        onChange={e => change(line, { sku: e.target.value })}
                        placeholder="SKU (optional)"
                        className="font-mono"
                      />
                    </div>
                  )}

                  {d.action === 'track' && (
                    <Input
                      aria-label={`SKU for ${line.description}`}
                      value={d.sku}
                      onChange={e => change(line, { sku: e.target.value })}
                      placeholder="SKU (optional: worked out from the description)"
                      className="font-mono"
                    />
                  )}

                  {(d.action === 'link' || d.action === 'new' || d.action === 'track') &&
                    (assetOptions.length > 0 || cogsOptions.length > 0) && (
                      <details className="text-[13px]">
                        <summary className="cursor-pointer rounded-sm text-text-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          Accounts (optional)
                        </summary>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <SearchableSelect
                            aria-label={`Inventory account for ${line.description}`}
                            options={assetOptions}
                            value={d.assetId}
                            onChange={assetId => change(line, { assetId })}
                            placeholder="Inventory account"
                            className={FIELD_TRIGGER_CLASS}
                            emptyOption="Default"
                          />
                          <SearchableSelect
                            aria-label={`Cost of sales account for ${line.description}`}
                            options={cogsOptions}
                            value={d.cogsId}
                            onChange={cogsId => change(line, { cogsId })}
                            placeholder="Cost of sales account"
                            className={FIELD_TRIGGER_CLASS}
                            emptyOption="Default"
                          />
                        </div>
                      </details>
                    )}
                </>
              )}
            </li>
          );
        })}
      </ul>

      {open.length > 0 && (
        <Button onClick={apply} disabled={decisions.length === 0 || busy} variant="outline">
          {busy
            ? 'Applying…'
            : decisions.length === 0
              ? 'Apply stock decisions'
              : `Apply ${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'}`}
        </Button>
      )}
    </section>
  );
}
