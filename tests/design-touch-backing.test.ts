import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backingRatio, MAX_TOUCH_RATIO, PINCH_RATIO} from '../src/design/engine/touch/backing';

// The canvas's backing store on a phone (src/design/engine/touch/backing.ts).

test('should keep the screen\'s ratio when the pointer is a mouse', () => {
  assert.equal(backingRatio(3, false), 3);
});

test('should stop at the touch cap when a 3× phone draws the canvas', () => {
  assert.equal(backingRatio(3, true), MAX_TOUCH_RATIO);
});

test('should keep a lower ratio when the phone\'s screen is below the cap', () => {
  assert.equal(backingRatio(1.5, true), 1.5);
});

test('should draw coarser when two fingers are pinching', () => {
  assert.equal(backingRatio(3, true, true), PINCH_RATIO);
});

test('should fall back to 1 when the browser reports no ratio', () => {
  assert.equal(backingRatio(0, false), 1);
});
