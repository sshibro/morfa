import {test, expect} from './fixtures';
import {Fingers, nodesOf, openNewPhoneFile, OWNER_PHONE, PHONE, pickTool, savedFile, shot, type Pt} from './phone';

// The design editor on a phone: the canvas is the screen, the panels are sheets, a thumb
// edits. 390 × 844 with touch; every check reads the saved document, the canvas or the layout.

test.use(PHONE);

const rectangleAt = async (page: Parameters<typeof savedFile>[0], fingers: Fingers, from: Pt, to: Pt) => {
  await pickTool(page, 'Rectangle');
  await fingers.drag([from], [to]);
};

test('should give the canvas the screen when a file opens on a phone', async ({page, seed: _seed}) => {
  const {canvas} = await openNewPhoneFile(page);
  await shot(page, 'editor-390');
  const box = (await canvas.boundingBox())!;
  expect(box.width * box.height).toBeGreaterThanOrEqual((390 * 844 * 2) / 3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const name of ['Layers', 'Properties', 'Back to files', 'Main menu']) await expect(page.getByRole('button', {name, exact: true})).toBeVisible();
});

test('should draw a rectangle with a finger, then move it once a tap has selected it', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await rectangleAt(page, fingers, {x: 120, y: 300}, {x: 220, y: 380});
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').map(node => [node.width, node.height])).toEqual([[100, 80]]);
  const drawn = nodesOf(await savedFile(page, id), 'RECTANGLE')[0];
  // A tap on empty canvas clears the selection; a drag from the rectangle then pans, it does not move it.
  await fingers.tap({x: 300, y: 600});
  await fingers.drag([{x: 170, y: 340}], [{x: 170, y: 440}]);
  await fingers.tap({x: 170, y: 440});
  await fingers.drag([{x: 170, y: 440}], [{x: 230, y: 480}]);
  await expect.poll(async () => {
    const node = nodesOf(await savedFile(page, id), 'RECTANGLE')[0];
    return [node.x - drawn.x, node.y - drawn.y];
  }).toEqual([60, 40]);
});

test('should leave nothing of a moved rectangle where it was', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await rectangleAt(page, fingers, {x: 120, y: 300}, {x: 220, y: 380});
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(1);
  const drawn = nodesOf(await savedFile(page, id), 'RECTANGLE')[0];
  await fingers.tap({x: 170, y: 340});
  // A finger's first move past the slop moves the rectangle by everything it travelled, in the frame that lifts it
  // out of the tiles: the tiles under where it stood must be repainted then, or its old edges stay (the owner's
  // iPhone showed strips of the rectangle left behind that no tap could reach).
  await fingers.drag([{x: 170, y: 340}], [{x: 270, y: 440}], 3);
  await expect.poll(async () => {
    const node = nodesOf(await savedFile(page, id), 'RECTANGLE')[0];
    return [node.x - drawn.x, node.y - drawn.y];
  }).toEqual([100, 100]);
  const grey = (point: Pt) => page.evaluate(([x, y]) => {
    const element = document.querySelector<HTMLCanvasElement>('.dz-canvas__scene')!;
    const box = element.getBoundingClientRect();
    const scale = element.width / box.width;
    const [r, g, b] = element.getContext('2d')!.getImageData(Math.round((x - box.left) * scale), Math.round((y - box.top) * scale), 1, 1).data;
    return Math.abs(r - 217) < 8 && Math.abs(g - 217) < 8 && Math.abs(b - 217) < 8;
  }, [point.x, point.y] as const);
  // The middle of where it is now is the rectangle's grey; its old left edge and top edge are canvas again.
  await expect.poll(() => grey({x: 270, y: 440})).toBe(true);
  for (const point of [{x: 124, y: 340}, {x: 170, y: 304}, {x: 150, y: 330}]) expect(await grey(point), `${point.x}, ${point.y}`).toBe(false);
});

