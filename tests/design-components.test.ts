import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {resizeUpdates} from '../shared/design/constraints';
import {normalizeDocument} from '../shared/design/normalize';
import {
  addComponentProperty, bindProperty, createComponent, createInstance, deleteProperty, DesignComponentError, detachInstance, editProperty,
  goToMainComponent, instancesOfComponent, isOverridden, moveViolation, propertyForField, pushOverridesToMain, recordOverrides, resetOverrides,
  setInstanceProperty, swapInstance, syncInstances, syncInstancesDetailed, withOverrideTracking, wouldCreateCycle,
} from '../shared/design/components';
import {budget} from './helpers/speed';

// The components engine: instances mirror their main, keep every override through every sync, and
// sync only what a change touches.

const RED = {r: 1, g: 0, b: 0}, GREEN = {r: 0, g: 1, b: 0}, BLUE = {r: 0, g: 0, b: 1};

function add(doc: DesignDocument, type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}, index?: number): DesignDocument {
  const node = createNode(type, props);
  const parent = doc.nodes[props.parentId];
  const children = [...(parent.children ?? [])];
  children.splice(index ?? children.length, 0, node.id);
  return {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children}}};
}

const update = (doc: DesignDocument, id: NodeId, partial: Partial<SceneNode>): DesignDocument => ({...doc, nodes: {...doc.nodes, [id]: {...doc.nodes[id], ...partial}}});

/** A change to the main as a transaction makes it, then the sync normalize runs. */
const editMain = (doc: DesignDocument, id: NodeId, partial: Partial<SceneNode>) => syncInstances(update(doc, id, partial), new Set([id]));

/** A change to an instance or one of its copies as the editor makes it: overrides tracked, then synced. */
const editCopy = (doc: DesignDocument, id: NodeId, partial: Partial<SceneNode>) => syncInstances(update(doc, id, withOverrideTracking(doc, id, partial)), new Set([id]));

function removeNode(doc: DesignDocument, id: NodeId): DesignDocument {
  const node = doc.nodes[id];
  const nodes = {...doc.nodes};
  delete nodes[id];
  const parent = nodes[node.parentId!];
  nodes[parent.id] = {...parent, children: parent.children!.filter(child => child !== id)};
  return syncInstances({...doc, nodes}, new Set([id, parent.id]));
}

const text = (characters: string) => defaultTextProps(characters);

/** Page "p" with the main component "btn" (120×40): background "bg" stretching, label "label", icon "icon" pinned right. */
function buttonDoc(): DesignDocument {
  let doc = createDocument('p');
  doc = add(doc, 'COMPONENT', {id: 'btn', parentId: 'p', name: 'Button', width: 120, height: 40});
  doc = add(doc, 'RECTANGLE', {id: 'bg', parentId: 'btn', name: 'Background', width: 120, height: 40, fills: [solid(BLUE)], constraints: {horizontal: 'STRETCH', vertical: 'STRETCH'}});
  doc = add(doc, 'TEXT', {id: 'label', parentId: 'btn', name: 'Label', x: 10, y: 10, width: 60, height: 20, text: text('Button')});
  doc = add(doc, 'ELLIPSE', {id: 'icon', parentId: 'btn', name: 'Icon', x: 96, y: 12, width: 16, height: 16, constraints: {horizontal: 'MAX', vertical: 'CENTER'}});
  return doc;
}

const place = (doc: DesignDocument, componentId: NodeId, id: NodeId, parentId = 'p', x = 0, y = 300) => createInstance(doc, componentId, {parentId, x, y, newId: id}).doc;

function checkTree(doc: DesignDocument): void {
  for (const node of Object.values(doc.nodes)) {
    if (node.parentId === null) continue;
    const parent = doc.nodes[node.parentId];
    assert.ok(parent, `${node.id} has a parent`);
    assert.equal(parent.children!.filter(id => id === node.id).length, 1, `${node.id} is listed once by ${parent.id}`);
    if (node.mainId !== undefined) assert.ok(node.id.endsWith(`;${node.mainId}`) || node.id.includes(';'), `${node.id} is a derived id`);
  }
  for (const node of Object.values(doc.nodes)) for (const child of node.children ?? []) assert.equal(doc.nodes[child]?.parentId, node.id, `${child} points back to ${node.id}`);
}

test('an instance mirrors its main with ids derived from the main', () => {
  const {doc, id, changed} = createInstance(buttonDoc(), 'btn', {parentId: 'p', x: 300, y: 20, newId: 'i1'});
  const instance = doc.nodes[id];
  assert.equal(instance.type, 'INSTANCE');
  assert.equal(instance.componentId, 'btn');
  assert.equal(instance.name, 'Button');
  assert.deepEqual([instance.x, instance.y, instance.width, instance.height], [300, 20, 120, 40]);
  assert.deepEqual(instance.children, ['i1;bg', 'i1;label', 'i1;icon']);
  assert.equal(doc.nodes['i1;label'].mainId, 'label');
  assert.equal(doc.nodes['i1;label'].text!.characters, 'Button');
  assert.equal(doc.nodes['i1;bg'].parentId, 'i1');
  assert.ok(changed.has('i1') && changed.has('i1;icon') && changed.has('p'));
  assert.deepEqual(doc.nodes.p.children, ['btn', 'i1']);
  checkTree(doc);
  // Syncing again changes nothing and keeps the document's identity.
  assert.equal(syncInstances(doc, new Set(['btn', 'i1'])), doc);
});

