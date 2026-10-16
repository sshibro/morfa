// X-rows of docs/TARGETS.md §6: the Rust render service (lane B4: crates/render-service `morfa-render`, crates/export
// behind `POST /internal/render`, no Chromium). BENCH_RENDER_URL=http://host:port and BENCH_RENDER_SECRET (the
// service's MORFA_RENDER_INTERNAL_SECRET) point this bench at a running service; it posts the jobs of
// scripts/render/fixtures.ts (the same bodies `scripts/render/requests.ts` writes for `morfa-render job`):
//   X3  SVG of heavyPage() (f20k seed 0), every top-level layer: p95 of the round trip;
//   X4  productFile's 50 frames (Cyrillic text, 6 pictures, 580 shadows and blurs): p95; fidelity when
//       BENCH_X4_REFERENCE names today's Chromium PDF of the same pages (scripts/render/references.ts): the mean share of
//       differing pixels at 150 dpi (scripts/bench/pdf-diff.ts), the worst page in the notes;
//   X1  the file-card thumbnail (kind thumbnail, 512 px) of heavyPage() (f20k seed 0): wall time of the round trip;
//   X2  the PNG 3840 × 2160 of x2Frame() (a frame of 20 000 layers, drop shadows on): p95 of the round trip;
//   X5  20 X2 jobs posted at once (as many accounts): p95 of one against X2's — ≤ 2× passes.
//   Rasters are lane L4's vello_cpu in the service (crates/render-service src/vello.rs); the service needs
//   MORFA_RENDER_FONTS_DIR (public/fonts) for the text.
//
//   BENCH_RENDER_URL=… BENCH_RENDER_SECRET=… tsx scripts/bench/export.ts [--only X3,X4] [--quick]
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fillNa, runStandalone, wants, type Bench} from './lib/context';
import type {RowResult} from './lib/targets';
import {rasterRequests, xRequests} from '../render/fixtures';

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
};

