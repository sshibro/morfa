// The support chat's look, without a server: Vite on 5482 (`--mode app`), Chromium with every /api answer made up here (the
// session, /api/config with `supportChat`, the file browser's boot calls, and /api/support/* from fixtures), then screenshots of the
// person's panel into output/support-preview/ (gitignored): the badge on the file browser's button, who answers (the team, online
// and not), the note after the first message, "typing…", a conversation over a few days, a failed
// send, the "New messages" pill, the dark theme and the phone's sheet.
//
//   npx tsx scripts/support/preview.ts [name…]    (only the scenarios whose name contains one; PREVIEW_PORT, PLAYWRIGHT_CHROMIUM)
//
// Uses a Chromium already installed (findChromium); it never installs one.
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser, type BrowserContext, type Page, type Route} from 'playwright';
import {SUPPORT_TEAM_NAME, type SupportMessage, type SupportTeam, type SupportThreadView} from '../../shared/support';

// The fixtures' days and hours are Moscow's, as the browser's.
process.env.TZ = 'Europe/Moscow';
const root = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(process.env.PREVIEW_PORT || 5482);
const base = `http://127.0.0.1:${port}`;
const out = path.join(root, 'output', 'support-preview');

/* ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────── */

const ACCOUNT = {id: 'acc-anna', email: 'anna@morfa.example', name: 'Anna Peterson'};
const CONFIG = {designTool: true, designPdf: false, designRaster: false, designAi: false, bigFiles: false, supportChat: true};
const LIMITS = {storageBytes: 20 * 1024 ** 3, historyDays: 365, trashDays: 365};

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
/** A moment `days` ago at a given local hour and minute. */
const dayAt = (days: number, hour: number, minute: number) => {
  const at = new Date(now);
  at.setDate(at.getDate() - days);
  at.setHours(hour, minute, 0, 0);
  return at.toISOString();
};
const FILES = [
  {id: 'f1', name: 'Landing page — spring', kind: 'design', minutes: 40},
  {id: 'f2', name: 'Mobile app', kind: 'design', minutes: 60 * 5},
  {id: 'f3', name: 'Sprint 42 retro', kind: 'board', minutes: 60 * 26},
  {id: 'f4', name: 'Brand book', kind: 'design', minutes: 60 * 72},
].map(file => ({id: file.id, name: file.name, kind: file.kind, version: 3, createdAt: ago(file.minutes + 600), updatedAt: ago(file.minutes), thumbnailUrl: null, trashedAt: null, teamId: null, projectId: null}));

let serial = 0;
const message = (author: SupportMessage['author'], body: string, createdAt: string): SupportMessage => ({id: `m${++serial}`, author, body, createdAt});

/** A conversation over three days with the team, the last of the person's messages read. */
function conversation(): SupportMessage[] {
  return [
    message('user', 'Hello! After the update I cannot export my layout to PDF — the button spins and nothing happens.', dayAt(2, 11, 4)),
    message('user', 'The file "Landing page — spring", the page "Home".', dayAt(2, 11, 5)),
    message('operator', 'Hello, Anna! Thanks for writing. I will look into the export and get back to you.', dayAt(2, 11, 32)),
    message('operator', 'Found the cause: the file uses a font that was missing on the export server. The fix is already out — please try again.', dayAt(1, 18, 40)),
    message('user', 'It worked, thanks! 🙌', dayAt(1, 19, 2)),
    message('user', 'One more question: can I move my personal files to a team without losing the version history?', ago(25)),
  ];
}

/** Who answers: the team, in the console now, answering in about 40 minutes (as measured). */
const TEAM: SupportTeam = {operators: [{name: SUPPORT_TEAM_NAME}], online: true, typicalReplyMinutes: 40, emailFollowUp: true};
const OFFLINE: Partial<SupportTeam> = {online: false, typicalReplyMinutes: 180};
const thread = (messages: SupportMessage[], extra: Partial<NonNullable<SupportThreadView['thread']>> = {}): SupportThreadView['thread'] =>
  ({id: 't1', status: 'open', messages, unread: 0, operatorReadAt: ago(1), ...extra});

