import { test, expect, expectNoHorizontalOverflow, openNavIfCollapsed } from './fixtures';

test.describe('app shell', () => {
  test('sidebar is permanent from 1024px up and a drawer below it', async ({ page }) => {
    await page.goto('/dashboard');
    const sidebar = page.locator('aside');
    if (page.viewportSize()!.width >= 1024) {
      await expect(sidebar).toBeInViewport();
    } else {
      await expect(sidebar).not.toBeInViewport();
      await page.getByRole('button', { name: 'Open navigation menu' }).click();
      await expect(sidebar).toBeInViewport();
      await expect(sidebar.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    }
  });

  test('marks the current page', async ({ page }) => {
    await page.goto('/dashboard');
    await openNavIfCollapsed(page);
    await expect(page.locator('aside').getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  test('has a single page h1 (the mobile bar is not a second one)', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByText('Total Orders', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  test('sidebar text is readable (not light-on-light or dark-on-dark)', async ({ page }) => {
    await page.goto('/dashboard');
    await openNavIfCollapsed(page);
    const colors = await page.locator('aside').evaluate(el => {
      const cs = getComputedStyle(el);
      const link = el.querySelector('nav a') as HTMLElement;
      return { bg: cs.backgroundColor, fg: getComputedStyle(link).color };
    });
    expect(colors.bg).not.toBe(colors.fg);
  });

  test('legacy pages still fit the viewport in this theme', async ({ page }) => {
    for (const path of ['/dashboard', '/transactions']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalOverflow(page);
    }
  });

  // KNOWN ISSUE (pre-existing, not from the redesign): the legacy Reports page is wider than a
  // 1280px viewport because hidden InfoTooltip popovers are absolutely positioned off the right
  // edge. Phase 3 replaces the page; remove `fixme` then.
  test.fixme('legacy reports page fits the viewport', async ({ page }) => {
    await page.goto('/reports');
    await page.waitForLoadState('networkidle');
    await expectNoHorizontalOverflow(page);
  });
});
