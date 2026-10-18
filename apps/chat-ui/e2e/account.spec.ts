import AxeBuilder from '@axe-core/playwright';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';
import { requireEnv } from './env';

const seed = readManifest();

test.describe('account', () => {
  test('shows who you are and the business', async ({ page }) => {
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('You,');
    await expect(page.getByText(requireEnv('E2E_USER_EMAIL'))).toBeVisible();
    await expect(page.getByLabel('Business name')).toHaveValue(seed.entityName);
    await expect(page.getByRole('heading', { level: 2, name: 'Password' })).toBeVisible();
  });

  test('saving waits for a change', async ({ page }) => {
    await page.goto('/account');
    const business = page.getByRole('button', { name: 'Save' }).nth(1);
    await expect(business).toBeDisabled();
    await page.getByLabel('Business name').fill(`${seed.entityName} x`);
    await expect(business).toBeEnabled();
  });

  test('a new password is checked before it is sent', async ({ page }) => {
    await page.goto('/account');
    await page.getByLabel('New password', { exact: true }).fill('abc');
    await page.getByLabel('Confirm new password').fill('abc');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('alert')).toContainText('at least 6');
    await page.getByLabel('New password', { exact: true }).fill('abcdef');
    await page.getByLabel('Confirm new password').fill('abcdeg');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('alert')).toContainText('do not match');
  });

  test('the theme can be switched here too', async ({ page }) => {
    await page.goto('/account');
    const group = page.getByRole('main').getByRole('group', { name: 'Theme' });
    await expect(group).toBeVisible();
  });

  test('has no horizontal overflow, and no accessibility violations', async ({ page }) => {
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