test('should zoom about the fingers\' centre and change no layer when two fingers pinch', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await rectangleAt(page, fingers, {x: 150, y: 300}, {x: 250, y: 400});
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(1);
  const drawn = nodesOf(await savedFile(page, id), 'RECTANGLE')[0];
  // The rectangle's centre is (200, 350): pinch there to twice the distance, starting on the selected rectangle.
  await fingers.drag([{x: 180, y: 350}, {x: 220, y: 350}], [{x: 160, y: 350}, {x: 240, y: 350}]);
  await page.getByRole('button', {name: 'Properties', exact: true}).tap();
  const sheet = page.getByRole('dialog', {name: 'Properties'});
  await expect(sheet.locator('.dz-zoom')).toContainText('200');
  await sheet.getByRole('button', {name: 'Close'}).tap();
  expect(nodesOf(await savedFile(page, id), 'RECTANGLE')).toEqual([drawn]);
  // Twice the size about the centre: the rectangle now spans 100…300 × 250…450. A tap clears the selection, a tap near
  // its new corner (outside where it was drawn) selects it, and a drag moves it by half the finger's travel.
  await fingers.tap({x: 30, y: 700});
  await fingers.tap({x: 270, y: 420});
  await fingers.drag([{x: 270, y: 420}], [{x: 290, y: 440}]);
  await expect.poll(async () => {
    const node = nodesOf(await savedFile(page, id), 'RECTANGLE')[0];
    return [node.x - drawn.x, node.y - drawn.y];
  }).toEqual([10, 10]);
});

test('should fill a rectangle from the "Properties" sheet and rename it from the "Layers" sheet', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await rectangleAt(page, fingers, {x: 120, y: 200}, {x: 220, y: 280});
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(1);
  await page.getByRole('button', {name: 'Properties', exact: true}).tap();
  const properties = page.getByRole('dialog', {name: 'Properties'});
  const fill = properties.locator('.dz-section', {hasText: 'Fill'}).first().getByRole('textbox', {name: 'Color'});
  await expect(fill).toHaveValue('D9D9D9');
  // The canvas stays live above the half sheet: the rectangle is still there to see while its colour changes.
  const sheetTop = (await properties.boundingBox())!.y;
  expect(sheetTop).toBeGreaterThan(280);
  await fill.tap();
  await fill.fill('FF0000');
  await fill.press('Enter');
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE')[0].fills).toEqual([{type: 'SOLID', color: {r: 1, g: 0, b: 0}, opacity: 1, visible: true, blendMode: 'NORMAL'}]);
  await shot(page, 'editor-properties-sheet');
  await properties.getByRole('button', {name: 'Close'}).tap();

  await page.getByRole('button', {name: 'Layers', exact: true}).tap();
  const layers = page.getByRole('dialog', {name: 'Layers'});
  const row = layers.getByRole('tree', {name: 'Layers'}).locator('.dz-layer-name').first();
  const box = (await row.boundingBox())!;
  // A long press is the right click: the layer's menu, then "Rename".
  await fingers.down([{x: box.x + 10, y: box.y + box.height / 2}]);
  await page.waitForTimeout(700);
  await fingers.up();
  await page.getByRole('menuitem', {name: /Rename/}).tap();
  const rename = page.getByRole('textbox', {name: 'Layer name'});
  await rename.fill('Card');
  await rename.press('Enter');
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE')[0].name).toBe('Card');
  await shot(page, 'editor-layers-sheet');
});

test('should type a text with the text tool and undo it from the top bar', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await pickTool(page, 'Text');
  await fingers.tap({x: 120, y: 250});
  await page.keyboard.type('Hello');
  await page.keyboard.press('Escape');
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'TEXT').map(node => node.text?.characters)).toEqual(['Hello']);
  await page.getByRole('button', {name: 'Undo', exact: true}).tap();
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'TEXT').length).toBe(0);
});

test('should open a text for typing when it is double tapped', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await pickTool(page, 'Text');
  await fingers.tap({x: 120, y: 250});
  await page.keyboard.type('One');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'TEXT').length).toBe(1);
  await fingers.tap({x: 300, y: 600});
  await page.waitForTimeout(400);
  await fingers.tap({x: 128, y: 258});
  await page.waitForTimeout(100);
  await fingers.tap({x: 128, y: 258});
  await page.keyboard.press('End');
  await page.keyboard.type(' two');
  await page.keyboard.press('Escape');
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'TEXT').map(node => node.text?.characters)).toEqual(['One two']);
});

