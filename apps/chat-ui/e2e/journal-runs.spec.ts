/**
 * The Runs tab of the Journals page. The list and the drawer read the seeded runs for real;
 * only the summary, which the browser asks the agent for, is stood in for. Nothing here changes
 * data.
 */

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';
import { contract, fakeJournalAgent, replies } from './helpers/journal-run';

const seed = readManifest();
const R = seed.generationRuns;

const gbp = (value: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value);

const list = (page: Page) => page.getByRole('region', { name: 'Journal generation runs' });
const drawer = (page: Page) => page.getByRole('dialog');

test.describe('journal runs', () => {
  test('every run is listed, newest first, saying how it went', async ({ page }) => {
    await page.goto('/journals?tab=runs');
    await expect(page.getByRole('tab', { name: /Runs/ })).toContainText(String(R.count));
    const rows = list(page).locator('tbody tr');
    await expect(rows).toHaveCount(R.count);
    await expect(rows.nth(0)).toContainText('2 problems');
    await expect(rows.nth(1)).toContainText('Nothing new');
    await expect(rows.nth(2)).toContainText('Failed');
  });

  test('a run says what it created, and what is true of it now', async ({ page }, info) => {
    await page.goto('/journals?tab=runs');
    const row = list(page).locator('tbody tr').first();
    await expect(row).toContainText(String(R.problem.created));
    // Narrow widths drop these columns; the drawer still has them.
    if (info.project.name.startsWith('desktop')) {
      await expect(row).toContainText(gbp(R.problem.value));
      await expect(row).toContainText(`${R.problem.stillOpen} draft`);
    }
  });

  test('opening a run shows its summary, steps, problems and journals', async ({ page }) => {
    const agent = await fakeJournalAgent(page);
    await page.goto('/journals?tab=runs');
    await list(page).locator('tbody tr').first().getByRole('button').click();

    const run = drawer(page);
    await expect(
      run.getByRole('heading', { name: `${R.problem.created} journals created` })
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`run=${R.problem.id}`));

    await expect(run.getByText(contract.narrative.headline)).toBeVisible();
    expect(agent.summaryRequests.map(r => r.run_id)).toEqual([R.problem.id]);

    const problems = run.getByRole('region', { name: 'Problems' });
    await expect(problems).toContainText(R.problem.problemText);
    await expect(problems).toContainText(R.problem.stepFailure);
    await expect(problems.getByRole('link', { name: 'See the bank line' })).toHaveAttribute(
      'href',
      `/transactions?transactionId=${R.problem.transactionId}`
    );

    // What went wrong comes before the summary: it is what a run is usually opened for.
    const above = await problems.evaluate(
      (el, summary) =>
        !!(el.compareDocumentPosition(summary as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
      await run.getByRole('region', { name: 'Summary', exact: true }).elementHandle()
    );
    expect(above).toBe(true);
    await expect(
      run.getByRole('region', { name: 'Summary', exact: true }).getByText('Largest journals')
    ).toHaveCount(0);

    const steps = run.getByRole('region', { name: 'Step by step' });
    await expect(steps).toContainText('Accrue payments');
    await expect(steps).toContainText('3 created, 1 skipped');
    await expect(steps).toContainText('Could not finish');

    const journals = run.getByRole('region', { name: 'Journals in this run' });
    for (const description of R.problem.descriptions)
      await expect(journals).toContainText(description);
  });

  test('a journal opens from its run, and closing it comes back', async ({ page }) => {
    await fakeJournalAgent(page);
    await page.goto(`/journals?tab=runs&run=${R.problem.id}`);
    const journals = drawer(page).getByRole('region', { name: 'Journals in this run' });
    await journals.getByRole('button', { name: new RegExp(R.problem.descriptions[0]) }).click();

    await expect(drawer(page).getByRole('table', { name: 'Journal lines' })).toBeVisible();
    await drawer(page).getByRole('button', { name: /close/i }).click();
    await expect(drawer(page).getByRole('region', { name: 'Step by step' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`run=${R.problem.id}`));
  });

  test('the ledger can be narrowed to one run, and widened again', async ({ page }) => {
    await fakeJournalAgent(page);
    await page.goto(`/journals?tab=runs&run=${R.problem.id}`);
    await drawer(page)
      .getByRole('button', { name: `View ${R.problem.inLedger} in the ledger` })
      .click();

    const table = page.getByRole('region', { name: 'Journals', exact: true });
    await expect(table.locator('tbody tr')).toHaveCount(R.problem.inLedger);
    await expect(page.getByText(/From the run of/)).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/fromRun=/);
    await expect(page.getByText(/From the run of/)).toBeHidden();
    await expect.poll(() => table.locator('tbody tr').count()).toBeGreaterThan(R.problem.inLedger);
  });

  test('a run that found nothing does not ask for a summary', async ({ page }) => {
    const agent = await fakeJournalAgent(page);
    await page.goto(`/journals?tab=runs&run=${R.nothingNewId}`);
    await expect(
      drawer(page).getByRole('heading', { name: 'Nothing new to journal' })
    ).toBeVisible();
    expect(agent.summaryRequests).toEqual([]);
  });

  test('a run that died says why', async ({ page }) => {
    const agent = await fakeJournalAgent(page);
    await page.goto(`/journals?tab=runs&run=${R.failed.id}`);
    await expect(drawer(page).getByRole('alert')).toContainText(R.failed.reason);
    expect(agent.summaryRequests).toEqual([]);
  });

  test('if the summary fails, the record of the run is still there', async ({ page }) => {
    const agent = await fakeJournalAgent(page);
    agent.answerSummaryWith(replies.failure);
    await page.goto(`/journals?tab=runs&run=${R.problem.id}`);
    await expect(drawer(page).getByText(/The summary fell over/)).toBeVisible();
    await expect(drawer(page).getByRole('region', { name: 'Problems' })).toContainText(
      R.problem.problemText
    );
  });

  test('a run that is not yours, or not a run, is not found', async ({ page }) => {
    for (const id of [R.rivalId, 'not-a-run']) {
      await page.goto(`/journals?tab=runs&run=${id}`);
      await expect(drawer(page).getByRole('heading', { name: 'Run not found' })).toBeVisible();
    }
  });

  test('the tab and the drawer have no accessibility problems and fit the screen', async ({
    page,
  }) => {
    await fakeJournalAgent(page);
    await page.goto('/journals?tab=runs');
    await expect(list(page)).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await expectNoHorizontalOverflow(page);

    await page.goto(`/journals?tab=runs&run=${R.problem.id}`);
    await expect(drawer(page).getByText(contract.narrative.headline)).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
});
