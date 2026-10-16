import {test, expect} from './fixtures';
import {figmaKit, NUXT_LIKE} from '../helpers/figma-kit';
import {figKit} from '../helpers/fig-kit';

// A big UI kit imported through "Import from Figma" in the browser, from a link
// (a fake Figma answers the API with a generated kit of Nuxt UI's shape) and from a .fig of the same shape; the import runs in its
// worker (src/design/import/figma/import-runner.ts), so the page never stops for long; the file is saved as a skeleton and then its layers in parts (run-import.ts `saveInParts`: the kit is
// over 8 MB as the file stores it), and it opens. The e2e server runs with big files off: the kit stays under its 20 MB.

const KEY = 'KIT1234567890abcdef';

test('a UI kit over 8 MB imports from Figma in the worker, saved in parts, and opens', async ({page, seed: _seed}) => {
  test.setTimeout(240_000);
  const kit = figmaKit({...NUXT_LIKE, pages: 14, borrow: true, pictures: 0});
  const fileJson = JSON.stringify(kit.file);
  const figmaCalls: string[] = [];
  // A page route registered after the fixture's catch-all is matched first (Playwright matches the last route first).
  await page.route('https://api.figma.com/**', async route => {
    const url = new URL(route.request().url());
    figmaCalls.push(url.pathname);
    // Figma answers cross-origin calls with CORS headers; a call with a token is preflighted.
    const cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET'};
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    const json = (body: string) => route.fulfill({status: 200, contentType: 'application/json', headers: cors, body});
    if (url.pathname === '/v1/me') return json(JSON.stringify({id: '1', handle: 'designer'}));
    if (url.pathname === `/v1/files/${KEY}/images`) return json(JSON.stringify({meta: {images: {}}}));
    if (url.pathname === `/v1/files/${KEY}`) return json(fileJson);
    return route.fulfill({status: 404, contentType: 'application/json', headers: cors, body: '{"status":404,"err":"Not found"}'});
  });
  const saves: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (/\/api\/design-files\/[^/]+\/document$/.test(url.pathname)) saves.push(request.method());
  });

  await page.goto('/#designs');
  await page.getByRole('button', {name: 'Import', exact: true}).click();
  await page.getByRole('menuitem', {name: /Import from Figma/}).click();
  const dialog = page.getByRole('dialog', {name: 'Import from Figma'});
  await expect(dialog).toBeVisible();
  // ".fig file" is the default tab.
  await dialog.getByRole('radio', {name: 'Link and token'}).click();
  await dialog.getByPlaceholder('https://www.figma.com/design/…').fill(`https://www.figma.com/design/${KEY}/Nuxt-UI`);
  const token = dialog.getByPlaceholder('figd_…');
  if (await token.isVisible()) await token.fill('figd_e2e-token');
  await dialog.getByRole('button', {name: 'Continue'}).click();
  await expect(dialog.getByRole('group', {name: 'Pages'})).toBeVisible({timeout: 60_000});

  // The page's longest stop while the import runs: the mapping and the parts are written in the worker.
  await page.evaluate(() => {
    const state = window as unknown as {__longest: number};
    state.__longest = 0;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.__longest = Math.max(state.__longest, entry.duration);
    }).observe({type: 'longtask', buffered: false});
  });
  await dialog.getByRole('button', {name: /^Import /}).click();
  await expect(dialog.getByRole('button', {name: 'Open file'})).toBeVisible({timeout: 180_000});
  const longest = await page.evaluate(() => (window as unknown as {__longest: number}).__longest);
  expect(longest, 'no long stop of the page while importing').toBeLessThan(400);
  expect(figmaCalls).toContain(`/v1/files/${KEY}`);
  // A skeleton (PUT), then the layers in parts (PATCH).
  expect(saves[0]).toBe('PUT');
  expect(saves.filter(method => method === 'PATCH').length).toBeGreaterThan(1);

  await dialog.getByRole('button', {name: 'Open file'}).click();
  await expect(page).toHaveURL(/#design\/[^/?]+/);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  const id = decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
  const opened = (await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as {document: {pages: string[]; nodes: Record<string, unknown>}};
  const layers = [...kit.layersByPage.values()].reduce((a, b) => a + b, 0);
  expect(Object.keys(opened.document.nodes).length).toBeGreaterThan(layers * 0.95);
  expect(opened.document.pages.length).toBeGreaterThanOrEqual(14);
});

test('a UI kit saved as a .fig over 8 MB imports in the worker, saved in parts, and opens', async ({page, seed: _seed}) => {
  test.setTimeout(240_000);
  const kit = figKit({...NUXT_LIKE, pages: 14, borrow: true, pictures: 2});
  const saves: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (/\/api\/design-files\/[^/]+\/document$/.test(url.pathname)) saves.push(request.method());
  });

  await page.goto('/#designs');
  await page.getByRole('button', {name: 'Import', exact: true}).click();
  await page.getByRole('menuitem', {name: /Import from Figma/}).click();
  const dialog = page.getByRole('dialog', {name: 'Import from Figma'});
  await expect(dialog.getByRole('radio', {name: '.fig file'})).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => {
    const state = window as unknown as {__longest: number};
    state.__longest = 0;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.__longest = Math.max(state.__longest, entry.duration);
    }).observe({type: 'longtask', buffered: false});
  });
  await dialog.locator('input[type=file]').setInputFiles({name: 'Nuxt UI.fig', mimeType: 'application/octet-stream', buffer: Buffer.from(kit.zip)});
  await dialog.getByRole('button', {name: 'Continue'}).click();
  await expect(dialog.getByRole('group', {name: 'Pages'})).toBeVisible({timeout: 60_000});
  await dialog.getByRole('button', {name: /^Import /}).click();
  await expect(dialog.getByRole('button', {name: 'Open file'})).toBeVisible({timeout: 180_000});
  // Unpacking, mapping and writing the parts happen in the worker: the page never stops for long.
  const longest = await page.evaluate(() => (window as unknown as {__longest: number}).__longest);
  expect(longest, 'no long stop of the page while importing').toBeLessThan(400);
  expect(saves[0]).toBe('PUT');
  expect(saves.filter(method => method === 'PATCH').length).toBeGreaterThan(1);

  await dialog.getByRole('button', {name: 'Open file'}).click();
  await expect(page).toHaveURL(/#design\/[^/?]+/);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  const id = decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
  const opened = (await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as {file: {name: string}; document: {pages: string[]; nodes: Record<string, unknown>; images: Record<string, unknown>}};
  expect(opened.file.name).toBe('Nuxt UI');
  expect(Object.keys(opened.document.nodes).length).toBeGreaterThan(kit.layers * 0.95);
  expect(opened.document.pages.length).toBeGreaterThanOrEqual(15);
  expect(Object.keys(opened.document.images).length).toBe(2);
});
