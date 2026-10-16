import {test, expect} from './fixtures';
import type {Browser, BrowserContext, Page} from '@playwright/test';
import {createDocument, createNode} from '../../shared/design/defaults';
import {createBoardDocument} from '../../shared/design/board/document';
import {createShape, createSticky, insertPieces} from '../../shared/design/board/create';
import {beginTransaction} from '../../shared/design/transaction';
import type {TextMeasurer} from '../../shared/design/text-layout';

// "Meeting" in the real app with several people on one team file (docs/board-meeting.md): the shared timer with music (everyone counts
// down to the same moment; the music is made in the browser, starts only after a gesture and is muted per person; viewers cannot run
// it), a voting session (dots per person, hidden until the end, results for everyone, a viewer votes too), cursor chat "/", emote
// bursts, a high five, and "Get attention" (the others follow, step away and come back). Keyboard-opened chat does not animate;
// with reduced motion a burst only fades. On a board ("Board") the same features sit in the board's top-right pill and vote for
// stickies through the board's meeting slot. Needs ENABLE_DESIGN_TOOL=1 on the test server (scripts/e2e-server.ts).

type Viewport = {x: number; y: number; zoom: number};
type Frame = {x: number; y: number; width: number; height: number};
type TestHost = {
  __morfaDesignTest?: {
    store: {getState(): {pageId: string; tool: string; selection: string[]; viewports: Record<string, Viewport>; doc: {nodes: Record<string, Frame>}}; setViewport(viewport: Viewport): void};
    meeting?: {sound: {muted(): boolean}; chat: {state(): {open: boolean; text: string; sent: boolean}}};
  };
};
type Person = {page: Page; context: BrowserContext};

const PAGE = '0:1';
const FRAMES = [
  {id: '1:1', name: 'Variant A', x: 0},
  {id: '1:2', name: 'Variant B', x: 420},
  {id: '1:3', name: 'Variant C', x: 840},
];
function startingDocument() {
  const doc = createDocument(PAGE, 'Home');
  for (const frame of FRAMES) doc.nodes[frame.id] = createNode('FRAME', {id: frame.id, name: frame.name, parentId: PAGE, x: frame.x, y: 0, width: 360, height: 480});
  doc.nodes[PAGE] = {...doc.nodes[PAGE], children: FRAMES.map(frame => frame.id)};
  return doc;
}

