import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {hitHandle} from '../src/design/engine/tools/transform';
import {selectionBox} from '../src/design/engine/selection';
import {hitTolerancePx, HIT_TOLERANCE_PX, TOUCH_HIT_TOLERANCE_PX} from '../src/design/engine/hit-test';

// Handles on touch (src/design/engine/tools/transform.ts `hitHandle` with `touch`): a 44 px target around each, what is
// drawn unchanged, and a small layer's middle still moves it.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const VIEW = {x: 0, y: 0, zoom: 1};

function rectangle(width: number, height: number): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('RECTANGLE', {id: 'r', x: 100, y: 100, width, height}), 'page');
  return tx.commit({measurer}).doc;
}

const hit = (doc: DesignDocument, x: number, y: number, touch: boolean) => hitHandle(doc, selectionBox(doc, ['r'])!, {x, y}, VIEW, {touch});

test('should grab a corner from 20 px away when the pointer is a finger', () => {
  const doc = rectangle(200, 200);

  assert.deepEqual(hit(doc, 300 + 14, 300 + 14, true), {kind: 'resize', hx: 1, hy: 1});
});

test('should not grab a corner from 20 px away when the pointer is a mouse', () => {
  const doc = rectangle(200, 200);

  assert.notDeepEqual(hit(doc, 300 + 14, 300 + 14, false), {kind: 'resize', hx: 1, hy: 1});
});

test('should leave the middle of a small layer free when a finger presses it', () => {
  const doc = rectangle(40, 40);

  assert.equal(hit(doc, 120, 120, true), null);
});

test('should still grab a small layer\'s corner from outside when a finger presses there', () => {
  const doc = rectangle(40, 40);

  assert.deepEqual(hit(doc, 100 - 15, 100 - 15, true), {kind: 'resize', hx: -1, hy: -1});
});

test('should pick from further away when the pointer is a finger', () => {
  assert.equal(hitTolerancePx('touch'), TOUCH_HIT_TOLERANCE_PX);
  assert.equal(hitTolerancePx('mouse'), HIT_TOLERANCE_PX);
  assert.ok(TOUCH_HIT_TOLERANCE_PX > HIT_TOLERANCE_PX);
});
