import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LONG_PRESS_MS, TouchGestures, type TouchClaim, type TouchHost, type TouchPoint} from '../src/design/engine/touch/gestures';
import type {Viewport} from '../src/design/engine/contracts';

// Fingers on the canvas (src/design/engine/touch/gestures.ts): what one finger, two fingers, a tap, a double tap and a
// long press tell the canvas. The host records the calls; events are the touch points themselves.

type Call = string;

function setup(claim: TouchClaim = 'pan') {
  const calls: Call[] = [];
  let view: Viewport = {x: 0, y: 0, zoom: 1};
  let pending: (() => void) | null = null;
  const host: TouchHost<TouchPoint> = {
    claim: () => claim,
    toolDown: e => calls.push(`down ${e.at.x},${e.at.y}`),
    toolMove: e => calls.push(`move ${e.at.x},${e.at.y}`),
    toolUp: e => calls.push(`up ${e.at.x},${e.at.y}`),
    toolCancel: () => calls.push('cancel'),
    viewport: () => view,
    setViewport: next => {
      view = next;
    },
    contextMenu: e => calls.push(`menu ${e.at.x},${e.at.y}`),
    doubleTap: e => calls.push(`double ${e.at.x},${e.at.y}`),
    later: run => {
      pending = run;
      return () => {
        pending = null;
      };
    },
  };
  const gestures = new TouchGestures(host);
  const p = (id: number, x: number, y: number, time = 0): TouchPoint => ({id, at: {x, y}, time});
  const send = {
    down: (point: TouchPoint) => gestures.down(point, point),
    move: (point: TouchPoint) => gestures.move(point, point),
    up: (point: TouchPoint) => gestures.up(point, point),
  };
  return {calls, gestures, p, send, view: () => view, fireHold: () => pending?.()};
}

test('should click the tool where the finger landed when one finger taps empty canvas', () => {
  const {calls, p, send} = setup('pan');

  send.down(p(1, 100, 100));
  send.up(p(1, 102, 101));

  assert.deepEqual(calls, ['down 100,100', 'up 102,101']);
});

test('should pan and leave the tool alone when one finger drags empty canvas', () => {
  const {calls, p, send, view} = setup('pan');

  send.down(p(1, 100, 100));
  send.move(p(1, 130, 140));
  send.move(p(1, 150, 160));
  send.up(p(1, 150, 160));

  assert.deepEqual(calls, []);
  assert.deepEqual(view(), {x: -50, y: -60, zoom: 1});
});

test('should not move a selected layer when the finger wanders less than the slop', () => {
  const {calls, p, send} = setup('grab');

  send.down(p(1, 100, 100));
  send.move(p(1, 104, 103));
  send.up(p(1, 104, 103));

  assert.deepEqual(calls, ['down 100,100', 'up 104,103']);
});

test('should give the tool the drag when one finger drags a selected layer past the slop', () => {
  const {calls, p, send} = setup('grab');

  send.down(p(1, 100, 100));
  send.move(p(1, 104, 100));
  send.move(p(1, 130, 100));
  send.up(p(1, 130, 100));

  assert.deepEqual(calls, ['down 100,100', 'move 130,100', 'up 130,100']);
});

test('should give a drawing tool every move when one finger draws', () => {
  const {calls, p, send} = setup('draw');

  send.down(p(1, 100, 100));
  send.move(p(1, 102, 100));
  send.up(p(1, 102, 100));

  assert.deepEqual(calls, ['down 100,100', 'move 102,100', 'up 102,100']);
});

test('should cancel the tool\'s drag and zoom when a second finger lands mid-drag', () => {
  const {calls, p, send, view} = setup('grab');

  send.down(p(1, 100, 100));
  send.move(p(1, 140, 100));
  send.down(p(2, 200, 100));
  send.move(p(2, 240, 100));
  send.up(p(2, 240, 100));
  send.up(p(1, 140, 100));

  assert.deepEqual(calls, ['down 100,100', 'move 140,100', 'cancel']);
  assert.ok(Math.abs(view().zoom - 100 / 60) < 1e-9);
});

test('should change nothing on the tool when two fingers pinch on empty canvas', () => {
  const {calls, p, send, view} = setup('pan');

  send.down(p(1, 100, 100));
  send.down(p(2, 200, 100));
  send.move(p(1, 50, 100));
  send.move(p(2, 250, 100));
  send.up(p(1, 50, 100));
  send.move(p(2, 400, 100));
  send.up(p(2, 400, 100));

  assert.deepEqual(calls, []);
  assert.equal(view().zoom, 2);
});

test('should double click when two taps land close together in time and place', () => {
  const {calls, p, send} = setup('grab');

  send.down(p(1, 100, 100, 0));
  send.up(p(1, 100, 100, 80));
  send.down(p(1, 105, 102, 200));
  send.up(p(1, 105, 102, 260));

  assert.equal(calls.at(-1), 'double 105,102');
});

test('should not double click when the second tap comes too late', () => {
  const {calls, p, send} = setup('grab');

  send.down(p(1, 100, 100, 0));
  send.up(p(1, 100, 100, 80));
  send.down(p(1, 100, 100, 900));
  send.up(p(1, 100, 100, 960));

  assert.ok(!calls.some(call => call.startsWith('double')));
});

test('should put the press back and open the context menu as the finger lifts when it was held still', () => {
  const {calls, p, send, fireHold} = setup('grab');

  send.down(p(1, 100, 100));
  fireHold();
  send.up(p(1, 100, 100, LONG_PRESS_MS + 10));

  assert.deepEqual(calls, ['down 100,100', 'cancel', 'menu 100,100']);
});

test('should not open the context menu when the held finger moved', () => {
  const {calls, p, send, fireHold} = setup('pan');

  send.down(p(1, 100, 100));
  send.move(p(1, 150, 100));
  fireHold();
  send.up(p(1, 150, 100));

  assert.deepEqual(calls, []);
});

test('should open no context menu when a second finger lands on a held press', () => {
  const {calls, p, send, fireHold} = setup('pan');

  send.down(p(1, 100, 100));
  fireHold();
  send.down(p(2, 200, 100));
  send.up(p(1, 100, 100));
  send.up(p(2, 200, 100));

  assert.ok(!calls.some(call => call.startsWith('menu')));
});
