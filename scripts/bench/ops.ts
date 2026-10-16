// The ops benches: the co-editing core in TypeScript against its Rust port (crates/ops through
// crates/wasm: scripts/wasm-build.sh first) in Node, on the 20 041-layer `heavyPage()`.
//
//   npx tsx scripts/bench/ops.ts [--runs 3] [--json] [--dump dir]
//
// `--dump dir` writes the page (`doc.json`) and the saves (`saves.json`, a JSON array of request texts) for the native
// server-side bench: `cargo run --release -p morfa-ops --example m1 -- dir` (TARGETS.md M1's actor work).
//
// 1. merge: five editors each moving 20 layers (a quarter of them shared with a neighbour), 150 saves; each save lands
//    on whatever version the server holds now, made on the version its editor last saw. Per save, from the request's
//    JSON text to the stored change's JSON text: TS `JSON.parse` + `applyDocumentChange` + `JSON.stringify(stored)`
//    against `OpsDocument.applyDocumentChange(text)` on the document the wasm holds. Also the merge alone
//    (`mergeChange`, parse included on both sides). The stored changes and the final documents must be equal.
// 2. waiting changes: 120 stored changes on the 20k page. (a) a held document caught up (document-cache.ts:
//    `applyPatch(doc, JSON.parse(change))` per change) against `OpsDocument.applyPatch(text)` in place; (b) a
//    document put together from its stored text (document-store.ts: `JSON.parse(text)` then the changes in place on
//    the parsed copy) against `new OpsDocument(text)` then the changes.
// 3. a drag frame: 50 layers of two groups moved in one transaction lent the gesture's scratch table, committed with
//    normalization (the group refits), 40 frames: `beginTransaction` with ops `ts` against ops `wasm` (the engine
//    switch; shared/design/ops-transaction.ts; normalization is the TypeScript's on both sides until the Rust normalize
//    lands, so this row is the transaction's own cost plus the boundary).
// Medians of `--runs` runs; each run starts from fresh copies.

import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {heavyPage, testMeasurer} from '../../tests/helpers/design-big-files';
import {applyDocumentChange} from '../../server/design/apply';
import {documentTarget, mergeChange} from '../../shared/design/merge';
import {applyPatch, type DocumentPatch} from '../../shared/design/patch';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {engineWasm, setEngine} from '../../shared/design/engine-switch';
import {beginTransaction, createScratch, type Transaction} from '../../shared/design/transaction';

// The TypeScript side runs as ops `ts`; the Rust side is called directly (OpsDocument) or through the switch in `wasm`.
setEngine('ops', 'ts');
const ops = () => engineWasm();
/** Runs `run` with ops in `wasm` (the switch's Rust side). */
function inWasm<T>(run: () => T): T {
  const restore = setEngine('ops', 'wasm');
  try {
    return run();
  } finally {
    restore();
  }
}

const args = process.argv.slice(2);
const RUNS = Number(args[args.indexOf('--runs') + 1] || 3) || 3;
const JSON_OUT = args.includes('--json');

const EDITORS = 5, LAYERS = 20, SAVES = 150, WAITING = 120;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Leaves of the page in a stable order; editor e moves 20 of them, 5 shared with editor e+1. */
function layersOf(doc: DesignDocument): NodeId[][] {
  const leaves = Object.values(doc.nodes).filter(node => !node.children).map(node => node.id);
  return Array.from({length: EDITORS}, (_, e) => {
    const own = leaves.slice(e * 1000, e * 1000 + LAYERS - 5);
    const shared = leaves.slice(((e + 1) % EDITORS) * 1000, ((e + 1) % EDITORS) * 1000 + 5);
    return [...own, ...shared];
  });
}

type Save = {editor: number; text: string};

/** The 150 saves as their editors send them (generated once with the TypeScript, replayed on both engines). */
function makeSaves(start: DesignDocument): Save[] {
  const layers = layersOf(start);
  let server = start;
  const seen: DesignDocument[] = Array.from({length: EDITORS}, () => start);
  const saves: Save[] = [];
  for (let s = 0; s < SAVES; s++) {
    const editor = s % EDITORS;
    const base = seen[editor];
    const nodes: Record<NodeId, SceneNode> = {}, before: Record<NodeId, SceneNode | null> = {};
    for (const id of layers[editor]) {
      const node = base.nodes[id];
      nodes[id] = {...node, x: node.x + 1 + (s % 3), y: node.y + (editor % 2)};
      before[id] = node;
    }
    const text = JSON.stringify({patch: {nodes}, before});
    saves.push({editor, text});
    const applied = applyDocumentChange(server, JSON.parse(text));
    server = applied.doc;
    // The editor learns the server's state at its own save's answer (the others' changes come with it).
    seen[editor] = server;
  }
  return saves;
}

