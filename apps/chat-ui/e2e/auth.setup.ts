import { test as setup, expect } from '@playwright/test';
import { AUTH_FILE, requireEnv } from './env';

setup('sign in as the seeded test user', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#email').fill(requireEnv('E2E_USER_EMAIL'));
  await page.locator('#password').fill(requireEnv('E2E_USER_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.context().storageState({ path: AUTH_FILE });
});
