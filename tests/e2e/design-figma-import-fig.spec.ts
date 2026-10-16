import {test, expect} from './fixtures';
import type {DesignDocument, ImagePaint} from '../../shared/design/types';
import {figZip, sampleFig, SAMPLE_HASH, TINY_PNG} from '../helpers/fig-kit';

// "Import from Figma" from a .fig file (Figma → File → Save local copy): no link and no token, the file is read in the
// browser (a worker), the pages are chosen and the design is saved as a new file with its picture uploaded.

test('a .fig saved from Figma imports without a token: layers, an instance with its own text and a picture', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'Import', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Import from Figma…'}).click();
  const dialog = page.getByRole('dialog', {name: 'Import from Figma'});
  await expect(dialog.getByRole('radio', {name: '.fig file'})).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('button', {name: 'Continue'})).toBeDisabled();

  // Not a .fig: said so, nothing read.
  await dialog.locator('input[type=file]').setInputFiles({name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello')});
  await expect(dialog.getByRole('alert')).toContainText('.fig');

  await dialog.locator('input[type=file]').setInputFiles({name: 'Mockup.fig', mimeType: 'application/octet-stream', buffer: Buffer.from(figZip(sampleFig(), {[SAMPLE_HASH]: TINY_PNG}))});
  await expect(dialog.getByText('Mockup.fig')).toBeVisible();
  await dialog.getByRole('button', {name: 'Continue'}).click();
  await dialog.getByRole('button', {name: 'Import file'}).click();
  await dialog.getByRole('button', {name: 'Open file'}).click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);

  const id = decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length));
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  const {file, document} = (await response.json()) as {file: {name: string}; document: DesignDocument};
  expect(file.name).toBe('Mockup');
  const nodes = Object.values(document.nodes);
  const save = document.nodes['2:9'];
  expect(save?.type).toBe('INSTANCE');
  expect(nodes.find(node => node.parentId === '2:9' && node.type === 'TEXT')?.text?.characters).toBe('Save');
  const photo = document.nodes['1:2'];
  const paint = photo.fills[0] as ImagePaint;
  expect(paint.type).toBe('IMAGE');
  expect(Object.keys(document.images)).toContain(paint.imageRef);
});
