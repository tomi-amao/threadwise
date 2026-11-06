/**
 * The bell: open notifications of the signed-in business, newest first, the unread counted.
 * Resolved ones (the problem went away) and the other business's are never shown.
 */

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const seed = readManifest();
const n = seed.notifications;

/** The bell that is on screen: the sidebar's on a wide screen, the header's on a phone. */
const bell = (page: Page) =>
  page.locator(
    page.viewportSize()!.width < 1024 ? '#notifications-bell-header' : '#notifications-bell'
  );

test.describe('notifications', () => {
  test('the bell counts the unread', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(bell(page)).toHaveAccessibleName(
      new RegExp(`Notifications.*${n.unread.length} unread`)
    );
  });

  test('opening it lists the open ones, newest first, and never a resolved one', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await bell(page).click();
    const drawer = page.getByRole('dialog', { name: 'What needs you' });
    const items = drawer.getByRole('list', { name: 'Notifications' }).getByRole('heading');
    await expect(items).toHaveText(n.shown.map(t => new RegExp(`^${t}`)));
    for (const title of n.unread)
      await expect(drawer.getByText(`${title} (unread)`)).toHaveCount(1);
    await expect(drawer).not.toContainText(n.resolvedTitle);
    await expect(drawer).not.toContainText(seed.rival.notificationTitle);
    await expect(drawer.getByRole('link', { name: 'Go to it' }).first()).toHaveAttribute(
      'href',
      '/integrations'
    );
    await expect(drawer.getByRole('button', { name: 'Mark all as read' })).toBeVisible();
  });

  test('has no horizontal overflow, and no accessibility violations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dashboard');
    await bell(page).click();
    await expect(page.getByRole('dialog', { name: 'What needs you' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});