type State = {thread: SupportThreadView['thread']; typing: boolean};
type Scenario = {
  name: string;
  thread: SupportThreadView['thread'];
  team?: Partial<SupportTeam>;
  typing?: boolean;
  unread?: number;
  /** POST /api/support/messages: answer with the thread plus the message, or fail. */
  send?: 'ok' | 'fail';
  viewport?: {width: number; height: number};
  dark?: boolean;
  /** Opens the panel (else the file browser alone, for the badge). */
  open?: boolean;
  act?: (page: Page, state: State) => Promise<void>;
  /** Screenshot of the panel alone as well. */
  clip?: boolean;
};

const PHONE = {width: 390, height: 844};
const SCENARIOS: Scenario[] = [
  {name: '01-badge', thread: thread([...conversation(), message('operator', 'Yes, you can: "Move to team" in the file menu.', ago(3))], {unread: 2, operatorReadAt: ago(4)}), unread: 2, open: false},
  {name: '02-empty-online', thread: null, open: true, clip: true},
  {name: '03-empty-offline', thread: null, team: OFFLINE, open: true, clip: true},
  {
    name: '04-first-message', thread: null, open: true, clip: true,
    act: async page => {
      const field = page.getByRole('textbox', {name: 'Message to support'});
      await field.fill('Hello! I cannot invite a colleague to the team — the e-mail does not arrive.');
      await field.press('Enter');
      await page.locator('.mf-sc-note').waitFor();
    },
  },
  {name: '05-typing', thread: thread(conversation()), typing: true, open: true, clip: true},
  {name: '06-conversation', thread: thread(conversation()), open: true, clip: true},
  {
    name: '09-failed', thread: thread(conversation()), team: OFFLINE, send: 'fail', open: true, clip: true,
    act: async page => {
      const field = page.getByRole('textbox', {name: 'Message to support'});
      await field.fill('How many versions are kept in a file?');
      await field.press('Enter');
      await page.getByText('Not sent').waitFor();
    },
  },
  {
    name: '10-new-pill', thread: thread(conversation()), open: true, clip: true,
    act: async (page, state) => {
      await page.locator('.mf-sc-list').evaluate(element => element.scrollTo({top: 0}));
      await page.waitForTimeout(300);
      state.thread = {...state.thread!, messages: [...state.thread!.messages, message('operator', 'Yes, you can: open the file menu and choose "Move to team". The version history moves along with the file.', ago(0))]};
      await page.getByText('New messages').waitFor({timeout: 12_000});
    },
  },
  {name: '11-dark', thread: thread(conversation()), typing: true, open: true, dark: true, clip: true},
  {name: '12-dark-empty-offline', thread: null, team: OFFLINE, open: true, dark: true, clip: true},
  {name: '13-phone', thread: thread(conversation()), typing: true, open: true, viewport: PHONE},
  {name: '14-phone-empty', thread: null, team: {...OFFLINE, typicalReplyMinutes: null}, open: true, viewport: PHONE},
];

/* ── The fake API ─────────────────────────────────────────────────────────────────────────────────── */

const json = (route: Route, body: unknown, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
async function fakeApi(context: BrowserContext, scenario: Scenario, state: State, unknown: Set<string>) {
  const team = {...TEAM, ...scenario.team};
  const view = () => ({enabled: true, team, operatorTyping: state.typing, thread: state.thread});
  await context.route(/\/(api|uploads)\//, async route => {
    const request = route.request(),
      url = new URL(request.url()),
      at = url.pathname,
      method = request.method();
    if (url.origin !== base) return route.continue();
    if (at.startsWith('/uploads/')) return route.fulfill({status: 404, body: ''});
    if (at === '/api/config') return json(route, CONFIG);
    if (at === '/api/auth/me') return json(route, ACCOUNT);
    if (at === '/api/design-files' && method === 'GET')
      return json(route, url.searchParams.has('shared') ? {files: []} : {files: url.searchParams.has('trash') ? [] : FILES, usage: {files: FILES.length, storageBytes: 12_400_000}, limits: LIMITS});
    if (at === '/api/design-teams') return json(route, {teams: []});
    if (at === '/api/design-favourites') return json(route, {files: [], projects: []});
    if (at === '/api/support') return json(route, view());
    if (at === '/api/support/unread') return json(route, {unread: state.thread?.unread ?? scenario.unread ?? 0});
    if (at === '/api/support/read') {
      if (state.thread) state.thread = {...state.thread, unread: 0};
      return route.fulfill({status: 204, body: ''});
    }
    if (at === '/api/support/messages' && method === 'POST') {
      if (scenario.send === 'fail') return json(route, {error: 'Could not complete the action. Check the data and try again.'}, 500);
      const input = JSON.parse(request.postData() || '{}') as {body: string};
      const current = state.thread ?? {id: 't-new', status: 'open' as const, messages: [], unread: 0, operatorReadAt: null};
      state.thread = {...current, messages: [...current.messages, message('user', input.body.trim(), new Date().toISOString())]};
      return json(route, view());
    }
    unknown.add(`${method} ${at}`);
    return json(route, {error: 'Route not found.'}, 404);
  });
}

