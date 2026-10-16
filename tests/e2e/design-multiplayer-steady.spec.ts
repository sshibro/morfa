import {test, expect} from './fixtures';
import type {Browser, BrowserContext, Page} from '@playwright/test';

// Two people in one file stay in it while they work: no avatar blinking away and back, no stream reconnecting. Run with the API
// as production runs it (E2E_API_PROCESSES=2: two processes behind a least-connections balancer, scripts/e2e-server.ts) a
// presence post that reached the process without the poster's stream was answered 404, the editor took that for a dead stream
// and reconnected, and the other person saw the avatar, cursor and selection blink several times a second (2026-10-12).

type TestHost = {__morfaDesignTest?: {store: {getState(): {doc: {nodes: Record<string, {type: string}>}}; setSelection(ids: string[]): void}}};

async function account(browser: Browser, page: Page, baseURL: string, name: string): Promise<{context: BrowserContext; page: Page}> {
  const response = await page.request.post('/__e2e/fixtures', {headers: {'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!}, data: {}});
  expect(response.ok(), 'An isolated account').toBeTruthy();
  const seed = (await response.json()) as {token: string};
  const context = await browser.newContext({baseURL, locale: 'en-US', timezoneId: 'Europe/Moscow', viewport: {width: 1440, height: 900}});
  await context.addCookies([{name: 'forma_session', value: seed.token, url: baseURL, httpOnly: true, sameSite: 'Lax'}]);
  const opened = await context.newPage();
  expect((await opened.request.put('/api/settings', {data: {name, workspace: 'Studio'}})).ok()).toBeTruthy();
  return {context, page: opened};
}

/** Every event stream the page opens, and every presence post's answer. */
function watchNetwork(page: Page) {
  const seen = {streams: 0, presence: [] as number[]};
  page.on('request', request => {
    if (/\/api\/design-files\/[^/]+\/events\b/.test(request.url())) seen.streams++;
  });
  page.on('response', response => {
    if (/\/api\/design-files\/[^/]+\/presence$/.test(response.url())) seen.presence.push(response.status());
  });
  return seen;
}

/** Counts, frame by frame in the page, the frames whose header lacks the avatar with these initials. */
async function watchAvatar(page: Page, initials: string) {
  await page.evaluate(initials => {
    const host = window as unknown as {__avatarMissing: number; __avatarFrames: number};
    host.__avatarMissing = 0;
    host.__avatarFrames = 0;
    const tick = () => {
      const group = document.querySelector('[role="group"][aria-label="People in this file"]');
      const here = !!group && [...group.querySelectorAll('.dz-live-avatar')].some(avatar => avatar.textContent?.trim() === initials);
      host.__avatarFrames++;
      if (!here) host.__avatarMissing++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, initials);
  return () => page.evaluate(() => {
    const host = window as unknown as {__avatarMissing: number; __avatarFrames: number};
    return {missing: host.__avatarMissing, frames: host.__avatarFrames};
  });
}

async function openFile(page: Page, id: string) {
  await page.goto('/#design/' + encodeURIComponent(id));
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as TestHost).__morfaDesignTest)).toBe(true);
}

test('two people moving and selecting for a while: each stays in the other\'s header, on one stream each', async ({page, seed: _seed, browser, baseURL}) => {
  test.setTimeout(90_000);
  expect((await page.request.put('/api/settings', {data: {name: 'Anna Smith', workspace: 'Studio'}})).ok()).toBeTruthy();
  const teamId = ((await (await page.request.post('/api/design-teams', {data: {name: 'North Studio'}})).json()) as {team: {id: string}}).team.id;
  const token = ((await (await page.request.post(`/api/design-teams/${teamId}/invites`, {data: {role: 'editor', days: 7, maxUses: 1}})).json()) as {token: string}).token;
  const boris = await account(browser, page, baseURL!, 'Boris Petrov');
  expect((await boris.page.request.post(`/api/design-teams/invites/${token}/accept`)).ok()).toBeTruthy();
  const created = await page.request.post('/api/design-files', {data: {name: 'Together', teamId}});
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as {file: {id: string}}).file.id;

  const anna = watchNetwork(page), borisNet = watchNetwork(boris.page);
  await openFile(page, id);
  await openFile(boris.page, id);
  await expect(page.getByRole('group', {name: 'People in this file'}).getByRole('button', {name: /Follow: Boris Petrov/})).toBeVisible();
  await expect(boris.page.getByRole('group', {name: 'People in this file'}).getByRole('button', {name: /Follow: Anna Smith/})).toBeVisible();
  const borisSeenByAnna = await watchAvatar(page, 'BP');
  const annaSeenByBoris = await watchAvatar(boris.page, 'AS');

  // Anna draws and selects, both move their pointers over the canvas: a few dozen presence posts each.
  const canvas = page.getByRole('application', {name: 'Canvas'});
  const box = (await canvas.boundingBox())!;
  await canvas.click({position: {x: 40, y: 40}});
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 500, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 640, box.y + 400, {steps: 6});
  await page.mouse.up();
  await expect.poll(() => boris.page.evaluate(() => Object.values((window as unknown as TestHost).__morfaDesignTest!.store.getState().doc.nodes).filter(node => node.type === 'RECTANGLE').length)).toBe(1);
  const canvasB = boris.page.getByRole('application', {name: 'Canvas'});
  const boxB = (await canvasB.boundingBox())!;
  for (let step = 0; step < 40; step++) {
    await page.mouse.move(box.x + 200 + step * 12, box.y + 200 + (step % 7) * 15);
    await boris.page.mouse.move(boxB.x + 700 - step * 10, boxB.y + 250 + (step % 5) * 20);
    await page.waitForTimeout(60);
  }
  await expect(page.locator('.dz-live-cursor.is-shown')).toContainText('Boris Petrov');
  await expect(boris.page.locator('.dz-live-cursor.is-shown')).toContainText('Anna Smith');

  const a = await borisSeenByAnna(), b = await annaSeenByBoris();
  expect(a.frames, 'Anna\'s page painted while they worked').toBeGreaterThan(30);
  expect(b.frames, 'Boris\'s page painted while they worked').toBeGreaterThan(30);
  expect(a.missing, 'frames where Anna\'s header lost Boris').toBe(0);
  expect(b.missing, 'frames where Boris\'s header lost Anna').toBe(0);
  expect(anna.presence.length, 'Anna\'s pointer was posted').toBeGreaterThan(5);
  expect(borisNet.presence.length, 'Boris\'s pointer was posted').toBeGreaterThan(5);
  expect([...anna.presence, ...borisNet.presence].filter(status => status !== 204), 'presence posts not taken').toEqual([]);
  expect(anna.streams, 'Anna\'s event streams').toBe(1);
  expect(borisNet.streams, 'Boris\'s event streams').toBe(1);
  await boris.context.close();
});

