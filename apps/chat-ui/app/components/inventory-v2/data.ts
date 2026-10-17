/**
 * Mock data + derivations for the Inventory v2 preview.
 * Stock, movements and valuation are all derived from one item list, so a gift
 * or write-off recorded in the UI flows through every tab.
 */

export type ItemType = 'sellable' | 'sample' | 'material';
export type StockState = 'unlimited' | 'oversold' | 'out' | 'low' | 'in';

export interface Item {
  id: string;
  productId: string | null;
  productName: string | null;
  sku: string;
  attributes: Record<string, string>;
  provider: 'shopify' | 'squarespace' | 'invoice';
  itemType: ItemType;
  unitCost: number;
  sellingPrice: number | null;
  isUnlimited: boolean;
  purchased: number;
  sold: number;
  refunded: number;
  gifted: number;
  writtenOff: number;
}

export interface Movement {
  id: string;
  itemId: string;
  type: 'PURCHASE' | 'SALE' | 'REFUND' | 'GIFT' | 'WRITE_OFF';
  /** Signed: positive adds stock, negative removes it. */
  quantity: number;
  unitCost: number;
  reference: string | null;
  notes: string | null;
  date: string;
}

export const PRODUCTS = [
  { id: 'pr1', name: 'Heavy Knit Cardigan' },
  { id: 'pr2', name: 'Wool Overshirt' },
  { id: 'pr3', name: 'Selvedge Work Trouser' },
  { id: 'pr4', name: 'Linen Camp Shirt' },
  { id: 'pr5', name: 'Merino Scarf' },
  { id: 'pr6', name: 'Brushed Cotton Tee' },
  { id: 'pr7', name: 'Canvas Tote' },
  { id: 'pr8', name: 'Rib Beanie' },
  { id: 'pr9', name: 'Shearling Collar Jacket' },
];
const P = (id: string) => PRODUCTS.find(p => p.id === id)!;

