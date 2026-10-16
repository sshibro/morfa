// The layout Node bench: the TypeScript layout stages against the Rust ones through
// the wasm build (crates/layout/wasm-l2b, the workspace's release profile), in one Node process, the fixed-width fake
// measurer on both sides. Each case reports the TypeScript's time, Rust's time with the written entries serialized and
// parsed back (what a patch costs to cross), Rust's compute alone (the count of entries crosses), and the ratio.
//
//   npx tsx scripts/bench/layout.ts [--runs 7] [--case name]      min of the runs per case, ms
//
// Cases:
//   layoutFrame×500  layoutFrame of the 500 largest auto-layout frames (by subtree) of productFile(); heavyPage()
//                    has no auto-layout frame (its screens, sections and groups are plain), so the product file it is
//   engine-all       LayoutEngine.run over every id, nothing trusted (a whole-file normalize's layout), productFile()
//   engine-all-heavy the same on heavyPage() (no auto layout: rootFor finds nothing; the cost is the walk)
//   drag-*           one commit's layout stage: a top frame resized (E2), a card moved, one text retyped; on the
//                    product file and on 2× / 4× copies of it, to show the work does not grow with the file
//   group-fit-heavy  fitGroups over every id of heavyPage() (every layer is in a group)
//   resize-hand      resizeUpdates of every screen of productFile() by hand (constraints, text, vectors)

import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {Draft, isAutoLayout, resizeNode} from '../../shared/design/constraints';
import {LayoutEngine, layoutFrame} from '../../shared/design/layout';
import {fitGroups} from '../../shared/design/group-fit';
import {heavyPage, productFile, testMeasurer} from '../../tests/helpers/design-big-files';
import {loadWasm} from '../../tests/helpers/stage-diff-l2b';

const args = process.argv.slice(2);
const at = args.indexOf('--runs');
const RUNS = at >= 0 ? Number(args[at + 1]) : 7;
const only = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;
const wasm = loadWasm();

/** Min of the runs; `work` gets what `setup` made, outside the timed region. */
function time<T>(work: (prepared: T) => unknown, runs = RUNS, setup: () => T = () => undefined as T): number {
  work(setup());
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const prepared = setup();
    const start = process.hrtime.bigint();
    work(prepared);
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
  }
  return best;
}

const subtree = (doc: DesignDocument, id: NodeId): number => 1 + (doc.nodes[id].children ?? []).reduce((n, child) => n + subtree(doc, child), 0);

/** `copies` side-by-side copies of the product file's screens page (ids suffixed), for the size-independence rows. */
function scaled(doc: DesignDocument, copies: number): DesignDocument {
  if (copies === 1) return doc;
  const nodes: Record<NodeId, SceneNode> = {...doc.nodes};
  const page = doc.pages[0];
  const extra: NodeId[] = [];
  for (let c = 1; c < copies; c++) {
    const suffix = `~${c}`;
    const copy = (id: NodeId, parentId: NodeId): NodeId => {
      const node = doc.nodes[id];
      const next = `${id}${suffix}`;
      nodes[next] = {...node, id: next, parentId, y: parentId === page ? node.y + c * 50_000 : node.y, children: node.children?.map(child => copy(child, next))};
      if (!node.children) delete nodes[next].children;
      return next;
    };
    for (const id of doc.nodes[page].children ?? []) extra.push(copy(id, page));
  }
  nodes[page] = {...nodes[page], children: [...(doc.nodes[page].children ?? []), ...extra]};
  return {...doc, nodes};
}

type Row = {name: string; ts: number; rust: number; compute: number; entries: number; work: string};
const rows: Row[] = [];

/** A TypeScript case: `run` gets a document whose node table it may write in place (a transaction's own copy, as
 *  normalize gets it with `owned`), copied outside the timed region. */
type TsCase = {run: (doc: DesignDocument) => unknown; owned?: boolean};

function bench(name: string, doc: DesignDocument, ts: TsCase, rust: (handle: number, serialize: boolean) => string) {
  if (only && !name.startsWith(only)) return;
  const handle = wasm.l2b_load(JSON.stringify(doc));
  let entries = 0;
  const tsMs = time(ts.run, RUNS, () => (ts.owned ? {...doc, nodes: {...doc.nodes}} : doc));
  const rustMs = time(() => {
    const json = rust(handle, true);
    entries = (JSON.parse(json) as unknown[]).length;
  });
  wasm.l2b_layout_counters();
  rust(handle, false);
  // The layout stage's work in one run (containers measured / frames arranged / texts measured): the same for every
  // file size in the drag rows.
  const counters = wasm.l2b_layout_counters();
  const work = counters[0] || counters[1] ? `${counters[0]}/${counters[1]}/${counters[2]}` : '';
  const computeMs = time(() => rust(handle, false));
  wasm.l2b_drop(handle);
  rows.push({name, ts: tsMs, rust: rustMs, compute: computeMs, entries, work});
  console.log(`${name.padEnd(28)} ts ${tsMs.toFixed(3).padStart(9)} ms   rust ${rustMs.toFixed(3).padStart(9)} ms (${(tsMs / rustMs).toFixed(2)}×)   compute ${computeMs.toFixed(3).padStart(9)} ms (${(tsMs / computeMs).toFixed(2)}×)   entries ${entries}`);
}

