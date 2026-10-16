// The server's rasters against the editor's own (the raster pass): for frames of the
// goldens fixtures, the editor's `exportRaster` in headless Chromium (scripts/goldens/harness.ts `exportFrame`, with the
// page's text and effect masks) and the render service's PNG of the same layer (`morfa-render job`, vello_cpu
// with the catalogue faces), scored by scripts/goldens/ssim.ts: outside text and effects ≥ 0.995, inside effects ≥ 0.98
// (the renderer's bars), and the text region with its own bar of 0.75: the glyphs sit where the browser's sit (the same
// layout, the text engine's), but Chrome's font engine and vello_cpu on skrifa outlines antialias them differently (the
// service's stems come out a little heavier, small sizes most), and SSIM reads that as 0.78–0.99 — the number says how
// close, the layout is checked by eye in output/L4/raster-diff.
//
//   npx tsx scripts/render/raster-diff.ts                       every frame below at scale 1 and 2
//   npx tsx scripts/render/raster-diff.ts --only template-site --scale 2 --text-bar 0.95
//
// Needs public/fonts (npm run fonts), the morfa-render binary (cargo build -p morfa-render-service; MORFA_RENDER_BIN names
// one) and Chromium (MORFA_GOLDENS_CHROMIUM in the cloud). Writes output/L4/raster-diff/<fixture>/<id>@<scale>.{browser,service}.png
// and raster-diff.json; exit 1 under a bar.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import type {FrameExportResult} from '../goldens/harness';
import {FIXTURES, EFFECTS_IMAGE_URL, fixtureByName} from '../goldens/fixtures';
import {startHarnessServer, writeEffectsPhoto} from '../goldens/render';
import {compareFiles, judge, type SsimReport} from '../goldens/ssim';
import {rasterRequest} from './fixtures';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Args = {only?: string; scales: number[]; out: string; textBar: number; perFixture: number};
function parseArgs(argv: string[]): Args {
  const args: Args = {scales: [1, 2], out: path.join(repo, 'output', 'L4', 'raster-diff'), textBar: 0.75, perFixture: 2};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => inline ?? argv[++i];
    if (flag === '--only') args.only = value();
    else if (flag === '--scale') args.scales = value().split(',').map(Number);
    else if (flag === '--out') args.out = path.resolve(value());
    else if (flag === '--text-bar') args.textBar = Number(value());
    else if (flag === '--per-fixture') args.perFixture = Number(value());
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

/** MORFA_RENDER_BIN, or the newest morfa-render cargo built. */
function serviceBinary(): string {
  const targets = [process.env.CARGO_TARGET_DIR, path.resolve('target'), path.join(os.homedir(), '.cache/morfa-target/gate')].filter((dir): dir is string => !!dir);
  const found = (process.env.MORFA_RENDER_BIN ? [process.env.MORFA_RENDER_BIN] : targets.flatMap(dir => ['service', 'release', 'debug'].map(profile => path.join(dir, profile, 'morfa-render'))))
    .filter(file => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!found) throw new Error('no morfa-render binary: cargo build -p morfa-render-service, or MORFA_RENDER_BIN');
  return found;
}

export type RasterDiffRow = {fixture: string; id: string; name: string; scale: number; width: number; height: number; browserMs: number; serviceMs: number; report: SsimReport; ok: boolean; failures: string[]};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const binary = serviceBinary();
  const photoDir = path.join(repo, 'fixtures', 'goldens', 'assets');
  await writeEffectsPhoto(photoDir);
  const photo = fs.readFileSync(path.join(photoDir, 'photo.png'));
  const server = await startHarnessServer();
  const executablePath = process.env.MORFA_GOLDENS_CHROMIUM || undefined;
  const browser = await chromium.launch({executablePath});
  const rows: RasterDiffRow[] = [];
  const problems: string[] = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'raster-diff-'));
  try {
    const page = await browser.newPage({viewport: {width: 1200, height: 800}, deviceScaleFactor: 1});
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    await page.goto(`${server.url}/scripts/goldens/harness.html`);
    await page.locator('#out[data-state="ready"]').waitFor({timeout: 30_000});
    await page.evaluate(() => window.goldens.fontsIdle());
    console.log(['fixture', 'layer', 'scale', 'size', 'browser ms', 'service ms', 'outside', 'effect', 'text', 'verdict'].join('\t'));
    for (const fixture of FIXTURES) {
      if (args.only && !fixture.name.startsWith(args.only)) continue;
      const doc = fixture.build();
      // The first frame-like layers of the first page: what a designer exports.
      const ids = (doc.nodes[doc.pages[0]].children ?? []).filter(id => ['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET'].includes(doc.nodes[id].type)).slice(0, args.perFixture);
      for (const id of ids) {
        for (const scale of args.scales) {
          const dir = path.join(args.out, fixture.name);
          fs.mkdirSync(dir, {recursive: true});
          const stem = path.join(dir, `${id}@${scale}`);
          const result: FrameExportResult = await page.evaluate(({name, id, scale}) => window.goldens.exportFrame(name, id, scale), {name: fixture.name, id, scale});
          fs.writeFileSync(`${stem}.browser.png`, Buffer.from(result.png, 'base64'));
          fs.writeFileSync(`${stem}.text.png`, Buffer.from(result.textMask, 'base64'));
          fs.writeFileSync(`${stem}.effect.png`, Buffer.from(result.effectMask, 'base64'));
          // The same layer through the service: the fixture's one picture goes along where it has one.
          const hasPhoto = Object.values(doc.images).some(asset => asset?.url === EFFECTS_IMAGE_URL);
          const request = rasterRequest(doc, [id], {kind: 'png', scale, bytes: hasPhoto ? [photo] : [], hrefs: hasPhoto ? [EFFECTS_IMAGE_URL] : []});
          const requestFile = path.join(work, `${fixture.name}-${id}@${scale}.mrr`);
          fs.writeFileSync(requestFile, request);
          const started = performance.now();
          const log = execFileSync(binary, ['job', requestFile, `${stem}.service.png`], {env: {...process.env, MORFA_RENDER_FONTS_DIR: path.join(repo, 'public', 'fonts')}, maxBuffer: 1 << 24}).toString();
          const serviceMs = Number(/run 0: ([\d.]+) ms/.exec(log)?.[1] ?? performance.now() - started);
          const report = await compareFiles(`${stem}.browser.png`, `${stem}.service.png`, {text: `${stem}.text.png`, effect: `${stem}.effect.png`});
          const verdict = judge(report);
          const failures = [...verdict.failures];
          if (report.text.windows && report.text.ssim < args.textBar) failures.push(`text ${report.text.ssim.toFixed(4)} < ${args.textBar}`);
          const ok = failures.length === 0;
          rows.push({fixture: fixture.name, id, name: doc.nodes[id].name, scale, width: result.width, height: result.height, browserMs: result.paintMs, serviceMs, report, ok, failures});
          console.log([fixture.name, id, scale, `${result.width}×${result.height}`, result.paintMs.toFixed(0), serviceMs.toFixed(0), report.outside.ssim.toFixed(4), report.effect.windows ? report.effect.ssim.toFixed(4) : '—', report.text.windows ? report.text.ssim.toFixed(4) : '—', ok ? 'ok' : failures.join('; ')].join('\t'));
        }
      }
    }
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(work, {recursive: true, force: true});
    for (const problem of problems) console.error(`raster-diff: ${problem}`);
  }
  fs.mkdirSync(args.out, {recursive: true});
  fs.writeFileSync(path.join(args.out, 'raster-diff.json'), JSON.stringify({generated: new Date().toISOString(), loadavg: os.loadavg(), provisional: true, bars: {outside: 0.995, effects: 0.98, text: args.textBar}, rows}, null, 2) + '\n');
  const failed = rows.filter(r => !r.ok);
  console.log(failed.length ? `under a bar: ${failed.length} of ${rows.length}` : `ok: ${rows.length} of ${rows.length} frames within the bars`);
  if (failed.length || problems.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
