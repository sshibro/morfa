import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import {Fingers} from './phone';

// The file browser by touch: several files selected without ⌘ or Shift
// ("Select" in a file's menu, then taps), the trash menu. At 390 (a phone) and 820 (a tablet) with touch.

type Listed = {files: {id: string; name: string; trashedAt?: string | null}[]};
const list = async (page: Page) => ((await (await page.request.get('/api/design-files')).json()) as Listed).files;

async function hold(page: Page, name: string) {
  const fingers = await Fingers.on(page);
  const box = (await page.locator('.dz-file').filter({hasText: name}).locator('.dz-file-hit').boundingBox())!;
  await fingers.down([{x: box.x + box.width / 2, y: box.y + box.height / 3}]);
  await page.waitForTimeout(700);
  await fingers.up();
}

const inside = async (page: Page, role: 'dialog' | 'menu') => {
  const box = (await page.getByRole(role).last().boundingBox())!;
  const size = page.viewportSize()!;
  return box.x >= -0.5 && box.x + box.width <= size.width + 0.5 && box.y + box.height <= size.height + 0.5;
};

for (const size of [{width: 390, height: 844}, {width: 820, height: 1180}]) {
  test.describe(`at ${size.width}`, () => {
    test.use({viewport: size, hasTouch: true, isMobile: true, deviceScaleFactor: 2});
    const phone = size.width < 768;

    test('should select several files by touch and act on all of them', async ({page, seed: _seed}) => {
      for (const name of ['Alpha', 'Beta', 'Gamma']) expect((await page.request.post('/api/design-files', {data: {name}})).ok()).toBeTruthy();
      await page.goto('/#designs');
      await expect(page.locator('.dz-file')).toHaveCount(3);
      await hold(page, 'Alpha');
      await page.getByRole('menuitem', {name: 'Select', exact: true}).tap();
      await page.locator('.dz-file').filter({hasText: 'Beta'}).locator('.dz-file-hit').tap();
      await expect(page.locator('.dz-file.is-selected')).toHaveCount(2);
      // A tap on a selected file takes it out; another puts it back.
      await page.locator('.dz-file').filter({hasText: 'Beta'}).locator('.dz-file-hit').tap();
      await expect(page.locator('.dz-file.is-selected')).toHaveCount(1);
      await page.locator('.dz-file').filter({hasText: 'Beta'}).locator('.dz-file-hit').tap();
      await hold(page, 'Beta');
      await expect(page.getByRole('menu').last()).toContainText('Selected: 2');
      await expect.poll(() => inside(page, 'menu')).toBe(true);
      await page.getByRole('menuitem', {name: /^Duplicate 2/}).tap();
      await expect.poll(async () => (await list(page)).length).toBe(5);
    });

    test('should open a trashed file\'s menu by touch and restore it', async ({page, seed: _seed}) => {
      const created = await page.request.post('/api/design-files', {data: {name: 'Old layout'}});
      expect(created.ok()).toBeTruthy();
      await page.goto('/#designs');
      await hold(page, 'Old layout');
      await page.getByRole('menuitem', {name: 'Move to trash'}).tap();
      await expect.poll(async () => (await list(page)).filter(file => !file.trashedAt).length).toBe(0);
      if (phone) await page.getByRole('button', {name: 'Sections'}).tap();
      await page.getByRole('link', {name: 'Trash'}).or(page.getByRole('button', {name: 'Trash'})).first().tap();
      await page.locator('.dz-file').filter({hasText: 'Old layout'}).locator('.dz-file-hit').tap();
      const menu = page.getByRole('menu').last();
      await expect(menu.getByRole('menuitem', {name: 'Duplicate to personal files'})).toBeVisible();
      await expect.poll(() => inside(page, 'menu')).toBe(true);
      await menu.getByRole('menuitem', {name: 'Restore'}).tap();
      await expect.poll(async () => (await list(page)).filter(file => !file.trashedAt).length).toBe(1);
    });

    test('should keep the list view\'s names readable, find a project and reach "Recently viewed" by touch', async ({page, seed: _seed}) => {
      const team = ((await (await page.request.post('/api/design-teams', {data: {name: 'Studio'}})).json()) as {team: {id: string}}).team;
      const project = ((await (await page.request.post(`/api/design-teams/${team.id}/projects`, {data: {name: 'Coffee shop site'}})).json()) as {project: {id: string}}).project;
      await page.request.post('/api/design-files', {data: {name: 'Home', teamId: team.id, projectId: project.id}});
      for (const name of ['Coffee shop menu', 'Event poster']) expect((await page.request.post('/api/design-files', {data: {name}})).ok()).toBeTruthy();
      await page.goto('/#designs');
      await expect(page.locator('.dz-file')).toHaveCount(2);
      // The list (SH): the name's column keeps its room beside the dates, and "⋯" is a finger's size.
      await page.getByRole('radio', {name: 'List'}).tap();
      const row = page.locator('.dz-file').filter({hasText: 'Coffee shop menu'});
      expect((await row.locator('.dz-file-name').boundingBox())!.width).toBeGreaterThanOrEqual(100);
      expect((await row.getByRole('button', {name: 'File actions'}).boundingBox())!.width).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      // "Recently viewed" from the drawer on a phone, the sidebar on a tablet.
      await page.locator('.dz-file').filter({hasText: 'Event poster'}).locator('.dz-file-hit').dblclick();
      await expect(page).toHaveURL(/#design\//);
      await page.goBack();
      if (phone) await page.getByRole('button', {name: 'Sections'}).tap();
      await page.getByRole('navigation', {name: 'Sections'}).getByRole('button', {name: 'Recently viewed', exact: true}).tap();
      await expect(page.locator('.dz-file-name')).toHaveText(['Event poster']);
      if (phone) await expect(page.getByRole('navigation', {name: 'Sections'})).toBeHidden();
      // The search's "Projects" fits the screen and opens the project with a tap.
      await page.getByRole('searchbox', {name: 'Search files'}).fill('coffee');
      const projects = page.getByRole('region', {name: 'Projects'});
      const box = (await projects.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      await projects.getByRole('button', {name: /Coffee shop site/}).tap();
      await expect(page.locator('.dz-file')).toHaveText([/Home/]);
    });
  });
}
