import {test, expect} from './fixtures';

// "Recently viewed", Figma's "Recents" (docs/figma-parity-shell.md): the files this browser opened lately, from the personal
// files and every team, the last opened first; before any opening the view says so.

test('should list the files opened in this browser from every place, the last opened first', async ({page, seed: _seed}) => {
  const team = ((await (await page.request.post('/api/design-teams', {data: {name: 'Studio'}})).json()) as {team: {id: string}}).team;
  for (const name of ['Personal', 'Never opened']) await page.request.post('/api/design-files', {data: {name}});
  await page.request.post('/api/design-files', {data: {name: 'Team file', teamId: team.id}});
  await page.goto('/#designs');

  const places = page.getByRole('navigation', {name: 'Sections'});
  await places.getByRole('button', {name: 'Recently viewed', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'You have not opened any files in this browser yet'})).toBeVisible();

  await places.getByRole('button', {name: 'Recent', exact: true}).click();
  await page.locator('.dz-file').filter({hasText: 'Personal'}).locator('.dz-file-hit').dblclick();
  await expect(page).toHaveURL(/#design\//);
  await page.goBack();
  await places.getByRole('button', {name: 'All files', exact: true}).click();
  await page.locator('.dz-file').filter({hasText: 'Team file'}).locator('.dz-file-hit').dblclick();
  await expect(page).toHaveURL(/#design\//);
  await page.goBack();

  await places.getByRole('button', {name: 'Recently viewed', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Recently viewed', level: 1})).toBeVisible();
  await expect(page.locator('.dz-file-name')).toHaveText(['Team file', 'Personal']);
  await expect(page.getByRole('button', {name: 'Sort'})).toHaveCount(0);
});
