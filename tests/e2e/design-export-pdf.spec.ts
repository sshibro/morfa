import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {test, expect} from './fixtures';
import type {Download, Page} from '@playwright/test';
import {createDocument, createNode, defaultTextProps, defaultTextStyle, solid} from '../../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../shared/design/types';
import {pageBoxes} from '../../server/design/pdf/page-boxes';

// Morfa Design vector PDF (docs/design-tool.md §Export): two frames are written through the API, selected in "Layers",
// given a PDF setting in "Export" and exported together — one PDF, a page per frame in reading order, each the frame's
// exact size in points, with text that can be copied out — then again from the export dialog (⇧⌘E). The server prints
// it in its sandboxed Chromium; where that browser cannot start (Chromium's sandbox needs unprivileged user namespaces) the editor says so and the spec stops there.

const hex = (value: string) => {
  const n = parseInt(value.slice(1), 16);
  return {r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255};
};

function posterAndPhone(): DesignDocument {
  let doc = createDocument('page', 'Print');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}) => {
    const node = createNode(type, props);
    const parent = doc.nodes[props.parentId];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  };
  const text = (id: string, parentId: string, characters: string, y: number, size: number, weight: number, family = 'Inter') =>
    add('TEXT', {id, parentId, name: characters, x: 32, y, width: 520, height: size * 1.3, fills: [solid(hex('#1E1E1E'))],
      text: {...defaultTextProps(characters), style: {...defaultTextStyle(), fontFamily: family, fontSize: size, fontWeight: weight}, textAutoResize: 'NONE'}});
  // The phone screen sits left of the poster but below it: reading order (rows, then left to right) puts the poster first.
  add('FRAME', {id: 'poster', parentId: 'page', name: 'Poster', x: 500, y: 0, width: 600, height: 400, fills: [solid(hex('#FFFFFF'))]});
  // Cyrillic text on purpose: the PDF must embed and extract non-Latin glyphs (checkPdf looks for these words).
  text('headline', 'poster', 'Весенняя распродажа', 40, 40, 800);
  text('lead', 'poster', 'Скидки до 50% на всё — Spring sale', 100, 20, 450);
  const card = createNode('RECTANGLE', {id: 'card', parentId: 'poster', x: 32, y: 180, width: 240, height: 160, cornerRadius: 16, fills: [solid(hex('#0D99FF'))]});
  card.effects = [{type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.25}, offset: {x: 0, y: 8}, radius: 24, spread: 0, blendMode: 'NORMAL', showShadowBehindNode: false}];
  doc = {...doc, nodes: {...doc.nodes, card, poster: {...doc.nodes.poster, children: [...doc.nodes.poster.children!, 'card']}}};
  add('FRAME', {id: 'phone', parentId: 'page', name: 'Phone', x: 0, y: 450, width: 375.5, height: 812.25, fills: [solid(hex('#F2F6FF'))]});
  text('screen', 'phone', 'Phone screen', 60, 24, 600, 'Montserrat');
  return doc;
}

const fileIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);

/** The export's download, or null when the editor reports that this server cannot print PDFs. */
async function pdfOrUnavailable(page: Page, click: () => Promise<void>): Promise<Download | null> {
  const download = page.waitForEvent('download', {timeout: 60_000});
  const refused = page.getByText('Vector PDF is temporarily unavailable on the server', {exact: false}).waitFor({timeout: 60_000});
  await click();
  const first = await Promise.race([download.then(value => ({download: value})), refused.then(() => ({download: null}))]);
  download.catch(() => undefined);
  refused.catch(() => undefined);
  return first.download;
}

function checkPdf(pdf: Buffer) {
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // A page per frame, in reading order, 1 px = 1 pt exactly.
  const size = (box: number[]) => [Math.round((box[2] - box[0]) * 1000) / 1000, Math.round((box[3] - box[1]) * 1000) / 1000];
  expect(pageBoxes(pdf)?.map(size)).toEqual([[600, 400], [375.5, 812.25]]);
  const text = pdf.toString('latin1');
  expect(text).toMatch(/\/Type \/Font/);
  const extracted = spawnSync('pdftotext', ['-', '-'], {input: pdf});
  if (!extracted.error && extracted.status === 0) {
    const words = extracted.stdout.toString('utf8');
    for (const word of ['Весенняя распродажа', 'Spring sale', 'Phone screen']) expect(words).toContain(word);
  }
}

test('frames export as one vector PDF from "Export" and from the export dialog', async ({page, seed: _seed}) => {
  test.setTimeout(150_000);
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const id = fileIdFrom(page);
  const opened = await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json();
  const written = await page.request.put(`/api/design-files/${encodeURIComponent(id)}/document`, {
    headers: {Origin: new URL(page.url()).origin},
    data: {baseVersion: opened.file.version, document: posterAndPhone()},
  });
  expect(written.ok(), await written.text()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible({timeout: 30_000});

  // Both frames selected in "Layers"; "+" in "Export" gives each a setting, switched to PDF: vector, so no scale.
  await page.locator('[data-row-id="poster"]').click();
  await page.locator('[data-row-id="phone"]').click({modifiers: ['Shift']});
  const design = page.getByRole('tabpanel', {name: 'Design'});
  await design.getByRole('button', {name: 'Add export setting'}).click();
  // "Export" is the panel's last section: scrolled to first, so the scroll does not close the menu it opens.
  const format = design.getByRole('button', {name: 'Format'});
  await format.scrollIntoViewIfNeeded();
  await expect(format).toBeInViewport();
  await format.click();
  const pdfItem = page.getByRole('menuitemradio', {name: /^PDF/});
  await expect(pdfItem).toContainText('Vectors and text, 1 px = 1 pt');
  await pdfItem.click();
  await expect(design.getByRole('textbox', {name: 'Scale'})).toBeDisabled();

  const fromPanel = await pdfOrUnavailable(page, () => design.getByRole('button', {name: 'Export 2 layers'}).click());
  test.skip(!fromPanel, 'This server cannot start the sandboxed Chromium that prints PDFs; the editor said so.');
  // Several layers save under "Export".
  expect(fromPanel!.suggestedFilename()).toBe('Export.pdf');
  checkPdf(await readFile((await fromPanel!.path())!));

  // ⇧⌘E lists both frames with "PDF" and writes the same single file.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+Shift+e');
  const dialog = page.getByRole('dialog', {name: 'Export'});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('PDF', {exact: true})).toHaveCount(2);
  const fromDialog = await pdfOrUnavailable(page, () => dialog.getByRole('button', {name: 'Export 1 file'}).click());
  expect(fromDialog?.suggestedFilename()).toBe('Print.pdf');
  checkPdf(await readFile((await fromDialog!.path())!));
  await expect(dialog).toBeHidden();
});
