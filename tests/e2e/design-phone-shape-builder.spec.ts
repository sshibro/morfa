import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';
import {Fingers, openNewPhoneFile, pickTool, savedFile} from './phone';

// "Shape builder" by touch (lane PH): a finger has no ⌥ and no Escape, so on a phone and on a tablet the builder has a
// bar — "Merge" or "Subtract" for what a tap does, "Done" to put it down. Each check reads the saved document.

const shapesOf = async (page: Page, id: string) => Object.values((await savedFile(page, id)).document.nodes).filter(node => node.type !== 'PAGE');

async function overlappingSquares(page: Page, id: string) {
  const fingers = await Fingers.on(page);
  await pickTool(page, 'Rectangle');
  await fingers.drag([{x: 80, y: 250}], [{x: 220, y: 390}]);
  await pickTool(page, 'Rectangle');
  await fingers.drag([{x: 160, y: 320}], [{x: 300, y: 460}]);
  await expect.poll(async () => (await shapesOf(page, id)).length).toBe(2);
  await page.getByRole('button', {name: 'Main menu', exact: true}).first().tap();
  await page.getByRole('menuitem', {name: /^Edit$/}).first().tap();
  await page.getByRole('menuitem', {name: /Select all/}).first().tap();
  await page.getByRole('button', {name: 'Main menu', exact: true}).first().tap();
  await page.getByRole('menuitem', {name: /^Object$/}).first().tap();
  await page.getByRole('menuitem', {name: /^Boolean operations/}).first().tap();
  await page.getByRole('menuitem', {name: /Shape builder/}).first().tap();
  return fingers;
}

for (const size of [{width: 390, height: 844}, {width: 820, height: 1180}]) {
  test.describe(`at ${size.width}`, () => {
    test.use({viewport: size, hasTouch: true, isMobile: true, deviceScaleFactor: 2});

    test('should take a region away by tap when "Subtract" is chosen on the builder\'s bar, and put the builder down with "Done"', async ({page, seed: _seed}) => {
      const {id} = await openNewPhoneFile(page);
      const fingers = await overlappingSquares(page, id);
      const bar = page.getByRole('toolbar', {name: 'Shape builder'});
      await expect(bar).toBeVisible();
      const box = (await bar.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      const before = JSON.stringify((await savedFile(page, id)).document.nodes);
      await bar.getByRole('radio', {name: 'Subtract'}).tap();
      // The overlap of the two squares.
      await fingers.tap({x: 190, y: 355});
      await expect.poll(async () => JSON.stringify((await savedFile(page, id)).document.nodes)).not.toBe(before);
      const shapes = await shapesOf(page, id);
      // Taken away, the overlap leaves two cut shapes; merged ("Merge"), it would become a third layer of its own.
      expect(shapes.map(node => node.type)).toEqual(['VECTOR', 'VECTOR']);
      await bar.getByRole('button', {name: 'Done'}).tap();
      await expect(bar).toHaveCount(0);
    });
  });
}
