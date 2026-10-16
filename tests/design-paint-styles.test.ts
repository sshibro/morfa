import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import {beginTransaction, type Transaction} from '../shared/design/transaction';
import type {DesignDocument, NodeType, SceneNode, ShadowEffect} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {
  applyStyleTo, bindPaint, createStyleFrom, deleteStyle, detachStyleFrom, nextStyleName, renameStyle, setStyleEffects, setStylePaints, stylesOfType, usersOf,
} from '../src/design/panels/design/paint/style-ops';
import {writePaints} from '../src/design/panels/design/paint/editing';
import {newDropShadow} from '../src/design/panels/design/paint/paints';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const RED = {r: 1, g: 0, b: 0}, BLUE = {r: 0, g: 0, b: 1}, GREEN = {r: 0, g: 1, b: 0};

function build(): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  const add = (type: NodeType, props: Partial<SceneNode> & {id: string}) => tx.create(createNode(type, props), 'page');
  add('RECTANGLE', {id: 'a', fills: [solid(RED)], strokes: [solid(BLUE)], effects: [newDropShadow()]});
  add('RECTANGLE', {id: 'b', fills: [solid(GREEN)]});
  add('ELLIPSE', {id: 'c', fills: [solid(GREEN)]});
  tx.setVariableCollection({id: 'col', name: 'Colors', modes: [{modeId: 'm', name: 'Light'}], defaultModeId: 'm', variableIds: []});
  tx.setVariable({id: 'brand', name: 'brand', collectionId: 'col', type: 'COLOR', valuesByMode: {m: {r: 0.1, g: 0.2, b: 0.3, a: 0.5}}, description: ''});
  return tx.commit({measurer}).doc;
}

function run(doc: DesignDocument, recipe: (tx: Transaction) => void): DesignDocument {
  const tx = beginTransaction(doc);
  recipe(tx);
  return tx.commit({measurer}).doc;
}

test('a colour style is made from the selection\'s fills and given to it', () => {
  let id: string | null = null;
  const doc = run(build(), tx => {
    id = createStyleFrom(tx, ['a', 'b'], 'fills', ' Brand / Red ', 's1');
  });
  assert.equal(id, 's1');
  assert.deepEqual(doc.styles.s1, {id: 's1', type: 'FILL', name: 'Brand / Red', description: '', paints: [solid(RED)]});
  assert.equal(doc.nodes.a.fillStyleId, 's1');
  assert.equal(doc.nodes.b.fillStyleId, 's1', 'every selected layer follows the new style');
  assert.deepEqual(doc.nodes.b.fills, [solid(RED)]);
  // Strokes and effects make styles of their own kind; a nameless style gets the next free name.
  const more = run(doc, tx => {
    createStyleFrom(tx, ['a'], 'strokes', '', 's2');
    createStyleFrom(tx, ['a'], 'effects', 'Shadows/Soft', 'e1');
  });
  assert.equal(more.styles.s2.name, 'Color 1');
  assert.deepEqual(more.styles.s2.paints, [solid(BLUE)]);
  assert.equal(more.nodes.a.strokeStyleId, 's2');
  assert.equal(more.styles.e1.type, 'EFFECT');
  assert.equal(more.nodes.a.effectStyleId, 'e1');
  assert.equal(nextStyleName(more, 'FILL'), 'Color 2');
  assert.deepEqual(stylesOfType(more, 'FILL').map(style => style.id), ['s1', 's2']);
  // Nothing to make a style from.
  assert.equal(run(build(), tx => assert.equal(createStyleFrom(tx, ['c'], 'effects', 'x'), null)).styles.x, undefined);
});

