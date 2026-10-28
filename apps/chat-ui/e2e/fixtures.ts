import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MANIFEST_FILE } from './env';

export interface SeedManifest {
  entityName: string;
  email: string;
  orderCount: number;
  /** Every customer, including those who never ordered. */
  customerCount: number;
  productCount: number;
  bankAccountCount: number;
  transactionCount: number;
  /** Stored balances plus every seeded transaction, as the dashboard derives it. */
  expectedBankBalance: number;
  /** What the seed put into inventory, computed by the same rules the page uses. */
  inventory: {
    itemCount: number;
    linkedSellableCount: number;
    movementCount: number;
    bulkItemSku: string;
    stockValue: number;
    unitsOnHand: number;
    oversold: number;
    outOfStock: number;
    low: number;
    unlinked: number;
    uncosted: number;
    invested: number;
    unitsPurchased: number;
    oversoldSku: string;
    outSku: string;
    lowSku: string;
    healthySku: string;
    uncostedSku: string;
    unlimitedSku: string;
    unlinkedSku: string;
    sampleSku: string;
  };
  /** What the seed put into orders, by the rules the Orders page uses. */
  orders: {
    total: number;
    byStatus: Record<string, number>;
    toFulfil: number;
    shipped: number;
    delivered: number;
    sales: number;
    refundedCount: number;
    refunded: number;
    refundedOrderNumber: string;
    sampleOrderNumber: string;
  };
  /** The books: periods, journals and the figures the statements should show. */
  ledger: {
    currentLabel: string;
    previousLabel: string;
    currentFrom: string;
    currentTo: string;
    previousFrom: string;
    previousTo: string;
    current: { revenue: number; cogs: number; expenses: number; profit: number };
    previous: { revenue: number; cogs: number; expenses: number; profit: number };
    all: { revenue: number; cogs: number; expenses: number; profit: number };
    balanceSheet: {
      assets: number;
      liabilities: number;
      equity: number;
      retainedEarnings: number;
      balance: number;
    };
    journalCount: number;
    posted: number;
    drafts: number;
    reversed: number;
    manual: number;
    bankFeedJournals: number;
    draftDescriptions: string[];
    reversedDescription: string;
    manualDescription: string;
    tax: { previousProfit: number; previousTax: number };
  };
  /** Collections: sales, linked costs and a plan, worked out by the seed. */
  collections: {
    count: number;
    active: number;
    autumn: {
      name: string;
      id: string;
      productNames: string[];
      units: number;
      revenue: number;
      orders: number;
      cost: number;
      costCount: number;
    };
    winter: { name: string; id: string };
    summer: { name: string; id: string; units: number; revenue: number; orders: number };
    totalRevenue: number;
    totalCost: number;
    plan: {
      partner: string;
      revenue: number;
      netProfit: number;
      partnerDue: number;
      pending: number;
      estimated: number;
      lineCount: number;
      costCount: number;
      sizedLine: { productName: string; quantity: number; sizes: string[]; suggested: string[] };
    };
    rivalName: string;
    rivalId: string;
  };
  /** A second business (and its user) that the first must never see. */
  rival: {
    email: string;
    entityName: string;
    orderNumbers: string[];
    orderTotal: number;
    customerNames: string[];
    productName: string;
    inventorySku: string;
    invoiceNumber: string;
    bankName: string;
    bankBalance: number;
    /** A transaction attachment of the rival's, which the first business must not open. */
    attachmentId: string;
  };
  /** The one file attached to a seeded transaction (a Revolut receipt, as the sync stores it). */
  attachments: {
    count: number;
    transactionId: string;
    attachmentId: string;
    fileName: string;
    sizeBytes: number;
  };
  /** What the seed put into products: line-item revenue, by the rules the Products page uses. */
  products: {
    total: number;
    selling: number;
    slowing: number;
    never: number;
    units: number;
    revenue: number;
    topName: string;
    topRevenue: number;
    topUnits: number;
    topOrders: number;
    slowingName: string;
    neverNames: string[];
  };
  /** What the seed put into customers; the rules are the Customers page's. */
  customerStats: {
    total: number;
    repeat: number;
    oneTime: number;
    lapsed: number;
    never: number;
    spentTotal: number;
    topSpender: string;
    topSpenderOrders: number;
    topSpenderSpent: number;
    oneTimeName: string;
    lapsedName: string;
    neverName: string;
  };
  /** What the seed put into invoices; amounts are in GBP and add up as the page does. */
  invoices: {
    total: number;
    owedToYou: number;
    owedToYouCount: number;
    youOwe: number;
    youOweCount: number;
    overdueOwedToYou: number;
    overdueYouOwe: number;
    overdueCount: number;
    toReview: number;
    otherCurrency: number;
    openCount: number;
    paidCount: number;
    draftPurchase: string;
    draftSale: string;
    priorPeriodDraft: string;
    openSale: string;
    overdueSale: string;
    overduePurchase: string;
    matchedPurchase: string;
    paidMatched: string;
    foreign: string;
    voided: string;
    bulkPrefix: string;
    counterparty: string;
  };
}

export function readManifest(): SeedManifest {
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    throw new Error('No seed manifest. Run `pnpm e2e:seed` (or `pnpm db:fresh`) first.');
  }
}

/**
 * Every test uses this `test`. The auto fixture fails any test whose browser talks to a
 * hosted Supabase project, a second line of defence behind the env guard.
 */
export type ThemeOption = 'light' | 'dark' | 'none';

export const test = base.extend<{ noHostedTraffic: void; theme: ThemeOption }>({
  /**
   * Theme for this project. 'light' / 'dark' set the cookie the server reads; 'none' sets no
   * cookie at all, so a test can check the default. Projects set it (see playwright.config.ts).
   */
  theme: ['light', { option: true }],
  context: async ({ context, theme, baseURL }, use) => {
    if (theme !== 'none' && baseURL) {
      await context.addCookies([{ name: 'tw-theme', value: theme, url: baseURL }]);
    }
    await use(context);
  },
  noHostedTraffic: [
    async ({ page }, use) => {
      const hosted: string[] = [];
      page.on('request', req => {
        const host = new URL(req.url()).hostname;
        if (host.endsWith('.supabase.co') || host.endsWith('.supabase.com')) hosted.push(req.url());
      });
      await use();
      expect(hosted, 'browser must never contact a hosted Supabase project').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Fails if the page scrolls sideways. Reports the widest offenders to make fixes quick. */
export async function expectNoHorizontalOverflow(page: Page) {
  const result = await page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const offenders: string[] = [];
    document.querySelectorAll<HTMLElement>('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (
        r.width > 0 &&
        r.right > vw + 1 &&
        !el.closest('[data-allow-overflow], .overflow-x-auto, .cv2-scroll')
      ) {
        offenders.push(
          `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} (right ${Math.round(r.right)})`
        );
      }
    });
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: vw,
      offenders: [...new Set(offenders)].slice(0, 6),
    };
  });
  expect(
    result.scrollWidth,
    `page is ${result.scrollWidth}px wide in a ${result.clientWidth}px viewport; offenders: ${result.offenders.join(', ')}`
  ).toBeLessThanOrEqual(result.clientWidth + 1);
}

/** The sidebar is a drawer below the `lg` breakpoint (1024px), whatever the device type. */
export async function openNavIfCollapsed(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width < 1024) await page.getByRole('button', { name: 'Open navigation menu' }).click();
}
