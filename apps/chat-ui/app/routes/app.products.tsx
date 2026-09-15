/**
 * Products Route (Protected)
 *
 * Product performance analytics with a slide-over detail panel
 * showing images, variant info, and AI-powered insights.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData, Link } from 'react-router';
import {
  Package,
  TrendUp,
  CurrencyGbp,
  ShoppingBag,
  X,
  CaretLeft,
  CaretRight,
  Image as ImageIcon,
  Sparkle,
  Lightning,
  Megaphone,
  ChartLineUp,
  ArrowSquareOut,
  MagnifyingGlass,
  Spinner,
  Tag,
} from 'phosphor-react';
import { getServerSupabaseClient } from '~/lib/supabase';

export const meta: MetaFunction = () => [
  { title: 'Products - ThreadWise' },
  { name: 'description', content: 'Product performance analytics' },
];

// ─── Types ────────────────────────────────────────────────────────────

interface ProductImage {
  id: string;
  url: string;
  altText: string | null;
  orderIndex: number;
}

interface ProductVariant {
  externalId: string;
  sku: string | null;
  price: number | null;
  stock: number | null;
  attributes: Record<string, string>;
}

interface ProductDetail {
  id: string;
  name: string;
  provider: string | null;
  status: string;
  productType: string | null;
  description: string | null;
  urlSlug: string | null;
  images: ProductImage[];
  variants: ProductVariant[];
  createdAt: string;
}

interface ProductRow {
  id: string | null;
  name: string;
  totalQuantity: number;
  totalRevenue: number;
  orderCount: number;
  avgPrice: number;
  /** Thumbnail from product metadata for inline display */
  thumbnailUrl: string | null;
}

// ─── Loader ───────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const supabase = getServerSupabaseClient();

  const [{ data: lineItems }, { data: productsRaw }] = await Promise.all([
    supabase
      .from('order_line_items')
      .select(
        'product_id, product_name, quantity, total_price_amount, unit_price_amount, order_id'
      ),
    supabase
      .from('products')
      .select('id, name, provider, status, product_type, metadata, variants, created_at')
      .neq('status', 'archived')
      .order('name'),
  ]);

  // Build product detail map
  const productDetailMap = new Map<string, ProductDetail>();
  for (const p of productsRaw || []) {
    const meta = (p as any).metadata ?? {};
    const images: ProductImage[] = Array.isArray(meta.images)
      ? meta.images
          .map((img: any, index: number) => {
            if (typeof img === 'string') {
              const normalizedUrl = img.trim();
              return {
                id: `image-${index}`,
                url: normalizedUrl,
                altText: null,
                orderIndex: index,
              };
            }

            const normalizedUrl =
              typeof img?.url === 'string'
                ? img.url.trim()
                : typeof img?.src === 'string'
                  ? img.src.trim()
                  : '';

            return {
              id: img?.id ?? `image-${index}`,
              url: normalizedUrl,
              altText:
                typeof img?.altText === 'string'
                  ? img.altText
                  : typeof img?.alt_text === 'string'
                    ? img.alt_text
                    : null,
              orderIndex:
                typeof img?.orderIndex === 'number'
                  ? img.orderIndex
                  : typeof img?.position === 'number'
                    ? img.position
                    : index,
            };
          })
          .filter((img: ProductImage) => img.url.length > 0)
          .sort((a: ProductImage, b: ProductImage) => a.orderIndex - b.orderIndex)
      : [];

    const variantsRaw = Array.isArray((p as any).variants) ? (p as any).variants : [];
    const variants: ProductVariant[] = variantsRaw.map((v: any) => ({
      externalId: v.external_id ?? '',
      sku: v.sku ?? null,
      price: v.price?.amount != null ? Number(v.price.amount) : null,
      stock: v.stock != null ? Number(v.stock) : null,
      attributes: v.attributes ?? {},
    }));

    productDetailMap.set(p.id, {
      id: p.id,
      name: p.name || 'Unnamed Product',
      provider: p.provider ?? null,
      status: p.status,
      productType: p.product_type ?? null,
      description: meta.description ?? meta.seo?.description ?? null,
      urlSlug: meta.url_slug ?? null,
      images,
      variants,
      createdAt: p.created_at,
    });
  }

  // Aggregate line items
  const salesMap = new Map<
    string,
    {
      id: string | null;
      name: string;
      qty: number;
      revenue: number;
      totalUnitPrice: number;
      priceCount: number;
      orders: Set<string>;
    }
  >();

  for (const item of lineItems || []) {
    const key = (item as any).product_name || 'Unknown';
    const existing = salesMap.get(key) || {
      id: (item as any).product_id,
      name: key,
      qty: 0,
      revenue: 0,
      totalUnitPrice: 0,
      priceCount: 0,
      orders: new Set<string>(),
    };
    existing.qty += Number((item as any).quantity || 0);
    existing.revenue += Number((item as any).total_price_amount || 0);
    existing.totalUnitPrice += Number((item as any).unit_price_amount || 0);
    existing.priceCount += 1;
    existing.orders.add((item as any).order_id);
    salesMap.set(key, existing);
  }

  const products: ProductRow[] = Array.from(salesMap.values())
    .map(p => {
      const detail = p.id ? productDetailMap.get(p.id) : null;
      return {
        id: p.id,
        name: p.name,
        totalQuantity: p.qty,
        totalRevenue: p.revenue,
        orderCount: p.orders.size,
        avgPrice: p.priceCount > 0 ? p.totalUnitPrice / p.priceCount : 0,
        thumbnailUrl: detail?.images[0]?.url ?? null,
      };
    })
    .sort((a, b) => b.totalRevenue - a.totalRevenue);

  const totalRevenue = products.reduce((s, p) => s + p.totalRevenue, 0);
  const totalQuantity = products.reduce((s, p) => s + p.totalQuantity, 0);

  // Convert productDetailMap to serializable array
  const productDetails: ProductDetail[] = Array.from(productDetailMap.values());

  return { products, totalRevenue, totalQuantity, productDetails };
}