test('should add a frame from the toolbar and a page from the "Layers" sheet', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await pickTool(page, 'Frame');
  await fingers.drag([{x: 60, y: 160}], [{x: 260, y: 460}]);
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'FRAME').map(node => [node.width, node.height])).toEqual([[200, 300]]);
  await page.getByRole('button', {name: 'Layers', exact: true}).tap();
  await page.getByRole('dialog', {name: 'Layers'}).getByRole('button', {name: 'Add page'}).tap();
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'PAGE').length).toBe(2);
});

test.describe('on the owner\'s phone in the dark theme', () => {
  test.use({viewport: OWNER_PHONE, colorScheme: 'dark'});

  test('should show the canvas, the top bar and the tools when a new file opens', async ({page, seed: _seed}) => {
    const {canvas} = await openNewPhoneFile(page);
    await shot(page, 'editor-440-dark');
    const box = (await canvas.boundingBox())!;
    expect(box.width).toBe(OWNER_PHONE.width);
    for (const name of ['Layers', 'Properties']) {
      const button = (await page.getByRole('button', {name, exact: true}).boundingBox())!;
      expect(button.y + button.height).toBeLessThanOrEqual(OWNER_PHONE.height);
      expect([button.width, button.height]).toEqual([44, 44]);
    }
    const bar = (await page.getByRole('toolbar', {name: 'Tools'}).boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(OWNER_PHONE.width);
  });
});

test.describe('at a tablet width with a mouse', () => {
  test.use({viewport: {width: 768, height: 1024}, hasTouch: false, isMobile: false, deviceScaleFactor: 1});

  test('should keep the desktop panels when the screen is 768 px wide and the pointer is a mouse', async ({page, seed: _seed}) => {
    await openNewPhoneFile(page);
    await shot(page, 'editor-768');
    await expect(page.getByRole('complementary', {name: 'Properties'}).or(page.locator('.dz-right'))).toBeVisible();
    await expect(page.getByRole('button', {name: 'Layers', exact: true})).toHaveCount(0);
  });
});

test('should pin a comment with a tap and answer it in the card at the bottom', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await pickTool(page, 'Comment');
  await fingers.tap({x: 195, y: 300});
  const draft = page.getByRole('dialog', {name: 'New comment'});
  await expect(draft).toBeVisible();
  await draft.getByLabel('New comment', {exact: true}).last().pressSequentially('Bigger?');
  await page.keyboard.press('Enter');
  const card = page.getByRole('dialog', {name: 'Thread'});
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await card.getByLabel('Reply', {exact: true}).tap();
  await card.getByLabel('Reply', {exact: true}).pressSequentially('Yes, by 8 px');
  await page.keyboard.press('Enter');
  await expect(card.locator('.dz-comment')).toHaveCount(2);
  await shot(page, 'editor-comment');
  const threads = await (await page.request.get(`/api/design-files/${encodeURIComponent(id)}/comments`)).json() as {threads: {comments: {text: string}[]}[]};
  expect(threads.threads[0].comments.map(comment => comment.text)).toEqual(['Bigger?', 'Yes, by 8 px']);
});

