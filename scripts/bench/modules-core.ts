import {resetShadow, setEngine, type EngineModule} from '../../shared/design/engine-switch';
import {isAutoLayout} from '../../shared/design/constraints';
import {localMatrix, unionRects, worldBox, worldMatrix} from '../../shared/design/geometry';
import {combinePaths, combinePathsLive} from '../../shared/design/boolean';
import {strokeArea, type StrokeStyle} from '../../shared/design/outline-stroke';
import {parsePathData, transformPaths} from '../../shared/design/paths';
import {nodeGeometry} from '../../shared/design/shapes';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps} from '../../shared/design/defaults';
import {createInstance} from '../../shared/design/components';
import {normalizeDocument} from '../../shared/design/normalize';
import type {NodeType, PathCommand, VectorPath} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';
import {mulberry32, randomPathData} from '../geometry/fuzz-docs';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {createDesignStore} from '../../src/design/engine/store';
import {attachPersistence} from '../../src/design/editor/editor-session';
import {rebaseLocal} from '../../shared/design/merge';
import {solid} from '../../shared/design/defaults';
import {heavyPage, productFile, testMeasurer} from '../../tests/helpers/design-big-files';
import type {EngineBenchOptions, Row} from './engine-core';

// Lane E1: each ported module end to end, `ts` against `wasm`, as the editor runs it — the store committing with the
// shadow following it (what `wasm` costs on every commit), on heavyPage() (20 041 layers) and productFile() (12 502,
// nested auto layout). The same code in Node and in headless Chromium (scripts/bench/engine.ts --core modules
// [--chrome] [--throttle 2]: CPU throttling stands in for the laptop). Each row is a median in ms; × is ts ÷ wasm
// (above 1: wasm is faster).
//
// Rows:
//   geometry  selection box: worldBox of 2 000 selected layers and their union (the overlay's selection box, align);
//             world matrices of the same 2 000; a commit moving one layer, the shadow following (the upkeep `wasm`
//             adds to every commit while nothing reads the shadow); booleans: the union of L1's operands as
//             written (combinePaths, exact on both sides) and as drawn live (combinePathsLive, lane G: by area).
//   ops       a commit moving one layer (E1's store work); a drag frame moving 50 layers (gesture).
//   normalize productFile: a drag frame in auto layout, typing one character, the big reflow (E2's top frame resized);
//             a component with 1 000 instances changed (TARGETS E3); typing in a component's text with 16 copies
//             (lane N1: the instance sync is what the store-node stages are for).

/** The fastest round's median: a noisy machine only ever slows a round down. */
const best = (values: number[]) => (values.length ? Math.min(...values) : NaN);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const now = () => performance.now();

type Case = {module: EngineModule; name: string; doc: () => DesignDocument; run: (doc: DesignDocument, mode: 'ts' | 'wasm') => number[]};

const leaves = (doc: DesignDocument) => Object.values(doc.nodes).filter(node => !node.children && node.type !== 'PAGE');

/** Idle work the stores queued (the spare node table the editor copies while nobody types): run between timed steps,
 *  never inside one, as the editor's idle callback does. */
const idleQueue: (() => void)[] = [];
const runIdle = () => {
  while (idleQueue.length) idleQueue.shift()!();
};

/** A measurer that is not the fixed-width fake (widths by character, a revision): Rust normalize asks it through
 *  JavaScript (normalize.ts `measurerFunction`), as it would the browser's canvas measurer. */
const realishMeasurer: TextMeasurer = {
  revision: 1,
  width: (text, font) => {
    let width = 0;
    for (let i = 0; i < text.length; i++) width += (((text.charCodeAt(i) * 7) % 13) + 3) / 16;
    return width * font.size * (font.weight > 500 ? 1.1 : 1);
  },
  metrics: font => ({ascent: font.size * 0.77, descent: font.size * 0.23}),
};

