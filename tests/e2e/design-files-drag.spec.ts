import type {Page} from '@playwright/test';
import {test, expect} from './fixtures';

// Dragging files onto a place in the sidebar, as Figma's file browser (docs/figma-parity-shell.md): onto a project they
// move into it, several at once when they are selected; onto "Trash" they go to the trash; a place that cannot take them
// does not light up.

type Created = {id: string};

async function teamWithProject(page: Page) {
  const team = ((await (await page.request.post('/api/design-teams', {data: {name: 'Studio'}})).json()) as {team: Created}).team;
  const project = await page.request.post(`/api/design-teams/${team.id}/projects`, {data: {name: 'Site'}});
  expect(project.ok()).toBeTruthy();
  const answer = await project.json() as {project?: Created; team?: {projects: Created[]}};
  return {teamId: team.id, projectId: answer.project?.id ?? answer.team!.projects[0].id};
}

async function teamFile(page: Page, teamId: string, name: string) {
  return ((await (await page.request.post('/api/design-files', {data: {name, teamId}})).json()) as {file: Created}).file.id;
}

const card = (page: Page, name: string) => page.locator('.dz-file').filter({hasText: name});
const projectOf = async (page: Page, id: string) => ((await (await page.request.get('/api/design-files/' + id)).json()) as {file: {projectId: string | null}}).file.projectId;

test('should move the selected files into a project when they are dragged onto it in the sidebar', async ({page, seed: _seed}) => {
  const {teamId, projectId} = await teamWithProject(page);
  const first = await teamFile(page, teamId, 'Home');
  const second = await teamFile(page, teamId, 'Catalog');
  await teamFile(page, teamId, 'Stays');
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'All files', exact: true}).click();
  await expect(page.locator('.dz-file')).toHaveCount(3);

  await card(page, 'Home').locator('.dz-file-hit').click();
  await card(page, 'Catalog').locator('.dz-file-hit').click({modifiers: ['ControlOrMeta']});
  const project = page.getByRole('button', {name: 'Site', exact: true});
  await card(page, 'Catalog').dragTo(project);
  await expect(page.locator('.dz-toast').filter({hasText: '2 files moved to the project "Site"'})).toBeVisible();
  await expect.poll(() => projectOf(page, first)).toBe(projectId);
  await expect.poll(() => projectOf(page, second)).toBe(projectId);

  await project.click();
  await expect(page.locator('.dz-file')).toHaveCount(2);
});

test('should send a dragged file to the trash and refuse a place that cannot take it', async ({page, seed: _seed}) => {
  await page.request.post('/api/design-files', {data: {name: 'Draft'}});
  await page.goto('/#designs');
  const file = card(page, 'Draft');
  await expect(file).toBeVisible();

  // "Shared with me" takes no files: no ring while the card is over it.
  const shared = page.getByRole('button', {name: 'Shared with me', exact: true});
  await file.hover();
  await page.mouse.down();
  const box = (await shared.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps: 8});
  await expect(shared).not.toHaveClass(/is-drop-target/);
  await page.mouse.up();
  await expect(file).toBeVisible();

  await file.dragTo(page.getByRole('button', {name: 'Trash', exact: true}));
  await expect(page.locator('.dz-file')).toHaveCount(0);
  await expect(page.locator('.dz-toast').filter({hasText: 'Moved to the trash: 1 file'})).toBeVisible();
});