type Row = [
  id: string,
  product: string | null,
  sku: string,
  attrs: Record<string, string>,
  provider: Item['provider'],
  type: ItemType,
  cost: number,
  price: number | null,
  unlimited: boolean,
  purchased: number,
  sold: number,
  refunded: number,
  gifted: number,
  writtenOff: number,
];
const ROWS: Row[] = [
  [
    'i1',
    'pr1',
    'KN-0412-BLK-M',
    { Colour: 'Black', Size: 'M' },
    'shopify',
    'sellable',
    31,
    98,
    false,
    120,
    84,
    3,
    2,
    0,
  ],
  [
    'i2',
    'pr1',
    'KN-0412-BLK-L',
    { Colour: 'Black', Size: 'L' },
    'shopify',
    'sellable',
    31,
    98,
    false,
    120,
    112,
    2,
    1,
    1,
  ],
  [
    'i3',
    'pr1',
    'KN-0412-OAT-M',
    { Colour: 'Oat', Size: 'M' },
    'shopify',
    'sellable',
    31,
    98,
    false,
    80,
    72,
    1,
    0,
    0,
  ],
  [
    'i4',
    'pr2',
    'OS-0220-NVY-M',
    { Colour: 'Navy', Size: 'M' },
    'shopify',
    'sellable',
    42,
    124,
    false,
    90,
    64,
    2,
    1,
    0,
  ],
  [
    'i5',
    'pr2',
    'OS-0220-NVY-L',
    { Colour: 'Navy', Size: 'L' },
    'shopify',
    'sellable',
    42,
    124,
    false,
    90,
    90,
    1,
    0,
    1,
  ],
  [
    'i6',
    'pr3',
    'TR-0507-IND-32',
    { Colour: 'Indigo', Waist: '32' },
    'shopify',
    'sellable',
    48,
    135,
    false,
    60,
    41,
    1,
    0,
    0,
  ],
  [
    'i7',
    'pr3',
    'TR-0507-IND-34',
    { Colour: 'Indigo', Waist: '34' },
    'shopify',
    'sellable',
    48,
    135,
    false,
    60,
    63,
    1,
    0,
    0,
  ],
  [
    'i8',
    'pr4',
    'SH-0614-ECR-M',
    { Colour: 'Ecru', Size: 'M' },
    'shopify',
    'sellable',
    24,
    76,
    false,
    150,
    130,
    6,
    3,
    2,
  ],
  [
    'i9',
    'pr5',
    'AC-0150-GRY',
    { Colour: 'Grey' },
    'shopify',
    'sellable',
    15,
    58,
    false,
    200,
    130,
    2,
    4,
    0,
  ],
  [
    'i10',
    'pr6',
    'TS-0031-WHT-M',
    { Colour: 'White', Size: 'M' },
    'shopify',
    'sellable',
    13,
    42,
    false,
    240,
    165,
    5,
    6,
    2,
  ],
  [
    'i11',
    'pr7',
    'AC-0044-NAT',
    { Colour: 'Natural' },
    'shopify',
    'sellable',
    9,
    36,
    false,
    300,
    148,
    4,
    10,
    0,
  ],
  [
    'i12',
    'pr8',
    'AC-0108-CHR',
    { Colour: 'Charcoal' },
    'shopify',
    'sellable',
    6.5,
    28,
    false,
    220,
    150,
    3,
    5,
    1,
  ],
  [
    'i13',
    null,
    'SS-0099-RED-S',
    { Colour: 'Red', Size: 'S' },
    'squarespace',
    'sellable',
    0,
    null,
    false,
    30,
    22,
    0,
    0,
    0,
  ],
  ['i14', null, 'INV-LEGACY-014', {}, 'invoice', 'sellable', 11.5, null, false, 40, 0, 0, 0, 0],
  [
    'i15',
    'pr9',
    'GC-0050',
    { Type: 'Gift card' },
    'shopify',
    'sellable',
    0,
    50,
    true,
    0,
    18,
    0,
    0,
    0,
  ],
  [
    'i16',
    null,
    'SMP-KN-0412-PROTO',
    { Stage: 'Prototype' },
    'invoice',
    'sample',
    38,
    null,
    false,
    6,
    0,
    0,
    2,
    0,
  ],
  [
    'i17',
    null,
    'SMP-OS-0221-TEST',
    { Stage: 'Fit test' },
    'invoice',
    'sample',
    0,
    null,
    false,
    4,
    0,
    0,
    0,
    0,
  ],
];

export const SEED_ITEMS: Item[] = ROWS.map(r => ({
  id: r[0],
  productId: r[1],
  productName: r[1] ? P(r[1]).name : null,
  sku: r[2],
  attributes: r[3],
  provider: r[4],
  itemType: r[5],
  unitCost: r[6],
  sellingPrice: r[7],
  isUnlimited: r[8],
  purchased: r[9],
  sold: r[10],
  refunded: r[11],
  gifted: r[12],
  writtenOff: r[13],
}));

/* ── Derivations ─────────────────────────────────────── */

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const onHand = (i: Item) => i.purchased - i.sold + i.refunded - i.gifted - i.writtenOff;
export const stockValue = (i: Item) => (i.isUnlimited ? 0 : Math.max(onHand(i), 0) * i.unitCost);
export const margin = (i: Item) =>
  i.sellingPrice && i.unitCost > 0 ? ((i.sellingPrice - i.unitCost) / i.sellingPrice) * 100 : null;

export function stockState(i: Item): StockState {
  if (i.isUnlimited) return 'unlimited';
  const n = onHand(i);
  return n < 0 ? 'oversold' : n === 0 ? 'out' : n < 10 ? 'low' : 'in';
}

export const STATE_LABEL: Record<StockState, string> = {
  unlimited: 'Unlimited',
  oversold: 'Oversold',
  out: 'Out of stock',
  low: 'Low stock',
  in: 'In stock',
};
/** Chip tone per stock state (maps onto the shared .cv2-chip-* classes). */
export const STATE_TONE: Record<StockState, string> = {
  unlimited: 'completed',
  oversold: 'neg',
  out: 'draft',
  low: 'active',
  in: 'planned',
};

