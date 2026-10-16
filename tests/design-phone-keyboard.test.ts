import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keyboardInset, revealAbove} from '../src/design/editor/phone/keyboard';

// The on-screen keyboard on a phone (src/design/editor/phone/keyboard.ts): how much it covers, and how far the canvas
// pans to keep what is typed in sight.

test('should measure the keyboard as the layout height the visual viewport lost', () => {
  assert.equal(keyboardInset(844, {height: 500, offsetTop: 0}), 344);
});

test('should measure no keyboard when the visual viewport is only scrolled', () => {
  assert.equal(keyboardInset(844, {height: 844, offsetTop: 0}), 0);
});

test('should lift a text above the keyboard when the keyboard covers it', () => {
  const next = revealAbove({x: 0, y: 0, zoom: 2}, {x: 50, y: 600, width: 100, height: 40}, 0, 500);

  assert.deepEqual(next, {x: 0, y: (600 + 40 + 24 - 500) / 2, zoom: 2});
});

test('should leave the canvas alone when the text is above the keyboard', () => {
  assert.equal(revealAbove({x: 0, y: 0, zoom: 1}, {x: 50, y: 100, width: 100, height: 40}, 0, 500), null);
});

test('should not lift a text\'s top out of sight when it is taller than what is left', () => {
  const next = revealAbove({x: 0, y: 0, zoom: 1}, {x: 0, y: 100, width: 100, height: 900}, 60, 500);

  assert.deepEqual(next, {x: 0, y: 40, zoom: 1});
});
