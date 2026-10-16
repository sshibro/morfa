import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boxBetween, touchedIds, touches} from '../src/design/files/marquee';

const card = (id: string, left: number, top: number) => ({id, box: {left, top, right: left + 100, bottom: top + 80}});
const CARDS = [card('a', 0, 0), card('b', 120, 0), card('c', 0, 100), card('d', 120, 100)];

test('should make the same box whichever way the pointer moved', () => {
  assert.deepEqual(boxBetween({x: 50, y: 60}, {x: 10, y: 20}), {left: 10, top: 20, right: 50, bottom: 60});
});

test('should select the cards the box touches, in their order', () => {
  assert.deepEqual(touchedIds(boxBetween({x: 90, y: 70}, {x: 130, y: 110}), CARDS), ['a', 'b', 'c', 'd']);
  assert.deepEqual(touchedIds(boxBetween({x: 110, y: 10}, {x: 115, y: 200}), CARDS), []);
  assert.deepEqual(touchedIds(boxBetween({x: 130, y: 5}, {x: 140, y: 150}), CARDS), ['b', 'd']);
});

test('should not count a card the box only meets at its edge', () => {
  assert.equal(touches({left: 100, top: 0, right: 110, bottom: 10}, CARDS[0].box), false);
});
