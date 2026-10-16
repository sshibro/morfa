import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {transformRect, unionRects, worldBox, worldMatrices, worldMatrix} from '../shared/design/geometry';
import {topLevelSelection} from '../shared/design/tree';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../shared/design/types';
import {selectionBounds, selectionBox} from '../src/design/engine/selection';
import {selectionMarks} from '../src/design/engine/overlay';
import {displayPlacement, displayPlacements} from '../src/design/panels/design/layout/geometry';
import {budget, speedFactor} from './helpers/speed';

// A large selection (docs/design-tool.md §Performance): selecting 5 000 layers, and every frame of a pan or zoom while
// they stay selected, used to measure each selected layer's world matrix from the page down, once per layer, in the
// selection box (every overlay frame), the "Position" section and the top-level selection that half the panel asks for.
// Measured on the built editor at 4× CPU throttle on 2026-10-07: a pan with 5 000 layers selected spent ~90 ms a frame
// in the overlay alone. Selected siblings share their parents: these work out each parent once, and the overlay keeps
// its marks while the document and the selection stay. Every answer equals the one-layer function's.

/** 40 screens × 10 sections × a group of 48 layers (like tests/design-perf.test.ts), turned and flipped here and there. */
function heavyPage(): DesignDocument {
  const doc = createDocument('page', 'Heavy page');
  let n = 0;
  const add = (type: NodeType, parentId: NodeId, props: Partial<SceneNode>) => {
    const id = `n${++n}`;
    doc.nodes[id] = createNode(type, {...props, id, parentId});
    doc.nodes[parentId].children!.push(id);
    return id;
  };
  const kinds: NodeType[] = ['RECTANGLE', 'ELLIPSE', 'VECTOR', 'RECTANGLE', 'FRAME'];
  for (let s = 0; s < 40; s++) {
    const screen = add('FRAME', 'page', {x: (s % 8) * 1600, y: Math.floor(s / 8) * 2200, width: 1440, height: 2000, rotation: s % 7 === 3 ? 15 : 0});
    for (let k = 0; k < 10; k++) {
      const section = add('FRAME', screen, {x: 0, y: k * 200, width: 1440, height: 200, flipX: k === 4});
      const group = add('GROUP', section, {x: 20.5, y: 20.25, width: 1400, height: 160, rotation: k === 7 ? -30 : 0});
      for (let i = 0; i < 48; i++) add(kinds[i % kinds.length], group, {x: 20 + (i % 12) * 110, y: 20 + Math.floor(i / 12) * 38, width: 100, height: 30, rotation: i % 11 === 5 ? 45 : 0, flipY: i % 13 === 6});
    }
  }
  return doc;
}

const doc = heavyPage();
const leaves = Object.keys(doc.nodes).filter(id => !doc.nodes[id].children);
const many = leaves.slice(0, 5000);

