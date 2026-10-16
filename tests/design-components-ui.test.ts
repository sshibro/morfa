import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {validateDocument} from '../shared/design/schema';
import {createInstance, exposedInstancesOf, isExposableInstance, propertyDefinitionsOf, withOverrideTracking} from '../shared/design/components';
import {bindVariable, createVariable, createVariableCollection, setVariableValue} from '../shared/design/variables';
import type {DesignDocument, NodeId, SceneNode, Vec} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {copySelection, getCommand, pasteData, registerCoreCommands, runCommand, type CommandContext} from '../src/design/engine/commands';
import {
  altDragClones, applyDocument, connectComponentCommands, dropAllowed, insertInstance, restoreMainComponent, structureRefusal,
} from '../src/design/engine/commands/components';
import {createDesignStore, currentViewport} from '../src/design/engine/store';
import {editNodes} from '../src/design/engine/user-edit';
import {MoveTool} from '../src/design/engine/tools/move';
import {NO_SNAP, type ToolContext, type ToolPointerEvent} from '../src/design/engine/tools/types';
import {pageToScreen, screenToPage} from '../src/design/engine/viewport';
import {
  addProperty, bindLayer, createPropertyFor, removeProperty, renameProperty, setDescription, setInstancesProperty, setPropertyDefault, setVariantValue, swapInstances,
} from '../src/design/panels/design/components/actions';
import {boundLayers, componentModel, exposedGroups, filterSwapEntries, instanceModel, MIXED, nestedInstancesOf, swapEntries} from '../src/design/panels/design/components/model';
import {modeRows, setFramesMode} from '../src/design/panels/design/components/variable-modes';
import {bindingState, bindVariableTo} from '../src/design/panels/variables/binding';

// The user's side of components: commands write the pure operations' results through one transaction
// (one undo step each), the panels' models show what the sections render, and structural edits inside
// instances explain themselves instead of breaking the instance.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

