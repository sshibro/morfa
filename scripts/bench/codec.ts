// W-rows of docs/TARGETS.md §3b: the wire, codec and checkpoint format, on S1's numbers. S1's codec bench
// (`crates/model/src/bin/morfa-model-bench.rs`) is built and run here — `journal` on f20k for the op (W1, W3: the journal
// entry of a 20-layer drag, which TARGETS §3b makes the wire format), `report` on f20k and f100k for the checkpoint (W4),
// `frames` + the zstd CLI for the compressed sizes (W5), the 1 000-entry rebuild for the catch-up (W6) — and the JSON side is
// measured beside it in V8 (Node), so every W-row prints the comparison. Numbers come from this machine, not bench-ru:
// provisional until close.sh runs there. W2 needs the WASM decode in the browser (S2, B3).
//
//   tsx scripts/bench/codec.ts [--only W1,W4] [--quick]
//
// §3b rule (printed): binary wins when it decodes ≥ 2× faster than serde_json into the model OR is ≥ 2× smaller than JSON on f20k.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {fillNa, runStandalone, wants, type Bench} from './lib/context';
import {fixtureDocument, fixtureText, layersFor} from './lib/fixtures';
import {median} from './lib/stats';
import {ROOT, type RowResult} from './lib/targets';
import {BENCH_DIR} from './gen-file';

function time<T>(runs: number, work: () => T): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    work();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

const S1_BENCH = path.join(ROOT, 'crates/model/src/bin/morfa-model-bench.rs');
/** "12.34 ms (median 12.50)" or "4.5 µs (median 4.7)" → the median in the unit given. */
const timing = (text: string | undefined) => {
  const match = text && /([\d.]+) (ms|µs) \(median ([\d.]+)\)/.exec(text);
  return match ? Number(match[3]) : NaN;
};

type S1Numbers = {
  op?: {jsonBytes: number; bytes: number; encodeUs: number; decodeUs: number};
  f20k?: {jsonBytes: number; bytes: number; jsonParseMs: number; decodeMs: number; encodeMs: number};
  f100k?: {jsonBytes: number; bytes: number; jsonParseMs: number; decodeMs: number; encodeMs: number; jsonSerializeMs: number};
  zstd?: {json: number; binary: number; file: string};
  refused?: Record<string, string>;
  catchUp?: {bytes: number; decodeMs: number; jsonBytes: number};
};

function parseReport(text: string) {
  const file = /JSON (\d+) bytes/.exec(text);
  const postcard = /^postcard: (\d+) bytes \([\d.]+% of the JSON\), encode ([^,]+), decode ([^,]+), decode/m.exec(text);
  return {
    jsonBytes: Number(file?.[1]),
    bytes: Number(postcard?.[1]),
    jsonParseMs: timing(/^json parse \(from_json\): (.*)$/m.exec(text)?.[1]),
    jsonSerializeMs: timing(/^json serialize \(to_json\): (.*)$/m.exec(text)?.[1]),
    encodeMs: timing(postcard?.[2]),
    decodeMs: timing(postcard?.[3]),
  };
}

