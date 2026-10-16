// The exact Canvas2D pixel test: this tree's painter and scene renderer against the reference
// commit's (scripts/canvas-exact/REF), byte for byte, on every fixture of scripts/goldens/fixtures.ts plus a text-heavy
// page, and the scene renderer's picture after each edit against a fresh one (harness.ts says what is compared).
//
//   npx tsx scripts/canvas-exact/run.ts                  everything (exit 1 on any differing pixel)
//   npx tsx scripts/canvas-exact/run.ts --only effects   fixtures whose name starts with this
//   npx tsx scripts/canvas-exact/run.ts --ref <rev>      another reference (default: the commit in REF)
//   npx tsx scripts/canvas-exact/run.ts --no-ref         only the fresh comparison (no checkout needed)
//   npx tsx scripts/canvas-exact/run.ts --sweep          every view of the zoom × DPR sweep (slow; with --only)
//
// The reference is `git archive <rev> src shared` unpacked into ~/.cache/morfa-canvas-exact/<rev> with this tree's
// node_modules linked in, served by the same bare Vite server under /@fs. Chromium: Playwright's, or PLAYWRIGHT_CHROMIUM.
// A change that means to change the picture moves REF to the commit that makes it, in the same commit.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {chromium, type Page} from 'playwright-core';
import {createServer} from 'vite';
import {writeEffectsPhoto} from '../goldens/render';
import type {Diff, SceneStep} from './harness';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Every canvas on the CPU: Chromium moves a GPU canvas to the CPU when it is first read back (the blur reads its
 *  pooled canvases), and the two rasterize gradients and scaled images up to one level apart, so on the GPU path the
 *  same picture depends on which pooled canvas a layer happened to get. On the CPU it is the same byte for byte. */
export const EXACT_ARGS = ['--disable-accelerated-2d-canvas', '--disable-gpu'];
export const REF_FILE = path.join(repo, 'scripts/canvas-exact/REF');

/** The reference tree for `rev`, unpacked once (src and shared are all the painter and the scene renderer import). */
export function referenceTree(rev: string): string {
  const full = execFileSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], {cwd: repo, encoding: 'utf8'}).trim();
  const dir = path.join(process.env.MORFA_CANVAS_EXACT_CACHE || path.join(homedir(), '.cache/morfa-canvas-exact'), full);
  if (!fs.existsSync(path.join(dir, '.complete'))) {
    fs.rmSync(dir, {recursive: true, force: true});
    fs.mkdirSync(dir, {recursive: true});
    const archive = execFileSync('git', ['archive', '--format=tar', full, 'src', 'shared', 'tests/helpers'], {cwd: repo, maxBuffer: 1 << 30});
    execFileSync('tar', ['-x', '-C', dir], {input: archive});
    // Build outputs the reference's modules may import (the wasm glue is gitignored): this tree's.
    for (const generated of ['src/design/wasm', 'server/design/wasm-render']) {
      const from = path.join(repo, generated), to = path.join(dir, generated);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), {recursive: true});
        fs.symlinkSync(from, to);
      }
    }
    fs.writeFileSync(path.join(dir, '.complete'), full + '\n');
  }
  const modules = path.join(dir, 'node_modules');
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(repo, 'node_modules'), modules);
  return dir;
}

export type ExactServer = {url: string; close(): Promise<void>};

export async function startExactServer(refDir: string | null): Promise<ExactServer> {
  const fontsDir = path.join(repo, 'public', 'fonts');
  if (!fs.existsSync(fontsDir) || !fs.readdirSync(fontsDir).length) throw new Error('public/fonts is empty: run `npm run fonts` first');
  await writeEffectsPhoto(path.join(repo, 'fixtures/goldens/assets'));
  const allow = [repo, fs.realpathSync(path.join(repo, 'node_modules')), ...(refDir ? [refDir] : [])];
  const server = await createServer({
    root: repo,
    configFile: false,
    appType: 'mpa',
    logLevel: 'warn',
    clearScreen: false,
    cacheDir: path.join(repo, '.vite', 'canvas-exact'),
    optimizeDeps: {noDiscovery: true, include: []},
    // No reloads: a file edited while a run is going must not navigate the page away (the run uses what it loaded).
    server: {host: '127.0.0.1', port: 5406, strictPort: false, fs: {allow}, hmr: false, watch: null},
  });
  server.middlewares.use('/fonts', express.static(fontsDir) as never);
  await server.listen();
  return {url: server.resolvedUrls!.local[0].replace(/\/$/, ''), close: () => server.close()};
}

export type ExactReport = {lines: string[]; failures: string[]; compared: number};

