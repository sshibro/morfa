import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import {worldBox} from '../shared/design/geometry';
import {addComponentProperty, bindProperty, createComponent, createInstance, isOverridden} from '../shared/design/components';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode, TextProps} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {buildClipboardPayload} from '../src/design/engine/clipboard';
import {findByShortcut, getCommand, listCommands, type CommandContext} from '../src/design/engine/commands';
import {createDesignStore, type DesignStore} from '../src/design/engine/store';
import {
  DEFAULT_FIND_OPTIONS, FindSearch, FindSession, findAll, foldForSearch, occurrences, registerFindCommands, replaceAllIn, replaceMatch, findBar, type FindOptions,
} from '../src/design/engine/commands/find';
import {copyProperties, pasteProperties, propertiesPatch, registerPropertyCommands, setCopiedProperties} from '../src/design/engine/commands/properties';
import {registerPasteReplaceCommands, replacementTarget, replaceWithPayload} from '../src/design/engine/commands/paste-replace';
import {RASTER_MAX_SIDE, rasterScale, rasterTargets, registerRasterizeCommands, replaceWithPicture} from '../src/design/engine/commands/rasterize';
import {canCopyLinks, connectLinks, copyPageLink, followNodeLinks, followVersionLinks, linkedNodeId, linkedVersionId, linkTarget, nodeLink, registerLinkCommands, selectNode, versionLink} from '../src/design/engine/commands/link';
import {registerHelpCommands, supportChannel} from '../src/design/engine/commands/help';
import {MAIN_MENU} from '../src/design/editor/chrome/commands';
import {installEditorCommands} from '../src/design/editor/command-bridge';
import {registerTextCommands} from '../src/design/engine/commands/text';
import {registerFileCommands} from '../src/design/engine/commands/file';
import {registerLeftPanelCommands} from '../src/design/panels/left/commands';
import {registerCodeCommands} from '../src/design/engine/commands/code';
import {registerExportCommands} from '../src/design/engine/commands/export';
import type {FontRegistry, ImageCache} from '../src/design/engine/contracts';
import {budget} from './helpers/speed';

// The menu commands that came with "Find and replace" (src/design/engine/commands/{find,properties,
// paste-replace,rasterize,link,help}.ts): searching and replacing (instance-bound texts change their
// property), copying and pasting properties, pasting with replacement, rasterizing, links to layers.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

const textNode = (id: NodeId, characters: string, props: Partial<SceneNode> = {}): SceneNode => {
  const node = createNode('TEXT', {id, name: characters, ...props});
  return {...node, text: {...node.text!, characters, runs: []}};
};

function build(recipe: (add: (node: SceneNode, parent: NodeId) => void) => void, pages: NodeId[] = []): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  for (const id of pages) tx.addPage(createNode('PAGE', {id, name: id}));
  recipe((node, parent) => tx.create(node, parent));
  return tx.commit({measurer}).doc;
}

function storeOf(doc: DesignDocument): {store: DesignStore; ctx: CommandContext} {
  const store = createDesignStore({doc, measurer});
  store.setViewport({x: 0, y: 0, zoom: 1});
  return {store, ctx: {store, canvasSize: () => ({width: 1000, height: 800})}};
}

const opts = (partial: Partial<FindOptions> = {}): FindOptions => ({...DEFAULT_FIND_OPTIONS, ...partial});

// ── Comparing ────────────────────────────────────────────────────────────────────────────────────

test('folding keeps offsets: case, ё and non-breaking spaces', () => {
  // Cyrillic on purpose: search folds ё to е and ignores case in Russian words.
  assert.equal(foldForSearch('Ёлка Мир', false), 'елка мир');
  assert.equal(foldForSearch('Ёлка Мир', true), 'Ёлка Мир');
  const odd = 'İstanbul';
  assert.equal(foldForSearch(odd, false).length, odd.length);
});

test('occurrences: left to right, not overlapping, whole words in any script', () => {
// Cyrillic on purpose: whole-word matching works for any script, not only Latin.
  assert.deepEqual(occurrences('аааа', 'аа', false), [0, 2]);
  assert.deepEqual(occurrences('кот котик скот кот', 'кот', false), [0, 4, 11, 15]);
  assert.deepEqual(occurrences('кот котик скот кот', 'кот', true), [0, 15]);
  assert.deepEqual(occurrences('cat_s cat', 'cat', true), [6]);
  assert.deepEqual(occurrences('x', '', false), []);
});

// ── Searching ────────────────────────────────────────────────────────────────────────────────────

