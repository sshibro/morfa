// Runs scripts/text-engine/harness.ts in headless Chromium and writes output/L3/{t3,t4,perf}.md, the raw
// JSON and the ten screens' before/after PNGs. A bare Vite dev server (vite.config.ts not loaded) serves
// the repository root on MORFA_HARNESS_PORT (default 5403, lane L3's app port). Run scripts/wasm-build.sh
// and scripts/copy-fonts.ts first. Usage: node scripts/text-engine/run-harness.mjs [--no-screens] [--no-perf]
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createServer} from 'vite';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.join(root, 'output/L3');
mkdirSync(path.join(out, 'screens'), {recursive: true});
const port = Number(process.env.MORFA_HARNESS_PORT || 5403);
const options = {screens: !process.argv.includes('--no-screens'), perf: !process.argv.includes('--no-perf')};

const server = await createServer({configFile: false, root, server: {port, strictPort: true, host: '127.0.0.1', fs: {allow: [root]}}, logLevel: 'warn', cacheDir: path.join(root, '.vite/harness')});
await server.listen();
const browser = await chromium.launch({headless: true});
const page = await browser.newPage({viewport: {width: 1200, height: 800}, deviceScaleFactor: 2});
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/scripts/text-engine/harness.html`);
  await page.waitForFunction(() => 'harness' in window, null, {timeout: 60_000});
  const started = Date.now();
  const result = await page.evaluate(options => window.harness.run(options), options);
  console.log(`harness ran in ${((Date.now() - started) / 1000).toFixed(1)} s; page errors: ${errors.length}`);
  for (const error of errors.slice(0, 10)) console.log('  ', error);

  const t3 = result.t3;
  const t3Lines = [
    `# T3 — metrics vs today's renderer (Chrome measureText + TypeScript layout vs crates/text with harfrust)`,
    '',
    `Faces in the store: ${result.faces}. Text nodes: ${t3.nodes} (${t3.lines} lines) over the template catalogue, the board templates, heavyPage() and productFile().`,
    '',
    '| Nodes | Line-count mismatches | Width > max(0.5 px, 1 %) | Height > 0.5 px | Failures | Share |',
    '|---|---|---|---|---|---|',
    `| ${t3.nodes} | ${t3.failures.filter(f => f.reason.startsWith('lines')).length} | ${t3.failures.filter(f => f.reason.startsWith('line ')).length} | ${t3.failures.filter(f => f.reason.startsWith('height')).length} | ${t3.failures.length} | ${((100 * t3.failures.length) / t3.nodes).toFixed(2)} % |`,
    '',
    '## Failures by node',
    '',
    '| Document | Node | Name | Text | Reason |',
    '|---|---|---|---|---|',
    ...t3.failures.map(f => `| ${f.doc} | ${f.id} | ${f.name} | ${JSON.stringify(f.text)} | ${f.reason} |`),
  ];
  writeFileSync(path.join(out, 't3.md'), t3Lines.join('\n') + '\n');

  if (result.perfHeavy) {
    const perf = ['# Perf — layout', '', '| Set | Nodes | TS + measureText, cold (ms) | wasm one call per text, cold (ms) | wasm batched (layoutTextMany), cold (ms) | TS warm widths (ms) | wasm per text, warm (ms) | wasm batched, warm (ms) |', '|---|---|---|---|---|---|---|---|'];
    for (const [name, p] of [['heavyPage()', result.perfHeavy], ['productFile()', result.perfProduct], ['templates + board', result.perfTemplates]]) {
      perf.push(`| ${name} | ${p.nodes} | ${p.ts.toFixed(1)} | ${p.wasm.toFixed(1)} | ${p.batched.toFixed(1)} | ${p.tsWarm.toFixed(1)} | ${p.wasmWarm.toFixed(1)} | ${p.batchedWarm.toFixed(1)} |`);
    }
    if (result.perfFrames) {
      perf.push('', '# Perf — glyph drawing (paintNodeTree of a screen at DPR 2, best of 6, warm caches)', '', '| Screen | fillText (ms) | outlines (ms) | ratio |', '|---|---|---|---|');
      for (const f of result.perfFrames) perf.push(`| ${f.name} | ${f.canvasMs.toFixed(1)} | ${f.outlineMs.toFixed(1)} | ${f.ratio.toFixed(2)}× |`);
    }
    writeFileSync(path.join(out, 'perf.md'), perf.join('\n') + '\n');
  }

  if (result.t4) {
    const t4 = result.t4;
    const lines = [
      '# T4 — pixels: fillText goldens vs engine outlines, DPR 2, SSIM per text region',
      '',
      `| Regions | ≥ 0.98 | < 0.98 | Median SSIM | Min SSIM |`,
      '|---|---|---|---|---|',
    ];
    const sorted = t4.regions.map(r => r.ssim).sort((a, b) => a - b);
    lines.push(`| ${t4.regions.length} | ${t4.regions.length - t4.failures.length} | ${t4.failures.length} | ${(sorted[Math.floor(sorted.length / 2)] ?? 1).toFixed(4)} | ${(sorted[0] ?? 1).toFixed(4)} |`);
    lines.push('', '## Screens (whole-frame SSIM)', '', '| Screen | SSIM |', '|---|---|');
    for (const s of t4.screensSsim) lines.push(`| ${s.name} | ${s.ssim.toFixed(4)} |`);
    if (result.t4Variants) {
      lines.push('', '## Small text as sprites with a coverage curve (same regions)', '', '| Variant | < 0.98 | Median | Min |', '|---|---|---|---|');
      lines.push(`| outlines, plain path fill | ${t4.failures.length} | ${(sorted[Math.floor(sorted.length / 2)] ?? 1).toFixed(4)} | ${(sorted[0] ?? 1).toFixed(4)} |`);
      for (const [name, v] of Object.entries(result.t4Variants)) lines.push(`| ${name} | ${v.under} | ${v.median.toFixed(4)} | ${v.min.toFixed(4)} |`);
    }
    lines.push('', '## Regions under 0.98', '', '| Screen | Node | Name | SSIM | px |', '|---|---|---|---|---|');
    for (const r of t4.failures.sort((a, b) => a.ssim - b.ssim).slice(0, 60)) lines.push(`| ${r.screen} | ${r.id} | ${r.name} | ${r.ssim.toFixed(4)} | ${r.px} |`);
    writeFileSync(path.join(out, 't4.md'), lines.join('\n') + '\n');
    const safe = name => name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    for (const png of t4.pngs) {
      writeFileSync(path.join(out, 'screens', `${safe(png.name)}-before.png`), Buffer.from(png.before.split(',')[1], 'base64'));
      writeFileSync(path.join(out, 'screens', `${safe(png.name)}-after.png`), Buffer.from(png.after.split(',')[1], 'base64'));
    }
    delete t4.pngs;
    mkdirSync(path.join(out, 't4-crops'), {recursive: true});
    for (const r of t4.failures.filter(r => r.crop).sort((a, b) => a.ssim - b.ssim)) {
      writeFileSync(path.join(out, 't4-crops', `${safe(r.screen)}-${r.id}-${r.ssim.toFixed(3)}.png`), Buffer.from(r.crop.split(',')[1], 'base64'));
    }
    for (const r of t4.regions) delete r.crop;
  }
  writeFileSync(path.join(out, 'harness.json'), JSON.stringify(result, null, 1));
  console.log(`T3 failures ${t3.failures.length}/${t3.nodes}`, result.t4 ? `T4 regions under 0.98: ${result.t4.failures.length}/${result.t4.regions.length}` : '', JSON.stringify(result.stats));
} finally {
  await browser.close();
  await server.close();
}
