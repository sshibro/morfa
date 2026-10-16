import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {moveSelectedPoints, selectedPointsBox} from '../src/design/panels/design/layout/points';

// "Point" in the "Design" panel while a path is edited, as Figma shows it: the selected points' X and Y in the space the
// layer's own X and Y are read in, and typing a value moves those points (the others stay).

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

type Add = (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void;
function build(recipe: (add: Add) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, name: id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

/** A 100 × 50 rectangle at (20, 30) in a frame at (200, 100): its outline's anchors run from its top-left clockwise. */
const doc = build(add => {
  add('FRAME', 'frame', 'page', {x: 200, y: 100, width: 400, height: 400});
  add('RECTANGLE', 'rect', 'frame', {x: 20, y: 30, width: 100, height: 50});
});

test('should read the selected points in the layer\'s display space when a path is edited', () => {
  assert.deepEqual(selectedPointsBox(doc, 'rect', ['0.0.0']), {x: 20, y: 30, count: 1});
  assert.deepEqual(selectedPointsBox(doc, 'rect', ['0.0.1', '0.0.2']), {x: 120, y: 30, count: 2});
  assert.equal(selectedPointsBox(doc, 'rect', []), null);
});

test('should move only the selected points when their X is typed', () => {
  const tx = beginTransaction(doc);

  moveSelectedPoints(tx, 'rect', ['0.0.1', '0.0.2'], 'x', 150);

  const after = tx.commit({measurer}).doc;
  assert.deepEqual(selectedPointsBox(after, 'rect', ['0.0.1', '0.0.2']), {x: 150, y: 30, count: 2});
  assert.deepEqual(selectedPointsBox(after, 'rect', ['0.0.0']), {x: 20, y: 30, count: 1}, 'the left points stay');
  assert.equal(after.nodes.rect.width, 130);
});