const tsEngine = (dirty: NodeId[]): TsCase => ({owned: true, run: doc => {
  const draft = new Draft(doc, {mode: 'table', owned: true});
  const path = new Set<NodeId>();
  for (const id of dirty) for (let node = draft.get(id); node && !path.has(node.id); node = draft.get(node.parentId)) path.add(node.id);
  new LayoutEngine(draft, testMeasurer, {trusted: id => !path.has(id)}).run(dirty);
  return draft.written.size;
}});

function main() {
  const product = productFile();
  const heavy = heavyPage();
  const frames = Object.keys(product.nodes).filter(id => isAutoLayout(product.nodes[id]));
  const largest = frames.map(id => [id, subtree(product, id)] as const).sort((a, b) => b[1] - a[1]).slice(0, 500).map(([id]) => id);
  console.log(`product file: ${Object.keys(product.nodes).length} layers, ${frames.length} auto-layout frames; heavy page: ${Object.keys(heavy.nodes).length} layers; runs ${RUNS} (min)\n`);

  bench('layoutFrame×500', product, {run: doc => largest.map(id => layoutFrame(doc, id, testMeasurer))}, (h, s) => {
    let out = s ? '[' : '0';
    let n = 0;
    for (const id of largest) {
      const part = wasm.l2b_layout_frame(h, id, s);
      if (s) {
        const inner = part.slice(1, -1);
        if (inner) out += (n++ ? ',' : '') + inner;
      }
    }
    return s ? `${out}]` : out;
  });

  const all = Object.keys(product.nodes);
  bench('engine-all', product, tsEngine(all), (h, s) => wasm.l2b_stage(h, 'layout', all.join('\n'), s));
  const heavyAll = Object.keys(heavy.nodes);
  bench('engine-all-heavy', heavy, tsEngine(heavyAll), (h, s) => wasm.l2b_stage(h, 'layout', heavyAll.join('\n'), s));

  for (const copies of [1, 2, 4]) {
    const doc = scaled(product, copies);
    const layers = Object.keys(doc.nodes).length;
    const screen = doc.nodes[doc.pages[0]].children![0];
    const resized = {...doc, nodes: {...doc.nodes, [screen]: {...doc.nodes[screen], width: doc.nodes[screen].width - 37}}};
    bench(`drag-resize-screen ${layers}`, resized, tsEngine([screen]), (h, s) => wasm.l2b_stage(h, 'layout', screen, s));
    const card = Object.keys(doc.nodes).find(id => doc.nodes[id].type === 'INSTANCE' && isAutoLayout(doc.nodes[doc.nodes[id].parentId!]))!;
    const moved = {...doc, nodes: {...doc.nodes, [card]: {...doc.nodes[card], width: doc.nodes[card].width + 3}}};
    bench(`drag-card ${layers}`, moved, tsEngine([card]), (h, s) => wasm.l2b_stage(h, 'layout', card, s));
    const text = Object.keys(doc.nodes).find(id => doc.nodes[id].type === 'TEXT' && doc.nodes[id].text!.characters.length > 100 && isAutoLayout(doc.nodes[doc.nodes[id].parentId!]))!;
    // ' ещё' (Cyrillic) is typed on purpose: the relayout is measured on multi-byte text.
    const typed = {...doc, nodes: {...doc.nodes, [text]: {...doc.nodes[text], text: {...doc.nodes[text].text!, characters: `${doc.nodes[text].text!.characters} ещё`}}}};
    bench(`drag-type ${layers}`, typed, tsEngine([text]), (h, s) => wasm.l2b_stage(h, 'layout', text, s));
  }

  bench('group-fit-heavy', heavy, {owned: true, run: doc => {
    const draft = new Draft(doc, {mode: 'table', owned: true});
    fitGroups(draft, heavyAll);
    return draft.written.size;
  }}, (h, s) => wasm.l2b_stage(h, 'groupFit', heavyAll.join('\n'), s));

  const screens = product.nodes[product.pages[0]].children!;
  // resizeUpdates: an overlay draft (its `updates`), as the panel and the resize tool call it.
  bench('resize-hand screens', product, {run: doc => screens.map(id => {
    const draft = new Draft(doc);
    const node = doc.nodes[id];
    resizeNode(draft, id, {x: node.x, y: node.y, width: node.width * 0.8, height: node.height + 10}, 'hand');
    return draft.updates.size;
  })}, (h, s) => {
    let out = s ? '[' : '0';
    let n = 0;
    for (const id of screens) {
      const node = product.nodes[id];
      const part = wasm.l2b_resize(h, id, node.x, node.y, node.width * 0.8, node.height + 10, s);
      if (s) {
        const inner = part.slice(1, -1);
        if (inner) out += (n++ ? ',' : '') + inner;
      }
    }
    return s ? `${out}]` : out;
  });

  console.log('\n| case | TypeScript ms | Rust (wasm) ms, entries crossing | × | Rust compute ms | × | entries | layout work |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const row of rows) console.log(`| ${row.name} | ${row.ts.toFixed(3)} | ${row.rust.toFixed(3)} | ${(row.ts / row.rust).toFixed(2)} | ${row.compute.toFixed(3)} | ${(row.ts / row.compute).toFixed(2)} | ${row.entries} | ${row.work} |`);
}

main();