function sample(): DesignDocument {
  return build(add => {
    add(createNode('FRAME', {id: 'card', name: 'Card', width: 300, height: 200}), 'page');
    add(textNode('title', 'Hello, sun'), 'card');
    add(textNode('body', 'Sun is up. Sun is big.', {name: 'Details'}), 'card');
    add(createNode('RECTANGLE', {id: 'bg', name: 'Backdrop sun'}), 'page');
    add(textNode('far', 'Second sun'), 'p2');
  }, ['p2']);
}

test('findAll walks the layers panel order: pages in order, top-most first, parents before children', () => {
  const doc = sample();
  const page = findAll(doc, 'sun', opts(), 'page');
  // "Backdrop sun" is above the card on the page, "body" above "title" in the card.
  assert.deepEqual(page.map(match => `${match.id}:${match.field}:${match.start}`), ['bg:name:0', 'body:text:0', 'body:text:11', 'title:text:7']);
  const all = findAll(doc, 'sun', opts({scope: 'all'}), 'page');
  assert.deepEqual(all.at(-1), {id: 'far', pageId: 'p2', field: 'text', start: 7, end: 10});
  assert.deepEqual(findAll(doc, 'sun', opts({names: false}), 'page').map(match => match.id), ['body', 'body', 'title']);
  assert.deepEqual(findAll(doc, 'sun', opts({text: false}), 'page').map(match => match.id), ['bg', 'title']);
  assert.deepEqual(findAll(doc, 'Sun', opts({caseSensitive: true}), 'page').map(match => `${match.id}:${match.start}`), ['body:0', 'body:11']);
  assert.deepEqual(findAll(doc, 'Details', opts(), 'page').map(match => `${match.id}:${match.field}`), ['body:name']);
});

test('a search in slices finds the same as one in a go, and a big file stays sliced', () => {
  const doc = build(add => {
    for (let i = 0; i < 3000; i++) add(textNode(`t${i}`, i % 3 ? `line ${i}` : `Heading ${i}`), 'page');
  });
  const search = new FindSearch(doc, 'heading', opts(), 'page');
  let steps = 0;
  while (!search.step(100)) steps++;
  assert.ok(steps >= 29, 'ran in slices');
  assert.equal(search.matches.length, 1000);
  assert.deepEqual(search.matches, findAll(doc, 'heading', opts(), 'page'));
  const started = performance.now();
  findAll(doc, 'line', opts(), 'page');
  findAll(doc, 'line 2', opts(), 'page');
  assert.ok(performance.now() - started < budget(500), 'fast enough');
});

// ── Replacing ────────────────────────────────────────────────────────────────────────────────────

test('replace all is one undo step, keeps the style of each range and the layer names that follow the words', () => {
  const doc = build(add => {
    const styled = textNode('styled', 'sun and sun', {name: 'Own name'});
    styled.text = {...styled.text!, runs: [{start: 0, end: 3, style: {fontWeight: 700}}]};
    add(styled, 'page');
    add(textNode('auto', 'Sun'), 'page');
    add(textNode('none', 'empty'), 'page');
  });
  const {store} = storeOf(doc);
  let result = {occurrences: 0, layers: 0};
  store.transact('Replace all', tx => {
    result = replaceAllIn(tx, 'page', 'sun', 'moon', opts());
  });
  assert.deepEqual(result, {occurrences: 3, layers: 2});
  const after = store.getState().doc;
  assert.equal(after.nodes.styled.text!.characters, 'moon and moon');
  assert.deepEqual(after.nodes.styled.text!.runs.map(run => [run.start, run.end, run.style.fontWeight]), [[0, 4, 700]]);
  assert.equal(after.nodes.styled.name, 'Own name');
  assert.equal(after.nodes.auto.text!.characters, 'moon');
  assert.equal(after.nodes.auto.name, 'moon');
  assert.equal(store.getState().history.undo, 'Replace all');
  store.undo();
  assert.equal(store.getState().doc.nodes.styled.text!.characters, 'sun and sun');
  assert.equal(store.getState().doc.nodes.auto.text!.characters, 'Sun');
});

function componentDoc(): {doc: DesignDocument; key: string} {
  let doc = build(add => {
    add(createNode('FRAME', {id: 'btn', name: 'Button', width: 120, height: 40}), 'page');
    add(textNode('label', 'Buy'), 'btn');
    add(textNode('note', 'Buy now'), 'btn');
  });
  doc = createComponent(doc, ['btn'], () => 'cmp').doc;
  const componentId = Object.values(doc.nodes).find(node => node.type === 'COMPONENT')!.id;
  const added = addComponentProperty(doc, componentId, {name: 'Label', type: 'TEXT', defaultValue: 'Buy'});
  doc = bindProperty(added.doc, 'label', 'characters', added.key).doc;
  doc = createInstance(doc, componentId, {parentId: 'page', x: 0, y: 200, newId: 'inst'}).doc;
  return {doc, key: added.key};
}

