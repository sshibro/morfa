import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../shared/design/types';
import {addComponentProperty, bindProperty, createInstance, DesignComponentError, setInstanceProperty, syncInstances, withOverrideTracking} from '../shared/design/components';
import {
  addVariant, addVariantProperty, combineAsVariants, formatVariantProps, renameVariantProperty, renameVariantValue, setVariantProperty,
  variantFor, variantProps, variantSetIssues, VARIANT_GAP,
} from '../shared/design/variants';

// Variants: a set of components whose names carry property values; instances switch between them and
// keep what the user changed.

const RED = {r: 1, g: 0, b: 0}, GREEN = {r: 0, g: 1, b: 0}, BLUE = {r: 0, g: 0, b: 1};

function add(doc: DesignDocument, type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}): DesignDocument {
  const node = createNode(type, props);
  const parent = doc.nodes[props.parentId];
  return {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
}

const update = (doc: DesignDocument, id: NodeId, partial: Partial<SceneNode>): DesignDocument => ({...doc, nodes: {...doc.nodes, [id]: {...doc.nodes[id], ...partial}}});
const editCopy = (doc: DesignDocument, id: NodeId, partial: Partial<SceneNode>) => syncInstances(update(doc, id, withOverrideTracking(doc, id, partial)), new Set([id]));

/** A button component `id` with a background and a label, at (x, y). */
function button(doc: DesignDocument, id: string, name: string, x: number, y: number, width = 100, color = BLUE): DesignDocument {
  doc = add(doc, 'COMPONENT', {id, parentId: 'p', name, x, y, width, height: 40});
  doc = add(doc, 'RECTANGLE', {id: `${id}-bg`, parentId: id, name: 'Background', width, height: 40, fills: [solid(color)]});
  return add(doc, 'TEXT', {id: `${id}-label`, parentId: id, name: 'Label', x: 10, y: 10, width: 50, height: 20, text: defaultTextProps('Button')});
}

/** Four buttons named by size and state, in reading order. */
function fourButtons(): DesignDocument {
  let doc = createDocument('p');
  doc = button(doc, 'lg', 'Size=Large, State=Normal', 0, 0, 120);
  doc = button(doc, 'lgh', 'Size=Large, State=Hover', 200, 0, 120, GREEN);
  doc = button(doc, 'sm', 'Size=Small, State=Normal', 0, 100, 80);
  return button(doc, 'smh', 'Size=Small, State=Hover', 200, 100, 80, GREEN);
}

test('variant names parse and format', () => {
  assert.deepEqual(variantProps('Size=Large, State=Hover'), {Size: 'Large', State: 'Hover'});
  assert.deepEqual(variantProps(' Type = Primary '), {Type: 'Primary'});
  assert.equal(variantProps('Button'), null);
  assert.equal(variantProps('=Empty'), null);
  assert.equal(formatVariantProps({State: 'Hover', Size: 'Large'}, ['Size', 'State']), 'Size=Large, State=Hover');
});

test('combining components infers properties and lays the variants out in a grid', () => {
  let doc = fourButtons();
  doc = createInstance(doc, 'sm', {parentId: 'p', x: 600, y: 0, newId: 'i1'}).doc;
  const {doc: next, setId} = combineAsVariants(doc, ['smh', 'lg', 'sm', 'lgh'], 'set');
  const set = next.nodes[setId];
  assert.equal(set.type, 'COMPONENT_SET');
  assert.equal(set.name, 'Component');
  assert.deepEqual(set.children, ['lg', 'lgh', 'sm', 'smh'], 'reading order');
  assert.deepEqual(set.componentPropertyDefinitions, {
    Size: {type: 'VARIANT', defaultValue: 'Large', variantOptions: ['Large', 'Small']},
    State: {type: 'VARIANT', defaultValue: 'Normal', variantOptions: ['Normal', 'Hover']},
  });
  assert.equal(set.dashPattern.length, 2, 'the dashed frame of a set');
  // A matrix: columns are states, rows sizes; cells as wide as their widest variant, 20 px apart.
  const at = (id: string) => [next.nodes[id].x, next.nodes[id].y];
  assert.deepEqual(at('lg'), [VARIANT_GAP, VARIANT_GAP]);
  assert.deepEqual(at('lgh'), [VARIANT_GAP + 120 + VARIANT_GAP, VARIANT_GAP]);
  assert.deepEqual(at('sm'), [VARIANT_GAP, VARIANT_GAP + 40 + VARIANT_GAP]);
  assert.deepEqual(at('smh'), [VARIANT_GAP + 120 + VARIANT_GAP, VARIANT_GAP + 40 + VARIANT_GAP]);
  assert.deepEqual([set.x, set.y, set.width, set.height], [0, 0, 20 + 120 + 20 + 120 + 20, 20 + 40 + 20 + 40 + 20]);
  for (const id of set.children!) assert.equal(next.nodes[id].parentId, setId);
  assert.deepEqual(next.nodes.p.children!.filter(id => next.nodes[id].type !== 'INSTANCE'), [setId]);
  // The existing instance keeps working and now shows its variant values under the set's name.
  assert.equal(next.nodes.i1.componentId, 'sm');
  assert.equal(next.nodes.i1.name, 'Component');
  assert.deepEqual(next.nodes.i1.componentProperties, {Size: 'Small', State: 'Normal'});
  assert.deepEqual(createInstance(next, setId, {parentId: 'p', newId: 'i2'}).doc.nodes.i2.componentId, 'lg', 'a set gives its top-left variant');
});

test('unknown names become "Property 1=Variant N", folder names give the set its name', () => {
  let doc = createDocument('p');
  doc = button(doc, 'a', 'Button', 0, 0);
  doc = button(doc, 'b', 'Button dark', 200, 0);
  const plain = combineAsVariants(doc, ['a', 'b'], 'set').doc;
  assert.equal(plain.nodes.set.name, 'Button');
  assert.deepEqual([plain.nodes.a.name, plain.nodes.b.name], ['Property 1=Variant 1', 'Property 1=Variant 2']);
  assert.deepEqual(plain.nodes.set.componentPropertyDefinitions!['Property 1'].variantOptions, ['Variant 1', 'Variant 2']);

  let folders = createDocument('p');
  folders = button(folders, 'a', 'Button/Primary', 0, 0);
  folders = button(folders, 'b', 'Button/Secondary', 200, 0);
  const named = combineAsVariants(folders, ['a', 'b'], 'set').doc;
  assert.equal(named.nodes.set.name, 'Button');
  assert.deepEqual([named.nodes.a.name, named.nodes.b.name], ['Property 1=Primary', 'Property 1=Secondary']);
  assert.throws(() => combineAsVariants(named, ['a'], 'again'), (error: DesignComponentError) => error.code === 'unsupported');
  assert.throws(() => combineAsVariants(named, ['a-bg'], 'again'), (error: DesignComponentError) => error.code === 'not_component');
});

test('switching a variant keeps the instance\'s overrides', () => {
  let doc = combineAsVariants(fourButtons(), ['lg', 'lgh', 'sm', 'smh'], 'set').doc;
  doc = createInstance(doc, 'set', {parentId: 'p', x: 600, newId: 'i1'}).doc;
  doc = editCopy(doc, 'i1;lg-label', {text: {...doc.nodes['i1;lg-label'].text!, characters: 'Buy'}});
  doc = editCopy(doc, 'i1', {opacity: 0.5});
  const switched = setVariantProperty(doc, 'i1', 'State', 'Hover').doc;
  const instance = switched.nodes.i1;
  assert.equal(instance.componentId, 'lgh');
  assert.deepEqual(instance.componentProperties, {Size: 'Large', State: 'Hover'});
  assert.equal(instance.opacity, 0.5);
  assert.deepEqual(instance.children, ['i1;lgh-bg', 'i1;lgh-label']);
  assert.equal(switched.nodes['i1;lgh-label'].text!.characters, 'Buy');
  assert.deepEqual(switched.nodes['i1;lgh-label'].overrides, ['text.characters']);
  assert.deepEqual(switched.nodes['i1;lgh-bg'].fills, [solid(GREEN)], 'the rest comes from the new variant');
  assert.equal(switched.nodes['i1;lg-label'], undefined);
  // And back again, through the generic property setter.
  const back = setInstanceProperty(switched, 'i1', 'State', 'Normal').doc;
  assert.equal(back.nodes.i1.componentId, 'lg');
  assert.equal(back.nodes['i1;lg-label'].text!.characters, 'Buy');
});

test('a missing combination falls back to the closest variant', () => {
  let doc = fourButtons();
  doc = {...doc, nodes: {...doc.nodes, p: {...doc.nodes.p, children: doc.nodes.p.children!.filter(id => id !== 'smh')}}};
  for (const id of ['smh', 'smh-bg', 'smh-label']) delete doc.nodes[id];
  doc = combineAsVariants(doc, ['lg', 'lgh', 'sm'], 'set').doc;
  assert.equal(variantFor(doc, 'set', {Size: 'Small', State: 'Hover'}, 'Size'), 'sm');
  doc = createInstance(doc, 'lgh', {parentId: 'p', x: 600, newId: 'i1'}).doc;
  doc = setVariantProperty(doc, 'i1', 'Size', 'Small').doc;
  assert.equal(doc.nodes.i1.componentId, 'sm');
  assert.deepEqual(doc.nodes.i1.componentProperties, {Size: 'Small', State: 'Normal'});
  assert.throws(() => setVariantProperty(doc, 'i1', 'Size', 'Huge'), (error: DesignComponentError) => error.code === 'no_variant');
  assert.throws(() => setVariantProperty(doc, 'i1', 'Color', 'Red'), (error: DesignComponentError) => error.code === 'unknown_property');
});

test('a nested instance switches variant as an override of its instance', () => {
  let doc = combineAsVariants(fourButtons(), ['lg', 'lgh', 'sm', 'smh'], 'set').doc;
  doc = add(doc, 'COMPONENT', {id: 'card', parentId: 'p', y: 400, width: 300, height: 200});
  doc = createInstance(doc, 'set', {parentId: 'card', x: 20, y: 20, newId: 'n1'}).doc;
  doc = createInstance(doc, 'card', {parentId: 'p', x: 600, y: 400, newId: 'c1'}).doc;
  doc = setVariantProperty(doc, 'c1;n1', 'State', 'Hover').doc;
  assert.equal(doc.nodes['c1;n1'].componentId, 'lgh');
  assert.deepEqual(doc.nodes['c1;n1'].overrides, ['componentId']);
  assert.deepEqual(doc.nodes['c1;n1'].children, ['c1;n1;lgh-bg', 'c1;n1;lgh-label']);
  assert.equal(doc.nodes.n1.componentId, 'lg', 'the main keeps its variant');
  // The main's nested instance changes its size: the overridden copy keeps the state it was switched to.
  doc = setVariantProperty(doc, 'n1', 'Size', 'Small').doc;
  assert.equal(doc.nodes.n1.componentId, 'sm');
  assert.equal(doc.nodes['c1;n1'].componentId, 'lgh');
});

test('properties shared by a set reach every variant\'s instances', () => {
  let doc = combineAsVariants(fourButtons(), ['lg', 'lgh', 'sm', 'smh'], 'set').doc;
  const property = addComponentProperty(doc, 'lg', {name: 'Label', type: 'TEXT', defaultValue: 'Button'});
  doc = property.doc;
  assert.equal(doc.nodes.set.componentPropertyDefinitions![property.key].type, 'TEXT', 'a variant\'s property lives on its set');
  doc = bindProperty(doc, 'lg-label', 'characters', property.key).doc;
  doc = bindProperty(doc, 'lgh-label', 'characters', property.key).doc;
  doc = createInstance(doc, 'lg', {parentId: 'p', x: 600, newId: 'i1'}).doc;
  doc = setInstanceProperty(doc, 'i1', property.key, 'Pay').doc;
  assert.equal(doc.nodes['i1;lg-label'].text!.characters, 'Pay');
  doc = setVariantProperty(doc, 'i1', 'State', 'Hover').doc;
  assert.equal(doc.nodes['i1;lgh-label'].text!.characters, 'Pay', 'the value survives the switch');
});

test('adding variants and properties, renaming properties and values', () => {
  let doc = combineAsVariants(fourButtons(), ['lg', 'lgh', 'sm', 'smh'], 'set').doc;
  doc = createInstance(doc, 'lgh', {parentId: 'p', x: 600, newId: 'i1'}).doc;
  const added = addVariant(doc, 'set', {newId: 'v5'});
  doc = added.doc;
  const variant = doc.nodes.v5;
  assert.equal(variant.type, 'COMPONENT');
  assert.equal(variant.name, 'Size=Large, State=Variant 5');
  assert.deepEqual(variant.children, ['v5-2', 'v5-3'], 'its layers are fresh copies of the default variant\'s');
  assert.equal(doc.nodes['v5-2'].name, 'Background');
  assert.equal(variant.y, 20 + 40 + 20 + 40 + VARIANT_GAP);
  assert.equal(doc.nodes.set.height, variant.y + variant.height + VARIANT_GAP);
  assert.deepEqual(doc.nodes.set.componentPropertyDefinitions!.State.variantOptions, ['Normal', 'Hover', 'Variant 5']);

  doc = renameVariantProperty(doc, 'set', 'State', 'Style').doc;
  assert.equal(doc.nodes.lgh.name, 'Size=Large, Style=Hover');
  assert.deepEqual(Object.keys(doc.nodes.set.componentPropertyDefinitions!), ['Size', 'Style']);
  assert.deepEqual(doc.nodes.i1.componentProperties, {Size: 'Large', Style: 'Hover'});

  doc = renameVariantValue(doc, 'set', 'Style', 'Hover', 'Hovered').doc;
  assert.equal(doc.nodes.smh.name, 'Size=Small, Style=Hovered');
  assert.deepEqual(doc.nodes.set.componentPropertyDefinitions!.Style.variantOptions, ['Normal', 'Hovered', 'Variant 5']);
  assert.equal(doc.nodes.i1.componentProperties!.Style, 'Hovered');

  doc = addVariantProperty(doc, 'set', 'Icon', 'None').doc;
  assert.equal(doc.nodes.lg.name, 'Size=Large, Style=Normal, Icon=None');
  assert.deepEqual(doc.nodes.i1.componentProperties, {Size: 'Large', Style: 'Hovered', Icon: 'None'});
  assert.throws(() => renameVariantProperty(doc, 'set', 'Style', 'Size'), (error: DesignComponentError) => error.code === 'duplicate_property');
  assert.throws(() => renameVariantValue(doc, 'set', 'Style', 'Normal', 'a=b'), (error: DesignComponentError) => error.code === 'invalid_name');
});

test('duplicate combinations and broken names are reported; a rename in the layers panel updates the set', () => {
  let doc = combineAsVariants(fourButtons(), ['lg', 'lgh', 'sm', 'smh'], 'set').doc;
  assert.deepEqual(variantSetIssues(doc, 'set'), []);
  doc = renameVariantValue(doc, 'set', 'State', 'Hover', 'Normal').doc;
  assert.deepEqual(variantSetIssues(doc, 'set'), [
    {type: 'duplicate', ids: ['lg', 'lgh'], name: 'Size=Large, State=Normal'},
    {type: 'duplicate', ids: ['sm', 'smh'], name: 'Size=Small, State=Normal'},
  ]);
  // Renamed by hand, as the layers panel does it: the set's options follow on the next sync.
  doc = syncInstances(update(doc, 'smh', {name: 'Size=Small, State=Pressed'}), new Set(['smh']));
  assert.deepEqual(doc.nodes.set.componentPropertyDefinitions!.State.variantOptions, ['Normal', 'Pressed']);
  doc = syncInstances(update(doc, 'lgh', {name: 'Hover'}), new Set(['lgh']));
  assert.deepEqual(variantSetIssues(doc, 'set'), [{type: 'invalid_name', id: 'lgh'}]);
});