function mergeRun(start: DesignDocument, startText: string, saves: Save[]) {
  // TypeScript: the server's apply step from the request text to the stored change's text.
  let doc = start;
  const tsTimes: number[] = [], tsStored: string[] = [];
  for (const save of saves) {
    const t = performance.now();
    const change = JSON.parse(save.text) as {patch: DocumentPatch; before: Record<NodeId, SceneNode | null>};
    const applied = applyDocumentChange(doc, change);
    const stored = JSON.stringify(applied.stored);
    tsTimes.push(performance.now() - t);
    doc = applied.doc;
    tsStored.push(stored);
  }
  // Rust: the document held in wasm memory, the same texts.
  const held = new (ops().OpsDocument)(startText);
  const rsTimes: number[] = [], rsStored: string[] = [];
  for (const save of saves) {
    const t = performance.now();
    const answer = held.applyDocumentChange(save.text);
    rsTimes.push(performance.now() - t);
    rsStored.push(answer);
  }
  for (let i = 0; i < saves.length; i++) {
    const answer = JSON.parse(rsStored[i]) as {stored: unknown};
    assert.equal(JSON.stringify(answer.stored), tsStored[i], `save ${i}: the stored changes differ`);
  }
  assert.equal(held.toJson(), JSON.stringify(doc), 'the final documents differ');
  held.free();
  // The merge alone, on the final document (parse of the change included on both sides).
  const target = documentTarget(doc);
  const finalHeld = new (ops().OpsDocument)(JSON.stringify(doc));
  const tsMerge: number[] = [], rsMerge: number[] = [];
  for (const save of saves) {
    const parts = JSON.parse(save.text) as {patch: DocumentPatch; before: Record<NodeId, SceneNode | null>};
    const patchText = JSON.stringify(parts.patch), beforeText = JSON.stringify({nodes: parts.before});
    let t = performance.now();
    const outcome = mergeChange(target, JSON.parse(patchText), JSON.parse(beforeText));
    const tsText = JSON.stringify(outcome);
    tsMerge.push(performance.now() - t);
    t = performance.now();
    const rsText = finalHeld.mergeChange(patchText, beforeText);
    rsMerge.push(performance.now() - t);
    assert.equal(rsText, tsText, 'mergeChange outcomes differ');
  }
  finalHeld.free();
  return {tsTimes, rsTimes, tsMerge, rsMerge};
}

function waitingRun(start: DesignDocument, startText: string, changes: string[]) {
  // (a) a held document caught up.
  let doc = start;
  let t = performance.now();
  for (const change of changes) doc = applyPatch(doc, JSON.parse(change) as DocumentPatch);
  const tsCatchUp = performance.now() - t;
  const held = new (ops().OpsDocument)(startText);
  t = performance.now();
  for (const change of changes) held.applyPatch(change);
  const rsCatchUp = performance.now() - t;
  assert.equal(held.toJson(), JSON.stringify(doc), 'caught-up documents differ');
  held.free();
  // (b) put together from the stored text.
  t = performance.now();
  let parsed = JSON.parse(startText) as DesignDocument;
  for (const change of changes) parsed = applyPatch(parsed, JSON.parse(change) as DocumentPatch, parsed.nodes);
  const tsAssemble = performance.now() - t;
  t = performance.now();
  const built = new (ops().OpsDocument)(startText);
  for (const change of changes) built.applyPatch(change);
  const rsAssemble = performance.now() - t;
  assert.equal(built.toJson(), JSON.stringify(parsed), 'assembled documents differ');
  built.free();
  return {tsCatchUp, rsCatchUp, tsAssemble, rsAssemble};
}

function dragRun(doc: DesignDocument) {
  const groups = Object.values(doc.nodes).filter(node => node.type === 'GROUP').slice(0, 2);
  const ids = groups.flatMap(group => group.children!.slice(0, 25));
  const starts = ids.map(id => doc.nodes[id]);
  const frames = (begin: (scratch: ReturnType<typeof createScratch>) => Transaction) => {
    const scratch = createScratch(doc);
    const times: number[] = [];
    let last: DocumentPatch = {};
    for (let k = 1; k <= 40; k++) {
      const t = performance.now();
      const tx = begin(scratch);
      ids.forEach((id, i) => tx.update(id, {x: starts[i].x + k * 2, y: starts[i].y + k}));
      last = tx.commit({measurer: testMeasurer}).patch;
      times.push(performance.now() - t);
    }
    return {times: times.slice(5), last: JSON.stringify(last)};
  };
  const ts = frames(scratch => beginTransaction(doc, {scratch}));
  const rs = inWasm(() => frames(scratch => beginTransaction(doc, {scratch})));
  assert.equal(rs.last, ts.last, 'drag frame patches differ');
  return {ts: ts.times, rs: rs.times};
}

