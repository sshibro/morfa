import {test, expect} from './fixtures';

// The browser's search finds projects as well as files, as Figma's results do (docs/figma-parity-shell.md "Search"): a project
// of any of the caller's teams whose name matches shows above the files, and opens with a click.

test('should find a team project by its name and open it from the results', async ({page, seed: _seed}) => {
  const team = ((await (await page.request.post('/api/design-teams', {data: {name: 'Studio'}})).json()) as {team: {id: string}}).team;
  const project = ((await (await page.request.post(`/api/design-teams/${team.id}/projects`, {data: {name: 'Coffee shop site'}})).json()) as {project: {id: string}}).project;
  await page.request.post('/api/design-files', {data: {name: 'Home', teamId: team.id, projectId: project.id}});
  await page.request.post('/api/design-files', {data: {name: 'Coffee shop menu'}});
  await page.goto('/#designs');
  await expect(page.locator('.dz-file')).toHaveCount(1);

  await page.getByRole('searchbox', {name: 'Search files'}).fill('coffee');
  const projects = page.getByRole('region', {name: 'Projects'});
  await expect(projects.getByRole('button', {name: /Coffee shop site/})).toBeVisible();
  await expect(page.locator('.dz-file').filter({hasText: 'Coffee shop menu'})).toBeVisible();

  await projects.getByRole('button', {name: /Coffee shop site/}).click();
  await expect(page.getByRole('heading', {name: 'Coffee shop site', level: 1})).toBeVisible();
  await expect(page.locator('.dz-file')).toHaveCount(1);
  await expect(page.getByRole('searchbox', {name: 'Search files'})).toHaveValue('');
  await expect(projects).toHaveCount(0);
});
