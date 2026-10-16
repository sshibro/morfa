import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';
import {createSticky} from '../../shared/design/board/create';
import type {DesignTemplateContent, DesignTemplateSummary} from '../../shared/design/api';

// Custom team templates on a board (help.figma.com "Create custom templates in FigJam"; lane S's routes, lane FJ's client):
// "File → Publish as template…" on a team's board, and "+" → "Templates" → "Team templates" on a board of the team. The e2e
// server publishes for real, and the insert reads a list and a content answered here in the shape lane S's routes answer.

async function saved(page: Page, id: string): Promise<DesignDocument> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as {document: DesignDocument}).document;
}

async function teamBoard(page: Page, name: string) {
  const teamId = ((await (await page.request.post('/api/design-teams', {data: {name: 'North Studio'}})).json()) as {team: {id: string}}).team.id;
  const id = ((await (await page.request.post('/api/design-files', {data: {name, teamId, kind: 'board'}})).json()) as {file: {id: string}}).file.id;
  await page.goto('/#design/' + encodeURIComponent(id));
  await expect(page.locator('.bd-top-left').getByRole('status')).toHaveText('Saved');
  const sheet = page.getByRole('dialog', {name: 'More: templates, stickers, stamps'});
  await expect(sheet).toBeVisible();
  return {teamId, id, sheet};
}

test('should publish a team board from "Publish as template…"', async ({page, seed: _seed}) => {
  const {sheet} = await teamBoard(page, 'Team standup');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  const canvas = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  await page.keyboard.press('KeyS');
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.keyboard.type('Agenda');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByRole('combobox').fill('Publish as template');
  // Enter runs the highlighted row: wait until the list has settled and highlights the match.
  await expect(page.getByRole('dialog', {name: 'Actions'}).getByRole('option', {name: 'Publish as template…', selected: true})).toBeVisible();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {name: 'Publish as template'});
  await expect(dialog.getByRole('textbox', {name: 'Template name'})).toHaveValue('Team standup');
  await dialog.getByRole('textbox', {name: 'Template description'}).fill('Every morning, 15 minutes');
  const [request] = await Promise.all([page.waitForRequest(r => r.method() === 'POST' && /\/template$/.test(r.url())), dialog.getByRole('button', {name: 'Publish'}).click()]);
  expect(request.postDataJSON()).toMatchObject({name: 'Team standup', description: 'Every morning, 15 minutes', scope: 'team'});
  await expect(page.getByText('Template "Team standup" published')).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test('should insert one of the team\'s templates from the "+" sheet', async ({page, seed: _seed}) => {
  // The template's content as lane S's route gives it: a sticky's layers with fresh ids, parents first, the root unparented.
  let n = 0;
  const sticky = createSticky(() => `tpl:${++n}`, {x: 400, y: 300, text: 'Agenda'});
  const content: DesignTemplateContent = {
    pieces: sticky.pieces.map(piece => ({...piece.node, parentId: piece.parent ? piece.parent : null}) as SceneNode),
    roots: [sticky.id], bounds: {x: 400, y: 300, width: sticky.pieces[0].node.width, height: sticky.pieces[0].node.height}, images: {},
  };
  let teamId = '';
  const summary = (): DesignTemplateSummary => ({
    id: 'tpl-1', fileId: 'source', name: 'Team standup', description: 'Every morning', version: 1, publishedAt: new Date().toISOString(), teamId,
    scope: 'team', thumbnailUrl: null, publishedBy: {name: 'Anna'},
  });
  await page.route('**/api/design-templates?teamId=*', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({templates: [summary()]})}));
  await page.route('**/api/design-templates/tpl-1/content?*', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(content)}));
  const board = await teamBoard(page, 'New team board');
  teamId = board.teamId;
  await board.sheet.getByRole('tab', {name: 'Templates'}).click();
  await expect(board.sheet.getByRole('heading', {name: 'Team templates'})).toBeVisible();
  await board.sheet.getByRole('button', {name: /Team standup/}).click();
  await expect(board.sheet).toBeHidden();
  await expect.poll(async () => {
    const doc = await saved(page, board.id);
    return Object.values(doc.nodes).filter(node => node.board?.kind === 'sticky').length;
  }).toBe(1);
});
