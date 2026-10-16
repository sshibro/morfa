import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid, BLACK, WHITE} from '../shared/design/defaults';
import type {DesignDocument, Effect, LayoutGrid, NodeType, SceneNode, Style} from '../shared/design/types';
import {applyStyle, clearsStyle, createStyleFromNode, detachStyle, editTextRange, groupStyles, removeStyleUpdates, styleDisplayName, styleUsages, updateStyleUpdates, withStylesCleared} from '../shared/design/styles';
import type {NodeUpdates} from '../shared/design/constraints';

const RED = {r: 1, g: 0, b: 0};
const shadow: Effect = {type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.25}, offset: {x: 0, y: 4}, radius: 12, spread: 0, visible: true, blendMode: 'NORMAL'};
const columns: LayoutGrid = {pattern: 'COLUMNS', alignment: 'STRETCH', count: 12, gutterSize: 20, offset: 16, sectionSize: 60, visible: true, color: {r: 1, g: 0, b: 0, a: 0.1}};

function build() {
  const doc = createDocument('page');
  const add = (type: NodeType, props: Partial<SceneNode> & {id: string}, parentId = 'page') => {
    const node = createNode(type, {...props, parentId});
    doc.nodes[node.id] = node;
    doc.nodes[parentId].children!.push(node.id);
    return node;
  };
  add('RECTANGLE', {id: 'rect', fills: [solid(RED)], effects: [shadow]});
  add('FRAME', {id: 'frame', layoutGrids: [columns]});
  add('TEXT', {id: 'text', text: {...defaultTextProps('Hello, world'), style: {...defaultTextProps().style, fontSize: 24, fontWeight: 700, hyperlink: {type: 'URL', url: 'https://example.com'}}, runs: [{start: 0, end: 6, style: {fontSize: 30}, fills: [solid(WHITE)]}]}});
  return {doc, add};
}

function withStyle(doc: DesignDocument, style: Style): DesignDocument {
  return {...doc, styles: {...doc.styles, [style.id]: style}};
}
function apply(doc: DesignDocument, updates: NodeUpdates): DesignDocument {
  const nodes = {...doc.nodes};
  for (const [id, patch] of updates) nodes[id] = {...nodes[id], ...patch};
  return {...doc, nodes};
}

test('styles are made from a node\'s fills, type, effects or grids', () => {
  const {doc} = build();
  const fill = createStyleFromNode(doc, 'rect', 'FILL', ' Brand / Red ', 'red')!;
  assert.deepEqual(fill, {id: 'red', type: 'FILL', name: 'Brand / Red', description: '', paints: [solid(RED)]});
  assert.notEqual(fill.paints, doc.nodes.rect.fills, 'the style owns a copy');
  const text = createStyleFromNode(doc, 'text', 'TEXT', 'Heading/H1', 'h1')!;
  assert.equal(text.text!.fontSize, 30, 'the type of the first character');
  assert.equal(text.text!.fontWeight, 700);
  assert.equal('hyperlink' in text.text!, false, 'a link is not part of a text style');
  assert.deepEqual(createStyleFromNode(doc, 'rect', 'EFFECT', 'Shadow', 'fx')!.effects, [shadow]);
  assert.deepEqual(createStyleFromNode(doc, 'frame', 'GRID', 'Grid', 'grid')!.grids, [columns]);
  assert.equal(createStyleFromNode(doc, 'rect', 'TEXT', 'x'), null);
  assert.equal(createStyleFromNode(doc, 'rect', 'GRID', 'x'), null);
  assert.equal(createStyleFromNode(doc, 'rect', 'FILL', '  ', 'blank')!.name, 'Color');
  assert.equal(typeof createStyleFromNode(doc, 'rect', 'FILL', 'auto id')!.id, 'string');
});

