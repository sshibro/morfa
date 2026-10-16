import {test, expect} from './fixtures';

// "Favorites", Figma's "Starred" (docs/figma-parity-shell.md; SQL018): a file or a project starred from its menu shows in the
// sidebar's section, which opens it; taking the star back empties the section; only what the caller may open can be starred.

test('should list a starred file in the sidebar, open it from there and take the star back', async ({page, seed: _seed}) => {
  const created = await (await page.request.post('/api/design-files', {data: {name: 'Main mockup'}})).json() as {file: {id: string}};
  await page.goto('/#designs');
  const starred = page.getByRole('group', {name: 'Favorites'});
  await expect(page.locator('.dz-file')).toHaveCount(1);
  await expect(starred).toHaveCount(0);

  const card = page.locator('.dz-file').filter({hasText: 'Main mockup'});
  await card.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Add to favorites'}).click();
  await expect(starred.getByRole('button', {name: 'Main mockup'})).toBeVisible();

  // Kept on the server: a reload lists it again.
  await page.reload();
  await expect(starred.getByRole('button', {name: 'Main mockup'})).toBeVisible();
  await starred.getByRole('button', {name: 'Main mockup'}).click();
  await expect(page).toHaveURL(new RegExp('#design/' + created.file.id));
  await page.goBack();
  // The menu says what the star is once the list is read again.
  await expect(starred.getByRole('button', {name: 'Main mockup'})).toBeVisible();

  await card.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Remove from favorites'}).click();
  await expect(starred).toHaveCount(0);
});

test('should list a starred project and open its files from the sidebar', async ({page, seed: _seed}) => {
  const team = ((await (await page.request.post('/api/design-teams', {data: {name: 'Studio'}})).json()) as {team: {id: string}}).team;
  const project = ((await (await page.request.post(`/api/design-teams/${team.id}/projects`, {data: {name: 'Website'}})).json()) as {project: {id: string}}).project;
  await page.request.post('/api/design-files', {data: {name: 'Home', teamId: team.id, projectId: project.id}});
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'Website', exact: true}).click();
  await page.locator('.dz-files-eyebrow').getByRole('button', {name: 'Team', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Add project to favorites'}).click();

  await page.getByRole('button', {name: 'Recent', exact: true}).click();
  const starred = page.getByRole('group', {name: 'Favorites'});
  await starred.getByRole('button', {name: 'Website'}).click();
  await expect(page.getByRole('heading', {name: 'Website'})).toBeVisible();
  await expect(page.locator('.dz-file')).toHaveCount(1);
});

test('should refuse a star on a file the caller cannot open', async ({page, seed: _seed}) => {
  const answer = await page.request.put('/api/design-favourites/files/00000000-0000-4000-8000-000000000000');
  expect(answer.status()).toBe(404);
  expect((await (await page.request.get('/api/design-favourites')).json())).toEqual({files: [], projects: []});
});

test('should star a file with the star on its card and by dragging it into "Favorites"', async ({page, seed: _seed}) => {
  for (const name of ['Star', 'Drag me']) await page.request.post('/api/design-files', {data: {name}});
  await page.goto('/#designs');
  const starred = page.getByRole('group', {name: 'Favorites'});
  const first = page.locator('.dz-file').filter({hasText: 'Star'});
  await first.hover();
  await first.getByRole('button', {name: 'Add to favorites'}).click();
  await expect(starred.getByRole('button', {name: 'Star'})).toBeVisible();
  await expect(first.getByRole('button', {name: 'Remove from favorites'})).toHaveAttribute('aria-pressed', 'true');

  // A card dragged onto the section is starred too.
  await page.locator('.dz-file').filter({hasText: 'Drag me'}).dragTo(starred);
  await expect(starred.getByRole('button', {name: 'Drag me'})).toBeVisible();

  await first.hover();
  await first.getByRole('button', {name: 'Remove from favorites'}).click();
  await expect(starred.getByRole('button', {name: 'Star'})).toHaveCount(0);
});

test('should show "Favorites" as a place to drop cards while one is dragged, even before anything is starred', async ({page, seed: _seed}) => {
  await page.request.post('/api/design-files', {data: {name: 'First'}});
  await page.goto('/#designs');
  const starred = page.getByRole('group', {name: 'Favorites'});
  await expect(starred).toHaveCount(0);
  await page.locator('.dz-file').filter({hasText: 'First'}).dragTo(page.getByRole('button', {name: 'Shared with me', exact: true}));
  await expect(starred).toHaveCount(0);
  await page.locator('.dz-file').hover();
  await page.mouse.down();
  await page.mouse.move(60, 400, {steps: 6});
  await expect(starred.getByText('Drag here to add')).toBeVisible();
  await page.mouse.up();
});