// ─── Helpers ──────────────────────────────────────────────────────────

const GBP = (v: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(v);

const GBP2 = (v: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);

function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return import.meta.env?.VITE_LANGGRAPH_API_URL || 'http://localhost:2024';
  }
  return 'http://localhost:2024';
}

function getAssistantId(): string {
  if (typeof window !== 'undefined') {
    return import.meta.env?.VITE_LANGGRAPH_ASSISTANT_ID || 'threadwise-financial-agent';
  }
  return 'threadwise-financial-agent';
}

// ─── AI Insight Types ─────────────────────────────────────────────────

interface InsightConfig {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  prompt: (product: ProductDetail, revenue?: number, qty?: number) => string;
}

const INSIGHTS: InsightConfig[] = [
  {
    id: 'pricing',
    label: 'Pricing Analysis',
    description: 'Optimize pricing strategy based on sales data',
    icon: <ChartLineUp size={16} weight="duotone" />,
    color: 'emerald',
    prompt: (p, rev, qty) =>
      `Analyze the pricing strategy for "${p.name}". It has ${p.variants.length} variant(s) with prices: ${p.variants.map(v => `${Object.values(v.attributes).join('/') || v.sku || 'default'}: ${v.price != null ? `£${v.price}` : 'N/A'}`).join(', ')}. Total revenue: £${rev?.toFixed(2) ?? 'unknown'}, units sold: ${qty ?? 'unknown'}. Suggest pricing optimizations, competitive positioning, and potential margin improvements. Be concise and actionable.`,
  },
  {
    id: 'demand',
    label: 'Demand Forecast',
    description: 'Predict future demand & sales trends',
    icon: <TrendUp size={16} weight="duotone" />,
    color: 'blue',
    prompt: (p, rev, qty) =>
      `Forecast demand for "${p.name}". Current data: ${qty ?? 0} units sold generating £${rev?.toFixed(2) ?? '0'} revenue across ${p.variants.length} variant(s). Product type: ${p.productType || 'general'}. Provider: ${p.provider || 'unknown'}. Based on this, predict demand trends, identify seasonality, and recommend inventory stocking levels. Be concise.`,
  },
  {
    id: 'marketing',
    label: 'Marketing Copy',
    description: 'Generate compelling product descriptions',
    icon: <Megaphone size={16} weight="duotone" />,
    color: 'violet',
    prompt: p =>
      `Write a compelling product description and three variations of marketing copy for "${p.name}". Product type: ${p.productType || 'general'}. Variants: ${p.variants.map(v => Object.values(v.attributes).join('/') || v.sku || 'default').join(', ')}. ${p.description ? `Current description: "${p.description}".` : ''} Provide a main description plus three short social-media-ready captions. Be creative and brand-aware.`,
  },
];

// ─── Image Gallery ────────────────────────────────────────────────────

