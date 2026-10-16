import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {Rect} from '../shared/design/geometry';
import {SpatialIndex} from '../src/design/engine/render/spatial-index';
import type {SpatialIndex as TreeIndex} from '../shared/design/tree';

function page(): DesignDocument {
  const doc = createDocument('page');
  doc.pages.push('other');
  doc.nodes.other = createNode('PAGE', {id: 'other'});
  return doc;
}
function add(doc: DesignDocument, type: SceneNode['type'], props: Partial<SceneNode> & {id: string}, parentId = 'page'): DesignDocument {
  const node = createNode(type, {...props, parentId});
  const parent = doc.nodes[parentId];
  return {...doc, nodes: {...doc.nodes, [node.id]: node, [parentId]: {...parent, children: [...(parent.children ?? []), node.id]}}};
}
const update = (doc: DesignDocument, id: NodeId, patch: Partial<SceneNode>): DesignDocument => ({...doc, nodes: {...doc.nodes, [id]: {...doc.nodes[id], ...patch}}});
function remove(doc: DesignDocument, id: NodeId): DesignDocument {
  const nodes = {...doc.nodes};
  const drop = (nodeId: NodeId) => {
    for (const child of nodes[nodeId]?.children ?? []) drop(child);
    delete nodes[nodeId];
  };
  const parentId = nodes[id].parentId!;
  drop(id);
  nodes[parentId] = {...nodes[parentId], children: nodes[parentId].children!.filter(c => c !== id)};
  return {...doc, nodes};
}

const covers = (areas: {rect: Rect}[], rect: Rect) => areas.some(({rect: a}) => a.x <= rect.x + 1e-9 && a.y <= rect.y + 1e-9 && a.x + a.width >= rect.x + rect.width - 1e-9 && a.y + a.height >= rect.y + rect.height - 1e-9);
const sorted = (ids: Iterable<NodeId>) => [...ids].sort();

function sameAsFresh(index: SpatialIndex, doc: DesignDocument) {
  const fresh = new SpatialIndex({eager: true});
  fresh.sync(doc, 'page');
  for (const id of Object.keys(doc.nodes)) {
    const a = index.bounds(id), b = fresh.bounds(id);
    if (!a || !b) assert.equal(a, b, `bounds of ${id}`);
    else for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(a[key] - b[key]) < 1e-9, `${id}.${key}: ${a[key]} vs ${b[key]}`);
    assert.equal(index.hasMask(id), fresh.hasMask(id), `mask flag of ${id}`);
  }
  const everywhere = {x: -1e6, y: -1e6, width: 2e6, height: 2e6};
  assert.deepEqual(sorted(index.query(everywhere)), sorted(fresh.query(everywhere)));
}

test('the index satisfies the tree interface and answers rectangle and point queries', () => {
  let doc = page();
  doc = add(doc, 'RECTANGLE', {id: 'a', x: 0, y: 0, width: 10, height: 10});
  doc = add(doc, 'RECTANGLE', {id: 'b', x: 1000, y: 1000, width: 10, height: 10});
  doc = add(doc, 'FRAME', {id: 'big', x: -5000, y: -5000, width: 20000, height: 20000});
  doc = add(doc, 'RECTANGLE', {id: 'elsewhere', x: 0, y: 0, width: 10, height: 10}, 'other');
  const index = new SpatialIndex();
  index.sync(doc, 'page');
  const tree: TreeIndex = index;
  assert.deepEqual(sorted(tree.query({x: -1, y: -1, width: 2, height: 2})), ['a', 'big']);
  assert.deepEqual(sorted(index.queryPoint(1005, 1005)), ['b', 'big']);
  assert.equal(index.bounds('elsewhere'), undefined, 'other pages are not indexed');
});

test('incremental syncs equal a fresh build through moves, resizes, adds, removes, reparenting and masks', () => {
  let doc = page();
  doc = add(doc, 'FRAME', {id: 'f', x: 0, y: 0, width: 300, height: 300});
  doc = add(doc, 'GROUP', {id: 'g', x: 400, y: 0, width: 100, height: 100});
  doc = add(doc, 'RECTANGLE', {id: 'g1', x: 0, y: 0, width: 50, height: 50}, 'g');
  doc = add(doc, 'RECTANGLE', {id: 'g2', x: 50, y: 50, width: 50, height: 50, effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 1}, offset: {x: 0, y: 4}, radius: 8, spread: 0, visible: true, blendMode: 'NORMAL'}]}, 'g');
  doc = add(doc, 'RECTANGLE', {id: 'r', x: 10, y: 10, width: 20, height: 20}, 'f');
  const index = new SpatialIndex();
  index.sync(doc, 'page');
  const steps: ((d: DesignDocument) => DesignDocument)[] = [
    d => update(d, 'r', {x: 40}),
    d => update(d, 'g', {x: 450, rotation: 30}),
    d => update(d, 'g2', {width: 200, strokes: [solid({r: 0, g: 0, b: 0})], strokeWeight: 5, strokeAlign: 'OUTSIDE'}),
    d => add(d, 'ELLIPSE', {id: 'e', x: 5, y: 5, width: 10, height: 10, isMask: true}, 'f'),
    d => update(d, 'f', {clipsContent: false}),
    d => update(d, 'g1', {visible: false}),
    d => {
      // Move r from the frame into the group.
      const moved = {...d.nodes.r, parentId: 'g', x: 0, y: 0};
      return {...d, nodes: {...d.nodes, r: moved, f: {...d.nodes.f, children: d.nodes.f.children!.filter(c => c !== 'r')}, g: {...d.nodes.g, children: [...d.nodes.g.children!, 'r']}}};
    },
    d => remove(d, 'g2'),
    d => update(d, 'e', {isMask: false}),
    d => remove(d, 'g'),
  ];
  for (const step of steps) {
    doc = step(doc);
    index.sync(doc, 'page');
    sameAsFresh(index, doc);
  }
});