test('applying a style sets the values and the style id', () => {
  const {doc} = build();
  const white: Style = {id: 'white', type: 'FILL', name: 'White', description: '', paints: [solid(WHITE)]};
  let next = withStyle(doc, white);
  let updates = applyStyle(next, ['rect', 'frame', 'page'], 'white');
  assert.deepEqual(updates.get('rect'), {fills: [solid(WHITE)], fillStyleId: 'white'});
  assert.equal(updates.has('page'), false, 'pages take no fill styles');
  updates = applyStyle(next, ['rect'], 'white', {target: 'strokes'});
  assert.deepEqual(updates.get('rect'), {strokes: [solid(WHITE)], strokeStyleId: 'white'});
  updates = applyStyle(next, ['text'], 'white');
  assert.deepEqual(updates.get('text')!.text!.runs, [{start: 0, end: 6, style: {fontSize: 30}}], 'a whole-text colour replaces range colours');

  const fx: Style = {id: 'fx', type: 'EFFECT', name: 'Shadow', description: '', effects: [shadow]};
  const grid: Style = {id: 'grid', type: 'GRID', name: 'Grid', description: '', grids: [columns]};
  next = withStyle(withStyle(next, fx), grid);
  assert.deepEqual(applyStyle(next, ['frame'], 'fx').get('frame'), {effects: [shadow], effectStyleId: 'fx'});
  assert.deepEqual(applyStyle(next, ['frame', 'rect'], 'grid').get('frame'), {layoutGrids: [columns], gridStyleId: 'grid'});
  assert.equal(applyStyle(next, ['rect'], 'grid').size, 0, 'grids belong to frames');
  assert.equal(applyStyle(next, ['rect'], 'missing').size, 0);
});

test('a text style applies to the whole text, or to a range through runs', () => {
  const {doc} = build();
  const body: Style = {id: 'body', type: 'TEXT', name: 'Body', description: '', text: {...defaultTextProps().style, fontSize: 14, fontFamily: 'Onest'}};
  const next = withStyle(doc, body);
  const whole = applyStyle(next, ['text', 'rect'], 'body').get('text')!;
  assert.equal(whole.textStyleId, 'body');
  assert.equal(whole.text!.style.fontSize, 14);
  assert.equal(whole.text!.style.fontFamily, 'Onest');
  assert.deepEqual(whole.text!.style.hyperlink, {type: 'URL', url: 'https://example.com'}, 'the link stays');
  assert.deepEqual(whole.text!.runs, [{start: 0, end: 6, style: {}, fills: [solid(WHITE)]}], 'styled overrides go, colours stay');

  const ranged = applyStyle(next, ['text'], 'body', {range: {start: 4, end: 9}}).get('text')!;
  assert.equal(ranged.textStyleId, undefined, 'the text as a whole keeps its style');
  const runs = ranged.text!.runs;
  assert.deepEqual(runs.map(run => [run.start, run.end, run.style.fontSize, run.textStyleId ?? null]), [[0, 4, 30, null], [4, 6, 14, 'body'], [6, 9, 14, 'body']]);
  assert.deepEqual(runs[1].fills, [solid(WHITE)], 'the split run keeps its colour');
  assert.equal(applyStyle(next, ['text'], 'body', {range: {start: 0, end: 12}}).get('text')!.textStyleId, 'body', 'a range over everything is the whole text');
  assert.equal(applyStyle(next, ['text'], 'body', {range: {start: 3, end: 3}}).size, 0);
});

test('a range edit splits runs at its edges and fills the gaps between them', () => {
  const text = {...defaultTextProps('abcdefghij'), runs: [{start: 2, end: 4, style: {fontWeight: 700}}]};
  assert.deepEqual(editTextRange(text, 3, 6, run => ({...run, style: {...run.style, italic: true}})), [
    {start: 2, end: 3, style: {fontWeight: 700}},
    {start: 3, end: 4, style: {fontWeight: 700, italic: true}},
    {start: 4, end: 6, style: {italic: true}},
  ]);
});

