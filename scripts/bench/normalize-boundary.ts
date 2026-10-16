import {resetShadow, setEngine, shadowFor} from '../../shared/design/engine-switch';
import {normalizeDetailed} from '../../shared/design/normalize';
import {isAutoLayout} from '../../shared/design/constraints';
import type {DesignDocument, NodeId} from '../../shared/design/types';
import {heavyPage, productFile, testMeasurer} from '../../tests/helpers/design-big-files';

// Lane S2's R1 bench: what one normalize entry costs through the shadow document (crates/wasm/src/normalize.rs) on the
// 20 041-layer heavyPage() and the 12 502-layer productFile(), for a call that touches one layer. Before R1 every entry
// converted the whole store to the JSON model first (18–28 ms); after it, a draft reads the store node by node
// (`Draft::over_store`), so the per-call cost should not depend on the file's size. Median of the runs, ms; the
// TypeScript `normalizeDetailed` of the same one-layer change beside it.
//
//   node --import tsx scripts/bench/normalize-boundary.ts [--runs 15]

const args = process.argv.slice(2);
const RUNS = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 15;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function time(run: () => unknown): number {
  run();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return median(times);
}

type Case = {name: string; run: () => unknown};

function cases(doc: DesignDocument): Case[] {
  const shadow = shadowFor(doc);
  const nodes = Object.values(doc.nodes);
  const leaf = nodes.find(node => !node.children && node.type !== 'TEXT' && node.parentId && doc.nodes[node.parentId].type !== 'PAGE')!;
  const text = nodes.find(node => node.type === 'TEXT') ?? leaf;
  const frame = nodes.find(node => isAutoLayout(node)) ?? doc.nodes[leaf.parentId!];
  const one = JSON.stringify([leaf.id]);
  const dirty = new Set<NodeId>([leaf.id]);
  return [
    {name: 'noop stage (the boundary alone)', run: () => shadow.normalize_stage('noop', one)},
    {name: 'normalize, one layer dirty', run: () => shadow.normalize_stage('normalize', one)},
    {name: 'normalize, one text dirty', run: () => shadow.normalize_stage('normalize', JSON.stringify([text.id]))},
    {name: 'instances stage, one layer', run: () => shadow.normalize_stage('instances', one)},
    {name: 'variables stage, one layer', run: () => shadow.normalize_stage('variables', one)},
    {name: 'resizeUpdates', run: () => shadow.normalize_resize(leaf.id, leaf.x + 1, leaf.y, leaf.width + 2, leaf.height)},
    {name: 'layoutFrame', run: () => shadow.normalize_layout_frame(frame.id)},
    {name: 'groupFitUpdates', run: () => shadow.normalize_group_fit(one)},
    {name: 'TS normalizeDetailed, one layer', run: () => normalizeDetailed(doc, dirty, {measurer: testMeasurer})},
  ];
}

setEngine('normalize', 'wasm');
const rows: string[] = [];
for (const [label, make] of [
  ['heavyPage', heavyPage],
  ['productFile', () => productFile()],
] as const) {
  resetShadow();
  const doc = make();
  for (const each of cases(doc)) rows.push(`| ${label} (${Object.keys(doc.nodes).length}) | ${each.name} | ${time(each.run).toFixed(3)} |`);
}
console.log('| file | call | ms (median of ' + RUNS + ') |\n|---|---|---|\n' + rows.join('\n'));
