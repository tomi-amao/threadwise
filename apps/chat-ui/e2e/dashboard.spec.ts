import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const seed = readManifest();

test.describe('dashboard', () => {
  test('reads the seeded business, not another database', async ({ page }) => {
    await page.goto('/dashboard');
    // The entity name only exists in the local seed: proves the app is using the test database.
    await expect(page.getByText(seed.entityName, { exact: true }).first()).toBeVisible();
  });

  // KNOWN ISSUE found while building this suite: the header falls back to "Your Business"
  // because the loader resolves the entity from the request, and the browser keeps the
  // Supabase session in localStorage, not a cookie, so the server never sees it. Remove
  // `fixme` when the redesign passes the session to loaders (cookie-based auth).
  test.fixme('header shows the business name', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: seed.entityName })).toBeVisible();
  });

  test('shows the seeded order count', async ({ page }) => {
    await page.goto('/dashboard');
    const card = page.getByText('Total Orders', { exact: true }).locator('xpath=..');
    await expect(card).toContainText(String(seed.orderCount));
  });

  test('lists the seeded bank accounts', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByText('Revolut Business')).toBeVisible();
    await expect(page.getByText('Revolut Savings')).toBeVisible();
  });

  test('has no horizontal overflow', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByText('Total Orders', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