test('a text a component property drives changes the property on its instance, not an override', () => {
  const {doc, key} = componentDoc();
  const copy = Object.values(doc.nodes).find(node => node.mainId === 'label' && node.id.startsWith('inst;'))!;
  const {store} = storeOf(doc);
  const match = findAll(doc, 'buy', opts(), 'page').find(item => item.id === copy.id)!;
  let ok = false;
  store.transact('Replace text', tx => {
    ok = replaceMatch(tx, match, 'buy', 'Order', opts());
  });
  assert.ok(ok);
  const after = store.getState().doc;
  assert.equal(after.nodes.inst.componentProperties?.[key], 'Order');
  assert.equal(after.nodes[copy.id].text!.characters, 'Order');
  assert.ok(!isOverridden(after.nodes[copy.id], 'text.characters'), 'no override of the words');
  // The main keeps its words.
  assert.equal(after.nodes.label.text!.characters, 'Buy');
});

test('replace all: copies that show their main follow it, bound copies change their property once', () => {
  const {doc, key} = componentDoc();
  const noteCopy = Object.values(doc.nodes).find(node => node.mainId === 'note' && node.id.startsWith('inst;'))!;
  const {store} = storeOf(doc);
  store.transact('Replace all', tx => void replaceAllIn(tx, 'page', 'buy', 'Take', opts()));
  const after = store.getState().doc;
  assert.equal(after.nodes.note.text!.characters, 'Take now');
  assert.equal(after.nodes[noteCopy.id].text!.characters, 'Take now', 'the copy followed its main');
  assert.ok(!isOverridden(after.nodes[noteCopy.id], 'text.characters'), 'and stays linked');
  assert.equal(after.nodes.inst.componentProperties?.[key], 'Take');
});

test('a replacement never writes more words than a stored file holds', () => {
  // A short word replaced everywhere by a long one grew a long text past 100 000 characters (or a component
  // property past 10 000): the server refused that autosave patch and every later one with it.
  const doc = build(add => {
    add(textNode('long', 'sun '.repeat(25_000)), 'page');
    add(textNode('short', 'sun'), 'page');
  });
  const {store} = storeOf(doc);
  let result = {occurrences: 0, layers: 0};
  store.transact('Replace all', tx => {
    result = replaceAllIn(tx, 'page', 'sun', 'sunsun', opts());
  });
  assert.deepEqual(result, {occurrences: 1, layers: 1});
  assert.equal(store.getState().doc.nodes.long.text!.characters.length, 100_000);
  assert.equal(store.getState().doc.nodes.short.text!.characters, 'sunsun');
  const {doc: bound, key} = componentDoc();
  const copy = Object.values(bound.nodes).find(node => node.mainId === 'label' && node.id.startsWith('inst;'))!;
  const session = storeOf(bound).store;
  const match = findAll(bound, 'buy', opts(), 'page').find(item => item.id === copy.id)!;
  let ok = true;
  session.transact('Replace text', tx => {
    ok = replaceMatch(tx, match, 'buy', 'x'.repeat(10_001), opts());
  });
  assert.equal(ok, false);
  assert.equal(session.getState().doc.nodes.inst.componentProperties?.[key] ?? 'Buy', 'Buy');
});

test('a stale match is not replaced', () => {
  const doc = build(add => add(textNode('t', 'one two'), 'page'));
  const {store} = storeOf(doc);
  const [match] = findAll(doc, 'two', opts(), 'page');
  store.transact('Edit', tx => tx.update('t', {text: {...doc.nodes.t.text!, characters: 'one three'} as TextProps}));
  let ok = true;
  store.transact('Replace text', tx => {
    ok = replaceMatch(tx, match, 'two', 'five', opts());
  });
  assert.equal(ok, false);
  assert.equal(store.getState().doc.nodes.t.text!.characters, 'one three');
});