test('should fit the meeting\'s reactions bar and vote dialog on the screen', async ({page, seed: _seed}) => {
  await openNewPhoneFile(page);
  await page.getByRole('button', {name: 'Reactions and meeting'}).tap();
  await page.getByRole('button', {name: 'Fire'}).tap();
  const reactions = page.getByRole('toolbar', {name: 'Reactions'});
  await expect(reactions).toBeVisible();
  await expect(page.getByRole('toolbar', {name: 'Tools'})).toBeHidden();
  const bar = (await reactions.boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.x + bar.width).toBeLessThanOrEqual(390);
  expect(bar.y + bar.height).toBeLessThanOrEqual(844);
  await shot(page, 'editor-meeting-reactions');
  await reactions.getByRole('button', {name: /Close reactions/}).tap();
  await expect(page.getByRole('toolbar', {name: 'Tools'})).toBeVisible();
  await page.getByRole('button', {name: 'Reactions and meeting'}).tap();
  await page.getByRole('button', {name: /Voting…/}).tap();
  const setup = page.getByRole('dialog', {name: 'Voting'});
  await expect(setup).toBeVisible();
  const box = (await setup.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(setup.getByRole('button', {name: 'Start voting'})).toBeInViewport();
});

// The frame times while two fingers pinch a full template at 4× CPU throttle on a 3× screen. A measurement, not a check: it runs only with MORFA_PH_PERF=1 and writes the numbers to the report.
test('should report frame times when two fingers pinch a full file at 4× throttle', async ({page, seed: _seed}, info) => {
  test.skip(!process.env.MORFA_PH_PERF, 'measurement only: MORFA_PH_PERF=1');
  test.setTimeout(120_000);
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file from a template', exact: true}).tap();
  await page.getByRole('button', {name: /^Mobile app/}).tap();
  await expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible({timeout: 20_000});
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
  const fingers = await Fingers.on(page);
  const measure = async (label: string, gesture: () => Promise<void>) => {
    await page.evaluate(() => {
      const w = window as unknown as {__frames: number[]; __stop: boolean};
      w.__frames = [];
      w.__stop = false;
      let last = performance.now();
      const tick = (now: number) => {
        w.__frames.push(now - last);
        last = now;
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await gesture();
    const frames = await page.evaluate(() => {
      const w = window as unknown as {__frames: number[]; __stop: boolean};
      w.__stop = true;
      return w.__frames.slice(1).sort((a, b) => a - b);
    });
    const at = (q: number) => Math.round(frames[Math.min(frames.length - 1, Math.floor(frames.length * q))] * 10) / 10;
    const backing = await page.evaluate(() => [...document.querySelectorAll('[role="application"] canvas')].map(c => `${(c as HTMLCanvasElement).width}×${(c as HTMLCanvasElement).height}`).join(', '));
    const line = `${label}: ${frames.length} frames, median ${at(0.5)} ms, p95 ${at(0.95)} ms; canvases ${backing}`;
    info.annotations.push({type: 'perf', description: line});
    console.log('[perf] ' + line);
  };
  await measure('pinch in and out', async () => {
    for (let round = 0; round < 3; round++) {
      await fingers.drag([{x: 170, y: 420}, {x: 220, y: 420}], [{x: 70, y: 420}, {x: 320, y: 420}], 20);
      await fingers.drag([{x: 70, y: 420}, {x: 320, y: 420}], [{x: 170, y: 420}, {x: 220, y: 420}], 20);
    }
  });
  await measure('one-finger pan', async () => {
    for (let round = 0; round < 3; round++) await fingers.drag([{x: 300, y: 600}], [{x: 80, y: 250}], 25);
  });
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
});

test('should offer a comment first when the empty canvas is long-pressed', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await fingers.down([{x: 195, y: 400}]);
  await page.waitForTimeout(700);
  await fingers.up();
  const first = page.getByRole('menuitem').first();
  await expect(first).toHaveText(/Comment here/);
  await first.tap();
  const draft = page.getByRole('dialog', {name: 'New comment'});
  await expect(draft).toBeVisible();
  await draft.getByLabel('New comment', {exact: true}).last().pressSequentially('Here');
  await page.keyboard.press('Enter');
  await expect.poll(async () => {
    const response = await page.request.get(`/api/design-files/${encodeURIComponent(id)}/comments`);
    return ((await response.json()) as {threads: unknown[]}).threads.length;
  }).toBe(1);
});

test('should open the "Layers" sheet for a rename chosen from the canvas menu', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await rectangleAt(page, fingers, {x: 120, y: 300}, {x: 240, y: 400});
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(1);
  await fingers.down([{x: 180, y: 350}]);
  await page.waitForTimeout(700);
  await fingers.up();
  await page.getByRole('menuitem', {name: /Rename/}).tap();
  await expect(page.getByRole('dialog', {name: 'Layers'})).toBeVisible();
  const rename = page.getByRole('textbox', {name: 'Layer name'});
  await expect(rename).toBeFocused();
  await rename.fill('Button');
  await rename.press('Enter');
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE')[0].name).toBe('Button');
});

test('should show a frame whole when it is tapped in the frame strip', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  let count = 0;
  for (const [from, to] of [[{x: 40, y: 150}, {x: 140, y: 300}], [{x: 220, y: 450}, {x: 350, y: 650}]] as const) {
    await pickTool(page, 'Frame');
    await fingers.drag([from], [to]);
    count += 1;
    await expect.poll(async () => nodesOf(await savedFile(page, id), 'FRAME').length).toBe(count);
  }
  const [, second] = nodesOf(await savedFile(page, id), 'FRAME').sort((a, b) => a.y - b.y);
  // Look away first: the second frame leaves the screen.
  await fingers.drag([{x: 300, y: 700}], [{x: 300, y: 150}]);
  await page.getByRole('button', {name: 'Frames', exact: true}).tap();
  await expect(page.getByRole('button', {name: 'Frames', exact: true})).toHaveAttribute('aria-pressed', 'true');
  const strip = page.getByRole('navigation', {name: 'Frames on this page'});
  await strip.getByRole('button', {name: second.name, exact: true}).tap();
  await expect(strip.getByRole('button', {name: second.name, exact: true})).toHaveAttribute('aria-current', 'true');
  const view = await page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {getState(): {viewports: Record<string, {x: number; y: number; zoom: number}>; pageId: string}}}}).__morfaDesignTest.store.getState());
  const viewport = view.viewports[view.pageId];
  const top = (second.y - viewport.y) * viewport.zoom, bottom = (second.y + second.height - viewport.y) * viewport.zoom;
  const stripTop = (await strip.boundingBox())!.y;
  expect(top).toBeGreaterThanOrEqual(60);
  expect(bottom).toBeLessThanOrEqual(stripTop);
  await shot(page, 'editor-frame-strip');
});

