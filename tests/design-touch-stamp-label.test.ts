import assert from 'node:assert/strict';
import test from 'node:test';
import {stampLabelTarget} from '../src/design/board/tools/stamp-label';

// Who put a stamp, by touch (lane PH): a screen without hover labels the one selected stamp instead.

test('the hovered stamp is labelled, on any screen', () => {
  assert.equal(stampLabelTarget('a', ['b'], false), 'a');
  assert.equal(stampLabelTarget('a', ['b'], true), 'a');
});

test('with no hover, a touch screen labels the one selected node and a mouse screen nothing', () => {
  assert.equal(stampLabelTarget(null, ['b'], true), 'b');
  assert.equal(stampLabelTarget(null, ['b'], false), null);
  assert.equal(stampLabelTarget(null, ['b', 'c'], true), null);
  assert.equal(stampLabelTarget(null, [], true), null);
});
