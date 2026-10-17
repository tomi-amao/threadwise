/**
 * Mock data + pure helpers for the Collections v2 preview.
 * Frontend only: nothing here talks to Supabase or the AI agent.
 */

export type Status = 'active' | 'planned' | 'completed' | 'draft';
export type Collab = 'in_house' | 'consignment' | 'revenue_share';

export interface Product {
  id: string;
  name: string;
  sku: string;
  price: number;
  units: number;
}

export interface Cost {
  id: string;
  vendor: string;
  category: string;
  date: string;
  amount: number;
  note: string;
}

export interface PlanLine {
  id: string;
  name: string;
  qty: number;
  unitCost: number;
  price: number;
  sellThrough: number;
}

export interface PlanCost {
  id: string;
  category: string;
  amount: number | null;
}

export interface Plan {
  collab: Collab;
  partner: string;
  sharePct: number;
  lines: PlanLine[];
  costs: PlanCost[];
}

export interface Collection {
  id: string;
  name: string;
  type: string;
  status: Status;
  ref: string;
  launchDate: string | null;
  budget: number | null;
  /** weekly revenue, oldest → newest */
  weekly: number[];
  products: Product[];
  costs: Cost[];
  plan: Plan | null;
}

export const COST_CATEGORIES = [
  'Fabric & materials',
  'Manufacturing',
  'Freight in',
  'Outbound shipping',
  'Photography',
  'Marketing',
  'Gifting',
  'Packaging',
];

export const COLLAB_LABEL: Record<Collab, string> = {
  in_house: 'In-house',
  consignment: 'Consignment',
  revenue_share: 'Revenue share',
};

export const CATALOG: Omit<Product, 'units'>[] = [
  { id: 'cat-1', name: 'Heavy Knit Cardigan', sku: 'KN-0412', price: 98 },
  { id: 'cat-2', name: 'Wool Overshirt', sku: 'OS-0220', price: 124 },
  { id: 'cat-3', name: 'Rib Beanie', sku: 'AC-0108', price: 28 },
  { id: 'cat-4', name: 'Brushed Cotton Tee', sku: 'TS-0031', price: 42 },
  { id: 'cat-5', name: 'Selvedge Work Trouser', sku: 'TR-0507', price: 135 },
  { id: 'cat-6', name: 'Linen Camp Shirt', sku: 'SH-0614', price: 76 },
  { id: 'cat-7', name: 'Canvas Tote', sku: 'AC-0044', price: 36 },
  { id: 'cat-8', name: 'Merino Scarf', sku: 'AC-0150', price: 58 },
];

/* ── Helpers ─────────────────────────────────────────── */

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function stats(c: Collection) {
  const units = sum(c.products.map(p => p.units));
  const revenue = sum(c.products.map(p => p.units * p.price));
  const cost = sum(c.costs.map(x => x.amount));
  const profit = revenue - cost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : null;
  const orders = Math.round(units * 0.72);
  const budgetUsed = c.budget ? cost / c.budget : null;
  return { units, revenue, cost, profit, margin, orders, budgetUsed };
}

