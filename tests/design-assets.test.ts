import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {createComponent} from '../shared/design/components';
import {combineAsVariants} from '../shared/design/variants';
import {addVariableMode, createVariable, createVariableCollection, setVariableValue, bindPaintVariable, deleteVariable, removeVariableMode} from '../shared/design/variables';
import type {DesignDocument, NodeId, SceneNode, Style} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createDesignStore, type DesignStore} from '../src/design/engine/store';
import type {EditorServices} from '../src/design/editor/services';
import {ComponentIndex, folderTree, isAsset} from '../src/design/panels/left/component-index';
import {colorHex, leafName, paintBackground, parseHex, textStyleSummary, variableGroups, variablesSummary} from '../src/design/panels/left/assets-model';
import {canHoldInstance, placeInstanceAt, showMainComponent} from '../src/design/panels/left/assets-actions';
import {commitEdit} from '../src/design/panels/left/apply-edit';
import {budget} from './helpers/speed';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

type Add = (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void;
function build(recipe: (add: Add) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.addPage(createNode('PAGE', {id: 'lib', name: 'Components'}));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, name: id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

function library() {
  let doc = build(add => {
    add('COMPONENT', 'btn', 'lib', {name: 'Primary button / Primary', width: 120, height: 40, description: 'Main action'});
    add('RECTANGLE', 'btnBg', 'btn', {width: 120, height: 40});
    add('COMPONENT', 'icon', 'lib', {name: 'Icons/Star', x: 200, width: 24, height: 24});
    add('COMPONENT', 'on', 'lib', {name: 'State=On', x: 300, width: 40, height: 20});
    add('COMPONENT', 'off', 'lib', {name: 'State=Off', x: 360, width: 40, height: 20});
    add('FRAME', 'screen', 'page', {x: 0, y: 0, width: 400, height: 400});
    add('FRAME', 'other', 'page', {x: 1000, y: 0, width: 200, height: 200});
  });
  doc = combineAsVariants(doc, ['on', 'off'], 'toggle').doc;
  // The set is renamed so the sorted order below is fixed.
  doc = {...doc, nodes: {...doc.nodes, toggle: {...doc.nodes.toggle, name: 'Toggle'}}};
  return doc;
}

function services(store: DesignStore, toasts: string[] = []): EditorServices {
  return {
    fileId: 'f', store, fonts: {} as EditorServices['fonts'], images: {} as EditorServices['images'], renderer: () => null,
    uploadImage: () => Promise.reject(new Error('no')), toast: message => void toasts.push(message), revealNodes: () => {}, openDialog: () => {},
  };
}

test('the component index lists standalone components and variant sets, never variants or copies', () => {
  const store = createDesignStore({doc: library(), measurer});
  const index = new ComponentIndex(store);
  const stop = index.subscribe(() => {});
  assert.deepEqual(index.components().map(entry => entry.id), ['icon', 'btn', 'toggle'], 'sorted by name within the page');
  assert.equal(index.components().find(entry => entry.id === 'btn')?.description, 'Main action');
  assert.ok(!isAsset(store.getState().doc, store.getState().doc.nodes.on), 'a variant is part of its set');
  stop();
});

test('the index follows edits incrementally and bumps only the changed component’s thumbnail', () => {
  const store = createDesignStore({doc: library(), measurer});
  const index = new ComponentIndex(store);
  let calls = 0;
  const stop = index.subscribe(() => calls++);
  const btn = index.thumbnailVersion('btn'), icon = index.thumbnailVersion('icon'), toggle = index.thumbnailVersion('toggle');
  // A change deep inside a component.
  store.transact('Color', tx => tx.update('btnBg', {fills: [solid({r: 1, g: 0, b: 0})]}));
  assert.equal(index.thumbnailVersion('btn'), btn + 1);
  assert.equal(index.thumbnailVersion('icon'), icon);
  // A change in a variant redraws its set.
  store.transact('Color', tx => tx.update('on', {opacity: 0.5}));
  assert.equal(index.thumbnailVersion('toggle'), toggle + 1);
  // A gesture frame is ignored until it ends.
  const gesture = store.gesture('Move');
  gesture.update(tx => tx.update('btnBg', {x: 5}));
  assert.equal(index.thumbnailVersion('btn'), btn + 1);
  gesture.commit();
  assert.equal(index.thumbnailVersion('btn'), btn + 2);
  // Rename and a new component reorder the list.
  store.transact('Name', tx => tx.update('icon', {name: 'Zzz last'}));
  assert.deepEqual(index.components().map(entry => entry.id), ['btn', 'toggle', 'icon']);
  store.transact('New', tx => tx.create(createNode('COMPONENT', {id: 'avatar', name: 'Avatar'}), 'page'));
  assert.deepEqual(index.components().map(entry => [entry.id, entry.pageId]), [['avatar', 'page'], ['btn', 'lib'], ['toggle', 'lib'], ['icon', 'lib']], 'page order first');
  store.transact('Delete', tx => tx.remove('btn'));
  assert.ok(!index.components().some(entry => entry.id === 'btn'));
  store.undo();
  assert.ok(index.components().some(entry => entry.id === 'btn'));
  // Unrelated edits do not notify.
  const before = calls;
  store.transact('Shift', tx => tx.update('screen', {x: 10}));
  assert.equal(calls, before);
  stop();
});

test('names with "/" make folders', () => {
  const tree = folderTree([{name: 'Button / Primary'}, {name: 'Button/Secondary'}, {name: 'Icons/Arrows/Up'}, {name: 'Card'}], 'p');
  assert.deepEqual(tree.items.map(item => item.name), ['Card']);
  assert.deepEqual(tree.folders.map(folder => [folder.name, folder.key]), [['Button', 'p/Button'], ['Icons', 'p/Icons']]);
  assert.deepEqual(tree.folders[0].items.map(item => item.name), ['Primary', 'Secondary']);
  assert.equal(tree.folders[1].folders[0].items[0].name, 'Up');
});

test('a click places an instance centred on the point, inside the frame there, as one undo step', () => {
  const store = createDesignStore({doc: library(), measurer});
  const id = placeInstanceAt(services(store), 'btn', {x: 100, y: 100})!;
  const doc = store.getState().doc;
  assert.equal(doc.nodes[id].type, 'INSTANCE');
  assert.equal(doc.nodes[id].componentId, 'btn');
  assert.equal(doc.nodes[id].parentId, 'screen');
  assert.deepEqual([doc.nodes[id].x, doc.nodes[id].y], [40, 80]);
  assert.equal(doc.nodes[id].children?.length, 1, 'its copy materialized');
  assert.deepEqual(store.getState().selection, [id]);
  // A set places its default variant; outside any frame it lands on the page.
  const set = placeInstanceAt(services(store), 'toggle', {x: 700, y: 700})!;
  assert.equal(store.getState().doc.nodes[set].parentId, 'page');
  assert.equal(store.getState().doc.nodes[set].componentId, 'on');
  store.undo();
  store.undo();
  assert.equal(store.getState().doc.nodes[id], undefined);
});

test('an instance that would contain its own component falls back to the page; a set with no variant is refused', () => {
  const doc = build(add => {
    add('FRAME', 'card', 'page', {width: 300, height: 300});
  });
  const made = createComponent(doc, ['card']);
  const store = createDesignStore({doc: made.doc, measurer});
  const component = made.componentIds[0];
  assert.ok(!canHoldInstance(store.getState().doc, component, component), 'a component cannot hold itself');
  assert.ok(canHoldInstance(store.getState().doc, component, 'page'));
  const id = placeInstanceAt(services(store), component, {x: 150, y: 150})!;
  assert.equal(store.getState().doc.nodes[id].parentId, 'page', 'not inside itself');
  const toasts: string[] = [];
  assert.equal(placeInstanceAt(services(store, toasts), 'missing', {x: 0, y: 0}), null);
});

test('"Go to main component" switches the page and selects it', () => {
  const store = createDesignStore({doc: library(), measurer});
  showMainComponent(services(store), 'icon');
  assert.equal(store.getState().pageId, 'lib');
  assert.deepEqual(store.getState().selection, ['icon']);
});

test('style previews and summaries', () => {
  const solidStyle = paintBackground([solid({r: 1, g: 0, b: 0}, 0.5)]);
  assert.equal(solidStyle, 'linear-gradient(rgb(255 0 0 / 0.5), rgb(255 0 0 / 0.5))');
  const gradient = paintBackground([{type: 'GRADIENT_LINEAR', gradientStops: [{position: 0, color: {r: 0, g: 0, b: 0, a: 1}}, {position: 1, color: {r: 1, g: 1, b: 1, a: 1}}], gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}], opacity: 1, visible: true, blendMode: 'NORMAL'}]);
  assert.equal(gradient, 'linear-gradient(90deg, rgb(0 0 0 / 1) 0%, rgb(255 255 255 / 1) 100%)');
  assert.equal(paintBackground([]), null);
  const text: Style = {id: 't', type: 'TEXT', name: 'Headings/H1', description: '', text: {fontFamily: 'Inter', fontWeight: 700, italic: false, fontSize: 40, lineHeight: {unit: 'PIXELS', value: 48}, letterSpacing: {unit: 'PERCENT', value: 0}, textDecoration: 'NONE', textCase: 'ORIGINAL'}};
  assert.equal(textStyleSummary(text), '40/48 · Inter Bold');
  assert.equal(textStyleSummary({...text, text: {...text.text!, fontSize: 15.5, lineHeight: {unit: 'AUTO'}, italic: true, fontWeight: 400}}), '15.5/Auto · Inter Italic');
});

