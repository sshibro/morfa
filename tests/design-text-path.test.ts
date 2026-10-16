import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BLACK, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {PathCommand, SceneNode, TextPathData, TextProps} from '../shared/design/types';
import {layoutText, offsetAt, type FontSpec, type TextMeasurer} from '../shared/design/text-layout';
import {hitsTextPath, placeOnPath, pointAlong, projectOnPath, straightPoint, textPathLayout, textPathSampler} from '../shared/design/text-path';
import {localRenderBounds} from '../shared/design/bounds';
import {textBoxSize} from '../shared/design/text-layout';
import {resizeUpdates} from '../shared/design/constraints';
import {validateDocument} from '../shared/design/schema';
import {createDocument} from '../shared/design/defaults';

// "Text on path" (shared/design/text-path.ts): glyphs follow the path, by alignment, side and start offset; every
// renderer and exporter reads this one placement.

// Every letter is half an em wide, spaces a quarter; ascent 0.8 em, descent 0.2 em.
const measurer: TextMeasurer = {
  width(text: string, font: FontSpec) {
    let width = 0;
    for (const ch of text) width += (ch === ' ' ? 0.25 : 0.5) * font.size;
    return width;
  },
  metrics: (font: FontSpec) => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

const line = (x0: number, y0: number, x1: number, y1: number): PathCommand[] => [{type: 'M', x: x0, y: y0}, {type: 'L', x: x1, y: y1}];
/** A circle of radius r around (r, r), clockwise on screen, starting at 3 o'clock. */
function circle(r: number): PathCommand[] {
  const k = 0.5522847498 * r;
  return [
    {type: 'M', x: 2 * r, y: r},
    {type: 'C', x1: 2 * r, y1: r + k, x2: r + k, y2: 2 * r, x: r, y: 2 * r},
    {type: 'C', x1: r - k, y1: 2 * r, x2: 0, y2: r + k, x: 0, y: r},
    {type: 'C', x1: 0, y1: r - k, x2: r - k, y2: 0, x: r, y: 0},
    {type: 'C', x1: r + k, y1: 0, x2: 2 * r, y2: r - k, x: 2 * r, y: r},
    {type: 'Z'},
  ];
}

function textNode(characters: string, path: TextPathData, text: Partial<TextProps> = {}): SceneNode {
  return createNode('TEXT', {id: 't', parentId: 'p', width: 200, height: 0, fills: [solid(BLACK)], text: {...defaultTextProps(characters), textAutoResize: 'NONE', textAlignVertical: 'BOTTOM', ...text}, textPath: path});
}

test('a straight path: LEFT text starts at the offset, its baseline on the path', () => {
  const node = textNode('ab', {commands: line(0, 50, 200, 50), startOffset: 0.25, side: 'LEFT'});
  const layout = layoutText(node, measurer);
  const placed = textPathLayout(node, layout);
  assert.equal(placed.glyphs.length, 2);
  const [a, b] = placed.glyphs;
  // Font 16 (the default): each letter 8 px. The first starts 50 px along (a quarter of 200).
  assert.equal(a.text, 'a');
  assert.ok(Math.abs(a.origin.x - 50) < 1e-6 && Math.abs(a.origin.y - 50) < 1e-6, JSON.stringify(a.origin));
  assert.ok(Math.abs(b.origin.x - 58) < 1e-6);
  assert.ok(Math.abs(a.angle) < 1e-9);
  // The text stands on the path: its box is above it.
  assert.ok(placed.bounds!.y < 50 && placed.bounds!.y + placed.bounds!.height <= 50 + 16 * 0.2 + 1e-6);
});

test('CENTER and RIGHT place the text around and before the anchor', () => {
  const path = (startOffset: number): TextPathData => ({commands: line(0, 0, 100, 0), startOffset, side: 'LEFT'});
  const center = textPathLayout(textNode('abcd', path(0.5), {textAlignHorizontal: 'CENTER'}), layoutText(textNode('abcd', path(0.5), {textAlignHorizontal: 'CENTER'}), measurer));
  // 4 letters × 8 px = 32 px centred on 50.
  assert.ok(Math.abs(center.glyphs[0].origin.x - 34) < 1e-6, String(center.glyphs[0].origin.x));
  const rightNode = textNode('abcd', path(1), {textAlignHorizontal: 'RIGHT'});
  const right = textPathLayout(rightNode, layoutText(rightNode, measurer));
  assert.ok(Math.abs(right.glyphs[3].origin.x + right.glyphs[3].advance - 100) < 1e-6);
});

test('glyphs past the end of an open path are not drawn; a closed path carries them round', () => {
  const open = textNode('abcdefghij', {commands: line(0, 0, 30, 0), startOffset: 0, side: 'LEFT'});
  assert.equal(textPathLayout(open, layoutText(open, measurer)).glyphs.length, 4);
  const round = textNode('abcdefghij', {commands: circle(5), startOffset: 0.9, side: 'LEFT'});
  assert.equal(textPathLayout(round, layoutText(round, measurer)).glyphs.length, 10);
});

test('glyphs turn with the path, and side RIGHT reads it backwards', () => {
  const node = textNode('a', {commands: line(0, 0, 0, 100), startOffset: 0, side: 'LEFT'});
  const down = textPathLayout(node, layoutText(node, measurer)).glyphs[0];
  assert.ok(Math.abs(down.angle - Math.PI / 2) < 1e-9);
  const flipped = textNode('a', {commands: line(0, 0, 0, 100), startOffset: 0, side: 'RIGHT'});
  const up = textPathLayout(flipped, layoutText(flipped, measurer)).glyphs[0];
  assert.ok(Math.abs(up.angle + Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(up.origin.y - 100) < 1e-6, 'starts at the path\'s far end');
});

test('vertical alignment: TOP hangs the text below the path, CENTER centres it', () => {
  const at = (vertical: TextProps['textAlignVertical']) => {
    const node = textNode('a', {commands: line(0, 0, 100, 0), startOffset: 0, side: 'LEFT'}, {textAlignVertical: vertical});
    return textPathLayout(node, layoutText(node, measurer)).glyphs[0].origin.y;
  };
  assert.ok(Math.abs(at('BOTTOM')) < 1e-6);
  // A 16 px line, AUTO line height: the baseline is 0.8 em below the top.
  assert.ok(Math.abs(at('TOP') - 12.8) < 1e-6, String(at('TOP')));
  assert.ok(at('CENTER') > 0 && at('CENTER') < at('TOP'));
});

test('points on the path map back to the unwrapped line, for the caret', () => {
  const node = textNode('abcd', {commands: line(0, 20, 100, 20), startOffset: 0.1, side: 'LEFT'});
  const layout = layoutText(node, measurer);
  const placed = textPathLayout(node, layout);
  const straight = straightPoint(placed, layout, {x: 10 + 13, y: 15})!;
  assert.ok(Math.abs(straight.x - 13) < 1e-6);
  assert.equal(offsetAt(layout, straight).offset, 2);
  const caret = placeOnPath(placed, 0, 12)!;
  assert.ok(Math.abs(caret.point.x - 22) < 1e-6 && Math.abs(caret.point.y - 20) < 1e-6);
  assert.ok(hitsTextPath(placed, layout, {x: 14, y: 15}, 0));
  assert.ok(!hitsTextPath(placed, layout, {x: 90, y: 0}, 1));
});

test('sampling: lengths, wrapping and projection', () => {
  const sampler = textPathSampler({commands: circle(10), startOffset: 0, side: 'LEFT'})!;
  assert.ok(Math.abs(sampler.length - 2 * Math.PI * 10) < 0.05, String(sampler.length));
  const wrapped = pointAlong(sampler, sampler.length + 1)!, plain = pointAlong(sampler, 1)!;
  assert.ok(Math.abs(wrapped.point.x - plain.point.x) < 1e-9);
  const projected = projectOnPath(sampler, {x: 10, y: -3});
  assert.ok(Math.abs(projected.distance - 3) < 0.05);
  assert.equal(pointAlong(textPathSampler({commands: line(0, 0, 10, 0), startOffset: 0, side: 'LEFT'})!, 11), null);
});

test('render bounds cover glyphs outside the box; the box stays the path\'s', () => {
  const node = textNode('abc', {commands: line(0, 0, 100, 0), startOffset: 0, side: 'LEFT'});
  const box = textBoxSize({...node, width: 100, height: 0, text: {...node.text!, textAutoResize: 'WIDTH_AND_HEIGHT'}}, measurer);
  assert.deepEqual(box, {width: 100, height: 0});
  const bounds = localRenderBounds({...node, width: 100}, measurer);
  assert.ok(bounds.y < -8, JSON.stringify(bounds));
});

test('resizing a text on a path scales its path', () => {
  const doc = createDocument('p');
  const node = {...textNode('a', {commands: line(0, 0, 100, 0), startOffset: 0, side: 'LEFT'}), width: 100, height: 10};
  doc.nodes.t = node;
  doc.nodes.p.children = ['t'];
  const updates = resizeUpdates(doc, 't', {x: 0, y: 0, width: 200, height: 10});
  const path = updates.get('t')!.textPath!;
  assert.deepEqual(path.commands[1], {type: 'L', x: 200, y: 0});
});

test('the schema keeps a text path on text only', () => {
  const doc = createDocument('p');
  doc.nodes.t = {...textNode('a', {commands: line(0, 0, 100, 0), startOffset: 0.5, side: 'RIGHT'}), width: 100};
  doc.nodes.p.children = ['t'];
  assert.equal(validateDocument(structuredClone(doc)).ok, true);
  const wrong = structuredClone(doc);
  wrong.nodes.r = createNode('RECTANGLE', {id: 'r', parentId: 'p', textPath: {commands: line(0, 0, 1, 0), startOffset: 0, side: 'LEFT'}});
  wrong.nodes.p.children = ['t', 'r'];
  assert.equal(validateDocument(wrong).ok, false);
});
