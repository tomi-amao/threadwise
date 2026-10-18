/**
 * Creating an account, and setting the business up. Runs in the `mutations` project (it makes a
 * user and a business, and removes both afterwards).
 */

import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { deleteSignupUser, readEntityByName } from './helpers/db';

test.use({ storageState: { cookies: [], origins: [] } });

const EMAIL = 'e2e.signup@example.test';
const BUSINESS = 'E2E Signup Co';

test.beforeEach(async () => deleteSignupUser(EMAIL, BUSINESS));
test.afterEach(async () => deleteSignupUser(EMAIL, BUSINESS));

test('a new account is created, set up in five steps, and lands on its dashboard', async ({
  page,
}) => {
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Sam Signup');
  await page.getByLabel('Business name').fill(BUSINESS);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('a-long-test-password');
  await page.getByLabel('Confirm password').fill('a-long-test-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  // The business exists, not yet set up, and the set-up asks its five questions.
  expect((await readEntityByName(BUSINESS)).onboarding_completed).toBe(false);
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');

  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, 'onboarding').toEqual([]);

  // 1. Industry is required.
  await expect(modal.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await modal.getByRole('button', { name: 'Retail and e-commerce' }).click();
  await modal.getByRole('button', { name: 'Continue' }).click();
  // 2 and 3 are optional.
  await expect(modal.getByRole('heading', { name: /What does E2E Signup Co do/ })).toBeVisible();
  await modal.getByRole('button', { name: 'Skip' }).click();
  await modal.getByRole('button', { name: 'Skip' }).click();
  // 4. The country starts as the UK and cannot be left empty.
  const country = modal.getByLabel('Country');
  await expect(country).toHaveValue('United Kingdom');
  await country.fill('');
  await expect(modal.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await country.fill('United Kingdom');
  await modal.getByRole('button', { name: 'Continue' }).click();
  // 5. Team size is required, then finish.
  await expect(modal.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
  await modal.getByRole('button', { name: '1 to 10' }).click();
  await modal.getByRole('button', { name: 'Finish setup' }).click();
  await expect(modal).toBeHidden();

  const saved = await readEntityByName(BUSINESS);
  expect(saved.onboarding_completed).toBe(true);
  expect(saved.industry).toBe('retail');
  expect(saved.country).toBe('United Kingdom');
  expect(saved.employee_count).toBe('1-10');
});

test('an email that already has an account is refused', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Sam Signup');
  await page.getByLabel('Business name').fill(BUSINESS);
  await page.getByLabel('Email').fill(process.env.E2E_USER_EMAIL ?? 'x');
  await page.getByLabel('Password', { exact: true }).fill('a-long-test-password');
  await page.getByLabel('Confirm password').fill('a-long-test-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/signup$/);
});
