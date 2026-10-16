// The console's way in and out through the app shell (`npx tsx scripts/admin/preview-shell.ts`, Vite on 5480 as for preview.ts):
// a non-operator on #admin lands on the file browser and never loads the console's chunk; an operator's account menu offers "Admin console",
// which opens the console; "To files" goes back. Prints one line per check, saves the open menu to output/admin-preview/, and exits 1
// when a check fails.
import {chromium, type Page} from 'playwright';
import {NOW} from './fixtures';
import {executablePath, intercept} from './preview';

const BASE = 'http://127.0.0.1:5480/';
const executable = executablePath();
const browser = await chromium.launch({headless: true, args: ['--no-sandbox'], ...(executable ? {executablePath: executable} : {})});
let failed = false;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed = true;
};

const calls: string[] = [];

async function open(operator: boolean, hash: string): Promise<{page: Page; adminChunk: () => boolean}> {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  let loaded = false;
  page.on('request', request => {
    if (/\/src\/admin\//.test(request.url())) loaded = true;
    if (request.url().includes('/api/')) calls.push(request.method() + ' ' + new URL(request.url()).pathname);
  });
  page.on('pageerror', error => console.log('  page error:', error.message));
  await page.clock.setFixedTime(new Date(NOW));
  await intercept(page, {operator});
  await page.goto(BASE + hash);
  await page.waitForTimeout(2500);
  return {page, adminChunk: () => loaded};
}

{
  const {page, adminChunk} = await open(false, '#admin/usage');
  check('a non-operator on #admin is sent to the file browser', (await page.evaluate(() => location.hash)) === '#designs', await page.evaluate(() => location.hash));
  check('a non-operator never sees the console', (await page.locator('.mfa').count()) === 0);
  check('a non-operator never loads the console code', !adminChunk());
  await page.close();
}
{
  const {page} = await open(true, '#admin/usage?period=90d');
  check('an operator keeps a console address on load', (await page.evaluate(() => location.hash)) === '#admin/usage?period=90d');
  check('the console shows the asked screen', (await page.locator('.mfa-head h1').textContent()) === 'Usage');
  await page.locator('.mfa-rail-back').click();
  await page.waitForTimeout(1500);
  check('"To files" goes to the file browser', (await page.evaluate(() => location.hash)) === '#designs' && (await page.locator('.mfa').count()) === 0);
  const account = page.locator('.dz-account');
  if (await account.count()) {
    await account.click();
    await page.waitForTimeout(400);
    const item = page.getByRole('menuitem', {name: 'Admin console'});
    check('the account menu offers "Admin console" to an operator', (await item.count()) === 1);
    await page.screenshot({path: 'output/admin-preview/shell-account-menu.png', clip: {x: 0, y: 0, width: 520, height: 420}});
    if (await item.count()) {
      await item.click();
      await page.waitForTimeout(1500);
      check('"Admin console" opens the console', (await page.evaluate(() => location.hash)) === '#admin' && (await page.locator('.mfa').count()) === 1);
    }
  } else {
    check('the file browser rendered its account button', false, 'no .dz-account');
    await page.screenshot({path: 'output/admin-preview/shell-designs.png'});
    console.log([...new Set(calls)].join('\n'));
  }
  await page.goBack();
  await page.waitForTimeout(1200);
  check('back returns to the file browser', (await page.evaluate(() => location.hash)) === '#designs');
  await page.close();
}
await browser.close();
process.exitCode = failed ? 1 : 0;
