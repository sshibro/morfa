import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import {LIBRARY_PAGE_ID} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {loadedPagesOf, pageLayerCounts, pageOfEntry, pageSlice, skeletonOf} from '../shared/design/pages';

// Pages loaded on demand (docs/decisions/big-files.md §3–§4): the skeleton, page slices and the page of an entry.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

/** Two pages: `page` holds a frame with a rectangle and a component with a child; `page2` holds a rectangle and a variant set. */
function sample(): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.addPage(createNode('PAGE', {id: 'page2', name: 'Page 2'}));
  const add = (type: SceneNode['type'], id: NodeId, parent: NodeId, props: Partial<SceneNode> = {}) => tx.create(createNode(type, {id, ...props}), parent);
  add('FRAME', 'f', 'page', {width: 300, height: 300});
  add('RECTANGLE', 'r', 'f', {x: 10, y: 10});
  add('COMPONENT', 'c', 'f', {x: 50, y: 50, width: 40, height: 40});
  add('RECTANGLE', 'cr', 'c');
  add('RECTANGLE', 'p2r', 'page2');
  add('COMPONENT_SET', 'set', 'page2', {width: 100, height: 100});
  add('COMPONENT', 'v1', 'set', {name: 'View=A'});
  add('RECTANGLE', 'v1r', 'v1');
  return tx.commit({measurer}).doc;
}

test('skeletonOf keeps pages, components with their subtrees and the loaded pages', () => {
  const doc = sample();
  const skeleton = skeletonOf(doc);
  assert.deepEqual(Object.keys(skeleton.nodes).sort(), ['c', 'cr', 'page', 'page2', 'set', 'v1', 'v1r']);
  assert.equal(skeleton.nodes.page.children!.length, 1, 'the page node keeps its list of layers');
  assert.equal(skeleton.pages, doc.pages);
  assert.equal(skeleton.styles, doc.styles, 'the other tables are the same objects');
  const withPage = skeletonOf(doc, ['page']);
  assert.deepEqual(Object.keys(withPage.nodes).sort(), ['c', 'cr', 'f', 'page', 'page2', 'r', 'set', 'v1', 'v1r']);
  assert.deepEqual([...loadedPagesOf(skeleton)], []);
  assert.deepEqual([...loadedPagesOf(withPage)], ['page']);
  assert.deepEqual([...loadedPagesOf(doc)].sort(), ['page', 'page2']);
});

test('the hidden library page is always whole', () => {
  const doc = sample();
  const library = createNode('PAGE', {id: LIBRARY_PAGE_ID, name: 'Library', children: ['lib']});
  const copy = createNode('COMPONENT', {id: 'lib', parentId: LIBRARY_PAGE_ID, children: ['libr']});
  const libr = createNode('RECTANGLE', {id: 'libr', parentId: 'lib'});
  const withLibrary = {...doc, nodes: {...doc.nodes, [LIBRARY_PAGE_ID]: library, lib: copy, libr}};
  const skeleton = skeletonOf(withLibrary);
  assert.ok(skeleton.nodes[LIBRARY_PAGE_ID] && skeleton.nodes.lib && skeleton.nodes.libr);
  assert.equal(skeleton.nodes.r, undefined);
});

test('pageSlice is the page’s layers, pageLayerCounts counts them', () => {
  const doc = sample();
  assert.deepEqual(Object.keys(pageSlice(doc, 'page')).sort(), ['c', 'cr', 'f', 'r']);
  assert.deepEqual(Object.keys(pageSlice(doc, 'page2')).sort(), ['p2r', 'set', 'v1', 'v1r']);
  assert.deepEqual(pageSlice(doc, 'r'), {}, 'not a page');
  assert.deepEqual(pageLayerCounts(doc), {page: 4, page2: 4});
  assert.deepEqual(pageLayerCounts(skeletonOf(doc)), {page: 0, page2: 3}, 'a skeleton counts only what it holds (page 2’s variant set): the opened file carries the real counts');
});

test('pageOfEntry follows the parent chain through the patch and the document', () => {
  const doc = skeletonOf(sample(), ['page']);
  const read = (patch: Record<NodeId, SceneNode | null>) => (id: NodeId) => (Object.hasOwn(patch, id) ? patch[id] : doc.nodes[id]);
  assert.equal(pageOfEntry(read({}), 'r'), 'page');
  assert.equal(pageOfEntry(read({}), 'cr'), 'resident', 'inside a component');
  assert.equal(pageOfEntry(read({}), 'v1r'), 'resident');
  assert.equal(pageOfEntry(read({}), 'p2r'), null, 'a layer of a page the store does not hold');
  const added = createNode('RECTANGLE', {id: 'new', parentId: 'f'});
  assert.equal(pageOfEntry(read({new: added}), 'new'), 'page');
  const orphan = createNode('RECTANGLE', {id: 'o', parentId: 'ghost'});
  assert.equal(pageOfEntry(read({o: orphan}), 'o'), null);
  const loop = createNode('FRAME', {id: 'loop', parentId: 'loop'});
  assert.equal(pageOfEntry(read({loop}), 'loop'), null, 'a cycle ends');
});
