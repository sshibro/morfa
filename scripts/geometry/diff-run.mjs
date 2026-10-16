// Lane L1: runs scripts/geometry/diff.ts over many documents in parallel chunks, each under a time limit. A chunk
// that does not finish is re-run one document at a time to find the seeds where a call never returns (the
// TypeScript's polygon-clipping can loop forever in its sweep line; the Rust port returns an error there), which
// are reported as their own category and skipped. The chunks' counts are merged into one report.
//
//   node scripts/geometry/diff-run.mjs --docs 10000 [--seed 1] [--jobs 3] [--chunk 100] [--limit 600] -- <diff.ts flags>
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const own = split >= 0 ? argv.slice(0, split) : argv, pass = split >= 0 ? argv.slice(split + 1) : [];
const opt = (name, fallback) => {
  const i = own.indexOf(`--${name}`);
  return Number(i >= 0 ? own[i + 1] : fallback);
};
const DOCS = opt('docs', 10000), SEED = opt('seed', 1), JOBS = opt('jobs', 3), CHUNK = opt('chunk', 100), LIMIT = opt('limit', 600);
const dir = mkdtempSync(path.join(tmpdir(), 'geometry-diff-'));
const diff = path.join(path.dirname(new URL(import.meta.url).pathname), 'diff.ts');

function run(seed, docs, skip, limitSeconds) {
  return new Promise(resolve => {
    const json = path.join(dir, `${seed}-${docs}-${skip.length}.json`);
    const args = ['--import', 'tsx', diff, '--docs', String(docs), '--seed', String(seed), '--json', json, ...(skip.length ? ['--skip', skip.join(',')] : []), ...pass];
    const child = spawn(process.execPath, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), limitSeconds * 1000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(existsSync(json) ? {ok: true, result: JSON.parse(readFileSync(json, 'utf8')), out} : {ok: false, out});
    });
  });
}

const results = [], hung = [];
async function chunk(seed, docs) {
  const first = await run(seed, docs, [], LIMIT);
  if (first.ok) return results.push(first.result);
  // Find the documents that never finish, one by one, then run the chunk without them.
  const skip = [];
  for (let s = seed; s < seed + docs; s++) {
    const one = await run(s, 1, [], 120);
    if (!one.ok) skip.push(s);
  }
  hung.push(...skip);
  const again = await run(seed, docs, skip, LIMIT * 2);
  if (again.ok) results.push(again.result);
  else hung.push(`chunk ${seed}+${docs} failed again`);
}

const queue = [];
for (let s = SEED; s < SEED + DOCS; s += CHUNK) queue.push([s, Math.min(CHUNK, SEED + DOCS - s)]);
const started = Date.now();
let done = 0;
await Promise.all(Array.from({length: JOBS}, async () => {
  while (queue.length) {
    const [s, n] = queue.shift();
    await chunk(s, n);
    done += n;
    if (done % (CHUNK * 10) === 0) console.log(`… ${done}/${DOCS} documents, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
}));

const counts = {}, byKind = {}, worst = {};
let docs = 0, wasmCalls = 0, crashed = 0;
const failures = [];
for (const r of results) {
  docs += r.docs; wasmCalls += r.wasmCalls; crashed += r.crashed;
  for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
  for (const [k, v] of Object.entries(r.byKind)) byKind[k] = (byKind[k] ?? 0) + v;
  for (const [k, v] of Object.entries(r.worst)) if (!worst[k] || v.value > worst[k].value) worst[k] = v;
  failures.push(...r.failures);
}
console.log(`\n${docs} documents compared (seeds ${SEED}..${SEED + DOCS - 1}, ${(Date.now() - started) / 1000 | 0} s, WASM calls ${wasmCalls}); flags: ${pass.join(' ')}`);
for (const kind of Object.keys(counts).sort()) console.log(`  ${kind.padEnd(44)} ${String(counts[kind]).padStart(9)} checks  ${String(byKind[kind] ?? 0).padStart(6)} mismatches${worst[kind] ? `  worst area ratio ${worst[kind].value.toExponential(2)} (seed ${worst[kind].seed})` : ''}`);
console.log(`  documents where the TypeScript never returns (skipped): ${hung.length ? hung.join(', ') : 'none'}`);
if (crashed) console.log(`  crashes: ${crashed}`);
for (const f of failures.slice(0, Number(process.env.MORFA_DIFF_SHOW ?? 10))) console.log(`  MISMATCH ${f.kind} seed=${f.seed}: ${f.detail.slice(0, 300)}`);
const mismatches = Object.values(byKind).reduce((a, b) => a + b, 0);
console.log(mismatches || crashed ? `FAIL: ${mismatches} mismatches` : 'PASS');
process.exit(mismatches || crashed ? 1 : 0);