test('the session steps from the current page, keeps its place and lands after a replacement', () => {
  const doc = sample();
  const {store} = storeOf(doc);
  store.setPage('p2');
  const landed: string[] = [];
  const session = new FindSession(store, {schedule: work => (work(), () => {}), onLand: match => landed.push(match.id)});
  session.run('sun', opts({scope: 'all'}));
  assert.equal(session.snapshot().total, 5);
  assert.equal(session.go(1)?.id, 'far', 'starts on the page in view');
  assert.equal(session.go(1)?.id, 'bg', 'wraps around');
  store.setPage('page');
  session.go(1);
  session.go(1);
  assert.equal(session.snapshot().current, 2);
  store.transact('Edit', tx => tx.update('bg', {name: 'Backdrop'}));
  session.refresh();
  assert.deepEqual(session.currentMatch(), {id: 'body', pageId: 'page', field: 'text', start: 11, end: 14}, 'the same occurrence after an edit elsewhere');
  const current = session.currentMatch()!;
  store.transact('Replace text', tx => void replaceMatch(tx, current, 'sun', 'edge', opts({scope: 'all'})));
  session.landAt(session.snapshot().current);
  assert.deepEqual(landed, ['title']);
  session.dispose();
});

test('⌘F opens the bar of the file and asks it to focus', () => {
  registerFindCommands();
  const {store, ctx} = storeOf(sample());
  const bar = findBar(store);
  assert.equal(bar.get().open, false);
  getCommand('edit.find')!.run(ctx);
  assert.equal(bar.get().open, true);
  const focus = bar.get().focus;
  getCommand('edit.find')!.run(ctx);
  assert.equal(bar.get().focus, focus + 1);
});

// ── Properties ───────────────────────────────────────────────────────────────────────────────────

function propertiesDoc(): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.setStyle({id: 'S:fill', type: 'FILL', name: 'Accent', description: '', paints: [solid({r: 1, g: 0, b: 0})]});
  tx.setVariableCollection({id: 'c', name: 'Tokens', modes: [{modeId: 'm', name: 'Mode 1'}], defaultModeId: 'm', variableIds: []});
  tx.setVariable({id: 'V:r',name: 'radius', collectionId: 'c', type: 'FLOAT', valuesByMode: {m: 12}, description: ''});
  tx.create(createNode('RECTANGLE', {
    id: 'src', fills: [solid({r: 1, g: 0, b: 0})], fillStyleId: 'S:fill', strokes: [solid({r: 0, g: 0, b: 1})], strokeWeight: 3, strokeAlign: 'OUTSIDE',
    effects: [{type: 'LAYER_BLUR', radius: 4, visible: true}], opacity: 0.5, blendMode: 'MULTIPLY', cornerRadius: 12, rectangleCornerRadii: [1, 2, 3, 4], cornerSmoothing: 0.6,
    boundVariables: {cornerRadius: {type: 'VARIABLE_ALIAS', id: 'V:r'}},
  }), 'page');
  tx.create(createNode('RECTANGLE', {id: 'rect', boundVariables: {width: {type: 'VARIABLE_ALIAS', id: 'V:r'}}}), 'page');
  tx.create(createNode('ELLIPSE', {id: 'oval'}), 'page');
  const heading = textNode('heading', 'Heading');
  heading.text = {...heading.text!, style: {...heading.text!.style, fontSize: 32, fontWeight: 700}, textAlignHorizontal: 'CENTER'};
  tx.create(heading, 'page');
  const body = textNode('body', 'Text with a link');
  body.text = {...body.text!, runs: [{start: 0, end: 5, style: {fontWeight: 300}}, {start: 9, end: 16, style: {hyperlink: {type: 'URL', url: 'https://example.com'}}, fills: [solid({r: 0, g: 1, b: 0})]}]};
  tx.create(body, 'page');
  tx.create(createNode('FRAME', {id: 'frame', layoutGrids: [{pattern: 'GRID', sectionSize: 8, visible: true, color: {r: 1, g: 0, b: 0, a: 0.1}}]}), 'page');
  tx.create(createNode('FRAME', {id: 'frame2'}), 'page');
  return tx.commit({measurer}).doc;
}

