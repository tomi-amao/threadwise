import AxeBuilder from '@axe-core/playwright';
import { test, expect, expectNoHorizontalOverflow } from './fixtures';

// The landing page is public: visit it signed out.
test.use({ storageState: { cookies: [], origins: [] } });

const gbp0 = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(n);

test.describe('landing page', () => {
  test('says what it is, and offers the two ways in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Know what you made');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('See how we know');
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: /Get started/ }).first()).toHaveAttribute(
      'href',
      '/signup'
    );
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toHaveAttribute(
      'href',
      '/login'
    );
  });

  test('a sale can be followed from the order to the profit figure', async ({ page }) => {
    await page.goto('/');
    const steps = page.getByRole('list', { name: 'Steps' });
    await steps.getByRole('button', { name: /Order lands/ }).click();
    await expect(page.getByText('We record exactly what it said')).toBeVisible();
    await steps.getByRole('button', { name: /Payment clears/ }).click();
    await expect(page.getByText('Processor fee')).toBeVisible();
    await steps.getByRole('button', { name: /Becomes a journal/ }).click();
    const journal = page.getByRole('table', { name: 'Journal entry' });
    await expect(journal).toContainText('Merchant clearing');
    await expect(journal).toContainText('Debits equal credits');
    await expect(page.getByLabel('Posted')).toBeVisible();
    await steps.getByRole('button', { name: /Moves your numbers/ }).click();
    await expect(page.getByText('£11,500.00')).toBeVisible();
    await expect(steps.getByRole('button', { name: /Moves your numbers/ })).toHaveAttribute(
      'aria-current',
      'step'
    );
  });

  test('a profit and loss line opens to what it is made of', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Operating expenses, open/ }).click();
    await expect(page.getByText('Postage · Royal Mail')).toBeVisible();
    await expect(page.getByText('Bank line · 6 Oct')).toBeVisible();
    await page.getByRole('button', { name: /Revenue, open/ }).click();
    await expect(page.getByText('Order #1042 · Heavy Knit Cardigan')).toBeVisible();
  });

  test('the planner works out profit with the real projection', async ({ page }) => {
    await page.goto('/');
    const plan = page.locator('#plan');
    await plan.scrollIntoViewIfNeeded();
    await expect(plan).toContainText(gbp0(2940)); // 120 pieces, 75% sold: see the engine's maths
    await plan.getByLabel('Sell-through').fill('100');
    await expect(plan).toContainText(gbp0(5880)); // 11,760 revenue less 4,080 goods and 1,800 other
    await plan.getByRole('button', { name: '30% to a partner' }).click();
    await expect(plan).toContainText(gbp0(2352)); // 8,232 left after the partner, less 5,880 of costs
    await expect(plan).toContainText('Partner');
    await plan.getByLabel('Selling price').fill('20');
    await expect(plan.getByText(/A loss/)).toBeVisible();
  });

  test('corporation tax follows the bands, and the VAT meter warns', async ({ page }) => {
    await page.goto('/');
    const tax = page.locator('#tax');
    await tax.scrollIntoViewIfNeeded();
    await expect(tax).toContainText(gbp0(15330)); // 72,000 profit: marginal relief between the bands
    await tax.getByLabel('Profit before tax').fill('50000');
    await expect(tax).toContainText(gbp0(9500)); // exactly 19%
    await expect(tax).toContainText('Small profits rate');
    await tax.getByLabel('Profit before tax').fill('300000');
    await expect(tax).toContainText(gbp0(75000)); // exactly 25%
    await tax.getByLabel('Profit before tax').fill('0');
    await expect(tax).toContainText('No profit, no tax');

    await expect(tax).toContainText(gbp0(29000)); // 61,000 of sales: headroom to £90,000
    await tax.getByLabel('Sales in the last 12 months').fill('95000');
    await expect(tax).toContainText('Over the threshold');
    await expect(tax).toContainText('Registration is compulsory');
  });

  test('questions open and close', async ({ page }) => {
    await page.goto('/');
    const q = page.getByText('Does it replace my accountant?');
    await q.click();
    await expect(page.getByText(/it is not trying to/)).toBeVisible();
    await q.click();
    await expect(page.getByText(/it is not trying to/)).toBeHidden();
  });

  test('has no horizontal overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('has no accessibility violations', async ({ page }) => {
    // The entrance animations fade text in; check it at rest, which is also how reduced motion shows it.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