function runS1(quick: boolean, outDir: string, log: (line: string) => void): S1Numbers | string {
  if (!existsSync(S1_BENCH)) return 'S1\'s codec bench (crates/model/src/bin/morfa-model-bench.rs) is not in this checkout';
  const env = {...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || path.join(homedir(), '.cache/morfa-target/B0'), PATH: `${homedir()}/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}`};
  try {
    log('codec: building S1\'s morfa-model-bench (release)');
    execFileSync('cargo', ['build', '--release', '-p', 'morfa-model', '--bin', 'morfa-model-bench'], {cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024});
  } catch (error) {
    return `S1's codec bench did not build: ${String((error as Error).message).slice(0, 160)}`;
  }
  const binary = path.join(env.CARGO_TARGET_DIR!, 'release/morfa-model-bench');
  const runs = quick ? '3' : '7';
  const run = (args: string[]) => execFileSync(binary, args, {encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024});
  const out: S1Numbers = {};
  fixtureText('f20k');
  fixtureText('f100k');
  const journal = run(['journal', path.join(BENCH_DIR, 'f20k.json'), runs]);
  writeFileSync(path.join(outDir, 's1-journal-f20k.txt'), journal);
  const drag = /^drag 20 nodes: JSON patch (\d+) bytes.*\n\s+postcard: (\d+) bytes, encode ([^,]+), decode ([^,]+), replay/m.exec(journal);
  if (drag) out.op = {jsonBytes: Number(drag[1]), bytes: Number(drag[2]), encodeUs: timing(drag[3]), decodeUs: timing(drag[4])};
  const rebuild = /rebuild from snapshot \+ (\d+) one-node entries \(JSON patches (\d+) bytes in all\):\n\s+postcard: snapshot \d+ bytes \+ journal (\d+) bytes .*of which decode \+ replay of the entries (.*)$/m.exec(journal);
  if (rebuild) out.catchUp = {jsonBytes: Number(rebuild[2]), bytes: Number(rebuild[3]), decodeMs: timing(rebuild[4])};
  for (const name of ['f20k', 'f100k'] as const) {
    try {
      const report = run(['report', path.join(BENCH_DIR, `${name}.json`), runs]);
      writeFileSync(path.join(outDir, `s1-report-${name}.txt`), report);
      out[name] = parseReport(report);
    } catch (error) {
      // S1's reader validates as schema.ts does: f100k is past the 50 000-layer cap.
      out.refused = {...out.refused, [name]: String((error as {stderr?: string}).stderr ?? (error as Error).message).match(/Invalid \{ message: "([^"]+)"/)?.[1] ?? 'refused'};
    }
  }
  // W5: the frames (compact JSON and postcard) through zstd -3, as the checkpoints are written (BACKEND §3); f100k when the
  // model reads it, f20k otherwise.
  const zstdOf = out.f100k ? 'f100k' : 'f20k';
  try {
    const frames = path.join(outDir, `frames-${zstdOf}`);
    mkdirSync(frames, {recursive: true});
    run(['frames', path.join(BENCH_DIR, `${zstdOf}.json`), frames]);
    const sizes: Record<string, number> = {};
    for (const file of readdirSync(frames)) {
      if (file.endsWith('.zst')) continue;
      execFileSync('zstd', ['-q', '-f', '-3', path.join(frames, file), '-o', path.join(frames, `${file}.zst`)], {env});
      sizes[file] = statSync(path.join(frames, `${file}.zst`)).size;
    }
    const json = Object.entries(sizes).find(([file]) => /json/i.test(file))?.[1];
    const binary = Object.entries(sizes).find(([file]) => /postcard/i.test(file))?.[1];
    if (json && binary) out.zstd = {json, binary, file: zstdOf};
    else log(`codec: frames written ${JSON.stringify(sizes)}`);
  } catch (error) {
    log(`codec: zstd sizes failed: ${String((error as Error).message).slice(0, 160)}`);
  }
  return out;
}

const run: Bench = async ctx => {
  const results: RowResult[] = [];
  // The JSON side in V8: the op of TARGETS §3 (20 moved layers with their `before` copies, as loadgen sends it) and f100k.
  const doc = fixtureDocument('f20k');
  const layers = layersFor(doc, 0);
  const op = {baseVersion: 2, patch: {nodes: Object.fromEntries(layers.map(node => [node.id, {...node, x: node.x + 1}]))}, before: Object.fromEntries(layers.map(node => [node.id, node]))};
  const opText = JSON.stringify(op);
  const reps = ctx.quick ? 200 : 2000;
  const v8 = {opBytes: Buffer.byteLength(opText), encodeUs: time(reps, () => JSON.stringify(op)) * 1000, decodeUs: time(reps, () => JSON.parse(opText)) * 1000};
  const s1 = runS1(ctx.quick, ctx.outDir, ctx.log);
  // Measured where it runs: provisional anywhere but bench-ru (lane B5: close.sh runs it there).
  const here = ctx.machine === 'bench-ru' && process.env.BENCH_RU_LIVE === '1' ? undefined : 'S1\'s bench on this Mac (Apple silicon), not bench-ru';
  const json = `JSON in V8 (Node ${process.version}): the 20-layer op with its before copies (${(v8.opBytes / 1024).toFixed(1)} KB) ${v8.encodeUs.toFixed(0)} / ${v8.decodeUs.toFixed(0)} µs`;
  if (typeof s1 === 'string') {
    for (const id of ['W1', 'W3', 'W4', 'W5', 'W6']) if (wants(ctx, id)) results.push({id, na: `${s1}; ${json}`});
  } else {
    if (wants(ctx, 'W1'))
      results.push(s1.op ? {id: 'W1', values: {encode: s1.op.encodeUs, decode: s1.op.decodeUs}, provisional: here, notes: [`W1: S1's journal entry of a 20-node drag on f20k (postcard, the §3b wire), median µs; ${json}`]} : {id: 'W1', na: 'S1\'s journal output did not parse'});
    if (wants(ctx, 'W3'))
      results.push(s1.op ? {id: 'W3', values: {ratio: s1.op.bytes / s1.op.jsonBytes}, provisional: here, notes: [`W3: ${s1.op.bytes} bytes as postcard vs ${s1.op.jsonBytes} bytes as a JSON patch (S1's 20-node drag; today's PATCH body with before copies is ${v8.opBytes} bytes)`]} : {id: 'W3', na: 'S1\'s journal output did not parse'});
    const f20k = s1.f20k ? `on f20k (${(s1.f20k.jsonBytes / 2 ** 20).toFixed(1)} MB JSON): postcard ${(s1.f20k.bytes / 2 ** 20).toFixed(1)} MB, encode ${s1.f20k.encodeMs.toFixed(0)} ms, decode ${s1.f20k.decodeMs.toFixed(0)} ms; serde_json parse ${s1.f20k.jsonParseMs.toFixed(0)} ms` : '';
    const refusal = s1.refused?.f100k ? `S1's model refuses f100k ("${s1.refused.f100k}": the 50 000-layer cap of schema.ts)` : '';
    if (wants(ctx, 'W4'))
      results.push(s1.f100k && Number.isFinite(s1.f100k.decodeMs)
        ? {id: 'W4', values: {encode: s1.f100k.encodeMs, decode: s1.f100k.decodeMs}, provisional: here, notes: [`W4: f100k (${(s1.f100k.jsonBytes / 2 ** 20).toFixed(1)} MB JSON) as a postcard checkpoint of S1's store: ${(s1.f100k.bytes / 2 ** 20).toFixed(1)} MB; JSON in Rust: parse ${s1.f100k.jsonParseMs.toFixed(0)} ms, serialize ${s1.f100k.jsonSerializeMs.toFixed(0)} ms`]}
        : {id: 'W4', na: `${refusal || 'S1\'s report on f100k did not parse'}; ${f20k}`});
    if (wants(ctx, 'W5'))
      results.push(s1.zstd && s1.zstd.file === 'f100k'
        ? {id: 'W5', values: {ratio: s1.zstd.binary / s1.zstd.json}, provisional: here, notes: [`W5: f100k after zstd -3: postcard ${(s1.zstd.binary / 2 ** 20).toFixed(2)} MB vs compact JSON ${(s1.zstd.json / 2 ** 20).toFixed(2)} MB`]}
        : {id: 'W5', na: `${refusal || 'the f100k frames were not available'}${s1.zstd ? `; on ${s1.zstd.file} after zstd -3: postcard ${(s1.zstd.binary / 2 ** 20).toFixed(2)} MB vs compact JSON ${(s1.zstd.json / 2 ** 20).toFixed(2)} MB (${((s1.zstd.binary / s1.zstd.json) * 100).toFixed(0)} %)` : ''}`});
    if (wants(ctx, 'W6'))
      results.push(s1.catchUp ? {id: 'W6', values: {bytes: s1.catchUp.bytes / 2 ** 20, decode: s1.catchUp.decodeMs}, provisional: here ? `${here}; native Rust, the client decodes in WASM (S2, B3)` : undefined, notes: [`W6: S1's rebuild of 1 000 one-node entries on f20k: ${(s1.catchUp.bytes / 1024).toFixed(0)} KB of postcard vs ${(s1.catchUp.jsonBytes / 1024).toFixed(0)} KB of JSON patches; legacy answers such a gap with a full reload (M8)`]} : {id: 'W6', na: 'S1\'s journal output did not parse'});
    if (s1.f20k) {
      const faster = s1.f20k.jsonParseMs / s1.f20k.decodeMs, smaller = s1.f20k.jsonBytes / s1.f20k.bytes;
      ctx.log(`codec §3b rule on f20k: postcard decodes ${faster.toFixed(1)}× faster than serde_json and is ${smaller.toFixed(1)}× smaller → ${faster >= 2 || smaller >= 2 ? 'binary' : 'JSON + zstd'}`);
    }
  }
  if (wants(ctx, 'W2')) results.push({id: 'W2', na: 'needs decode_op in the WASM build (S2) and the browser client (B3)'});
  return fillNa(ctx, results, 'not run');
};

export default run;
await runStandalone('codec', run, import.meta.url);
