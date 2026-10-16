import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

// The open from the binary checkpoint (`?checkpoint=1` asks for it on any file): the
// editor reads `GET /:id/checkpoint`, decodes it in wasm (`MorfaDoc.decode_from`), takes the nodes in parts and
// keeps the bytes for the next open, which asks `?have=` and decodes its own copy. Both times the document must be the
// server's, field for field.

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

/** The version of the file's entry in this browser's warm-open cache, or null. */
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

/** The editor's document and the server's, read whole as JSON. */
const documents = (page: Page, fileId: string) =>
  page.evaluate(async id => {
    const shown = (window as unknown as {__morfaDesignTest: {store: {getState(): {doc: unknown}}}}).__morfaDesignTest.store.getState().doc;
    const stored = (await (await fetch('/api/design-files/' + encodeURIComponent(id))).json()) as {file: {version: number}; document: unknown};
    return {shown: JSON.parse(JSON.stringify(shown)), stored: stored.document, version: stored.file.version};
  }, fileId);

/** The document's reads of this page load (resource timings), and whether the editor decoded its own bytes. */
const howOpened = (page: Page, fileId: string) =>
  page.evaluate(id => {
    const reads = performance
      .getEntriesByType('resource')
      .map(entry => new URL(entry.name))
      .filter(url => url.pathname.startsWith('/api/design-files/' + id) && !/\/(comments|libraries|collab|events|session|sharing|thumbnail|meeting|presence)/.test(url.pathname))
      .map(url => url.pathname.replace('/api/design-files/' + id, '') + url.search);
    return {reads, fromKept: performance.getEntriesByName('morfa:open:checkpoint').length > 0};
  }, fileId);

test('a file opened from its checkpoint bytes, cold and warm, is the server’s document field for field', async ({page, seed: _seed}) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(100_000));
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  const id = fileIdFrom(page);
  // Layers with text and fills (shared values in a part), saved.
  await page.keyboard.press('r');
  const box = (await canvas.boundingBox())!;
  for (const [x, y] of [[200, 200], [360, 220], [240, 340]]) {
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + x + 90, box.y + y + 60, {steps: 3});
    await page.mouse.up();
    await page.keyboard.press('r');
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 420, box.y + 380);
  await page.keyboard.type('Hello, checkpoint');
  await page.keyboard.press('Escape');
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

  // Closing the file keeps its JSON in this browser (src/design/editor/open-file.ts keepCheckpointFresh).
  await page.evaluate(() => {
    location.hash = '#designs';
  });
  await expect.poll(() => keptVersion(page, id), {timeout: 15_000}).toBe(settled);

  // Cold for the bytes: the kept JSON is current (`?have=`), but it is not a checkpoint — the checkpoint is read, decoded and
  // taken in parts, and its bytes replace the JSON in the cache.
  await page.goto('/?bench=1&checkpoint=1&cold=1#design/' + encodeURIComponent(id));
  await expect(canvas).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest)).toBe(true);
  const cold = await howOpened(page, id);
  expect(cold.reads).toEqual([`?have=${settled}`, '/checkpoint']);
  expect(cold.fromKept).toBe(false);
  const first = await documents(page, id);
  expect(first.shown).toEqual(first.stored);
  await expect(page.getByRole('tree', {name: 'Layers'}).getByText('Hello, checkpoint')).toBeVisible();

  // Warm: the kept bytes, confirmed current by `?have=`, no checkpoint read.
  await page.goto('/?bench=1&checkpoint=1&warm=1#design/' + encodeURIComponent(id));
  await expect(canvas).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest)).toBe(true);
  const warm = await howOpened(page, id);
  expect(warm.reads).toEqual([`?have=${settled}`]);
  expect(warm.fromKept).toBe(true);
  const second = await documents(page, id);
  expect(second.version).toBe(settled);
  expect(second.shown).toEqual(second.stored);
});
