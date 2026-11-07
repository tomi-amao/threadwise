/**
 * Marking notifications read: by following one, one at a time, or all at once. Runs in the
 * mutations project: it changes read state, and puts every row back as it was.
 */

import type { Page } from '@playwright/test';
import { test, expect, readManifest } from './fixtures';
import { restoreNotificationReads, snapshotNotificationReads } from './helpers/db';

const n = readManifest().notifications;
let before: Awaited<ReturnType<typeof snapshotNotificationReads>>;

test.beforeEach(async () => {
  before = await snapshotNotificationReads();
});
test.afterEach(async () => {
  await restoreNotificationReads(before);
});

const bell = (page: Page) =>
  page.locator(
    page.viewportSize()!.width < 1024 ? '#notifications-bell-header' : '#notifications-bell'
  );

test('following one goes there and marks it read; the rest stay unread', async ({ page }) => {
  await page.goto('/dashboard');
  await bell(page).click();
  const drawer = page.getByRole('dialog', { name: 'What needs you' });
  const first = drawer.getByRole('article', { name: n.unread[0] });
  await first.getByRole('link', { name: 'Go to it' }).click();
  await expect(page).toHaveURL(/\/integrations$/);
  await expect(drawer).toBeHidden();
  await expect(bell(page)).toHaveAccessibleName(
    new RegExp(`Notifications.*${n.unread.length - 1} unread`)
  );

  // Read state is stored, not only shown: a reload keeps it.
  await page.reload();
  await expect(bell(page)).toHaveAccessibleName(
    new RegExp(`Notifications.*${n.unread.length - 1} unread`)
  );
});

test('one can be marked read where it is, and all at once', async ({ page }) => {
  await page.goto('/dashboard');
  await bell(page).click();
  const drawer = page.getByRole('dialog', { name: 'What needs you' });
  await drawer
    .getByRole('article', { name: n.unread[1] })
    .getByRole('button', { name: 'Mark as read' })
    .click();
  await expect(drawer.getByText(`${n.unread[1]} (unread)`)).toHaveCount(0);

  await drawer.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(drawer.getByText('(unread)')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(bell(page)).toHaveAccessibleName(/^Notifications$/);
  await page.reload();
  await expect(bell(page)).toHaveAccessibleName(/^Notifications$/);
});
