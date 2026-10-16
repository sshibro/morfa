import {test} from 'node:test';
import assert from 'node:assert/strict';
import {swipeStep} from '../src/design/prototype/player/phone/swipe';

// A swipe in the player on a phone (src/design/prototype/player/phone/swipe.ts).

test('should go to the next screen when the finger flicks left', () => {
  assert.equal(swipeStep({x: 300, y: 400}, {x: 200, y: 410}, 1), 1);
});

test('should go back when the finger flicks right', () => {
  assert.equal(swipeStep({x: 100, y: 400}, {x: 200, y: 390}, 1), -1);
});

test('should not step when the finger mostly moves up or down', () => {
  assert.equal(swipeStep({x: 100, y: 400}, {x: 170, y: 250}, 1), 0);
});

test('should not step when the flick is short on the screen at the fit scale', () => {
  assert.equal(swipeStep({x: 100, y: 400}, {x: 180, y: 400}, 0.5), 0);
});