export function summary(items: Item[]) {
  const sellable = items.filter(i => i.itemType === 'sellable');
  const samples = items.filter(i => i.itemType === 'sample');
  const counted = sellable.filter(i => !i.isUnlimited);
  const costable = items.filter(i => !i.isUnlimited);
  return {
    sellable,
    samples,
    unitsOnHand: sum(counted.map(i => Math.max(onHand(i), 0))),
    stockValue: sum(sellable.map(stockValue)),
    invested: sum(items.map(i => i.purchased * i.unitCost)),
    unitsPurchased: sum(items.map(i => i.purchased)),
    low: sellable.filter(i => stockState(i) === 'low').length,
    out: sellable.filter(i => stockState(i) === 'out').length,
    oversold: sellable.filter(i => stockState(i) === 'oversold').length,
    unlinked: sellable.filter(i => i.productId == null).length,
    linked: sellable.filter(i => i.productId != null).length,
    uncosted: costable.filter(i => i.unitCost <= 0).length,
    costCoverage: costable.length
      ? (costable.filter(i => i.unitCost > 0).length / costable.length) * 100
      : 100,
    products: new Set(items.map(i => i.productId).filter(Boolean)).size,
  };
}

export function valuation(items: Item[]) {
  const rows = items
    .filter(i => i.purchased * i.unitCost > 0)
    .map(i => ({ item: i, invested: i.purchased * i.unitCost }))
    .sort((a, b) => b.invested - a.invested);
  return { rows, total: sum(rows.map(r => r.invested)) };
}

/* ── Movements (generated from the item totals so they tie) ── */

function splitQty(total: number, parts: number) {
  const out: number[] = [];
  let left = total;
  for (let i = 0; i < parts; i++) {
    const q = i === parts - 1 ? left : Math.round(total * [0.55, 0.3, 0.15][i]);
    out.push(q);
    left -= q;
  }
  return out.filter(q => q > 0);
}

const day = (n: number) => new Date(2026, 9, 11 - n, 10, 30).toISOString();

export function generateMovements(items: Item[]): Movement[] {
  const out: Movement[] = [];
  items.forEach((it, idx) => {
    splitQty(it.purchased, 2).forEach((q, j) =>
      out.push({
        id: `${it.id}-p${j}`,
        itemId: it.id,
        type: 'PURCHASE',
        quantity: q,
        unitCost: it.unitCost,
        reference: null,
        notes: j ? 'Top-up order' : 'Initial production run',
        date: day(150 + idx * 3 - j * 60),
      })
    );
    splitQty(it.sold, 3).forEach((q, j) =>
      out.push({
        id: `${it.id}-s${j}`,
        itemId: it.id,
        type: 'SALE',
        quantity: -q,
        unitCost: it.unitCost,
        reference: `#${4700 + idx * 7 + j * 3}`,
        notes: null,
        date: day(2 + idx * 2 + j * 9),
      })
    );
    if (it.refunded)
      out.push({
        id: `${it.id}-r`,
        itemId: it.id,
        type: 'REFUND',
        quantity: it.refunded,
        unitCost: it.unitCost,
        reference: `#${4690 + idx}`,
        notes: 'Returned to stock',
        date: day(6 + idx),
      });
    if (it.gifted)
      out.push({
        id: `${it.id}-g`,
        itemId: it.id,
        type: 'GIFT',
        quantity: -it.gifted,
        unitCost: it.unitCost,
        reference: null,
        notes: 'Gifted',
        date: day(12 + idx),
      });
    if (it.writtenOff)
      out.push({
        id: `${it.id}-w`,
        itemId: it.id,
        type: 'WRITE_OFF',
        quantity: -it.writtenOff,
        unitCost: it.unitCost,
        reference: null,
        notes: 'Damaged',
        date: day(20 + idx),
      });
  });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