test('should leave the canvas menu open and the file unchanged when the held finger lifts over the menu', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  // Low on the screen, where the menu's sheet rises from: the finger is over the menu when it lifts.
  await rectangleAt(page, fingers, {x: 120, y: 600}, {x: 260, y: 740});
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(1);
  const before = JSON.stringify((await savedFile(page, id)).document.nodes);
  await fingers.down([{x: 190, y: 700}]);
  await page.waitForTimeout(700);
  await fingers.up();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.getByRole('menuitem').first()).toBeVisible();
  expect(JSON.stringify((await savedFile(page, id)).document.nodes)).toBe(before);
});

test('should open a layer\'s menu without pressing a row when a layer near the bottom is held', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  for (let i = 0; i < 6; i++) {
    await rectangleAt(page, fingers, {x: 40 + i * 50, y: 200}, {x: 80 + i * 50, y: 240});
    await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(i + 1);
  }
  const before = JSON.stringify((await savedFile(page, id)).document.nodes);
  await page.getByRole('button', {name: 'Layers', exact: true}).tap();
  const sheet = page.getByRole('dialog', {name: 'Layers'});
  const last = sheet.getByRole('tree', {name: 'Layers'}).locator('.dz-layer-name').last();
  await last.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = (await last.boundingBox())!;
  expect(box.y).toBeGreaterThan(844 / 2);
  await fingers.down([{x: box.x + 10, y: box.y + box.height / 2}]);
  await page.waitForTimeout(700);
  await fingers.up();
  const rename = page.getByRole('menuitem', {name: /Rename/});
  await expect(rename).toBeVisible();
  await page.waitForTimeout(600);
  await expect(rename).toBeVisible();
  expect(JSON.stringify((await savedFile(page, id)).document.nodes)).toBe(before);
  await shot(page, 'editor-layer-menu');
});

test('should redo from a long press on "Undo"', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await rectangleAt(page, fingers, {x: 120, y: 300}, {x: 220, y: 380});
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(1);
  const undo = page.getByRole('button', {name: 'Undo', exact: true});
  await undo.tap();
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(0);
  const box = (await undo.boundingBox())!;
  await fingers.down([{x: box.x + box.width / 2, y: box.y + box.height / 2}]);
  await page.waitForTimeout(700);
  await fingers.up();
  await page.getByRole('menuitem', {name: /Redo/}).tap();
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(1);
});

