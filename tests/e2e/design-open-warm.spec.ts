import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

// The warm open (lane O, src/design/editor/checkpoint-cache.ts): the editor keeps the saved document in IndexedDB when it
// closes; the next open asks `GET /:id?have=<version>`, the server answers `current` without the document, and the editor shows
// its own copy — which must be the server's document, field for field. After someone saves a newer version, the open is whole.

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

/** The version of the file's checkpoint in this browser, or null. */
const keptVersion = (page: Page, fileId: string) =>
  page.evaluate(
    id =>
      new Promise<number | null>(resolve => {
        const request = indexedDB.open('morfa-checkpoints');
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('meta')) return resolve(null);
          const all = db.transaction('meta').objectStore('meta').getAll();
          all.onsuccess = () => resolve((all.result as {fileId: string; version: number}[]).find(entry => entry.fileId === id)?.version ?? null);
          all.onerror = () => resolve(null);
        };
      }),
    fileId,
  );

/** The editor's document and the server's, read whole without `have`. */
const documents = (page: Page, fileId: string) =>
  page.evaluate(async id => {
    const shown = (window as unknown as {__morfaDesignTest: {store: {getState(): {doc: unknown}}}}).__morfaDesignTest.store.getState().doc;
    const stored = (await (await fetch('/api/design-files/' + encodeURIComponent(id))).json()) as {file: {version: number}; document: unknown};
    return {shown: JSON.parse(JSON.stringify(shown)), stored: stored.document, version: stored.file.version};
  }, fileId);

test('a file opened again comes from this browser’s copy only while the server holds that version, equal to the server’s', async ({page, seed: _seed}) => {
  // The dev server serves every module on its own: a page load fills Chromium's default 250 resource-timing entries before the
  // document's read, which then has no entry to look at (the cause of this spec's failures in other containers). Room for all.
  await page.addInitScript(() => performance.setResourceTimingBufferSize(100_000));
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  const id = fileIdFrom(page);
  // A layer, saved.
  await page.keyboard.press('r');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 320, box.y + 280, {steps: 4});
  await page.mouse.up();
  await expect(page.getByText('Saved')).toBeVisible();

  // Every save landed: the server's version holds still for a second (the layer may take more than one save under load).
  const serverVersion = async () => ((await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as {file: {version: number}}).file.version;
  let settled = 0;
  await expect
    .poll(async () => {
      const before = await serverVersion();
      await new Promise(resolve => setTimeout(resolve, 1000));
      settled = await serverVersion();
      return before === settled && settled > 1;
    }, {timeout: 30_000})
    .toBe(true);
  // Closing the file keeps its saved document.
  await page.evaluate(() => {
    location.hash = '#designs';
  });
  const kept = settled;
  await expect.poll(() => keptVersion(page, id), {timeout: 15_000}).toBe(kept);
  expect(await serverVersion()).toBe(kept);

  // Opened again: `have` answered `current`, no document on the wire, the editor's document the server's.
  /** How the page's open went: the `?have=` read's address and decoded size, and whether the editor took its document from the
   *  checkpoint (`morfa:open:checkpoint`, marked with `?bench=1`, src/design/editor/open-file.ts). */
  const howOpened = () =>
    page.evaluate(fileId => {
      const read = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/api/design-files/' + fileId && new URL(entry.name).searchParams.has('have')) as PerformanceResourceTiming | undefined;
      return {url: read ? new URL(read.name).pathname + new URL(read.name).search : null, bytes: read?.decodedBodySize ?? -1, fromCheckpoint: performance.getEntriesByName('morfa:open:checkpoint').length > 0};
    }, id);
  await page.goto('/?bench=1&again=1#design/' + encodeURIComponent(id));
  await expect(canvas).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest)).toBe(true);
  const warmOpen = await howOpened();
  expect(warmOpen.url).toBe(`/api/design-files/${id}?have=${kept}`);
  expect(warmOpen.fromCheckpoint).toBe(true);
  expect(warmOpen.bytes).toBeLessThan(1000);
  const warm = await documents(page, id);
  expect(warm.version).toBe(kept);
  expect(warm.shown).toEqual(warm.stored);

  // An edit in the warm session: closing the file writes a newer checkpoint, and the page is left at once, while that write may
  // still be under way (a page loaded then used to find no checkpoint at all: the old write removed before it put).
  await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 420, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 520, box.y + 300, {steps: 4});
  await page.mouse.up();
  await expect.poll(serverVersion).toBeGreaterThan(kept);
  // Someone saves a newer version while the file is closed: the next open downloads it whole, and shows that one.
  await page.evaluate(() => {
    location.hash = '#designs';
  });
  await expect(page).toHaveURL(/#designs$/);
  const opened = (await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as {file: {version: number}; document: {pages: string[]; nodes: Record<string, {name?: string}>}};
  const first = opened.document.pages[0];
  const renamed = {...opened.document, nodes: {...opened.document.nodes, [first]: {...opened.document.nodes[first], name: 'Page from another device'}}};
  const put = await page.request.put('/api/design-files/' + encodeURIComponent(id) + '/document', {data: {baseVersion: opened.file.version, document: renamed}, headers: {origin: new URL(page.url()).origin}});
  expect(put.ok(), await put.text()).toBeTruthy();
  await page.goto('/?bench=1&again=2#design/' + encodeURIComponent(id));
  await expect(canvas).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest)).toBe(true);
  const wholeOpen = await howOpened();
  // The checkpoint the editor kept: `kept`, or a later version it wrote while the file was open; never none.
  expect(wholeOpen.url).toMatch(new RegExp(`^/api/design-files/${id}\\?have=\\d+$`));
  expect(Number(wholeOpen.url!.split('have=')[1])).toBeGreaterThanOrEqual(kept);
  expect(wholeOpen.fromCheckpoint).toBe(false);
  expect(wholeOpen.bytes).toBeGreaterThan(1000);
  await expect.poll(async () => (await documents(page, id).catch(() => null))?.shown).toEqual((await documents(page, id)).stored);
  expect(((await documents(page, id)).shown as {nodes: Record<string, {name: string}>}).nodes[first].name).toBe('Page from another device');
});
