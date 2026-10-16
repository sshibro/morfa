import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decorationRect, GREEK_BELOW_PX, graphemes, greekBar, letterSpacingPx} from '../src/design/engine/render/text-math';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const line = {baseline: 40, ascent: 16, descent: 4};

test('underlines sit under the baseline by a quarter of the descent, 1/15 em thick', () => {
  const rect = decorationRect('UNDERLINE', {x: 10, width: 50}, line, 15)!;
  close(rect.height, 1);
  close(rect.y, 40 + 1);
  assert.deepEqual([rect.x, rect.width], [10, 50]);
});

test('strike-through crosses 0.3 of the ascent above the baseline', () => {
  const rect = decorationRect('STRIKETHROUGH', {x: 0, width: 20}, line, 30)!;
  close(rect.y + rect.height / 2, 40 - 16 * 0.3);
  close(rect.height, 2);
});

test('no decoration, zero width or zero size draws nothing; thin text keeps a visible line', () => {
  assert.equal(decorationRect('NONE', {x: 0, width: 20}, line, 16), null);
  assert.equal(decorationRect('UNDERLINE', {x: 0, width: 0}, line, 16), null);
  assert.equal(decorationRect('UNDERLINE', {x: 0, width: 10}, line, 0), null);
  assert.equal(decorationRect('UNDERLINE', {x: 0, width: 10}, line, 2)!.height, 0.5);
});

test('letter spacing: pixels as given, percent of the font size', () => {
  assert.equal(letterSpacingPx({unit: 'PIXELS', value: 3}, 20), 3);
  assert.equal(letterSpacingPx({unit: 'PERCENT', value: 10}, 20), 2);
  assert.equal(letterSpacingPx(undefined, 20), 0);
});

test('tiny text becomes a soft bar on its baseline; graphemes keep clusters whole', () => {
  assert.equal(GREEK_BELOW_PX, 4);
  assert.deepEqual(greekBar({x: 5, width: 30}, 20, 10), {x: 5, y: 15, width: 30, height: 5});
  assert.deepEqual(graphemes('ab'), ['a', 'b']);
  assert.equal(graphemes('e\u0308👍🏽').length, 2, 'a combining mark and an emoji with a skin tone are one cluster each');
});
