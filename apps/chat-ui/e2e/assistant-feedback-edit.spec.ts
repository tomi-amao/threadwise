/**
 * Thumbs up and down are saved for the review queue (assistant_feedback): one row per rating,
 * ids only, and only the person who gave it can see or change it. Runs in the mutations
 * project: it writes rows, and removes every one it wrote.
 */

import { test, expect, readManifest } from './fixtures';
import { api, deleteTestFeedback, feedbackRows, insertFeedback, signIn } from './helpers/db';
import { mockAgent, type Plan } from './helpers/fake-langgraph';

const seed = readManifest();
const QUESTION = 'What is my profit this financial year?';
const PLANS: Record<string, Plan> = { [QUESTION]: { answer: 'Your net profit is **£4,449.16**.' } };

test.afterEach(async () => {
  await deleteTestFeedback();
});

test.describe('the panel', () => {
  test('saves a rating, changes it, and removes it, as ids only', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockAgent(page, PLANS);
    await page.goto('/dashboard');
    await page.locator('#assistant-launcher').click();
    const composer = page.getByRole('textbox', { name: 'Ask about your business' });
    await composer.fill(QUESTION);
    await composer.press('Enter');
    const panel = page.locator('#assistant-panel');
    await expect(panel.getByText('£4,449.16')).toBeVisible();

    await panel.getByRole('button', { name: 'Good answer' }).click();
    await expect.poll(async () => (await feedbackRows()).map(r => r.rating)).toEqual(['up']);
    const [row] = await feedbackRows();
    // What is kept: who, which business, which thread and message, the rating. No text.
    expect(Object.keys(row).sort()).toEqual(
      [
        'created_at',
        'entity_id',
        'id',
        'message_id',
        'rating',
        'thread_id',
        'updated_at',
        'user_id',
      ].sort()
    );
    expect(JSON.stringify(row)).not.toContain('profit');

    // Changing their mind changes the same row, not a second one.
    await panel.getByRole('button', { name: 'Bad answer' }).click();
    await expect.poll(async () => (await feedbackRows()).map(r => r.rating)).toEqual(['down']);
    expect((await feedbackRows())[0].id).toBe(row.id);

    // Taking it back removes it.
    await panel.getByRole('button', { name: 'Bad answer' }).click();
    await expect.poll(async () => (await feedbackRows()).length).toBe(0);
  });
});

test.describe('who can see a rating', () => {
  const THREAD = 'thread-rls-check';

  test('only the person who gave it, and never another business or anyone not signed in', async () => {
    const mine = await signIn(seed.email);
    const theirs = await signIn(seed.rival.email);
    const own = (await api('GET', 'entities', 'select=id,owner_user_id', mine)).rows[0] as {
      id: string;
      owner_user_id: string;
    };
    const rival = (await api('GET', 'entities', 'select=id,owner_user_id', theirs)).rows[0] as {
      id: string;
      owner_user_id: string;
    };
    await insertFeedback({
      entity_id: own.id,
      user_id: own.owner_user_id,
      thread_id: THREAD,
      message_id: 'm-1',
      rating: 'down',
    });

    // The owner sees it; nobody else does.
    expect(
      (await api('GET', 'assistant_feedback', `thread_id=eq.${THREAD}`, mine)).rows
    ).toHaveLength(1);
    expect((await api('GET', 'assistant_feedback', `thread_id=eq.${THREAD}`, theirs)).rows).toEqual(
      []
    );
    expect((await api('GET', 'assistant_feedback', `thread_id=eq.${THREAD}`)).rows).toEqual([]);

    // Another user can neither change nor delete it (the row is simply not theirs).
    await api('PATCH', 'assistant_feedback', `thread_id=eq.${THREAD}`, theirs, { rating: 'up' });
    await api('DELETE', 'assistant_feedback', `thread_id=eq.${THREAD}`, theirs);
    const after = await api('GET', 'assistant_feedback', `thread_id=eq.${THREAD}`, mine);
    expect(after.rows.map(r => r.rating)).toEqual(['down']);

    // And cannot write as someone else, or into someone else's business.
    const asMe = await api('POST', 'assistant_feedback', '', theirs, {
      entity_id: rival.id,
      user_id: own.owner_user_id,
      thread_id: THREAD,
      message_id: 'm-2',
      rating: 'down',
    });
    expect(asMe.status).toBeGreaterThanOrEqual(400);
    const intoMine = await api('POST', 'assistant_feedback', '', theirs, {
      entity_id: own.id,
      user_id: rival.owner_user_id,
      thread_id: THREAD,
      message_id: 'm-3',
      rating: 'down',
    });
    expect(intoMine.status).toBeGreaterThanOrEqual(400);
    const anonymous = await api('POST', 'assistant_feedback', '', undefined, {
      entity_id: own.id,
      thread_id: THREAD,
      message_id: 'm-4',
      rating: 'down',
    });
    expect(anonymous.status).toBeGreaterThanOrEqual(400);
    expect((await feedbackRows()).map(r => r.message_id)).toEqual(['m-1']);
  });
});
