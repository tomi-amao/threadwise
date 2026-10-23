import { test as setup, expect, type Page } from '@playwright/test';
import { AUTH_FILE, requireEnv } from './env';

setup('sign in as the seeded test user', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(requireEnv('E2E_USER_EMAIL'));
  await page.getByLabel('Password', { exact: true }).fill(requireEnv('E2E_USER_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.context().storageState({ path: AUTH_FILE });

  // Warm the routes the suite visits. In development the first request to a route compiles it, and
  // when many workers hit a cold route at once the slowest ones time out. Not a product concern.
  for (const route of ['/dashboard', '/transactions', '/ui-kit']) {
    await warm(page, route);
  }
});

// The dev server can reload the page while it optimises dependencies on a cold route, which
// aborts the navigation in flight (net::ERR_ABORTED). That is the server settling, not a failure,
// so try again; a route that is really broken still fails after the last attempt.
async function warm(page: Page, route: string, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
    }
  }
}