test('undo and redo with two people editing: each takes back and brings back only their own, and the other sees it', async ({page, seed: _seed, browser, baseURL}) => {
  test.setTimeout(90_000);
  expect((await page.request.put('/api/settings', {data: {name: 'Anna Smith', workspace: 'Studio'}})).ok()).toBeTruthy();
  const teamId = ((await (await page.request.post('/api/design-teams', {data: {name: 'South Studio'}})).json()) as {team: {id: string}}).team.id;
  const token = ((await (await page.request.post(`/api/design-teams/${teamId}/invites`, {data: {role: 'editor', days: 7, maxUses: 1}})).json()) as {token: string}).token;
  const boris = await account(browser, page, baseURL!, 'Boris Petrov');
  expect((await boris.page.request.post(`/api/design-teams/invites/${token}/accept`)).ok()).toBeTruthy();
  const created = await page.request.post('/api/design-files', {data: {name: 'Undo together', teamId}});
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await openFile(page, id);
  await openFile(boris.page, id);
  await expect(page.getByRole('group', {name: 'People in this file'}).getByRole('button', {name: /Follow: Boris Petrov/})).toBeVisible();

  const rectangles = (p: Page) => p.evaluate(() => Object.values((window as unknown as TestHost).__morfaDesignTest!.store.getState().doc.nodes).filter(node => node.type === 'RECTANGLE').length);
  const draw = async (p: Page, dx: number) => {
    const canvas = p.getByRole('application', {name: 'Canvas'});
    const box = (await canvas.boundingBox())!;
    await canvas.click({position: {x: 40, y: 40}});
    await p.keyboard.press('r');
    await p.mouse.move(box.x + 400 + dx, box.y + 300);
    await p.mouse.down();
    await p.mouse.move(box.x + 480 + dx, box.y + 360, {steps: 4});
    await p.mouse.up();
  };
  await draw(page, 0);
  await expect.poll(() => rectangles(boris.page)).toBe(1);
  await draw(boris.page, 200);
  await expect.poll(() => rectangles(page)).toBe(2);

  // Anna's ⌘Z takes back her rectangle only, on both screens; ⇧⌘Z brings it back on both.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => rectangles(page)).toBe(1);
  await expect.poll(() => rectangles(boris.page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => rectangles(page)).toBe(2);
  await expect.poll(() => rectangles(boris.page)).toBe(2);
  // Boris's own undo and redo, the same.
  await boris.page.keyboard.press('Escape');
  await boris.page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => rectangles(page)).toBe(1);
  await boris.page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => rectangles(page)).toBe(2);
  // And what the server keeps.
  await expect.poll(async () => {
    const saved = (await (await page.request.get('/api/design-files/' + encodeURIComponent(id))).json()) as {document: {nodes: Record<string, {type: string}>}};
    return Object.values(saved.document.nodes).filter(node => node.type === 'RECTANGLE').length;
  }).toBe(2);
  await boris.context.close();
});
