import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode, Style} from '../shared/design/types';
import {LIBRARY_PAGE_ID} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {beginTransaction} from '../shared/design/transaction';
import {createInstance, DesignComponentError, pushOverridesToMain, withOverrideTracking} from '../shared/design/components';
import {checkPatchedDocument, validateDocument} from '../shared/design/schema';
import {diffDocuments} from '../shared/design/patch';
import {
  applyLibraryImport,
  buildLibrarySnapshot,
  canonicalJson,
  contentHash,
  isOnLibraryPage,
  libraryClosure,
  LibraryError,
  libraryUpdates,
  publishableAssets,
  remoteAssets,
  remoteId,
  snapshotPart,
  SNAPSHOT_PAGE_ID,
  validateLibraryImport,
  validateLibrarySnapshot,
  type LibraryImport,
  type LibraryManifest,
  type LibrarySnapshot,
} from '../shared/design/libraries';
import {toReact} from '../shared/design/codegen/react';
import {createDesignStore} from '../src/design/engine/store';
import {connectComponentCommands, goToMain} from '../src/design/engine/commands/components';
import {budget} from './helpers/speed';

// Shared libraries (docs/design-tool.md §Teams): what a publication takes along, how another file copies it, and that an update
// replaces the copies while instances keep their overrides.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const RED = {r: 1, g: 0, b: 0}, GREEN = {r: 0, g: 1, b: 0}, BLUE = {r: 0, g: 0, b: 1};
const LIBRARY = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OTHER_LIBRARY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function add(doc: DesignDocument, type: NodeType, props: Partial<SceneNode> & {id: NodeId; parentId: NodeId}): DesignDocument {
  const node = createNode(type, props);
  const parent = doc.nodes[props.parentId];
  return {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
}

const brand = (color = BLUE): Style => ({id: 'sBrand', type: 'FILL', name: 'Brand/Primary', description: '', paints: [solid(color)]});

/** A library file: "Button" (background styled "Brand/Primary" with a radius variable, a label, a picture and a nested "Icon"
 *  whose dot binds a colour aliasing another), a private "_Draft", a text style nobody uses. */
function libraryDoc(color = BLUE, label = 'Button'): DesignDocument {
  let doc = createDocument('p');
  doc = {
    ...doc,
    styles: {sBrand: brand(color), sTitle: {id: 'sTitle', type: 'TEXT', name: 'Title', description: 'Large', text: defaultTextProps('').style}},
    images: {'dz-pic': {url: '/uploads/dz-pic.webp', width: 10, height: 10}},
    variableCollections: {col: {id: 'col', name: 'Tokens', modes: [{modeId: 'm1', name: 'Light'}], defaultModeId: 'm1', variableIds: ['vBase', 'vPrimary', 'vRadius', 'vHidden']}},
    variables: {
      vBase: {id: 'vBase', name: 'Color/Base', collectionId: 'col', type: 'COLOR', valuesByMode: {m1: {...RED, a: 1}}, description: ''},
      vPrimary: {id: 'vPrimary', name: 'Color/Primary', collectionId: 'col', type: 'COLOR', valuesByMode: {m1: {type: 'VARIABLE_ALIAS', id: 'vBase'}}, description: ''},
      vRadius: {id: 'vRadius', name: 'Radius', collectionId: 'col', type: 'FLOAT', valuesByMode: {m1: 8}, description: ''},
      vHidden: {id: 'vHidden', name: 'Internal', collectionId: 'col', type: 'FLOAT', valuesByMode: {m1: 1}, description: '', hiddenFromPublishing: true},
    },
  };
  doc = add(doc, 'COMPONENT', {id: 'icon', parentId: 'p', name: 'Icon', x: 400, y: 0, width: 16, height: 16});
  doc = add(doc, 'ELLIPSE', {id: 'dot', parentId: 'icon', name: 'Dot', width: 16, height: 16, fills: [{...solid(RED), boundVariables: {color: {type: 'VARIABLE_ALIAS', id: 'vPrimary'}}}]});
  doc = add(doc, 'COMPONENT', {id: 'btn', parentId: 'p', name: 'Button', x: 40, y: 40, width: 120, height: 40, description: 'Main button'});
  doc = add(doc, 'RECTANGLE', {id: 'bg', parentId: 'btn', name: 'Background', width: 120, height: 40, fills: [solid(color)], fillStyleId: 'sBrand', boundVariables: {cornerRadius: {type: 'VARIABLE_ALIAS', id: 'vRadius'}}, constraints: {horizontal: 'STRETCH', vertical: 'STRETCH'}});
  doc = add(doc, 'RECTANGLE', {id: 'pic', parentId: 'btn', name: 'Picture', width: 8, height: 8, fills: [{type: 'IMAGE', imageRef: 'dz-pic', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
  doc = add(doc, 'TEXT', {id: 'label', parentId: 'btn', name: 'Label', x: 10, y: 10, width: 60, height: 20, text: defaultTextProps(label)});
  doc = createInstance(doc, 'icon', {parentId: 'btn', x: 96, y: 12, newId: 'ico'}).doc;
  doc = add(doc, 'COMPONENT', {id: 'draft', parentId: 'p', name: '_Draft', x: 0, y: 200});
  return doc;
}

const publish = (doc: DesignDocument, version: number, previous?: LibraryManifest | null) =>
  buildLibrarySnapshot(doc, {components: ['btn'], styles: ['sBrand'], variableCollections: ['col']}, {version, previous});

function importOf(snapshot: LibrarySnapshot, version: number, request = {components: ['btn'], styles: [] as string[], variableCollections: [] as string[]}): LibraryImport {
  const part = snapshotPart(snapshot, request);
  return {libraryId: LIBRARY, version, ...part.selection, components: [...part.selection.components], styles: [...part.selection.styles], variableCollections: [...part.selection.variableCollections], document: JSON.parse(JSON.stringify(part.document))};
}

function applyImport(doc: DesignDocument, payload: LibraryImport) {
  const checked = validateLibraryImport(payload);
  assert.ok(checked.ok, checked.ok ? '' : checked.error + ' ' + checked.path);
  const tx = beginTransaction(doc);
  const result = applyLibraryImport(tx, checked.value);
  return {doc: tx.commit({measurer}).doc, result};
}

const valid = (doc: DesignDocument) => {
  const result = validateDocument(JSON.parse(JSON.stringify(doc)));
  assert.ok(result.ok, result.ok ? '' : `${result.error} ${result.path}`);
};

test('the closure of a published component takes its nested components, styles, variables through aliases and pictures', () => {
  const doc = libraryDoc();
  const closure = libraryClosure(doc, {components: ['btn'], styles: [], variableCollections: []});
  assert.deepEqual(closure.roots, ['btn', 'icon']);
  assert.ok(closure.nodes.includes('ico') && closure.nodes.includes('ico;dot') && closure.nodes.includes('dot'));
  assert.ok(!closure.nodes.includes('draft'));
  assert.deepEqual(closure.styles, ['sBrand']);
  assert.deepEqual(new Set(closure.variables), new Set(['vRadius', 'vPrimary', 'vBase']));
  assert.deepEqual(closure.collections, ['col']);
  assert.deepEqual(closure.images, ['dz-pic']);
  // A published collection brings every variable but the hidden ones.
  const collection = libraryClosure(doc, {components: [], styles: [], variableCollections: ['col']});
  assert.deepEqual(new Set(collection.variables), new Set(['vBase', 'vPrimary', 'vRadius']));
  // A variant names its set.
  let sets = add(createDocument('p'), 'COMPONENT_SET', {id: 'set', parentId: 'p', name: 'Button'});
  sets = add(sets, 'COMPONENT', {id: 'v1', parentId: 'set', name: 'Size=S'});
  assert.deepEqual(libraryClosure(sets, {components: ['v1'], styles: [], variableCollections: []}).roots, ['set']);
});

test('a snapshot is a valid document of the published components and what they use, with a manifest of the published assets', () => {
  const doc = libraryDoc();
  const snapshot = publish(doc, 1);
  const checked = validateLibrarySnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.ok(checked.ok, checked.ok ? '' : checked.error + ' ' + checked.path);
  assert.deepEqual(snapshot.document.pages, [SNAPSHOT_PAGE_ID]);
  assert.deepEqual(snapshot.document.nodes[SNAPSHOT_PAGE_ID].children, ['btn', 'icon']);
  // Where a component stood in its file is not part of it.
  assert.equal(snapshot.document.nodes.btn.x, 0);
  assert.equal(snapshot.document.nodes.btn.parentId, SNAPSHOT_PAGE_ID);
  assert.ok(!snapshot.document.nodes.draft, 'unpublished, unused components stay home');
  assert.deepEqual(snapshot.manifest.components.map(entry => [entry.key, entry.name, entry.description, entry.changedIn]), [['btn', 'Button', 'Main button', 1]]);
  assert.deepEqual(snapshot.manifest.styles.map(entry => entry.key), ['sBrand']);
  assert.deepEqual(snapshot.manifest.variableCollections.map(entry => [entry.key, entry.variables]), [['col', 3]]);
  assert.ok(!snapshot.document.variables.vHidden);
  assert.deepEqual(Object.keys(snapshot.document.images), ['dz-pic']);
  assert.throws(() => buildLibrarySnapshot(doc, {components: [], styles: [], variableCollections: []}, {version: 1}), (error: unknown) => error instanceof LibraryError && error.code === 'empty');
  // The publish dialog offers local components and sets only, the private one too (unchecked by the dialog).
  assert.deepEqual(publishableAssets(doc).components.map(entry => entry.id).sort(), ['btn', 'draft', 'icon']);
});

test('republishing keeps the version an unchanged asset last changed in; a change anywhere in what it uses moves it', () => {
  const first = publish(libraryDoc(), 1);
  const same = publish(libraryDoc(), 2, first.manifest);
  assert.equal(same.manifest.components[0].changedIn, 1);
  assert.equal(same.manifest.styles[0].changedIn, 1);
  assert.equal(same.manifest.components[0].hash, first.manifest.components[0].hash);
  // Moving the component on its page is not a change.
  const moved = libraryDoc();
  moved.nodes.btn = {...moved.nodes.btn, x: 900, y: 900};
  assert.equal(publish(moved, 2, first.manifest).manifest.components[0].changedIn, 1);
  // The style changed: the style and the component using it move; the collection stays.
  const recoloured = publish(libraryDoc(GREEN), 3, first.manifest);
  assert.equal(recoloured.manifest.components[0].changedIn, 3);
  assert.equal(recoloured.manifest.styles[0].changedIn, 3);
  assert.equal(recoloured.manifest.variableCollections[0].changedIn, 1);
  // A nested component changed: the component using it moves too.
  const nested = libraryDoc();
  nested.nodes.dot = {...nested.nodes.dot, width: 12};
  assert.equal(publish(nested, 4, first.manifest).manifest.components[0].changedIn, 4);
});

test('canonical JSON ignores key order and the content hash tells contents apart', () => {
  assert.equal(canonicalJson({b: 1, a: [1, {d: 2, c: undefined, e: null}]}), canonicalJson({a: [1, {e: null, d: 2}], b: 1}));
  assert.equal(contentHash('a'), contentHash('a'));
  assert.notEqual(contentHash('a'), contentHash('b'));
  assert.match(contentHash(''), /^[0-9a-f]{16}$/);
});

test('ids of a library keep instance copies naming their instance, part by part', () => {
  assert.equal(remoteId(LIBRARY, 'btn'), 'r0f1e2d3c4b5a4968:btn');
  assert.equal(remoteId(LIBRARY, 'ico;dot'), 'r0f1e2d3c4b5a4968:ico;r0f1e2d3c4b5a4968:dot');
  assert.notEqual(remoteId(OTHER_LIBRARY, 'btn'), remoteId(LIBRARY, 'btn'));
});

test('a file uses a library component through a read-only copy on its hidden page; an update keeps the instance overrides', () => {
  const v1 = publish(libraryDoc(), 1);
  let doc: DesignDocument = createDocument('home');
  const imported = applyImport(doc, importOf(v1, 1));
  doc = imported.doc;
  valid(doc);
  const btn = remoteId(LIBRARY, 'btn');
  assert.deepEqual(doc.pages, ['home'], 'the library page is never listed');
  assert.equal(doc.nodes[LIBRARY_PAGE_ID].type, 'PAGE');
  assert.deepEqual(imported.result.components, [btn, remoteId(LIBRARY, 'icon')]);
  assert.deepEqual(doc.nodes[btn].remote, {libraryId: LIBRARY, key: 'btn', version: 1});
  assert.ok(isOnLibraryPage(doc, remoteId(LIBRARY, 'ico;dot')));
  // References follow the copies: the style, the variables, the nested instance, the picture.
  const bg = doc.nodes[remoteId(LIBRARY, 'bg')];
  assert.equal(bg.fillStyleId, remoteId(LIBRARY, 'sBrand'));
  assert.equal(bg.boundVariables?.cornerRadius?.id, remoteId(LIBRARY, 'vRadius'));
  assert.equal(doc.styles[remoteId(LIBRARY, 'sBrand')].remote?.key, 'sBrand');
  assert.equal(doc.variables[remoteId(LIBRARY, 'vPrimary')].valuesByMode.m1 && (doc.variables[remoteId(LIBRARY, 'vPrimary')].valuesByMode.m1 as {id: string}).id, remoteId(LIBRARY, 'vBase'));
  assert.equal(doc.nodes[remoteId(LIBRARY, 'ico')].componentId, remoteId(LIBRARY, 'icon'));
  assert.equal(doc.images['dz-pic'].url, '/uploads/dz-pic.webp');
  // The radius variable reached the copy on commit.
  assert.equal(bg.cornerRadius, 8);

  // An instance on the page, its label overridden.
  doc = createInstance(doc, btn, {parentId: 'home', x: 10, y: 10, newId: 'use'}).doc;
  const label = `use;${remoteId(LIBRARY, 'label')}`;
  const tx = beginTransaction(doc);
  tx.update(label, withOverrideTracking(doc, label, {text: defaultTextProps('Buy')}));
  doc = tx.commit({measurer}).doc;
  valid(doc);
  assert.equal(doc.nodes[label].text?.characters, 'Buy');
  assert.throws(() => pushOverridesToMain(doc, 'use'), (error: unknown) => error instanceof DesignComponentError && error.code === 'remote_component');

  // The library recolours the button and renames the label; the file is offered the update.
  const v2 = publish(libraryDoc(GREEN, 'Button 2'), 2, v1.manifest);
  const updates = libraryUpdates(doc, [{id: LIBRARY, version: 2, manifest: v2.manifest}]);
  // The style came along with the button and changed too; the collection did not.
  assert.deepEqual(updates.map(update => [update.kind, update.key, update.from, update.to]), [['component', 'btn', 1, 2], ['style', 'sBrand', 1, 2]]);
  assert.deepEqual(libraryUpdates(doc, [{id: LIBRARY, version: 1, manifest: v1.manifest}]), []);
  assert.deepEqual(remoteAssets(doc).get(LIBRARY), {components: ['btn', 'icon'], styles: ['sBrand'], variableCollections: ['col']});

  const before = doc;
  doc = applyImport(doc, importOf(v2, 2)).doc;
  valid(doc);
  const patch = diffDocuments(before, doc);
  const checked = checkPatchedDocument(before, doc, JSON.parse(JSON.stringify(patch)));
  assert.ok(checked.ok, checked.ok ? '' : checked.error + ' ' + checked.path);
  assert.equal(doc.nodes[btn].remote?.version, 2);
  assert.deepEqual((doc.nodes[`use;${remoteId(LIBRARY, 'bg')}`].fills[0] as {color: unknown}).color, GREEN, 'the instance follows the new main');
  assert.equal(doc.nodes[label].text?.characters, 'Buy', 'and keeps its override');
  assert.equal(doc.nodes[remoteId(LIBRARY, 'label')].text?.characters, 'Button 2');
  assert.deepEqual(libraryUpdates(doc, [{id: LIBRARY, version: 2, manifest: v2.manifest}]), []);
});

test('library styles and variables apply by reference: layers of the file follow an update', () => {
  const v1 = publish(libraryDoc(), 1);
  let doc: DesignDocument = createDocument('home');
  doc = applyImport(doc, importOf(v1, 1, {components: [], styles: ['sBrand'], variableCollections: ['col']})).doc;
  const style = remoteId(LIBRARY, 'sBrand'), radius = remoteId(LIBRARY, 'vRadius');
  assert.ok(!doc.nodes[LIBRARY_PAGE_ID], 'no components, no hidden page');
  doc = add(doc, 'RECTANGLE', {id: 'card', parentId: 'home', fills: [solid(BLUE)], fillStyleId: style, cornerRadius: 8, boundVariables: {cornerRadius: {type: 'VARIABLE_ALIAS', id: radius}}});
  valid(doc);
  const changed = libraryDoc(GREEN);
  changed.variables.vRadius = {...changed.variables.vRadius, valuesByMode: {m1: 20}};
  const v2 = publish(changed, 2, v1.manifest);
  assert.deepEqual(libraryUpdates(doc, [{id: LIBRARY, version: 2, manifest: v2.manifest}]).map(update => update.kind).sort(), ['style', 'variables']);
  doc = applyImport(doc, importOf(v2, 2, {components: [], styles: ['sBrand'], variableCollections: ['col']})).doc;
  valid(doc);
  assert.deepEqual((doc.nodes.card.fills[0] as {color: unknown}).color, GREEN);
  assert.equal(doc.nodes.card.cornerRadius, 20);
  assert.equal(doc.variableCollections[remoteId(LIBRARY, 'col')].remote?.version, 2);
});

test('a component only carried along keeps its collection at the version the file asked for', () => {
  const v1 = publish(libraryDoc(), 1);
  let doc: DesignDocument = createDocument('home');
  doc = applyImport(doc, importOf(v1, 1, {components: [], styles: [], variableCollections: ['col']})).doc;
  const v2 = publish(libraryDoc(), 2, v1.manifest);
  doc = applyImport(doc, importOf(v2, 2)).doc;
  assert.equal(doc.variableCollections[remoteId(LIBRARY, 'col')].remote?.version, 1);
  assert.equal(doc.nodes[remoteId(LIBRARY, 'btn')].remote?.version, 2);
});

test('copies of another library carried by a published component are published as the publisher\'s own', () => {
  const v1 = publish(libraryDoc(), 1);
  let doc: DesignDocument = createDocument('home');
  doc = applyImport(doc, importOf(v1, 1)).doc;
  const remoteButton = remoteId(LIBRARY, 'btn');
  doc = add(doc, 'COMPONENT', {id: 'card', parentId: 'home', name: 'Card', width: 200, height: 100});
  doc = createInstance(doc, remoteButton, {parentId: 'card', x: 10, y: 10, newId: 'cardBtn'}).doc;
  assert.throws(() => buildLibrarySnapshot(doc, {components: [remoteButton], styles: [], variableCollections: []}, {version: 1}), (error: unknown) => error instanceof LibraryError && error.code === 'not_local');
  assert.deepEqual(publishableAssets(doc).components.map(entry => entry.id), ['card']);
  const snapshot = buildLibrarySnapshot(doc, {components: ['card'], styles: [], variableCollections: []}, {version: 1});
  assert.ok(validateLibrarySnapshot(JSON.parse(JSON.stringify(snapshot))).ok);
  assert.ok(!snapshot.document.nodes[remoteButton].remote, 'the snapshot speaks for its own library');
  // A third file uses it: the button comes along under the second library's prefix.
  const third = applyImport(createDocument('third'), {...importOf(snapshot, 1, {components: ['card'], styles: [], variableCollections: []}), libraryId: OTHER_LIBRARY}).doc;
  valid(third);
  assert.equal(third.nodes[remoteId(OTHER_LIBRARY, remoteButton)].remote?.libraryId, OTHER_LIBRARY);
});

test('the schema keeps library copies on the hidden page and the hidden page out of the page list', () => {
  const v1 = publish(libraryDoc(), 1);
  const doc = applyImport(createDocument('home'), importOf(v1, 1)).doc;
  const btn = remoteId(LIBRARY, 'btn');
  const refused = (mutate: (copy: DesignDocument) => void, message: RegExp) => {
    const copy = JSON.parse(JSON.stringify(doc)) as DesignDocument;
    mutate(copy);
    const result = validateDocument(copy);
    assert.equal(result.ok, false);
    assert.match((result as {error: string}).error, message);
  };
  refused(copy => void (copy.pages = ['home', LIBRARY_PAGE_ID]), /page list/);
  refused(copy => void delete copy.nodes[btn].remote, /live on the libraries page/);
  refused(copy => {
    copy.nodes.home.children = [btn];
    copy.nodes[LIBRARY_PAGE_ID].children = copy.nodes[LIBRARY_PAGE_ID].children!.filter(id => id !== btn);
    copy.nodes[btn].parentId = 'home';
  }, /lives only on the libraries page/);
  refused(copy => void ((copy.nodes[btn].remote as {libraryId: string}).libraryId = 'not-a-library'), /./);
  // A patch that adds the hidden page with its copies passes the patch checks.
  const empty = createDocument('home');
  const patch = diffDocuments(empty, doc);
  assert.ok(checkPatchedDocument(empty, doc, JSON.parse(JSON.stringify(patch))).ok);
});

test('a hostile snapshot or import is refused before it reaches a document', () => {
  const snapshot = JSON.parse(JSON.stringify(publish(libraryDoc(), 1))) as LibrarySnapshot;
  assert.equal(validateLibrarySnapshot({...snapshot, format: 2}).ok, false);
  const ghost = JSON.parse(JSON.stringify(snapshot)) as LibrarySnapshot;
  ghost.manifest.components[0].key = 'ghost';
  assert.equal(validateLibrarySnapshot(ghost).ok, false);
  const frame = JSON.parse(JSON.stringify(snapshot)) as LibrarySnapshot;
  frame.document.nodes.btn.type = 'FRAME';
  assert.equal(validateLibrarySnapshot(frame).ok, false);
  const marked = JSON.parse(JSON.stringify(snapshot)) as LibrarySnapshot;
  marked.document.styles.sBrand.remote = {libraryId: LIBRARY, key: 'x', version: 1};
  assert.equal(validateLibrarySnapshot(marked).ok, false);
  const payload = importOf(snapshot, 1);
  assert.equal(validateLibraryImport({...payload, libraryId: '../x'}).ok, false);
  assert.equal(validateLibraryImport({...payload, document: {...payload.document, pages: ['x']}}).ok, false);
  // A deep chain of nodes is refused by the document checks, within a time budget.
  const deep = JSON.parse(JSON.stringify(payload)) as LibraryImport;
  let parent = 'btn';
  for (let i = 0; i < 400; i++) {
    const id = 'deep' + i;
    deep.document.nodes[id] = {...createNode('FRAME', {id}), parentId: parent};
    deep.document.nodes[parent].children = [...(deep.document.nodes[parent].children ?? []), id];
    parent = id;
  }
  const started = performance.now();
  assert.equal(validateLibraryImport(deep).ok, false);
  assert.ok(performance.now() - started < budget(500));
});

test('design to code: an instance of a library component is written as a component of the project, marked as the library\'s', () => {
  const v1 = publish(libraryDoc(), 1);
  let doc: DesignDocument = applyImport(createDocument('home'), importOf(v1, 1)).doc;
  doc = createInstance(doc, remoteId(LIBRARY, 'btn'), {parentId: 'home', x: 0, y: 0, newId: 'cta'}).doc;
  const result = toReact(doc, ['home'], {measurer});
  const button = result.files.find(file => file.path.startsWith('src/components/') && file.path.endsWith('.tsx') && file.contents.includes('"Button"'));
  assert.ok(button, result.files.map(file => file.path).join(', '));
  assert.match(button!.contents, /A shared library component \(version 1\): change it in the library file/);
  const icon = result.files.find(file => file.path.endsWith('.tsx') && file.contents.includes('"Icon"'));
  assert.ok(icon, 'the nested library component is written too');
  assert.match(icon!.contents, /A shared library component/);
  assert.ok(result.entries[0]?.usage?.startsWith('<'), JSON.stringify(result.entries[0]));
  assert.ok(!result.files.some(file => file.contents.includes('morfa:library')), 'the hidden page never reaches the code');
});

test('"Go to main component" on an instance of a library component never shows the hidden page', async () => {
  const v1 = publish(libraryDoc(), 1);
  let doc: DesignDocument = applyImport(createDocument('home'), importOf(v1, 1)).doc;
  doc = createInstance(doc, remoteId(LIBRARY, 'btn'), {parentId: 'home', x: 0, y: 0, newId: 'cta'}).doc;
  const store = createDesignStore({doc, measurer});
  const toasts: string[] = [];
  const disconnect = connectComponentCommands(store, {toast: message => void toasts.push(message), revealNodes: () => {}});
  store.setSelection(['cta']);
  assert.equal(goToMain(store, 'cta'), null);
  assert.equal(store.getState().pageId, 'home');
  assert.deepEqual(store.getState().selection, ['cta']);
  store.setPage(LIBRARY_PAGE_ID);
  assert.equal(store.getState().pageId, 'home', 'the store refuses the hidden page');
  // No library session in a test: the library can't be opened, and the toast says so.
  for (let tick = 0; tick < 100 && !toasts.length; tick++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(toasts[0] ?? '', /comes from a library that cannot be opened/);
  disconnect();
});