async function person(browser: Browser, page: Page, baseURL: string, name: string, options: {reducedMotion?: boolean; countAudio?: boolean; dark?: boolean} = {}): Promise<Person> {
  const response = await page.request.post('/__e2e/fixtures', {headers: {'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!}, data: {}});
  expect(response.ok(), 'An isolated account').toBeTruthy();
  const seed = (await response.json()) as {token: string};
  const context = await browser.newContext({baseURL, locale: 'en-US', timezoneId: 'Europe/Moscow', viewport: {width: 1440, height: 900}, reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference', colorScheme: options.dark ? 'dark' : 'light'});
  await context.addCookies([{name: 'forma_session', value: seed.token, url: baseURL, httpOnly: true, sameSite: 'Lax'}]);
  if (options.countAudio) {
    // Each audio context the page makes calls out here. Read on the network, never by touching the page: Playwright runs its own
    // evaluations (locators too) as user gestures, and sound waits exactly for the first gesture.
    await context.route('**/__meeting-audio-probe', route => route.fulfill({status: 204}));
    await context.addInitScript(() => {
      const Native = window.AudioContext;
      window.AudioContext = class extends Native {
        constructor(...args: ConstructorParameters<typeof AudioContext>) {
          super(...args);
          void fetch('/__meeting-audio-probe', {method: 'POST'}).catch(() => undefined);
        }
      };
    });
  }
  const opened = await context.newPage();
  expect((await opened.request.put('/api/settings', {data: {name, workspace: 'Studio'}})).ok()).toBeTruthy();
  return {context, page: opened};
}

/** A team file with three frames, its owner (the test's own page), an editor and a viewer. */
async function room(page: Page, browser: Browser, baseURL: string, options: {veraReducedMotion?: boolean; veraCountsAudio?: boolean} = {}) {
  expect((await page.request.put('/api/settings', {data: {name: 'Anna Smith', workspace: 'Studio'}})).ok()).toBeTruthy();
  const teamId = ((await (await page.request.post('/api/design-teams', {data: {name: 'North Studio'}})).json()) as {team: {id: string}}).team.id;
  const invite = async (role: string) => ((await (await page.request.post(`/api/design-teams/${teamId}/invites`, {data: {role, days: 7, maxUses: 1}})).json()) as {token: string}).token;
  const boris = await person(browser, page, baseURL, 'Boris Petrov');
  const vera = await person(browser, page, baseURL, 'Vera Fox', {reducedMotion: options.veraReducedMotion, countAudio: options.veraCountsAudio});
  expect((await boris.page.request.post(`/api/design-teams/invites/${await invite('editor')}/accept`)).ok()).toBeTruthy();
  expect((await vera.page.request.post(`/api/design-teams/invites/${await invite('viewer')}/accept`)).ok()).toBeTruthy();
  const created = await page.request.post('/api/design-files', {data: {name: 'Home variants', teamId, document: startingDocument()}});
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  return {id, boris, vera};
}

async function openFile(page: Page, id: string) {
  await page.goto('/#design/' + encodeURIComponent(id));
  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  // The meeting loads after co-editing (its own chunk).
  await expect.poll(() => page.evaluate(() => !!(window as unknown as TestHost).__morfaDesignTest?.meeting), {timeout: 20_000}).toBe(true);
  await page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest!.store.setViewport({x: -40, y: -80, zoom: 0.75}));
}

/** A point of a frame on screen (`fx`, `fy`: where inside it, 0–1). */
async function pointOf(page: Page, frameId: string, fx = 0.5, fy = 0.5) {
  const box = (await page.getByRole('application', {name: 'Canvas'}).boundingBox())!;
  const {frame, viewport} = await page.evaluate(id => {
    const state = (window as unknown as TestHost).__morfaDesignTest!.store.getState();
    return {frame: state.doc.nodes[id], viewport: state.viewports[state.pageId]};
  }, frameId);
  return {x: box.x + (frame.x + frame.width * fx - viewport.x) * viewport.zoom, y: box.y + (frame.y + frame.height * fy - viewport.y) * viewport.zoom};
}
const toolOf = (page: Page) => page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest!.store.getState().tool);
const meetingMenu = (page: Page) => page.getByRole('button', {name: 'Reactions and meeting'});
const seconds = (text: string | null) => {
  const [minutes, rest] = (text ?? '').split(':').map(Number);
  return minutes * 60 + rest;
};

test('a shared timer with music: editors run it, everyone counts to the same moment, sound waits for a gesture and mutes per person', async ({page, seed: _seed, browser, baseURL}) => {
  test.setTimeout(120_000);
  const {id, boris, vera} = await room(page, browser, baseURL!, {veraCountsAudio: true});
  const fetched: string[] = [];
  for (const who of [page, boris.page, vera.page]) who.on('request', request => fetched.push(request.url()));
  await openFile(page, id);
  await openFile(boris.page, id);

  // ── Anna starts three minutes with "Lo-fi" ──
  await meetingMenu(page).click();
  await page.getByRole('button', {name: /^Timer/}).click();
  const panel = page.getByRole('dialog', {name: 'Timer'});
  await panel.getByRole('button', {name: '3 min'}).click();
  await panel.getByRole('button', {name: 'Music'}).click();
  await page.getByRole('menuitemradio', {name: 'Lo-fi'}).click();
  const musicStarted = fetched.length;
  await panel.getByRole('button', {name: 'Start'}).click();
  await expect(panel.getByRole('button', {name: 'Pause'})).toBeVisible();
  await page.keyboard.press('Escape');

  // ── Everyone sees the pill counting down to the same moment ──
  const pillA = page.locator('.dz-meet-timer'), pillB = boris.page.locator('.dz-meet-timer');
  await expect(pillB).toBeVisible();
  await expect(pillB).toHaveAttribute('aria-label', /Timer: 0[23]:\d\d/);
  const [a, b] = await Promise.all([pillA.textContent(), pillB.textContent()]);
  expect(Math.abs(seconds(a) - seconds(b))).toBeLessThanOrEqual(1);
  await page.screenshot({path: test.info().outputPath('timer-anna.png')});

  // ── Vera (a viewer) opens the file while it runs: no sound before her first gesture, music after it, mute is hers alone. Until her
  // click the test only listens to the network (see `person`). ──
  let audioContexts = 0;
  vera.page.on('request', request => {
    if (request.url().endsWith('/__meeting-audio-probe')) audioContexts++;
  });
  const read = vera.page.waitForResponse(response => response.url().endsWith(`/api/design-files/${encodeURIComponent(id)}/meeting`) && response.request().method() === 'GET', {timeout: 30_000});
  await vera.page.goto('/#design/' + encodeURIComponent(id));
  await read;
  await vera.page.waitForTimeout(2_000);
  expect(audioContexts, 'no audio before a gesture, though the timer runs with music').toBe(0);
  await vera.page.getByRole('application', {name: 'Canvas'}).click({position: {x: 20, y: 400}});
  await expect.poll(() => audioContexts, {message: 'the music starts with her first click'}).toBe(1);
  await vera.page.locator('.dz-meet-timer').click();
  const veraPanel = vera.page.getByRole('dialog', {name: 'Timer'});
  await expect(veraPanel.getByText('The timer is controlled by the file’s editors.')).toBeVisible();
  await expect(veraPanel.getByRole('button', {name: 'Pause'})).toHaveCount(0);
  await expect(veraPanel.getByText('Started by: Anna Smith')).toBeVisible();
  await veraPanel.getByRole('button', {name: 'Mute'}).click();
  expect(await vera.page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest!.meeting!.sound.muted())).toBe(true);
  expect(await boris.page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest!.meeting!.sound.muted()), 'muting is per person').toBe(false);
  expect((await vera.page.request.post(`/api/design-files/${id}/meeting/timer`, {data: {action: 'pause'}})).status(), 'viewers cannot run it').toBe(403);
  await vera.page.keyboard.press('Escape');

  // ── Boris (an editor) pauses; everyone sees the pause; Anna stops ──
  await pillB.click();
  await boris.page.getByRole('dialog', {name: 'Timer'}).getByRole('button', {name: 'Pause'}).click();
  await expect(pillA).toHaveAttribute('aria-label', /paused/);
  await expect(vera.page.locator('.dz-meet-timer')).toHaveAttribute('aria-label', /paused/);
  await boris.page.keyboard.press('Escape');
  await pillA.click();
  await page.getByRole('dialog', {name: 'Timer'}).getByRole('button', {name: 'Stop'}).click();
  await expect(pillB).toHaveCount(0);
  await expect(vera.page.locator('.dz-meet-timer')).toHaveCount(0);

  // The music is generated in the browser: nothing beyond the app's own requests was fetched for it.
  const origin = new URL(baseURL!).origin;
  expect(fetched.slice(musicStarted).filter(url => !url.startsWith(origin)), 'no outside requests').toEqual([]);
  expect(fetched.slice(musicStarted).filter(url => /\.(mp3|ogg|wav|m4a|aac|flac)(\?|$)/i.test(url)), 'no recording fetched').toEqual([]);
  await boris.context.close();
  await vera.context.close();
});

test('a voting session: everyone’s dots stay hidden until the end, a viewer votes too, the results reach everyone', async ({page, seed: _seed, browser, baseURL}) => {
  test.setTimeout(120_000);
  const {id, boris, vera} = await room(page, browser, baseURL!);
  await openFile(page, id);
  await openFile(boris.page, id);
  await openFile(vera.page, id);

  // ── Anna starts a vote: two votes each, no timer ──
  await meetingMenu(page).click();
  await page.getByRole('button', {name: /Voting…/}).click();
  const setup = page.getByRole('dialog', {name: 'Voting'});
  await setup.getByRole('button', {name: 'Votes per person: less'}).click();
  await setup.getByRole('checkbox', {name: 'With a timer'}).click();
  await setup.getByRole('button', {name: 'Start voting'}).click();
  // Everyone else is taken into voting: the bar replaces the toolbar.
  for (const who of [boris.page, vera.page]) {
    await expect(who.getByRole('region', {name: 'Voting', exact: true})).toContainText('Keep clicking frames: 2 of 2 left');
    await expect.poll(() => toolOf(who)).toBe('meeting-vote');
    await expect(who.getByRole('toolbar', {name: 'Tools'})).toBeHidden();
  }
  await expect(boris.page.getByText(/Anna Smith started a vote: you have 2 votes/)).toBeVisible();

  // ── Boris votes for A and B, takes B back and votes for C; Vera (a viewer) votes for C ──
  for (const frame of ['1:1', '1:2']) {
    const at = await pointOf(boris.page, frame);
    await boris.page.mouse.click(at.x, at.y);
  }
  await expect(boris.page.locator('.dz-meet-dot')).toHaveCount(2);
  await expect(boris.page.getByRole('region', {name: 'Voting', exact: true})).toContainText('You are out of votes');
  await boris.page.getByRole('button', {name: 'Remove vote: Variant B'}).click();
  await expect(boris.page.locator('.dz-meet-dot')).toHaveCount(1);
  const c = await pointOf(boris.page, '1:3');
  await boris.page.mouse.click(c.x, c.y);
  await expect(boris.page.locator('.dz-meet-dot')).toHaveCount(2);
  const cv = await pointOf(vera.page, '1:3');
  await vera.page.mouse.click(cv.x, cv.y);
  await expect(vera.page.locator('.dz-meet-dot')).toHaveCount(1);
  // Hidden until the end: Anna sees nobody's dots, and the server tells her nothing.
  await page.waitForTimeout(500);
  await expect(page.locator('.dz-meet-badge')).toHaveCount(0);
  const during = (await (await page.request.get(`/api/design-files/${id}/meeting`)).json()) as {vote: {results: unknown; mine: unknown[]}};
  expect(during.vote.results).toBeNull();
  expect(during.vote.mine).toEqual([]);
  await boris.page.screenshot({path: test.info().outputPath('vote-boris.png')});

  // ── Anna ends it: everyone sees the results, C first; voting mode ends ──
  await page.getByRole('region', {name: 'Voting', exact: true}).getByRole('button', {name: 'End', exact: true}).click();
  await page.getByRole('region', {name: 'Voting', exact: true}).getByRole('button', {name: 'End for everyone'}).click();
  for (const who of [page, boris.page, vera.page]) {
    const results = who.getByRole('region', {name: 'Voting results'});
    await expect(results).toBeVisible();
    await expect(results).toContainText('2 voted · 3 votes');
    await expect(results.getByRole('listitem').first()).toContainText('Variant C');
    await expect(results.getByRole('listitem').first()).toContainText('2');
    await expect(who.locator('.dz-meet-badge.is-result')).toHaveCount(2);
  }
  await expect.poll(() => toolOf(boris.page)).toBe('move');
  await expect(boris.page.getByRole('toolbar', {name: 'Tools'})).toBeVisible();
  await page.screenshot({path: test.info().outputPath('results-anna.png')});
  // A viewer cannot clear them; an editor clears them for everyone.
  await expect(vera.page.getByRole('button', {name: 'Clear results for everyone'})).toHaveCount(0);
  await page.getByRole('button', {name: 'Clear results for everyone'}).click();
  await expect(boris.page.getByRole('region', {name: 'Voting results'})).toHaveCount(0);
  await expect(vera.page.locator('.dz-meet-badge')).toHaveCount(0);
  await boris.context.close();
  await vera.context.close();
});

test('cursor chat, emotes, a high five and "Get attention" between people; no motion from the keyboard, bursts still with reduced motion', async ({page, seed: _seed, browser, baseURL}) => {
  test.setTimeout(120_000);
  const {id, boris, vera} = await room(page, browser, baseURL!, {veraReducedMotion: true});
  await openFile(page, id);
  await openFile(boris.page, id);
  await openFile(vera.page, id);

  // ── "/": Boris types at his cursor, Anna reads it there; it appears without motion and fades after Enter ──
  const b = await pointOf(boris.page, '1:2', 0.4, 0.3);
  await boris.page.mouse.move(b.x - 20, b.y - 10);
  await boris.page.mouse.move(b.x, b.y, {steps: 3});
  await boris.page.keyboard.press('Slash');
  const field = boris.page.getByRole('textbox', {name: /Cursor chat/});
  await expect(field).toBeFocused();
  expect(await boris.page.locator('.dz-meet-chat-self').evaluate(element => {
    const style = getComputedStyle(element);
    return [style.animationName, element.getAnimations().length];
  }), 'opened from the keyboard: no animation').toEqual(['none', 0]);
  await boris.page.keyboard.type('I like B better 👍');
  await expect(field).toHaveValue('I like B better 👍');
  const remote = page.locator('.dz-live-cursor .dz-meet-chat-remote');
  await expect(remote).toContainText('I like B better 👍');
  await expect(remote).toContainText('Boris Petrov');
  await page.screenshot({path: test.info().outputPath('chat-anna.png')});
  await boris.page.keyboard.press('Enter');
  await expect(boris.page.locator('.dz-meet-chat-self.is-sent')).toContainText('I like B better 👍');
  await expect(remote).toHaveCount(0, {timeout: 8_000});

  // ── Emotes: Boris holds "Fire" on the canvas; Anna and Vera see bursts at his cursor (Vera's only fade) ──
  await meetingMenu(boris.page).click();
  await boris.page.getByRole('button', {name: 'Fire'}).click();
  await expect(boris.page.getByRole('toolbar', {name: 'Reactions'})).toBeVisible();
  await expect(boris.page.getByRole('toolbar', {name: 'Tools'})).toBeHidden();
  const fire = await pointOf(boris.page, '1:1');
  await boris.page.mouse.move(fire.x, fire.y);
  await boris.page.mouse.down();
  await expect(page.locator('.dz-meet-burst').first()).toContainText('🔥');
  await expect(vera.page.locator('.dz-meet-burst').first()).toBeAttached();
  const moves = await vera.page.locator('.dz-meet-burst').first().evaluate(element =>
    element.getAnimations({subtree: true}).flatMap(animation => (animation.effect as KeyframeEffect).getKeyframes().map(frame => 'transform' in frame)),
  );
  expect(moves.length).toBeGreaterThan(0);
  expect(moves.every(transform => !transform), 'reduced motion: a burst only fades').toBe(true);
  await boris.page.mouse.up();
  await boris.page.keyboard.press('Escape');
  await expect(boris.page.getByRole('toolbar', {name: 'Tools'})).toBeVisible();

  // ── A high five: Anna and Boris wave next to each other ──
  for (const who of [page, boris.page]) {
    await meetingMenu(who).click();
    await who.getByRole('button', {name: /High five/}).click();
  }
  const five = await pointOf(page, '1:3');
  await page.mouse.move(five.x, five.y);
  await boris.page.mouse.move(five.x + 6, five.y + 4);
  await page.mouse.down();
  await expect(boris.page.locator('.dz-live-cursor .dz-meet-wave')).toBeAttached();
  await boris.page.mouse.down();
  await expect(page.locator('.dz-meet-burst.is-high-five')).toBeAttached();
  await expect(boris.page.locator('.dz-meet-burst.is-high-five')).toBeAttached();
  await page.mouse.up();
  await boris.page.mouse.up();
  for (const who of [page, boris.page]) await who.keyboard.press('Escape');

  // ── "Get attention": Boris and Vera follow Anna; Boris steps away and comes back; Anna stops ──
  await meetingMenu(page).click();
  await page.getByRole('button', {name: /Get attention/}).click();
  await expect(page.getByRole('status').filter({hasText: 'Everyone is following your view'})).toBeVisible();
  for (const who of [boris.page, vera.page]) await expect(who.getByRole('status').filter({hasText: 'Following: Anna Smith'})).toBeVisible();
  await page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest!.store.setViewport({x: 600, y: 100, zoom: 1.5}));
  await expect.poll(() => boris.page.evaluate(() => {
    const state = (window as unknown as TestHost).__morfaDesignTest!.store.getState();
    return state.viewports[state.pageId]?.zoom;
  })).toBeCloseTo(1.5, 1);
  await page.screenshot({path: test.info().outputPath('spotlight-anna.png')});
  await boris.page.keyboard.press('Escape');
  const back = boris.page.getByRole('status').filter({hasText: 'Anna Smith is getting attention'});
  await expect(back).toBeVisible();
  await back.getByRole('button', {name: 'Follow'}).click();
  await expect(boris.page.getByRole('status').filter({hasText: 'Following: Anna Smith'})).toBeVisible();
  await page.getByRole('status').filter({hasText: 'Everyone is following your view'}).getByRole('button', {name: 'Stop'}).click();
  for (const who of [boris.page, vera.page]) await expect(who.getByRole('status').filter({hasText: 'Following: Anna Smith'})).toHaveCount(0);
  await boris.context.close();
  await vera.context.close();
});

