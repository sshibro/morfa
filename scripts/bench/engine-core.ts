import {engineTs, followStore, resetShadow, resetShadowStats, setEngine, shadowFor, shadowStats, withEngine} from '../../shared/design/engine-switch';
import {localMatrix, worldBox} from '../../shared/design/geometry';
import type {DocumentPatch} from '../../shared/design/patch';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {createDesignStore} from '../../src/design/engine/store';
import {compareModes} from './engine-calls';
import {heavyPage, testMeasurer} from '../../tests/helpers/design-big-files';

// The measurements, the same code in Node (scripts/bench/engine.ts) and in headless Chrome (engine.html): the
// switch's own overhead, the shadow document's upkeep on the 20 041-layer heavyPage() (load, apply_patch of a
// 20-entry patch, the double write per store commit, memory) and the proof module (localMatrix, worldBox) per call in
// ts and wasm. docs/TARGETS.md: double write at 20k nodes under 2 ms a commit and under 60 MB;
// apply_patch of a 20-entry patch under 0.5 ms median in Chrome.

export type Row = {name: string; value: number; unit: string; target?: string; pass?: boolean; note?: string};

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const now = () => performance.now();

/** Leaves of the page in a stable order. */
const leavesOf = (doc: DesignDocument) => Object.values(doc.nodes).filter(node => !node.children && node.type !== 'PAGE').map(node => node.id);

/** `run` repeated until about `ms` passed: the time per call in ns. */
function perCall(run: (i: number) => void, ms = 200): number {
  let calls = 0;
  const started = now();
  let elapsed = 0;
  while (elapsed < ms) {
    for (let i = 0; i < 1000; i++) run(calls + i);
    calls += 1000;
    elapsed = now() - started;
  }
  return (elapsed * 1e6) / calls;
}

export type EngineBenchOptions = {
  /** Heap in use (bytes), when the runtime can tell: Node's process.memoryUsage, Chrome's performance.memory. */
  heapUsed?: () => number | null;
  /** Collects garbage when the runtime allows it (node --expose-gc, Chrome --js-flags=--expose-gc). */
  gc?: () => void;
  /** The heap measure counts wasm memory too (Chrome's performance.memory does, Node's heapUsed does not). */
  heapIncludesWasm?: boolean;
  commits?: number;
};