test('should add to the selection by tap and marquee while "Select" is on, and turn it off when the selection clears', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  for (const [x, y] of [[60, 200], [220, 200], [60, 420]] as const) {
    await rectangleAt(page, fingers, {x, y}, {x: x + 80, y: y + 80});
  }
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(3);
  const selection = () => page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {getState(): {selection: string[]}}}}).__morfaDesignTest.store.getState().selection.length);
  await fingers.tap({x: 100, y: 240});
  await expect.poll(selection).toBe(1);
  const toggle = page.getByRole('button', {name: 'Select', exact: true});
  await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await fingers.tap({x: 260, y: 240});
  await expect.poll(selection).toBe(2);
  // A marquee from inside the first rectangle down over the third: it adds, it does not move anything.
  const before = JSON.stringify((await savedFile(page, id)).document.nodes);
  await fingers.drag([{x: 70, y: 210}], [{x: 120, y: 460}]);
  await expect.poll(selection).toBe(3);
  expect(JSON.stringify((await savedFile(page, id)).document.nodes)).toBe(before);
  // Two fingers still zoom, and change nothing in the selection.
  await fingers.drag([{x: 180, y: 600}, {x: 220, y: 600}], [{x: 160, y: 600}, {x: 240, y: 600}]);
  await expect.poll(selection).toBe(3);
  await fingers.tap({x: 330, y: 700});
  await expect.poll(selection).toBe(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('should open the cursor chat from the meeting menu by touch, with its field inside the screen', async ({page, seed: _seed}) => {
  await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  // The last place a finger touched the canvas stands for the cursor.
  await fingers.tap({x: 200, y: 400});
  await page.getByRole('button', {name: 'Reactions and meeting'}).tap();
  await page.getByText('Cursor chat').tap();
  const field = page.locator('.dz-meet-chat-self input, .dz-meet-chat-self textarea, .dz-meet-chat-self [contenteditable]').first();
  await expect(field).toBeVisible();
  await page.keyboard.type('Hello');
  const box = (await field.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y).toBeGreaterThan(64);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await shot(page, 'editor-meeting-chat');
});

test('should add layers to the selection from the "Layers" sheet while "Select" is on', async ({page, seed: _seed}) => {
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  for (const x of [40, 160, 280]) await rectangleAt(page, fingers, {x, y: 200}, {x: x + 60, y: 260});
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'RECTANGLE').length).toBe(3);
  const selection = () => page.evaluate(() => (window as unknown as {__morfaDesignTest: {store: {getState(): {selection: string[]}}}}).__morfaDesignTest.store.getState().selection.length);
  await fingers.tap({x: 70, y: 230});
  await expect.poll(selection).toBe(1);
  await page.getByRole('button', {name: 'Select', exact: true}).tap();
  await page.getByRole('button', {name: 'Layers', exact: true}).tap();
  const rows = page.getByRole('dialog', {name: 'Layers'}).getByRole('tree', {name: 'Layers'}).locator('.dz-layer-name');
  await expect(rows).toHaveCount(3);
  await rows.nth(0).tap();
  await expect.poll(selection).toBe(2);
  await rows.nth(1).tap();
  await expect.poll(selection).toBe(3);
  await rows.nth(1).tap();
  await expect.poll(selection).toBe(2);
});