function main() {
  const start = heavyPage();
  if (args.includes('--drag')) {
    // The drag-frame row alone (quick iterations on the transaction's boundary).
    dragRun(start);
    const drags = Array.from({length: RUNS}, () => dragRun(start));
    const ts = median(drags.map(run => sum(run.ts))), rs = median(drags.map(run => sum(run.rs)));
    const p50 = (key: 'ts' | 'rs') => median(drags.map(run => median(run[key])));
    console.log(`drag frame, 35 frames: ts ${ts.toFixed(1)} ms (p50 ${p50('ts').toFixed(3)}), wasm ${rs.toFixed(1)} ms (p50 ${p50('rs').toFixed(3)}) → ${(ts / rs).toFixed(2)}×`);
    return;
  }
  const startText = JSON.stringify(start);
  const saves = makeSaves(start);
  if (args.includes('--dump')) {
    const dir = args[args.indexOf('--dump') + 1];
    mkdirSync(dir, {recursive: true});
    writeFileSync(`${dir}/doc.json`, startText);
    writeFileSync(`${dir}/saves.json`, JSON.stringify(saves.map(save => save.text)));
    console.log(`ops bench: wrote ${dir}/doc.json and ${dir}/saves.json (${saves.length} saves)`);
    return;
  }
  // The stored changes of the saves are the waiting changes of (2).
  let replay = start;
  const changes: string[] = [];
  for (const save of saves.slice(0, WAITING)) {
    const applied = applyDocumentChange(replay, JSON.parse(save.text));
    replay = applied.doc;
    changes.push(JSON.stringify(applied.stored));
  }
  // Warm both engines (JIT, wasm tier-up, allocator) on a short run.
  mergeRun(start, startText, saves.slice(0, 20));

  dragRun(start);
  const merge: ReturnType<typeof mergeRun>[] = [], waiting: ReturnType<typeof waitingRun>[] = [], drags: ReturnType<typeof dragRun>[] = [];
  for (let run = 0; run < RUNS; run++) {
    merge.push(mergeRun(start, startText, saves));
    waiting.push(waitingRun(start, startText, changes));
    drags.push(dragRun(start));
  }
  const pick = (key: keyof ReturnType<typeof mergeRun>) => merge.map(run => run[key]);
  const row = (name: string, ts: number[][], rs: number[][]) => {
    const tsTotal = median(ts.map(sum)), rsTotal = median(rs.map(sum));
    return {
      name,
      ts: {total: tsTotal, p50: median(ts.map(times => median(times))), p95: median(ts.map(times => percentile(times, 0.95)))},
      rust: {total: rsTotal, p50: median(rs.map(times => median(times))), p95: median(rs.map(times => percentile(times, 0.95)))},
      speedup: tsTotal / rsTotal,
    };
  };
  type Row = {name: string; ts: {total: number; p50?: number; p95?: number}; rust: {total: number; p50?: number; p95?: number}; speedup: number};
  const rows: Row[] = [row('merge+apply per save (150 saves, 5 editors × 20 layers, heavyPage)', pick('tsTimes'), pick('rsTimes')), row('mergeChange alone (150 changes)', pick('tsMerge'), pick('rsMerge'))];
  const single = (name: string, ts: number[], rs: number[]) => ({name, ts: {total: median(ts)}, rust: {total: median(rs)}, speedup: median(ts) / median(rs)});
  rows.push(single('120 waiting changes: held document caught up', waiting.map(run => run.tsCatchUp), waiting.map(run => run.rsCatchUp)));
  rows.push(single('120 waiting changes: put together from the stored text (parse included)', waiting.map(run => run.tsAssemble), waiting.map(run => run.rsAssemble)));
  rows.push(row('drag frame: 50 layers, transaction + commit (normalize: TS on both sides), 35 frames', drags.map(run => run.ts), drags.map(run => run.rs)));
  if (JSON_OUT) console.log(JSON.stringify({runs: RUNS, nodes: Object.keys(start.nodes).length, bytes: startText.length, rows}, null, 2));
  else {
    console.log(`ops bench: heavyPage ${Object.keys(start.nodes).length} layers, ${(startText.length / 1e6).toFixed(1)} MB; medians of ${RUNS} runs (ms)`);
    for (const entry of rows) {
      const detail = (side: {total: number; p50?: number; p95?: number}) =>
        `${side.total.toFixed(1)}${side.p50 !== undefined ? ` (p50 ${side.p50.toFixed(3)}, p95 ${side.p95!.toFixed(3)} per call)` : ''}`;
      console.log(`  ${entry.name}\n    ts ${detail(entry.ts)}  rust ${detail(entry.rust)}  → ${entry.speedup.toFixed(2)}×`);
    }
  }
}

main();
