/**
 * BoughtSection
 *
 * What a purchase invoice bought, and how much of it: the products (linked to their product
 * page) and the samples (which have no product). Each line's kind is proposed when the
 * invoice is read and can be corrected here.
 *
 * This is information only. Nothing here changes a product or stock: stock levels and stock
 * value come from the stock records (Shopify, or the inventory page), never from invoices.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { Eyebrow } from '~/components/ui/eyebrow';
import { NativeSelect } from '~/components/ui/native-select';
import { FIELD_TRIGGER_CLASS, SearchableSelect } from '~/components/ui/searchable-select';
import type { InvoiceLineItem, LineKind, LineUpdate, ProductOption } from '~/types/invoice';
import { int, money } from './model';

const KIND_LABEL: Record<LineKind, string> = {
  product: 'Product',
  sample: 'Sample',
  other: 'Something else',
};

interface Draft {
  line_kind: LineKind;
  product_id: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

/** "3 products, 120 units; 2 samples, 6 units" for the lines given. */
export function boughtSummary(lines: InvoiceLineItem[]): string | null {
  const products = lines.filter(l => l.line_kind === 'product');
  const samples = lines.filter(l => l.line_kind === 'sample');
  const units = (ls: InvoiceLineItem[]) => ls.reduce((s, l) => s + l.quantity, 0);
  const parts = [
    products.length > 0 &&
      `${plural(products.length, 'product')}, ${plural(units(products), 'unit')}`,
    samples.length > 0 && `${plural(samples.length, 'sample')}, ${plural(units(samples), 'unit')}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : null;
}

export function BoughtSection({
  lines,
  currency,
  products,
  busy,
  disabled,
  onSave,
}: {
  lines: InvoiceLineItem[];
  currency: string;
  products: ProductOption[];
  busy: boolean;
  disabled: boolean;
  onSave: (updates: Record<string, LineUpdate>) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const productOptions = useMemo(
    () => products.map(p => ({ value: p.id, label: p.name })),
    [products]
  );

  const draftOf = (line: InvoiceLineItem): Draft =>
    drafts[line.id] ?? { line_kind: line.line_kind, product_id: line.product?.id ?? null };
  const change = (line: InvoiceLineItem, patch: Partial<Draft>) =>
    setDrafts(prev => ({ ...prev, [line.id]: { ...draftOf(line), ...patch } }));

  // Only what differs from the saved line is sent.
  const updates: Record<string, LineUpdate> = {};
  for (const line of lines) {
    const draft = draftOf(line);
    const savedProduct = line.product?.id ?? null;
    if (draft.line_kind === line.line_kind && draft.product_id === savedProduct) continue;
    updates[line.id] =
      draft.line_kind === 'product'
        ? { line_kind: 'product', product_id: draft.product_id }
        : { line_kind: draft.line_kind };
  }
  const dirty = Object.keys(updates).length > 0;

  const save = async () => {
    if (await onSave(updates)) {
      setDrafts({});
      setEditing(false);
    }
  };
  const cancel = () => {
    setDrafts({});
    setEditing(false);
  };

  const bought = lines.filter(l => l.line_kind !== 'other');
  const summary = boughtSummary(lines);

  return (
    <section aria-label="What this invoice bought" className="space-y-3 border-t pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>What this invoice bought</Eyebrow>
        {!editing && !disabled && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        )}
      </div>

      {!editing && (
        <>
          <p className="text-[13px] text-text-2">
            {summary ?? 'No products or samples on this invoice.'}
          </p>
          {bought.length > 0 && (
            <ul className="divide-y rounded-xl border">
              {bought.map(line => (
                <li key={line.id} className="flex items-start justify-between gap-3 px-3.5 py-3">
                  <div className="min-w-0">
                    {line.line_kind === 'product' && line.product ? (
                      <Link
                        to={`/products?product=${encodeURIComponent(line.product.id)}`}
                        className="text-[15px] text-accent-text underline-offset-4 hover:underline"
                      >
                        {line.product.name}
                      </Link>
                    ) : (
                      <div className="text-[15px]">{line.description}</div>
                    )}
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs text-text-2">
                      <span>
                        {int(line.quantity)} × {money(line.unit_cost, currency)}
                      </span>
                      {line.line_kind === 'sample' && <Chip tone="plain">Sample</Chip>}
                      {line.line_kind === 'product' && !line.product && (
                        <span>Not linked to a product</span>
                      )}
                    </div>
                    {line.line_kind === 'product' && line.product && (
                      <div className="truncate text-[13px] text-text-2">{line.description}</div>
                    )}
                  </div>
                  <div className="shrink-0 tabular-nums">
                    {money(line.line_net ?? line.quantity * line.unit_cost, currency)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {editing && (
        <>
          <ul className="divide-y rounded-xl border">
            {lines.map(line => {
              const draft = draftOf(line);
              return (
                <li key={line.id} className="space-y-2 px-3.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 text-[15px]">{line.description}</div>
                    <div className="shrink-0 font-mono text-xs text-text-2">
                      {int(line.quantity)} × {money(line.unit_cost, currency)}
                    </div>
                  </div>
                  <NativeSelect
                    shape="field"
                    aria-label={`What ${line.description} is`}
                    value={draft.line_kind}
                    onChange={e => change(line, { line_kind: e.target.value as LineKind })}
                  >
                    {(Object.keys(KIND_LABEL) as LineKind[]).map(kind => (
                      <option key={kind} value={kind}>
                        {KIND_LABEL[kind]}
                      </option>
                    ))}
                  </NativeSelect>
                  {draft.line_kind === 'product' && (
                    <SearchableSelect
                      aria-label={`Product for ${line.description}`}
                      options={productOptions}
                      value={draft.product_id ?? ''}
                      onChange={value => change(line, { product_id: value || null })}
                      placeholder="Link to a product"
                      emptyOption="Not linked"
                      className={FIELD_TRIGGER_CLASS}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={!dirty || busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="outline" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </>
      )}

      <p className="text-[13px] text-muted-foreground">
        For reference only: this does not change your products or stock.
      </p>
    </section>
  );
}
