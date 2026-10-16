import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

// A file opened from checkpoint bytes and then edited keeps bytes in this browser (checkpoint bytes, not
// `JSON.stringify(state.doc)`, on hide and close): closing it writes the engine's shadow encoded at
// the saved version, and the next warm open takes those bytes as the server's current document — field for field.

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

/** The file's entry in this browser's warm-open cache: its version and whether its body is bytes. */
const kept = (page: Page, fileId: string) =>
  page.evaluate(
    id =>
      new Promise<{version: number; bytes: boolean} | null>(resolve => {
        const request = indexedDB.open('morfa-checkpoints');
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('meta')) return resolve(null);
          const tx = db.transaction(['meta', 'bodies']);
          const all = tx.objectStore('meta').getAll();
          all.onsuccess = () => {
            const entry = (all.result as {account: string; fileId: string; version: number}[]).find(each => each.fileId === id);
            if (!entry) return resolve(null);
            const body = tx.objectStore('bodies').get([entry.account, entry.fileId]);
            body.onsuccess = () => resolve({version: entry.version, bytes: body.result instanceof Uint8Array});
            body.onerror = () => resolve(null);
          };
          all.onerror = () => resolve(null);
        };
      }),
    fileId,
  );

const documents = (page: Page, fileId: string) =>
  page.evaluate(async id => {
    const shown = (window as unknown as {__morfaDesignTest: {store: {getState(): {doc: unknown}}}}).__morfaDesignTest.store.getState().doc;
    const stored = (await (await fetch('/api/design-files/' + encodeURIComponent(id))).json()) as {file: {version: number}; document: unknown};
    return {shown: JSON.parse(JSON.stringify(shown)), stored: stored.document, version: stored.file.version};
  }, fileId);

const reads = (page: Page, fileId: string) =>
  page.evaluate(id => ({
    reads: performance
      .getEntriesByType('resource')
      .map(entry => new URL(entry.name))
      .filter(url => url.pathname.startsWith('/api/design-files/' + id) && !/\/(comments|libraries|collab|events|session|sharing|thumbnail|meeting|presence)/.test(url.pathname))
      .map(url => url.pathname.replace('/api/design-files/' + id, '') + url.search),
    fromKept: performance.getEntriesByName('morfa:open:checkpoint').length > 0,
  }), fileId);

const ready = async (page: Page) => {
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as {__morfaDesignTest?: unknown}).__morfaDesignTest)).toBe(true);
};

test('a file opened from its bytes and edited keeps bytes at the saved version; the warm open is the server’s document', async ({page, seed: _seed}) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(100_000));
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  const serverVersion = async () => ((await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as {file: {version: number}}).file.version;
  const settled = async (above: number) => {
    let version = 0;
    await expect
      .poll(async () => {
        const before = await serverVersion();
        await new Promise(resolve => setTimeout(resolve, 1000));
        version = await serverVersion();
        return before === version && version > above;
      }, {timeout: 30_000})
      .toBe(true);
    return version;
  };
  const draw = async (x: number, y: number) => {
    const box = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
    await page.keyboard.press('r');
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + x + 90, box.y + y + 60, {steps: 3});
    await page.mouse.up();
    await page.keyboard.press('Escape');
  };
  await draw(200, 200);
  const first = await settled(1);
  // Closed once: its JSON is kept at that version, so the next open asks `?have=` and, with `?checkpoint=1`, reads the bytes.
  await page.evaluate(() => {
    location.hash = '#designs';
  });
  await expect.poll(() => kept(page, id), {timeout: 15_000}).toEqual({version: first, bytes: false});

  // Opened from the checkpoint (its bytes kept at the open), then edited and saved.
  await page.goto('/?bench=1&checkpoint=1&cold=1#design/' + encodeURIComponent(id));
  await ready(page);
  const cold = await reads(page, id);
  expect(cold.reads, JSON.stringify(cold)).toContain('/checkpoint');
  await expect.poll(() => kept(page, id), {timeout: 15_000}).toEqual({version: first, bytes: true});
  await draw(360, 260);
  const second = await settled(first);

  // Closing the file writes bytes at the saved version, never the document's JSON.
  await page.evaluate(() => {
    location.hash = '#designs';
  });
  await expect.poll(() => kept(page, id), {timeout: 15_000}).toEqual({version: second, bytes: true});

  // Warm: those bytes, confirmed current by `?have=`, no checkpoint read; the server's document field for field.
  await page.goto('/?bench=1&checkpoint=1&warm=1#design/' + encodeURIComponent(id));
  await ready(page);
  const warm = await reads(page, id);
  expect(warm.reads).toEqual([`?have=${second}`]);
  expect(warm.fromKept).toBe(true);
  const shown = await documents(page, id);
  expect(shown.version).toBe(second);
  expect(shown.shown).toEqual(shown.stored);
});