const run: Bench = async ctx => {
  const service = process.env.BENCH_RENDER_URL?.replace(/\/+$/, '');
  if (!service) return fillNa(ctx, [], 'BENCH_RENDER_URL is not set: start `morfa-render` (crates/render-service) and point the bench at it');
  try {
    const response = await fetch(service + '/healthz');
    if (!response.ok) throw Error(String(response.status));
  } catch (error) {
    return fillNa(ctx, [], `BENCH_RENDER_URL ${service} does not answer (${String((error as Error).message)})`);
  }
  const secret = process.env.BENCH_RENDER_SECRET ?? '';
  // The per-account limit is ten a minute: every request is an account of its own.
  let n = 0;
  const post = async (body: Buffer): Promise<{ms: number; bytes: Buffer}> => {
    const account = `bench-${process.pid}-${n++}`;
    const head = body.readUInt32LE(4);
    const header = JSON.parse(body.subarray(8, 8 + head).toString('utf8'));
    header.account = account;
    const json = Buffer.from(JSON.stringify(header));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(json.length);
    const sent = Buffer.concat([body.subarray(0, 4), length, json, body.subarray(8 + head)]);
    const started = performance.now();
    const response = await fetch(service + '/internal/render', {method: 'POST', headers: {authorization: `Bearer ${secret}`, 'content-type': 'application/octet-stream'}, body: new Uint8Array(sent)});
    const bytes = Buffer.from(await response.arrayBuffer());
    const ms = performance.now() - started;
    if (!response.ok) throw new Error(`render service ${response.status}: ${bytes.toString('utf8').slice(0, 200)}`);
    return {ms, bytes};
  };
  const requests = await xRequests('fixed');
  const results: RowResult[] = [];
  const runs = ctx.quick ? 3 : 10;
  if (wants(ctx, 'X3')) {
    await post(requests.x3);
    const times: number[] = [];
    for (let i = 0; i < runs * 2; i++) times.push((await post(requests.x3)).ms);
    results.push({id: 'X3', values: {p95: percentile(times, 0.95)}, extra: {median: percentile(times, 0.5), runs: times.length}});
    ctx.log(`X3 svg heavyPage: median ${percentile(times, 0.5).toFixed(0)} ms, p95 ${percentile(times, 0.95).toFixed(0)} ms`);
  }
  if (wants(ctx, 'X4')) {
    const first = await post(requests.x4Product);
    const times: number[] = [];
    for (let i = 0; i < runs; i++) times.push((await post(requests.x4Product)).ms);
    const values: Record<string, number> = {p95: percentile(times, 0.95)};
    const notes: string[] = [`productFile, 50 frames, ${(requests.x4Product.length / 1048576).toFixed(1)} MiB request; median ${percentile(times, 0.5).toFixed(0)} ms`];
    const reference = process.env.BENCH_X4_REFERENCE;
    if (reference && fs.existsSync(reference)) {
      const ours = path.join(ctx.outDir, 'x4-product.pdf');
      fs.writeFileSync(ours, first.bytes);
      const report = execFileSync('npx', ['tsx', 'scripts/bench/pdf-diff.ts', ours, reference, '--cache', path.join(ctx.outDir, '..', 'pdf-diff-cache')], {maxBuffer: 1 << 26}).toString();
      fs.writeFileSync(path.join(ctx.outDir, 'x4-fidelity.md'), report);
      const summary = /mean ([\d.]+) %, worst ([\d.]+) % \(page (\d+)\)/.exec(report);
      if (summary) {
        values.fidelity = Number(summary[1]);
        notes.push(`fidelity: mean ${summary[1]} %, worst page ${summary[3]} ${summary[2]} % (pdftoppm, 150 dpi)`);
      }
    } else notes.push('fidelity: set BENCH_X4_REFERENCE to today\'s Chromium PDF (scripts/render/references.ts)');
    results.push({id: 'X4', values, notes});
    ctx.log(`X4 pdf productFile: ${notes.join('; ')}`);
  }
  if (wants(ctx, 'X1', 'X2', 'X5')) {
    const raster = rasterRequests();
    if (wants(ctx, 'X1')) {
      await post(raster.x1);
      const times: number[] = [];
      for (let i = 0; i < runs; i++) times.push((await post(raster.x1)).ms);
      results.push({id: 'X1', values: {wall: percentile(times, 0.5)}, extra: {p95: percentile(times, 0.95), runs: times.length}, notes: [`heavyPage() page as a 512 px thumbnail through the service; median of ${times.length} round trips, p95 ${percentile(times, 0.95).toFixed(0)} ms`]});
      ctx.log(`X1 thumbnail heavyPage: median ${percentile(times, 0.5).toFixed(0)} ms, p95 ${percentile(times, 0.95).toFixed(0)} ms`);
    }
    let x2p95: number | null = null;
    if (wants(ctx, 'X2', 'X5')) {
      const first = await post(raster.x2);
      fs.writeFileSync(path.join(ctx.outDir, 'x2.png'), first.bytes);
      const times: number[] = [];
      for (let i = 0; i < runs; i++) times.push((await post(raster.x2)).ms);
      x2p95 = percentile(times, 0.95);
      if (wants(ctx, 'X2')) results.push({id: 'X2', values: {p95: x2p95}, extra: {median: percentile(times, 0.5), runs: times.length}, notes: [`x2Frame(): ${raster.layers} layers in a 3840 × 2160 frame, drop shadows on, ${(raster.x2.length / 1048576).toFixed(1)} MiB request; median ${percentile(times, 0.5).toFixed(0)} ms`]});
      ctx.log(`X2 png 3840×2160: median ${percentile(times, 0.5).toFixed(0)} ms, p95 ${x2p95.toFixed(0)} ms`);
    }
    if (wants(ctx, 'X5') && x2p95 !== null) {
      const concurrent = ctx.quick ? 8 : 20;
      const started = performance.now();
      const times = (await Promise.all(Array.from({length: concurrent}, () => post(raster.x2)))).map(r => r.ms);
      const wall = performance.now() - started;
      const p95 = percentile(times, 0.95);
      results.push({id: 'X5', values: {p95: p95 / x2p95}, extra: {p95Ms: p95, x2p95, wallMs: wall, concurrent}, notes: [`${concurrent} X2 jobs at once: one's p95 ${p95.toFixed(0)} ms = ${(p95 / x2p95).toFixed(2)}× X2's p95 (${x2p95.toFixed(0)} ms); all done in ${wall.toFixed(0)} ms`]});
      ctx.log(`X5 ${concurrent} concurrent: p95 ${p95.toFixed(0)} ms (${(p95 / x2p95).toFixed(2)}× X2), wall ${wall.toFixed(0)} ms`);
    }
  }
  return fillNa(ctx, results, 'not run');
};

export default run;
await runStandalone('export', run, import.meta.url);
