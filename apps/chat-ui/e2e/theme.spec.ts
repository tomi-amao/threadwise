import { test, expect, openNavIfCollapsed } from './fixtures';

const isDark = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'));

test.describe('theme', () => {
  test('follows the theme cookie on first paint', async ({ page, theme }) => {
    await page.goto('/dashboard');
    expect(await isDark(page)).toBe(theme === 'dark');
  });

  test('server renders the right class before any JavaScript runs', async ({
    request,
    baseURL,
  }) => {
    for (const theme of ['light', 'dark'] as const) {
      const html = await (
        await request.get(`${baseURL}/login`, { headers: { cookie: `tw-theme=${theme}` } })
      ).text();
      const htmlTag = html.match(/<html[^>]*>/)?.[0] ?? '';
      expect(htmlTag.includes('class="dark"'), `<html> for ${theme}: ${htmlTag}`).toBe(
        theme === 'dark'
      );
    }
  });
});

test.describe('theme defaults and switching', () => {
  test.use({ theme: 'none' });

  test('is light when no preference has been saved', async ({ page }) => {
    await page.goto('/dashboard');
    expect(await isDark(page)).toBe(false);
  });

  test('toggle switches instantly, persists in a cookie, and survives a reload', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await openNavIfCollapsed(page);
    const group = page.getByRole('group', { name: 'Theme' });

    await group.getByRole('button', { name: 'Dark' }).click();
    expect(await isDark(page)).toBe(true);
    expect((await page.context().cookies()).find(c => c.name === 'tw-theme')?.value).toBe('dark');

    await page.reload();
    expect(await isDark(page)).toBe(true);

    await openNavIfCollapsed(page);
    await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
    await page.reload();
    expect(await isDark(page)).toBe(false);
  });
});