/** A store over `doc` as the editor makes it (the shadow catching up at idle, as in the browser), the shadow loaded. */
function storeOf(doc: DesignDocument, mode: 'ts' | 'wasm', measurer: TextMeasurer = testMeasurer) {
  const store = createDesignStore({
    doc,
    measurer,
    deferShadow: true,
    idle: run => {
      let live = true;
      idleQueue.push(() => live && run());
      return () => void (live = false);
    },
  });
  if (mode === 'wasm') runIdle();
  return {store, off: () => runIdle()};
}

function times(count: number, each: (k: number) => void): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    runIdle();
    const started = now();
    each(k);
    out.push(now() - started);
  }
  return out;
}

function pickProduct(doc: DesignDocument) {
  const nodes = Object.values(doc.nodes);
  const flowChild = nodes.find(node => node.type !== 'TEXT' && isAutoLayout(doc.nodes[node.parentId ?? '']) && !node.children)!;
  const text = nodes.find(node => node.type === 'TEXT' && isAutoLayout(doc.nodes[node.parentId ?? '']))!;
  const size = (id: NodeId): number => 1 + (doc.nodes[id].children ?? []).reduce((n, child) => n + size(child), 0);
  const top = [...(doc.nodes[doc.pages[0]].children ?? [])].sort((a, b) => size(b) - size(a))[0];
  return {flowChild, text, top};
}

/** A card component (a picture, a title and a text in a vertical auto layout) and `copies` instances of it on one
 *  page (rows of 25), normalized: TARGETS E3's document for 1 000 copies, the instance sync's for 16. */
export function componentWithCopies(copies: number): DesignDocument {
  let doc = createDocument('page', 'Page');
  const nodes = doc.nodes;
  const add = (type: NodeType, parentId: NodeId, id: NodeId, props: Partial<SceneNode>) => {
    nodes[id] = createNode(type, {...props, id, parentId});
    nodes[parentId].children!.push(id);
  };
  const padded = {...defaultAutoLayout('VERTICAL'), itemSpacing: 12, paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16};
  add('COMPONENT', 'page', 'card', {name: 'Card', x: 0, y: -400, width: 320, height: 220, autoLayout: padded, cornerRadius: 12});
  add('RECTANGLE', 'card', 'picture', {name: 'Picture', width: 288, height: 120, layoutSizingHorizontal: 'FILL', fills: [solid({r: 0.8, g: 0.85, b: 0.9})]});
  add('TEXT', 'card', 'title', {name: 'Title', width: 288, height: 24, text: {...defaultTextProps('Card title'), textAutoResize: 'HEIGHT'}, layoutSizingHorizontal: 'FILL'});
  add('TEXT', 'card', 'caption', {name: 'Caption', width: 288, height: 18, text: {...defaultTextProps('A two-line description, as in a catalog'), textAutoResize: 'HEIGHT'}, layoutSizingHorizontal: 'FILL'});
  for (let k = 0; k < copies; k++) doc = createInstance(doc, 'card', {parentId: 'page', newId: `i${k}`, x: (k % 25) * 340, y: Math.floor(k / 25) * 240}).doc;
  return normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer: testMeasurer});
}
const thousandCopies = () => componentWithCopies(1000);

/** A 10 × 10 grid auto-layout frame (lane N1 step 11): fixed 640 × 640, FLEX columns, HUG rows, 8 px gaps, a hundred
 *  cells each holding a card (a picture over a title in a small vertical auto layout), normalized. */