export function costByCategory(costs: Cost[]) {
  const map = new Map<string, number>();
  for (const c of costs) map.set(c.category, (map.get(c.category) ?? 0) + c.amount);
  return [...map.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

/** Scenario multipliers applied to each line's sell-through. */
export const SCENARIOS = [
  { id: 'cautious', label: 'Cautious', factor: 0.7 },
  { id: 'expected', label: 'Expected', factor: 1 },
  { id: 'strong', label: 'Strong', factor: 1.25 },
] as const;
export type ScenarioId = (typeof SCENARIOS)[number]['id'];

export function projectPlan(plan: Plan, scenario: ScenarioId) {
  const factor = SCENARIOS.find(s => s.id === scenario)!.factor;
  const lines = plan.lines.map(l => {
    const st = Math.min(100, l.sellThrough * factor);
    const revenue = l.qty * (st / 100) * l.price;
    const cogs = l.qty * l.unitCost;
    return { ...l, effectiveSellThrough: st, revenue, cogs };
  });
  const revenue = sum(lines.map(l => l.revenue));
  const cogs = sum(lines.map(l => l.cogs));
  const other = sum(plan.costs.map(c => c.amount ?? 0));
  const tbd = plan.costs.filter(c => c.amount == null).length;
  const profit = revenue - cogs - other;
  const payout = plan.collab === 'in_house' ? 0 : (plan.sharePct / 100) * Math.max(profit, 0);
  const net = profit - payout;
  const margin = revenue > 0 ? (net / revenue) * 100 : null;
  return { lines, revenue, cogs, other, tbd, profit, payout, net, margin };
}

/** Spread a total across weights so the series sums exactly to the total. */
function distribute(total: number, weights: number[]) {
  const w = sum(weights);
  const out = weights.map(x => Math.round((x / w) * total));
  out[out.length - 1] += total - sum(out);
  return out;
}

/* ── Seed data ───────────────────────────────────────── */

function mk(partial: Omit<Collection, 'weekly'> & { curve: number[] }): Collection {
  const { curve, ...rest } = partial;
  const revenue = sum(rest.products.map(p => p.units * p.price));
  return { ...rest, weekly: revenue > 0 ? distribute(revenue, curve) : [] };
}

export const SEED: Collection[] = [
  mk({
    id: 'autumn-layers',
    name: 'Autumn Layers 26',
    type: 'Seasonal',
    status: 'active',
    ref: 'AL-26',
    launchDate: '2026-09-12',
    budget: 18000,
    curve: [9, 14, 12, 10, 8, 7, 6],
    products: [
      { id: 'p1', name: 'Heavy Knit Cardigan', sku: 'KN-0412', price: 98, units: 142 },
      { id: 'p2', name: 'Wool Overshirt', sku: 'OS-0220', price: 124, units: 96 },
      { id: 'p3', name: 'Rib Beanie', sku: 'AC-0108', price: 28, units: 188 },
      { id: 'p4', name: 'Merino Scarf', sku: 'AC-0150', price: 58, units: 74 },
      { id: 'p5', name: 'Selvedge Work Trouser', sku: 'TR-0507', price: 135, units: 61 },
    ],
    costs: [
      {
        id: 'c1',
        vendor: 'Mill & Loom Ltd',
        category: 'Fabric & materials',
        date: '2026-07-02',
        amount: 5400,
        note: 'Wool and cotton, first run',
      },
      {
        id: 'c2',
        vendor: 'Porto Knitwear',
        category: 'Manufacturing',
        date: '2026-07-28',
        amount: 6200,
        note: 'Cut, make and trim',
      },
      {
        id: 'c3',
        vendor: 'DHL Freight',
        category: 'Freight in',
        date: '2026-08-19',
        amount: 840,
        note: 'Pallet from Porto',
      },
      {
        id: 'c4',
        vendor: 'Studio Nine',
        category: 'Photography',
        date: '2026-08-30',
        amount: 1200,
        note: 'Lookbook day',
      },
      {
        id: 'c5',
        vendor: 'Meta Ads',
        category: 'Marketing',
        date: '2026-09-15',
        amount: 1650,
        note: 'Launch fortnight',
      },
    ],
    plan: {
      collab: 'in_house',
      partner: '',
      sharePct: 0,
      lines: [
        {
          id: 'l1',
          name: 'Heavy Knit Cardigan',
          qty: 220,
          unitCost: 31,
          price: 98,
          sellThrough: 80,
        },
        { id: 'l2', name: 'Wool Overshirt', qty: 150, unitCost: 42, price: 124, sellThrough: 75 },
        { id: 'l3', name: 'Rib Beanie', qty: 300, unitCost: 6.5, price: 28, sellThrough: 85 },
      ],
      costs: [
        { id: 'pc1', category: 'Freight in', amount: 840 },
        { id: 'pc2', category: 'Outbound shipping', amount: 1900 },
        { id: 'pc3', category: 'Gifting', amount: null },
      ],
    },
  }),
  mk({
    id: 'marlowe',
    name: 'Atelier × Marlowe',
    type: 'Collaboration',
    status: 'active',
    ref: 'AM-26',
    launchDate: '2026-09-26',
    budget: 24000,
    curve: [18, 15, 11, 8],
    products: [
      { id: 'p1', name: 'Canvas Tote', sku: 'AC-0044', price: 36, units: 210 },
      { id: 'p2', name: 'Brushed Cotton Tee', sku: 'TS-0031', price: 42, units: 155 },
      { id: 'p3', name: 'Linen Camp Shirt', sku: 'SH-0614', price: 76, units: 88 },
    ],
    costs: [
      {
        id: 'c1',
        vendor: 'Marlowe Studio',
        category: 'Manufacturing',
        date: '2026-08-04',
        amount: 7800,
        note: 'Deposit, 50%',
      },
      {
        id: 'c2',
        vendor: 'Hush Print Co',
        category: 'Packaging',
        date: '2026-09-01',
        amount: 920,
        note: 'Co-branded mailers',
      },
      {
        id: 'c3',
        vendor: 'Meta Ads',
        category: 'Marketing',
        date: '2026-09-27',
        amount: 2100,
        note: '',
      },
    ],
    plan: {
      collab: 'revenue_share',
      partner: 'Marlowe Studio',
      sharePct: 30,
      lines: [
        { id: 'l1', name: 'Canvas Tote', qty: 400, unitCost: 9, price: 36, sellThrough: 70 },
        {
          id: 'l2',
          name: 'Brushed Cotton Tee',
          qty: 300,
          unitCost: 13,
          price: 42,
          sellThrough: 75,
        },
        { id: 'l3', name: 'Linen Camp Shirt', qty: 200, unitCost: 24, price: 76, sellThrough: 60 },
      ],
      costs: [
        { id: 'pc1', category: 'Freight in', amount: 600 },
        { id: 'pc2', category: 'Outbound shipping', amount: 1400 },
        { id: 'pc3', category: 'Gifting', amount: 300 },
      ],
    },
  }),
  mk({
    id: 'winter-capsule',
    name: 'Winter Capsule',
    type: 'Capsule',
    status: 'planned',
    ref: 'WC-26',
    launchDate: '2026-11-14',
    budget: 12000,
    curve: [1],
    products: [],
    costs: [
      {
        id: 'c1',
        vendor: 'Mill & Loom Ltd',
        category: 'Fabric & materials',
        date: '2026-09-30',
        amount: 2400,
        note: 'Deposit on shearling',
      },
      {
        id: 'c2',
        vendor: 'Studio Nine',
        category: 'Photography',
        date: '2026-10-05',
        amount: 700,
        note: 'Booking fee',
      },
    ],
    plan: {
      collab: 'in_house',
      partner: '',
      sharePct: 0,
      lines: [
        {
          id: 'l1',
          name: 'Shearling Collar Jacket',
          qty: 120,
          unitCost: 88,
          price: 285,
          sellThrough: 70,
        },
        { id: 'l2', name: 'Merino Scarf', qty: 200, unitCost: 15, price: 58, sellThrough: 90 },
      ],
      costs: [
        { id: 'pc1', category: 'Freight in', amount: null },
        { id: 'pc2', category: 'Outbound shipping', amount: null },
        { id: 'pc3', category: 'Gifting', amount: null },
      ],
    },
  }),
  mk({
    id: 'summer-linen',
    name: 'Summer Linen 26',
    type: 'Seasonal',
    status: 'completed',
    ref: 'SL-26',
    launchDate: '2026-04-18',
    budget: 30000,
    curve: [6, 11, 14, 15, 14, 12, 10, 8, 6, 4],
    products: [
      { id: 'p1', name: 'Linen Camp Shirt', sku: 'SH-0614', price: 76, units: 320 },
      { id: 'p2', name: 'Linen Drawstring Trouser', sku: 'TR-0188', price: 88, units: 244 },
      { id: 'p3', name: 'Canvas Tote', sku: 'AC-0044', price: 36, units: 410 },
      { id: 'p4', name: 'Brushed Cotton Tee', sku: 'TS-0031', price: 42, units: 360 },
    ],
    costs: [
      {
        id: 'c1',
        vendor: 'Mill & Loom Ltd',
        category: 'Fabric & materials',
        date: '2026-02-11',
        amount: 9800,
        note: '',
      },
      {
        id: 'c2',
        vendor: 'Porto Knitwear',
        category: 'Manufacturing',
        date: '2026-03-02',
        amount: 14200,
        note: '',
      },
      {
        id: 'c3',
        vendor: 'DHL Freight',
        category: 'Freight in',
        date: '2026-03-28',
        amount: 1700,
        note: '',
      },
      {
        id: 'c4',
        vendor: 'Meta Ads',
        category: 'Marketing',
        date: '2026-04-20',
        amount: 5700,
        note: 'Spring and early summer',
      },
    ],
    plan: null,
  }),
  mk({
    id: 'archive-sale',
    name: 'Archive Sale',
    type: 'Clearance',
    status: 'completed',
    ref: 'AS-26',
    launchDate: '2026-01-10',
    budget: 6000,
    curve: [20, 14, 8, 4],
    products: [
      { id: 'p1', name: 'Wool Overshirt', sku: 'OS-0220', price: 62, units: 120 },
      { id: 'p2', name: 'Rib Beanie', sku: 'AC-0108', price: 14, units: 220 },
      { id: 'p3', name: 'Heavy Knit Cardigan', sku: 'KN-0412', price: 49, units: 36 },
    ],
    costs: [
      {
        id: 'c1',
        vendor: 'Sendcloud',
        category: 'Outbound shipping',
        date: '2026-01-31',
        amount: 2200,
        note: 'Free shipping promo',
      },
      {
        id: 'c2',
        vendor: 'Meta Ads',
        category: 'Marketing',
        date: '2026-01-12',
        amount: 3900,
        note: '',
      },
      {
        id: 'c3',
        vendor: 'Hush Print Co',
        category: 'Packaging',
        date: '2026-01-05',
        amount: 840,
        note: '',
      },
    ],
    plan: null,
  }),
  mk({
    id: 'spring-basics',
    name: 'Spring Basics',
    type: 'Core range',
    status: 'draft',
    ref: '',
    launchDate: null,
    budget: null,
    curve: [1],
    products: [],
    costs: [],
    plan: null,
  }),
];