test('editing a style rewrites every node and range that uses it', () => {
  const {doc, add} = build();
  const brand: Style = {id: 'brand', type: 'FILL', name: 'Brand', description: '', paints: [solid(RED)]};
  const body: Style = {id: 'body', type: 'TEXT', name: 'Body', description: '', text: {...defaultTextProps().style, fontSize: 14}};
  let next = withStyle(withStyle(doc, brand), body);
  add('RECTANGLE', {id: 'other', strokes: [solid(RED)], strokeStyleId: 'brand'});
  next = {...next, nodes: {...next.nodes, other: doc.nodes.other}};
  next = apply(next, applyStyle(next, ['rect'], 'brand'));
  next = apply(next, applyStyle(next, ['text'], 'body', {range: {start: 0, end: 3}}));
  const changed = {...brand, paints: [solid(BLACK)]};
  let updates = updateStyleUpdates(next, changed);
  assert.deepEqual([...updates.keys()].sort(), ['other', 'rect']);
  assert.deepEqual(updates.get('rect'), {fills: [solid(BLACK)]});
  assert.deepEqual(updates.get('other'), {strokes: [solid(BLACK)]});
  updates = updateStyleUpdates(next, {...body, text: {...body.text!, fontSize: 18}});
  const runs = updates.get('text')!.text!.runs;
  assert.deepEqual(runs.map(run => run.style.fontSize), [18, 30]);
  assert.deepEqual(styleUsages(next, 'body'), ['text']);
  assert.deepEqual(styleUsages(next, 'brand').sort(), ['other', 'rect']);
});

test('detaching keeps the values; removing a style detaches every user', () => {
  const {doc} = build();
  const node: SceneNode = {...doc.nodes.text, fillStyleId: 'brand', textStyleId: 'body', text: {...doc.nodes.text.text!, runs: [{start: 0, end: 2, style: {fontSize: 9}, textStyleId: 'small'}, {start: 2, end: 4, style: {fontSize: 9}, textStyleId: 'body'}]}};
  assert.deepEqual(detachStyle(node, 'fill'), {fillStyleId: undefined});
  const text = detachStyle(node, 'text', 'body');
  assert.equal('textStyleId' in text && text.textStyleId, undefined);
  assert.deepEqual(text.text!.runs.map(run => run.textStyleId ?? null), ['small', null]);
  assert.deepEqual(detachStyle(node, 'text').text!.runs, [{start: 0, end: 4, style: {fontSize: 9}}], 'ranges that now look the same merge');
  const next = {...doc, nodes: {...doc.nodes, text: node, rect: {...doc.nodes.rect, effectStyleId: 'body'}}};
  const updates = removeStyleUpdates(next, 'body');
  assert.deepEqual([...updates.keys()].sort(), ['rect', 'text']);
  assert.deepEqual(updates.get('rect'), {effectStyleId: undefined});
  assert.equal(updates.get('text')!.fillStyleId, undefined);
  assert.equal('fillStyleId' in updates.get('text')!, false, 'other styles stay');
});

test('editing a styled field by hand detaches its style', () => {
  assert.equal(clearsStyle('fills'), 'fillStyleId');
  assert.equal(clearsStyle('strokes'), 'strokeStyleId');
  assert.equal(clearsStyle('effects'), 'effectStyleId');
  assert.equal(clearsStyle('layoutGrids'), 'gridStyleId');
  assert.equal(clearsStyle('fontSize'), 'textStyleId');
  assert.equal(clearsStyle('lineHeight'), 'textStyleId');
  assert.equal(clearsStyle('characters'), null);
  assert.equal(clearsStyle('opacity'), null);
  assert.deepEqual(withStylesCleared({fills: [], opacity: 0.5}), {fills: [], opacity: 0.5, fillStyleId: undefined});
  assert.deepEqual(withStylesCleared({fills: [], fillStyleId: 'x'}), {fills: [], fillStyleId: 'x'});
});

test('the assets panel groups styles into folders by "/"', () => {
  const style = (id: string, name: string): Style => ({id, type: 'FILL', name, description: '', paints: []});
  const tree = groupStyles({
    a: style('a', 'Brand/Primary'), b: style('b', 'Brand / Secondary'), c: style('c', 'Gray/100'),
    d: style('d', 'Brand/Accent/Hot'), e: style('e', 'Loose'),
  });
  assert.deepEqual(tree.styles.map(s => s.id), ['e']);
  assert.deepEqual(tree.groups.map(g => [g.name, g.path]), [['Brand', 'Brand'], ['Gray', 'Gray']]);
  const brand = tree.groups[0];
  assert.deepEqual(brand.styles.map(s => s.id), ['a', 'b']);
  assert.deepEqual(brand.groups.map(g => g.path), ['Brand/Accent']);
  assert.deepEqual(brand.groups[0].styles.map(s => styleDisplayName(s)), ['Hot']);
  assert.equal(groupStyles([style('x', 'One')]).styles.length, 1, 'an array works too');
});