export function gridOfCells(rows = 10, columns = 10): DesignDocument {
  const doc = createDocument('page', 'Page');
  const nodes = doc.nodes;
  const add = (type: NodeType, parentId: NodeId, id: NodeId, props: Partial<SceneNode>) => {
    nodes[id] = createNode(type, {...props, id, parentId});
    nodes[parentId].children!.push(id);
  };
  add('FRAME', 'page', 'grid', {
    name: 'Grid', x: 0, y: 0, width: 640, height: 640, autoLayout: {...defaultAutoLayout('GRID'), paddingLeft: 8, paddingRight: 8, paddingTop: 8, paddingBottom: 8},
    grid: {rowCount: rows, columnCount: columns, rowGap: 8, columnGap: 8, rowSizes: Array.from({length: rows}, () => ({type: 'HUG'})), columnSizes: [], autoTracks: 'NONE', itemsPositioning: 'ROW_AUTO_FLOW'},
  });
  for (let k = 0; k < rows * columns; k++) {
    const cell = `c${k}`;
    add('FRAME', 'grid', cell, {name: 'Cell', width: 56, height: 56, layoutSizingHorizontal: 'FILL', autoLayout: {...defaultAutoLayout('VERTICAL'), itemSpacing: 4}});
    add('RECTANGLE', cell, `${cell}p`, {name: 'Picture', width: 48, height: 32, layoutSizingHorizontal: 'FILL', fills: [solid({r: 0.8, g: 0.85, b: 0.9})]});
    add('TEXT', cell, `${cell}t`, {name: 'Caption', width: 48, height: 16, text: {...defaultTextProps(`Cell ${k}`), textAutoResize: 'HEIGHT'}, layoutSizingHorizontal: 'FILL'});
  }
  return normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer: testMeasurer});
}
const gridHundred = () => gridOfCells();
const sixteenCopies = () => componentWithCopies(16);

/** Lane L1's boolean operands (scripts/bench/geometry.ts), `count` shapes of five kinds in page space. */
function operands(seed: number, count: number): VectorPath[][] {
  const r = mulberry32(seed);
  const closed = (commands: PathCommand[]): PathCommand[] => (commands.length && commands[commands.length - 1].type !== 'Z' ? [...commands, {type: 'Z'}] : commands);
  const out: VectorPath[][] = [];
  for (let k = 0; k < count; k++) {
    const kind = Math.floor(r() * 5);
    const node = createNode(['RECTANGLE', 'ELLIPSE', 'STAR', 'POLYGON', 'VECTOR'][kind] as 'RECTANGLE', {
      id: `o${k}`, x: r() * 900, y: r() * 900, width: 20 + r() * 160, height: 20 + r() * 160, rotation: r() * 360 - 180,
      cornerRadius: kind === 0 || kind === 3 ? r() * 30 : undefined, pointCount: kind === 2 || kind === 3 ? 3 + Math.floor(r() * 6) : undefined,
      vectorPaths: kind === 4 ? [{windingRule: 'NONZERO', commands: closed(parsePathData(randomPathData(r, 80, false)))}] : undefined,
    });
    out.push(transformPaths(nodeGeometry(node), localMatrix(node)));
  }
  return out;
}

/** Lane L1's dashed strokes: open paths of curves and lines, several weights, caps and joins. */
function dashed(seed: number, count: number): {paths: VectorPath[]; style: StrokeStyle}[] {
  const r = mulberry32(seed);
  return Array.from({length: count}, () => ({
    paths: [{windingRule: 'NONZERO' as const, commands: parsePathData(randomPathData(r, 150, false)).filter(c => c.type !== 'Z')}],
    style: {
      weight: [1, 2, 4, 8][Math.floor(r() * 4)], align: 'CENTER' as const, cap: (['NONE', 'ROUND', 'SQUARE'] as const)[Math.floor(r() * 3)],
      join: (['MITER', 'BEVEL', 'ROUND'] as const)[Math.floor(r() * 3)], miterLimit: 4, dashPattern: [[10, 5], [4, 4], [20, 8, 4, 8]][Math.floor(r() * 3)],
    },
  }));
}