function ImageGallery({ images }: { images: ProductImage[] }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [imageError, setImageError] = useState<Set<number>>(new Set());

  useEffect(() => {
    setCurrentIndex(0);
    setImageError(new Set());
  }, [images]);

  if (images.length === 0) {
    return (
      <div className="aspect-square bg-muted/30 rounded-xl flex flex-col items-center justify-center gap-2">
        <ImageIcon size={40} weight="thin" className="text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground/50">No images available</p>
      </div>
    );
  }

  const hasError = imageError.has(currentIndex);

  return (
    <div className="space-y-2">
      {/* Main image */}
      <div className="relative aspect-square bg-muted/10 rounded-xl overflow-hidden group">
        {hasError ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-muted/20">
            <ImageIcon size={32} weight="thin" className="text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground/50">Failed to load</p>
          </div>
        ) : (
          <img
            src={images[currentIndex].url}
            alt={images[currentIndex].altText || 'Product image'}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            onError={() => setImageError(prev => new Set(prev).add(currentIndex))}
          />
        )}
        {images.length > 1 && (
          <>
            <button
              onClick={() => setCurrentIndex(i => (i - 1 + images.length) % images.length)}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/50 backdrop-blur-sm text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
            >
              <CaretLeft size={14} weight="bold" />
            </button>
            <button
              onClick={() => setCurrentIndex(i => (i + 1) % images.length)}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/50 backdrop-blur-sm text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
            >
              <CaretRight size={14} weight="bold" />
            </button>
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1">
              {images.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentIndex(i)}
                  className={`w-1.5 h-1.5 rounded-full transition-all ${i === currentIndex ? 'bg-white w-3' : 'bg-white/50 hover:bg-white/70'}`}
                />
              ))}
            </div>
          </>
        )}
      </div>
      {/* Thumbnails */}
      {images.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {images.slice(0, 6).map((img, i) => (
            <button
              key={img.id || i}
              onClick={() => setCurrentIndex(i)}
              className={`w-12 h-12 rounded-lg overflow-hidden shrink-0 border-2 transition-colors ${i === currentIndex ? 'border-primary' : 'border-transparent hover:border-muted-foreground/30'}`}
            >
              <img
                src={img.url}
                alt={img.altText || ''}
                className="w-full h-full object-cover"
                onError={e => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </button>
          ))}
          {images.length > 6 && (
            <div className="w-12 h-12 rounded-lg bg-muted/30 flex items-center justify-center shrink-0 text-xs text-muted-foreground">
              +{images.length - 6}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── AI Insight Button ────────────────────────────────────────────────

function AIInsightButton({
  insight,
  product,
  revenue,
  quantity,
}: {
  insight: InsightConfig;
  product: ProductDetail;
  revenue?: number;
  quantity?: number;
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const colorClasses: Record<
    string,
    { bg: string; text: string; border: string; hoverBg: string }
  > = {
    emerald: {
      bg: 'bg-emerald-500/10',
      text: 'text-emerald-400',
      border: 'border-emerald-500/20',
      hoverBg: 'hover:bg-emerald-500/15',
    },
    blue: {
      bg: 'bg-blue-500/10',
      text: 'text-blue-400',
      border: 'border-blue-500/20',
      hoverBg: 'hover:bg-blue-500/15',
    },
    violet: {
      bg: 'bg-violet-500/10',
      text: 'text-violet-400',
      border: 'border-violet-500/20',
      hoverBg: 'hover:bg-violet-500/15',
    },
  };
  const c = colorClasses[insight.color] || colorClasses.emerald;

  const handleClick = useCallback(async () => {
    if (result) {
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const apiUrl = getApiBaseUrl();
      const assistantId = getAssistantId();
      const prompt = insight.prompt(product, revenue, quantity);

      // Create a thread, then run a stateless request
      const threadRes = await fetch(`${apiUrl}/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!threadRes.ok) throw new Error('Failed to create thread');
      const thread = await threadRes.json();

      const runRes = await fetch(`${apiUrl}/threads/${thread.thread_id}/runs/wait`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant_id: assistantId,
          input: {
            messages: [{ role: 'user', content: prompt }],
          },
        }),
      });
      if (!runRes.ok) throw new Error('AI request failed');
      const runData = await runRes.json();

      // Extract the last assistant message
      const messages = runData.messages || runData.values?.messages || [];
      const lastAI = [...messages]
        .reverse()
        .find((m: any) => m.type === 'ai' || m.role === 'assistant');
      setResult(lastAI?.content || lastAI?.text || 'No response generated.');
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [insight, product, revenue, quantity, result]);

  return (
    <div className="space-y-2">
      <button
        onClick={handleClick}
        disabled={loading}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border ${c.border} ${c.bg} ${c.hoverBg} transition-all text-left group disabled:opacity-70`}
      >
        <div className={`${c.text} shrink-0`}>
          {loading ? <Spinner size={16} className="animate-spin" /> : insight.icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium ${c.text}`}>{insight.label}</p>
          <p className="text-[11px] text-muted-foreground">{insight.description}</p>
        </div>
        <Sparkle
          size={12}
          className={`${c.text} opacity-50 group-hover:opacity-100 transition-opacity shrink-0`}
        />
      </button>
      {error && (
        <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-400">
          {error}
        </div>
      )}
      {result && (
        <div className="px-3 py-3 rounded-lg bg-muted/30 border border-border text-sm text-foreground leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto">
          {result}
        </div>
      )}
    </div>
  );
}

// ─── Product Detail Sheet ─────────────────────────────────────────────

function ProductDetailSheet({
  product,
  salesData,
  onClose,
}: {
  product: ProductDetail;
  salesData: { revenue: number; quantity: number; orders: number } | null;
  onClose: () => void;
}) {
  const providerBadge =
    product.provider === 'squarespace'
      ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
      : product.provider === 'invoice'
        ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
        : 'bg-muted text-muted-foreground border-border';

  const statusBadge =
    product.status === 'active' || product.status === 'ACTIVE'
      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
      : 'bg-muted text-muted-foreground border-border';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full z-50 w-full max-w-lg bg-card border-l border-border shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border bg-card/95 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${providerBadge}`}
              >
                {product.provider ?? 'unknown'}
              </span>
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${statusBadge}`}
              >
                {product.status}
              </span>
              {product.productType && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border font-medium">
                  {product.productType}
                </span>
              )}
            </div>
            <h2 className="mt-1.5 text-base font-semibold text-foreground leading-snug">
              {product.name}
            </h2>
            {product.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {product.description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Image gallery */}
          <ImageGallery images={product.images} />

          {/* Sales stats (if available) */}
          {salesData && (
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-muted/20 border border-border p-3 text-center">
                <p className="text-lg font-bold text-foreground tabular-nums">
                  {GBP(salesData.revenue)}
                </p>
                <p className="text-[11px] text-muted-foreground">Revenue</p>
              </div>
              <div className="rounded-lg bg-muted/20 border border-border p-3 text-center">
                <p className="text-lg font-bold text-foreground tabular-nums">
                  {salesData.quantity.toLocaleString()}
                </p>
                <p className="text-[11px] text-muted-foreground">Sold</p>
              </div>
              <div className="rounded-lg bg-muted/20 border border-border p-3 text-center">
                <p className="text-lg font-bold text-foreground tabular-nums">{salesData.orders}</p>
                <p className="text-[11px] text-muted-foreground">Orders</p>
              </div>
            </div>
          )}

          {/* Variants */}
          {product.variants.length > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Variants ({product.variants.length})
              </h3>
              <div className="rounded-lg border border-border divide-y divide-border/60 overflow-hidden">
                {product.variants.map((v, i) => {
                  const attrStr =
                    Object.values(v.attributes).join(' / ') || v.sku || `Variant ${i + 1}`;
                  return (
                    <div
                      key={v.externalId || i}
                      className="flex items-center justify-between px-3 py-2.5 hover:bg-muted/10 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-foreground font-medium truncate">{attrStr}</p>
                        {v.sku && (
                          <p className="text-[11px] text-muted-foreground font-mono">{v.sku}</p>
                        )}
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <p className="text-sm font-medium text-foreground tabular-nums">
                          {v.price != null ? GBP2(v.price) : '\u2014'}
                        </p>
                        {v.stock != null && (
                          <p className="text-[11px] text-muted-foreground">{v.stock} in stock</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* AI Insights */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Sparkle size={14} className="text-primary" weight="fill" />
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                AI Insights
              </h3>
            </div>
            <div className="space-y-2">
              {INSIGHTS.map(insight => (
                <AIInsightButton
                  key={insight.id}
                  insight={insight}
                  product={product}
                  revenue={salesData?.revenue}
                  quantity={salesData?.quantity}
                />
              ))}
            </div>
          </section>

          {/* Details */}
          <section>
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Details
            </h3>
            <dl className="space-y-1.5 text-xs">
              {(
                [
                  [
                    'Created',
                    new Date(product.createdAt).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }),
                  ],
                  ['URL Slug', product.urlSlug || '\u2014'],
                  ['Product ID', product.id],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt className="text-muted-foreground shrink-0">{label}</dt>
                  <dd className="text-foreground text-right font-mono truncate max-w-[280px]">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────

export default function ProductsPage() {
  const { products, totalRevenue, totalQuantity, productDetails } = useLoaderData<typeof loader>();
  const maxRevenue = products.length > 0 ? products[0].totalRevenue : 1;

  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const productDetailMap = useMemo(() => {
    const m = new Map<string, ProductDetail>();
    for (const d of productDetails) m.set(d.id, d);
    return m;
  }, [productDetails]);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return products;
    return products.filter(p => p.name.toLowerCase().includes(q));
  }, [products, searchQuery]);

  const selectedDetail = selectedProductId
    ? (productDetailMap.get(selectedProductId) ?? null)
    : null;
  const selectedSales = selectedProductId
    ? (() => {
        const p = products.find(pr => pr.id === selectedProductId);
        return p
          ? { revenue: p.totalRevenue, quantity: p.totalQuantity, orders: p.orderCount }
          : null;
      })()
    : null;

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* Sticky Header */}
      <header className="border-b border-border bg-card/95 backdrop-blur-sm sticky top-0 z-40">
        <div className="px-4 md:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-foreground">Products</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {products.length} products &middot; {totalQuantity.toLocaleString()} units sold
                &middot; {GBP(totalRevenue)} revenue
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="px-4 md:px-6 lg:px-8 py-6 space-y-5">
        {/* KPI Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Package size={16} className="text-primary" />
              </div>
            </div>
            <p className="text-2xl font-bold text-foreground tabular-nums">{products.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Total Products</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <ShoppingBag size={16} className="text-emerald-500" />
              </div>
            </div>
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {totalQuantity.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Units Sold</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <CurrencyGbp size={16} className="text-blue-500" />
              </div>
            </div>
            <p className="text-2xl font-bold text-foreground tabular-nums">{GBP(totalRevenue)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Total Revenue</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <Tag size={16} className="text-amber-500" />
              </div>
            </div>
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {products.length > 0 ? GBP(totalRevenue / products.length) : GBP(0)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Avg Revenue</p>
          </div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-xs">
            <MagnifyingGlass
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <input
              type="text"
              placeholder="Search products\u2026"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-card border border-border rounded-lg pl-7 pr-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <span className="text-xs text-muted-foreground">{filteredProducts.length} products</span>
        </div>

        {/* Products Table */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-5 py-3 w-8">
                    #
                  </th>
                  <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-3 py-3">
                    Product
                  </th>
                  <th className="text-right text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-3 py-3">
                    Qty
                  </th>
                  <th className="text-right text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-3 py-3">
                    Orders
                  </th>
                  <th className="text-right text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-3 py-3">
                    Avg Price
                  </th>
                  <th className="text-right text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-3 py-3">
                    Revenue
                  </th>
                  <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-5 py-3 w-36">
                    Share
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((product, i) => {
                  const pct = totalRevenue > 0 ? (product.totalRevenue / totalRevenue) * 100 : 0;
                  const hasDetail = product.id && productDetailMap.has(product.id);
                  return (
                    <tr
                      key={product.id || product.name}
                      onClick={() => {
                        if (product.id && hasDetail) setSelectedProductId(product.id);
                      }}
                      className={`border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors ${hasDetail ? 'cursor-pointer' : ''}`}
                    >
                      <td className="px-5 py-3 text-muted-foreground text-xs">{i + 1}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2.5">
                          {product.thumbnailUrl ? (
                            <img
                              src={product.thumbnailUrl}
                              alt=""
                              className="w-8 h-8 rounded-lg object-cover shrink-0"
                              onError={e => {
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                              <Package size={14} className="text-primary" weight="duotone" />
                            </div>
                          )}
                          <span className="text-foreground truncate max-w-[250px] font-medium">
                            {product.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right text-foreground tabular-nums">
                        {product.totalQuantity.toLocaleString()}
                      </td>
                      <td className="px-3 py-3 text-right text-muted-foreground tabular-nums">
                        {product.orderCount.toLocaleString()}
                      </td>
                      <td className="px-3 py-3 text-right text-muted-foreground tabular-nums">
                        {GBP(product.avgPrice)}
                      </td>
                      <td className="px-3 py-3 text-right font-semibold text-foreground tabular-nums">
                        {GBP(product.totalRevenue)}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary/60 rounded-full"
                              style={{ width: `${(product.totalRevenue / maxRevenue) * 100}%` }}
                            />
                          </div>
                          <span className="text-[11px] text-muted-foreground w-10 text-right tabular-nums">
                            {pct.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      <td className="pr-3">
                        {hasDetail && (
                          <ArrowSquareOut
                            size={14}
                            className="text-muted-foreground/40 group-hover:text-primary"
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* Detail panel */}
      {selectedDetail && (
        <ProductDetailSheet
          product={selectedDetail}
          salesData={selectedSales}
          onClose={() => setSelectedProductId(null)}
        />
      )}
    </div>
  );
}