test('should reach the pages\' divider, the list\'s height and a caret\'s "Expand all nested" by long press', async ({page, seed: _seed}) => {
  test.setTimeout(90_000);
  const {id} = await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  const hold = async (box: {x: number; y: number; width: number; height: number}) => {
    await fingers.down([{x: box.x + box.width / 2, y: box.y + box.height / 2}]);
    await page.waitForTimeout(700);
    await fingers.up();
  };
  // A frame in a frame in a frame: three levels for the caret.
  await pickTool(page, 'Frame');
  await fingers.drag([{x: 40, y: 140}], [{x: 350, y: 560}]);
  await pickTool(page, 'Frame');
  await fingers.drag([{x: 80, y: 200}], [{x: 300, y: 500}]);
  await pickTool(page, 'Frame');
  await fingers.drag([{x: 120, y: 260}], [{x: 260, y: 440}]);
  await expect.poll(async () => nodesOf(await savedFile(page, id), 'FRAME').length).toBe(3);
  await page.getByRole('button', {name: 'Layers', exact: true}).tap();
  const sheet = page.getByRole('dialog', {name: 'Layers'});
  const tree = sheet.getByRole('tree', {name: 'Layers'});
  const rows = tree.getByRole('treeitem');
  // Fold the outer frame by a tap on its caret, then open everything inside it from the caret's long press.
  const outer = rows.first();
  if ((await outer.getAttribute('aria-expanded')) === 'true') await outer.locator('[data-caret]').tap();
  await expect(rows).toHaveCount(1);
  await hold((await outer.locator('[data-caret]').boundingBox())!);
  await page.getByRole('menuitem', {name: 'Expand all nested'}).tap();
  await expect(rows).toHaveCount(3);
  await expect(tree.locator('[aria-expanded="false"]')).toHaveCount(0);
  await hold((await outer.locator('[data-caret]').boundingBox())!);
  await page.getByRole('menuitem', {name: 'Collapse all nested'}).tap();
  await expect(rows).toHaveCount(1);

  // A page divider (FD): an empty page named "-…" is a line; it is not opened by a tap, and its menu opens by long press.
  await sheet.getByRole('button', {name: 'Add page'}).tap();
  await page.keyboard.type('---');
  await page.keyboard.press('Enter');
  const divider = sheet.getByRole('option', {name: 'Divider "---"'});
  await expect(divider).toBeVisible();
  const current = sheet.getByRole('option', {selected: true});
  await sheet.getByRole('option').first().tap();
  const line0 = (await divider.boundingBox())!;
  await fingers.tap({x: line0.x + line0.width / 2, y: line0.y + line0.height / 2});
  await expect(sheet.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await hold((await divider.boundingBox())!);
  await expect(page.getByRole('menuitem', {name: 'Delete page'})).toBeVisible();
  // A tap on the dimmed page closes the menu, as a finger does.
  await fingers.tap({x: 195, y: 60});
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(current).toHaveCount(1);

  // The list's height: a finger drags the line under the pages (the sheet opened full, so there is room); a long press on
  // it puts the height back.
  const grip = (await sheet.locator('.dz-phone-sheet-handle').boundingBox())!;
  await fingers.drag([{x: grip.x + grip.width / 2, y: grip.y + grip.height / 2}], [{x: grip.x + grip.width / 2, y: 40}], 10);
  await page.waitForTimeout(400);
  const pages = sheet.locator('.dz-left-pages .dz-pages, .dz-pages').first();
  const natural = (await pages.boundingBox())!.height;
  const line = (await sheet.getByRole('separator', {name: 'Page list height'}).boundingBox())!;
  const at = {x: line.x + line.width / 2, y: line.y + line.height / 2};
  await fingers.drag([at], [{x: at.x, y: at.y + 80}], 8);
  await expect.poll(async () => (await pages.boundingBox())!.height).toBeGreaterThan(natural + 40);
  await hold((await sheet.getByRole('separator', {name: 'Page list height'}).boundingBox())!);
  await page.getByRole('menuitem', {name: 'Default height'}).tap();
  await expect.poll(async () => Math.round((await pages.boundingBox())!.height)).toBe(Math.round(natural));
});

test('should hide and show the comment pins from "⋯ › View" by touch', async ({page, seed: _seed}) => {
  await openNewPhoneFile(page);
  const fingers = await Fingers.on(page);
  await pickTool(page, 'Comment');
  await fingers.tap({x: 195, y: 300});
  const draft = page.getByRole('dialog', {name: 'New comment'});
  await draft.getByLabel('New comment', {exact: true}).last().pressSequentially('Pin');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', {name: 'Thread'})).toBeVisible();
  await page.keyboard.press('Escape');
  await pickTool(page, 'Move');
  const pins = page.locator('.dz-comment-pin:not(.is-draft)');
  await expect(pins).toHaveCount(1);
  const toggle = async () => {
    await page.getByRole('button', {name: 'Main menu'}).tap();
    await page.getByRole('menuitem', {name: 'View', exact: true}).tap();
    await page.getByRole('menuitemcheckbox', {name: /Comments on the canvas/}).or(page.getByRole('menuitem', {name: /Comments on the canvas/})).tap();
  };
  await toggle();
  await expect(pins).toHaveCount(0);
  await toggle();
  await expect(pins).toHaveCount(1);
});