test('hex colours read and write', () => {
  assert.deepEqual(parseHex('#f80'), {r: 1, g: 0x88 / 255, b: 0, a: 1});
  assert.deepEqual(parseHex('FF880080'), {r: 1, g: 0x88 / 255, b: 0, a: 0x80 / 255});
  assert.equal(parseHex('xyz'), null);
  assert.equal(parseHex('12345'), null);
  assert.equal(colorHex({r: 1, g: 0.5, b: 0}), 'FF8000');
});

test('variables group by "/" and the panel summarizes them', () => {
  let doc = createDocument('page');
  assert.equal(variablesSummary(doc), 'No variables yet.');
  doc = createVariableCollection(doc, {id: 'c', name: 'Colors'}).doc;
  for (const [id, name] of [['a', 'Surface/Primary'], ['b', 'Accent'], ['c1', 'Surface / Card'], ['d', 'Text/Primary'], ['e', 'Extra']] as const) {
    doc = createVariable(doc, {id, name, collectionId: 'c', type: 'COLOR'}).doc;
  }
  const groups = variableGroups(doc, doc.variableCollections.c);
  assert.deepEqual(groups.map(group => [group.path, group.variables.map(variable => variable.id)]), [['', ['b', 'e']], ['Surface', ['a', 'c1']], ['Text', ['d']]]);
  assert.equal(leafName('Surface / Card'), 'Card');
  assert.equal(variablesSummary(doc), '1 collection · 5 variables');
  doc = createVariableCollection(doc, {id: 'n', name: 'Numbers'}).doc;
  doc = createVariable(doc, {id: 'x', name: 'x', collectionId: 'n', type: 'FLOAT'}).doc;
  assert.equal(variablesSummary(doc), '2 collections · 6 variables');
});