/** "glyph" lives in "ico"; "chip" holds an instance n1 of "ico"; "card" holds an instance n2 of "chip". */
function nestedDoc(): DesignDocument {
  let doc = createDocument('p');
  doc = add(doc, 'COMPONENT', {id: 'ico', parentId: 'p', name: 'Badge', width: 24, height: 24});
  doc = add(doc, 'ELLIPSE', {id: 'glyph', parentId: 'ico', name: 'Glyph', width: 24, height: 24, fills: [solid(BLUE)]});
  doc = add(doc, 'COMPONENT', {id: 'ico2', parentId: 'p', name: 'Badge 2', x: 40, width: 24, height: 24});
  doc = add(doc, 'STAR', {id: 'star', parentId: 'ico2', name: 'Glyph', width: 24, height: 24});
  doc = add(doc, 'COMPONENT', {id: 'chip', parentId: 'p', name: 'Chip', y: 100, width: 80, height: 32});
  doc = add(doc, 'TEXT', {id: 'chip-label', parentId: 'chip', name: 'Label', x: 30, y: 6, width: 40, height: 20, text: text('Chip')});
  doc = createInstance(doc, 'ico', {parentId: 'chip', x: 4, y: 4, newId: 'n1'}).doc;
  doc = add(doc, 'COMPONENT', {id: 'card', parentId: 'p', name: 'Card', y: 200, width: 200, height: 120});
  doc = createInstance(doc, 'chip', {parentId: 'card', x: 10, y: 10, newId: 'n2'}).doc;
  return doc;
}

test('nested instances are copied as instances, two levels deep, with unique deterministic ids', () => {
  let doc = place(nestedDoc(), 'card', 'top');
  assert.equal(doc.nodes['n1;glyph'].mainId, 'glyph');
  assert.equal(doc.nodes['n2;n1'].type, 'INSTANCE');
  assert.equal(doc.nodes['n2;n1'].mainId, 'n1');
  assert.equal(doc.nodes['n2;n1'].componentId, 'ico');
  assert.equal(doc.nodes['n2;n1;glyph'].mainId, 'n1;glyph');
  assert.deepEqual(doc.nodes.top.children, ['top;n2']);
  assert.deepEqual(doc.nodes['top;n2'].children, ['top;n2;chip-label', 'top;n2;n1'], 'copies inside a nested instance carry its id');
  assert.equal(doc.nodes['top;n1'], undefined);
  assert.equal(doc.nodes['top;n2;n1'].mainId, 'n2;n1');
  assert.equal(doc.nodes['top;n2;n1;glyph'].mainId, 'n2;n1;glyph');
  checkTree(doc);

  // A change two components down reaches the outermost instance in one sync.
  doc = editMain(doc, 'glyph', {fills: [solid(RED)]});
  for (const id of ['n1;glyph', 'n2;n1;glyph', 'top;n2;n1;glyph']) assert.deepEqual(doc.nodes[id].fills[0], solid(RED), id);
  // A main-level override on the nested instance (inside "card") reaches the instance of "card".
  doc = editCopy(doc, 'n2;n1;glyph', {fills: [solid(GREEN)]});
  assert.deepEqual(doc.nodes['n2;n1;glyph'].overrides, ['fills']);
  assert.deepEqual(doc.nodes['top;n2;n1;glyph'].fills[0], solid(GREEN));
  assert.equal(doc.nodes['top;n2;n1;glyph'].overrides, undefined, 'the outer copy inherits, it does not override');
  doc = editMain(doc, 'glyph', {fills: [solid(BLUE)], strokes: [solid(RED)]});
  assert.deepEqual(doc.nodes['top;n2;n1;glyph'].fills[0], solid(GREEN));
  assert.deepEqual(doc.nodes['top;n2;n1;glyph'].strokes[0], solid(RED));
});

test('a fill override survives while the main\'s stroke change propagates', () => {
  let doc = place(place(buttonDoc(), 'btn', 'i1'), 'btn', 'i2', 'p', 200);
  doc = editCopy(doc, 'i1;bg', {fills: [solid(RED)]});
  assert.deepEqual(doc.nodes['i1;bg'].overrides, ['fills']);
  doc = editMain(doc, 'bg', {strokes: [solid(GREEN)], strokeWeight: 2, fills: [solid(BLUE), solid(GREEN)]});
  assert.deepEqual(doc.nodes['i1;bg'].fills, [solid(RED)]);
  assert.deepEqual(doc.nodes['i1;bg'].strokes, [solid(GREEN)]);
  assert.equal(doc.nodes['i1;bg'].strokeWeight, 2);
  assert.deepEqual(doc.nodes['i2;bg'].fills, [solid(BLUE), solid(GREEN)]);
});

test('a text override survives while the main\'s text style changes', () => {
  let doc = place(buttonDoc(), 'btn', 'i1');
  doc = editCopy(doc, 'i1;label', {text: {...doc.nodes['i1;label'].text!, characters: 'Buy'}});
  assert.deepEqual(doc.nodes['i1;label'].overrides, ['text.characters']);
  const main = doc.nodes.label.text!;
  doc = editMain(doc, 'label', {text: {...main, characters: 'Submit', style: {...main.style, fontSize: 20, fontWeight: 700}, textAlignHorizontal: 'CENTER'}});
  const copy = doc.nodes['i1;label'].text!;
  assert.equal(copy.characters, 'Buy');
  assert.equal(copy.style.fontSize, 20);
  assert.equal(copy.style.fontWeight, 700);
  assert.equal(copy.textAlignHorizontal, 'CENTER');
  // A style part overridden on the copy stays while another part follows.
  doc = editCopy(doc, 'i1;label', {text: {...copy, style: {...copy.style, fontWeight: 300}}});
  assert.ok(isOverridden(doc.nodes['i1;label'], 'text.style.fontWeight'));
  const next = doc.nodes.label.text!;
  doc = editMain(doc, 'label', {text: {...next, style: {...next.style, fontSize: 24, fontWeight: 900}}});
  assert.equal(doc.nodes['i1;label'].text!.style.fontSize, 24);
  assert.equal(doc.nodes['i1;label'].text!.style.fontWeight, 300);
});

