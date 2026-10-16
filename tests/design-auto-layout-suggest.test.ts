import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout} from '../shared/design/defaults';
import type {NodeType, SceneNode} from '../shared/design/types';
import {suggestAutoLayout} from '../shared/design/auto-layout-suggest';

function build() {
  const doc = createDocument('page');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: string}, parentId = 'page') => {
    const node = createNode(type, {...props, parentId});
    doc.nodes[node.id] = node;
    doc.nodes[parentId].children!.push(node.id);
    return node;
  };
  return {doc, add};
}

test('a loose row becomes a horizontal stack in screen order with the typical gap', () => {
  const {doc, add} = build();
  add('RECTANGLE', {id: 'a', x: 100, y: 10, width: 40, height: 40});
  add('RECTANGLE', {id: 'b', x: 152, y: 10, width: 40, height: 40});
  add('RECTANGLE', {id: 'c', x: 50, y: 10, width: 40, height: 40});
  add('RECTANGLE', {id: 'd', x: 202, y: 10, width: 40, height: 40});
  const suggestion = suggestAutoLayout(doc, ['a', 'b', 'c', 'd'])!;
  assert.equal(suggestion.frameId, null, 'loose layers are wrapped');
  assert.deepEqual(suggestion.order, ['c', 'a', 'b', 'd']);
  assert.equal(suggestion.autoLayout.layoutMode, 'HORIZONTAL');
  assert.equal(suggestion.autoLayout.itemSpacing, 10, 'the median gap');
  assert.equal(suggestion.autoLayout.counterAxisAlignItems, 'MIN');
  assert.deepEqual([suggestion.autoLayout.paddingLeft, suggestion.autoLayout.paddingTop], [0, 0]);
  assert.deepEqual(suggestion.box, {x: 50, y: 10, width: 192, height: 40});
  assert.deepEqual(suggestion.sizing, {horizontal: 'HUG', vertical: 'HUG'});
});

test('a column of centred items becomes a vertical stack aligned on the centre', () => {
  const {doc, add} = build();
  add('TEXT', {id: 'title', x: 150, y: 0, width: 100, height: 24});
  add('RECTANGLE', {id: 'image', x: 170, y: 40.4, width: 60, height: 60});
  add('RECTANGLE', {id: 'button', x: 160, y: 116.6, width: 80, height: 32});
  const suggestion = suggestAutoLayout(doc, ['button', 'image', 'title'])!;
  assert.equal(suggestion.autoLayout.layoutMode, 'VERTICAL');
  assert.deepEqual(suggestion.order, ['title', 'image', 'button']);
  assert.equal(suggestion.autoLayout.itemSpacing, 16, 'gaps of 16.4 and 16.2 round to 16');
  assert.equal(suggestion.autoLayout.counterAxisAlignItems, 'CENTER');
});

test('items sharing a bottom edge align to the end', () => {
  const {doc, add} = build();
  add('RECTANGLE', {id: 'a', x: 0, y: 80, width: 20, height: 20});
  add('RECTANGLE', {id: 'b', x: 30, y: 60, width: 20, height: 40});
  add('RECTANGLE', {id: 'c', x: 60, y: 70, width: 20, height: 30});
  assert.equal(suggestAutoLayout(doc, ['a', 'b', 'c'])!.autoLayout.counterAxisAlignItems, 'MAX');
});

test('a frame without auto layout gets it, with the room around its content as padding', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'card', x: 500, y: 300, width: 300, height: 200});
  add('TEXT', {id: 'second', x: 24, y: 80, width: 120, height: 40}, 'card');
  add('TEXT', {id: 'first', x: 24, y: 16, width: 100, height: 50}, 'card');
  add('RECTANGLE', {id: 'ghost', x: 0, y: 0, width: 300, height: 300, visible: false}, 'card');
  const suggestion = suggestAutoLayout(doc, ['card'])!;
  assert.equal(suggestion.frameId, 'card');
  assert.equal(suggestion.autoLayout.layoutMode, 'VERTICAL');
  assert.deepEqual(suggestion.order, ['ghost', 'first', 'second'], 'hidden layers keep a place but shape nothing');
  assert.equal(suggestion.autoLayout.itemSpacing, 14);
  const {paddingLeft, paddingTop, paddingRight, paddingBottom} = suggestion.autoLayout;
  assert.deepEqual([paddingLeft, paddingTop, paddingRight, paddingBottom], [24, 16, 156, 80]);
  assert.deepEqual(suggestion.box, {x: 500, y: 300, width: 300, height: 200});
});

test('one layer, or a frame that already has auto layout, is wrapped; an empty frame keeps its size', () => {
  const {doc, add} = build();
  add('TEXT', {id: 'label', x: 10, y: 20, width: 50, height: 16});
  add('FRAME', {id: 'stack', x: 0, y: 100, width: 80, height: 40, autoLayout: defaultAutoLayout('VERTICAL')});
  add('FRAME', {id: 'empty', x: 0, y: 200, width: 120, height: 90});
  const label = suggestAutoLayout(doc, ['label'])!;
  assert.equal(label.frameId, null);
  assert.equal(label.autoLayout.layoutMode, 'HORIZONTAL');
  assert.equal(label.autoLayout.itemSpacing, 10, 'nothing to infer from: the default gap');
  assert.deepEqual(label.box, {x: 10, y: 20, width: 50, height: 16});
  assert.equal(suggestAutoLayout(doc, ['stack'])!.frameId, null);
  const empty = suggestAutoLayout(doc, ['empty'])!;
  assert.equal(empty.frameId, 'empty');
  assert.deepEqual(empty.sizing, {horizontal: 'FIXED', vertical: 'FIXED'});
  assert.equal(suggestAutoLayout(doc, ['page']), null);
  assert.equal(suggestAutoLayout(doc, []), null);
});

test('layers from different parents are measured on the page', () => {
  const {doc, add} = build();
  add('FRAME', {id: 'f', x: 100, y: 100, width: 50, height: 50});
  add('RECTANGLE', {id: 'inside', x: 10, y: 10, width: 20, height: 20}, 'f');
  add('RECTANGLE', {id: 'outside', x: 150, y: 110, width: 20, height: 20});
  const suggestion = suggestAutoLayout(doc, ['outside', 'inside'])!;
  assert.deepEqual(suggestion.order, ['inside', 'outside']);
  assert.deepEqual(suggestion.box, {x: 110, y: 110, width: 60, height: 20});
  assert.equal(suggestion.autoLayout.itemSpacing, 20);
});