test('variable edits from the dialog are single undo steps that also update bound layers', () => {
  let doc = build(add => add('RECTANGLE', 'r', 'page', {fills: [solid({r: 0, g: 0, b: 0})]}));
  doc = createVariableCollection(doc, {id: 'c', name: 'Colors', modes: [{modeId: 'light', name: 'Light'}]}).doc;
  doc = addVariableMode(doc, 'c', {modeId: 'dark', name: 'Dark'}).doc;
  doc = createVariable(doc, {id: 'bg', name: 'Surface', collectionId: 'c', type: 'COLOR', value: {r: 1, g: 1, b: 1, a: 1}}).doc;
  doc = createVariable(doc, {id: 'card', name: 'Card', collectionId: 'c', type: 'COLOR', value: {r: 0.5, g: 0.5, b: 0.5, a: 1}}).doc;
  doc = bindPaintVariable(doc, 'r', 'fills', 0, 'card').doc;
  const store = createDesignStore({doc, measurer});
  const fill = () => (store.getState().doc.nodes.r.fills[0] as {color: {r: number}}).color.r;
  assert.equal(fill(), 0.5);
  const run = (label: string, op: (d: DesignDocument) => {doc: DesignDocument; changed: ReadonlySet<string>}) => {
    const before = store.getState().doc;
    commitEdit(store, label, before, op(before));
  };
  run('Value', d => setVariableValue(d, 'card', 'light', {r: 0.25, g: 0.25, b: 0.25, a: 1}));
  assert.equal(fill(), 0.25, 'the bound fill follows');
  run('Alias', d => setVariableValue(d, 'card', 'light', {type: 'VARIABLE_ALIAS', id: 'bg'}));
  assert.equal(fill(), 1, 'an alias resolves');
  run('Mode', d => removeVariableMode(d, 'c', 'dark'));
  assert.deepEqual(store.getState().doc.variableCollections.c.modes.map(mode => mode.modeId), ['light']);
  run('Delete', d => deleteVariable(d, 'bg'));
  assert.equal(store.getState().doc.variables.bg, undefined);
  assert.equal(fill(), 1, 'the alias became the value it had');
  store.undo();
  assert.ok(store.getState().doc.variables.bg);
  store.undo();
  store.undo();
  store.undo();
  assert.equal(fill(), 0.5);
  assert.equal(store.getState().doc.variables.card.valuesByMode.light && (store.getState().doc.variables.card.valuesByMode.light as {r: number}).r, 0.5);
});

test('a library of 600 components is listed in English numeric order in a few milliseconds', () => {
  // localeCompare with options builds a collator per comparison: sorting 600 names took ~34 ms (2026-10-07); one collator, ~1 ms.
  const names = Array.from({length: 600}, (_, i) => `Section ${i % 20 + 1}/Item ${(i * 7919) % 600}`);
  const doc = build(add => names.forEach((name, i) => add('COMPONENT', `c${i}`, 'lib', {name, x: i * 10, width: 8, height: 8})));
  const store = createDesignStore({doc, measurer, idle: () => () => {}});
  const index = new ComponentIndex(store);
  const started = performance.now();
  const list = index.components();
  const ms = performance.now() - started;
  assert.deepEqual(list.map(entry => entry.name), [...names].sort((a, b) => a.localeCompare(b, 'en', {numeric: true})));
  assert.ok(ms <= budget(10), `${ms.toFixed(1)} ms (budget ${budget(10).toFixed(1)})`);
});
