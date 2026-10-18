/**
 * Saving the profile, the business and a new password. Runs in the `mutations` project and puts
 * the business and the user's name back afterwards (the password test uses a throwaway user).
 */

import { test, expect, readManifest } from './fixtures';
import { requireEnv } from './env';
import {
  createThrowawayUser,
  deleteSignupUser,
  readEntityByName,
  readUserMetadata,
  restoreAccount,
  snapshotAccount,
  type AccountSnapshot,
} from './helpers/db';

const seed = readManifest();
const EMAIL = requireEnv('E2E_USER_EMAIL');

let before: AccountSnapshot;
test.beforeEach(async () => {
  before = await snapshotAccount(EMAIL, seed.entityName);
});
test.afterEach(async () => {
  await restoreAccount(before);
});

test('the name is saved, and shows in the profile', async ({ page }) => {
  await page.goto('/account');
  await page.getByLabel('Your name').fill('E2E New Name');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('Profile saved')).toBeVisible();
  await expect.poll(async () => (await readUserMetadata(EMAIL)).full_name).toBe('E2E New Name');
});

test('business details are saved, and emptied fields become unset', async ({ page }) => {
  await page.goto('/account');
  await page.getByLabel('Website').fill('https://example.test');
  await page.getByLabel('Industry').selectOption('retail');
  await page.getByRole('button', { name: 'Save' }).nth(1).click();
  await expect(page.getByText('Business saved')).toBeVisible();
  await expect.poll(async () => (await readEntityByName(seed.entityName)).industry).toBe('retail');

  await page.getByLabel('Website').fill('');
  await page.getByLabel('Industry').selectOption('');
  await page.getByRole('button', { name: 'Save' }).nth(1).click();
  await expect(page.getByText('Business saved').first()).toBeVisible();
  await expect.poll(async () => (await readEntityByName(seed.entityName)).industry).toBeNull();
});

test('a new password is saved, and works', async ({ browser, baseURL }) => {
  // A throwaway user: changing the seeded user's password would sign the whole suite out.
  const email = 'e2e.password@example.test';
  await deleteSignupUser(email, 'none');
  await createThrowawayUser(email, 'the-old-password');
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('the-old-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto('/account');
    await page.getByLabel('New password', { exact: true }).fill('a-brand-new-password');
    await page.getByLabel('Confirm new password').fill('a-brand-new-password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Password changed')).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('the-old-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(/invalid login credentials/i);
    await page.getByLabel('Password', { exact: true }).fill('a-brand-new-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  } finally {
    await context.close();
    await deleteSignupUser(email, 'none');
  }
});
