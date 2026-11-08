/**
 * The Summary tab of the Generate Journals modal, shown once a run has finished. The agent and
 * Inngest's realtime socket are stood in for at the network edge (`helpers/journal-run.ts`), so
 * each test decides exactly what the run says and when. Nothing here changes data.
 */

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures';
import { contract, fakeJournalAgent, replies } from './helpers/journal-run';

type Agent = Awaited<ReturnType<typeof fakeJournalAgent>>;

const gbp = (value: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value);

const OUTDATED = /Written before you posted drafts/;
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

async function openModal(page: Page): Promise<Agent> {
  const agent = await fakeJournalAgent(page);
  await page.goto('/integrations?journals=1');
  await expect(page.getByRole('heading', { name: 'Generate Journals' })).toBeVisible();
  await agent.connected();
  return agent;
}

async function startRun(page: Page) {
  await page.getByRole('button', { name: 'Generate Journals' }).click();
  await expect(page.getByRole('button', { name: 'Generating...' })).toBeVisible();
}

async function finishedRun(page: Page): Promise<Agent> {
  const agent = await openModal(page);
  await startRun(page);
  await agent.completed();
  await expect(tab(page, 'Summary')).toBeVisible();
  return agent;
}

/** Post the run's draft from the Review tab, using the account the agent suggested. */
async function postDraft(page: Page) {
  const draft = contract.journals.find(j => j.status === 'draft')!;
  await tab(page, 'Review').click();
  await page.getByRole('button', { name: new RegExp(draft.description!) }).click();
  await expect(page.getByText('A software subscription.')).toBeVisible();
  await page.getByRole('button', { name: 'Post journal' }).click();
  await expect(page.getByText('Everything looks good')).toBeVisible();
}

