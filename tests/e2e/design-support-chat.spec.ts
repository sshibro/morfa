import type {APIRequestContext} from '@playwright/test';
import {expect, test, type Seed} from './fixtures';
import {SUPPORT_API, type SupportConversation, type SupportInbox} from '../../shared/support';

// The support chat end to end (shared/support.ts): the person writes from the file browser's support button, sees who will answer (the
// team, never the operator's name; "Online" once the operator is in the console, "typing…" while they type) and the note after their
// first message; the operator answers through the console's API (/api/admin/support), the answer appears in the open panel under the
// team's name, and a closed panel's button counts it until the person reads it. The chat is off for every other spec; this one turns it on
// with its own operator (scripts/e2e-server.ts), whose account is named "Browser check".

const runKey = () => ({'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!});

async function newAccount(request: APIRequestContext): Promise<Seed> {
  const response = await request.post('/__e2e/fixtures', {headers: runKey(), data: {}});
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.describe('the support chat', () => {
  let operator: Seed;
  test.beforeEach(async ({request}) => {
    operator = await newAccount(request);
    expect((await request.post('/__e2e/support', {headers: runKey(), data: {on: true, operator: operator.accountId}})).ok()).toBeTruthy();
  });
  test.afterEach(async ({request}) => {
    await request.post('/__e2e/support', {headers: runKey(), data: {on: false}});
  });

  test('the person writes, the operator answers, the answer appears and is counted until read', async ({page, seed, request}) => {
    const asOperator = {cookie: 'forma_session=' + operator.token};
    const reply = async (threadId: string, body: string) => {
      const answer = await request.post('/api' + SUPPORT_API.reply(threadId), {headers: asOperator, data: {body, clientId: crypto.randomUUID()}});
      expect(answer.status(), await answer.text()).toBe(200);
      return (await answer.json()) as SupportConversation;
    };

    await page.goto('/#designs');
    const button = page.getByRole('button', {name: 'Contact support'});
    await expect(button).toBeVisible();
    // Only operators reach the console's routes.
    expect((await page.request.get('/api' + SUPPORT_API.inbox)).status()).toBe(404);

    await button.click();
    const panel = page.getByRole('dialog', {name: 'Morfa support'});
    await expect(panel).toBeVisible();
    // The team answers, never the operator by name; nobody has opened the console yet, so nobody is "Online".
    await expect(panel.getByRole('heading', {name: 'Morfa team'})).toBeVisible();
    await expect(panel.getByText(/Our team will answer you\s—\sreal people, not\sa\sbot/)).toBeVisible();
    await expect(panel.getByText(/Browser check/)).toHaveCount(0);
    await expect(panel.getByText(/We are offline right now/)).toBeVisible();
    await expect(panel.getByText(/We usually reply/)).toHaveCount(0);
    await expect(panel.getByText('Hello! How can we help?')).toBeVisible();
    const field = panel.getByRole('textbox', {name: 'Message to support'});
    await expect(field).toBeFocused();
    await panel.getByRole('button', {name: 'Need help with a file'}).click();
    await expect(field).toHaveValue(/^Hello! I need help with a file: $/);
    // The chip puts the caret at the end on the next frame, and gives the field focus back: type only after that.
    await expect(field).toBeFocused();
    await field.pressSequentially('the layout does not open?');
    await field.press('Shift+Enter');
    await field.pressSequentially('Thanks!');
    await field.press('Enter');
    await expect(field).toHaveValue('');
    const mine = panel.locator('.mf-sc-run.is-mine .mf-sc-bubble');
    await expect(mine).toHaveText('Hello! I need help with a file: the layout does not open?\nThanks!');
    await expect(panel.getByText('Sending…')).toHaveCount(0);
    // The note after the first message: who reads it; no letter is promised while this server sends no mail.
    const note = panel.getByRole('note');
    await expect(note).toContainText('Message received.');
    await expect(note).toContainText(/A person from our team will read it\. The reply will appear here\.$/);

    // The operator finds it waiting, with where it was written from; the person now sees them "Online".
    const inbox = await request.get('/api' + SUPPORT_API.inbox, {headers: asOperator});
    expect(inbox.status()).toBe(200);
    const row = ((await inbox.json()) as SupportInbox).rows.find(item => item.account.id === seed.accountId)!;
    expect(row.last.body).toContain('the layout does not open');
    const seen = (await (await request.get('/api' + SUPPORT_API.conversation(row.id), {headers: asOperator})).json()) as SupportConversation;
    expect(seen.messages[0]!.context).toEqual({where: 'files'});
    await expect(panel.getByText('Online', {exact: true})).toBeVisible({timeout: 15_000});
    // The operator types: "typing…" within one poll.
    expect((await request.post('/api' + SUPPORT_API.typing(row.id), {headers: asOperator, data: {}})).status()).toBe(204);
    await expect(panel.getByText('Morfa team is typing…')).toBeVisible({timeout: 15_000});
    await reply(row.id, 'Hello! Thanks, we are looking into it.');

    // The open panel shows it within one poll, says it to a screen reader, and reads it.
    const theirs = panel.locator('.mf-sc-run.is-theirs .mf-sc-bubble');
    await expect(theirs).toHaveText('Hello! Thanks, we are looking into it.', {timeout: 15_000});
    await expect(panel.locator('.mf-sc-run.is-theirs .mf-sc-author')).toHaveText('Morfa team');
    await expect(panel.getByText('Morfa team is typing…')).toHaveCount(0);
    await expect(panel.getByText(/Browser check/)).toHaveCount(0);
    await expect(panel.getByRole('note')).toHaveCount(0);
    await expect(panel.locator('[aria-live="polite"][aria-atomic="true"]')).toContainText('we are looking into it');
    await expect.poll(async () => ((await (await request.get('/api' + SUPPORT_API.conversation(row.id), {headers: asOperator})).json()) as SupportConversation).userReadAt).not.toBeNull();

    // Esc closes and gives the focus back to the button.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();

    // A new answer while the panel is closed: the button counts it (checked when the page opens), until the person reads it.
    await reply(row.id, 'If needed, we will send you an invoice.');
    await page.reload();
    const counted = page.getByRole('button', {name: 'Support. New support reply'});
    await expect(counted).toBeVisible({timeout: 15_000});
    await expect(counted.locator('.mf-support-badge')).toHaveText('1');
    await counted.click();
    await expect(panel.locator('.mf-sc-run.is-theirs .mf-sc-bubble').last()).toHaveText('If needed, we will send you an invoice.');
    await expect(page.locator('.mf-support-badge')).toHaveCount(0);
    expect((await (await page.request.get('/api' + SUPPORT_API.unread)).json()).unread).toBe(0);
  });

  test('"Help ▸ Contact support" in the editor: the message names the file, the menu notes the answer', async ({page, seed, request}) => {
    const asOperator = {cookie: 'forma_session=' + operator.token};
    await page.goto('/#designs');
    await page.getByRole('button', {name: 'New file', exact: true}).first().click();
    await expect(page).toHaveURL(/#design\/[^/?]+$/);
    const fileId = decodeURIComponent(/#design\/([^/?]+)$/.exec(page.url())![1]!);
    await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
    await page.getByRole('button', {name: 'Main menu', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Help', exact: true}).hover();
    await page.getByRole('menuitem', {name: /Contact support/}).click();
    const panel = page.getByRole('dialog', {name: 'Morfa support'});
    await expect(panel).toBeVisible();
    const field = panel.getByRole('textbox', {name: 'Message to support'});
    await expect(field).toBeFocused();
    // Typing in the chat is the chat's: the editor's single-key tools do not take the letters.
    await field.pressSequentially('A layer vanished after undo');
    await field.press('Enter');
    await expect(panel.locator('.mf-sc-run.is-mine .mf-sc-bubble')).toHaveText('A layer vanished after undo');
    await expect(panel.getByText('Sending…')).toHaveCount(0);

    const inbox = (await (await request.get('/api' + SUPPORT_API.inbox, {headers: asOperator})).json()) as SupportInbox;
    const row = inbox.rows.find(item => item.account.id === seed.accountId)!;
    const seen = (await (await request.get('/api' + SUPPORT_API.conversation(row.id), {headers: asOperator})).json()) as SupportConversation;
    expect(seen.messages[0]!.context).toEqual({fileId, where: 'editor'});
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    const answered = await request.post('/api' + SUPPORT_API.reply(row.id), {headers: asOperator, data: {body: 'Try "Edit ▸ Redo".', clientId: crypto.randomUUID()}});
    expect(answered.status()).toBe(200);
    await page.reload();
    const menu = page.getByRole('button', {name: 'Main menu. New support reply', exact: true});
    await expect(menu).toBeVisible({timeout: 15_000});
    await menu.click();
    await page.getByRole('menuitem', {name: 'Help', exact: true}).hover();
    const item = page.getByRole('menuitem', {name: /Contact support/});
    await expect(item).toContainText('New support reply');
    await item.click();
    await expect(panel.locator('.mf-sc-run.is-theirs .mf-sc-bubble')).toHaveText('Try "Edit ▸ Redo".');
    await expect(page.getByRole('button', {name: 'Main menu', exact: true})).toBeVisible();
  });
});
