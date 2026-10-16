import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sheetHeight, sheetStopAfterDrag} from '../src/design/editor/phone/sheet-model';

// The phone's bottom sheets (src/design/editor/phone/sheet-model.ts): two stops, half and nearly full, and where a drag
// of the handle lets go.

const SCREEN = 844;

test('should be half the screen when the sheet is at its half stop', () => {
  assert.equal(sheetHeight('half', SCREEN), SCREEN / 2);
});

test('should leave the top bar visible when the sheet is at its full stop', () => {
  const full = sheetHeight('full', SCREEN);

  assert.ok(full > SCREEN * 0.8 && full < SCREEN);
});

test('should go to the full stop when the handle is let go nearer to it', () => {
  assert.equal(sheetStopAfterDrag(sheetHeight('full', SCREEN) - 40, 0, SCREEN), 'full');
});

test('should go to the half stop when the handle is let go between the stops nearer to half', () => {
  assert.equal(sheetStopAfterDrag(SCREEN / 2 + 30, 0, SCREEN), 'half');
});

test('should close when the handle is let go well below the half stop', () => {
  assert.equal(sheetStopAfterDrag(SCREEN / 5, 0, SCREEN), 'closed');
});

test('should follow a flick upwards when the handle is let go fast', () => {
  assert.equal(sheetStopAfterDrag(SCREEN / 2 + 10, 1.2, SCREEN), 'full');
});

test('should follow a flick downwards when the handle is let go fast', () => {
  assert.equal(sheetStopAfterDrag(SCREEN / 2 - 10, -1.2, SCREEN), 'closed');
});
