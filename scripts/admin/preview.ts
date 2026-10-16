// The operator console's preview: `npx tsx scripts/admin/preview.ts [--only name,name] [--keep]`. Starts (or reuses) Vite on 5480
// (`--mode app`), opens Chromium with every /api call answered from scripts/admin/fixtures.ts (an operator signed in, /api/config with
// `admin: true`, the console's reports, the support inbox), fixes the clock to the fixtures' moment, and screenshots each screen at
// 1440 × 900 (the whole page) and 390 × 844 (the phone's first screen and its whole length) into output/admin-preview/. It also shoots a
// hover tooltip, the empty and the error states, the dark theme and an inbox with nobody waiting. No backend is needed.
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium, type Browser, type Page, type Route} from 'playwright';
import {isAdminPeriod, type AdminAccountSort, type AccountSegment} from '../../shared/admin-analytics';
import {DESIGN_LIMITS} from '../../shared/design/limits';
import type {DesignFileList} from '../../shared/design/api';
import {account, accounts, NOW, overview, SAMPLE_ACCOUNT, SAMPLE_THREAD, SupportStore, usage} from './fixtures';

const PORT = Number(process.env.ADMIN_PREVIEW_PORT ?? 5480);
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = path.resolve('output/admin-preview');
const args = process.argv.slice(2);
const only = (() => {
  const index = args.indexOf('--only');
  return index >= 0 ? new Set(args[index + 1].split(',')) : null;
})();
const keep = args.includes('--keep');

const OPERATOR = {id: 'acc_operator', email: 'owner@morfa.example', name: 'Morfa operator', emailVerified: true};