// ── On a board ───────────────────────────────────────────────────────────────────────────────────

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const STICKIES = [
  {id: '9:1', text: 'Dark theme', x: -420},
  {id: '9:4', text: 'Onboarding', x: -120},
  {id: '9:7', text: 'File search', x: 180},
];
function boardDocument() {
  const tx = beginTransaction(createBoardDocument(PAGE));
  let n = 0;
  const id = () => `9:${++n}`;
  for (const sticky of STICKIES) insertPieces(tx, createSticky(id, {x: sticky.x, y: -120, text: sticky.text}), PAGE);
  insertPieces(tx, createShape(id, {x: -120, y: 200, shape: 'diamond', text: 'Decision'}), PAGE);
  return tx.commit({measurer}).doc;
}
async function openBoard(page: Page, id: string) {
  await page.goto('/#design/' + encodeURIComponent(id));
  await expect(page.getByRole('toolbar', {name: 'Board tools'})).toBeVisible();
  // The meeting loads with co-editing and plugs into the board's top-right pill.
  await expect(page.locator('.bd-top-right').getByRole('button', {name: 'Reactions and meeting'})).toBeVisible({timeout: 20_000});
  await page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest!.store.setViewport({x: -720, y: -300, zoom: 1}));
}

test('on a board: the timer and votes in the board’s pill, a click on a sticky votes, ⌥-click takes back, Escape leaves, chat and emotes', async ({page, seed: _seed, browser, baseURL}) => {
  test.setTimeout(150_000);
  expect((await page.request.put('/api/settings', {data: {name: 'Anna Smith', workspace: 'Studio'}})).ok()).toBeTruthy();
  const teamId = ((await (await page.request.post('/api/design-teams', {data: {name: 'North Studio'}})).json()) as {team: {id: string}}).team.id;
  const token = ((await (await page.request.post(`/api/design-teams/${teamId}/invites`, {data: {role: 'editor', days: 7, maxUses: 1}})).json()) as {token: string}).token;
  // Boris works in the dark theme: the board's chrome follows it, its canvas stays paper.
  const boris = await person(browser, page, baseURL!, 'Boris Petrov', {dark: true});
  expect((await boris.page.request.post(`/api/design-teams/invites/${token}/accept`)).ok()).toBeTruthy();
  const created = await page.request.post('/api/design-files', {data: {name: 'Retro', teamId, kind: 'board', document: boardDocument()}});
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as {file: {id: string}}).file.id;
  await openBoard(page, id);
  await openBoard(boris.page, id);

  // ── The pill: the timer (always there, FigJam's way) and "Reactions and meeting", sized like the board's own 36 px buttons ──
  const pill = page.locator('.bd-top-right');
  for (const name of ['Timer', 'Reactions and meeting']) {
    const box = (await pill.getByRole('button', {name, exact: true}).boundingBox())!;
    expect([box.width, box.height]).toEqual([36, 36]);
  }
  // A board mounts the meeting once, through its slot: the design file's own layer is not there too.
  await expect(page.locator('.dz-meet-layer')).toHaveCount(1);
  await page.screenshot({path: test.info().outputPath('board-anna.png')});

  // ── The timer from the pill: everyone sees it run ──
  await pill.getByRole('button', {name: 'Timer', exact: true}).click();
  const timerPanel = page.getByRole('dialog', {name: 'Timer'});
  // The board's purple reaches the popover, drawn outside the board: the chosen preset and "Start" wear it.
  const purple = await page.locator('.dz-board').evaluate(element => getComputedStyle(element).getPropertyValue('--bd-accent').trim());
  const rgbOf = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  await expect(timerPanel.getByRole('button', {name: '3 min'})).toHaveCSS('background-color', rgbOf(purple));
  await timerPanel.getByRole('button', {name: 'Start'}).click();
  // Escape after the timer runs, the order a loaded machine used to fail on: "Start" had focus and became "Pause", focus fell to the
  // page, Escape left the popover open and the click on the pill below closed it. The popover keeps focus now.
  await expect(page.locator('.bd-top-right .dz-meet-timer')).toHaveAttribute('aria-label', /Timer: 0[23]:\d\d/);
  await page.keyboard.press('Escape');
  await expect(timerPanel).toHaveCount(0);
  await expect(boris.page.locator('.bd-top-right .dz-meet-timer')).toHaveAttribute('aria-label', /Timer: 0[23]:\d\d/);
  await page.locator('.bd-top-right .dz-meet-timer').click();
  await page.getByRole('dialog', {name: 'Timer'}).getByRole('button', {name: 'Stop'}).click();
  await expect(boris.page.locator('.bd-top-right .dz-meet-timer')).toHaveCount(0);

  // ── Anna starts a vote; Boris is taken into voting, the bar at the top centre, clear of the board's chrome ──
  await pill.getByRole('button', {name: 'Reactions and meeting'}).click();
  await page.getByRole('button', {name: /Voting…/}).click();
  const setup = page.getByRole('dialog', {name: 'Voting'});
  await setup.getByRole('checkbox', {name: 'With a timer'}).click();
  await setup.getByRole('button', {name: 'Start voting'}).click();
  const bar = boris.page.getByRole('region', {name: 'Voting', exact: true});
  await expect(bar).toContainText('Keep clicking stickies and shapes: 3 of 3 left');
  expect((await bar.boundingBox())!.y).toBeLessThan(40);

  // A click on a sticky votes: the board draws the badge, filled with its purple (this person's own votes).
  const stickyAt = async (who: Page, nodeId: string) => {
    const box = (await who.getByRole('application', {name: 'Canvas'}).boundingBox())!;
    const {node, viewport} = await who.evaluate(target => {
      const state = (window as unknown as TestHost).__morfaDesignTest!.store.getState();
      return {node: state.doc.nodes[target], viewport: state.viewports[state.pageId]};
    }, nodeId);
    return {x: box.x + (node.x + node.width / 2 - viewport.x) * viewport.zoom, y: box.y + (node.y + 60 - viewport.y) * viewport.zoom};
  };
  const dark = await stickyAt(boris.page, '9:1');
  await boris.page.mouse.click(dark.x, dark.y);
  const badge = boris.page.locator('.bd-badge.is-mine');
  await expect(badge).toHaveText('1');
  const borisPurple = await boris.page.locator('.dz-board').evaluate(element => getComputedStyle(element).getPropertyValue('--bd-accent').trim());
  await expect(badge).toHaveCSS('background-color', rgbOf(borisPurple));
  await expect(bar).toContainText('2 of 3 left');
  await expect.poll(async () => (await boris.page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest!.store.getState().selection)) ?? [], {message: 'a vote selects nothing'}).toEqual([]);
  await boris.page.screenshot({path: test.info().outputPath('board-vote-boris-dark.png')});
  // ⌥-click takes it back.
  await boris.page.keyboard.down('Alt');
  await boris.page.mouse.click(dark.x, dark.y);
  await boris.page.keyboard.up('Alt');
  await expect(badge).toHaveCount(0);
  await expect(bar).toContainText('3 of 3 left');
  // Votes for "Onboarding"; Escape leaves voting: the bar offers "Vote", a click on a sticky selects it and votes for nothing.
  const onboarding = await stickyAt(boris.page, '9:4');
  await boris.page.mouse.click(onboarding.x, onboarding.y);
  await expect(badge).toHaveText('1');
  await boris.page.keyboard.press('Escape');
  await expect(bar).toContainText('Voting in progress · 2 of 3 left');
  await boris.page.mouse.click(dark.x, dark.y);
  await expect.poll(() => boris.page.evaluate(() => (window as unknown as TestHost).__morfaDesignTest!.store.getState().selection)).toEqual(['9:1']);
  await expect(badge).toHaveCount(1);
  await boris.page.keyboard.press('Escape');

  // ── Anna votes "Onboarding" and ends it: everyone sees the results, the winner's badge in the accent ──
  const annaOnboarding = await stickyAt(page, '9:4');
  await page.mouse.click(annaOnboarding.x, annaOnboarding.y);
  await page.getByRole('region', {name: 'Voting', exact: true}).getByRole('button', {name: 'End', exact: true}).click();
  await page.getByRole('region', {name: 'Voting', exact: true}).getByRole('button', {name: 'End for everyone'}).click();
  for (const who of [page, boris.page]) {
    const results = who.getByRole('region', {name: 'Voting results'});
    await expect(results).toContainText('2 voted · 2 votes');
    await expect(results.getByRole('listitem').first()).toContainText('Onboarding');
    await expect(who.locator('.bd-badge')).toHaveCount(1);
    await expect(who.locator('.bd-badge')).toHaveText('2');
    await expect(who.getByRole('region', {name: 'Voting', exact: true})).toHaveCount(0);
  }
  await page.screenshot({path: test.info().outputPath('board-results-anna.png')});

  // ── Cursor chat and an emote over the board's canvas ──
  const free = await stickyAt(boris.page, '9:7');
  await boris.page.mouse.move(free.x, free.y + 240);
  await boris.page.mouse.move(free.x + 10, free.y + 250, {steps: 3});
  await boris.page.keyboard.press('Slash');
  await boris.page.keyboard.type('Voting for onboarding');
  await expect(page.locator('.dz-live-cursor .dz-meet-chat-remote')).toContainText('Voting for onboarding');
  await boris.page.keyboard.press('Enter');
  await pill.getByRole('button', {name: 'Reactions and meeting'}).click();
  await page.getByRole('button', {name: 'Hooray'}).click();
  await expect(page.getByRole('toolbar', {name: 'Reactions'})).toBeVisible();
  const burstAt = await stickyAt(page, '9:7');
  await page.mouse.move(burstAt.x, burstAt.y + 260);
  await page.mouse.down();
  await expect(boris.page.locator('.dz-meet-burst').first()).toContainText('🎉');
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', {name: 'Reactions'})).toHaveCount(0);
  await boris.page.screenshot({path: test.info().outputPath('board-chat-boris-dark.png')});
  await boris.context.close();
});
