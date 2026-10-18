/**
 * The assistant panel and /chat, against a stand-in for the LangGraph API
 * (helpers/fake-langgraph.ts). Runs at every width and theme like every page: below 1700px
 * the panel overlays the page (a dialog), on a phone it is a sheet; one test checks the
 * docked layout at 1800px.
 */

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures';
import { example, mockAgent, type Plan } from './helpers/fake-langgraph';

const PROFIT = 'What is my profit this financial year?';
const COMPARE = 'How does this compare with last financial year?';
const PERIOD = 'How did sales go?';
const SLOW = 'Take your time';
const BROKEN = 'This one fails';

const PLANS: Record<string, Plan> = {
  [PROFIT]: {
    steps: [
      {
        name: 'profit_and_loss',
        args: { start_date: '2026-04-01', end_date: '2027-03-31' },
        result: { net_profit: 4449.16 },
        ui: [{ name: 'summary-list', props: example('summary-list', 0) }],
        progress: 'Reading the ledger',
      },
    ],
    answer: [
      'Your net profit this financial year is **£4,449.16**.',
      'Net profit so far this financial year: **£4,449.16**.',
    ],
    followUps: [
      { label: 'Compare with last year', prompt: COMPARE },
      { label: 'Biggest expenses', prompt: 'What were my biggest expenses this year?' },
    ],
  },
  [COMPARE]: {
    answer: 'Last financial year the net profit was £5,000.00, so this year is lower so far.',
    followUps: [
      { label: 'Cash', prompt: 'How much cash do I have?' },
      { label: 'Overdue invoices', prompt: 'Which invoices are overdue?' },
    ],
  },
  [PERIOD]: {
    clarify: {
      question: 'Which period do you mean?',
      options: ['This month', 'Last month'],
      then: {
        steps: [
          {
            name: 'sales_summary',
            args: { start_date: '2026-09-01', end_date: '2026-09-30' },
            ui: [{ name: 'metric', props: example('metric', 0) }],
          },
        ],
        answer: 'Last month you sold **£16,100.00** across 72 orders.',
      },
    },
    answer: 'unused',
  },
  [SLOW]: { answer: 'Done at last.', delayMs: 15_000 },
  [BROKEN]: { answer: 'unused', fail: true },
};

const panel = (page: Page) => page.locator('#assistant-panel');
const composer = (page: Page) =>
  page.getByRole('textbox', { name: /Ask about your business|Your answer/ });
/** The launcher a user sees: the sidebar's from 1024px, the header's below (where the
 * sidebar is a drawer that is only off screen, so still "visible" to Playwright). */
const launcher = (page: Page) =>
  page.locator(
    page.viewportSize()!.width >= 1024 ? '#assistant-launcher' : '#assistant-launcher-header'
  );

async function openPanel(page: Page) {
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(composer(page)).toBeFocused();
}

/** The button that opens a conversation in the list (its name also carries the date). */
const conversation = (page: Page, title: string) =>
  panel(page)
    .getByRole('list', { name: 'Conversations' })
    .getByRole('listitem')
    .filter({ hasText: title })
    .getByRole('button')
    .first();

async function ask(page: Page, question: string) {
  await composer(page).fill(question);
  await composer(page).press('Enter');
}

