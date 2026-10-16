import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout} from '../shared/design/defaults';
import {worldBox} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import {
  ancestors, childNames, commonParent, comparePaintPaths, descendants, frameAtPoint, hitOrder, isAncestor, isComponentLike, isInsideInstance,
  isLockedInTree, isVisibleInTree, nearestFrameLike, nextLayerName, nextNumberedName, pageIdOf, paintOrder, paintPath, siblingIndex, sortByPaintOrder,
  topLevelSelection, uniqueName, type SpatialIndex,
} from '../shared/design/tree';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {Rect} from '../shared/design/geometry';

const context = {measurer: {width: (text: string) => text.length * 8, metrics: () => ({ascent: 12, descent: 4})}};

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit(context).doc;
}

/** A test index: every node on the page whose world box meets the rect (what a real index returns, unordered). */
function bruteIndex(doc: DesignDocument, pageId: NodeId): SpatialIndex {
  return {
    query: (rect: Rect) => descendants(doc, pageId).filter(id => {
      const box = worldBox(doc, id);
      return box.x <= rect.x + rect.width && rect.x <= box.x + box.width && box.y <= rect.y + rect.height && rect.y <= box.y + box.height;
    }).reverse(),
  };
}

const doc = build(add => {
  add('FRAME', 'f', 'page', {x: 0, y: 0, width: 400, height: 300});
  add('GROUP', 'g', 'f');
  add('RECTANGLE', 'a', 'g', {x: 10, y: 10});
  add('RECTANGLE', 'b', 'g', {x: 50, y: 50});
  add('TEXT', 't', 'f');
  add('INSTANCE', 'i', 'page', {x: 500, y: 0});
  add('RECTANGLE', 'i;m1', 'i', {mainId: 'm1'});
  add('SECTION', 's', 'page', {x: 0, y: 400, width: 600, height: 400});
  add('FRAME', 'sf', 's', {x: 20, y: 20, width: 200, height: 200});
});

test('ancestry and paths', () => {
  assert.deepEqual(ancestors(doc, 'a'), ['g', 'f', 'page']);
  assert.ok(isAncestor(doc, 'f', 'a'));
  assert.ok(!isAncestor(doc, 'a', 'a'));
  assert.deepEqual(descendants(doc, 'f'), ['g', 'a', 'b', 't']);
  assert.equal(pageIdOf(doc, 'b'), 'page');
  assert.equal(pageIdOf(doc, 'nope'), null);
  assert.equal(siblingIndex(doc, 'b'), 1);
  assert.equal(nearestFrameLike(doc, 'a'), 'f');
  assert.equal(nearestFrameLike(doc, 'sf'), 's');
  assert.equal(nearestFrameLike(doc, 'f'), null);
  assert.equal(nearestFrameLike(doc, 'f', {includeSelf: true}), 'f');
  assert.ok(isInsideInstance(doc, 'i;m1'));
  assert.ok(!isInsideInstance(doc, 'i'));
  assert.ok(isComponentLike(doc.nodes.i));
});

test('paint order is a pre-order walk; hit order its reverse; reversed z-index is honoured', () => {
  assert.deepEqual(paintOrder(doc, 'page'), ['f', 'g', 'a', 'b', 't', 'i', 'i;m1', 's', 'sf']);
  assert.deepEqual(hitOrder(doc, 'page'), ['sf', 's', 'i;m1', 'i', 't', 'b', 'a', 'g', 'f']);
  assert.deepEqual(sortByPaintOrder(doc, ['sf', 'a', 'f', 't', 'a']), ['f', 'a', 't', 'sf']);
  assert.ok(comparePaintPaths(paintPath(doc, 'f'), paintPath(doc, 'a')) < 0);
  const reversed = build(add => {
    add('FRAME', 'row', 'page', {autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemReverseZIndex: true}});
    add('RECTANGLE', 'first', 'row');
    add('RECTANGLE', 'second', 'row');
  });
  assert.deepEqual(paintOrder(reversed, 'page'), ['row', 'second', 'first']);
});

test('paint paths in long children lists: indexed once, right after a reorder in place, reversed z-index honoured', () => {
  const many = build(add => {
    add('FRAME', 'big', 'page', {width: 1000, height: 1000});
    for (let i = 0; i < 300; i++) add('RECTANGLE', `r${i}`, 'big');
    add('FRAME', 'rev', 'page', {autoLayout: {...defaultAutoLayout('HORIZONTAL'), itemReverseZIndex: true}});
    for (let i = 0; i < 40; i++) add('RECTANGLE', `q${i}`, 'rev');
  });
  assert.deepEqual(paintPath(many, 'r250'), [0, 0, 250]);
  assert.deepEqual(paintPath(many, 'q0'), [0, 1, 39], 'the first child of a reversed row paints last');
  const order = paintOrder(many, 'page');
  const shuffled = order.map((id, i) => ({id, k: (i * 7919) % order.length})).sort((a, b) => a.k - b.k).map(entry => entry.id);
  assert.deepEqual(sortByPaintOrder(many, shuffled), order);
  // A list a transaction is still reordering in place: the cached index is checked, not trusted.
  const children = many.nodes.big.children as NodeId[];
  paintPath(many, 'r10');
  [children[10], children[11]] = [children[11], children[10]];
  assert.deepEqual(paintPath(many, 'r10'), [0, 0, 11]);
  assert.deepEqual(paintPath(many, 'r11'), [0, 0, 10]);
});

