import AxeBuilder from '@axe-core/playwright';
import { test, expect, expectNoHorizontalOverflow } from './fixtures';
import { requireEnv } from './env';

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sign in explains itself and keeps the button off until it can work', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome back.' })).toBeVisible();
    const button = page.getByRole('button', { name: 'Sign in' });
    await expect(button).toBeDisabled();
    await page.getByLabel('Email').fill('someone@example.com');
    await page.getByLabel('Password', { exact: true }).fill('x');
    await expect(button).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/signup'
    );
  });

  test('the password can be shown and hidden', async ({ page }) => {
    await page.goto('/login');
    const password = page.getByLabel('Password', { exact: true });
    await expect(password).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password' }).click();
    await expect(password).toHaveAttribute('type', 'password');
  });

  test('a wrong password says so, in words, and keeps you on the page', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(requireEnv('E2E_USER_EMAIL'));
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(/invalid login credentials/i);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('signing in takes you to the dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(requireEnv('E2E_USER_EMAIL'));
    await page.getByLabel('Password', { exact: true }).fill(requireEnv('E2E_USER_PASSWORD'));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('sign up checks the form before asking the server', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.getByRole('heading', { level: 1, name: 'Start your books.' })).toBeVisible();
    await page.getByLabel('Your name').fill('Test Person');
    await page.getByLabel('Business name').fill('Nobody Ltd');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password', { exact: true }).fill('abcdef');
    await page.getByLabel('Confirm password').fill('abcdeg');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText('do not match');
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('link', { name: 'Sign in' }).last()).toHaveAttribute(
      'href',
      '/login'
    );
  });

  test('has no horizontal overflow, and no accessibility violations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const url of ['/login', '/signup']) {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, url).toEqual([]);
    }
  });
});

test.describe('signed in', () => {
  test('visiting sign in goes straight to the dashboard', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