async function up(): Promise<boolean> {
  try {
    const response = await fetch(BASE, {signal: AbortSignal.timeout(1500)});
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureVite(): Promise<ChildProcess | null> {
  if (await up()) return null;
  // --keep leaves Vite running for the next run: detached, with no pipes to hold this process open.
  const child = spawn('npx', ['vite', '--mode', 'app', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    stdio: keep ? 'ignore' : ['ignore', 'ignore', 'pipe'],
    detached: keep,
    env: process.env,
  });
  child.stderr?.on('data', chunk => process.stderr.write(String(chunk)));
  if (keep) child.unref();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await up()) return child;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  child.kill();
  throw new Error(`Vite did not start on ${PORT}`);
}

/** Playwright's own Chromium when it is installed, else the container's (PLAYWRIGHT_CHROMIUM overrides). */
export function executablePath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  for (const candidate of ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium']) if (fs.existsSync(candidate)) return candidate;
  return undefined;
}

type Mode = {
  /** Paths (after /api) that answer 500 with a request id. */
  fail?: RegExp;
  /** The support inbox has nobody waiting. */
  supportEmpty?: boolean;
  /** false: the signed-in account is not an operator (/api/config without `admin`, /api/admin answers 404). */
  operator?: boolean;
};

export async function intercept(page: Page, mode: Mode = {}) {
  const support = new SupportStore();
  support.empty = mode.supportEmpty === true;
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const at = url.pathname.replace(/^\/api/, '');
    const method = request.method();
    const params = url.searchParams;
    const json = (body: unknown, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
    if (mode.fail?.test(at)) return json({error: 'The report could not be built: the database did not answer in time.', code: 'report_failed', requestId: 'req_7f3a9c21e4'}, 500);
    const periodParam = params.get('period');
    const period = isAdminPeriod(periodParam) ? periodParam : '30d';

    const operator = mode.operator !== false;
    if (at === '/config') return json({...(operator ? {admin: true} : {})});
    if (!operator && at.startsWith('/admin/')) return json({error: 'Not found.'}, 404);
    if (at === '/auth/me') return json(OPERATOR);
    if (at === '/admin/overview') return json(overview(period));
    if (at === '/admin/usage') return json(usage(period));
    if (at === '/admin/accounts') {
      const page = Number(params.get('page') ?? '1');
      return json(accounts({
        q: params.get('q') ?? undefined,
        segment: (params.get('segment') as AccountSegment | null) ?? 'all',
        sort: (params.get('sort') as AdminAccountSort | null) ?? 'created',
        order: params.get('order') === 'asc' ? 'asc' : 'desc',
        page: Number.isInteger(page) && page > 0 ? page : 1,
      }));
    }
    const accountMatch = /^\/admin\/accounts\/([^/]+)$/.exec(at);
    if (accountMatch) {
      const detail = account(decodeURIComponent(accountMatch[1]));
      return detail ? json(detail) : json({error: 'No such account.', requestId: 'req_404'}, 404);
    }
    if (at === '/admin/support/unread') return json({waiting: support.waiting()});
    if (at === '/admin/support/threads') return json(support.inbox((params.get('filter') as 'waiting' | 'open' | 'closed' | 'all' | null) ?? 'waiting', params.get('q') ?? ''));
    const thread = /^\/admin\/support\/threads\/([^/]+)(?:\/(messages|status|read|typing))?$/.exec(at);
    if (thread) {
      const id = decodeURIComponent(thread[1]);
      const body = request.postData() ? JSON.parse(request.postData()!) : {};
      if (method === 'GET' && !thread[2]) {
        const conversation = support.conversation(id);
        return conversation ? json(conversation) : json({error: 'Conversation not found.'}, 404);
      }
      if (method === 'POST' && thread[2] === 'messages') return json(support.reply(id, String(body.body ?? '')));
      if (method === 'POST' && thread[2] === 'status') return json(support.setStatus(id, body.status === 'closed' ? 'closed' : 'open'));
      if (method === 'POST' && thread[2] === 'read') {
        support.read(id);
        return route.fulfill({status: 204, body: ''});
      }
      if (method === 'POST' && thread[2] === 'typing') return route.fulfill({status: 204, body: ''});
    }
    // The file browser's own boot (the way in through the account menu, scripts/admin/preview-shell.ts): an empty workspace.
    if (at === '/design-files') return json({files: [], usage: {files: 0, storageBytes: 0}, limits: DESIGN_LIMITS} satisfies DesignFileList);
    if (at === '/design-teams') return json({teams: []});
    if (at === '/design-favourites') return json({files: [], projects: []});
    // Anything else the shell might ask on boot: a harmless empty answer.
    return json(null);
  });
}