test.describe('journal run summary', () => {
  test('the tab exists only once the run has finished', async ({ page }) => {
    const agent = await openModal(page);
    await expect(tab(page, 'Review')).toBeVisible();
    await expect(tab(page, 'Summary')).toBeHidden();

    await startRun(page);
    await agent.running();
    await expect(page.getByText('Step 1/4')).toBeVisible();
    await expect(tab(page, 'Summary')).toBeHidden();

    await agent.completed();
    await expect(tab(page, 'Summary')).toBeVisible();
    expect(agent.summaryRequests, 'nothing is asked until the tab is opened').toEqual([]);
  });

  test('it asks about this run, and shows the narrative above the figures', async ({ page }) => {
    const agent = await finishedRun(page);
    await tab(page, 'Summary').click();

    await expect(page.getByText(contract.narrative.headline)).toBeVisible();
    expect(agent.summaryRequests).toHaveLength(1);
    expect(agent.summaryRequests[0].run_id).toBe(contract.runId);
    expect(agent.summaryRequests[0].include_narrative).toBeUndefined();

    for (const line of [...contract.narrative.highlights, ...contract.narrative.attention])
      await expect(page.getByText(line)).toBeVisible();
    await expect(page.getByText(gbp(contract.stats.total_amount)).first()).toBeVisible();
    for (const account of contract.stats.top_accounts)
      await expect(
        page.getByRole('region', { name: 'Accounts that moved most' }).getByText(account.name)
      ).toBeVisible();
    for (const journal of contract.stats.largest_journals)
      await expect(
        page.getByRole('region', { name: 'Largest journals' }).getByText(journal.description!)
      ).toBeVisible();
  });

  test('a message replayed after completion does not take the tab away', async ({ page }) => {
    const agent = await finishedRun(page);
    await agent.replayedRunning();
    await tab(page, 'Summary').click();
    await expect(page.getByText(contract.narrative.headline)).toBeVisible();
    await expect(tab(page, 'Summary')).toBeVisible();
  });

  test('switching tabs does not ask the model again', async ({ page }) => {
    const agent = await finishedRun(page);
    await tab(page, 'Summary').click();
    await expect(page.getByText(contract.narrative.headline)).toBeVisible();

    await tab(page, 'Pipeline').click();
    await tab(page, 'Summary').click();
    await expect(page.getByText(contract.narrative.headline)).toBeVisible();
    expect(agent.summaryRequests).toHaveLength(1);
  });

  test('a second run asks for its own summary and drops the first', async ({ page }) => {
    const agent = await finishedRun(page);
    await tab(page, 'Summary').click();
    await expect(page.getByText(contract.narrative.headline)).toBeVisible();

    await tab(page, 'Pipeline').click();
    await page.getByRole('button', { name: 'Run Again' }).click();
    await expect(tab(page, 'Summary')).toBeHidden();
    agent.answerSummaryWith(replies.secondRun);
    await startRun(page);
    await agent.completed(contract.secondRunId);
    await tab(page, 'Summary').click();

    await expect(page.getByText(contract.secondNarrative.headline)).toBeVisible();
    await expect(page.getByText(contract.narrative.headline)).toBeHidden();
    expect(agent.summaryRequests.map(r => r.run_id)).toEqual([
      contract.runId,
      contract.secondRunId,
    ]);
  });

  test('without a narrative the figures are still all there', async ({ page }) => {
    const agent = await finishedRun(page);
    agent.answerSummaryWith(replies.noNarrative);
    await tab(page, 'Summary').click();
    await expect(page.getByText(/AI summary is unavailable/)).toBeVisible();
    await expect(page.getByText(gbp(contract.stats.total_amount)).first()).toBeVisible();
  });

  test('a run that recorded nothing says so', async ({ page }) => {
    const agent = await finishedRun(page);
    agent.answerSummaryWith(replies.emptyRun);
    await tab(page, 'Summary').click();
    await expect(page.getByText('No new journals in this run')).toBeVisible();
  });

  test('a failed summary can be retried', async ({ page }) => {
    const agent = await finishedRun(page);
    agent.answerSummaryWith(replies.failure);
    await tab(page, 'Summary').click();
    await expect(page.getByText(/The summary fell over/)).toBeVisible();
    expect(agent.summaryRequests).toHaveLength(1);

    agent.answerSummaryWith(replies.full);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText(contract.narrative.headline)).toBeVisible();
    expect(agent.summaryRequests).toHaveLength(2);
  });

  test('the drafts shortcut opens Review', async ({ page }) => {
    await finishedRun(page);
    await tab(page, 'Summary').click();
    await page.getByRole('button', { name: /1 draft need an account/ }).click();
    await expect(tab(page, 'Review')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Draft Journals')).toBeVisible();
  });

  test('posting this run’s draft updates the figures without asking the model', async ({
    page,
  }) => {
    const agent = await finishedRun(page);
    await tab(page, 'Summary').click();
    await expect(page.getByRole('button', { name: /1 draft need an account/ })).toBeVisible();

    agent.answerSummaryWith(replies.afterPosting);
    await postDraft(page);
    expect(agent.posted).toEqual([contract.postedDraft.journalId]);

    await tab(page, 'Summary').click();
    await expect(page.getByText(OUTDATED)).toBeVisible();
    await expect(page.getByRole('button', { name: /draft.* need an account/ })).toBeHidden();
    // The narrative stays, marked as written before the change.
    await expect(page.getByText(contract.narrative.headline)).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Accounts that moved most' }).getByText('Software')
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Accounts that moved most' })
        .getByText('Miscellaneous Expense')
    ).toBeHidden();

    expect(agent.summaryRequests).toHaveLength(2);
    expect(agent.summaryRequests[1].include_narrative).toBe(false);
  });

  test('posting a draft from an earlier run leaves the narrative as it was', async ({ page }) => {
    const agent = await finishedRun(page);
    await tab(page, 'Summary').click();
    await expect(page.getByText(contract.narrative.headline)).toBeVisible();

    agent.answerSummaryWith(replies.unchanged);
    await postDraft(page);
    await tab(page, 'Summary').click();

    await expect.poll(() => agent.summaryRequests.length).toBe(2);
    await expect(page.getByText(contract.narrative.headline)).toBeVisible();
    await expect(page.getByText(/Written by AI from the figures/)).toBeVisible();
    await expect(page.getByText(OUTDATED)).toBeHidden();
  });

  test('the tab has no accessibility problems and fits the screen', async ({ page }) => {
    await finishedRun(page);
    await tab(page, 'Summary').click();
    await expect(page.getByText(contract.narrative.headline)).toBeVisible();
    // The toast that announces the run is the toast library's own colours, not this tab's.
    const axe = new AxeBuilder({ page }).exclude('[data-sonner-toaster]');
    expect((await axe.analyze()).violations).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
});