/* ── Running ──────────────────────────────────────────────────────────────────────────────────────── */

/** PLAYWRIGHT_CHROMIUM, else Playwright's own build if it is installed, else the newest Chromium under PLAYWRIGHT_BROWSERS_PATH (a
 *  machine whose browsers are older than this Playwright). */
export function findChromium(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  if (existsSync(chromium.executablePath())) return undefined;
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const builds = existsSync(store) ? readdirSync(store).filter(name => /^chromium-\d+$/.test(name)).sort().reverse() : [];
  for (const build of builds) {
    const binary = path.join(store, build, 'chrome-linux', 'chrome');
    if (existsSync(binary)) return binary;
  }
  return undefined;
}

async function waitForVite(child: ChildProcess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error('Vite exited with ' + child.exitCode);
    const ok = await fetch(base + '/').then(response => response.ok, () => false);
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw Error('Vite did not start on ' + base);
}

async function shoot(browser: Browser, scenario: Scenario) {
  const state: State = {thread: scenario.thread ? structuredClone(scenario.thread) : null, typing: !!scenario.typing};
  const unknown = new Set<string>();
  const context = await browser.newContext({
    viewport: scenario.viewport ?? {width: 1280, height: 800},
    deviceScaleFactor: 2,
    locale: 'en-US',
    timezoneId: 'Europe/Moscow',
    colorScheme: scenario.dark ? 'dark' : 'light',
    isMobile: !!scenario.viewport && scenario.viewport.width < 768,
    hasTouch: !!scenario.viewport && scenario.viewport.width < 768,
    reducedMotion: 'reduce',
  });
  await fakeApi(context, scenario, state, unknown);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(String(error)));
  await page.goto(base + '/#designs');
  await page.locator('.dz-files-app').waitFor({timeout: 30_000});
  if (scenario.open) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('morfa:support-open', {detail: {source: 'button'}})));
    await page.locator('.mf-sc').waitFor();
    await page.locator('.mf-sc-skeleton').waitFor({state: 'detached'});
  } else {
    await page.locator('.mf-support-badge').waitFor({timeout: 10_000});
  }
  await scenario.act?.(page, state);
  await page.waitForTimeout(400);
  await page.screenshot({path: path.join(out, scenario.name + '.png')});
  if (scenario.clip && scenario.open) await page.locator('.mf-sc').screenshot({path: path.join(out, scenario.name + '-panel.png')});
  if (!scenario.open) await page.locator('.dz-files-top').screenshot({path: path.join(out, scenario.name + '-topbar.png')});
  await context.close();
  if (unknown.size) console.log(`  ${scenario.name}: unanswered ${[...unknown].join(', ')}`);
  if (problems.length) console.log(`  ${scenario.name}: page errors\n    ${problems.join('\n    ')}`);
}

await mkdir(out, {recursive: true});
// Vite's own script, in its own process group, so stopping it leaves nothing listening.
const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--mode', 'app', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
vite.stderr?.on('data', chunk => process.stderr.write(chunk));
try {
  await waitForVite(vite);
  const browser = await chromium.launch({executablePath: findChromium()});
  try {
    const only = process.argv.slice(2);
    for (const scenario of SCENARIOS) {
      if (only.length && !only.some(name => scenario.name.includes(name))) continue;
      console.log('shooting', scenario.name);
      await shoot(browser, scenario);
    }
  } finally {
    await browser.close();
  }
  console.log('screenshots in', path.relative(root, out));
} finally {
  try {
    process.kill(-vite.pid!, 'SIGTERM');
  } catch {
    vite.kill('SIGTERM');
  }
}
