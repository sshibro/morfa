import {test, expect, waitEditorReady} from './fixtures';

// A modal <dialog> makes the rest of the page inert and dims it: a toast raised while one is open (here the export dialog's error when
// its code cannot load) renders inside the dialog (src/design/ui/Toast.tsx, layer.tsx `useTopModalLayer`), readable and clickable.

test('a toast shown while a modal dialog is open sits inside it and can be clicked', async ({page, seed: _seed}) => {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await page.waitForURL(/#design\//);
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  // The editor takes keys, and co-editing and the meeting have mounted (fixtures.ts `waitEditorReady`).
  await waitEditorReady(page);
  await page.keyboard.press('r');
  const canvas = page.getByRole('application', {name: 'Canvas'});
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 320, box.y + 300, {steps: 4});
  await page.mouse.up();
  await page.getByRole('button', {name: 'Add export setting'}).click();
  await page.route(/export\/(run|files)\.ts/, route => route.abort());
  await page.getByRole('button', {name: 'Export', exact: true}).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  const go = dialog.getByRole('button', {name: /^Export/}).last();
  await go.click();
  const toast = page.locator('.dz-toast').first();
  await expect(toast).toBeVisible({timeout: 15000});
  await expect(page.locator('dialog[open] .dz-toast')).toHaveCount(1);
  await expect(toast).toContainText('Could not load export');
  const close = toast.getByRole('button', {name: 'Dismiss notification'});
  const hit = await close.evaluate(el => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return top === el || el.contains(top); });
  expect(hit, 'the close button is what a click there reaches').toBe(true);
  await close.click({timeout: 3000});
  await expect(page.locator('.dz-toast')).toHaveCount(0);
  await expect(dialog).toBeVisible();
});
