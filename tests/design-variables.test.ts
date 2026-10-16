import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, RGBA, SceneNode} from '../shared/design/types';
import {createInstance, syncInstancesDetailed} from '../shared/design/components';
import {
  addVariableMode, aliasCycle, applyVariables, bindPaintVariable, bindVariable, BINDABLE_FIELDS, createVariable, createVariableCollection, deleteVariable,
  DesignVariableError, modeForNode, removeVariableMode, resolveVariable, setNodeVariableMode, setVariableValue, variableUsage, wouldCreateAliasCycle,
} from '../shared/design/variables';

// Variables: collections with modes, aliases, and bound fields that always hold the resolved value.

const WHITE: RGBA = {r: 1, g: 1, b: 1, a: 1};
const INK: RGBA = {r: 0.1, g: 0.1, b: 0.1, a: 1};
const BRAND: RGBA = {r: 0, g: 0.6, b: 1, a: 0.8};

function add(doc: DesignDocument, type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}): DesignDocument {
  const node = createNode(type, props);
  const parent = doc.nodes[props.parentId];
  return {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
}

/** A "Colors" collection with light and dark modes, a surface colour and a spacing number. */
function themed(): DesignDocument {
  let doc = createDocument('p');
  doc = createVariableCollection(doc, {id: 'colors', name: 'Colors', modes: [{modeId: 'light', name: 'Light'}, {modeId: 'dark', name: 'Dark'}]}).doc;
  doc = createVariable(doc, {id: 'surface', name: 'Background/Surface', collectionId: 'colors', type: 'COLOR', value: WHITE}).doc;
  doc = setVariableValue(doc, 'surface', 'dark', INK).doc;
  doc = createVariable(doc, {id: 'gap', name: 'Spacing', collectionId: 'colors', type: 'FLOAT', value: 8}).doc;
  doc = setVariableValue(doc, 'gap', 'dark', 12).doc;
  return doc;
}

test('values per mode, the default mode as fallback', () => {
  const doc = themed();
  assert.deepEqual(doc.variableCollections.colors.variableIds, ['surface', 'gap']);
  assert.equal(doc.variableCollections.colors.defaultModeId, 'light');
  assert.deepEqual(resolveVariable(doc, 'surface', 'light'), WHITE);
  assert.deepEqual(resolveVariable(doc, 'surface', 'dark'), INK);
  assert.deepEqual(resolveVariable(doc, 'surface'), WHITE);
  assert.deepEqual(resolveVariable(doc, 'surface', 'unknown'), WHITE);
  assert.equal(resolveVariable(doc, 'missing'), undefined);
  // A new mode starts as a copy of the default; values are typed.
  const withMode = addVariableMode(doc, 'colors', {modeId: 'contrast', name: 'Contrast'}).doc;
  assert.equal(resolveVariable(withMode, 'gap', 'contrast'), 8);
  assert.throws(() => setVariableValue(doc, 'gap', 'light', 'eight'), (error: DesignVariableError) => error.code === 'wrong_type');
  assert.throws(() => setVariableValue(doc, 'gap', 'night', 4), (error: DesignVariableError) => error.code === 'unknown_mode');
  assert.throws(() => createVariable(doc, {id: 'x', name: 'Spacing', collectionId: 'colors', type: 'FLOAT'}), (error: DesignVariableError) => error.code === 'duplicate_name');
  assert.equal(BINDABLE_FIELDS.itemSpacing, 'FLOAT');
  assert.equal(BINDABLE_FIELDS.visible, 'BOOLEAN');
  assert.equal(BINDABLE_FIELDS.characters, 'STRING');
});

test('aliases resolve through other variables and collections, and never loop', () => {
  let doc = themed();
  doc = createVariableCollection(doc, {id: 'tokens', name: 'Tokens', modes: [{modeId: 'base', name: 'Base'}]}).doc;
  doc = createVariable(doc, {id: 'card', name: 'Card', collectionId: 'tokens', type: 'COLOR', value: {type: 'VARIABLE_ALIAS', id: 'surface'}}).doc;
  doc = createVariable(doc, {id: 'panel', name: 'Panel', collectionId: 'colors', type: 'COLOR', value: {type: 'VARIABLE_ALIAS', id: 'surface'}}).doc;
  assert.deepEqual(resolveVariable(doc, 'panel', 'dark'), INK, 'an alias in the same collection keeps the mode');
  assert.deepEqual(resolveVariable(doc, 'card', 'base'), WHITE, 'another collection resolves in its default mode');
  assert.throws(() => setVariableValue(doc, 'surface', 'light', {type: 'VARIABLE_ALIAS', id: 'panel'}), (error: DesignVariableError) => error.code === 'alias_cycle');
  assert.throws(() => setVariableValue(doc, 'surface', 'light', {type: 'VARIABLE_ALIAS', id: 'surface'}), (error: DesignVariableError) => error.code === 'alias_cycle');
  assert.throws(() => setVariableValue(doc, 'gap', 'light', {type: 'VARIABLE_ALIAS', id: 'surface'}), (error: DesignVariableError) => error.code === 'wrong_type');
  assert.equal(wouldCreateAliasCycle(doc, 'surface', 'card'), true);
  assert.equal(wouldCreateAliasCycle(doc, 'gap', 'surface'), false);
  // A loop in an imported file: resolution gives up instead of hanging, and the loop can be shown.
  const looped = {...doc, variables: {...doc.variables, surface: {...doc.variables.surface, valuesByMode: {...doc.variables.surface.valuesByMode, light: {type: 'VARIABLE_ALIAS' as const, id: 'panel'}}}}};
  assert.equal(resolveVariable(looped, 'card', 'base'), undefined);
  assert.deepEqual(aliasCycle(looped, 'card'), ['surface', 'panel']);
  assert.equal(aliasCycle(doc, 'card'), null);
});

test('bound fields hold resolved values and follow modes, aliases and edits', () => {
  let doc = themed();
  doc = add(doc, 'FRAME', {id: 'screen', parentId: 'p', width: 400, height: 400, autoLayout: {...defaultAutoLayout('VERTICAL'), itemSpacing: 0}});
  doc = add(doc, 'RECTANGLE', {id: 'box', parentId: 'screen', width: 100, height: 100});
  doc = add(doc, 'TEXT', {id: 'title', parentId: 'screen', text: defaultTextProps('Heading')});
  doc = bindPaintVariable(doc, 'box', 'fills', 0, 'surface').doc;
  assert.deepEqual(doc.nodes.box.fills[0], {...solid({r: 1, g: 1, b: 1}), boundVariables: {color: {type: 'VARIABLE_ALIAS', id: 'surface'}}});
  doc = bindVariable(doc, 'screen', 'itemSpacing', 'gap').doc;
  assert.equal(doc.nodes.screen.autoLayout!.itemSpacing, 8);
  doc = createVariable(doc, {id: 'shown', name: 'Shown', collectionId: 'colors', type: 'BOOLEAN', value: true}).doc;
  doc = setVariableValue(doc, 'shown', 'dark', false).doc;
  doc = bindVariable(doc, 'title', 'visible', 'shown').doc;
  doc = createVariable(doc, {id: 'heading', name: 'Heading', collectionId: 'colors', type: 'STRING', value: 'Hello'}).doc;
  doc = bindVariable(doc, 'title', 'characters', 'heading').doc;
  assert.equal(doc.nodes.title.text!.characters, 'Hello');
  assert.throws(() => bindVariable(doc, 'box', 'width', 'surface'), (error: DesignVariableError) => error.code === 'wrong_type');
  assert.throws(() => bindVariable(doc, 'box', 'rotation', 'gap'), (error: DesignVariableError) => error.code === 'not_bindable');

  // The frame picks the dark mode: everything inside re-resolves.
  const dark = setNodeVariableMode(doc, 'screen', 'colors', 'dark');
  doc = dark.doc;
  assert.equal(modeForNode(doc, 'box', 'colors'), 'dark');
  assert.equal(modeForNode(doc, 'p', 'colors'), 'light');
  assert.deepEqual(doc.nodes.box.fills[0].type === 'SOLID' && doc.nodes.box.fills[0].color, {r: 0.1, g: 0.1, b: 0.1});
  assert.equal(doc.nodes.screen.autoLayout!.itemSpacing, 12);
  assert.equal(doc.nodes.title.visible, false);
  assert.ok(dark.changed.has('box') && dark.changed.has('title'));

  // A value edit reaches the bound nodes, through aliases too; colour alpha becomes paint opacity.
  doc = createVariable(doc, {id: 'accent', name: 'Accent', collectionId: 'colors', type: 'COLOR', value: BRAND}).doc;
  doc = setVariableValue(doc, 'surface', 'dark', {type: 'VARIABLE_ALIAS', id: 'accent'}).doc;
  const paint = doc.nodes.box.fills[0];
  assert.ok(paint.type === 'SOLID');
  assert.deepEqual(paint.color, {r: 0, g: 0.6, b: 1});
  assert.equal(paint.opacity, 0.8);
  doc = setVariableValue(doc, 'accent', 'dark', WHITE).doc;
  assert.equal(doc.nodes.box.fills[0].opacity, 1);

  // Removing the mode choice falls back to the default; a node moved out of the frame would do the same.
  doc = setNodeVariableMode(doc, 'screen', 'colors', null).doc;
  assert.equal(doc.nodes.screen.autoLayout!.itemSpacing, 8);
  assert.equal(doc.nodes.title.visible, true);
  assert.equal(doc.variableModes?.screen, undefined);
});

test('applyVariables only touches what changed and leaves an unbound document as it is', () => {
  let doc = themed();
  doc = add(doc, 'RECTANGLE', {id: 'a', parentId: 'p', width: 10, height: 10});
  doc = add(doc, 'RECTANGLE', {id: 'b', parentId: 'p', width: 10, height: 10});
  assert.equal(applyVariables(doc, new Set(['a', 'surface'])), doc);
  doc = bindVariable(doc, 'a', 'width', 'gap').doc;
  doc = bindVariable(doc, 'b', 'cornerRadius', 'gap').doc;
  assert.deepEqual([doc.nodes.a.width, doc.nodes.b.cornerRadius], [8, 8]);
  assert.deepEqual([...variableUsage(doc).byVariable.get('gap')!].sort(), ['a', 'b']);
  // The raw variable changes behind the function's back (an undo restores the table): the dirty variable
  // id brings the nodes up to date; an unrelated dirty id does nothing.
  const raw = {...doc, variables: {...doc.variables, gap: {...doc.variables.gap, valuesByMode: {...doc.variables.gap.valuesByMode, light: 16}}}};
  assert.equal(applyVariables(raw, new Set(['p-unrelated'])), raw);
  const applied = applyVariables(raw, new Set(['gap']));
  assert.deepEqual([applied.nodes.a.width, applied.nodes.b.cornerRadius], [16, 16]);
  // Values written by hand over a binding are put back when the node is dirty (the binding wins).
  const handEdited = {...doc, nodes: {...doc.nodes, a: {...doc.nodes.a, width: 50}}};
  assert.equal(applyVariables(handEdited, new Set(['a'])).nodes.a.width, 8);
});

test('instance copies resolve in their own place and inherit a mode set on their main', () => {
  let doc = themed();
  doc = add(doc, 'COMPONENT', {id: 'card', parentId: 'p', width: 100, height: 100});
  doc = add(doc, 'RECTANGLE', {id: 'bg', parentId: 'card', width: 100, height: 100});
  doc = bindPaintVariable(doc, 'bg', 'fills', 0, 'surface').doc;
  doc = add(doc, 'FRAME', {id: 'night', parentId: 'p', x: 300, width: 300, height: 300});
  doc = setNodeVariableMode(doc, 'night', 'colors', 'dark').doc;
  // The normalize order: sync the instance, then apply variables to what the sync wrote.
  const placed = createInstance(doc, 'card', {parentId: 'night', newId: 'i1'});
  doc = applyVariables(placed.doc, placed.changed);
  assert.deepEqual(doc.nodes['i1;bg'].fills[0].type === 'SOLID' && doc.nodes['i1;bg'].fills[0].color, {r: 0.1, g: 0.1, b: 0.1}, 'dark inside the dark frame');
  assert.deepEqual(doc.nodes.bg.fills[0].type === 'SOLID' && doc.nodes.bg.fills[0].color, {r: 1, g: 1, b: 1}, 'the main stays light');
  // A main edit re-syncs the copy from the light main; applying variables puts it back to dark.
  const edited = {...doc, nodes: {...doc.nodes, bg: {...doc.nodes.bg, strokes: [solid({r: 1, g: 0, b: 0})]}}};
  const synced = syncInstancesDetailed(edited, new Set(['bg']));
  doc = applyVariables(synced.doc, new Set([...synced.changed, 'bg']));
  assert.deepEqual(doc.nodes['i1;bg'].fills[0].type === 'SOLID' && doc.nodes['i1;bg'].fills[0].color, {r: 0.1, g: 0.1, b: 0.1});
  // A mode picked on the main component is inherited by its instances on a page without one.
  doc = setNodeVariableMode(doc, 'card', 'colors', 'dark').doc;
  const loose = createInstance(doc, 'card', {parentId: 'p', x: 700, newId: 'i2'});
  doc = applyVariables(loose.doc, loose.changed);
  assert.equal(modeForNode(doc, 'i2;bg', 'colors'), 'dark');
  assert.deepEqual(doc.nodes['i2;bg'].fills[0].type === 'SOLID' && doc.nodes['i2;bg'].fills[0].color, {r: 0.1, g: 0.1, b: 0.1});
});

test('deleting variables and modes keeps the values nodes show', () => {
  let doc = themed();
  doc = add(doc, 'RECTANGLE', {id: 'box', parentId: 'p', width: 10, height: 10});
  doc = bindPaintVariable(doc, 'box', 'fills', 0, 'surface').doc;
  doc = bindVariable(doc, 'box', 'width', 'gap').doc;
  doc = createVariable(doc, {id: 'panel', name: 'Panel', collectionId: 'colors', type: 'COLOR', value: {type: 'VARIABLE_ALIAS', id: 'surface'}}).doc;
  doc = setNodeVariableMode(doc, 'box', 'colors', 'dark').doc;
  assert.equal(doc.nodes.box.width, 12);

  const removedMode = removeVariableMode(doc, 'colors', 'dark').doc;
  assert.equal(removedMode.nodes.box.width, 8, 'the node falls back to the default mode');
  assert.equal(removedMode.variableModes?.box, undefined);
  assert.equal(removedMode.variables.gap.valuesByMode.dark, undefined);
  assert.throws(() => removeVariableMode(removedMode, 'colors', 'light'), (error: DesignVariableError) => error.code === 'last_mode');

  doc = deleteVariable(doc, 'surface').doc;
  assert.equal(doc.variables.surface, undefined);
  assert.deepEqual(doc.variableCollections.colors.variableIds, ['gap', 'panel']);
  const fill = doc.nodes.box.fills[0];
  assert.ok(fill.type === 'SOLID' && !fill.boundVariables, 'the binding goes');
  assert.deepEqual(fill.type === 'SOLID' && fill.color, {r: 0.1, g: 0.1, b: 0.1}, 'the value stays');
  assert.deepEqual(doc.variables.panel.valuesByMode, {light: WHITE, dark: INK}, 'aliases become the values they had');
  doc = deleteVariable(doc, 'gap').doc;
  assert.equal(doc.nodes.box.boundVariables, undefined);
  assert.equal(doc.nodes.box.width, 12);
});
