import AxeBuilder from '@axe-core/playwright';
import { test, expect, expectNoHorizontalOverflow } from './fixtures';

// The gallery only exists outside production builds (routes.ts); Playwright runs the dev server.
test.describe('ui kit', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui-kit');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('has no horizontal overflow', async ({ page }) => {
    await expectNoHorizontalOverflow(page);
  });

  test('has exactly one h1', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  test('passes an automated accessibility scan', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .include('main, [data-testid]')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      results.violations.map(
        v => `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`
      )
    ).toEqual([]);
  });

  test('charts render with a text alternative', async ({ page }) => {
    const charts = page.getByTestId('charts');
    await expect(charts.getByRole('img', { name: 'Monthly gross revenue' })).toBeVisible();
    await expect(charts.getByRole('img', { name: 'Total sales against net income' })).toBeVisible();
    // The sr-only summary carries the numbers for screen readers.
    await expect(charts.getByText(/Monthly gross revenue: Nov £21,400/)).toBeAttached();
    // The donut is decorative; its legend is the accessible, labelled list of the same data.
    await expect(charts.getByRole('term').filter({ hasText: 'PayPal' })).toBeVisible();
  });

  test('drawer traps focus, closes on Escape, and returns focus to its trigger', async ({
    page,
  }) => {
    const trigger = page.getByRole('button', { name: 'Open drawer' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Link a piece of spend.' });
    await expect(dialog).toBeVisible();

    // Focus stays inside the dialog however far we tab.
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
      true
    );

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('tabs move with the arrow keys', async ({ page }) => {
    const tabs = page.getByTestId('navigation').getByRole('tab');
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  });

  test('segmented control reports its pressed option', async ({ page }) => {
    const group = page.getByRole('group', { name: 'Direction' });
    await group.getByRole('button', { name: 'Out' }).click();
    await expect(group.getByRole('button', { name: 'Out' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(group.getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });
});