test('added, removed and reordered main children are reflected, overrides kept', () => {
  let doc = place(buttonDoc(), 'btn', 'i1');
  doc = editCopy(doc, 'i1;bg', {fills: [solid(RED)]});
  doc = add(doc, 'RECTANGLE', {id: 'badge', parentId: 'btn', name: 'Tag', x: 100, width: 10, height: 10});
  doc = syncInstances(doc, new Set(['badge', 'btn']));
  assert.deepEqual(doc.nodes.i1.children, ['i1;bg', 'i1;label', 'i1;icon', 'i1;badge']);
  assert.equal(doc.nodes['i1;badge'].mainId, 'badge');
  doc = removeNode(doc, 'icon');
  assert.deepEqual(doc.nodes.i1.children, ['i1;bg', 'i1;label', 'i1;badge']);
  assert.equal(doc.nodes['i1;icon'], undefined);
  doc = editMain(doc, 'btn', {children: ['badge', 'label', 'bg']});
  assert.deepEqual(doc.nodes.i1.children, ['i1;badge', 'i1;label', 'i1;bg']);
  assert.deepEqual(doc.nodes['i1;bg'].fills, [solid(RED)]);
  checkTree(doc);
});

test('a child moved into another frame of the main keeps its copy and overrides', () => {
  let doc = buttonDoc();
  doc = add(doc, 'FRAME', {id: 'box', parentId: 'btn', name: 'Block', width: 50, height: 40, fills: []});
  doc = place(doc, 'btn', 'i1');
  doc = editCopy(doc, 'i1;label', {fills: [solid(RED)]});
  // The label moves from the component into the frame "box" (a transaction marks both parents dirty).
  doc = update(doc, 'btn', {children: ['bg', 'box', 'icon']});
  doc = update(doc, 'box', {children: ['label']});
  doc = syncInstances(update(doc, 'label', {parentId: 'box'}), new Set(['btn', 'box', 'label']));
  assert.equal(doc.nodes['i1;label'].parentId, 'i1;box');
  assert.deepEqual(doc.nodes['i1;label'].fills, [solid(RED)]);
  checkTree(doc);
});

test('a resized instance lays its children out by their constraints', () => {
  let doc = place(buttonDoc(), 'btn', 'i1');
  doc = editCopy(doc, 'i1', {x: 5, width: 200, height: 60});
  assert.deepEqual(doc.nodes.i1.overrides, ['width', 'height'], 'position is the instance\'s own, size is an override');
  assert.deepEqual([doc.nodes['i1;bg'].width, doc.nodes['i1;bg'].height], [200, 60]);
  assert.deepEqual([doc.nodes['i1;icon'].x, doc.nodes['i1;icon'].y], [176, 22]);
  assert.equal(doc.nodes['i1;label'].x, 10);
  // The main changes: the instance keeps its size and its children follow the new main positions.
  doc = editMain(doc, 'icon', {x: 90});
  assert.equal(doc.nodes['i1;icon'].x, 170);
  assert.equal(doc.nodes.i1.width, 200);
  // A child moved by hand keeps its place.
  doc = editCopy(doc, 'i1;icon', {x: 4});
  doc = editMain(doc, 'icon', {x: 80});
  assert.equal(doc.nodes['i1;icon'].x, 4);
});