type Add = (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void;
function build(recipe: (add: Add) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, name: id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

/** «btn» (Button: bg, label, icon), its instance «i1» below it, a frame «f» with «r», and «loose». */
function fixture(): DesignDocument {
  let doc = build(add => {
    add('COMPONENT', 'btn', 'page', {name: 'Button', width: 120, height: 40});
    add('RECTANGLE', 'bg', 'btn', {name: 'Background', width: 120, height: 40, fills: [solid({r: 0, g: 0, b: 1})]});
    add('TEXT', 'label', 'btn', {name: 'Label', x: 10, y: 10, width: 60, height: 20, text: defaultTextProps('Button')});
    add('ELLIPSE', 'icon', 'btn', {name: 'Icon', x: 96, y: 12, width: 16, height: 16});
    add('FRAME', 'f', 'page', {x: 300, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'r', 'f', {x: 10, y: 10, width: 20, height: 20});
    add('RECTANGLE', 'loose', 'page', {x: 500, y: 0, width: 40, height: 40});
  });
  doc = createInstance(doc, 'btn', {parentId: 'page', x: 0, y: 200, newId: 'i1'}).doc;
  return doc;
}

function setup(doc: DesignDocument) {
  registerCoreCommands();
  const store = createDesignStore({doc, measurer});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const toasts: string[] = [];
  const revealed: NodeId[][] = [];
  connectComponentCommands(store, {toast: message => void toasts.push(message), revealNodes: ids => void revealed.push([...ids])});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  const run = (id: string) => assert.ok(runCommand(id, ctx), `${id} ran`);
  const select = (...ids: NodeId[]) => store.setSelection(ids);
  return {store, ctx, run, select, toasts, revealed, doc: () => store.getState().doc};
}

/** Every node's parent lists it once and every child points back: the invariants the schema checks. */
function checkTree(doc: DesignDocument) {
  for (const node of Object.values(doc.nodes)) {
    for (const child of node.children ?? []) assert.equal(doc.nodes[child]?.parentId, node.id, `${child} under ${node.id}`);
    if (node.parentId) assert.equal(doc.nodes[node.parentId].children!.filter(id => id === node.id).length, 1, `${node.id} listed once`);
    if (node.mainId !== undefined) assert.ok(node.id.includes(';'), `${node.id} is a copy id`);
  }
}

// ── Writing an operation's result ───────────────────────────────────────────────────────────────

test('applyDocument writes creates, moves, removals, fields and order through the transaction', () => {
  const doc = fixture();
  // A hand-made "after": r leaves f for the page, loose is removed, a new group holds a new rect, f renamed.
  const after: DesignDocument = {...doc, nodes: {...doc.nodes}};
  after.nodes.r = {...doc.nodes.r, parentId: 'page'};
  after.nodes.f = {...doc.nodes.f, name: 'Frame', children: []};
  after.nodes.g = createNode('GROUP', {id: 'g', parentId: 'page', children: ['n'], width: 5, height: 5});
  after.nodes.n = createNode('RECTANGLE', {id: 'n', parentId: 'g', width: 5, height: 5});
  delete after.nodes.loose;
  after.nodes.page = {...doc.nodes.page, children: ['btn', 'g', 'f', 'i1', 'r']};
  const tx = beginTransaction(doc);
  applyDocument(tx, after);
  const result = tx.commit({measurer});
  assert.deepEqual(result.doc.nodes.page.children, ['btn', 'g', 'f', 'i1', 'r']);
  assert.equal(result.doc.nodes.r.parentId, 'page');
  assert.equal(result.doc.nodes.f.name, 'Frame');
  assert.equal(result.doc.nodes.loose, undefined);
  assert.deepEqual(result.doc.nodes.g.children, ['n']);
  checkTree(result.doc);
});

// ── Creating components ─────────────────────────────────────────────────────────────────────────

test('"Create component": a frame converts in place, a shape is wrapped, ⌥⌘K is one undo step', () => {
  const {store, run, select, doc} = setup(fixture());
  assert.deepEqual(getCommand('object.create-component')?.shortcut, {code: 'KeyK', mod: true, alt: true});
  select('f');
  run('object.create-component');
  assert.equal(doc().nodes.f.type, 'COMPONENT', 'the frame itself became the component');
  assert.deepEqual(doc().nodes.f.children, ['r']);
  assert.deepEqual(store.getState().selection, ['f']);
  store.undo();
  assert.equal(doc().nodes.f.type, 'FRAME');

  select('loose');
  run('object.create-component');
  const [wrapper] = store.getState().selection;
  assert.notEqual(wrapper, 'loose');
  assert.equal(doc().nodes[wrapper].type, 'COMPONENT');
  assert.equal(doc().nodes.loose.parentId, wrapper);
  assert.equal(doc().nodes[wrapper].x, 500, 'the component takes the shape\'s place');
  checkTree(doc());
  store.undo();
  assert.equal(doc().nodes.loose.parentId, 'page');
  assert.equal(doc().nodes[wrapper], undefined);
});

test('several layers: ⌥⌘K wraps them in one component, "Create multiple components" makes one each', () => {
  const {store, run, select, doc} = setup(fixture());
  select('f', 'loose');
  run('object.create-component');
  const [one] = store.getState().selection;
  assert.equal(store.getState().selection.length, 1);
  assert.equal(doc().nodes.f.parentId, one);
  assert.equal(doc().nodes.loose.parentId, one);
  store.undo();
  select('f', 'loose');
  run('object.create-multiple-components');
  assert.equal(store.getState().selection.length, 2);
  assert.equal(doc().nodes.f.type, 'COMPONENT');
  assert.equal(doc().nodes[doc().nodes.loose.parentId!].type, 'COMPONENT');
  checkTree(doc());
});

test('components never nest: a layer inside a main or an instance is refused with a toast', () => {
  const {store, select, doc, toasts, ctx} = setup(fixture());
  select('label');
  assert.equal(getCommand('object.create-component')!.enabled!(ctx), false);
  const before = doc();
  select('i1;label');
  getCommand('object.create-component')!.run(ctx);
  assert.equal(doc(), before);
  assert.equal(store.getState().history.undo, null);
  void toasts;
});

// ── Variants ────────────────────────────────────────────────────────────────────────────────────

function twoButtons() {
  return build(add => {
    add('COMPONENT', 'a', 'page', {name: 'Button/Primary', width: 100, height: 40});
    add('TEXT', 'a-label', 'a', {name: 'Label', width: 60, height: 20, text: defaultTextProps('Yes')});
    add('COMPONENT', 'b', 'page', {name: 'Button/Secondary', x: 200, width: 100, height: 40});
    add('TEXT', 'b-label', 'b', {name: 'Label', width: 60, height: 20, text: defaultTextProps('No')});
  });
}

test('"Combine as variants" makes a set named after the folder; variants switch from the panel', () => {
  let start = twoButtons();
  start = createInstance(start, 'a', {parentId: 'page', x: 0, y: 200, newId: 'inst'}).doc;
  const {store, run, select, doc} = setup(start);
  select('a', 'b');
  run('object.combine-variants');
  const [setId] = store.getState().selection;
  const set = doc().nodes[setId];
  assert.equal(set.type, 'COMPONENT_SET');
  assert.equal(set.name, 'Button');
  assert.deepEqual(set.children, ['a', 'b']);
  const model = componentModel(doc(), [setId])!;
  assert.equal(model.kind, 'set');
  assert.deepEqual(model.variantProperties.map(row => [row.name, row.options]), [['Property 1', ['Primary', 'Secondary']]]);
  // The instance shows the variant property and switches through it.
  const inst = instanceModel(doc(), ['inst'])!;
  assert.equal(inst.mainName, 'Button');
  assert.deepEqual(inst.rows.map(row => [row.name, row.value]), [['Property 1', 'Primary']]);
  setInstancesProperty(store, ['inst'], 'Property 1', 'Secondary');
  assert.equal(doc().nodes.inst.componentId, 'b');
  assert.equal(doc().nodes['inst;b-label'].text!.characters, 'No');
  store.undo();
  assert.equal(doc().nodes.inst.componentId, 'a');
  // "Add variant" duplicates the selected variant into the set.
  select('b');
  run('object.add-variant');
  const added = store.getState().selection[0];
  assert.equal(doc().nodes[added].parentId, setId);
  assert.match(doc().nodes[added].name, /^Property 1=Variant \d$/);
  checkTree(doc());
});

test('a variant\'s own value renames it; duplicates show as an issue', () => {
  const {store, run, select, doc} = setup(twoButtons());
  select('a', 'b');
  run('object.combine-variants');
  const setId = store.getState().selection[0];
  setVariantValue(store, 'b', 'Property 1', 'Primary');
  assert.equal(doc().nodes.b.name, 'Property 1=Primary');
  const model = componentModel(doc(), [setId])!;
  assert.ok(model.issues.some(issue => issue.type === 'duplicate'), 'two variants share a combination');
  const variant = componentModel(doc(), ['b'])!;
  assert.equal(variant.kind, 'variant');
  assert.deepEqual(variant.values, {'Property 1': 'Primary'});
});

test('a variant property on a lone component turns it into a set', () => {
  const {store, doc} = setup(fixture());
  const added = addProperty(store, 'btn', 'VARIANT')!;
  const set = doc().nodes[added.ownerId];
  assert.equal(set.type, 'COMPONENT_SET');
  assert.deepEqual(set.children, ['btn']);
  assert.ok(added.key in propertyDefinitionsOf(doc(), added.ownerId));
  assert.equal(doc().nodes.i1.componentId, 'btn', 'the instance keeps its main');
  renameProperty(store, added.ownerId, added.key, 'Size', true);
  assert.ok('Size' in propertyDefinitionsOf(doc(), added.ownerId));
});

// ── Instances ───────────────────────────────────────────────────────────────────────────────────

test('detach (⌥⌘B), reset and push to main from the commands', () => {
  const {store, run, select, doc, ctx} = setup(fixture());
  // An override on the instance's label.
  store.transact('Text', tx => tx.update('i1;label', withOverrideTracking(tx.doc, 'i1;label', {text: {...tx.get('i1;label')!.text!, characters: 'Buy'}})));
  select('i1');
  assert.ok(getCommand('object.reset-instance')!.enabled!(ctx));
  run('object.push-to-main');
  assert.equal(doc().nodes.label.text!.characters, 'Buy', 'the main took the override');
  assert.equal(doc().nodes['i1;label'].overrides, undefined);
  store.undo();
  run('object.reset-instance');
  assert.equal(doc().nodes['i1;label'].text!.characters, 'Button');
  assert.equal(getCommand('object.reset-instance')!.enabled!(ctx), false);
  run('object.detach-instance');
  const frame = doc().nodes.i1;
  assert.equal(frame.type, 'FRAME');
  assert.equal(frame.componentId, undefined);
  assert.ok(frame.children!.every(id => !id.includes(';') && doc().nodes[id].mainId === undefined));
  checkTree(doc());
  store.undo();
  assert.equal(doc().nodes.i1.type, 'INSTANCE');
});

test('"Go to main component" switches page, selects and reveals', () => {
  let start = fixture();
  const tx = beginTransaction(start);
  tx.addPage(createNode('PAGE', {id: 'p2', name: 'Screens', parentId: null}));
  start = tx.commit({measurer}).doc;
  start = createInstance(start, 'btn', {parentId: 'p2', x: 0, y: 0, newId: 'far'}).doc;
  const {store, run, select, revealed} = setup(start);
  store.setPage('p2');
  select('far;label');
  run('object.go-to-main');
  assert.equal(store.getState().pageId, 'page');
  assert.deepEqual(store.getState().selection, ['label'], 'a copy leads to the layer it mirrors');
  assert.deepEqual(revealed.at(-1), ['label']);
});

test('swap from the panel keeps the overrides of same-named layers', () => {
  let start = twoButtons();
  start = createInstance(start, 'a', {parentId: 'page', x: 0, y: 200, newId: 'inst'}).doc;
  const {store, doc} = setup(start);
  store.transact('Text', tx => tx.update('inst;a-label', withOverrideTracking(tx.doc, 'inst;a-label', {text: {...tx.get('inst;a-label')!.text!, characters: 'Custom'}})));
  swapInstances(store, ['inst'], 'b');
  assert.equal(doc().nodes.inst.componentId, 'b');
  assert.equal(doc().nodes['inst;b-label'].text!.characters, 'Custom', 'the override moved to the same-named layer');
  assert.equal(doc().nodes['inst;a-label'], undefined);
  checkTree(doc());
});

test('the swap menu lists sets and loose components by page and folder, preferred first', () => {
  const {store, run, select, doc} = setup(build(add => {
    add('COMPONENT', 'x', 'page', {name: 'Icons/Arrow'});
    add('COMPONENT', 'y', 'page', {name: 'Icons/Cross'});
    add('COMPONENT', 'v1', 'page', {name: 'Chips/A'});
    add('COMPONENT', 'v2', 'page', {name: 'Chips/B'});
    add('FRAME', 'holder', 'page');
    add('COMPONENT', 'deep', 'holder', {name: 'Card'});
  }));
  select('v1', 'v2');
  run('object.combine-variants');
  const setId = store.getState().selection[0];
  const entries = swapEntries(doc());
  assert.deepEqual(entries.map(entry => entry.id).sort(), ['deep', 'x', 'y', setId].sort(), 'variants show as their set');
  assert.equal(entries.find(entry => entry.id === 'x')!.group, 'Page 1 / Icons');
  assert.equal(entries.find(entry => entry.id === 'x')!.label, 'Arrow');
  const filtered = filterSwapEntries(entries, 'arr', ['y']);
  assert.deepEqual(filtered.preferred.map(entry => entry.id), []);
  assert.deepEqual(filtered.groups.flatMap(group => group.entries.map(entry => entry.id)), ['x']);
  const all = filterSwapEntries(entries, '', ['y']);
  assert.deepEqual(all.preferred.map(entry => entry.id), ['y']);
  assert.ok(!all.groups.some(group => group.entries.some(entry => entry.id === 'y')), 'a preferred entry is not listed twice');
});

test('several instances show their common properties; differing values are mixed', () => {
  let start = twoButtons();
  start = createInstance(start, 'a', {parentId: 'page', x: 0, y: 200, newId: 'one'}).doc;
  start = createInstance(start, 'a', {parentId: 'page', x: 0, y: 300, newId: 'two'}).doc;
  const {store, run, select, doc} = setup(start);
  select('a', 'b');
  run('object.combine-variants');
  setInstancesProperty(store, ['two'], 'Property 1', 'Secondary');
  const model = instanceModel(doc(), ['one', 'two'])!;
  assert.equal(model.mainName, 'Button');
  assert.equal(model.componentId, MIXED);
  assert.equal(model.rows[0].value, MIXED);
  setInstancesProperty(store, ['one', 'two'], 'Property 1', 'Primary');
  assert.equal(doc().nodes.two.componentId, 'a');
  assert.equal(instanceModel(doc(), ['one', 'two'])!.rows[0].value, 'Primary');
});

// ── Component properties from the panel ─────────────────────────────────────────────────────────

test('boolean property: add, bind the icon\'s visibility, set it on an instance, delete', () => {
  const {store, doc} = setup(fixture());
  const added = addProperty(store, 'btn', 'BOOLEAN')!;
  assert.equal(added.ownerId, 'btn');
  const model = componentModel(doc(), ['btn'])!;
  assert.deepEqual(model.properties.map(row => [row.name, row.type, row.defaultValue]), [['Property 1', 'BOOLEAN', true]]);
  bindLayer(store, 'icon', 'visible', added.key);
  assert.deepEqual(boundLayers(doc(), 'btn', added.key), [{id: 'icon', name: 'Icon', field: 'visible'}]);
  const inst = instanceModel(doc(), ['i1'])!;
  assert.deepEqual(inst.rows.map(row => [row.key, row.value]), [[added.key, true]]);
  setInstancesProperty(store, ['i1'], added.key, false);
  assert.equal(doc().nodes['i1;icon'].visible, false);
  assert.equal(instanceModel(doc(), ['i1'])!.rows[0].value, false);
  assert.equal(doc().nodes.icon.visible, true, 'the main keeps its default');
  setPropertyDefault(store, 'btn', added.key, false);
  assert.equal(doc().nodes.icon.visible, false, 'the main shows the new default');
  const renamed = renameProperty(store, 'btn', added.key, 'Icon', false)!;
  assert.equal(renamed.split('#')[0], 'Icon');
  assert.equal(doc().nodes.icon.componentPropertyReferences?.visible, renamed);
  removeProperty(store, 'btn', renamed);
  assert.deepEqual(componentModel(doc(), ['btn'])!.properties, []);
  assert.equal(doc().nodes.icon.componentPropertyReferences, undefined);
});

test('text property created from a layer drives the instances\' text', () => {
  const {store, doc} = setup(fixture());
  const key = createPropertyFor(store, 'btn', 'label', 'characters')!;
  assert.ok(key.startsWith('Label#'));
  assert.equal(propertyDefinitionsOf(doc(), 'btn')[key].defaultValue, 'Button');
  assert.equal(doc().nodes.label.componentPropertyReferences?.characters, key);
  setInstancesProperty(store, ['i1'], key, 'Place order');
  assert.equal(doc().nodes['i1;label'].text!.characters, 'Place order');
  assert.equal(store.getState().history.undo, 'Instance property');
  setDescription(store, 'btn', 'Main button');
  assert.equal(componentModel(doc(), ['btn'])!.description, 'Main button');
});

test('instance swap property: nested instance bound, swapped from the instance', () => {
  let start = build(add => {
    add('COMPONENT', 'arrow', 'page', {name: 'Arrow', width: 16, height: 16});
    add('COMPONENT', 'cross', 'page', {name: 'Cross', x: 40, width: 16, height: 16});
    add('COMPONENT', 'chip', 'page', {name: 'Chip', x: 100, width: 80, height: 24});
  });
  start = createInstance(start, 'arrow', {parentId: 'chip', x: 4, y: 4, newId: 'nested'}).doc;
  start = createInstance(start, 'chip', {parentId: 'page', x: 0, y: 100, newId: 'use'}).doc;
  const {store, doc} = setup(start);
  const added = addProperty(store, 'chip', 'INSTANCE_SWAP')!;
  assert.equal(propertyDefinitionsOf(doc(), 'chip')[added.key].defaultValue, 'arrow', 'starts with the nested instance\'s component');
  bindLayer(store, 'nested', 'mainComponent', added.key);
  setInstancesProperty(store, ['use'], added.key, 'cross');
  assert.equal(doc().nodes['use;nested'].componentId, 'cross');
  assert.equal(instanceModel(doc(), ['use'])!.rows[0].value, 'cross');
});

// ── Guards ──────────────────────────────────────────────────────────────────────────────────────

test('delete, group and reorder inside an instance say why instead of acting', () => {
  const {store, select, doc, toasts, ctx} = setup(fixture());
  const before = doc();
  select('i1;label');
  assert.ok(getCommand('delete')!.enabled!(ctx), 'Delete answers on an instance layer');
  runCommand('delete', ctx);
  assert.equal(doc(), before);
  assert.equal(toasts.at(-1), 'A layer of an instance cannot be deleted — hide it instead');
  runCommand('group', ctx);
  assert.equal(toasts.at(-1), 'Layers inside an instance cannot be changed this way — detach the instance');
  runCommand('bring-forward', ctx);
  assert.equal(doc(), before);
  // A mixed selection acts on the layers it may touch.
  select('i1;label', 'loose');
  runCommand('delete', ctx);
  assert.equal(doc().nodes.loose, undefined);
  assert.ok(doc().nodes['i1;label']);
  void store;
});

test('variants cannot be grouped inside their set; nothing enters or leaves an instance by dragging', () => {
  const {store, run, select, doc} = setup(twoButtons());
  select('a', 'b');
  run('object.combine-variants');
  const setId = store.getState().selection[0];
  assert.match(structureRefusal(doc(), ['a', 'b'], 'group') ?? '', /Only components/);
  const current = createInstance(doc(), 'a', {parentId: 'page', x: 0, y: 300, newId: 'inst'}).doc;
  assert.equal(dropAllowed(current, 'inst;a-label', 'page'), false, 'a copy stays in its instance');
  assert.equal(dropAllowed(current, 'inst', setId), false, 'a set holds only variants');
  assert.equal(dropAllowed(current, 'a', 'page'), true, 'a variant may leave its set');
  assert.equal(dropAllowed(current, 'inst', 'a'), false, 'a component cannot hold its own instance');
});

// ── The move tool: Alt-drag of a main ───────────────────────────────────────────────────────────

test('Alt-dragging a main component leaves an instance of it', () => {
  const {store} = setup(fixture());
  const tool = new MoveTool();
  const ctx: ToolContext = {
    store, measurer,
    view: {
      viewport: () => currentViewport(store.getState()), size: () => ({width: 1000, height: 800}),
      screenToPage: p => screenToPage(currentViewport(store.getState()), p), pageToScreen: p => pageToScreen(currentViewport(store.getState()), p),
      setViewport: v => store.setViewport(v), pixel: () => 1 / currentViewport(store.getState()).zoom,
    },
    snap: NO_SNAP, index: () => null, setCursor: () => {}, requestOverlay: () => {}, setOverlayItems: () => {}, enterEdit: () => {},
    setTool: id => store.setTool(id), modifiers: () => ({shift: false, alt: true, mod: false}),
  };
  const ev = (at: Vec, mods: Partial<ToolPointerEvent> = {}): ToolPointerEvent => ({
    screen: at, page: at, button: 0, buttons: 1, shiftKey: false, altKey: true, metaKey: false, ctrlKey: false, mod: false,
    pointerId: 1, pointerType: 'mouse', pressure: 0.5, detail: 1, timeStamp: 0, ...mods,
  });
  // A main with room to press on its own fill (pressing a child would pick the child).
  store.transact('Component', tx => {
    tx.create(createNode('COMPONENT', {id: 'chip', name: 'Chip', x: 700, y: 0, width: 40, height: 40, fills: [solid({r: 1, g: 1, b: 1})]}), 'page');
    tx.create(createNode('ELLIPSE', {id: 'dot', name: 'Dot', x: 30, y: 30, width: 8, height: 8}), 'chip');
  });
  store.setSelection(['chip']);
  tool.onPointerDown(ev({x: 705, y: 5}, {altKey: false}), ctx);
  for (let i = 1; i <= 4; i++) tool.onPointerMove(ev({x: 705, y: 5 + i * 25}), ctx);
  tool.onPointerUp(ev({x: 705, y: 105}, {buttons: 0}), ctx);
  const doc = store.getState().doc;
  const [copy] = store.getState().selection;
  assert.notEqual(copy, 'chip');
  assert.equal(doc.nodes[copy].type, 'INSTANCE');
  assert.equal(doc.nodes[copy].componentId, 'chip');
  assert.equal(doc.nodes[copy].y, 100);
  assert.deepEqual(doc.nodes[copy].children, [`${copy};dot`], 'the instance has its copies');
  assert.equal(doc.nodes.chip.y, 0, 'the main stays');
  checkTree(doc);
  // Other layers still duplicate as copies.
  const clones = altDragClones(doc, ['loose']);
  assert.equal(clones.nodes[0].type, 'RECTANGLE');
});

// ── Restore, insert ─────────────────────────────────────────────────────────────────────────────

test('"Restore main component" rebuilds a deleted main under its old ids', () => {
  const {store, run, select, doc} = setup(fixture());
  store.transact('Delete', tx => tx.remove('btn'));
  assert.equal(doc().nodes.btn, undefined);
  select('i1');
  const model = instanceModel(doc(), ['i1'])!;
  assert.ok(model.orphan);
  run('object.restore-component');
  assert.equal(doc().nodes.btn.type, 'COMPONENT');
  assert.deepEqual(doc().nodes.btn.children, ['bg', 'label', 'icon']);
  assert.equal(doc().nodes.btn.x, 160, 'to the right of the instance');
  assert.deepEqual(store.getState().selection, ['btn']);
  // The instance follows its restored main again.
  store.transact('Color', tx => tx.update('bg', {fills: [solid({r: 1, g: 0, b: 0})]}));
  assert.deepEqual((doc().nodes['i1;bg'].fills[0] as {color: unknown}).color, {r: 1, g: 0, b: 0});
  assert.throws(() => restoreMainComponent(doc(), 'i1'));
  checkTree(doc());
});

test('insertInstance places an instance beside its main', () => {
  const {store, doc} = setup(fixture());
  const id = insertInstance(store, 'btn')!;
  assert.equal(doc().nodes[id].componentId, 'btn');
  assert.equal(doc().nodes[id].x, 160);
  assert.deepEqual(store.getState().selection, [id]);
});

// ── Variables ───────────────────────────────────────────────────────────────────────────────────

function withVariables(doc: DesignDocument): DesignDocument {
  let next = createVariableCollection(doc, {id: 'c', name: 'Theme', modes: [{modeId: 'light', name: 'Light'}, {modeId: 'dark', name: 'Dark'}]}).doc;
  next = createVariable(next, {id: 'gap', name: 'Spacing/M', collectionId: 'c', type: 'FLOAT', value: 16}).doc;
  next = setVariableValue(next, 'gap', 'dark', 24).doc;
  next = createVariable(next, {id: 'w', name: 'Width', collectionId: 'c', type: 'FLOAT', value: 64}).doc;
  return next;
}

test('a number field binds to a variable, inside an instance as an override, and unbinds keeping its value', () => {
  const {store, doc} = setup(withVariables(fixture()));
  assert.deepEqual(bindingState(doc(), ['loose'], {field: 'width'}), {type: 'FLOAT', variableId: null, name: null});
  bindVariableTo(store, ['loose'], {field: 'width'}, 'w');
  assert.equal(doc().nodes.loose.width, 64);
  assert.deepEqual(bindingState(doc(), ['loose'], {field: 'width'}), {type: 'FLOAT', variableId: 'w', name: 'Width'});
  assert.equal(store.getState().history.undo, 'Bind variable');
  assert.equal(bindingState(doc(), ['loose', 'r'], {field: 'width'})!.variableId, MIXED);
  bindVariableTo(store, ['i1;bg'], {field: 'width'}, 'w');
  assert.ok(doc().nodes['i1;bg'].overrides?.some(path => path.startsWith('boundVariables')), 'an override on the copy');
  bindVariableTo(store, ['loose'], {field: 'width'}, null);
  assert.equal(doc().nodes.loose.width, 64);
  assert.equal(doc().nodes.loose.boundVariables, undefined);
  assert.equal(bindingState(doc(), ['loose'], {field: 'visibleish'}), null, 'a field variables cannot drive');
});

test('a frame picks a mode; bound values inside follow', () => {
  let start = withVariables(fixture());
  start = bindVariable(start, 'r', 'width', 'gap').doc;
  const {store, doc} = setup(start);
  assert.equal(doc().nodes.r.width, 16);
  const rows = modeRows(doc(), ['f']);
  assert.deepEqual(rows.map(row => [row.name, row.value, row.inherited]), [['Theme', '__auto__', 'Light']]);
  setFramesMode(store, ['f'], 'c', 'dark');
  assert.equal(doc().nodes.r.width, 24);
  assert.equal(modeRows(doc(), ['f'])[0].value, 'dark');
  setFramesMode(store, ['f'], 'c', null);
  assert.equal(doc().nodes.r.width, 16);
  assert.deepEqual(modeRows(doc(), ['loose']), [], 'only frames pick modes');
});

// ── QA sweep (2026-10-07) ───────────────────────────────────────────────────────────────────────

test('⇧⌘H hides a layer inside an instance as an override that the main\'s changes keep', () => {
  const {store, run, select, doc} = setup(fixture());
  select('i1;icon');
  run('toggle-visible');
  assert.equal(doc().nodes['i1;icon'].visible, false);
  assert.ok(doc().nodes['i1;icon'].overrides?.includes('visible'), 'recorded as an override');
  store.transact('Size', tx => tx.update('icon', {width: 20}));
  assert.equal(doc().nodes['i1;icon'].visible, false, 'still hidden after the main changes');
  assert.equal(doc().nodes['i1;icon'].width, 20, 'the main\'s change arrives');
  assert.equal(doc().nodes.icon.visible, true, 'the main itself is untouched');
  run('toggle-visible');
  assert.equal(doc().nodes['i1;icon'].visible, true);
  select('i1;bg');
  run('toggle-lock');
  assert.ok(doc().nodes['i1;bg'].locked && doc().nodes['i1;bg'].overrides?.includes('locked'));
});

test('a variant property added to a component with its own "Property 1" takes a free name', () => {
  const {store, doc} = setup(fixture());
  const first = addProperty(store, 'btn', 'BOOLEAN')!;
  assert.equal(first.key.split('#')[0], 'Property 1');
  const variant = addProperty(store, 'btn', 'VARIANT')!;
  assert.equal(variant.key, 'Property 2');
  const rows = instanceModel(doc(), ['i1'])!.rows.map(row => row.name);
  assert.equal(new Set(rows).size, rows.length, `names differ on the instance: ${rows.join(', ')}`);
  // Another variant property on the set skips both names.
  const third = addProperty(store, variant.ownerId, 'VARIANT')!;
  assert.equal(third.key, 'Property 3');
});

test('"Select all instances" selects the instances of a main, a set or an instance\'s main; another page opens when this one has none', () => {
  let start = fixture();
  start = createInstance(start, 'btn', {parentId: 'f', x: 0, y: 0, newId: 'i2'}).doc;
  const tx = beginTransaction(start);
  tx.addPage(createNode('PAGE', {id: 'p2', name: 'Screens', parentId: null}));
  start = tx.commit({measurer}).doc;
  start = createInstance(start, 'btn', {parentId: 'p2', x: 0, y: 0, newId: 'far'}).doc;
  const {store, run, select, ctx, revealed, toasts} = setup(start);
  select('btn');
  run('object.select-instances');
  assert.deepEqual([...store.getState().selection].sort(), ['i1', 'i2'], 'this page only, nested copies left out');
  assert.deepEqual([...revealed.at(-1)!].sort(), ['i1', 'i2']);
  select('i2');
  run('object.select-instances');
  assert.deepEqual([...store.getState().selection].sort(), ['i1', 'i2'], 'from an instance: its main\'s');
  select('loose');
  assert.equal(getCommand('object.select-instances')!.enabled!(ctx), false);
  store.transact('Delete', tx => {
    tx.remove('i1');
    tx.remove('i2');
  });
  select('btn');
  run('object.select-instances');
  assert.equal(store.getState().pageId, 'p2');
  assert.deepEqual(store.getState().selection, ['far']);
  assert.deepEqual(toasts, []);
});

test('an instance pasted into a file without its main becomes a frame; in its own file it stays an instance', () => {
  // «Card» holds an instance of «Button»; «c1» is an instance of the card.
  let start = fixture();
  const tx = beginTransaction(start);
  tx.create(createNode('COMPONENT', {id: 'card', name: 'Card', x: 0, y: 400, width: 200, height: 100}), 'page');
  start = tx.commit({measurer}).doc;
  start = createInstance(start, 'btn', {parentId: 'card', x: 10, y: 10, newId: 'nested'}).doc;
  start = createInstance(start, 'card', {parentId: 'page', x: 300, y: 400, newId: 'c1'}).doc;
  const source = setup(start);
  source.select('c1');
  const text = copySelection(source.ctx)!;

  const other = setup(build(add => add('FRAME', 'board', 'page', {x: 2000, y: 2000, width: 50, height: 50})));
  const [pastedId] = pasteData(other.ctx, {text, html: null, files: []}, false)!;
  const pasted = other.doc().nodes[pastedId];
  assert.equal(pasted.type, 'FRAME', 'the card instance is a frame');
  const stack = [...pasted.children!];
  while (stack.length) {
    const node = other.doc().nodes[stack.pop()!];
    assert.notEqual(node.type, 'INSTANCE', `${node.name}: no instance of a main this file lacks`);
    assert.equal(node.mainId, undefined);
    assert.ok(!node.id.includes(';'));
    stack.push(...(node.children ?? []));
  }
  assert.ok(validateDocument(other.doc()).ok, 'the server accepts the result');
  assert.match(other.toasts.at(-1)!, /stayed in another file/);
  assert.equal(other.store.getState().history.undo, 'Paste', 'one undo step');
  other.store.undo();
  assert.equal(other.doc().nodes[pastedId], undefined);

  // In the file it came from it stays an instance of the card.
  const [again] = pasteData(source.ctx, {text, html: null, files: []}, false)!;
  assert.equal(source.doc().nodes[again].type, 'INSTANCE');
  assert.equal(source.doc().nodes[again].componentId, 'card');
  assert.equal(source.toasts.length, 0);

  // An instance whose main was already gone when copied stays one that can be restored.
  source.store.transact('Delete', tx => tx.remove('card'));
  source.select('c1');
  const orphanText = copySelection(source.ctx)!;
  const [orphan] = pasteData(other.ctx, {text: orphanText, html: null, files: []}, false)!;
  assert.equal(other.doc().nodes[orphan].type, 'INSTANCE');
});

test('a nested instance exposed in its main shows its properties on the main\'s instances, set there as overrides', () => {
  // «Card» holds «nested», an instance of «Button» (whose text property is «Label»); «c1» is a card instance.
  let start = fixture();
  start = addComponentPropertyTo(start, 'btn', 'label');
  const tx = beginTransaction(start);
  tx.create(createNode('COMPONENT', {id: 'card', name: 'Card', x: 0, y: 400, width: 200, height: 100}), 'page');
  start = tx.commit({measurer}).doc;
  start = createInstance(start, 'btn', {parentId: 'card', x: 10, y: 10, newId: 'nested'}).doc;
  start = createInstance(start, 'card', {parentId: 'page', x: 300, y: 400, newId: 'c1'}).doc;
  const {store, doc} = setup(start);
  assert.deepEqual(nestedInstancesOf(doc(), 'card').map(node => node.id), ['nested']);
  assert.ok(isExposableInstance(doc(), 'nested'));
  assert.ok(!isExposableInstance(doc(), 'i1'), 'an instance on the page is not inside a main');
  assert.ok(!isExposableInstance(doc(), 'c1;nested'), 'a copy is exposed by its main');
  assert.deepEqual(exposedGroups(doc(), 'c1'), []);

  editNodes(store, 'Show nested instance properties', ['nested'], () => ({isExposedInstance: true}));
  assert.equal(doc().nodes['c1;nested'].isExposedInstance, true, 'the copy inherits the flag');
  assert.deepEqual(exposedInstancesOf(doc(), 'c1'), ['c1;nested']);
  const [group] = exposedGroups(doc(), 'c1');
  assert.equal(group.id, 'c1;nested');
  assert.deepEqual(group.rows.map(row => [row.name, row.value]), [['Label', 'Button']]);

  // Set from the card instance: the nested copy's text changes, the main's and the other instances' do not.
  setInstancesProperty(store, [group.id], group.rows[0].key, 'Buy');
  assert.equal(doc().nodes['c1;nested;label'].text!.characters, 'Buy');
  assert.equal(doc().nodes['nested;label'].text!.characters, 'Button');
  // A change to the card keeps the value; turning exposure off keeps the flag off on the copies.
  store.transact('Size', tx2 => tx2.update('card', {width: 240}));
  assert.equal(doc().nodes['c1;nested;label'].text!.characters, 'Buy');
  editNodes(store, 'Hide', ['nested'], () => ({isExposedInstance: undefined}));
  assert.equal(doc().nodes['c1;nested'].isExposedInstance, undefined);
  assert.deepEqual(exposedGroups(doc(), 'c1'), []);
  assert.ok(validateDocument(doc()).ok);
});

/** «label» of a component drives a TEXT property named after it. */
function addComponentPropertyTo(doc: DesignDocument, componentId: NodeId, layerId: NodeId): DesignDocument {
  const {store} = setup(doc);
  createPropertyFor(store, componentId, layerId, 'characters');
  return store.getState().doc;
}
