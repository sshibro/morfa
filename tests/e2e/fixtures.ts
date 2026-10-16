import {test as base, expect, type FileChooser, type Locator, type Page} from '@playwright/test';

export type Seed = {accountId: string; token: string; email: string; password: string; projectId: string; secondProjectId: string; projectName: string};
/** What the test's account is created with (scripts/e2e-server.ts reads these); set with `test.use({seedOptions: {…}})`. */
export type SeedOptions = {
  assistant?: boolean;
};
export const test = base.extend<{seed: Seed; seedOptions: SeedOptions; healthyPage: void}>({
  seedOptions: [{}, {option: true}],
  seed: async ({request, context, baseURL, seedOptions}, use) => {
    const response = await request.post('/__e2e/fixtures', {headers: {'x-e2e-run-key': process.env.MORFA_E2E_RUN_KEY!}, data: seedOptions});
    expect(response.ok(), 'Isolated fixture creation').toBeTruthy();
    const seed = await response.json() as Seed;
    await context.addCookies([{name: 'forma_session', value: seed.token, url: baseURL!, httpOnly: true, sameSite: 'Lax'}]);
    await use(seed);
    // Each test owns a new account/session/projects. The server removes its entire
    // temporary data directory at shutdown; no production account is ever reused.
  },
  healthyPage: [async ({page, baseURL, browserName}, use, testInfo) => {
    const errors: string[] = [];
    const cancellations: Array<{url:string; error:string|undefined; at:number}> = [];
    const childTransitions: Array<{kind:'navigation'|'detach';url:string;at:number}> = [];
    const fontAborts: Array<{message:string;url:string;at:number}> = [];
    const thumbnailAborts: Array<{message:string;url:string;at:number}> = [];
    const originHost = new URL(baseURL!).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const thumbnailAbortPattern = new RegExp(`^(?:https?:)?/{0,2}${originHost}(/api/projects/[^/\\s?]+/thumbnail(?:\\?\\S*)?) due to access control checks\\.?$`);
    page.on('framenavigated', frame => {if(frame !== page.mainFrame()) childTransitions.push({kind:'navigation',url:frame.url(),at:Date.now()});});
    page.on('framedetached', frame => childTransitions.push({kind:'detach',url:frame.url(),at:Date.now()}));
    page.on('requestfailed', request => cancellations.push({url:request.url(),error:request.failure()?.errorText,at:Date.now()}));
    page.on('pageerror', error => errors.push(error.message));
    // MORFA_E2E_ENGINE (lane E1): the editor's engine for the run, as `?engine=` takes it (`geometry:both`, `both`):
    // in `both` every wasm call is compared in the browser and a difference throws (a page error, so the test fails).
    if (process.env.MORFA_E2E_ENGINE)
      await page.addInitScript(engine => void ((globalThis as {__MORFA_ENGINE__?: string}).__MORFA_ENGINE__ = engine), process.env.MORFA_E2E_ENGINE);
    // MORFA_E2E_TABLE (lane N1 step 14): the store's table mode for the run, as `?table=` takes it (`in-place`): the
    // editor commits into its document's own node table instead of a copy.
    if (process.env.MORFA_E2E_TABLE)
      await page.addInitScript(table => void ((globalThis as {__MORFA_TABLE__?: string}).__MORFA_TABLE__ = table), process.env.MORFA_E2E_TABLE);
    // The app page reports its target Content-Security-Policy (server/web/app-csp.ts) and srcdoc
    // previews inherit it: any violation, reported or enforced, in any frame that runs script fails.
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event =>
      console.error(`CSP ${event.disposition} violation: ${event.effectiveDirective} blocked ${event.blockedURI || 'inline'} in ${event.documentURI.split(/[?#]/)[0]}`)));
    page.on('console', message => {
      if (message.type() !== 'error' || message.text().startsWith('Failed to load resource:')) return;
      const text = message.text();
      // Firefox reports NS_BINDING_ABORTED as a font error when an iframe is
      // replaced mid-load. The standalone repro and exact messages are retained
      // in output/ux-remediation-2026-09-08/font-cancellation. No other errors match.
      const abort = browserName === 'firefox' && /downloadable font: download failed .*status=2152398850 source: (https?:\/\/[^\s"\]]+)/.exec(text);
      const url = abort ? new URL(abort[1]) : null;
      // WebKit reports a same-origin project-thumbnail fetch cancelled by a page
      // reload/navigation this way instead of a clean abort; SavedSitePreview.tsx
      // already catches that rejection locally. Narrowed to exactly that endpoint,
      // this origin, this browser; every other console error still fails the test.
      const thumbnail = browserName === 'webkit' && thumbnailAbortPattern.exec(text);
      if (url && url.origin === baseURL && /^\/fonts\/.+\.woff2?$/.test(url.pathname)) fontAborts.push({message:text,url:url.href,at:Date.now()});
      else if (thumbnail) thumbnailAborts.push({message:text,url:baseURL+thumbnail[1],at:Date.now()});
      else errors.push(text);
    });
    page.on('response', response => {
      if (response.url().startsWith(baseURL!) && response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) {
        errors.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== baseURL) {
        errors.push('Unexpected external browser request: ' + url.origin + url.pathname);
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await use();
    if (fontAborts.length) {
      const diagnostic = fontAborts.map(abort => ({...abort, transitions:childTransitions.filter(event => Math.abs(event.at-abort.at) <= 500)}));
      for (const abort of diagnostic) if (!abort.transitions.length) errors.push(abort.message);
      await testInfo.attach('firefox-font-cancellation-diagnostics', {body:JSON.stringify({knownAborts:diagnostic.filter(abort=>abort.transitions.length).length,events:diagnostic},null,2),contentType:'application/json'});
      testInfo.annotations.push({type:'browser-diagnostic',description:`${diagnostic.filter(abort=>abort.transitions.length).length} verified Firefox font cancellations during child-frame replacement; exact diagnostics attached.`});
    }
    if (thumbnailAborts.length) {
      await testInfo.attach('webkit-thumbnail-cancellation-diagnostics', {body:JSON.stringify(thumbnailAborts,null,2),contentType:'application/json'});
      testInfo.annotations.push({type:'browser-diagnostic',description:`${thumbnailAborts.length} WebKit project-thumbnail fetch(es) cancelled by navigation; SavedSitePreview.tsx already handles the rejection.`});
    }
    if (errors.length) await testInfo.attach('runtime-errors', {body: errors.join('\n'), contentType: 'text/plain'});
    if (cancellations.length) await testInfo.attach('request-failures', {body:JSON.stringify(cancellations,null,2),contentType:'application/json'});
    expect(errors, 'No unexpected runtime errors, external calls, or missing first-party assets').toEqual([]);
  }, {auto: true}],
});
export {expect};

/** The file dialog `open` brings up. `page.waitForEvent('filechooser')` alone races: Playwright turns the browser's
 *  dialog interception on with a message it does not wait for (playwright-core 1.63 `_updateSubscription`), its
 *  server runs calls side by side, and now and then the key press or click reached Chromium first — headless Chromium
 *  then cancels the dialog nobody intercepts and the wait times out (about 1 in 100 on a bare page, more under load).
 *  Here the interception is on, and the browser has said so, before `open` runs. */
export async function fileChooser(page: Page, open: () => Promise<unknown>): Promise<FileChooser> {
  const channel = (page as unknown as {_channel?: {updateSubscription?(params: {event: string; enabled: boolean}): Promise<unknown>}})._channel;
  if (typeof channel?.updateSubscription !== 'function') throw new Error('fileChooser: this Playwright has no page._channel.updateSubscription (tests/e2e/fixtures.ts)');
  await channel.updateSubscription({event: 'fileChooser', enabled: true});
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open()]);
  return chooser;
}

/** The open design file or board is ready: the editor takes keys, co-editing is live and the meeting has its state on screen
 *  (`data-design-ready` on <html>, src/design/editor/readiness.ts). "Saved" alone shows a frame after the editor does,
 *  before co-editing (/collab, /events) and the meeting (/meeting) mount; under load they then land inside the test's next
 *  gesture. Pass the file id to wait for that file; without it, whichever file the page has open. */
export async function waitEditorReady(page: Page, fileId?: string, options: {timeout?: number} = {}) {
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-design-ready', fileId ?? /./, options);
}

export async function expectFocusWithin(container: Locator) {
  await expect.poll(() => container.evaluate(element => element.contains(document.activeElement))).toBe(true);
}