const measurer: TextMeasurer = {
  width: (value, font) => value.length * font.size * 0.5,
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

/** A user edit as the editor commits it: tracked on the node acted on, the rest of the updates (a resize's
 *  constraint moves of descendants) applied as they are, then the normalize pass. */
function commit(doc: DesignDocument, updates: Map<NodeId, Partial<SceneNode>>, acted: NodeId): DesignDocument {
  const tracked = recordOverrides(doc, updates, {direct: new Set([acted])});
  const nodes = {...doc.nodes};
  for (const [id, partial] of tracked) nodes[id] = {...nodes[id], ...partial};
  return normalizeDocument({...doc, nodes}, new Set(tracked.keys()), {measurer});
}

test('constraint and layout geometry of instance children is derived, never an override', () => {
  const created = createInstance(buttonDoc(), 'btn', {parentId: 'p', y: 300, newId: 'i1'});
  let doc = normalizeDocument(created.doc, created.changed, {measurer});
  // Resizing the instance by hand: constraints.ts moves its children, only the instance's size is an override.
  doc = commit(doc, resizeUpdates(doc, 'i1', {x: 0, y: 300, width: 200, height: 60}), 'i1');
  assert.deepEqual(doc.nodes.i1.overrides, ['width', 'height']);
  for (const id of doc.nodes.i1.children!) assert.equal(doc.nodes[id].overrides, undefined, id);
  assert.deepEqual([doc.nodes['i1;bg'].width, doc.nodes['i1;bg'].height, doc.nodes['i1;icon'].x, doc.nodes['i1;icon'].y], [200, 60, 176, 22]);
  // The main changes: children are recomputed from the main and the instance's size.
  doc = normalizeDocument(update(doc, 'icon', {x: 90, y: 4}), new Set(['icon']), {measurer});
  assert.deepEqual([doc.nodes['i1;icon'].x, doc.nodes['i1;icon'].y], [170, 14]);

  // An auto-layout instance: positions come from layout, survive syncs, and are not overrides.
  let row = createDocument('p');
  row = add(row, 'COMPONENT', {id: 'row', parentId: 'p', width: 10, height: 10, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG',
    autoLayout: {...createNode('FRAME', {id: 'x'}).autoLayout!, layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingLeft: 10, paddingRight: 10}});
  row = add(row, 'RECTANGLE', {id: 'a', parentId: 'row', width: 20, height: 20});
  row = add(row, 'TEXT', {id: 't', parentId: 'row', name: 'Label', text: text('Buy')});
  const placed = createInstance(row, 'row', {parentId: 'p', newId: 'r1'});
  row = normalizeDocument(placed.doc, new Set([...Object.keys(row.nodes), ...placed.changed]), {measurer});
  assert.equal(row.nodes.r1.width, row.nodes.row.width);
  row = commit(row, new Map([['r1;t', {text: {...row.nodes['r1;t'].text!, characters: 'Buy now'}}]]), 'r1;t');
  assert.deepEqual(row.nodes['r1;t'].overrides, ['text.characters']);
  assert.ok(row.nodes.r1.width > row.nodes.row.width, 'the instance hugs its longer text');
  const laidOut = row;
  // An unrelated change of the main: the instance keeps its layout and its untouched copies their identity.
  row = normalizeDocument(update(row, 'a', {fills: [solid(RED)]}), new Set(['a']), {measurer});
  assert.equal(row.nodes.r1.width, laidOut.nodes.r1.width);
  assert.equal(row.nodes['r1;t'], laidOut.nodes['r1;t']);
  assert.deepEqual(row.nodes['r1;a'].fills, [solid(RED)]);
  assert.equal(row.nodes['r1;a'].overrides, undefined);
  // Spacing changes in the main: layout places the copies again from the instance's own content.
  row = normalizeDocument(update(row, 'row', {autoLayout: {...row.nodes.row.autoLayout!, itemSpacing: 20}}), new Set(['row']), {measurer});
  assert.equal(row.nodes['r1;t'].x, 10 + 20 + 20);
  assert.equal(row.nodes.r1.width, 10 + 20 + 20 + row.nodes['r1;t'].width + 10);
});

test('override tracking records what the user changed, not what layout derives', () => {
  let doc = buttonDoc();
  doc = add(doc, 'COMPONENT', {id: 'row', parentId: 'p', y: 100, width: 300, height: 40, autoLayout: {...createNode('FRAME', {id: 'x'}).autoLayout!, layoutMode: 'HORIZONTAL'}});
  doc = add(doc, 'RECTANGLE', {id: 'cell', parentId: 'row', width: 50, height: 40});
  doc = place(doc, 'row', 'r1');
  assert.deepEqual(withOverrideTracking(doc, 'r1;cell', {x: 70, y: 0}), {x: 70, y: 0}, 'flow positions are not overrides');
  assert.deepEqual(withOverrideTracking(doc, 'r1;cell', {width: 80}).overrides, ['width']);
  assert.deepEqual(withOverrideTracking(doc, 'r1;cell', {name: 'Cell'}).overrides, ['name']);
  assert.deepEqual(withOverrideTracking(doc, 'r1', {x: 1, y: 2, rotation: 15, visible: false}), {x: 1, y: 2, rotation: 15, visible: false});
  assert.deepEqual(withOverrideTracking(doc, 'cell', {fills: []}), {fills: []}, 'the main itself has no overrides');
  const updates = recordOverrides(doc, new Map<NodeId, Partial<SceneNode>>([['r1', {width: 400}], ['r1;cell', {x: 3, width: 60}]]), {direct: new Set(['r1'])});
  assert.deepEqual(updates.get('r1')!.overrides, ['width']);
  assert.equal(updates.get('r1;cell')!.overrides, undefined, 'a parent\'s resize moving a child is not the child\'s override');
  // An unchanged value is not an override; a partial that sets overrides itself is left alone.
  assert.deepEqual(withOverrideTracking(doc, 'r1;cell', {fills: doc.nodes['r1;cell'].fills}), {fills: doc.nodes['r1;cell'].fills});
  assert.deepEqual(withOverrideTracking(doc, 'r1;cell', {overrides: []}), {overrides: []});
});

test('detaching turns the instance into a frame and keeps nested instances', () => {
  let doc = place(nestedDoc(), 'chip', 'c1');
  doc = editCopy(doc, 'c1;n1;glyph', {fills: [solid(RED)]});
  doc = editCopy(doc, 'c1;chip-label', {fills: [solid(GREEN)]});
  let counter = 0;
  const result = detachInstance(doc, 'c1', () => `d${++counter}`);
  doc = result.doc;
  const frame = doc.nodes.c1;
  assert.equal(frame.type, 'FRAME');
  assert.equal(frame.componentId, undefined);
  assert.equal(frame.overrides, undefined);
  const [label, nested] = frame.children!.map(id => doc.nodes[id]);
  assert.equal(label.type, 'TEXT');
  assert.equal(label.mainId, undefined);
  assert.equal(label.overrides, undefined);
  assert.deepEqual(label.fills, [solid(GREEN)]);
  assert.equal(nested.type, 'INSTANCE');
  assert.equal(nested.mainId, undefined);
  assert.equal(nested.componentId, 'ico');
  assert.deepEqual(nested.children, [`${nested.id};glyph`]);
  const glyph = doc.nodes[`${nested.id};glyph`];
  assert.equal(glyph.mainId, 'glyph');
  assert.deepEqual(glyph.overrides, ['fills']);
  assert.equal(result.ids.get('c1;n1'), nested.id);
  assert.ok(!Object.keys(doc.nodes).some(id => id.startsWith('c1;')), 'no copy of the old instance is left');
  checkTree(doc);
  // The re-rooted instance still follows its main and keeps its override.
  doc = editMain(doc, 'glyph', {fills: [solid(BLUE)], strokes: [solid(RED)]});
  assert.deepEqual(doc.nodes[`${nested.id};glyph`].fills, [solid(RED)]);
  assert.deepEqual(doc.nodes[`${nested.id};glyph`].strokes, [solid(RED)]);
  assert.throws(() => detachInstance(place(nestedDoc(), 'chip', 'c2'), 'c2;n1'), (error: DesignComponentError) => error.code === 'nested_instance');
});

test('resetting overrides brings the main\'s values back', () => {
  let doc = place(buttonDoc(), 'btn', 'i1');
  doc = editCopy(doc, 'i1;bg', {fills: [solid(RED)], opacity: 0.5});
  doc = editCopy(doc, 'i1;label', {text: {...doc.nodes['i1;label'].text!, characters: 'Buy'}});
  doc = editCopy(doc, 'i1', {fills: [solid(GREEN)]});
  doc = resetOverrides(doc, 'i1;bg', ['fills']).doc;
  assert.deepEqual(doc.nodes['i1;bg'].fills, [solid(BLUE)]);
  assert.equal(doc.nodes['i1;bg'].opacity, 0.5);
  assert.deepEqual(doc.nodes['i1;bg'].overrides, ['opacity']);
  doc = resetOverrides(doc, 'i1;label', ['text']).doc;
  assert.equal(doc.nodes['i1;label'].text!.characters, 'Button');
  doc = resetOverrides(doc, 'i1').doc;
  for (const id of ['i1', 'i1;bg', 'i1;label', 'i1;icon']) assert.equal(doc.nodes[id].overrides, undefined, id);
  assert.deepEqual(doc.nodes.i1.fills, doc.nodes.btn.fills);
  assert.equal(doc.nodes['i1;bg'].opacity, 1);
});

test('swapping keeps the overrides of layers that match by name', () => {
  let doc = buttonDoc();
  doc = add(doc, 'COMPONENT', {id: 'btn2', parentId: 'p', name: 'Button 2', y: 100, width: 160, height: 48});
  doc = add(doc, 'RECTANGLE', {id: 'bg2', parentId: 'btn2', name: 'Background', width: 160, height: 48, fills: [solid(GREEN)]});
  doc = add(doc, 'TEXT', {id: 'label2', parentId: 'btn2', name: 'Label', x: 20, y: 12, width: 80, height: 20, text: text('Second')});
  doc = place(doc, 'btn', 'i1');
  doc = editCopy(doc, 'i1;label', {text: {...doc.nodes['i1;label'].text!, characters: 'Buy'}});
  doc = editCopy(doc, 'i1;icon', {visible: false});
  doc = editCopy(doc, 'i1', {opacity: 0.8});
  doc = swapInstance(doc, 'i1', 'btn2').doc;
  assert.equal(doc.nodes.i1.componentId, 'btn2');
  assert.deepEqual(doc.nodes.i1.children, ['i1;bg2', 'i1;label2']);
  assert.equal(doc.nodes['i1;label2'].text!.characters, 'Buy');
  assert.deepEqual(doc.nodes['i1;label2'].overrides, ['text.characters']);
  assert.equal(doc.nodes['i1;label2'].x, 20, 'not-overridden fields come from the new main');
  assert.deepEqual(doc.nodes['i1;bg2'].fills, [solid(GREEN)]);
  assert.equal(doc.nodes.i1.opacity, 0.8);
  assert.deepEqual([doc.nodes.i1.width, doc.nodes.i1.height], [160, 48]);
  assert.equal(doc.nodes['i1;label'], undefined);
  assert.equal(doc.nodes['i1;icon'], undefined);
  checkTree(doc);
});

test('an instance is named after its main until it is renamed', () => {
  let doc = place(place(buttonDoc(), 'btn', 'i1'), 'btn', 'i2', 'p', 200);
  doc = editCopy(doc, 'i2', {name: 'Buy'});
  assert.deepEqual(doc.nodes.i2.overrides, ['name']);
  doc = editMain(doc, 'btn', {name: 'Primary button'});
  assert.equal(doc.nodes.i1.name, 'Primary button');
  assert.equal(doc.nodes.i2.name, 'Buy');
  // Layer names inside follow too, unless renamed on the copy.
  doc = editCopy(doc, 'i1;bg', {name: 'Plate'});
  doc = editMain(doc, 'bg', {name: 'Button background'});
  assert.equal(doc.nodes['i1;bg'].name, 'Plate');
  assert.equal(doc.nodes['i2;bg'].name, 'Button background');
});

test('a swap carries property values over to same-named properties', () => {
  let doc = buttonDoc();
  doc = add(doc, 'COMPONENT', {id: 'btn2', parentId: 'p', name: 'Button 2', y: 100, width: 120, height: 40});
  doc = add(doc, 'ELLIPSE', {id: 'icon2', parentId: 'btn2', name: 'Icon', width: 16, height: 16});
  const first = addComponentProperty(doc, 'btn', {name: 'Icon', type: 'BOOLEAN', defaultValue: true});
  doc = bindProperty(first.doc, 'icon', 'visible', first.key).doc;
  doc = addComponentProperty(doc, 'btn2', {name: 'Text', type: 'TEXT', defaultValue: ''}).doc;
  const second = addComponentProperty(doc, 'btn2', {name: 'Icon', type: 'BOOLEAN', defaultValue: true});
  doc = bindProperty(second.doc, 'icon2', 'visible', second.key).doc;
  assert.notEqual(first.key, second.key);
  doc = place(doc, 'btn', 'i1');
  doc = setInstanceProperty(doc, 'i1', first.key, false).doc;
  doc = swapInstance(doc, 'i1', 'btn2').doc;
  assert.deepEqual(doc.nodes.i1.componentProperties, {'Text#1': '', [second.key]: false});
  assert.deepEqual(doc.nodes.i1.overrides, [`componentProperties.${second.key}`]);
  assert.equal(doc.nodes['i1;icon2'].visible, false);
});

test('a swapped nested instance mirrors its new component and keeps the swap through syncs', () => {
  let doc = place(nestedDoc(), 'chip', 'c1');
  doc = swapInstance(doc, 'c1;n1', 'ico2').doc;
  assert.deepEqual(doc.nodes['c1;n1'].overrides, ['componentId']);
  assert.deepEqual(doc.nodes['c1;n1'].children, ['c1;n1;star']);
  assert.equal(doc.nodes['c1;n1;star'].mainId, 'star');
  assert.deepEqual([doc.nodes['c1;n1'].x, doc.nodes['c1;n1'].y], [4, 4], 'the swap keeps the slot');
  doc = editMain(doc, 'chip-label', {fills: [solid(RED)]});
  assert.equal(doc.nodes['c1;n1'].componentId, 'ico2');
  doc = editMain(doc, 'star', {fills: [solid(GREEN)]});
  assert.deepEqual(doc.nodes['c1;n1;star'].fills, [solid(GREEN)]);
  // Swapping back to the main's component drops the override.
  doc = swapInstance(doc, 'c1;n1', 'ico').doc;
  assert.equal(doc.nodes['c1;n1'].overrides, undefined);
  assert.equal(doc.nodes['c1;n1;glyph'].mainId, 'n1;glyph');
  checkTree(doc);
});

test('BOOLEAN, TEXT and INSTANCE_SWAP properties drive their layers', () => {
  let doc = place(place(buttonDoc(), 'btn', 'i1'), 'btn', 'i2', 'p', 200);
  const icon = addComponentProperty(doc, 'btn', {name: 'Icon', type: 'BOOLEAN', defaultValue: true});
  assert.equal(icon.key, 'Icon#1');
  doc = bindProperty(icon.doc, 'icon', 'visible', icon.key).doc;
  assert.deepEqual(doc.nodes.icon.componentPropertyReferences, {visible: 'Icon#1'});
  assert.equal(doc.nodes.i1.componentProperties!['Icon#1'], true);
  doc = setInstanceProperty(doc, 'i1', 'Icon#1', false).doc;
  assert.equal(doc.nodes['i1;icon'].visible, false);
  assert.equal(doc.nodes['i2;icon'].visible, true);
  assert.equal(doc.nodes.icon.visible, true);
  assert.deepEqual(doc.nodes.i1.overrides, ['componentProperties.Icon#1']);
  // A new default reaches the main and instances that did not set the value.
  doc = editProperty(doc, 'btn', 'Icon#1', {defaultValue: false}).doc;
  assert.equal(doc.nodes.icon.visible, false);
  assert.equal(doc.nodes['i2;icon'].visible, false);
  doc = setInstanceProperty(doc, 'i2', 'Icon#1', true).doc;
  assert.equal(doc.nodes['i2;icon'].visible, true);

  const label = addComponentProperty(doc, 'btn', {name: 'Text', type: 'TEXT', defaultValue: 'Button'});
  assert.equal(label.key, 'Text#2');
  doc = bindProperty(label.doc, 'label', 'characters', label.key).doc;
  doc = setInstanceProperty(doc, 'i1', 'Text#2', 'Pay').doc;
  assert.equal(doc.nodes['i1;label'].text!.characters, 'Pay');
  assert.equal(doc.nodes['i2;label'].text!.characters, 'Button');
  assert.deepEqual(propertyForField(doc, 'i1;label', 'characters'), {instanceId: 'i1', key: 'Text#2'});
  // The main's style still flows into the property-driven text.
  const style = doc.nodes.label.text!;
  doc = editMain(doc, 'label', {text: {...style, style: {...style.style, fontSize: 18}}});
  assert.equal(doc.nodes['i1;label'].text!.characters, 'Pay');
  assert.equal(doc.nodes['i1;label'].text!.style.fontSize, 18);
  // Renaming keeps the key's suffix and follows on every reference and instance.
  const renamed = editProperty(doc, 'btn', 'Text#2', {name: 'Caption'});
  assert.equal(renamed.key, 'Caption#2');
  doc = renamed.doc;
  assert.equal(doc.nodes.label.componentPropertyReferences!.characters, 'Caption#2');
  assert.equal(doc.nodes.i1.componentProperties!['Caption#2'], 'Pay');
  assert.ok(doc.nodes.i1.overrides!.includes('componentProperties.Caption#2'));
  assert.equal(doc.nodes['i1;label'].text!.characters, 'Pay');
  // Deleting unbinds: layers keep what they show, instances drop the value.
  doc = deleteProperty(doc, 'btn', 'Caption#2').doc;
  assert.equal(doc.nodes.label.componentPropertyReferences, undefined);
  assert.equal(doc.nodes.i1.componentProperties!['Caption#2'], undefined);
  assert.ok(!doc.nodes.i1.overrides!.some(entry => entry.includes('Caption')));
  assert.throws(() => addComponentProperty(doc, 'btn', {name: 'Icon', type: 'BOOLEAN', defaultValue: true}), (error: DesignComponentError) => error.code === 'duplicate_property');
  assert.throws(() => setInstanceProperty(doc, 'i1', 'Icon#1', 'yes'), (error: DesignComponentError) => error.code === 'wrong_type');

  let nested = place(nestedDoc(), 'chip', 'c1');
  const swap = addComponentProperty(nested, 'chip', {name: 'Badge', type: 'INSTANCE_SWAP', defaultValue: 'ico'});
  nested = bindProperty(swap.doc, 'n1', 'mainComponent', swap.key).doc;
  nested = setInstanceProperty(nested, 'c1', swap.key, 'ico2').doc;
  assert.equal(nested.nodes['c1;n1'].componentId, 'ico2');
  assert.deepEqual(nested.nodes['c1;n1'].children, ['c1;n1;star']);
  assert.equal(nested.nodes['c1;n1'].overrides, undefined, 'a property-driven swap is not an override of the copy');
  assert.equal(nested.nodes.n1.componentId, 'ico', 'the main shows the default');
  nested = setInstanceProperty(nested, 'c1', swap.key, 'ico').doc;
  assert.equal(nested.nodes['c1;n1;glyph'].mainId, 'n1;glyph');
  assert.equal(nested.nodes.c1.overrides, undefined, 'setting the inherited value is no override');
});

test('a component never contains an instance of itself', () => {
  const doc = nestedDoc();
  assert.equal(wouldCreateCycle(doc, 'chip', 'chip'), true);
  assert.equal(wouldCreateCycle(doc, 'card', 'chip'), true, 'card holds chip');
  assert.equal(wouldCreateCycle(doc, 'card', 'ico'), true, 'card holds chip, which holds ico');
  assert.equal(wouldCreateCycle(doc, 'ico', 'card'), false);
  assert.equal(wouldCreateCycle(doc, 'card', 'p'), false);
  assert.throws(() => createInstance(doc, 'card', {parentId: 'ico', newId: 'x'}), (error: DesignComponentError) => error.code === 'cycle');
  assert.throws(() => swapInstance(doc, 'n1', 'card'), (error: DesignComponentError) => error.code === 'cycle');
  assert.throws(() => createInstance(doc, 'ico', {parentId: 'n2', newId: 'x'}), (error: DesignComponentError) => error.code === 'inside_instance');
  assert.equal(moveViolation(doc, ['n2'], 'ico'), 'cycle');
  assert.equal(moveViolation(doc, ['card'], 'chip'), 'nested_component');
  assert.equal(moveViolation(doc, ['n2;chip-label'], 'p'), 'inside_instance');
  assert.equal(moveViolation(doc, ['chip-label'], 'card'), null);

  // A cycle in imported data does not hang the sync.
  let broken = add(doc, 'INSTANCE', {id: 'loop', parentId: 'ico', componentId: 'card'});
  broken = syncInstances(broken, new Set(['loop', 'glyph']));
  assert.ok(broken.nodes.loop);
});

test('creating components: frames convert, groups become component frames, other layers are wrapped', () => {
  let doc = createDocument('p');
  doc = add(doc, 'FRAME', {id: 'f', parentId: 'p', width: 50, height: 50});
  doc = add(doc, 'GROUP', {id: 'g', parentId: 'p', x: 100, y: 10, width: 30, height: 20, rotation: 0});
  doc = add(doc, 'RECTANGLE', {id: 'g1', parentId: 'g', width: 30, height: 20});
  doc = add(doc, 'RECTANGLE', {id: 'r', parentId: 'p', name: 'Banner', x: 200, y: 20, width: 40, height: 10});
  doc = add(doc, 'ELLIPSE', {id: 'e', parentId: 'p', x: 300, y: 40, width: 10, height: 10});
  doc = add(doc, 'ELLIPSE', {id: 'e2', parentId: 'p', x: 330, y: 50, width: 10, height: 10});

  const frame = createComponent(doc, ['f']);
  assert.equal(frame.doc.nodes.f.type, 'COMPONENT');
  assert.deepEqual(frame.componentIds, ['f']);
  assert.deepEqual(frame.doc.nodes.f.componentPropertyDefinitions, {});

  const group = createComponent(doc, ['g']);
  const component = group.doc.nodes.g;
  assert.equal(component.type, 'COMPONENT');
  assert.deepEqual([component.x, component.y, component.width, component.height], [100, 10, 30, 20]);
  assert.deepEqual(component.children, ['g1']);
  assert.deepEqual(component.fills, []);

  const wrapped = createComponent(doc, ['r'], 'k');
  const wrapper = wrapped.doc.nodes.k;
  assert.equal(wrapper.name, 'Banner');
  assert.deepEqual([wrapper.x, wrapper.y, wrapper.width, wrapper.height], [200, 20, 40, 10]);
  assert.deepEqual([wrapped.doc.nodes.r.x, wrapped.doc.nodes.r.y, wrapped.doc.nodes.r.parentId], [0, 0, 'k']);
  assert.deepEqual(wrapped.doc.nodes.p.children, ['f', 'g', 'k', 'e', 'e2']);

  const combined = createComponent(doc, ['e', 'e2'], 'both', {combine: true});
  assert.deepEqual(combined.componentIds, ['both']);
  assert.deepEqual([combined.doc.nodes.both.x, combined.doc.nodes.both.y, combined.doc.nodes.both.width, combined.doc.nodes.both.height], [300, 40, 40, 20]);
  assert.deepEqual(combined.doc.nodes.both.children, ['e', 'e2']);
  assert.deepEqual([combined.doc.nodes.e2.x, combined.doc.nodes.e2.y], [30, 10]);
  assert.deepEqual(combined.doc.nodes.p.children, ['f', 'g', 'r', 'both']);

  const each = createComponent(doc, ['e', 'e2'], () => `w${Math.random()}`);
  assert.equal(each.componentIds.length, 2);
  for (const id of each.componentIds) assert.equal(each.doc.nodes[id].type, 'COMPONENT');

  const inside = createComponent(doc, ['f']).doc;
  const withChild = add(inside, 'RECTANGLE', {id: 'inner', parentId: 'f'});
  assert.throws(() => createComponent(withChild, ['inner']), (error: DesignComponentError) => error.code === 'inside_component');
  assert.throws(() => createComponent(place(buttonDoc(), 'btn', 'i1'), ['i1;bg']), (error: DesignComponentError) => error.code === 'inside_instance');
});

test('pushing an instance\'s overrides makes them the main\'s values', () => {
  let doc = place(place(buttonDoc(), 'btn', 'i1'), 'btn', 'i2', 'p', 200);
  doc = editCopy(doc, 'i1;bg', {fills: [solid(RED)]});
  doc = editCopy(doc, 'i1', {cornerRadius: 8});
  doc = editCopy(doc, 'i2;bg', {strokes: [solid(GREEN)]});
  doc = pushOverridesToMain(doc, 'i1').doc;
  assert.deepEqual(doc.nodes.bg.fills, [solid(RED)]);
  assert.equal(doc.nodes.btn.cornerRadius, 8);
  assert.equal(doc.nodes['i1;bg'].overrides, undefined);
  assert.equal(doc.nodes.i1.overrides, undefined);
  assert.deepEqual(doc.nodes['i2;bg'].fills, [solid(RED)], 'other instances follow');
  assert.deepEqual(doc.nodes['i2;bg'].strokes, [solid(GREEN)], 'and keep their own overrides');
  assert.equal(doc.nodes.i2.cornerRadius, 8);

  // Overrides of a nested instance's copies become main-level overrides of the nested instance.
  let nested = place(place(nestedDoc(), 'chip', 'c1'), 'chip', 'c2', 'p', 200);
  nested = editCopy(nested, 'c1;n1;glyph', {fills: [solid(RED)]});
  nested = pushOverridesToMain(nested, 'c1').doc;
  assert.deepEqual(nested.nodes['n1;glyph'].fills, [solid(RED)]);
  assert.deepEqual(nested.nodes['n1;glyph'].overrides, ['fills']);
  assert.deepEqual(nested.nodes.glyph.fills, [solid(BLUE)], 'the nested main is untouched');
  assert.deepEqual(nested.nodes['c2;n1;glyph'].fills, [solid(RED)]);
});

test('navigation and lookups', () => {
  const doc = place(nestedDoc(), 'card', 'top');
  assert.equal(goToMainComponent(doc, 'top'), 'card');
  assert.equal(goToMainComponent(doc, 'top;n2;n1'), 'ico');
  assert.equal(goToMainComponent(doc, 'top;n2;n1;glyph'), 'glyph');
  assert.equal(goToMainComponent(doc, 'glyph'), null);
  assert.deepEqual(instancesOfComponent(doc, 'ico').sort(), ['n1', 'n2;n1', 'top;n2;n1']);
});

test('instances of a deleted main keep what they show', () => {
  let doc = place(buttonDoc(), 'btn', 'i1');
  const nodes = {...doc.nodes};
  for (const id of ['btn', 'bg', 'label', 'icon']) delete nodes[id];
  nodes.p = {...nodes.p, children: ['i1']};
  doc = syncInstances({...doc, nodes}, new Set(['btn', 'p', 'i1']));
  assert.deepEqual(doc.nodes.i1.children, ['i1;bg', 'i1;label', 'i1;icon']);
});

test('syncing 500 instances of a 50-node component takes under 200 ms', () => {
  let doc = createDocument('p');
  doc = add(doc, 'COMPONENT', {id: 'big', parentId: 'p', width: 500, height: 500});
  for (let f = 0; f < 7; f++) {
    doc = add(doc, 'FRAME', {id: `f${f}`, parentId: 'big', x: f * 60, width: 60, height: 400, constraints: {horizontal: 'SCALE', vertical: 'STRETCH'}});
    for (let c = 0; c < 6; c++) doc = add(doc, c % 2 ? 'TEXT' : 'RECTANGLE', {id: `f${f}c${c}`, parentId: `f${f}`, y: c * 50, width: 50, height: 40, ...(c % 2 ? {text: text(`Row ${c}`)} : {})});
  }
  assert.equal(Object.keys(doc.nodes).length - 1, 50);
  doc = place(doc, 'big', 'i0');
  // Clone the first instance 499 times (createInstance per instance would only slow the setup down).
  const nodes = {...doc.nodes};
  const copies = Object.values(doc.nodes).filter(node => node.id === 'i0' || node.id.startsWith('i0;'));
  const page = {...nodes.p, children: [...nodes.p.children!]};
  for (let i = 1; i < 500; i++) {
    const rekey = (id: NodeId) => `i${i}` + id.slice(2);
    for (const node of copies) nodes[rekey(node.id)] = {...node, id: rekey(node.id), parentId: node.id === 'i0' ? 'p' : rekey(node.parentId!), children: node.children?.map(rekey), x: node.id === 'i0' ? i * 10 : node.x};
    page.children.push(`i${i}`);
  }
  nodes.p = page;
  doc = {...doc, nodes};
  // Resized instances make the constraint path run too.
  doc = {...doc, nodes: {...doc.nodes, i7: {...doc.nodes.i7, width: 700, overrides: ['width']}}};
  doc = syncInstances(doc, new Set(['i7']));
  doc = editCopy(doc, 'i3;f2c0', {fills: [solid(RED)]});

  // The first sync after a file loads compares every copy with its main once; an editing session then
  // syncs from there. Best of three edits, so a busy machine does not decide the result.
  doc = syncInstances(update(doc, 'f2c0', {strokes: [solid(BLUE)]}), new Set(['f2c0']));
  let elapsed = Infinity, edited = doc, result = syncInstancesDetailed(doc, new Set());
  for (const color of [GREEN, RED, GREEN]) {
    edited = update(doc, 'f2c0', {strokes: [solid(color)]});
    const started = performance.now();
    result = syncInstancesDetailed(edited, new Set(['f2c0']));
    elapsed = Math.min(elapsed, performance.now() - started);
  }
  const {doc: synced, changed} = result;
  assert.ok(elapsed < budget(200), `sync took ${elapsed.toFixed(1)} ms`);
  assert.equal(changed.size, 500, 'only the copies of the edited node change');
  assert.deepEqual(synced.nodes['i499;f2c0'].strokes, [solid(GREEN)]);
  assert.deepEqual(synced.nodes['i3;f2c0'].fills, [solid(RED)]);
  assert.equal(synced.nodes['i0;f3c1'], edited.nodes['i0;f3c1'], 'untouched copies keep their identity');
  // A document without instances is returned as is.
  const plain = buttonDoc();
  assert.equal(syncInstances(plain, new Set(['bg'])), plain);
});
