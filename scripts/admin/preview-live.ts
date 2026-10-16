// The operator console against a real API (`npx tsx scripts/admin/preview-live.ts`): Vite on 5480 proxied to a running server
// (VITE_API_PROXY, e.g. the demo database of scripts/admin/demo-up.sh with MORFA_OPERATORS=owner@name.invalid).
// Signs in by name as "owner" (owner@name.invalid), prints the reports' headline numbers for a sanity check, and screenshots
// every console screen at 1440 (whole page) and 390 (first screen and whole length) into output/admin-preview/live-*.png. Nothing is
// intercepted and the clock is the real one.
import fs from 'node:fs';
import path from 'node:path';
import {chromium, type Browser, type BrowserContext} from 'playwright';

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
import type {AdminAccountsPage, AdminOverview, AdminUsage} from '../../shared/admin-analytics';
import {executablePath, fullLength, settle} from './preview';

const BASE = `http://127.0.0.1:${Number(process.env.ADMIN_PREVIEW_PORT ?? 5480)}/`;
const OUT = path.resolve('output/admin-preview');
const OPERATOR = process.env.ADMIN_PREVIEW_OPERATOR ?? 'owner';

// One sign-in for the whole run (the sign-in has a shared budget); every screenshot's context starts from its cookie.
let session: Session | undefined;

async function signedIn(browser: Browser, viewport: {width: number; height: number}): Promise<BrowserContext> {
  const context = await browser.newContext({viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1, locale: 'en-US', timezoneId: 'Europe/Moscow', storageState: session});
  if (!session) {
    const answer = await context.request.post(BASE + 'api/auth/name', {data: {name: OPERATOR}});
    if (!answer.ok()) throw new Error(`name sign-in refused: HTTP ${answer.status()} ${await answer.text()}`);
    session = await context.storageState();
  }
  return context;
}

async function main() {
  fs.mkdirSync(OUT, {recursive: true});
  const executable = executablePath();
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(executable ? {executablePath: executable} : {})});
  try {
    const probe = await signedIn(browser, {width: 1440, height: 900});
    const config = await (await probe.request.get(BASE + 'api/config')).json();
    console.log(`config.admin = ${config?.admin === true}`);
    const read = async <T,>(url: string): Promise<T> => {
      const response = await probe.request.get(BASE + 'api' + url);
      if (!response.ok()) throw new Error(`${url}: HTTP ${response.status()}`);
      return response.json() as Promise<T>;
    };
    const overview = await read<AdminOverview>('/admin/overview?period=30d');
    const usage = await read<AdminUsage>('/admin/usage?period=30d');
    console.log(`active 30d ${overview.kpis.activeAccounts.value} · accounts ${overview.kpis.accounts.value}`);
    console.log(`day points: overview ${overview.series.signups.length} · usage ${usage.product.filesCreated.length} · alerts ${JSON.stringify(overview.alerts)}`);
    const listed = await read<AdminAccountsPage>('/admin/accounts?sort=created&order=desc');
    const sample = listed.rows[0]?.id;
    const support = await probe.request.get(BASE + 'api/admin/support/unread');
    console.log(`support API: HTTP ${support.status()}`);
    await probe.close();

    const screens: Array<{name: string; hash: string; ready: string; fill?: boolean}> = [
      {name: 'overview', hash: '#admin', ready: '.mfa-kpi-value'},
      {name: 'overview-365d', hash: '#admin?period=365d', ready: '.mfa-kpi-value'},
      {name: 'accounts', hash: '#admin/accounts', ready: '.mfa-table tbody tr:not(.is-skeleton)'},
      ...(sample ? [{name: 'account', hash: `#admin/accounts/${encodeURIComponent(sample)}`, ready: '.mfa-head h1'}] : []),
      {name: 'usage', hash: '#admin/usage', ready: '.mfa-kpi-value'},
      {name: 'support', hash: '#admin/support', ready: '.mfa-inbox, .mfa-failure', fill: true},
    ];
    for (const screen of screens) {
      for (const [viewport, suffix, full] of [
        [{width: 1440, height: 900}, '', true],
        [{width: 390, height: 844}, '-390', false],
        [{width: 390, height: 844}, '-390-full', true],
      ] as const) {
        if (screen.fill && suffix === '-390-full') continue;
        const context = await signedIn(browser, viewport);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(BASE + screen.hash);
        await settle(page, screen.ready);
        if (full && !screen.fill) await fullLength(page, viewport.width, viewport.height);
        const file = path.join(OUT, `live-${screen.name}${suffix}.png`);
        await page.screenshot({path: file});
        const overflow = await page.evaluate(() => {
          const work = document.querySelector('.mfa-work') as HTMLElement | null;
          return work ? work.scrollWidth - work.clientWidth : 0;
        });
        if (overflow > 0) errors.push(`horizontal overflow ${overflow}px`);
        console.log(`${errors.length ? '!' : '✓'} ${path.relative(process.cwd(), file)}${errors.length ? ' — ' + errors.join('; ') : ''}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

await main();
