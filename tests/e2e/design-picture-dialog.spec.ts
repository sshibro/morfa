import {crc32, deflateSync} from 'node:zlib';
import {test, expect, fileChooser, waitEditorReady} from './fixtures';
import type {Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

// The picture dialog (⇧⌘K, tools/image.ts) keeps its input in the page until it answers. A detached input is held by
// nothing once its click returns: a garbage collection while the dialog opens takes it, and the dialog is lost — no
// `filechooser` for Playwright, no picked files for the editor (on a bare page 172 of 200 dialogs).
// Here the browser collects on demand (V8's gc(), a launch flag, so the file runs in a worker of its own), every few
// milliseconds for half a second after the file input's click, the first time as soon as the key's handlers return.

test.use({launchOptions: {...(process.env.PLAYWRIGHT_CHROMIUM ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM} : {}), args: ['--js-flags=--expose-gc']}});

type Saved = {file: {name: string; version: number}; document: DesignDocument};

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

async function saved(page: Page, id: string): Promise<Saved> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Saved;
}

const ofType = (file: Saved, type: SceneNode['type']) => Object.values(file.document.nodes).filter(node => node.type === type);

/** A new empty file; returns its id and the canvas's centre. */
async function openNewFile(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  // The editor takes keys, and co-editing and the meeting have mounted (fixtures.ts `waitEditorReady`).
  await waitEditorReady(page);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + 30);
  return {id: fileIdFrom(page), centre: {x: box.x + Math.round(box.width / 2), y: box.y + Math.round(box.height / 2)}};
}

/** A plain grey PNG of the given size (an RGB image, one deflated IDAT). */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({length: height}, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('a picture placed with ⇧⌘K comes in when garbage is collected right after the dialog opens', async ({page, seed: _seed}) => {
  await page.addInitScript(() => {
    const gc = (globalThis as {gc?: () => void}).gc!;
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
      click.call(this);
      // Once the key's handlers have returned, before the browser has reported the dialog, and a few times after.
      if (this.type !== 'file') return;
      queueMicrotask(gc);
      const collecting = setInterval(gc, 5);
      setTimeout(() => clearInterval(collecting), 500);
    };
  });
  const {id, centre} = await openNewFile(page);
  const chooser = await fileChooser(page, () => page.keyboard.press('ControlOrMeta+Shift+k'));
  await chooser.setFiles({name: 'Screenshot.png', mimeType: 'image/png', buffer: png(120, 80)});
  await expect(page.getByRole('toolbar', {name: 'Tools'}).getByRole('button', {name: 'Image', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(centre.x, centre.y);
  await expect.poll(async () => ofType(await saved(page, id), 'RECTANGLE').map(node => [node.name, node.width, node.height])).toEqual([['Screenshot', 120, 80]]);
});
