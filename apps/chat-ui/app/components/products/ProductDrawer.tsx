/**
 * ProductDrawer
 *
 * One product: pictures, how it sells, its variants, and questions for the assistant. Loaded
 * from /api/products?id= when opened (?product=<id>); the sales figures come from the list row.
 */

import { useEffect, useState } from 'react';
import { CircleNotch, Image as ImageIcon } from 'phosphor-react';
import { Chip } from '~/components/ui/chip';
import { Drawer } from '~/components/ui/drawer';
import { Eyebrow } from '~/components/ui/eyebrow';
import type { ProductDetail, ProductRow } from '~/lib/api/products.server';
import { cn } from '~/lib/utils';
import { ProductInsights } from './ProductInsights';
import { STAGE, ago, int, money, shortDate, stageOf } from './model';

type Load =
  | { id: string; state: 'ready'; detail: ProductDetail }
  | { id: string; state: 'error'; message: string };

function Gallery({ images, name }: { images: string[]; name: string }) {
  const [index, setIndex] = useState(0);
  const [broken, setBroken] = useState<Set<number>>(new Set());
  const shown = Math.min(index, Math.max(0, images.length - 1));

  if (images.length === 0 || broken.has(shown)) {
    return (
      <div className="flex h-28 flex-col items-center justify-center gap-1.5 rounded-2xl border bg-card text-muted-foreground">
        <ImageIcon size={28} weight="thin" aria-hidden />
        <span className="text-[13px]">
          {images.length === 0 ? 'No pictures yet' : 'Picture unavailable'}
        </span>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <img
        src={images[shown]}
        alt={`${name}, picture ${shown + 1} of ${images.length}`}
        className="aspect-[4/3] w-full rounded-2xl border bg-card object-cover"
        onError={() => setBroken(prev => new Set(prev).add(shown))}
      />
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto" role="group" aria-label="Pictures">
          {images.map((url, i) => (
            <button
              key={url}
              type="button"
              aria-label={`Show picture ${i + 1}`}
              aria-pressed={i === shown}
              onClick={() => setIndex(i)}
              className={cn(
                'size-14 shrink-0 overflow-hidden rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                i === shown && 'ring-2 ring-ring'
              )}
            >
              <img src={url} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProductDrawer({
  row,
  today,
  onClose,
}: {
  /** The list row for the open product, or null when the drawer is closed. */
  row: ProductRow | null;
  today: string;
  onClose: () => void;
}) {
  const productId = row?.id ?? null;
  const [load, setLoad] = useState<Load | null>(null);

  useEffect(() => {
    if (!productId) return;
    let live = true;
    fetch(`/api/products?id=${encodeURIComponent(productId)}`)
      .then(r => r.json())
      .then((result: { ok: boolean; error?: string; detail?: ProductDetail }) => {
        if (!live) return;
        setLoad(
          result.ok && result.detail
            ? { id: productId, state: 'ready', detail: result.detail }
            : {
                id: productId,
                state: 'error',
                message: result.error ?? 'Could not load this product',
              }
        );
      })
      .catch(
        () =>
          live && setLoad({ id: productId, state: 'error', message: 'Could not load this product' })
      );
    return () => {
      live = false;
    };
  }, [productId]);

  const current = load && load.id === productId ? load : null;
  const detail = current?.state === 'ready' ? current.detail : null;
  const stage = row ? STAGE[stageOf(row, today)] : null;

  return (
    <Drawer
      open={!!row}
      onOpenChange={open => !open && onClose()}
      eyebrow={
        detail
          ? [detail.provider, detail.product_type].filter(Boolean).join(' · ') || 'Product'
          : 'Product'
      }
      title={row?.name ?? 'Product'}
      description="Pictures, sales, variants and questions for the assistant"
      className="w-[min(560px,100vw)]"
    >
      {productId && !current && (
        <div role="status" className="flex items-center gap-2 text-text-2">
          <CircleNotch size={18} className="animate-spin" aria-hidden /> Loading product…
        </div>
      )}
      {current?.state === 'error' && (
        <p role="alert" className="text-destructive">
          {current.message}
        </p>
      )}
      {row && detail && stage && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={stage.tone} dot>
              {stage.label}
            </Chip>
            {detail.status && <Chip className="capitalize">{detail.status.toLowerCase()}</Chip>}
          </div>
          {detail.description && <p className="text-[14px] text-text-2">{detail.description}</p>}

          <Gallery images={detail.images} name={detail.name} />

          <dl aria-label="Sales" className="grid grid-cols-3 gap-3">
            <div>
              <dt className="eyebrow">Revenue</dt>
              <dd className="mt-1 font-serif text-[24px] tabular-nums">{money(row.revenue)}</dd>
            </div>
            <div>
              <dt className="eyebrow">Sold</dt>
              <dd className="mt-1 font-serif text-[24px] tabular-nums">{int(row.units)}</dd>
            </div>
            <div>
              <dt className="eyebrow">Orders</dt>
              <dd className="mt-1 font-serif text-[24px] tabular-nums">{int(row.orders)}</dd>
            </div>
          </dl>
          <p className="text-[13px] text-text-2">
            {row.last_sold_at
              ? `Last sold ${ago(row.last_sold_at, today).toLowerCase()} (${shortDate(row.last_sold_at)}).`
              : 'This product has not sold yet.'}
          </p>

          {detail.variants.length > 0 && (
            <section aria-label="Variants" className="space-y-2 border-t pt-5">
              <div className="flex items-baseline justify-between">
                <Eyebrow>Variants</Eyebrow>
                <span className="font-mono text-xs text-text-2">{detail.variants.length}</span>
              </div>
              <ul className="divide-y rounded-xl border">
                {detail.variants.map((v, i) => (
                  <li
                    key={v.external_id || i}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[15px]">
                        {Object.values(v.attributes).join(' / ') || v.sku || `Variant ${i + 1}`}
                      </div>
                      {v.sku && <div className="font-mono text-xs text-text-2">{v.sku}</div>}
                    </div>
                    <div className="shrink-0 text-right tabular-nums">
                      {v.price != null ? money(v.price, 'GBP', 2) : '—'}
                      {v.stock != null && (
                        <div className="text-[13px] text-text-2">{int(v.stock)} in stock</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <ProductInsights product={detail} sales={{ revenue: row.revenue, units: row.units }} />

          <section aria-label="Details" className="space-y-2 border-t pt-5">
            <Eyebrow>Details</Eyebrow>
            <dl className="space-y-1.5 text-[14px]">
              {(
                [
                  ['Added', shortDate(detail.created_at)],
                  ['URL slug', detail.url_slug ?? '—'],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-text-2">{label}</dt>
                  <dd className="truncate text-right font-mono">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}
    </Drawer>
  );
}