test('copy and paste properties: paints, strokes, effects, layer, corners, styles and variable bindings', () => {
  const doc = propertiesDoc();
  const props = copyProperties(doc, 'src')!;
  const {store} = storeOf(doc);
  store.transact('Paste properties', tx => void pasteProperties(tx, ['rect', 'oval'], props));
  const {nodes} = store.getState().doc;
  assert.deepEqual(nodes.rect.fills, doc.nodes.src.fills);
  assert.equal(nodes.rect.fillStyleId, 'S:fill');
  assert.deepEqual(nodes.rect.strokes, doc.nodes.src.strokes);
  assert.equal(nodes.rect.strokeWeight, 3);
  assert.equal(nodes.rect.strokeAlign, 'OUTSIDE');
  assert.deepEqual(nodes.rect.effects, doc.nodes.src.effects);
  assert.equal(nodes.rect.opacity, 0.5);
  assert.equal(nodes.rect.blendMode, 'MULTIPLY');
  assert.equal(nodes.rect.cornerRadius, 12);
  assert.deepEqual(nodes.rect.rectangleCornerRadii, doc.nodes.src.rectangleCornerRadii);
  assert.equal(nodes.rect.cornerSmoothing, 0.6);
  assert.deepEqual(nodes.rect.boundVariables, {width: {type: 'VARIABLE_ALIAS', id: 'V:r'}, cornerRadius: {type: 'VARIABLE_ALIAS', id: 'V:r'}}, 'its own binding stays');
  // An ellipse has no corners: the rest applies.
  assert.equal(nodes.oval.cornerRadius, undefined);
  assert.equal(nodes.oval.opacity, 0.5);
  assert.equal(nodes.oval.boundVariables, undefined);
  assert.equal(store.getState().history.undo, 'Paste properties');
  store.undo();
  assert.equal(store.getState().doc.nodes.rect.opacity, 1);
  assert.equal(store.getState().doc.nodes.oval.opacity, 1);
});

test('the type of a text goes onto texts only; ranges lose their own type and colour but keep links', () => {
  const doc = propertiesDoc();
  const props = copyProperties(doc, 'heading')!;
  assert.equal(props.text?.style.fontSize, 32);
  const patch = propertiesPatch(doc, doc.nodes.body, props)!;
  assert.equal(patch.text!.style.fontSize, 32);
  assert.equal(patch.text!.style.fontWeight, 700);
  assert.equal(patch.text!.textAlignHorizontal, 'CENTER');
  assert.deepEqual(patch.text!.runs.map(run => [run.start, run.end, run.style, run.fills]), [[9, 16, {hyperlink: {type: 'URL', url: 'https://example.com'}}, undefined]]);
  assert.equal(propertiesPatch(doc, doc.nodes.rect, props)?.text, undefined);
  // A frame's layout grids go to frames only; a missing style id is dropped, its values kept.
  const grids = copyProperties(doc, 'frame')!;
  assert.deepEqual(propertiesPatch(doc, doc.nodes.frame2, grids)?.layoutGrids, doc.nodes.frame.layoutGrids);
  assert.equal(propertiesPatch(doc, doc.nodes.rect, grids)?.layoutGrids, undefined);
  const elsewhere = {...copyProperties(doc, 'src')!, fillStyleId: 'S:gone'};
  const out = propertiesPatch(doc, doc.nodes.rect, elsewhere)!;
  assert.equal(out.fillStyleId, undefined);
  assert.deepEqual(out.fills, doc.nodes.src.fills);
  // Nothing to change: null.
  assert.equal(propertiesPatch(doc, doc.nodes.src, copyProperties(doc, 'src')!), null);
});

test('properties pasted on a copy inside an instance are overrides', () => {
  const {doc} = componentDoc();
  const copy = Object.values(doc.nodes).find(node => node.mainId === 'note' && node.id.startsWith('inst;'))!;
  const source = build(add => add(createNode('RECTANGLE', {id: 'r', opacity: 0.3}), 'page'));
  const {store} = storeOf(doc);
  store.transact('Paste properties', tx => void pasteProperties(tx, [copy.id], copyProperties(source, 'r')!));
  assert.ok(isOverridden(store.getState().doc.nodes[copy.id], 'opacity'));
});

test('the property commands: copy needs one layer, paste needs a copy and a selection', () => {
  registerPropertyCommands();
  setCopiedProperties(null);
  const {store, ctx} = storeOf(propertiesDoc());
  const copy = getCommand('edit.copy-properties')!, paste = getCommand('edit.paste-properties')!;
  store.setSelection(['src', 'rect']);
  assert.equal(copy.enabled!(ctx), false);
  store.setSelection(['src']);
  assert.equal(paste.enabled!(ctx), false);
  copy.run(ctx);
  store.setSelection(['rect', 'oval']);
  assert.equal(paste.enabled!(ctx), true);
  paste.run(ctx);
  assert.equal(store.getState().doc.nodes.rect.opacity, 0.5);
  assert.equal(store.getState().doc.nodes.oval.opacity, 0.5);
});

// ── Paste to replace ─────────────────────────────────────────────────────────────────────────────