test.describe('assistant', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('opens from the launcher with focus in the composer; Escape closes it and focus goes back', async ({
    page,
  }) => {
    await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    // Below 1700px it overlays the page: a dialog, closed with Escape.
    await expect(page.getByRole('dialog', { name: 'Assistant' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(launcher(page)).toBeFocused();
    await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('Ctrl/⌘+J opens and closes it from anywhere', async ({ page }) => {
    await mockAgent(page, PLANS);
    await page.goto('/invoices');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+j');
    await expect(panel(page)).toBeVisible();
    await expect(composer(page)).toBeFocused();
    await page.keyboard.press('ControlOrMeta+j');
    await expect(panel(page)).toHaveCount(0);
  });

  test('an empty conversation offers questions for the page it is on', async ({ page }) => {
    const agent = await mockAgent(page, PLANS);
    await page.goto('/invoices');
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Which invoices are overdue?' }).click();
    await expect(panel(page).getByText('I can answer from your own records.')).toBeVisible();
    expect(agent.runs()).toHaveLength(1);
  });

  test('answers with its steps, the card built from the tool result, and follow-ups to click', async ({
    page,
  }) => {
    const agent = await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await ask(page, PROFIT);

    const p = panel(page);
    await expect(p.getByText('Your net profit this financial year is')).toBeVisible();
    await expect(p.getByText('Read the ledger, 1 Apr 2026 to 31 Mar 2027')).toBeVisible();
    const card = p.getByRole('region', { name: 'Profit and loss' });
    await expect(card.getByText('£4,449.16')).toBeVisible();
    await expect(card.getByRole('link', { name: 'Open in Reports' })).toHaveAttribute(
      'href',
      '/reports?from=2026-04-01&to=2027-03-31'
    );
    // The thread is named after its first question.
    await expect(p.getByRole('heading', { name: PROFIT })).toBeVisible();

    // A follow-up sends its full prompt; then only the newest answer has chips.
    await p
      .getByRole('navigation', { name: 'Suggested questions' })
      .getByRole('button', { name: 'Compare with last year' })
      .click();
    await expect(p.getByText('this year is lower so far')).toBeVisible();
    const runs = agent.runs();
    expect(
      (runs.at(-1)?.body as { input: { messages: { content: string }[] } }).input.messages[0]
        .content
    ).toBe(COMPARE);
    await expect(p.getByRole('navigation', { name: 'Suggested questions' })).toHaveCount(1);
    await expect(p.getByRole('button', { name: 'Cash' })).toBeVisible();
    await expect(p.getByRole('button', { name: 'Compare with last year' })).toHaveCount(0);
  });

  test('a clarifying question is answered with a click and the answer follows', async ({
    page,
  }) => {
    const agent = await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await ask(page, PERIOD);
    const question = panel(page).getByRole('group', { name: 'Which period do you mean?' });
    await expect(question).toBeVisible();
    await expect(composer(page)).toHaveAttribute('placeholder', 'Type your answer…');
    await question.getByRole('button', { name: 'Last month' }).click();
    await expect(panel(page).getByText('Last month you sold')).toBeVisible();
    await expect(panel(page).getByRole('region', { name: 'Net sales' })).toBeVisible();
    await expect(question).toHaveCount(0);
    expect(agent.runs().at(-1)?.body).toMatchObject({
      command: { resume: { answer: 'Last month' } },
    });
  });

  test('the conversation stays open while a link in an answer changes the page', async ({
    page,
  }) => {
    await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await ask(page, PROFIT);
    const card = panel(page).getByRole('region', { name: 'Profit and loss' });
    await card.getByRole('link', { name: 'Open in Reports' }).click();
    await expect(page).toHaveURL(/\/reports\?from=2026-04-01&to=2027-03-31/);
    await expect(panel(page).getByText('Your net profit this financial year is')).toBeVisible();
  });

  test('a conversation is still there after a reload, and the panel stays open', async ({
    page,
  }) => {
    await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await ask(page, PROFIT);
    await expect(panel(page).getByText('Your net profit this financial year is')).toBeVisible();
    await page.reload();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText('Your net profit this financial year is')).toBeVisible();
  });

  test('conversations can be switched, renamed and deleted (after a confirmation)', async ({
    page,
  }) => {
    await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await ask(page, PROFIT);
    await expect(panel(page).getByText('Your net profit this financial year is')).toBeVisible();
    await panel(page).getByRole('button', { name: 'New conversation' }).click();
    await ask(page, COMPARE);
    await expect(panel(page).getByText('this year is lower so far')).toBeVisible();

    const p = panel(page);
    await p.getByRole('button', { name: 'Conversations' }).click();
    const list = p.getByRole('list', { name: 'Conversations' });
    await expect(conversation(page, PROFIT)).toBeVisible();
    await expect(conversation(page, COMPARE)).toHaveAttribute('aria-current', 'true');

    await conversation(page, PROFIT).click();
    await expect(p.getByText('Your net profit this financial year is')).toBeVisible();

    await p.getByRole('button', { name: 'Conversations' }).click();
    await list.getByRole('button', { name: `Rename ${PROFIT}` }).click();
    await p.getByRole('textbox', { name: `New name for ${PROFIT}` }).fill('Profit check');
    await p.getByRole('button', { name: 'Save' }).click();
    await expect(conversation(page, 'Profit check')).toBeVisible();

    await list.getByRole('button', { name: `Delete ${COMPARE}` }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this conversation?' });
    await expect(confirm).toContainText(COMPARE);
    await confirm.getByRole('button', { name: 'Delete conversation' }).click();
    await expect(conversation(page, COMPARE)).toHaveCount(0);
    await expect(conversation(page, 'Profit check')).toBeVisible();
  });

  test('/chat shows the same conversation full width, with the panel hidden', async ({ page }) => {
    await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await ask(page, PROFIT);
    await expect(panel(page).getByText('Your net profit this financial year is')).toBeVisible();
    const expand = panel(page).getByRole('link', { name: 'Open full width' });
    if (await expand.isVisible()) {
      await expand.click();
    } else {
      // On a phone the panel is already full width; /chat is reached by its link.
      const thread = await page.evaluate(
        () => Object.entries(localStorage).find(([k]) => k.startsWith('tw-assistant-thread:'))?.[1]
      );
      await page.goto(`/chat?thread=${thread}`);
    }
    await expect(page).toHaveURL(/\/chat\?thread=/);
    await expect(page.getByRole('heading', { level: 1, name: PROFIT })).toBeVisible();
    await expect(page.getByText('Your net profit this financial year is')).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    // The launcher there goes to the composer, not to a second copy of the thread.
    await launcher(page).click();
    await expect(composer(page)).toBeFocused();
  });

  test('Stop ends a slow answer; a failed one can be tried again', async ({ page }) => {
    const agent = await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await ask(page, SLOW);
    await expect(panel(page).getByRole('status').filter({ hasText: 'Thinking' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Stop' }).click();
    await expect(panel(page).getByRole('button', { name: 'Send' })).toBeVisible();

    await ask(page, BROKEN);
    const alert = panel(page).getByRole('alert');
    await expect(alert).toContainText('could not answer');
    agent.setPlan(BROKEN, { answer: 'It worked the second time.' });
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(panel(page).getByText('It worked the second time.')).toBeVisible();
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
  });

  test('a question can be edited and sent again; an answer can be asked for again', async ({
    page,
  }) => {
    const agent = await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await ask(page, PROFIT);
    const p = panel(page);
    await expect(p.getByText('Your net profit this financial year is')).toBeVisible();

    await p.getByRole('button', { name: 'Answer again' }).click();
    await expect(p.getByText('Net profit so far this financial year')).toBeVisible();
    await expect(p.getByText('Your net profit this financial year is')).toHaveCount(0);
    expect(agent.runs().at(-1)?.body).toMatchObject({ checkpoint: expect.anything() });

    await p.getByRole('button', { name: 'Edit question' }).click();
    await p.getByRole('textbox', { name: 'Edit your question' }).fill(COMPARE);
    await p.getByRole('button', { name: 'Send again' }).click();
    await expect(p.getByText('this year is lower so far')).toBeVisible();
    // A fork from before the question: the old question and answer are gone from view.
    await expect(p.getByRole('log').getByText(PROFIT, { exact: true })).toHaveCount(0);
  });

  test('a thumbs up or down is saved with the conversation', async ({ page }) => {
    const agent = await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await ask(page, PROFIT);
    const good = panel(page).getByRole('button', { name: 'Good answer' });
    await good.click();
    await expect(good).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() =>
        agent.calls.some(
          c =>
            c.method === 'PATCH' &&
            Object.values(
              (c.body as { metadata?: { feedback?: Record<string, string> } }).metadata?.feedback ??
                {}
            ).includes('up')
        )
      )
      .toBe(true);
  });

  test('the panel can be resized from the keyboard, and keeps its width', async ({ page }) => {
    test.skip(page.viewportSize()!.width < 768, 'a phone shows the panel full width');
    await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    const handle = panel(page).getByRole('separator', { name: 'Resize assistant' });
    await expect(handle).toHaveAttribute('aria-valuenow', '420');
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '452');
    await page.reload();
    await expect(panel(page).getByRole('separator', { name: 'Resize assistant' })).toHaveAttribute(
      'aria-valuenow',
      '452'
    );
  });

  test('where there is room (1700px and wider) it docks and the page makes room', async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('desktop'), 'one width is enough');
    await page.setViewportSize({ width: 1800, height: 1000 });
    await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await expect(page.getByRole('complementary', { name: 'Assistant' })).toBeVisible();
    // Not modal: Escape leaves it open, and the page beside it keeps its designed width.
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeVisible();
    const main = await page.locator('main').boundingBox();
    const dock = await panel(page).boundingBox();
    expect(main!.x + main!.width).toBeLessThanOrEqual(dock!.x + 1);
    expect(main!.width).toBeGreaterThanOrEqual(1024);
    await expectNoHorizontalOverflow(page);
  });

  test('passes axe and has no horizontal overflow, with an answer open', async ({ page }) => {
    await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await openPanel(page);
    await ask(page, PROFIT);
    await expect(panel(page).getByRole('region', { name: 'Profit and loss' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const results = await new AxeBuilder({ page })
      .include('#assistant-panel')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations.map(v => `${v.id}: ${v.help} ${v.nodes[0]?.target}`)).toEqual([]);

    // The conversations view too.
    await panel(page).getByRole('button', { name: 'Conversations' }).click();
    const history = await new AxeBuilder({ page })
      .include('#assistant-panel')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(history.violations.map(v => `${v.id}: ${v.help} ${v.nodes[0]?.target}`)).toEqual([]);
  });

  test('/chat passes axe and has no horizontal overflow', async ({ page }) => {
    await mockAgent(page, PLANS);
    await page.goto('/chat');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await ask(page, PROFIT);
    await expect(page.getByRole('region', { name: 'Profit and loss' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const results = await new AxeBuilder({ page })
      .include('main')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations.map(v => `${v.id}: ${v.help} ${v.nodes[0]?.target}`)).toEqual([]);
  });
});