/** Runs every comparison in an open harness page. */
export async function runExact(page: Page, only?: string, sweep = false): Promise<ExactReport> {
  const lines: string[] = [], failures: string[] = [];
  let compared = 0;
  const hasReference = await page.evaluate(() => window.exact.hasReference);
  const fixtures = (await page.evaluate(() => window.exact.listFixtures())).filter(f => !only || f.name.startsWith(only));
  const show = (d: Diff) => (d.differing === 0 ? 'equal' : d.differing < 0 ? 'size differs' : `${d.differing} px differ, first at ${d.first}, box ${JSON.stringify(d.box)}`) + (d.unstable ? ` (${d.unstable} px under pictures left out)` : '') + (d.tolerated ? ` (${d.tolerated} px one level apart in a shadow's reach)` : '');
  if (hasReference) {
    for (const fixture of fixtures) for (const pg of fixture.pages) for (const dpr of [1, 2]) {
      const diff = await page.evaluate(({name, id, dpr}) => window.exact.paint(name, id, dpr, 2048), {name: fixture.name, id: pg.id, dpr});
      compared++;
      const line = `paint ${fixture.name}/${pg.id}@${dpr} ${diff.width}×${diff.height}: ${show(diff)}`;
      lines.push(line);
      if (diff.differing !== 0) failures.push(line);
    }
  } else lines.push('paint: no reference tree, skipped');
  // The scene runs: every fixture's first page at the fit view, 1 at DPR 2 and 0.37 at DPR 2, and two views of the sweep
  // (0.189 at DPR 1.25, 0.31 at DPR 1.5); the big pages only at the fit view. `sweep`: every view of the sweep
  // (harness.ts: zooms 0.1–0.5 × DPR 1, 1.25, 1.5).
  const count = await page.evaluate(() => window.exact.viewCount());
  for (const fixture of fixtures) {
    const big = fixture.name === 'heavy-page' || fixture.name === 'product-file';
    const views = process.env.EXACT_VIEWS ? process.env.EXACT_VIEWS.split(',').map(Number) : sweep ? Array.from({length: count}, (_, k) => k) : big ? [0] : [0, 1, 2, 10, 17];
    for (const view of views) {
      const run = await page.evaluate(({name, id, view}) => window.exact.scene(name, id, view), {name: fixture.name, id: fixture.pages[0].id, view});
      for (const step of run.steps as SceneStep[]) {
        compared++;
        const where = `scene ${fixture.name} view ${view} (zoom ${run.view.zoom.toFixed(3)} dpr ${run.view.dpr}) "${step.label}" (${step.changed} changed)`;
        const fresh = show(step.vsFresh), ref = step.vsReference ? show(step.vsReference) : 'no reference';
        // Both verdicts are against paints from nothing made in this run: this tree's own (the repaint is exact) and
        // the reference's (the painter paints what it painted). The reference's own repaint is only reported.
        const mains = step.referenceRepaint && step.referenceRepaint.differing !== 0 ? ` [main's own repaint differs from its fresh paint: ${show(step.referenceRepaint)}]` : '';
        const line = `${where}: vs fresh ${fresh}; vs reference ${ref}${mains}`;
        lines.push(line);
        if (step.vsFresh.differing !== 0 || (step.vsReference && step.vsReference.differing !== 0)) failures.push(line);
        if (step.pictures) {
          const dir = path.join(repo, 'output/canvas-exact', `${fixture.name}-v${view}-${String(compared).padStart(4, '0')}`);
          fs.mkdirSync(dir, {recursive: true});
          for (const [name, url] of Object.entries(step.pictures)) fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
        }
      }
    }
  }
  // A board: the dot grid under the page (its own canvas grid at each zoom), against this tree's fresh paint only (the
  // reference commit has no dots). 0.37, 0.5 and 1 at DPR 1, 1.25 and 2.
  for (const fixture of fixtures.filter(f => f.name === 'effects' || f.name === 'text-heavy')) {
    for (const view of [1, 2, 10, 21, 22]) {
      const run = await page.evaluate(({name, id, view}) => window.exact.scene(name, id, view, true), {name: fixture.name, id: fixture.pages[0].id, view});
      for (const step of run.steps as SceneStep[]) {
        compared++;
        const line = `scene ${fixture.name} on a board, view ${view} (zoom ${run.view.zoom.toFixed(3)} dpr ${run.view.dpr}) "${step.label}" (${step.changed} changed): vs fresh ${show(step.vsFresh)}`;
        lines.push(line);
        if (step.vsFresh.differing !== 0) failures.push(line);
      }
    }
  }
  return {lines, failures, compared};
}

export async function openHarness(page: Page, server: ExactServer, refDir: string | null): Promise<void> {
  const ref = refDir ? `/@fs${refDir}` : '';
  const query = new URLSearchParams();
  if (ref) query.set('ref', ref);
  if (process.argv.includes('--dump')) query.set('dump', '1');
  // The scenes' edits in this table mode (copy | in-place).
  if (process.env.MORFA_TABLE) query.set('table', process.env.MORFA_TABLE);
  await page.goto(`${server.url}/scripts/canvas-exact/harness.html?${query}`);
  await page.locator('#out[data-state="ready"]').waitFor({timeout: 120_000});
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const rev = argv.includes('--no-ref') ? null : value('--ref') ?? fs.readFileSync(REF_FILE, 'utf8').trim();
  const refDir = rev ? referenceTree(rev) : null;
  const server = await startExactServer(refDir);
  const browser = await chromium.launch({executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: EXACT_ARGS});
  const problems: string[] = [];
  let report: ExactReport | null = null;
  try {
    const page = await browser.newPage({viewport: {width: 900, height: 700}, deviceScaleFactor: 1});
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    page.on('console', message => message.type() === 'error' && problems.push(`console error: ${message.text()}`));
    await openHarness(page, server, refDir);
    console.log(`canvas-exact: reference ${rev ?? 'none'}, ${browser.browserType().name()} ${browser.version()}`);
    report = await runExact(page, value('--only'), argv.includes('--sweep'));
    for (const line of report.lines) console.log(line);
  } finally {
    await browser.close();
    await server.close();
  }
  for (const problem of problems) console.error(`canvas-exact: ${problem}`);
  console.log(`canvas-exact: ${report.compared} pictures compared, ${report.failures.length} differ`);
  if (report.failures.length || problems.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