export function engineBench(options: EngineBenchOptions = {}): Row[] {
  const rows: Row[] = [];
  const heap = () => {
    options.gc?.();
    return options.heapUsed?.() ?? null;
  };
  const restore = [setEngine('*', 'ts')];
  try {
    const doc = heavyPage();
    const json = JSON.stringify(doc);
    const ids = Object.keys(doc.nodes);
    const leaves = leavesOf(doc);
    rows.push({name: 'heavyPage', value: ids.length, unit: 'nodes', note: `${(json.length / 1e6).toFixed(1)} MB of JSON`});

    // ── The switch itself ──
    const direct = perCall(i => void (i & 1));
    rows.push({name: 'switch: engineTs check (ts mode)', value: perCall(() => void engineTs('geometry')) - direct, unit: 'ns/call'});
    rows.push({name: 'switch: withEngine (ts mode, two closures)', value: perCall(i => void withEngine('geometry', 'bench', () => i, () => i)) - direct, unit: 'ns/call'});
    restore.push(setEngine('ops', 'both'));
    rows.push({name: 'switch: withEngine (both, number compare)', value: perCall(i => void withEngine('ops', 'bench', () => i, () => i)) - direct, unit: 'ns/call'});

    // ── The shadow document ──
    resetShadow();
    const before = heap();
    const wasmBefore = shadowFor({...doc, nodes: {}, pages: []}).stats().memoryBytes;
    const loads: number[] = [];
    for (let run = 0; run < 3; run++) {
      resetShadow();
      const started = now();
      shadowFor(doc);
      loads.push(now() - started);
    }
    const shadow = shadowFor(doc);
    const stats = shadow.stats();
    const measured = heap();
    const after = measured === null ? null : measured - (options.heapIncludesWasm ? stats.memoryBytes - wasmBefore : 0);
    rows.push({name: 'shadow: load (JSON.stringify + new MorfaDoc)', value: median(loads), unit: 'ms'});
    rows.push({name: 'shadow: wasm memory after load', value: stats.memoryBytes / 2 ** 20, unit: 'MiB', note: `${stats.nodes} nodes, ${stats.atoms} atoms; the whole linear memory`});
    if (before !== null && after !== null) rows.push({name: 'shadow: JS heap for the shadow (mirror)', value: (after - before) / 2 ** 20, unit: 'MiB', note: 'heap used after − before load, gc first'});

    // apply_patch of 20-entry patches (20 layers moved), the JSON made beforehand and with it.
    const moved = leaves.slice(0, 20);
    const patches: DocumentPatch[] = [];
    for (let k = 1; k <= 300; k++) {
      const nodes: Record<NodeId, SceneNode> = {};
      for (const id of moved) nodes[id] = {...doc.nodes[id], x: doc.nodes[id].x + k, y: doc.nodes[id].y - k};
      patches.push({nodes});
    }
    const texts = patches.map(patch => JSON.stringify(patch));
    const apply: number[] = [], encode: number[] = [];
    texts.forEach((text, k) => {
      const t0 = now();
      JSON.stringify(patches[k]);
      const t1 = now();
      shadow.apply_patch(text);
      const t2 = now();
      encode.push(t1 - t0);
      apply.push(t2 - t1);
    });
    const applyMedian = median(apply);
    rows.push({name: 'shadow: apply_patch, 20 entries (JSON ready)', value: applyMedian * 1000, unit: 'µs', target: '≤ 500 µs median (Chrome)', pass: applyMedian <= 0.5, note: `${(texts[0].length / 1024).toFixed(1)} KiB of JSON`});
    rows.push({name: 'shadow: JSON.stringify of that patch', value: median(encode) * 1000, unit: 'µs'});

    // The double write per commit: the store's transact with the shadow following it, against the same without.
    const commits = options.commits ?? 200;
    const commitTimes = (follow: boolean) => {
      resetShadow();
      const store = createDesignStore({doc, measurer: testMeasurer, idle: run => (run(), () => {})});
      const off = follow ? followStore(store, {force: true}) : () => {};
      if (follow) shadowFor(store.getState().doc);
      resetShadowStats();
      const times: number[] = [];
      for (let k = 0; k < commits; k++) {
        const started = now();
        store.transact('move', tx => {
          for (const id of moved) tx.update(id, {x: 100 + k, y: 50 - k});
        });
        times.push(now() - started);
      }
      off();
      return {times, stats: shadowStats()};
    };
    const plain = commitTimes(false);
    const followed = commitTimes(true);
    const upkeep = (followed.stats.patchMs + followed.stats.diffMs) / commits;
    rows.push({name: 'store: commit moving 20 layers, ts only', value: median(plain.times), unit: 'ms'});
    rows.push({name: 'store: the same commit with the shadow following', value: median(followed.times), unit: 'ms'});
    rows.push({name: 'double write per commit (shadow upkeep)', value: upkeep, unit: 'ms', target: '< 2 ms at 20k nodes', pass: upkeep < 2, note: `${followed.stats.patches} patches of ${(followed.stats.entries / Math.max(1, followed.stats.patches)).toFixed(0)} entries, ${followed.stats.fullDiffs} full comparisons`});
    const memory = stats.memoryBytes / 2 ** 20;
    const mirror = before !== null && after !== null ? (after - before) / 2 ** 20 : 0;
    rows.push({name: 'double write memory (wasm + mirror)', value: memory + mirror, unit: 'MiB', target: '< 60 MB', pass: (memory + mirror) * 2 ** 20 < 60e6});

    // ── The proof module per call ──
    const nodes = leaves.slice(0, 4096).map(id => doc.nodes[id]);
    const sample = leaves.filter((_, i) => i % 4 === 0).slice(0, 4096);
    rows.push(
      ...compareModes('geometry', [
        {name: 'localMatrix', run: i => localMatrix(nodes[i & 4095])},
        {name: 'worldBox, 4-deep chain', prepare: () => void (resetShadow(), shadowFor(doc)), run: i => worldBox(doc, sample[i % sample.length])},
      ]),
    );
    return rows;
  } finally {
    while (restore.length) restore.pop()!();
    resetShadow();
  }
}

/** The runner's entry point (scripts/bench/engine.ts --core engine). */
export const bench = engineBench;

export function formatRows(rows: Row[], title: string): string {
  const lines = [`${title}`, `  ${'measure'.padEnd(52)} ${'value'.padStart(10)} unit      target`];
  for (const row of rows) {
    const value = row.value >= 100 ? row.value.toFixed(0) : row.value >= 1 ? row.value.toFixed(2) : row.value.toFixed(3);
    const verdict = row.pass === undefined ? '' : row.pass ? ' ok' : ' MISSED';
    lines.push(`  ${row.name.padEnd(52)} ${value.padStart(10)} ${row.unit.padEnd(9)} ${row.target ?? ''}${verdict}${row.note ? `  (${row.note})` : ''}`);
  }
  return lines.join('\n');
}
