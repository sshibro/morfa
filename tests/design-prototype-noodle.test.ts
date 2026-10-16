import {test} from 'node:test';
import assert from 'node:assert/strict';
import {arrivalDirection, distanceToPolyline, flattenNoodle, noodleBetween, noodleBounds, pointOnNoodle} from '../src/design/prototype/noodle';
import {presentedFrame, presentHash} from '../src/design/prototype/route';
import {parseHex, toHex} from '../src/design/prototype/color';
import {formatMs, reactionSummary, triggerLabel} from '../src/design/prototype/labels';
import {createDocument, createNode} from '../shared/design/defaults';

// The canvas connections' geometry, the player's address and the panel's small formatters.

const source = {x: 0, y: 100, width: 100, height: 40};

test('a connection leaves the side facing its destination and arrives level with the source', () => {
  const right = noodleBetween(source, {x: 300, y: 0, width: 200, height: 400});
  assert.deepEqual(right.start, {x: 100, y: 120});
  assert.deepEqual(right.end, {x: 300, y: 120});
  assert.deepEqual(arrivalDirection(right), {x: 1, y: 0});
  const left = noodleBetween(source, {x: -400, y: 0, width: 200, height: 400});
  assert.deepEqual([left.start, left.end], [{x: 0, y: 120}, {x: -200, y: 120}]);
  assert.deepEqual(arrivalDirection(left), {x: -1, y: 0});
  // Far below: from the bottom edge into the destination's top.
  const below = noodleBetween(source, {x: 0, y: 600, width: 300, height: 200});
  assert.deepEqual([below.start, below.end], [{x: 50, y: 140}, {x: 50, y: 600}]);
  // A destination above the source's level: the arrow lands inside its span, 16 px from the edge.
  const high = noodleBetween(source, {x: 300, y: -500, width: 200, height: 300});
  assert.equal(high.end.y, -500 + 300 - 16);
  // Overlapping boxes (a layer of the same frame): a loop out to the right.
  const loop = noodleBetween(source, {x: -20, y: 0, width: 400, height: 400});
  assert.ok(loop.c1.x > 380 && loop.c2.x > 380);
  assert.equal(loop.end.x, 380);
});

test('hit testing along the curve', () => {
  const noodle = noodleBetween(source, {x: 300, y: 300, width: 200, height: 400});
  const points = flattenNoodle(noodle);
  assert.equal(points.length, 25);
  assert.deepEqual(points[0], noodle.start);
  assert.deepEqual(points.at(-1), noodle.end);
  const middle = pointOnNoodle(noodle, 0.5);
  assert.ok(distanceToPolyline(points, middle) < 1.5);
  assert.ok(distanceToPolyline(points, {x: middle.x + 40, y: middle.y - 40}) > 10);
  const bounds = noodleBounds(noodle);
  for (const p of points) assert.ok(p.x >= bounds.x - 1e-9 && p.x <= bounds.x + bounds.width + 1e-9 && p.y >= bounds.y - 1e-9 && p.y <= bounds.y + bounds.height + 1e-9);
});

test('the player address rides in the hash, after the file id navigation.ts reads', () => {
  const hash = presentHash('f 1', 'a;b');
  assert.equal(hash, '#design/f%201?present=a%3Bb');
  assert.equal(presentedFrame(hash), 'a;b');
  assert.equal(presentedFrame('#design/f1'), null);
  assert.equal(presentedFrame('#design/f1?present='), null);
  assert.equal(presentedFrame('#designs'), null);
  assert.equal(presentedFrame('#site/x?present=y'), null);
});

test('panel formatting: colours, milliseconds from seconds, summaries', () => {
  assert.deepEqual(parseHex('#1E1E1E'), {r: 30 / 255, g: 30 / 255, b: 30 / 255});
  assert.deepEqual(parseHex('fff'), {r: 1, g: 1, b: 1});
  assert.equal(parseHex('#12345'), null);
  assert.equal(parseHex('green'), null);
  assert.equal(toHex({r: 1, g: 0.5, b: 0}), 'FF8000');
  assert.equal(formatMs(0.3), '300 ms');
  assert.equal(formatMs(12.5), '12.5 s');
  assert.equal(triggerLabel({type: 'AFTER_TIMEOUT', timeout: 0.8}), 'After 800 ms');
  const doc = createDocument('page');
  doc.nodes.f = createNode('FRAME', {id: 'f', parentId: 'page', name: 'Code'});
  assert.equal(reactionSummary(doc, {trigger: {type: 'ON_CLICK'}, actions: [{type: 'NODE', navigation: 'NAVIGATE', destinationId: 'f', transition: {type: 'INSTANT'}}]}), 'Navigate to: Code');
  assert.equal(reactionSummary(doc, {trigger: {type: 'ON_CLICK'}, actions: [{type: 'URL', url: 'https://foo.test/', openInNewTab: true}, {type: 'BACK'}]}), 'Open link: foo.test and 1 more');
  assert.equal(reactionSummary(doc, {trigger: {type: 'ON_CLICK'}, actions: []}), 'No action chosen');
});
