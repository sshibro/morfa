import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defineConfig} from '@playwright/test';

// Passed only to our test server process and the specs (tests/e2e/fixtures.ts); never to the application bundle.
process.env.MORFA_E2E_RUN_KEY ||= randomBytes(24).toString('hex');
// App 4400, API 4401 by default: apart from `npm run dev` (5400/3400), so a run never meets a dev server (docs/dev.md).
const port = Number(process.env.E2E_PORT || 4400);
const apiPort = Number(process.env.E2E_API_PORT || 4401);
const output = process.env.E2E_OUTPUT_DIR || path.join(tmpdir(), 'morfa-playwright-results');
const TEST_TIMEOUT_MS = 45_000;
const EXPECT_TIMEOUT_MS = 10_000;

export default defineConfig({
  testDir: './tests/e2e',
  // Morfa's browser suite is the design tool's: tests/e2e/design-*.spec.ts.
  testMatch: 'design-*.spec.ts',
  timeout: TEST_TIMEOUT_MS,
  expect: {timeout: EXPECT_TIMEOUT_MS},
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: a spec that passes only on a second attempt is a failure here.
  retries: 0,
  workers: Number(process.env.E2E_WORKERS || 1),
  reporter: [['list'], ['html', {outputFolder: path.join(output, 'report'), open: 'never'}], ['json', {outputFile: path.join(output, 'results.json')}]],
  outputDir: path.join(output, 'artifacts'),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Chromium only: the design tool's suite was verified on it, and it is the browser installed on the development machine.
    browserName: 'chromium',
    viewport: {width: 1440, height: 900},
    locale: 'en-US',
    timezoneId: 'Europe/Moscow',
    // Playwright's blocker reads navigator.serviceWorker in opaque preview frames,
    // creating a SecurityError even though this application registers no worker.
    serviceWorkers: 'allow',
    // Snapshot tracing injects script into every frame and logs a sandbox error even for sandboxed srcdoc frames.
    // Retain screenshots, sources and action traces while keeping the runtime-error check strict.
    trace: {mode: 'retain-on-failure', snapshots: false, screenshots: true, sources: true},
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM} : {},
  },
  webServer: {
    command: 'node --import tsx scripts/e2e-server.ts',
    url: `http://127.0.0.1:${port}/__e2e/ready`,
    reuseExistingServer: false,
    // The server answers /__e2e/ready after it has walked the editor's module graph (scripts/e2e-warmup.ts).
    timeout: 180_000,
    gracefulShutdown: {signal: 'SIGTERM', timeout: 5000},
    // Added to this process's environment (the PostgreSQL test-cluster keys come through from there).
    env: {E2E_PORT: String(port), E2E_API_PORT: String(apiPort), MORFA_E2E_RUN_KEY: process.env.MORFA_E2E_RUN_KEY},
  },
});