test('applying, editing, renaming, detaching and deleting a style', () => {
  let doc = run(build(), tx => {
    createStyleFrom(tx, ['a'], 'fills', 'Brand', 's1');
  });
  doc = run(doc, tx => applyStyleTo(tx, ['c'], 's1', 'fills'));
  assert.deepEqual(doc.nodes.c.fills, [solid(RED)]);
  assert.deepEqual(usersOf(doc, 's1').sort(), ['a', 'c']);
  // Editing the style rewrites every user and keeps them attached.
  doc = run(doc, tx => setStylePaints(tx, 's1', [solid(BLUE, 0.5)]));
  for (const id of ['a', 'c']) {
    assert.deepEqual(doc.nodes[id].fills, [solid(BLUE, 0.5)]);
    assert.equal(doc.nodes[id].fillStyleId, 's1');
  }
  assert.deepEqual(doc.nodes.b.fills, [solid(GREEN)], 'others are untouched');
  doc = run(doc, tx => renameStyle(tx, 's1', '  Brand/Primary '));
  assert.equal(doc.styles.s1.name, 'Brand/Primary');
  // Editing a styled fill by hand detaches it, as in Figma.
  const edited = run(doc, tx => writePaints(tx, ['a'], 'fills', () => [solid(GREEN)]));
  assert.equal(edited.nodes.a.fillStyleId, undefined);
  assert.equal(edited.nodes.c.fillStyleId, 's1');
  // "Detach" keeps the values.
  doc = run(doc, tx => detachStyleFrom(tx, ['c'], 'fills'));
  assert.equal(doc.nodes.c.fillStyleId, undefined);
  assert.deepEqual(doc.nodes.c.fills, [solid(BLUE, 0.5)]);
  // Deleting the style: users keep their paints.
  doc = run(doc, tx => deleteStyle(tx, 's1'));
  assert.equal(doc.styles.s1, undefined);
  assert.equal(doc.nodes.a.fillStyleId, undefined);
  assert.deepEqual(doc.nodes.a.fills, [solid(BLUE, 0.5)]);
});

test('an effect style edit follows into every user; given users limit the rewrite to them', () => {
  let doc = run(build(), tx => {
    createStyleFrom(tx, ['a'], 'effects', 'Shadow', 'e1');
    applyStyleTo(tx, ['b'], 'e1', 'effects');
  });
  const softer: ShadowEffect = {...newDropShadow(), radius: 24};
  doc = run(doc, tx => setStyleEffects(tx, 'e1', [softer], ['a']));
  assert.deepEqual(doc.nodes.a.effects, [softer]);
  assert.deepEqual(doc.nodes.b.effects, [newDropShadow()], 'only the users the editor found were rewritten');
  doc = run(doc, tx => setStyleEffects(tx, 'e1', [softer]));
  assert.deepEqual(doc.nodes.b.effects, [softer]);
  assert.equal(doc.nodes.b.effectStyleId, 'e1');
});

test('binding a solid paint to a colour variable, from a row or for the whole list', () => {
  let doc = run(build(), tx => bindPaint(tx, ['a', 'b'], 'fills', 0, 'brand'));
  for (const id of ['a', 'b']) {
    const paint = doc.nodes[id].fills[0];
    assert.equal(paint.type, 'SOLID');
    assert.deepEqual(paint.type === 'SOLID' && paint.boundVariables, {color: {type: 'VARIABLE_ALIAS', id: 'brand'}});
    assert.deepEqual(paint.type === 'SOLID' && {color: paint.color, opacity: paint.opacity}, {color: {r: 0.1, g: 0.2, b: 0.3}, opacity: 0.5});
  }
  // The whole list becomes one bound solid; a styled list lets go of its style.
  doc = run(doc, tx => {
    createStyleFrom(tx, ['c'], 'fills', 'Green', 's1');
    tx.update('c', {fills: [solid(GREEN), solid(RED, 0.2)], fillStyleId: 's1'});
  });
  doc = run(doc, tx => bindPaint(tx, ['c'], 'fills', 'all', 'brand'));
  assert.equal(doc.nodes.c.fills.length, 1);
  assert.deepEqual(doc.nodes.c.fills[0].type === 'SOLID' && doc.nodes.c.fills[0].color, {r: 0.1, g: 0.2, b: 0.3}, 'the colour carries no alpha channel');
  assert.equal(doc.nodes.c.fillStyleId, undefined);
});
