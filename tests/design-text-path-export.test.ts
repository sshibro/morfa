import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportSvg} from '../shared/design/svg-export';
import {createDocument, createNode, defaultTextProps, solid, BLACK} from '../shared/design/defaults';
import type {DesignDocument, PathCommand, SceneNode} from '../shared/design/types';
import {layoutText, type TextMeasurer} from '../shared/design/text-layout';
import {textPathLayout} from '../shared/design/text-path';
import {cssForLayers, needsSvg} from '../shared/design/codegen/css';
import {toReact} from '../shared/design/codegen/react';
import {outlineStroke} from '../shared/design/outline-stroke';
import {pointInPaths} from '../shared/design/paths';
import {hitTest} from '../src/design/engine/hit-test';
import {pdfPageSvg, pdfPagePlan, recordMeasurements} from '../shared/design/pdf-export';

// Exports of "Text on path" and "Width profile": the SVG (and the PDF built from it) places every glyph where the
// canvas does, the stroke profile is the same filled outline, the code says what CSS cannot draw.

const measurer: TextMeasurer = {
  width: (text, font) => [...text].length * font.size * 0.5,
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

// An arc whose top touches the box's top edge: the glyphs on it stand above the box.
const arc: PathCommand[] = [{type: 'M', x: 0, y: 100}, {type: 'C', x1: 50, y1: -100 / 3, x2: 150, y2: -100 / 3, x: 200, y: 100}];

function documentWith(source: SceneNode[]): DesignDocument {
  const doc = createDocument('page');
  for (const node of structuredClone(source)) {
    doc.nodes[node.id] = node;
    const parent = doc.nodes[node.parentId!];
    parent.children = [...(parent.children ?? []), node.id];
  }
  return doc;
}

const pathText = (): SceneNode => createNode('TEXT', {
  id: 't', parentId: 'page', x: 10, y: 10, width: 200, height: 100, fills: [solid(BLACK)],
  text: {...defaultTextProps('Arch'), textAutoResize: 'NONE', textAlignVertical: 'BOTTOM', textAlignHorizontal: 'CENTER'},
  textPath: {commands: arc, startOffset: 0.5, side: 'LEFT'},
});

test('SVG: a tspan per glyph at the place and angle the canvas uses', () => {
  const node = pathText();
  const svg = exportSvg(documentWith([node]), ['t'], {measurer});
  const placed = textPathLayout(node, layoutText(node, measurer));
  const tspans = [...svg.matchAll(/<tspan([^>]*)>([^<]*)<\/tspan>/g)];
  assert.equal(tspans.length, 4);
  assert.deepEqual(tspans.map(t => t[2]), ['A', 'r', 'c', 'h']);
  for (const [i, t] of tspans.entries()) {
    const x = Number(/ x="([^"]+)"/.exec(t[1])![1]), rotate = Number(/rotate="([^"]+)"/.exec(t[1])![1]);
    // The SVG's origin is the text's painted corner: compare relative positions.
    const first = Number(/ x="([^"]+)"/.exec(tspans[0][1])![1]);
    assert.ok(Math.abs((x - first) - (placed.glyphs[i].origin.x - placed.glyphs[0].origin.x)) < 0.01);
    assert.ok(Math.abs(rotate - (placed.glyphs[i].angle * 180) / Math.PI) < 0.01, `${rotate}`);
  }
  // The viewBox holds the glyphs that stand above the path's box.
  const height = Number(/<svg[^>]* height="([^"]+)"/.exec(svg)![1]);
  assert.ok(height > 100, String(height));
});

test('PDF: the print SVG carries the same glyphs, its measurements recorded', () => {
  const doc = documentWith([pathText()]);
  const recorder = recordMeasurements(measurer);
  const plan = pdfPagePlan(doc, 't')!;
  const page = pdfPageSvg(doc, plan, 0, {measurer: recorder.measurer});
  assert.equal([...page.svg.matchAll(/<tspan/g)].length, 4);
  assert.ok(recorder.table().widths.length > 0);
});

test('SVG and "Outline stroke": a width profile is the filled outline', () => {
  const line = createNode('LINE', {id: 'l', parentId: 'page', x: 0, y: 0, width: 100, height: 0, strokes: [solid(BLACK)], strokeWeight: 10, variableWidthStrokeProperties: {widthProfile: 'WEDGE'}});
  const svg = exportSvg(documentWith([line]), ['l'], {measurer});
  assert.ok(!svg.includes('stroke-width'), svg.slice(0, 400));
  assert.ok(/<path[^>]* d="M/.test(svg));
  const outline = outlineStroke(line);
  assert.ok(outline.length);
  assert.ok(pointInPaths(outline, {x: 2, y: 4}));
  assert.ok(!pointInPaths(outline, {x: 98, y: 4}));
});

test('code: text on a path is SVG, and CSS says why', () => {
  const doc = documentWith([pathText()]);
  assert.equal(needsSvg(doc.nodes.t), true);
  assert.match(cssForLayers(doc, ['t']), /Text on a path: CSS has no such thing/);
  const react = toReact(doc, ['t'], {styling: 'css-modules', measurer});
  const code = react.files.map(file => file.contents).join('\n');
  assert.match(code, /<svg/);
  assert.match(code, /<tspan/);
});

test('picking: a text on a path is hit along its path, not in the empty middle of its box', () => {
  const doc = documentWith([pathText()]);
  // On the arc's top (x 110, y 10 on the page) and well inside the box under it.
  assert.equal(hitTest(doc, 'page', {x: 110, y: 5}, {tolerance: 2}), 't');
  assert.equal(hitTest(doc, 'page', {x: 110, y: 105}, {tolerance: 2}), null);
});