export function casesFor(commits: number): Case[] {
  return [
    {
      module: 'geometry',
      name: 'boolean union of 100 operands (E4)',
      doc: heavyPage,
      run(_doc, _mode) {
        const ops = operands(7, 100);
        return times(Math.min(commits, 7), () => void combinePaths('UNION', ops, 0.01));
      },
    },
    {
      // What the editor draws (booleanGeometry → combinePathsLive, lane G): the same area, compared by area in both.
      module: 'geometry',
      name: 'boolean union of 100 operands, live drawing (E4)',
      doc: heavyPage,
      run(_doc, _mode) {
        const ops = operands(7, 100);
        return times(Math.min(commits, 7), () => void combinePathsLive('UNION', ops, 0.01));
      },
    },
    {
      module: 'geometry',
      name: 'boolean union of 200 operands, live drawing (E4)',
      doc: heavyPage,
      run(_doc, _mode) {
        const ops = operands(7, 200);
        return times(Math.min(commits, 7), () => void combinePathsLive('UNION', ops, 0.01));
      },
    },
    {
      module: 'geometry',
      name: 'outline stroke of 10 dashed paths',
      doc: heavyPage,
      run(_doc, _mode) {
        const items = dashed(11, 10);
        return times(Math.min(commits, 7), () => items.forEach(item => strokeArea(item.paths, item.style)));
      },
    },
    {
      module: 'geometry',
      name: 'selection box of 2 000 layers (heavyPage)',
      doc: heavyPage,
      run(doc, mode) {
        const ids = leaves(doc).filter((_, i) => i % 7 === 0).slice(0, 2000).map(node => node.id);
        const {store, off} = storeOf(doc, mode);
        const now = store.getState().doc;
        const out = times(commits, () => void unionRects(ids.map(id => worldBox(now, id))));
        off();
        return out;
      },
    },
    {
      module: 'geometry',
      name: 'world matrices of 2 000 layers (heavyPage)',
      doc: heavyPage,
      run(doc, mode) {
        const ids = leaves(doc).filter((_, i) => i % 7 === 0).slice(0, 2000).map(node => node.id);
        const {store, off} = storeOf(doc, mode);
        const now = store.getState().doc;
        const out = times(commits, () => void ids.map(id => worldMatrix(now, id)));
        off();
        return out;
      },
    },
    {
      module: 'geometry',
      name: 'commit moving one layer, shadow following (heavyPage)',
      doc: heavyPage,
      run(doc, mode) {
        const {store, off} = storeOf(doc, mode);
        const id = leaves(doc)[100].id;
        const out = times(commits, k => store.transact('move', tx => tx.update(id, {x: 10 + k})));
        off();
        return out;
      },
    },
    {
      module: 'geometry',
      name: 'drag frame of 50 layers reading 200 boxes (heavyPage)',
      doc: heavyPage,
      run(doc, mode) {
        const {store, off} = storeOf(doc, mode);
        const all = leaves(doc);
        const ids = all.slice(0, 50).map(node => node.id);
        const read = all.filter((_, i) => i % 97 === 0).slice(0, 200).map(node => node.id);
        const gesture = store.gesture('move');
        const out = times(commits, k => {
          gesture.update(tx => ids.forEach(id => tx.update(id, {x: doc.nodes[id].x + k + 1})));
          const frame = store.getState().doc;
          for (const id of read) worldBox(frame, id);
        });
        gesture.commit();
        off();
        return out;
      },
    },
    {
      module: 'geometry',
      name: 'commit moving one layer, then its box and 200 others (heavyPage)',
      doc: heavyPage,
      run(doc, mode) {
        const {store, off} = storeOf(doc, mode);
        const all = leaves(doc);
        const id = all[100].id;
        const read = all.filter((_, i) => i % 97 === 0).slice(0, 200).map(node => node.id);
        const out = times(commits, k => {
          store.transact('move', tx => tx.update(id, {x: 10 + k}));
          const now = store.getState().doc;
          worldBox(now, id);
          for (const each of read) worldBox(now, each);
        });
        off();
        return out;
      },
    },
    {
      module: 'ops',
      name: 'commit moving one layer (heavyPage)',
      doc: heavyPage,
      run(doc, mode) {
        const {store, off} = storeOf(doc, mode);
        const id = leaves(doc)[100].id;
        const out = times(commits, k => store.transact('move', tx => tx.update(id, {x: 10 + k})));
        off();
        return out;
      },
    },
    {
      module: 'ops',
      name: 'drag frame moving 50 layers (heavyPage)',
      doc: heavyPage,
      run(doc, mode) {
        const {store, off} = storeOf(doc, mode);
        const ids = leaves(doc).slice(0, 50).map(node => node.id);
        const gesture = store.gesture('move');
        const out = times(commits, k => gesture.update(tx => ids.forEach(id => tx.update(id, {x: doc.nodes[id].x + k + 1}))));
        gesture.commit();
        off();
        return out;
      },
    },
    {
      module: 'ops',
      name: 'remote change of 12 layers, local edits rebased (heavyPage)',
      doc: heavyPage,
      run(doc, mode) {
        const {store, off} = storeOf(doc, mode);
        const persistence = attachPersistence(store, {
          fileId: 'f', baseVersion: 1, events: null, timers: {setTimeout: () => 1, clearTimeout: () => {}}, onStatus: () => {}, onConflict: () => {},
          request: async () => ({version: 2, updatedAt: ''}),
        });
        const ids = leaves(doc).map(node => node.id);
        store.transact('Fill', tx => ids.slice(0, 3).forEach(id => tx.update(id, {fills: [solid({r: 1, g: 0, b: 0})]})));
        const autosave = persistence.autosave()!;
        const out = times(commits, round => {
          const change = {nodes: Object.fromEntries([ids[0], ...ids.slice(200 + round * 12, 211 + round * 12)].map(id => [id, {...store.getState().doc.nodes[id], x: round * 3}]))};
          store.applyRemote(state => autosave.serverChanged(change, state.doc, 2 + round, rebaseLocal));
        });
        off();
        return out;
      },
    },
    {
      module: 'normalize',
      name: 'drag frame in auto layout (productFile)',
      doc: () => productFile(),
      run(doc, mode) {
        const {flowChild} = pickProduct(doc);
        const {store, off} = storeOf(doc, mode);
        const gesture = store.gesture('move');
        const out = times(commits, k => gesture.update(tx => tx.update(flowChild.id, {width: flowChild.width + 1 + k})));
        gesture.commit();
        off();
        return out;
      },
    },
    {
      module: 'normalize',
      name: 'typing one character (productFile)',
      doc: () => productFile(),
      run(doc, mode) {
        const {text} = pickProduct(doc);
        const {store, off} = storeOf(doc, mode);
        const out = times(commits, () => {
          const node = store.getState().doc.nodes[text.id] as SceneNode;
          store.transact('type', tx => tx.update(text.id, {text: {...node.text!, characters: `${node.text!.characters}x`}}));
        });
        off();
        return out;
      },
    },
    {
      module: 'normalize',
      name: 'big reflow: top frame resized (productFile, E2)',
      doc: () => productFile(),
      run(doc, mode) {
        const {top} = pickProduct(doc);
        const {store, off} = storeOf(doc, mode);
        const out = times(commits, k => {
          const node = store.getState().doc.nodes[top];
          store.transact('resize', tx => tx.update(top, {width: node.width + (k % 2 ? -7 : 7)}));
        });
        off();
        return out;
      },
    },
    {
      module: 'normalize',
      name: 'grid 10×10: change a cell\'s picture (grid auto layout)',
      doc: gridHundred,
      run(doc, mode) {
        const {store, off} = storeOf(doc, mode);
        const out = times(commits, k => {
          store.transact('fill', tx => tx.update('c55p', {height: 32 + (k % 2 ? 4 : 0)}));
        });
        off();
        return out;
      },
    },
    {
      module: 'normalize',
      name: 'grid 10×10: resize the frame (grid auto layout)',
      doc: gridHundred,
      run(doc, mode) {
        const {store, off} = storeOf(doc, mode);
        const out = times(commits, k => {
          const node = store.getState().doc.nodes.grid;
          store.transact('resize', tx => tx.update('grid', {width: node.width + (k % 2 ? -7 : 7)}));
        });
        off();
        return out;
      },
    },
    {
      module: 'normalize',
      name: 'change a component with 1 000 instances (E3)',
      doc: thousandCopies,
      run(doc, mode) {
        const {store, off} = storeOf(doc, mode);
        const colors = [solid({r: 0.8, g: 0.85, b: 0.9}), solid({r: 0.9, g: 0.8, b: 0.8})];
        const out = times(Math.min(commits, 10), k => store.transact('fill', tx => tx.update('picture', {fills: [colors[(k + 1) % 2]]})));
        off();
        return out;
      },
    },
    {
      module: 'normalize',
      name: "typing in a component's text, 16 copies",
      doc: sixteenCopies,
      run(doc, mode) {
        const {store, off} = storeOf(doc, mode);
        const out = times(commits, () => {
          const node = store.getState().doc.nodes.title;
          store.transact('type', tx => tx.update('title', {text: {...node.text!, characters: `${node.text!.characters}x`}}));
        });
        off();
        return out;
      },
    },
    {
      module: 'normalize',
      name: 'big reflow, measured through JavaScript (productFile)',
      doc: () => productFile(),
      run(doc, mode) {
        const {top} = pickProduct(doc);
        const {store, off} = storeOf(doc, mode, realishMeasurer);
        const out = times(commits, k => {
          const node = store.getState().doc.nodes[top];
          store.transact('resize', tx => tx.update(top, {width: node.width + (k % 2 ? -7 : 7)}));
        });
        off();
        return out;
      },
    },
  ];
}

