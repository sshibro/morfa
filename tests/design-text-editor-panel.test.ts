import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BLACK, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import {MIXED} from '../shared/design/text-edit';
import type {SceneNode, TextProps} from '../shared/design/types';
import {evaluateNumberInput} from '../src/design/ui/number-expression';
import {faceName, faceOptions, fontRows, matchesFont} from '../src/design/ui/font-rows';
import {formatUnitValue, parseUnitValue, textPanelValues} from '../src/design/panels/design/text/text-values';
import type {FontFamilyInfo} from '../src/design/engine/contracts';

// The "Text" section's values and the font picker's rows (src/design/panels/design/text,
// src/design/ui/font-rows.ts).

const text = (id: string, characters: string, extra: Partial<TextProps> = {}, node: Partial<SceneNode> = {}): SceneNode =>
  createNode('TEXT', {id, parentId: 'p', width: 100, height: 20, fills: [solid(BLACK)], text: {...defaultTextProps(characters), ...extra}, ...node});

test('selected texts show their common values and "Mixed" where they differ', () => {
  const a = text('a', 'one', {runs: [{start: 0, end: 2, style: {fontWeight: 700}}]});
  const b = text('b', 'two', {textAlignHorizontal: 'CENTER'});
  const values = textPanelValues([a, b], null)!;
  assert.deepEqual(values.ids, ['a', 'b']);
  assert.equal(values.editing, false);
  assert.equal(values.fontFamily, 'Inter');
  assert.equal(values.fontSize, 16);
  assert.equal(values.fontWeight, MIXED, 'a bold run in one of them');
  assert.equal(values.textAlignHorizontal, MIXED);
  assert.equal(values.textAutoResize, 'WIDTH_AND_HEIGHT');
  assert.equal(values.listType, 'NONE');
  assert.deepEqual(values.families, ['Inter']);
  assert.equal(textPanelValues([createNode('RECTANGLE', {id: 'r', parentId: 'p'})], null), null);
  // "Paragraph indent" (in "Text settings"): the first line's indent, "Mixed" when the texts differ.
  assert.equal(values.paragraphIndent, 0);
  const indented = text('c', 'six', {paragraphIndent: 24});
  assert.equal(textPanelValues([indented], null)!.paragraphIndent, 24);
  assert.equal(textPanelValues([a, indented], null)!.paragraphIndent, MIXED);
});

test('while a text is edited the section shows its selection, or the caret with its pending style', () => {
  const node = text('t', 'Bolder or normal', {runs: [{start: 0, end: 6, style: {fontWeight: 700}}], listTypes: ['UNORDERED']}, {textStyleId: 'S'});
  const word = textPanelValues([node], {id: 't', start: 0, end: 6, pending: undefined, version: 1})!;
  assert.equal(word.editing, true);
  assert.equal(word.fontWeight, 700);
  assert.equal(word.listType, 'UNORDERED');
  const caret = textPanelValues([node], {id: 't', start: 9, end: 9, pending: {style: {italic: true, fontSize: 20}}, version: 2})!;
  assert.equal(caret.italic, true);
  assert.equal(caret.fontSize, 20);
  assert.equal(caret.fontWeight, 400);
  const whole = textPanelValues([node], {id: 't', start: 0, end: 16, pending: undefined, version: 3})!;
  assert.equal(whole.fontWeight, MIXED);
  assert.equal(whole.textStyleId, 'S', 'the layer’s style shows for the whole text');
});

test('line height and letter spacing read "auto", percent and pixels, with arithmetic', () => {
  const lh = {unit: 'PERCENT' as const, value: 120};
  assert.deepEqual(parseUnitValue('auto', 'lineHeight', lh, evaluateNumberInput), {unit: 'AUTO'});
  assert.deepEqual(parseUnitValue('', 'lineHeight', lh, evaluateNumberInput), {unit: 'AUTO'});
  assert.deepEqual(parseUnitValue('150%', 'lineHeight', lh, evaluateNumberInput), {unit: 'PERCENT', value: 150});
  assert.deepEqual(parseUnitValue('24', 'lineHeight', lh, evaluateNumberInput), {unit: 'PIXELS', value: 24}, 'a bare number is pixels');
  assert.deepEqual(parseUnitValue('20+4px', 'lineHeight', lh, evaluateNumberInput), {unit: 'PIXELS', value: 24});
  assert.equal(parseUnitValue('-4', 'lineHeight', lh, evaluateNumberInput), null);
  assert.equal(parseUnitValue('abc', 'lineHeight', lh, evaluateNumberInput), null);
  const ls = {unit: 'PERCENT' as const, value: 0};
  assert.deepEqual(parseUnitValue('2,5', 'letterSpacing', ls, evaluateNumberInput), {unit: 'PERCENT', value: 2.5}, 'letter spacing keeps its unit');
  assert.deepEqual(parseUnitValue('-1px', 'letterSpacing', ls, evaluateNumberInput), {unit: 'PIXELS', value: -1});
  assert.equal(parseUnitValue('auto', 'letterSpacing', ls, evaluateNumberInput), null);
  assert.equal(formatUnitValue({unit: 'AUTO'}), 'Auto');
  assert.equal(formatUnitValue({unit: 'PERCENT', value: 150}), '150%');
  assert.equal(formatUnitValue({unit: 'PIXELS', value: 1.5}), '1.5');
  assert.equal(formatUnitValue(MIXED), '');
});