test('selection helpers', () => {
  assert.deepEqual(topLevelSelection(doc, ['a', 'g', 't', 'a', 'gone']), ['g', 't']);
  assert.equal(commonParent(doc, ['a', 'b']), 'g');
  assert.equal(commonParent(doc, ['a', 't']), 'f');
  assert.equal(commonParent(doc, ['a', 'sf']), 'page');
  assert.equal(commonParent(doc, ['f']), 'page');
  assert.equal(commonParent(doc, []), null);
});

test('visibility and locks are inherited', () => {
  const tx = beginTransaction(doc);
  tx.update('g', {visible: false});
  tx.update('f', {locked: true});
  const next = tx.commit(context).doc;
  assert.ok(!isVisibleInTree(next, 'a'));
  assert.ok(isVisibleInTree(next, 't'));
  assert.ok(isLockedInTree(next, 't'));
  assert.ok(!isLockedInTree(next, 'i'));
});

test('frameAtPoint: the top-most frame or section under a point, with or without an index', () => {
  const nested = build(add => {
    add('FRAME', 'outer', 'page', {width: 300, height: 300});
    add('FRAME', 'inner', 'outer', {x: 50, y: 50, width: 100, height: 100});
    add('GROUP', 'grp', 'outer');
    add('FRAME', 'inGroup', 'grp', {x: 200, y: 200, width: 50, height: 50});
    add('FRAME', 'clipped', 'outer', {x: 280, y: 0, width: 100, height: 100});
    add('INSTANCE', 'inst', 'page', {x: 400, y: 0, width: 100, height: 100});
    add('FRAME', 'hidden', 'page', {x: 600, y: 0, visible: false});
    add('SECTION', 'sec', 'page', {x: 0, y: 500, width: 500, height: 500});
    add('FRAME', 'secFrame', 'sec', {x: 10, y: 10, width: 100, height: 100});
  });
  const cases: [x: number, y: number, expected: NodeId | null][] = [
    [60, 60, 'inner'], [10, 10, 'outer'], [210, 210, 'inGroup'], [290, 10, 'clipped'], [350, 10, null],
    [450, 50, null], [650, 50, null], [20, 520, 'secFrame'], [300, 700, 'sec'], [-5, -5, null],
  ];
  for (const [x, y, expected] of cases) {
    assert.equal(frameAtPoint(nested, 'page', {x, y}), expected, `scan at ${x},${y}`);
    assert.equal(frameAtPoint(nested, 'page', {x, y}, new Set(), bruteIndex(nested, 'page')), expected, `index at ${x},${y}`);
  }
  assert.equal(frameAtPoint(nested, 'page', {x: 60, y: 60}, new Set(['inner'])), 'outer', 'dragged frames are skipped');
  assert.equal(frameAtPoint(nested, 'page', {x: 60, y: 60}, new Set(['outer'])), null, 'with their subtree');
});

test('names', () => {
  assert.equal(uniqueName('Frame', ['Frame', 'Frame 2']), 'Frame 3');
  assert.equal(uniqueName('Button', ['Frame']), 'Button');
  assert.equal(nextNumberedName('Group', ['Group 1', 'Group 7', 'Group x', 'Frame 9']), 'Group 8');
  assert.equal(nextNumberedName('Group (copy)', []), 'Group (copy) 1');
  // New layers are numbered by type across the page, as in Figma, not per frame.
  const named = build(add => {
    add('FRAME', 'screen', 'page', {name: 'Screen'});
    add('RECTANGLE', 'r1', 'page', {name: 'Rectangle 1'});
    add('GROUP', 'g', 'screen', {name: 'Group 1'});
    add('RECTANGLE', 'r4', 'g', {name: 'Rectangle 4'});
    add('RECTANGLE', 'odd', 'screen', {name: 'Rectangle 2b'});
  });
  assert.equal(nextLayerName(named, 'page', 'Rectangle'), 'Rectangle 5');
  assert.equal(nextLayerName(named, 'page', 'Ellipse'), 'Ellipse 1');
  const twoPages = {...named, pages: [...named.pages, 'other'], nodes: {...named.nodes, other: createNode('PAGE', {id: 'other', children: []})}};
  assert.equal(nextLayerName(twoPages, 'other', 'Rectangle'), 'Rectangle 1', 'another page counts its own');
  assert.deepEqual(childNames(doc, 'g'), ['Rectangle', 'Rectangle']);
});