/** Every case in ts and wasm (its module alone switched; the rest `ts`), alternating over `rounds` rounds after a
 *  warm-up run of each: a row is the median of the rounds' medians, so the order of the modes and a single GC pause
 *  do not decide it. */
export function modulesBench(options: EngineBenchOptions & {only?: string; rounds?: number; modes?: ('ts' | 'wasm')[]} = {}): Row[] {
  const rows: Row[] = [];
  const commits = options.commits ?? 30;
  const rounds = options.rounds ?? 3;
  const docs = new Map<() => DesignDocument, DesignDocument>();
  for (const each of casesFor(commits)) {
    if (options.only && !`${each.module} ${each.name}`.includes(options.only)) continue;
    let doc = docs.get(each.doc);
    if (!doc) docs.set(each.doc, (doc = each.doc()));
    const result: Record<'ts' | 'wasm', number[]> = {ts: [], wasm: []};
    for (let round = -1; round < rounds; round++)
      for (const mode of options.modes ?? (['ts', 'wasm'] as const)) {
        const restore = [setEngine('*', 'ts'), setEngine(each.module, mode)];
        try {
          resetShadow();
          const times = each.run(doc, mode);
          if (round >= 0) result[mode].push(median(times));
        } finally {
          while (restore.length) restore.pop()!();
        }
      }
    // One mode alone (`modes`, a profile of it): the other reads as –.
    const ts = median(result.ts) ?? NaN, wasm = median(result.wasm) ?? NaN;
    const fixed = (value: number, digits: number) => (Number.isNaN(value) ? '–' : value.toFixed(digits));
    rows.push({name: `${each.module}: ${each.name}`, value: ts / wasm, unit: '× ts', note: `ts ${fixed(ts, 3)} ms, wasm ${fixed(wasm, 3)} ms; best rounds ${fixed(best(result.ts) / best(result.wasm), 2)}×; rounds ${result.ts.map((t, i) => fixed(t / result.wasm[i], 2)).join(' ')}`});
  }
  resetShadow();
  return rows;
}

export const bench = modulesBench;
