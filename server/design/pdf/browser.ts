import {chromium, type Browser, type BrowserContext, type Route} from 'playwright-core';

// The vector PDF's printer (docs/design-tool.md §Export): Chromium's headless shell, sandboxed like the site
// importer's browser (the same launch, the same seccomp profile in production),
// printing a page the server wrote itself from the stored document. Nothing on that page comes from the
// network: JavaScript is off, the proxy is a dead address and every host resolves to nothing, and each request
// the page makes is answered by `serve` (the document, catalogue fonts, the caller's own pictures) or refused.
// No session, cookie or file of the app ever reaches the browser.
//
// One browser serves every export (launching costs about half a second) with a fresh context per job; it is
// closed after 20 jobs, after a minute without work, and at once after a job that failed or ran out of time.

/** The page's origin. `.invalid` never resolves anywhere; requests to it are answered by `serve` alone. */
export const PDF_ORIGIN = 'https://pdf.morfa.invalid';

export class PdfBrowserUnavailable extends Error {
  constructor(cause: unknown) {
    super('PDF renderer did not start', {cause});
    this.name = 'PdfBrowserUnavailable';
  }
}
export class PdfRenderTimeout extends Error {
  constructor() {
    super('PDF rendering ran out of time');
    this.name = 'PdfRenderTimeout';
  }
}

export type PdfAnswer = {type: string; body: Buffer | string} | null;
export type PdfJob = {
  /** Answers a GET for `path` (below PDF_ORIGIN, starting with "/"); null refuses it. "/" is the document. */
  serve(path: string): Promise<PdfAnswer>;
  /** The whole job, from opening the page to the last byte of the PDF. */
  timeoutMs: number;
  /** Paper big enough for every page (CSS sizes them; larger paper keeps Chromium from splitting a tall page). */
  paper: {width: string; height: string};
};

const MAX_JOBS_PER_BROWSER = 20;
const IDLE_MS = 60_000;

type Shared = {browser: Promise<Browser>; jobs: number; active: number; retired: boolean; idle: ReturnType<typeof setTimeout> | null};
let shared: Shared | null = null;

function launch(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    chromiumSandbox: true,
    timeout: 15_000,
    ...(process.env.IMPORT_CHROMIUM_PATH ? {executablePath: process.env.IMPORT_CHROMIUM_PATH} : {}),
    proxy: {server: 'http://127.0.0.1:9', bypass: '<-loopback>'},
    args: [
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-quic',
      // The app container keeps Docker's 64 MB /dev/shm: large pages would crash the renderer there.
      '--disable-dev-shm-usage',
    ],
  });
}

function retire(entry: Shared) {
  entry.retired = true;
  if (shared === entry) shared = null;
  if (entry.idle) clearTimeout(entry.idle);
  if (!entry.active) void entry.browser.then(browser => browser.close()).catch(() => {});
}

function take(): Shared {
  if (shared && !shared.retired && shared.jobs < MAX_JOBS_PER_BROWSER) {
    if (shared.idle) clearTimeout(shared.idle);
    shared.idle = null;
    return shared;
  }
  if (shared) retire(shared);
  const entry: Shared = {browser: launch(), jobs: 0, active: 0, retired: false, idle: null};
  entry.browser.catch(() => retire(entry));
  shared = entry;
  return entry;
}

function release(entry: Shared, failed: boolean) {
  entry.active--;
  if (failed || entry.jobs >= MAX_JOBS_PER_BROWSER) retire(entry);
  else if (entry.retired) {
    if (!entry.active) void entry.browser.then(browser => browser.close()).catch(() => {});
  } else if (!entry.active) {
    entry.idle = setTimeout(() => retire(entry), IDLE_MS);
    entry.idle.unref?.();
  }
}

/** Closes the shared browser (tests, shutdown). */
export async function closePdfBrowser(): Promise<void> {
  const entry = shared;
  shared = null;
  if (!entry) return;
  entry.retired = true;
  if (entry.idle) clearTimeout(entry.idle);
  await entry.browser.then(browser => browser.close()).catch(() => {});
}

async function answer(route: Route, job: PdfJob, closed: () => boolean) {
  const request = route.request();
  const url = request.url();
  if (closed() || request.method() !== 'GET' || !url.startsWith(PDF_ORIGIN + '/')) return route.abort('blockedbyclient');
  const path = url.slice(PDF_ORIGIN.length);
  if (request.isNavigationRequest() && (path !== '/' || request.frame().parentFrame())) return route.abort('blockedbyclient');
  const reply = await job.serve(path).catch(() => null);
  if (!reply || closed()) return route.abort('blockedbyclient');
  return route.fulfill({status: 200, contentType: reply.type, body: reply.body, headers: {'cache-control': 'no-store'}});
}

/** Prints the job's document to a PDF. */
export async function printPdf(job: PdfJob): Promise<Buffer> {
  const entry = take();
  entry.jobs++;
  entry.active++;
  let failed = true;
  let context: BrowserContext | null = null;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const browser = await entry.browser.catch(cause => {
      throw new PdfBrowserUnavailable(cause);
    });
    const work = (async () => {
      context = await browser.newContext({javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false, permissions: [], bypassCSP: false, viewport: {width: 1280, height: 800}});
      await context.routeWebSocket(/.*/, socket => socket.close());
      await context.route('**/*', route => answer(route, job, () => done));
      const page = await context.newPage();
      context.on('page', popup => {
        if (popup !== page) void popup.close();
      });
      await page.goto(PDF_ORIGIN + '/', {waitUntil: 'load', timeout: job.timeoutMs});
      // The DevTools protocol evaluates even with the page's scripts off: wait for every face the text uses.
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      return page.pdf({preferCSSPageSize: true, printBackground: true, width: job.paper.width, height: job.paper.height, margin: {top: '0', right: '0', bottom: '0', left: '0'}});
    })();
    work.catch(() => {});
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PdfRenderTimeout()), job.timeoutMs);
    });
    const pdf = await Promise.race([work, deadline]);
    failed = false;
    return pdf;
  } catch (error) {
    // Out of time: the browser is closed now, which ends the print it is stuck in (other jobs on it fail too
    // and are answered as retryable). Any other failure retires it once its jobs are done.
    if (error instanceof PdfRenderTimeout) {
      entry.retired = true;
      if (shared === entry) shared = null;
      void entry.browser.then(browser => browser.close()).catch(() => {});
    }
    throw error;
  } finally {
    done = true;
    if (timer) clearTimeout(timer);
    const open = context as BrowserContext | null;
    // A context stuck in a print may not close: the browser is retired above, so wait for it at most two seconds.
    if (open) {
      let wait: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([open.close().catch(() => {}), new Promise<void>(resolve => {
        wait = setTimeout(resolve, 2_000);
      })]);
      clearTimeout(wait);
    }
    release(entry, failed);
  }
}
