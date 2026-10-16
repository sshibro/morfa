import test from 'node:test';
import assert from 'node:assert/strict';
import {BLACK, createNode, solid} from '../shared/design/defaults';
import type {SceneNode, VariableWidthStrokeProperties} from '../shared/design/types';
import {hasVariableWidth, maxWidthFactor, variableWidthOutline, widthAt, widthPointsOf, WIDTH_PROFILE_POINTS} from '../shared/design/stroke-profile';
import {pointInPaths} from '../shared/design/paths';
import {strokeOutsets} from '../shared/design/bounds';
import {validateDocument} from '../shared/design/schema';
import {createDocument} from '../shared/design/defaults';

// "Width profile" (shared/design/stroke-profile.ts): presets and custom points, a monotone width curve, and the filled
// pieces every renderer and exporter draws.

const line = (properties: VariableWidthStrokeProperties | undefined, extra: Partial<SceneNode> = {}): SceneNode =>
  createNode('LINE', {id: 'l', parentId: 'p', width: 100, height: 0, strokes: [solid(BLACK)], strokeWeight: 10, strokeCap: 'NONE', variableWidthStrokeProperties: properties, ...extra});

test('presets: a uniform profile is a plain stroke, the others vary', () => {
  assert.equal(widthPointsOf(undefined), null);
  assert.equal(widthPointsOf({widthProfile: 'UNIFORM'}), null);
  assert.equal(widthPointsOf({widthProfile: 'CUSTOM', variableWidthPoints: [{position: 0, width: 1}, {position: 1, width: 1}]}), null);
  for (const profile of Object.keys(WIDTH_PROFILE_POINTS)) if (profile !== 'UNIFORM') assert.ok(widthPointsOf({widthProfile: profile as 'EYE'}), profile);
  const wedge = widthPointsOf({widthProfile: 'WEDGE'})!;
  assert.equal(widthAt(wedge, 0), 1);
  assert.ok(Math.abs(widthAt(wedge, 0.5) - 0.5) < 1e-9, 'two points taper straight');
  assert.equal(widthAt(wedge, 1), 0);
});

test('the width curve never overshoots its points', () => {
  const eye = widthPointsOf({widthProfile: 'EYE'})!;
  for (let t = 0; t <= 1; t += 0.01) {
    const w = widthAt(eye, t);
    assert.ok(w >= 0 && w <= 1 + 1e-9, `${t}: ${w}`);
  }
  assert.equal(widthAt(eye, 0.5), 1);
  const quarter = widthPointsOf({widthProfile: 'QUARTER_TAPER'})!;
  assert.equal(widthAt(quarter, 0.5), 1);
  let previous = 1;
  for (let t = 0.75; t <= 1; t += 0.01) {
    const w = widthAt(quarter, t);
    assert.ok(w <= previous + 1e-9);
    previous = w;
  }
});

test('the outline: full width where the profile is 1, nothing where it is 0', () => {
  const node = line({widthProfile: 'WEDGE'});
  assert.ok(hasVariableWidth(node));
  const outline = variableWidthOutline(node);
  assert.ok(outline.length);
  // At the start the stroke is 10 wide (±5), half way 5 wide (±2.5), at the end a point.
  assert.ok(pointInPaths(outline, {x: 1, y: 4.5}));
  assert.ok(!pointInPaths(outline, {x: 1, y: 5.5}));
  assert.ok(pointInPaths(outline, {x: 50, y: 2.3}));
  assert.ok(!pointInPaths(outline, {x: 50, y: 2.7}));
  assert.ok(!pointInPaths(outline, {x: 99.5, y: 1}));
  assert.equal(variableWidthOutline(node), outline, 'cached per node');
});

test('only open paths of lines and vectors take a profile', () => {
  assert.equal(hasVariableWidth(line(undefined)), false);
  const closed = createNode('VECTOR', {id: 'v', parentId: 'p', strokes: [solid(BLACK)], strokeWeight: 4, vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 10, y: 0}, {type: 'L', x: 10, y: 10}, {type: 'Z'}]}], variableWidthStrokeProperties: {widthProfile: 'EYE'}});
  assert.equal(hasVariableWidth(closed), false);
  const rect = createNode('RECTANGLE', {id: 'r', parentId: 'p', strokes: [solid(BLACK)], variableWidthStrokeProperties: {widthProfile: 'EYE'}});
  assert.equal(hasVariableWidth(rect), false);
});

test('bounds reach the widest point', () => {
  const node = line({widthProfile: 'CUSTOM', variableWidthPoints: [{position: 0, width: 0.5}, {position: 0.5, width: 3}, {position: 1, width: 0.5}]});
  assert.equal(maxWidthFactor(node.variableWidthStrokeProperties), 3);
  assert.equal(strokeOutsets(node).top, 15);
});

test('the schema stores a profile', () => {
  const doc = createDocument('p');
  doc.nodes.l = line({widthProfile: 'CUSTOM', variableWidthPoints: [{position: 0, width: 0}, {position: 1, width: 2}]});
  doc.nodes.p.children = ['l'];
  assert.equal(validateDocument(structuredClone(doc)).ok, true);
  doc.nodes.l = line({widthProfile: 'CUSTOM', variableWidthPoints: [{position: 2, width: 1}]});
  assert.equal(validateDocument(structuredClone(doc)).ok, false);
});