export async function settle(page: Page, ready: string) {
  await page.waitForSelector(ready, {timeout: 20_000});
  await page.waitForFunction(() => !document.querySelector('.mfa-page .mfa-skel, [aria-busy="true"]'), undefined, {timeout: 20_000}).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

/** The whole length of the workspace: the viewport grows to the content, so nothing scrolls inside. */
export async function fullLength(page: Page, width: number, minHeight: number) {
  const extra = await page.evaluate(() => {
    const work = document.querySelector('.mfa-work') as HTMLElement | null;
    if (!work) return 0;
    return work.scrollHeight - work.clientHeight;
  });
  if (extra > 0) {
    await page.setViewportSize({width, height: minHeight + extra});
    await page.waitForTimeout(300);
  }
}

type Shot = {name: string; hash: string; ready: string; mode?: Mode; dark?: boolean; then?: (page: Page) => Promise<void>; desktop?: boolean; phone?: boolean; fill?: boolean};

const SHOTS: Shot[] = [
  {name: 'overview', hash: '#admin', ready: '.mfa-kpi-value'},
  {name: 'overview-365d', hash: '#admin?period=365d', ready: '.mfa-kpi-value', phone: false},
  {name: 'accounts', hash: '#admin/accounts', ready: '.mfa-table tbody tr:not(.is-skeleton)'},
  {name: 'accounts-closing', hash: '#admin/accounts?segment=closing', ready: '.mfa-table tbody tr:not(.is-skeleton)', phone: false},
  {name: 'account', hash: `#admin/accounts/${SAMPLE_ACCOUNT}`, ready: '.mfa-head h1'},
  {name: 'usage', hash: '#admin/usage', ready: '.mfa-kpi-value'},
  {name: 'support', hash: '#admin/support', ready: '.mfa-thread:not(.is-skeleton)', fill: true},
  {name: 'support-thread', hash: `#admin/support/${SAMPLE_THREAD}`, ready: '.mfa-bubble', fill: true},
  {name: 'support-empty', hash: '#admin/support', ready: '.mfa-answered', mode: {supportEmpty: true}, fill: true},
  {name: 'empty-search', hash: '#admin/accounts?q=zzzz', ready: '.mfa-empty', phone: false},
  {name: 'error', hash: '#admin/usage', ready: '.mfa-failure', mode: {fail: /^\/admin\/usage/}},
  {name: 'dark-overview', hash: '#admin', ready: '.mfa-kpi-value', dark: true},
  {name: 'dark-support', hash: `#admin/support/${SAMPLE_THREAD}`, ready: '.mfa-bubble', dark: true, phone: false, fill: true},
  {
    name: 'tooltip-area',
    hash: '#admin',
    ready: '.mfa-kpi-value',
    phone: false,
    fill: true,
    then: async page => {
      const plot = page.locator('.mfa-plot').first();
      await plot.scrollIntoViewIfNeeded();
      const box = (await plot.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5);
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'tooltip-bars',
    hash: '#admin/usage?period=90d',
    ready: '.mfa-kpi-value',
    phone: false,
    fill: true,
    then: async page => {
      const plot = page.locator('.mfa-plot').first();
      await plot.scrollIntoViewIfNeeded();
      const box = (await plot.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
      await page.waitForTimeout(200);
    },
  },
];

async function shoot(browser: Browser, shot: Shot, viewport: {width: number; height: number}, suffix: string, full: boolean) {
  const context = await browser.newContext({viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1, colorScheme: shot.dark ? 'dark' : 'light', locale: 'en-US', timezoneId: 'Europe/Moscow'});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/favicon|Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  await page.clock.setFixedTime(new Date(NOW));
  await intercept(page, shot.mode);
  await page.goto(BASE + shot.hash);
  await settle(page, shot.ready);
  if (full && !shot.fill) await fullLength(page, viewport.width, viewport.height);
  if (shot.then) await shot.then(page);
  const file = path.join(OUT, `${shot.name}${suffix}.png`);
  await page.screenshot({path: file, fullPage: false});
  // No horizontal scroll anywhere.
  const overflow = await page.evaluate(() => {
    const work = document.querySelector('.mfa-work') as HTMLElement | null;
    return {doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, work: work ? work.scrollWidth - work.clientWidth : 0};
  });
  if (overflow.doc > 0 || overflow.work > 0) errors.push(`horizontal overflow: document ${overflow.doc}px, workspace ${overflow.work}px`);
  await context.close();
  console.log(`${errors.length ? '!' : '✓'} ${path.relative(process.cwd(), file)}${errors.length ? '\n    ' + errors.join('\n    ') : ''}`);
}

async function main() {
  fs.mkdirSync(OUT, {recursive: true});
  const vite = await ensureVite();
  const executable = executablePath();
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'], ...(executable ? {executablePath: executable} : {})});
  try {
    for (const shot of SHOTS) {
      if (only && !only.has(shot.name)) continue;
      if (shot.desktop !== false) await shoot(browser, shot, {width: 1440, height: 900}, '', true);
      if (shot.phone !== false) {
        await shoot(browser, shot, {width: 390, height: 844}, '-390', false);
        if (!shot.fill) await shoot(browser, shot, {width: 390, height: 844}, '-390-full', true);
      }
    }
  } finally {
    await browser.close();
    if (vite && !keep) vite.kill();
  }
}

// Run as a script, not when the probe imports the interception.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
