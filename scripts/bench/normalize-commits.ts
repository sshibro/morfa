import {engineCalls, followStore, resetEngineCalls, resetShadow, setEngine, shadowFor} from '../../shared/design/engine-switch';
import {isAutoLayout} from '../../shared/design/constraints';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {normalizeDetailed} from '../../shared/design/normalize';
import {createDesignStore} from '../../src/design/engine/store';
import {heavyPage, productFile, testMeasurer} from '../../tests/helpers/design-big-files';

// Lane S2: the whole normalize pass per commit, TypeScript against Rust (normalize.ts `normalizeDetailed` through
// `withEngine('normalize', …)` as one unit: crates/layout/src/normalize.rs on the shadow document plus the
// transaction's writes as a patch). The store commits as the editor does (the shadow following it), with the
// fixed-width measurer both engines share. Each row is the median commit time, ms, in `ts` and in `wasm` mode; the
// difference between them is normalize's (the rest of the commit is the same TypeScript).
//
//   node --import tsx scripts/bench/normalize-commits.ts [--commits 40]
//
// Cases: a drag (gesture frames moving a layer inside an auto-layout frame), typing (a text in auto layout gets one
// more character per commit), a big reflow (a top frame's width changes, everything inside lays out again), and a
// whole-file normalize (every id dirty, an import or an old file).

const args = process.argv.slice(2);
const COMMITS = args.includes('--commits') ? Number(args[args.indexOf('--commits') + 1]) : 40;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const now = () => performance.now();

type Case = {name: string; run(doc: DesignDocument): number[]};

function pick(doc: DesignDocument) {
  const nodes = Object.values(doc.nodes);
  const flowChild = nodes.find(node => node.type !== 'TEXT' && isAutoLayout(doc.nodes[node.parentId ?? '']) && !node.children) ?? nodes.find(node => !node.children && node.parentId && doc.nodes[node.parentId].type !== 'PAGE')!;
  const text = nodes.find(node => node.type === 'TEXT' && isAutoLayout(doc.nodes[node.parentId ?? ''])) ?? nodes.find(node => node.type === 'TEXT');
  const pageChildren = doc.nodes[doc.pages[0]].children ?? [];
  const size = (id: NodeId): number => 1 + (doc.nodes[id].children ?? []).reduce((n, child) => n + size(child), 0);
  const top = [...pageChildren].sort((a, b) => size(b) - size(a))[0];
  return {flowChild, text, top};
}

const cases: Case[] = [
  {
    name: 'drag: gesture frames moving a layer in auto layout',
    run(doc) {
      const {flowChild} = pick(doc);
      const store = createDesignStore({doc, measurer: testMeasurer, idle: run => (run(), () => {})});
      const off = followStore(store);
      const times: number[] = [];
      const gesture = store.gesture('move');
      for (let k = 0; k < COMMITS; k++) {
        const started = now();
        gesture.update(tx => tx.update(flowChild.id, {width: flowChild.width + 1 + k}));
        times.push(now() - started);
      }
      gesture.commit();
      off();
      return times;
    },
  },
  {
    name: 'typing: one more character per commit',
    run(doc) {
      const {text} = pick(doc);
      if (!text?.text) return [NaN];
      const store = createDesignStore({doc, measurer: testMeasurer, idle: run => (run(), () => {})});
      const off = followStore(store);
      const times: number[] = [];
      for (let k = 0; k < COMMITS; k++) {
        const node = store.getState().doc.nodes[text.id] as SceneNode;
        const started = now();
        store.transact('type', tx => tx.update(text.id, {text: {...node.text!, characters: `${node.text!.characters}x`}}));
        times.push(now() - started);
      }
      off();
      return times;
    },
  },
  {
    name: 'big reflow: the largest top frame resized',
    run(doc) {
      const {top} = pick(doc);
      const store = createDesignStore({doc, measurer: testMeasurer, idle: run => (run(), () => {})});
      const off = followStore(store);
      const times: number[] = [];
      for (let k = 0; k < COMMITS; k++) {
        const node = store.getState().doc.nodes[top];
        const started = now();
        store.transact('resize', tx => tx.update(top, {width: node.width + (k % 2 ? -7 : 7)}));
        times.push(now() - started);
      }
      off();
      return times;
    },
  },
  {
    name: 'whole file: every id dirty',
    run(doc) {
      const dirty = new Set(Object.keys(doc.nodes));
      shadowFor(doc);
      const times: number[] = [];
      for (let k = 0; k < Math.min(COMMITS, 7); k++) {
        const started = now();
        normalizeDetailed(doc, dirty, {measurer: testMeasurer});
        times.push(now() - started);
      }
      return times;
    },
  },
];

const rows: string[] = [];
for (const [label, make] of [
  ['productFile', () => productFile()],
  ['heavyPage', heavyPage],
] as const) {
  const doc = make();
  for (const each of cases) {
    const result: Record<string, number> = {};
    let note = '';
    for (const mode of ['ts', 'wasm'] as const) {
      const restore = setEngine('normalize', mode);
      resetShadow();
      resetEngineCalls('normalize');
      each.run(doc);
      const times = each.run(doc);
      result[mode] = median(times);
      if (mode === 'wasm') {
        const calls = engineCalls('normalize');
        note = `${calls.wasm} wasm calls, ${calls.fallback} fallbacks`;
      }
      restore();
    }
    rows.push(`| ${label} | ${each.name} | ${result.ts.toFixed(2)} | ${result.wasm.toFixed(2)} | ${(result.ts / result.wasm).toFixed(2)}× | ${note} |`);
  }
}
resetShadow();
console.log(`| file | commit | ts ms | wasm ms | ts / wasm | |\n|---|---|---|---|---|---|\n${rows.join('\n')}`);