/** `doc` with a node table that counts the entries read. */
function counted(source: DesignDocument) {
  const counts = {reads: 0};
  const nodes = new Proxy(source.nodes, {
    get(target, key, receiver) {
      if (typeof key === 'string') counts.reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return {doc: {...source, nodes}, counts};
}

test('world matrices of many layers equal worldMatrix to the bit and read each ancestor once', () => {
  const world = worldMatrices(doc);
  for (const id of [...many, 'n1', 'n2', 'n3', 'page', 'missing']) assert.deepEqual(world(id), worldMatrix(doc, id), id);
  const {doc: probe, counts} = counted(doc);
  const fresh = worldMatrices(probe);
  for (const id of many) fresh(id);
  // One read per layer and its first known ancestor, plus each ancestor once: not one walk to the page per layer.
  assert.ok(counts.reads < many.length * 3, `entries read: ${counts.reads}`);
});

test('selection bounds and box equal the union of the layers\' world boxes', () => {
  const reference = unionRects(many.map(id => worldBox(doc, id)));
  assert.deepEqual(selectionBounds(doc, many), reference);
  assert.deepEqual(selectionBox(doc, many)!.width, reference!.width);
  const turned = leaves.find(id => doc.nodes[id].rotation === 45)!;
  assert.deepEqual(selectionBox(doc, [turned])!.matrix, worldMatrix(doc, turned));
  assert.deepEqual(transformRect(worldMatrices(doc)(turned), {x: 0, y: 0, width: 100, height: 30}), worldBox(doc, turned));
});

test('the top-level selection reads each container once and keeps order, duplicates out, descendants of selected out', () => {
  const reference = (ids: readonly NodeId[]) => {
    const selected = new Set(ids), seen = new Set<NodeId>(), out: NodeId[] = [];
    outer: for (const id of ids) {
      if (seen.has(id) || !doc.nodes[id]) continue;
      seen.add(id);
      for (let node = doc.nodes[id]; node?.parentId; node = doc.nodes[node.parentId]) if (selected.has(node.parentId)) continue outer;
      out.push(id);
    }
    return out;
  };
  const mixed = ['n4', 'n3', 'missing', ...many.slice(0, 300), 'n2', 'n4', 'n60', 'page', ...many.slice(2000, 2300)];
  for (const ids of [many, mixed, [], ['page'], [...many].reverse()]) assert.deepEqual(topLevelSelection(doc, ids), reference(ids));
  const {doc: probe, counts} = counted(doc);
  topLevelSelection(probe, many);
  assert.ok(counts.reads < many.length * 3, `entries read: ${counts.reads}`);
});

test('the position section\'s placements of many layers equal displayPlacement, parents worked out once', () => {
  const place = displayPlacements(doc);
  for (const id of [...many.slice(0, 1500), 'n1', 'n2', 'n3']) assert.deepEqual(place(doc.nodes[id]), displayPlacement(doc, doc.nodes[id]), id);
  const {doc: probe, counts} = counted(doc);
  const batch = displayPlacements(probe);
  for (const id of many) batch(probe.nodes[id]);
  assert.ok(counts.reads < many.length * 3, `entries read: ${counts.reads}`);
});

test('the overlay measures a selection once: a pan redraws from the kept marks', () => {
  const first = selectionMarks(doc, many);
  assert.equal(selectionMarks(doc, many), first, 'same document and selection: the same marks');
  assert.equal(selectionMarks(doc, many, new Set()), first, 'an empty set of hidden layers is no change');
  assert.deepEqual(first.box, selectionBox(doc, many));
  assert.equal(first.outlines.length, 0, 'over MAX_OUTLINED layers only the union box is drawn');
  const few = many.slice(0, 20);
  const some = selectionMarks(doc, few);
  assert.deepEqual(some.outlines.map(outline => outline.matrix), few.map(id => worldMatrix(doc, id)));
  assert.notEqual(selectionMarks(doc, few, new Set([few[0]])), some, 'a hidden layer is left out');
  assert.equal(selectionMarks(doc, few, new Set([few[0]])).ids.length, 19);
  const moved = {...doc, nodes: {...doc.nodes, [few[0]]: {...doc.nodes[few[0]], x: 999}}};
  assert.notEqual(selectionMarks(moved, few).box, some.box, 'another document is measured again');
});

test('selecting 5 000 layers: box, top-level selection and placements within 30 ms', t => {
  const run = () => {
    const started = performance.now();
    selectionBox(doc, many);
    topLevelSelection(doc, many);
    const place = displayPlacements(doc);
    for (const id of many) place(doc.nodes[id]);
    return performance.now() - started;
  };
  run();
  const best = Math.min(run(), run(), run(), run(), run());
  t.diagnostic(`speed factor ${speedFactor().toFixed(2)}; ${best.toFixed(1)} ms`);
  assert.ok(best <= budget(30), `${best.toFixed(1)} ms (budget ${budget(30).toFixed(1)})`);
});
