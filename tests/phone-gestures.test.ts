import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SHEET_CLOSE_DISTANCE, SHEET_CLOSE_VELOCITY, SHEET_DRAG_SLOP, sheetCloses, sheetOffset} from '../src/design/ui/phone/sheet-gesture';

test('should close a sheet when it is let go far enough down', () => {
  assert.equal(sheetCloses(SHEET_CLOSE_DISTANCE, 0), true);
});

test('should keep a sheet open when a slow drag stops short of the line', () => {
  assert.equal(sheetCloses(SHEET_CLOSE_DISTANCE - 1, SHEET_CLOSE_VELOCITY / 2), false);
});

test('should close a sheet when a short drag is a flick down', () => {
  assert.equal(sheetCloses(SHEET_DRAG_SLOP + 4, SHEET_CLOSE_VELOCITY), true);
});

test('should keep a sheet open when the finger only tapped', () => {
  assert.equal(sheetCloses(SHEET_DRAG_SLOP, SHEET_CLOSE_VELOCITY * 2), false);
});

test('should keep a sheet open when it is flicked up', () => {
  assert.equal(sheetCloses(-SHEET_CLOSE_DISTANCE, -SHEET_CLOSE_VELOCITY * 2), false);
});

test('should follow the finger down and resist it up', () => {
  assert.equal(sheetOffset(40), 40);
  assert.equal(sheetOffset(-40), -10);
});

test('should keep a long press when the finger drifts within the slop', async () => {
  const {LONG_PRESS_SLOP, stillHolding} = await import('../src/design/files/phone/long-press');
  assert.equal(stillHolding(LONG_PRESS_SLOP / 2, LONG_PRESS_SLOP / 2), true);
});

test('should cancel a long press when the finger scrolls away', async () => {
  const {LONG_PRESS_SLOP, stillHolding} = await import('../src/design/files/phone/long-press');
  assert.equal(stillHolding(0, LONG_PRESS_SLOP + 1), false);
});
