import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MANIFEST_FILE } from './env';

export interface SeedManifest {
  entityName: string;
  email: string;
  orderCount: number;
  customerCount: number;
  productCount: number;
  bankAccountCount: number;
  transactionCount: number;
  /** Stored balances plus every seeded transaction, as the dashboard derives it. */
  expectedBankBalance: number;
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