test('paste to replace: the copy takes each layer\'s place and centre, one undo step', () => {
  const doc = build(add => {
    add(createNode('FRAME', {id: 'f', x: 100, y: 100, width: 400, height: 300}), 'page');
    add(createNode('RECTANGLE', {id: 'a', x: 10, y: 20, width: 40, height: 40}), 'f');
    add(createNode('RECTANGLE', {id: 'b', x: 200, y: 100, width: 100, height: 60}), 'f');
    add(createNode('ELLIPSE', {id: 'c', x: 300, y: 10, width: 20, height: 20}), 'f');
    add(createNode('STAR', {id: 'src', x: 900, y: 900, width: 30, height: 10}), 'page');
  });
  assert.deepEqual(replacementTarget(doc, 'b'), {parentId: 'f', index: 2, centre: {x: 350, y: 230}});
  const payload = buildClipboardPayload(doc, ['src'])!;
  const {store} = storeOf(doc);
  let created: NodeId[] = [];
  let n = 0;
  store.transact('Paste to replace', tx => {
    created = replaceWithPayload(tx, ['a', 'b'], payload, () => `new${++n}`).created;
    return {select: created};
  });
  const after = store.getState().doc;
  assert.equal(after.nodes.a, undefined);
  assert.equal(after.nodes.b, undefined);
  assert.deepEqual(after.nodes.f.children, ['new1', 'new2', 'c'], 'each copy in its layer\'s slot');
  const centre = (id: NodeId) => {
    const box = worldBox(after, id);
    return {x: box.x + box.width / 2, y: box.y + box.height / 2};
  };
  assert.deepEqual(centre('new1'), {x: 130, y: 140});
  assert.deepEqual(centre('new2'), {x: 350, y: 230});
  assert.deepEqual(store.getState().selection, ['new1', 'new2']);
  store.undo();
  assert.deepEqual(store.getState().doc.nodes.f.children, ['a', 'b', 'c']);
});

test('paste to replace inside an auto layout keeps the slot in the flow', () => {
  let doc = build(add => {
    add(createNode('FRAME', {id: 'row', width: 300, height: 50}), 'page');
    add(createNode('RECTANGLE', {id: 'a', width: 40, height: 40}), 'row');
    add(createNode('RECTANGLE', {id: 'b', width: 40, height: 40}), 'row');
    add(createNode('ELLIPSE', {id: 'src', width: 10, height: 10, x: 900}), 'page');
  });
  const tx = beginTransaction(doc);
  tx.update('row', {autoLayout: {...doc.nodes.row.autoLayout!, layoutMode: 'HORIZONTAL', itemSpacing: 10}});
  doc = tx.commit({measurer}).doc;
  const {store} = storeOf(doc);
  store.transact('Paste to replace', t => void replaceWithPayload(t, ['a'], buildClipboardPayload(doc, ['src'])!, () => 'n'));
  const after = store.getState().doc;
  assert.deepEqual(after.nodes.row.children, ['n', 'b']);
  assert.equal(after.nodes.n.x, 0);
  assert.equal(after.nodes.b.x, 20);
});

// ── Rasterize ────────────────────────────────────────────────────────────────────────────────────

test('rasterize: 2× up to the stored size, larger areas refused', () => {
  assert.equal(rasterScale({x: 0, y: 0, width: 300, height: 200}), 2);
  assert.equal(rasterScale({x: 0, y: 0, width: 3000, height: 200}), RASTER_MAX_SIDE / 3000);
  assert.equal(rasterScale({x: 0, y: 0, width: RASTER_MAX_SIDE + 1, height: 10}), null);
  assert.equal(rasterScale({x: 0, y: 0, width: 0, height: 0}), null);
});