test('dirty areas cover the old and the new place of a moved node, and nothing for an untouched one', () => {
  let doc = page();
  doc = add(doc, 'RECTANGLE', {id: 'a', x: 0, y: 0, width: 10, height: 10});
  doc = add(doc, 'RECTANGLE', {id: 'b', x: 500, y: 500, width: 10, height: 10});
  const index = new SpatialIndex();
  index.sync(doc, 'page');
  const moved = update(doc, 'a', {x: 100});
  const {dirty, rebuilt} = index.sync(moved, 'page');
  assert.equal(rebuilt, false);
  assert.ok(covers(dirty, {x: 0, y: 0, width: 10, height: 10}));
  assert.ok(covers(dirty, {x: 100, y: 0, width: 10, height: 10}));
  assert.ok(dirty.every(area => area.id === 'a'));
  assert.equal(index.sync(moved, 'page').dirty.length, 0, 'the same document again is free');
  // Renaming changes nothing on screen.
  assert.equal(index.sync(update(moved, 'b', {name: 'New name'}), 'page').dirty.length, 0);
});

test('a group that refits around its children marks nothing when nothing moved on screen', () => {
  let doc = page();
  doc = add(doc, 'GROUP', {id: 'g', x: 100, y: 100, width: 50, height: 50});
  doc = add(doc, 'RECTANGLE', {id: 'c', x: 0, y: 0, width: 50, height: 50}, 'g');
  const index = new SpatialIndex();
  index.sync(doc, 'page');
  // Normalize shifts the group and compensates its child: same world position.
  const refit = update(update(doc, 'g', {x: 90, y: 90, width: 60, height: 60}), 'c', {x: 10, y: 10});
  assert.deepEqual(index.sync(refit, 'page').dirty, []);
});

test('reordering children marks the ones whose stacking changed; a hint replaces the full comparison', () => {
  let doc = page();
  for (const id of ['a', 'b', 'c']) doc = add(doc, 'RECTANGLE', {id, x: 0, y: 0, width: 10, height: 10});
  const index = new SpatialIndex();
  index.sync(doc, 'page');
  const reordered = update(doc, 'page', {children: ['b', 'a', 'c']});
  assert.deepEqual(sorted(new Set(index.sync(reordered, 'page').dirty.map(area => area.id))), ['a', 'b']);
  const from = reordered;
  const next = update(from, 'c', {y: 300});
  const hinted = index.sync(next, 'page', undefined, {from, ids: ['c']});
  assert.ok(covers(hinted.dirty, {x: 0, y: 300, width: 10, height: 10}));
  sameAsFresh(index, next);
  // A hint for another starting document is ignored safely.
  const later = update(next, 'a', {x: 700});
  const stale = index.sync(later, 'page', undefined, {from, ids: []});
  assert.ok(covers(stale.dirty, {x: 700, y: 0, width: 10, height: 10}));
});

test('switching pages rebuilds', () => {
  let doc = page();
  doc = add(doc, 'RECTANGLE', {id: 'x', x: 0, y: 0, width: 10, height: 10}, 'other');
  const index = new SpatialIndex();
  index.sync(doc, 'page');
  assert.equal(index.sync(doc, 'other').rebuilt, true);
  assert.ok(index.bounds('x'));
});