const info = (family: string, kind: string, source: 'catalog' | 'local' = 'catalog', weights = [400, 700], italic = false): FontFamilyInfo => ({family, kind, source, weights, italic});

test('the font list groups by kind with recent fonts first and local fonts last, and searches', () => {
  const families = [info('Inter', 'sans'), info('PT Serif', 'serif'), info('Pacifico', 'script'), info('Roboto Mono', 'mono'), info('My font', '', 'local')];
  const rows = fontRows(families, '', ['PT Serif'], 'loaded');
  const shape = rows.map(row => (row.type === 'heading' ? `# ${row.label}` : row.type === 'font' ? row.family : row.type));
  assert.deepEqual(shape, ['# Recent', 'PT Serif', '# Sans serif', 'Inter', '# Serif', 'PT Serif', '# Handwriting', 'Pacifico', '# Monospace', 'Roboto Mono', '# Local fonts', 'My font']);
  const idle = fontRows(families.slice(0, 2), '', [], 'idle');
  assert.deepEqual(idle.at(-1), {type: 'local', state: 'idle'}, 'the button to list the computer’s fonts');
  const unsupported = fontRows(families.slice(0, 2), '', [], 'unsupported');
  assert.deepEqual(unsupported.at(-1), {type: 'local', state: 'unsupported'});
  const found = fontRows(families, 'mono rob', [], 'loaded');
  assert.deepEqual(found.filter(row => row.type === 'font').map(row => row.type === 'font' && row.family), ['Roboto Mono']);
  assert.equal(fontRows(families, 'no such font', [], 'loaded')[0].type, 'empty');
// Cyrillic on purpose: the font search treats ё and е as one letter.
  assert.ok(matchesFont('Ёлка Sans', 'елка'));
});

test('faces list only what the family has, italics where it has them', () => {
  assert.deepEqual(faceOptions({weights: [400, 700], italic: false}).map(face => face.label), ['Regular', 'Bold']);
  assert.deepEqual(faceOptions({weights: [400], italic: true}).map(face => face.value), ['400', '400i']);
  assert.deepEqual(faceOptions({weights: [400], italic: false}, {weight: 350, italic: false}).map(face => face.label), ['Regular', '350'], 'a face in use stays visible');
  assert.equal(faceName(600, true), 'Semi Bold Italic');
  assert.equal(faceName(400, true), 'Italic');
});

test('moving selected texts re-reads their values instead of working them out again', () => {
  // A drag or a nudge of hundreds of selected texts recomputed every text's styles on every frame (2026-10-07).
  let runsRead = 0;
  const counting = (props: TextProps) => new Proxy(props, {get: (target, key, receiver) => {
    if (key === 'runs') runsRead++;
    return Reflect.get(target, key, receiver);
  }});
  const nodes = Array.from({length: 200}, (_, i) => text(`t${i}`, 'Text', {runs: i % 3 ? [] : [{start: 0, end: 2, style: {fontWeight: 700}}]}))
    .map(node => ({...node, text: counting(node.text!)}));
  const first = textPanelValues(nodes, null)!;
  assert.ok(runsRead > 0);
  runsRead = 0;
  const moved = nodes.map(node => ({...node, x: node.x + 10}));
  assert.deepEqual(textPanelValues(moved, null), first);
  assert.equal(runsRead, 0, 'no text worked out again');
  // A recoloured or restyled text is worked out again.
  const recoloured = moved.map((node, i) => (i ? node : {...node, fills: [solid({r: 1, g: 0, b: 0})]}));
  const values = textPanelValues(recoloured, null)!;
  assert.ok(runsRead > 0);
  assert.equal(values.fontWeight, MIXED);
});