test('rasterize: one rectangle with the picture on the same box, where the top layer was; one undo step', () => {
  const doc = build(add => {
    add(createNode('FRAME', {id: 'f', x: 100, y: 50, width: 400, height: 300}), 'page');
    add(createNode('RECTANGLE', {id: 'a', x: 10, y: 10, width: 40, height: 40}), 'f');
    add(createNode('ELLIPSE', {id: 'b', x: 30, y: 30, width: 40, height: 40}), 'f');
    add(createNode('RECTANGLE', {id: 'top', x: 300, y: 10, width: 10, height: 10}), 'f');
    add(createNode('SLICE', {id: 'slice', x: 0, y: 0, width: 10, height: 10}), 'f');
  });
  assert.deepEqual(rasterTargets(doc, ['b', 'slice', 'a']), ['a', 'b']);
  const {store} = storeOf(doc);
  const picture = {ref: 'dz-pic', asset: {url: '/uploads/dz-pic.png', width: 120, height: 120}};
  store.transact('Rasterize', tx => {
    const id = replaceWithPicture(tx, ['a', 'b'], {x: 110, y: 60, width: 60, height: 60}, picture, () => 'img');
    return {select: [id!]};
  });
  const after = store.getState().doc;
  assert.deepEqual(after.nodes.f.children, ['img', 'top', 'slice']);
  assert.deepEqual(worldBox(after, 'img'), {x: 110, y: 60, width: 60, height: 60});
  assert.deepEqual(after.nodes.img.fills, [{type: 'IMAGE', imageRef: 'dz-pic', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]);
  assert.deepEqual(after.images['dz-pic'], picture.asset);
  store.undo();
  assert.deepEqual(store.getState().doc.nodes.f.children, ['a', 'b', 'top', 'slice']);
  assert.equal(store.getState().doc.images['dz-pic'], undefined, 'the picture went with the same step');
});

// ── Links ────────────────────────────────────────────────────────────────────────────────────────

test('a link to a layer names the file and the layer, and is read back only for that file', () => {
  const link = nodeLink({origin: 'https://app.foo.test', pathname: '/'}, 'file 1', 'inst;label');
  assert.equal(link, 'https://app.foo.test/#design/file%201?node=inst%3Blabel');
  const hash = new URL(link).hash;
  assert.equal(linkedNodeId(hash, 'file 1'), 'inst;label');
  assert.equal(linkedNodeId(hash, 'other'), null);
  assert.equal(linkedNodeId('#design/file%201', 'file 1'), null);
  assert.equal(linkedNodeId('#designs', 'file 1'), null);
  assert.equal(linkTarget(sample(), 'page', []), 'page');
  assert.equal(linkTarget(sample(), 'page', ['card', 'title']), 'title');
});

test('opening a link selects the layer on its page with its parent entered, and follows later links', async () => {
  const {store} = storeOf(sample());
  const where = {hash: '#design/f1?node=far'};
  const target = new EventTarget();
  const revealed: NodeId[] = [];
  const toasts: string[] = [];
  const stop = followNodeLinks({store, fileId: 'f1', reveal: id => revealed.push(id), toast: message => toasts.push(message), location: where, target});
  assert.equal(store.getState().pageId, 'p2');
  assert.deepEqual(store.getState().selection, ['far']);
  where.hash = '#design/f1?node=title';
  target.dispatchEvent(new Event('hashchange'));
  assert.equal(store.getState().pageId, 'page');
  assert.deepEqual(store.getState().selection, ['title']);
  assert.equal(store.getState().context, 'card');
  where.hash = '#design/f1?node=gone';
  target.dispatchEvent(new Event('hashchange'));
  assert.equal(toasts.length, 1);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(revealed, ['title']);
  stop();
  assert.ok(selectNode(store, 'p2'));
  assert.equal(store.getState().pageId, 'p2');
  assert.deepEqual(store.getState().selection, []);
});

test('a link to a version opens the history on it, once per link, and only for its file', () => {
  const link = versionLink({origin: 'https://app.foo.test', pathname: '/'}, 'file 1', 'a1b2-c3');
  assert.equal(link, 'https://app.foo.test/#design/file%201?version=a1b2-c3');
  assert.equal(linkedVersionId(new URL(link).hash, 'file 1'), 'a1b2-c3');
  assert.equal(linkedVersionId(new URL(link).hash, 'other'), null);
  assert.equal(linkedVersionId('#design/file%201?node=x', 'file 1'), null);
  assert.equal(linkedNodeId(new URL(link).hash, 'file 1'), null, 'a version link selects no layer');
  const where = {hash: '#design/f1?version=v1'};
  const target = new EventTarget();
  const opened: string[] = [];
  const stop = followVersionLinks({fileId: 'f1', open: id => opened.push(id), location: where, target});
  assert.deepEqual(opened, ['v1']);
  where.hash = '#design/f1?version=v2';
  target.dispatchEvent(new Event('hashchange'));
  where.hash = '#design/f1?node=title';
  target.dispatchEvent(new Event('hashchange'));
  assert.deepEqual(opened, ['v1', 'v2']);
  stop();
  where.hash = '#design/f1?version=v3';
  target.dispatchEvent(new Event('hashchange'));
  assert.deepEqual(opened, ['v1', 'v2']);
});

test('"Copy link to layer" writes the link of the selection', async () => {
  registerLinkCommands();
  const {store, ctx} = storeOf(sample());
  const written: string[] = [];
  const toasts: string[] = [];
  const command = getCommand('edit.copy-link')!;
  assert.equal(command.enabled!(ctx), false, 'only inside an open file');
  const off = connectLinks(store, {fileId: 'f1', toast: message => toasts.push(message)});
  (globalThis as {location?: unknown}).location ??= {origin: 'https://app.test', pathname: '/'};
  store.setSelection(['title']);
  await command.run({...ctx, clipboard: {writeText: text => void written.push(text), readText: async () => null}});
  assert.match(written[0], /#design\/f1\?node=title$/);
  assert.deepEqual(toasts, ['Link to layer copied']);
  off();
});

test('should copy the link to a page from the page\'s menu when the file is open', async () => {
  const {store} = storeOf(sample());
  const pageId = store.getState().doc.pages[0];
  const written: string[] = [];
  const toasts: string[] = [];
  const clipboard = {writeText: (text: string) => void written.push(text), readText: async () => null};
  assert.equal(canCopyLinks(store), false, 'only inside an open file');
  const off = connectLinks(store, {fileId: 'f1', toast: message => toasts.push(message)});
  (globalThis as {location?: unknown}).location ??= {origin: 'https://app.test', pathname: '/'};

  const copied = await copyPageLink(store, pageId, clipboard);

  assert.equal(copied, true);
  assert.equal(written[0], nodeLink(globalThis.location, 'f1', pageId));
  assert.deepEqual(toasts, ['Link to page copied']);
  off();
});

// ── Help ─────────────────────────────────────────────────────────────────────────────────────────

test('support is reached the way the app says, never through an invented contact', () => {
  assert.deepEqual(supportChannel({supportChat: true, supportEmail: 'a@b.ru'}, {}), {kind: 'chat'});
  assert.deepEqual(supportChannel({supportChat: false, supportEmail: 'help@foo.test'}, {}), {kind: 'email', address: 'help@foo.test'});
  assert.deepEqual(supportChannel({supportChat: false, supportEmail: null}, {publicSupportUrl: 'https://t.me/example'}), {kind: 'page', url: 'https://t.me/example'});
  assert.equal(supportChannel({supportChat: false, supportEmail: null}, {publicSupportUrl: 'javascript:alert(1)'}), null);
  assert.equal(supportChannel(null, undefined), null);
});

// ── Registry ─────────────────────────────────────────────────────────────────────────────────────

test('the commands fill their MAIN_MENU ids, and their keys collide with nothing else', () => {
  installEditorCommands();
  registerTextCommands();
  registerLeftPanelCommands();
  registerFileCommands();
  registerExportCommands(() => {});
  registerCodeCommands({fonts: {} as FontRegistry, images: {} as ImageCache, toast: () => {}, openDialog: () => {}});
  registerFindCommands();
  registerPropertyCommands();
  registerPasteReplaceCommands();
  registerRasterizeCommands();
  registerLinkCommands();
  registerHelpCommands();
  const menuIds = new Set<string>();
  const collect = (entries: (typeof MAIN_MENU)[number]['items']) => {
    for (const entry of entries) {
      if (typeof entry === 'object') collect(entry.items);
      else if (entry !== '-') menuIds.add(entry);
    }
  };
  for (const section of MAIN_MENU) collect(section.items);
  const ours = ['edit.find', 'edit.copy-properties', 'edit.paste-properties', 'edit.paste-replace', 'object.rasterize', 'edit.copy-link', 'help.guide', 'help.support'];
  for (const id of ours) {
    assert.ok(menuIds.has(id), `${id} is a menu id`);
    assert.ok(getCommand(id), `${id} is registered`);
  }
  for (const mac of [true, false]) {
    for (const id of ours) {
      const shortcut = getCommand(id)!.shortcut;
      if (!shortcut) continue;
      const event = {code: shortcut.code, shiftKey: !!shortcut.shift, altKey: !!shortcut.alt, metaKey: mac ? !!shortcut.mod : false, ctrlKey: mac ? !!shortcut.ctrl : !!(shortcut.mod || shortcut.ctrl)};
      assert.equal(findByShortcut(event, mac)?.id, id, `${id} owns its key (mac: ${mac})`);
      const sharing = listCommands({includeHidden: true}).filter(other => other.id !== id && [other.shortcut, ...(other.alternates ?? [])].some(key => key && key.code === shortcut.code && !!key.mod === !!shortcut.mod && !!key.shift === !!shortcut.shift && !!key.alt === !!shortcut.alt && !!key.ctrl === !!shortcut.ctrl));
      assert.deepEqual(sharing.map(other => other.id), [], `${id}: nothing else on its key`);
    }
  }
});