test('a container that slides shifts its subtree: same as a fresh build, its old and new places dirty', () => {
  let doc = page();
  doc = add(doc, 'FRAME', {id: 'f', x: 0, y: 0, width: 300, height: 300});
  doc = add(doc, 'FRAME', {id: 'inner', x: 20, y: 20, width: 100, height: 100, clipsContent: false}, 'f');
  doc = add(doc, 'RECTANGLE', {id: 'deep', x: 5, y: 5, width: 20, height: 20}, 'inner');
  doc = add(doc, 'RECTANGLE', {id: 'r', x: 200, y: 200, width: 30, height: 30}, 'f');
  // A group, which clips nothing: children far apart, one with a shadow.
  doc = add(doc, 'GROUP', {id: 'g', x: 1000, y: 0, width: 900, height: 600});
  doc = add(doc, 'RECTANGLE', {id: 'g1', x: 0, y: 0, width: 50, height: 50}, 'g');
  doc = add(doc, 'RECTANGLE', {id: 'g2', x: 850, y: 550, width: 50, height: 50, effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 1}, offset: {x: 0, y: 4}, radius: 8, spread: 0, visible: true, blendMode: 'NORMAL'}]}, 'g');
  // A turned frame: its child slides along a turned axis.
  doc = add(doc, 'FRAME', {id: 't', x: 0, y: 800, width: 200, height: 200, rotation: 30});
  doc = add(doc, 'FRAME', {id: 't1', x: 10, y: 10, width: 80, height: 80}, 't');
  doc = add(doc, 'RECTANGLE', {id: 't2', x: 10, y: 10, width: 20, height: 20}, 't1');
  const index = new SpatialIndex();
  index.sync(doc, 'page');
  const steps: [string, (d: DesignDocument) => DesignDocument, NodeId[]][] = [
    ['a frame nudged by 1 px', d => update(d, 'f', {x: 1}), ['f', 'inner', 'deep', 'r']],
    ['across grid cells', d => update(d, 'f', {x: 700, y: 513}), ['f', 'inner', 'deep', 'r']],
    ['a group of far-apart layers', d => update(d, 'g', {x: 1003, y: -2}), ['g1', 'g2']],
    ['inside a turned frame', d => update(d, 't1', {x: 30}), ['t1', 't2']],
    ['the turned frame itself', d => update(d, 't', {y: 900}), ['t1', 't2']],
    ['flipped and resized', d => update(d, 'inner', {flipX: true, width: 140}), ['inner', 'deep']],
    ['a slide with a changed child', d => update(update(d, 'f', {x: 650}), 'deep', {width: 60}), ['f', 'inner', 'deep', 'r']],
    ['nested slides at once', d => update(update(d, 'f', {y: 400}), 'inner', {x: 60}), ['f', 'inner', 'deep', 'r']],
  ];
  for (const [label, step, moved] of steps) {
    const before = moved.map(id => index.bounds(id)!);
    doc = step(doc);
    const {dirty} = index.sync(doc, 'page');
    sameAsFresh(index, doc);
    for (const [i, rect] of before.entries()) assert.ok(covers(dirty, rect), `${label}: the old place of ${moved[i]} is repainted`);
    for (const id of moved) assert.ok(covers(dirty, index.bounds(id)!), `${label}: the new place of ${id} is repainted`);
  }
});

test('a drag that shares one node table slides a frame of many layers by the reported ids', async () => {
  const {createDesignStore} = await import('../src/design/engine/store');
  let doc = page();
  doc = add(doc, 'FRAME', {id: 'f', x: 0, y: 0, width: 400, height: 400});
  for (let i = 0; i < 200; i++) doc = add(doc, 'RECTANGLE', {id: `c${i}`, x: (i % 20) * 20, y: Math.floor(i / 20) * 20, width: 10, height: 10}, 'f');
  const measurer = {width: (text: string) => text.length * 6, metrics: () => ({ascent: 8, descent: 2})};
  const store = createDesignStore({doc, measurer, idle: () => () => {}});
  const index = new SpatialIndex();
  index.sync(doc, 'page', measurer);
  let from = index.document!;
  const ids = new Set<NodeId>();
  store.onDocument(change => change.changed.forEach(id => ids.add(id)));
  const gesture = store.gesture('Move');
  for (let k = 1; k <= 4; k++) {
    gesture.update(tx => tx.update('f', {x: 37 * k, y: 300 * k}));
    const next = store.getState().doc;
    index.sync(next, 'page', measurer, {from, ids: [...ids]});
    ids.clear();
    from = next;
    const fresh = new SpatialIndex();
    fresh.sync(next, 'page', measurer);
    for (const id of ['f', 'c0', 'c77', 'c199']) {
      const a = index.bounds(id)!, b = fresh.bounds(id)!;
      for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(a[key] - b[key]) < 1e-9, `frame ${k}: ${id}.${key}`);
    }
    assert.deepEqual(sorted(index.query({x: 37 * k, y: 300 * k, width: 15, height: 15})), sorted(fresh.query({x: 37 * k, y: 300 * k, width: 15, height: 15})));
  }
  gesture.commit();
});

test('a board section with «hide contents» is bounded by its own box: what it holds does not count', () => {
  let doc = page();
  doc = add(doc, 'SECTION', {id: 's', x: 0, y: 0, width: 200, height: 100, board: {kind: 'section', hidden: true}});
  doc = add(doc, 'RECTANGLE', {id: 'k', x: 150, y: 50, width: 200, height: 200}, 's');
  const index = new SpatialIndex({eager: true});
  index.sync(doc, 'page');
  assert.deepEqual(index.bounds('s'), {x: 0, y: 0, width: 200, height: 100});
  const shown = update(doc, 's', {board: {kind: 'section'}});
  index.sync(shown, 'page');
  assert.deepEqual(index.bounds('s'), {x: 0, y: 0, width: 350, height: 250}, 'shown again, its layer counts');
});
