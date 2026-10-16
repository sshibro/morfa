import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps} from '../shared/design/defaults';
import {apply, worldBox, worldMatrix} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import {validatePatch} from '../shared/design/schema';
import type {DesignDocument, NodeId, SceneNode, Vec} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {buildClipboardPayload, choosePasteTarget, parsePayload, pastePayload, serializePayload} from '../src/design/engine/clipboard';
import {copySelection, cutSelection, CORE_COMMANDS, findByShortcut, getCommand, pasteData, registerCoreCommands, runCommand, shortcutMatches, type CommandContext} from '../src/design/engine/commands';
import {formatShortcut, handToDocument, handleKeyDown, isTypingTarget, isUndoKey, keyLabel} from '../src/design/engine/keyboard';
import {createDesignStore, currentViewport, type DesignStore} from '../src/design/engine/store';
import {MoveTool} from '../src/design/engine/tools/move';
import {resizeEdges, resizeSingle, rotateSingle} from '../src/design/engine/tools/transform';
import {NO_SNAP, type ToolContext, type ToolPointerEvent} from '../src/design/engine/tools/types';
import {pageToScreen, screenToPage} from '../src/design/engine/viewport';
import type {OverlayItem} from '../src/design/engine/overlay';
import {opacityForDigit, setOpacityByDigit} from '../src/design/engine/commands/opacity';
import {moveSelectionToPage, moveTargets} from '../src/design/engine/commands/arrange';
import {layerMenuItems} from '../src/design/panels/left/commands';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const close = (a: number, b: number, message?: string) => assert.ok(Math.abs(a - b) < 1e-6, message ?? `${a} ≈ ${b}`);

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

function setup(doc: DesignDocument) {
  registerCoreCommands();
  const store = createDesignStore({doc, measurer});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  return {store, ctx, run: (id: string) => assert.ok(runCommand(id, ctx), `${id} ran`)};
}

function sameWorldBox(a: DesignDocument, b: DesignDocument, id: NodeId) {
  const p = worldBox(a, id), q = worldBox(b, id);
  for (const key of ['x', 'y', 'width', 'height'] as const) close(p[key], q[key], `${id}.${key}: ${p[key]} vs ${q[key]}`);
}

// ── Shortcuts ────────────────────────────────────────────────────────────────────────────────────

const key = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods});

test('shortcuts match physical keys with ⌘ on Mac and Ctrl elsewhere', () => {
  const group = {code: 'KeyG', mod: true};
  assert.ok(shortcutMatches(group, key('KeyG', {metaKey: true}), true));
  assert.ok(!shortcutMatches(group, key('KeyG', {ctrlKey: true}), true), 'Ctrl is not ⌘ on a Mac');
  assert.ok(shortcutMatches(group, key('KeyG', {ctrlKey: true}), false));
  assert.ok(!shortcutMatches(group, key('KeyG', {metaKey: true}), false));
  assert.ok(!shortcutMatches(group, key('KeyG', {metaKey: true, shiftKey: true}), true), 'extra modifiers do not match');
  assert.ok(shortcutMatches({code: 'KeyG', ctrl: true}, key('KeyG', {ctrlKey: true}), true), '⌃ on Mac');
  registerCoreCommands();
  // Cyrillic layout mapping on purpose: on ЙЦУКЕН the G key types «п», but its code stays KeyG.
  assert.equal(findByShortcut({...key('KeyG', {metaKey: true}), key: 'п'} as never, true)?.id, 'group');
  assert.equal(findByShortcut(key('KeyG', {ctrlKey: true, shiftKey: true}), false)?.id, 'ungroup');
  assert.equal(findByShortcut(key('KeyG', {metaKey: true, altKey: true}), true)?.id, 'frame-selection');
  assert.equal(findByShortcut(key('KeyY', {ctrlKey: true}), false)?.id, 'redo');
  assert.equal(findByShortcut(key('Backspace'), true)?.id, 'delete');
  assert.equal(findByShortcut(key('BracketRight', {metaKey: true, altKey: true}), true)?.id, 'bring-to-front');
  assert.equal(findByShortcut(key('Digit2', {shiftKey: true}), true)?.id, 'zoom-selection');
  assert.equal(findByShortcut(key('ArrowLeft', {shiftKey: true}), true)?.id, 'nudge-left-10');
  assert.equal(findByShortcut(key('KeyH'), true)?.id, 'tool-hand');
  assert.equal(findByShortcut(key('KeyH', {shiftKey: true}), true)?.id, 'flip-horizontal');
  assert.equal(findByShortcut(key('KeyH', {shiftKey: true, metaKey: true}), true)?.id, 'toggle-visible');
});

test('no two core commands share a key', () => {
  const seen = new Map<string, string>();
  for (const mac of [true, false]) {
    for (const command of CORE_COMMANDS) {
      for (const shortcut of [command.shortcut, ...(command.alternates ?? [])]) {
        if (!shortcut) continue;
        const id = `${mac}:${formatShortcut(shortcut, mac)}`;
        assert.ok(!seen.has(id) || seen.get(id) === command.id, `${id} is both ${seen.get(id)} and ${command.id}`);
        seen.set(id, command.id);
      }
    }
  }
});

test('shortcuts are written the way each platform writes them', () => {
  assert.equal(formatShortcut({code: 'KeyG', mod: true, shift: true}, true), '⇧⌘G');
  assert.equal(formatShortcut({code: 'BracketRight', mod: true, alt: true}, true), '⌥⌘]');
  assert.equal(formatShortcut({code: 'KeyG', mod: true, shift: true, alt: true}, false), 'Ctrl+Shift+Alt+G');
  assert.equal(formatShortcut({code: 'Digit1', shift: true}, false), 'Shift+1');
  assert.equal(formatShortcut({code: 'KeyG', ctrl: true}, true), '⌃G');
  assert.equal(keyLabel('Backspace', true), '⌫');
  assert.equal(keyLabel('Equal', false), '+');
});

test('keys typed into fields never reach the canvas; handled keys are prevented', () => {
  assert.ok(isTypingTarget({tagName: 'INPUT', type: 'text'} as never));
  assert.ok(!isTypingTarget({tagName: 'INPUT', type: 'checkbox'} as never));
  assert.ok(isTypingTarget({tagName: 'DIV', isContentEditable: true} as never));
  assert.ok(!isTypingTarget(null));
  const doc = build(add => add('RECTANGLE', 'r', 'page'));
  const {store, ctx} = setup(doc);
  store.setSelection(['r']);
  const event = (code: string, mods: object = {}, target: unknown = null) => {
    let prevented = false;
    const e = {...key(code), ...mods, key: '', repeat: false, isComposing: false, defaultPrevented: false, target, preventDefault: () => void (prevented = true)};
    return {e: e as unknown as KeyboardEvent, prevented: () => prevented};
  };
  const typed = event('Delete', {}, {tagName: 'TEXTAREA'});
  assert.ok(!handleKeyDown(typed.e, {context: () => ctx, mac: true}));
  assert.ok(store.getState().doc.nodes.r);
  const del = event('Delete');
  assert.ok(handleKeyDown(del.e, {context: () => ctx, mac: true}));
  assert.ok(del.prevented());
  assert.equal(store.getState().doc.nodes.r, undefined);
  const copy = event('KeyC', {metaKey: true});
  assert.ok(!handleKeyDown(copy.e, {context: () => ctx, mac: true}), 'copy is left to the browser’s copy event');
  const toolFirst = event('Escape');
  assert.ok(handleKeyDown(toolFirst.e, {context: () => ctx, mac: true, before: () => true}));
});

test('⌘Z in a property field with nothing typed undoes the document, as in Figma', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page'));
  const {store, ctx} = setup(doc);
  store.transact('Width', tx => tx.update('r', {width: 300}));
  const press = (mods: object, target: unknown) => {
    let prevented = false;
    const e = {...key('KeyZ'), ...mods, key: 'z', repeat: false, isComposing: false, defaultPrevented: false, target, preventDefault: () => void (prevented = true)} as unknown as KeyboardEvent;
    return {e, prevented: () => prevented};
  };
  const field = {tagName: 'INPUT', type: 'text'};
  // Without the field handing it on, the key stays the field's (its own text undo while typing).
  const typing = press({metaKey: true}, field);
  assert.ok(!handleKeyDown(typing.e, {context: () => ctx, mac: true}));
  assert.equal(store.getState().doc.nodes.r.width, 300);
  // A committed field hands ⌘Z on: the document's step is undone and the browser's own undo prevented.
  const handed = press({metaKey: true}, field);
  assert.ok(isUndoKey(handed.e, true));
  handToDocument(handed.e);
  assert.ok(handleKeyDown(handed.e, {context: () => ctx, mac: true}));
  assert.ok(handed.prevented());
  assert.notEqual(store.getState().doc.nodes.r.width, 300);
  const redo = press({metaKey: true, shiftKey: true}, field);
  handToDocument(redo.e);
  assert.ok(handleKeyDown(redo.e, {context: () => ctx, mac: true}));
  assert.equal(store.getState().doc.nodes.r.width, 300);
  // Only ⌘Z, ⇧⌘Z and ⌘Y are undo keys (Ctrl elsewhere); ⌥⌘Z and a plain Z are not.
  assert.ok(isUndoKey({code: 'KeyY', metaKey: false, ctrlKey: true, altKey: false}, false));
  assert.ok(!isUndoKey({code: 'KeyZ', metaKey: true, ctrlKey: false, altKey: true}, true));
  assert.ok(!isUndoKey({code: 'KeyZ', metaKey: false, ctrlKey: false, altKey: false}, true));
});

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

test('group, frame and ungroup keep every layer where it is', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 100, y: 100, width: 400, height: 400, rotation: 20});
    add('RECTANGLE', 'a', 'f', {x: 10, y: 10, width: 20, height: 20});
    add('RECTANGLE', 'b', 'f', {x: 50, y: 60, width: 10, height: 10, rotation: 30});
    add('RECTANGLE', 'c', 'f', {x: 200, y: 200});
  });
  const {store, run} = setup(doc);
  store.setSelection(['b', 'a']);
  run('group');
  const grouped = store.getState().doc;
  const groupId = store.getState().selection[0];
  const group = grouped.nodes[groupId];
  assert.equal(group.type, 'GROUP');
  assert.equal(group.name, 'Group 1');
  assert.deepEqual(group.children, ['a', 'b']);
  assert.deepEqual(grouped.nodes.f.children, [groupId, 'c'], 'where the top-most layer was');
  for (const id of ['a', 'b']) sameWorldBox(doc, grouped, id);
  close(group.x, 10);
  close(group.y, 10);
  run('ungroup');
  const ungrouped = store.getState().doc;
  assert.deepEqual(ungrouped.nodes.f.children, ['a', 'b', 'c']);
  assert.deepEqual(store.getState().selection, ['a', 'b']);
  for (const id of ['a', 'b']) sameWorldBox(doc, ungrouped, id);
  run('frame-selection');
  const framed = store.getState().doc.nodes[store.getState().selection[0]];
  assert.equal(framed.type, 'FRAME');
  assert.deepEqual(framed.fills, []);
  assert.equal(framed.clipsContent, false);
  store.undo();
  store.undo();
  store.undo();
  assert.deepEqual(store.getState().doc, doc);
});

test('layer order: one step, to the front, to the back, blocks move together', () => {
  const doc = build(add => ['a', 'b', 'c', 'd', 'e'].forEach(id => add('RECTANGLE', id, 'page')));
  const {store, run} = setup(doc);
  const order = () => store.getState().doc.nodes.page.children;
  store.setSelection(['b']);
  run('bring-forward');
  assert.deepEqual(order(), ['a', 'c', 'b', 'd', 'e']);
  run('bring-to-front');
  assert.deepEqual(order(), ['a', 'c', 'd', 'e', 'b']);
  store.setSelection(['d', 'e']);
  run('bring-forward');
  assert.deepEqual(order(), ['a', 'c', 'b', 'd', 'e']);
  run('send-backward');
  assert.deepEqual(order(), ['a', 'c', 'd', 'e', 'b']);
  run('send-to-back');
  assert.deepEqual(order(), ['d', 'e', 'a', 'c', 'b']);
});

test('hide, lock, flip and nudge', () => {
  const doc = build(add => {
    add('RECTANGLE', 'r', 'page', {x: 0, y: 0, width: 100, height: 50});
    add('RECTANGLE', 's', 'page', {x: 200, y: 0, width: 100, height: 50, rotation: 30});
    add('FRAME', 'row', 'page', {x: 0, y: 300, width: 500, height: 100, autoLayout: defaultAutoLayout('HORIZONTAL')});
    add('RECTANGLE', 'p', 'row');
    add('RECTANGLE', 'q', 'row');
  });
  const {store, run, ctx} = setup(doc);
  store.setSelection(['r', 's']);
  run('toggle-visible');
  assert.ok(!store.getState().doc.nodes.r.visible && !store.getState().doc.nodes.s.visible);
  run('toggle-visible');
  assert.ok(store.getState().doc.nodes.r.visible);
  run('toggle-lock');
  assert.ok(store.getState().doc.nodes.s.locked);
  assert.ok(!getCommand('flip-horizontal')!.enabled!(ctx), 'locked layers do not flip');
  run('toggle-lock');
  // Everything read from the document before the flip is read before it: the store may write its table in place.
  const before = store.getState().doc;
  const sBefore = [{x: 0, y: 0}, {x: 100, y: 50}].map(p => apply(worldMatrix(before, 's'), p));
  const bounds = {x: 0, width: worldBox(before, 's').x + worldBox(before, 's').width};
  run('flip-horizontal');
  const after = store.getState().doc;
  assert.ok(after.nodes.r.flipX);
  const mirror = (p: Vec) => ({x: bounds.x + bounds.width - (p.x - bounds.x), y: p.y});
  const sAfter = [{x: 0, y: 0}, {x: 100, y: 50}].map(p => apply(worldMatrix(after, 's'), p));
  sBefore.forEach((p, i) => {
    close(sAfter[i].x, mirror(p).x);
    close(sAfter[i].y, mirror(p).y);
  });
  store.setSelection(['r']);
  const x = store.getState().doc.nodes.r.x;
  for (let i = 0; i < 4; i++) run('nudge-right');
  run('nudge-down-10');
  assert.equal(store.getState().doc.nodes.r.x, x + 4);
  assert.equal(store.getState().doc.nodes.r.y, 10);
  store.undo();
  assert.equal(store.getState().doc.nodes.r.x, x, 'held arrows make one undo step');
  store.setSelection(['p']);
  run('nudge-right');
  assert.deepEqual(store.getState().doc.nodes.row.children, ['q', 'p'], 'in auto layout arrows move along the flow');
});

test('⌘/Ctrl + arrows resize from the right and bottom sides, children by their constraints, one undo step', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 100, height: 50});
    add('RECTANGLE', 'pin', 'f', {x: 60, y: 10, width: 20, height: 20, constraints: {horizontal: 'MAX', vertical: 'MIN'}});
    add('RECTANGLE', 'turned', 'page', {x: 300, y: 0, width: 100, height: 40, rotation: 90});
    add('LINE', 'l', 'page', {x: 0, y: 200, width: 80, height: 0});
    add('TEXT', 't', 'page', {x: 0, y: 300, width: 60, height: 20, text: defaultTextProps('Hello')});
  });
  const {store, run, ctx} = setup(doc);
  for (const [code, id] of [['ArrowRight', 'resize-right'], ['ArrowLeft', 'resize-left'], ['ArrowDown', 'resize-down'], ['ArrowUp', 'resize-up']]) {
    assert.equal(findByShortcut(key(code, {metaKey: true}), true)?.id, id, `⌘${code}`);
    assert.equal(findByShortcut(key(code, {ctrlKey: true}), false)?.id, id, `Ctrl+${code}`);
    assert.equal(findByShortcut(key(code, {ctrlKey: true, shiftKey: true}), false)?.id, `${id}-10`);
  }
  assert.equal(getCommand('resize-right')!.enabled!(ctx), false, 'nothing selected');
  store.setSelection(['f']);
  for (let i = 0; i < 3; i++) run('resize-right');
  run('resize-down-10');
  const f = store.getState().doc.nodes.f;
  assert.deepEqual([f.x, f.y, f.width, f.height], [0, 0, 103, 60]);
  assert.equal(store.getState().doc.nodes.pin.x, 63, 'a layer pinned right follows the right side');
  store.undo();
  assert.equal(store.getState().doc.nodes.f.width, 100, 'held keys make one undo step');
  store.setSelection(['turned']);
  const before = worldBox(store.getState().doc, 'turned');
  run('resize-right-10');
  const turned = store.getState().doc.nodes.turned;
  assert.deepEqual([turned.width, turned.height, turned.rotation], [110, 40, 90], 'a turned layer grows along its own width');
  close(worldBox(store.getState().doc, 'turned').height, before.height + 10);
  store.setSelection(['l']);
  run('resize-down');
  run('resize-right');
  assert.deepEqual([store.getState().doc.nodes.l.width, store.getState().doc.nodes.l.height], [81, 0], 'a line only gets longer');
  store.setSelection(['t']);
  run('resize-left');
  assert.equal(store.getState().doc.nodes.t.text?.textAutoResize, 'HEIGHT', 'an auto-width text gets a fixed width');
  store.setSelection(['f']);
  for (let i = 0; i < 12; i++) run('resize-up-10');
  assert.equal(store.getState().doc.nodes.f.height, 0, 'never past nothing, never flipped');
  assert.ok(!store.getState().doc.nodes.f.flipY);
  store.transact('Proportions', tx => tx.update('turned', {constrainProportions: true}));
  store.setSelection(['turned']);
  run('resize-left-10');
  assert.equal(store.getState().doc.nodes.turned.width, 100);
  close(store.getState().doc.nodes.turned.height, (40 * 100) / 110, '"Constrain proportions" keeps the ratio');
  store.setEditing({kind: 'vector', id: 'l'});
  assert.equal(getCommand('resize-right')!.enabled!(ctx), false, 'the vector editor keeps the arrows');
});

test('"Resize to fit" (⌥⇧⌘R): a frame takes its layers’ bounds, they stay put; auto layout hugs', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 100, y: 100, width: 400, height: 300});
    add('RECTANGLE', 'a', 'f', {x: 50, y: 40, width: 100, height: 60});
    add('RECTANGLE', 'b', 'f', {x: 200, y: 150, width: 120, height: 20});
    add('RECTANGLE', 'out', 'f', {x: -30, y: 250, width: 10, height: 10, visible: false});
    add('FRAME', 'row', 'page', {x: 0, y: 600, width: 500, height: 100, autoLayout: defaultAutoLayout('HORIZONTAL')});
    add('RECTANGLE', 'p', 'row');
    add('RECTANGLE', 'lone', 'page', {x: 0, y: 900});
    add('FRAME', 'empty', 'page', {x: 900, y: 0});
  });
  const {store, run, ctx} = setup(doc);
  assert.equal(findByShortcut(key('KeyR', {metaKey: true, altKey: true, shiftKey: true}), true)?.id, 'object.resize-to-fit');
  store.setSelection(['lone', 'empty']);
  assert.equal(getCommand('object.resize-to-fit')!.enabled!(ctx), false, 'nothing with layers to fit');
  const before = store.getState().doc;
  store.setSelection(['f', 'row']);
  run('object.resize-to-fit');
  const after = store.getState().doc;
  const f = after.nodes.f;
  assert.deepEqual([f.x, f.y, f.width, f.height], [150, 140, 270, 130], 'the visible layers’ bounds');
  for (const id of ['a', 'b']) sameWorldBox(before, after, id);
  assert.deepEqual([after.nodes.row.layoutSizingHorizontal, after.nodes.row.layoutSizingVertical], ['HUG', 'HUG']);
  store.undo();
  assert.equal(store.getState().doc.nodes.f.width, 400, 'one undo step');
});

test('"Move to page": the layers go to the other page where they stood, in one undo step; the menus offer it', () => {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'f', x: 100, y: 100, width: 300, height: 300}), 'page');
  tx.create(createNode('GROUP', {id: 'g', x: 10, y: 10, width: 50, height: 50}), 'f');
  tx.create(createNode('RECTANGLE', {id: 'r', x: 0, y: 0, width: 50, height: 50}), 'g');
  tx.create(createNode('RECTANGLE', {id: 'free', x: 500, y: 0, width: 20, height: 20}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'old', x: 0, y: 0, width: 5, height: 5}), 'page');
  tx.addPage(createNode('PAGE', {id: 'page-2', name: 'Screens'}));
  tx.create(createNode('RECTANGLE', {id: 'there', x: 0, y: 0, width: 5, height: 5}), 'page-2');
  tx.update('page', {flowStartingPoints: [{nodeId: 'f', name: 'Flow 1'}]});
  const {store, ctx} = setup(tx.commit({measurer}).doc);
  store.setSelection(['r', 'free']);
  const menu = layerMenuItems(ctx, {onRename: () => {}});
  const sub = menu.find(item => item.type === 'submenu' && item.id === 'layers.move-to-page');
  assert.ok(sub && sub.type === 'submenu', 'the row and canvas menus offer it');
  assert.deepEqual(sub.items.map(item => (item.type === 'separator' ? '—' : 'label' in item ? item.label : '')), ['Screens']);
  const target = sub.items[0];
  assert.ok('onSelect' in target && target.onSelect);
  target.onSelect();
  let doc = store.getState().doc;
  assert.equal(store.getState().pageId, 'page', 'the page in view stays');
  assert.deepEqual(store.getState().selection, []);
  assert.deepEqual(doc.nodes['page-2'].children, ['there', 'r', 'free'], 'on top of the other page, in paint order');
  assert.deepEqual([doc.nodes.r.x, doc.nodes.r.y], [110, 110], 'where it stood in page coordinates');
  assert.equal(doc.nodes.g, undefined, 'the group it left empty goes');
  store.undo();
  doc = store.getState().doc;
  assert.equal(doc.nodes.r.parentId, 'g');
  assert.deepEqual(store.getState().selection, ['r', 'free'], 'one undo step brings them and the selection back');
  store.setSelection(['f']);
  moveSelectionToPage(ctx, 'page-2');
  doc = store.getState().doc;
  assert.deepEqual(doc.nodes.page.flowStartingPoints, [], 'a flow starting on the moved frame moves with it');
  assert.deepEqual(doc.nodes['page-2'].flowStartingPoints, [{nodeId: 'f', name: 'Flow 1'}]);
  store.setSelection([]);
  assert.deepEqual(moveTargets(ctx), [], 'nothing selected: nothing to offer');
});

test('delete removes groups it empties; duplicate repeats the last offset', () => {
  const doc = build(add => {
    add('GROUP', 'g', 'page');
    add('RECTANGLE', 'only', 'g');
    add('RECTANGLE', 'r', 'page', {x: 10, y: 10});
  });
  const {store, run} = setup(doc);
  store.setSelection(['only']);
  run('delete');
  assert.equal(store.getState().doc.nodes.g, undefined);
  store.setSelection(['r']);
  run('duplicate');
  const [first] = store.getState().selection;
  assert.notEqual(first, 'r');
  assert.equal(store.getState().doc.nodes[first].x, 10);
  assert.deepEqual(store.getState().doc.nodes.page.children!.slice(-2), ['r', first]);
  store.transact('Move', tx => tx.update(first, {x: 40, y: 30}));
  run('duplicate');
  const [second] = store.getState().selection;
  assert.equal(store.getState().doc.nodes[second].x, 70);
  assert.equal(store.getState().doc.nodes[second].y, 50);
});

test('⌘D on frames standing on the canvas puts the copies to their right, past what stands there', () => {
  const doc = build(add => {
    add('FRAME', 'a', 'page', {x: 0, y: 0, width: 300, height: 600});
    add('FRAME', 'b', 'page', {x: 400, y: 100, width: 300, height: 600});
    add('FRAME', 'f', 'page', {x: 0, y: 1000, width: 300, height: 600});
    add('RECTANGLE', 'inner', 'f', {x: 10, y: 10, width: 50, height: 50});
  });
  const {store, run} = setup(doc);
  store.setSelection(['a']);
  run('duplicate');
  const [copy] = store.getState().selection;
  assert.equal(store.getState().doc.nodes[copy].x, 800, 'b stands 100 to the right: the copy goes past it');
  assert.equal(store.getState().doc.nodes[copy].y, 0);
  store.setSelection(['f']);
  run('duplicate');
  const [beside] = store.getState().selection;
  assert.deepEqual([store.getState().doc.nodes[beside].x, store.getState().doc.nodes[beside].y], [400, 1000], '100 to the right of the original');
  // Inside a frame a copy stays on top of its original.
  store.setSelection(['inner']);
  run('duplicate');
  const [inner] = store.getState().selection;
  assert.equal(store.getState().doc.nodes[inner].x, 10);
});

test('selection commands: all, parent, children, next', () => {
  const doc = build(add => {
    add('GROUP', 'g', 'page');
    add('RECTANGLE', 'g1', 'g');
    add('RECTANGLE', 'g2', 'g');
    add('RECTANGLE', 'hidden', 'g', {visible: false});
    add('RECTANGLE', 'r', 'page');
  });
  const {store, run} = setup(doc);
  run('select-all');
  assert.deepEqual(store.getState().selection, ['g', 'r']);
  store.setSelection(['g']);
  run('select-children');
  assert.deepEqual(store.getState().selection, ['g1', 'g2']);
  assert.equal(store.getState().context, 'g');
  run('select-all');
  assert.deepEqual(store.getState().selection, ['g1', 'g2']);
  store.setSelection(['g2']);
  run('select-next');
  assert.deepEqual(store.getState().selection, ['g1']);
  run('select-next');
  assert.deepEqual(store.getState().selection, ['g2'], 'wraps, skipping hidden layers');
  run('select-parent');
  assert.deepEqual(store.getState().selection, ['g']);
});

test('zoom commands', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page', {x: 100, y: 100, width: 50, height: 50}));
  const {store, run} = setup(doc);
  run('zoom-in');
  assert.equal(currentViewport(store.getState()).zoom, 2);
  run('zoom-out');
  run('zoom-out');
  assert.equal(currentViewport(store.getState()).zoom, 0.5);
  run('zoom-100');
  assert.equal(currentViewport(store.getState()).zoom, 1);
  store.setSelection(['r']);
  run('zoom-selection');
  const viewport = currentViewport(store.getState());
  close(viewport.zoom, (800 - 96) / 50);
  const centre = screenToPage(viewport, {x: 500, y: 400});
  close(centre.x, 125);
  close(centre.y, 125);
});

// ── Clipboard ────────────────────────────────────────────────────────────────────────────────────

test('copy and paste: fresh ids, the instance id scheme, styles and pictures come along', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 100, y: 100, width: 200, height: 200});
    add('INSTANCE', 'i', 'f', {x: 10, y: 10, width: 50, height: 50, componentId: 'main'});
    add('RECTANGLE', 'i;m1', 'i', {mainId: 'm1', fillStyleId: 'st', fills: [{type: 'IMAGE', imageRef: 'img', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
    add('INSTANCE', 'i;m2', 'i', {mainId: 'm2', componentId: 'inner'});
    add('RECTANGLE', 'i;m2;m3', 'i;m2', {mainId: 'm3'});
  });
  const withAssets = beginTransaction(doc);
  withAssets.setStyle({id: 'st', type: 'FILL', name: 'Accent', description: '', paints: []});
  withAssets.setImage('img', {url: '/uploads/photo.png', width: 10, height: 10});
  const source = withAssets.commit({measurer}).doc;
  const payload = buildClipboardPayload(source, ['i'])!;
  assert.deepEqual(Object.keys(payload.styles), ['st']);
  assert.deepEqual(Object.keys(payload.images), ['img']);
  const parsed = parsePayload(serializePayload(payload))!;
  const target = createDocument('p');
  const tx = beginTransaction(target);
  let n = 0;
  const [root] = pastePayload(tx, parsed, {parentId: 'p', mode: 'world'}, () => `new${n++}`);
  const pasted = tx.commit({measurer}).doc;
  assert.equal(root, 'new0');
  assert.deepEqual(pasted.nodes.new0.children, ['new0;m1', 'new0;m2']);
  assert.deepEqual(pasted.nodes['new0;m2'].children, ['new0;m2;m3']);
  assert.equal(pasted.nodes['new0;m2;m3'].mainId, 'm3');
  assert.equal(pasted.styles.st.name, 'Accent');
  assert.equal(pasted.images.img.url, '/uploads/photo.png');
  close(pasted.nodes.new0.x, 110, 'the world position is kept on the page');
  // Taken out of its instance, a layer becomes an ordinary one.
  const loose = buildClipboardPayload(source, ['i;m1'])!;
  const tx2 = beginTransaction(target);
  const [alone] = pastePayload(tx2, loose, {parentId: 'p', mode: 'world'}, () => 'alone');
  const aloneDoc = tx2.commit({measurer}).doc;
  assert.equal(alone, 'alone');
  assert.equal(aloneDoc.nodes.alone.mainId, undefined);
});

test('untrusted clipboard text is rebuilt and bounded', () => {
  assert.equal(parsePayload('hello'), null);
  assert.equal(parsePayload('{"morfaDesign":2,"roots":[],"nodes":{}}'), null);
  assert.equal(parsePayload('{"morfaDesign":1,"roots":["a"],"nodes":{"a":{"id":"a","type":"PAGE"}}}'), null);
  const payload = parsePayload(JSON.stringify({
    morfaDesign: 1,
    roots: ['a', 'a', 'cycle'],
    nodes: {
      a: {id: 'a', type: 'FRAME', x: 'evil', width: -5, height: 1e400, children: ['b', 'a', 7], fills: 'red'},
      b: {id: 'b', type: 'RECTANGLE', children: ['a'], parentId: 'zzz', opacity: Number.NaN},
      cycle: {id: 'cycle', type: 'GROUP', children: ['cycle']},
    },
    images: {ok: {url: '/uploads/a.png', width: 1, height: 1}, remote: {url: 'https://evil.example/x.png', width: 1, height: 1}, sneaky: {url: '/uploads/../secret', width: 1, height: 1}},
    styles: {s: {id: 's', type: 'FILL', name: 'x', description: ''}, bad: {id: 'other', type: 'FILL', name: 'y', description: ''}, shapeless: {id: 'shapeless', type: 'FILL', name: 'z'}},
  }))!;
  assert.deepEqual(payload.roots, ['a', 'cycle']);
  assert.equal(payload.nodes.a.x, 0);
  assert.equal(payload.nodes.a.width, 0);
  assert.deepEqual(payload.nodes.a.fills, createNode('FRAME', {id: 'x'}).fills);
  assert.deepEqual(payload.nodes.a.children, ['b']);
  assert.equal(payload.nodes.b.children, undefined, 'leaves hold no children');
  assert.equal(payload.nodes.b.parentId, 'a');
  assert.equal(payload.nodes.b.opacity, 1);
  assert.deepEqual(payload.nodes.cycle.children, []);
  assert.deepEqual(Object.keys(payload.images), ['ok']);
  assert.deepEqual(Object.keys(payload.styles), ['s']);
});

test('a pasted copy holds only what the server stores: a refused field never wedges autosave', () => {
  // Text copied from a web page can be anything. A layer with a javascript: link, a malformed text or a shape the
  // schema refuses used to land in the document, and the server then refused every later autosave patch (the
  // failed patch travels with the next one) until the layer was found and removed.
  const frame = createNode('FRAME', {id: 'f', width: 100, height: 100, children: ['link', 'bad-text', 'ok']});
  const link = {...createNode('RECTANGLE', {id: 'link', parentId: 'f'}), reactions: [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'URL', url: 'javascript:alert(document.cookie)', openInNewTab: false}]}]};
  const badText = {...createNode('TEXT', {id: 'bad-text', parentId: 'f'}), text: {characters: 'x', runs: 'none'}};
  const ok = {...createNode('TEXT', {id: 'ok', parentId: 'f'}), extra: {kept: false}, text: {...defaultTextProps('Hello'), runs: [{start: 0, end: 3, style: {hyperlink: {type: 'URL', url: 'https://foo.test'}}}]}};
  const payload = parsePayload(JSON.stringify({
    morfaDesign: 1,
    roots: ['f', 'evil'],
    nodes: {f: frame, link, 'bad-text': badText, ok, evil: {...createNode('ELLIPSE', {id: 'evil'}), fills: [{type: 'IMAGE', imageRef: 'x', scaleMode: 'FILL', opacity: 7, visible: true, blendMode: 'NORMAL'}]}},
    styles: {s: {id: 's', type: 'TEXT', name: 'x', description: '', text: {fontFamily: 'Inter', hyperlink: {type: 'URL', url: 'javascript:void 0'}}}},
    images: {x: {url: '/uploads/a b.png', width: 1, height: 1}},
  }))!;
  assert.deepEqual(payload.roots, ['f']);
  assert.deepEqual(payload.nodes.f.children, ['ok']);
  assert.deepEqual(Object.keys(payload.nodes).sort(), ['f', 'ok']);
  assert.equal((payload.nodes.ok as unknown as Record<string, unknown>).extra, undefined, 'unknown keys are dropped');
  assert.deepEqual(payload.styles, {});
  assert.deepEqual(payload.images, {});
  const target = createDocument('p');
  const tx = beginTransaction(target);
  pastePayload(tx, payload, {parentId: 'p', mode: 'world'});
  const {patch} = tx.commit({measurer});
  assert.equal(validatePatch(JSON.parse(JSON.stringify(patch))).ok, true, 'the paste saves');
});

test('paste lands in the selected frame, above the selected layer, or in view', () => {
  const doc = build(add => {
    add('FRAME', 'src', 'page', {x: 0, y: 0, width: 300, height: 300});
    add('RECTANGLE', 'r', 'src', {x: 20, y: 30, width: 40, height: 40});
    add('FRAME', 'dst', 'page', {x: 1000, y: 0, width: 300, height: 300});
    add('FRAME', 'tiny', 'page', {x: 2000, y: 0, width: 10, height: 10});
    add('ELLIPSE', 'e', 'page', {x: 500, y: 500});
  });
  const {store, ctx} = setup(doc);
  store.setSelection(['r']);
  assert.ok(copySelection(ctx));
  store.setSelection(['dst']);
  const [inFrame] = pasteData(ctx, {text: null, html: null, files: []}, false)!;
  let state = store.getState().doc;
  assert.equal(state.nodes[inFrame].parentId, 'dst');
  assert.equal(state.nodes[inFrame].x, 20, 'the offset inside the frame is kept');
  store.setSelection(['tiny']);
  const [centred] = pasteData(ctx, {text: null, html: null, files: []}, false)!;
  state = store.getState().doc;
  assert.equal(state.nodes[centred].parentId, 'tiny');
  close(worldBox(state, centred).x + 20, 2005, 'centred in a frame it does not fit');
  store.setSelection(['e']);
  const [above] = pasteData(ctx, {text: null, html: null, files: []}, false)!;
  state = store.getState().doc;
  assert.equal(state.nodes.page.children!.indexOf(above), state.nodes.page.children!.indexOf('e') + 1);
  close(worldBox(state, above).x, 20, 'still on screen: same place');
  store.setSelection([]);
  store.setViewport({x: 5000, y: 5000, zoom: 1});
  const [inView] = pasteData(ctx, {text: null, html: null, files: []}, false)!;
  const box = worldBox(store.getState().doc, inView);
  close(box.x + box.width / 2, 5500);
  close(box.y + box.height / 2, 5400);
  const [inPlace] = pasteData(ctx, {text: null, html: null, files: []}, true)!;
  close(worldBox(store.getState().doc, inPlace).x, 20, 'paste in place keeps the copied position');
  store.setSelection(['src']);
  assert.ok(cutSelection(ctx));
  assert.equal(store.getState().doc.nodes.src, undefined);
  const target = choosePasteTarget(store.getState().doc, 'page', [], buildClipboardPayload(doc, ['src'])!, {center: {x: 0, y: 0}, visible: {x: -10, y: -10, width: 400, height: 400}}, false);
  assert.deepEqual(target, {parentId: 'page', mode: 'world', centre: {x: 0, y: 0}});
});

// ── Transform maths ──────────────────────────────────────────────────────────────────────────────

test('resize edges: free, proportional, from the centre, past the opposite side', () => {
  assert.deepEqual(resizeEdges(100, 50, {hx: 1, hy: 0}, {x: 20, y: 99}), {left: 0, top: 0, right: 120, bottom: 50});
  assert.deepEqual(resizeEdges(100, 50, {hx: -1, hy: -1}, {x: 10, y: 10}, {fromCenter: true}), {left: 10, top: 10, right: 90, bottom: 40});
  assert.deepEqual(resizeEdges(100, 50, {hx: 1, hy: 1}, {x: 100, y: 0}, {keepRatio: true}), {left: 0, top: 0, right: 200, bottom: 100});
  assert.deepEqual(resizeEdges(100, 50, {hx: 1, hy: 0}, {x: 100, y: 0}, {keepRatio: true}), {left: 0, top: -25, right: 200, bottom: 75});
  const flipped = resizeEdges(100, 50, {hx: 1, hy: 0}, {x: -150, y: 0});
  assert.equal(flipped.right, -50);
});

test('a single node resizes in its own turned frame and flips past the opposite side', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page', {x: 100, y: 100, width: 100, height: 50, rotation: 30}));
  const anchor = apply(worldMatrix(doc, 'r'), {x: 0, y: 25});
  const wider = resizeSingle(doc, 'r', {left: 0, top: 0, right: 160, bottom: 50});
  assert.equal(wider.box.width, 160);
  const tx = beginTransaction(doc);
  tx.update('r', {...wider.placement, width: 160});
  const next = tx.commit({measurer}).doc;
  const still = apply(worldMatrix(next, 'r'), {x: 0, y: 25});
  close(still.x, anchor.x);
  close(still.y, anchor.y);
  const flipped = resizeSingle(doc, 'r', {left: 0, top: 0, right: -40, bottom: 50});
  assert.equal(flipped.box.width, 40);
  assert.ok(flipped.placement.flipX);
  close(flipped.placement.rotation, 30);
  const snapped = resizeSingle(build(add => add('RECTANGLE', 's', 'page', {x: 10.4, y: 0, width: 50})), 's', {left: 0, top: 0, right: 59.7, bottom: 100}, {snapToPixel: true});
  assert.deepEqual(snapped.box, {x: 10, y: 0, width: 60, height: 100});
});

test('rotation turns about the centre and snaps to 15° with Shift', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page', {x: 0, y: 0, width: 100, height: 40}));
  const placement = rotateSingle(doc, 'r', (Math.PI / 180) * 40, 15);
  assert.equal(placement.rotation, -45);
  const tx = beginTransaction(doc);
  tx.update('r', placement);
  const centre = apply(worldMatrix(tx.commit({measurer}).doc, 'r'), {x: 50, y: 20});
  close(centre.x, 50);
  close(centre.y, 20);
});

// ── The move tool ────────────────────────────────────────────────────────────────────────────────

function toolHarness(doc: DesignDocument) {
  const {store} = setup(doc);
  const tool = new MoveTool();
  const held = {shift: false, alt: false, mod: false};
  const edits: [NodeId, string | undefined][] = [];
  const ctx: ToolContext = {
    store,
    measurer,
    view: {
      viewport: () => currentViewport(store.getState()),
      size: () => ({width: 1000, height: 800}),
      screenToPage: p => screenToPage(currentViewport(store.getState()), p),
      pageToScreen: p => pageToScreen(currentViewport(store.getState()), p),
      setViewport: v => store.setViewport(v),
      pixel: () => 1 / currentViewport(store.getState()).zoom,
    },
    snap: NO_SNAP,
    index: () => null,
    setCursor: () => {},
    requestOverlay: () => {},
    setOverlayItems: () => {},
    enterEdit: (id, kind) => void edits.push([id, kind]),
    setTool: id => store.setTool(id),
    modifiers: () => ({...held}),
  };
  const ev = (x: number, y: number, mods: Partial<ToolPointerEvent> = {}): ToolPointerEvent => ({
    screen: {x, y}, page: {x, y}, button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false,
    pointerId: 1, pointerType: 'mouse', pressure: 0.5, detail: 1, timeStamp: 0, ...mods,
  });
  const drag = (from: Vec, to: Vec, mods: Partial<ToolPointerEvent> = {}) => {
    tool.onPointerDown(ev(from.x, from.y, mods), ctx);
    for (let i = 1; i <= 4; i++) tool.onPointerMove(ev(from.x + ((to.x - from.x) * i) / 4, from.y + ((to.y - from.y) * i) / 4, mods), ctx);
    tool.onPointerUp(ev(to.x, to.y, {...mods, buttons: 0}), ctx);
  };
  const click = (x: number, y: number, mods: Partial<ToolPointerEvent> = {}) => {
    tool.onPointerDown(ev(x, y, mods), ctx);
    tool.onPointerUp(ev(x, y, {...mods, buttons: 0}), ctx);
  };
  return {store, tool, ctx, ev, drag, click, held, edits};
}

test('move tool: click, Shift-click, drag, axis lock, cancel', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 50, height: 50});
    add('RECTANGLE', 'b', 'page', {x: 100, y: 0, width: 50, height: 50});
  });
  const {store, tool, ctx, ev, drag, click} = toolHarness(doc);
  click(10, 10);
  assert.deepEqual(store.getState().selection, ['a']);
  click(110, 10, {shiftKey: true});
  assert.deepEqual(store.getState().selection, ['a', 'b']);
  click(110, 10, {shiftKey: true});
  assert.deepEqual(store.getState().selection, ['a']);
  drag({x: 10, y: 10}, {x: 40.4, y: 30});
  assert.equal(store.getState().doc.nodes.a.x, 30, 'whole pixels');
  assert.equal(store.getState().doc.nodes.a.y, 20);
  store.undo();
  assert.equal(store.getState().doc.nodes.a.x, 0, 'one undo step');
  drag({x: 10, y: 10}, {x: 60, y: 15}, {shiftKey: true});
  assert.equal(store.getState().doc.nodes.a.y, 0, 'Shift keeps the axis');
  assert.equal(store.getState().doc.nodes.a.x, 50);
  tool.onPointerDown(ev(60, 10), ctx);
  tool.onPointerMove(ev(200, 200), ctx);
  assert.equal(store.getState().doc.nodes.a.x, 190);
  assert.ok(tool.onKeyDown({type: 'keydown', code: 'Escape', key: 'Escape', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, repeat: false}, ctx));
  assert.equal(store.getState().doc.nodes.a.x, 50, 'Esc puts the drag back');
  tool.onPointerUp(ev(200, 200, {buttons: 0}), ctx);
  assert.equal(store.getState().history.undo, 'Move');
});

test('move tool: Alt-drag duplicates, dropping into a frame reparents in place', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 300, y: 0, width: 300, height: 300, rotation: 15});
    add('RECTANGLE', 'r', 'page', {x: 0, y: 0, width: 50, height: 50});
  });
  const {store, drag} = toolHarness(doc);
  drag({x: 10, y: 10}, {x: 30, y: 10}, {altKey: true});
  const [copy] = store.getState().selection;
  assert.notEqual(copy, 'r');
  assert.equal(store.getState().doc.nodes.r.x, 0, 'the original stays');
  assert.equal(store.getState().doc.nodes[copy].x, 20);
  store.undo();
  assert.equal(store.getState().doc.nodes[copy], undefined);
  store.setSelection([]);
  drag({x: 10, y: 10}, {x: 410, y: 110});
  const moved = store.getState().doc;
  assert.equal(moved.nodes.r.parentId, 'f');
  const box = worldBox(moved, 'r');
  const centre = {x: box.x + box.width / 2, y: box.y + box.height / 2};
  close(centre.x, 425, 'the pointer’s offset is kept through the turned frame');
  close(centre.y, 125);
  drag({x: 420, y: 120}, {x: 20, y: 520});
  assert.equal(store.getState().doc.nodes.r.parentId, 'page', 'dragged out onto the canvas');
});

test('move tool: Space held keeps layers out of frames; Control, not ⌘, suspends snapping (Figma)', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 300, y: 0, width: 300, height: 300});
    add('RECTANGLE', 'r', 'page', {x: 0, y: 0, width: 50, height: 50});
    add('RECTANGLE', 'in', 'f', {x: 10, y: 10, width: 50, height: 50});
  });
  const {store, tool, ctx, ev} = toolHarness(doc);
  const space = (type: 'keydown' | 'keyup') => ({type, code: 'Space', key: ' ', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, repeat: false});
  // Space pressed mid-drag: the rectangle crosses the frame and stays on the page; let go, it nests again.
  tool.onPointerDown(ev(10, 10), ctx);
  tool.onPointerMove(ev(200, 50), ctx);
  tool.onPointerMove(ev(400, 100), ctx);
  assert.equal(store.getState().doc.nodes.r.parentId, 'f', 'over the frame it nests');
  assert.equal(tool.onKeyDown(space('keydown'), ctx), true);
  assert.equal(store.getState().doc.nodes.r.parentId, 'page', 'Space keeps it in its parent');
  tool.onPointerMove(ev(420, 110), ctx);
  assert.equal(store.getState().doc.nodes.r.parentId, 'page');
  tool.onPointerUp(ev(420, 110, {buttons: 0}), ctx);
  assert.equal(store.getState().doc.nodes.r.parentId, 'page', 'dropped where it is, not into the frame');
  assert.equal(store.getState().doc.nodes.r.x, 410);
  tool.onKeyUp(space('keyup'), ctx);
  // A layer in a frame dragged out with Space held stays a child of the frame.
  store.setSelection(['in']);
  tool.onPointerDown(ev(320, 20), ctx);
  tool.onPointerMove(ev(300, 60), ctx);
  tool.onKeyDown(space('keydown'), ctx);
  tool.onPointerMove(ev(200, 400), ctx);
  tool.onPointerUp(ev(200, 400, {buttons: 0}), ctx);
  tool.onKeyUp(space('keyup'), ctx);
  assert.equal(store.getState().doc.nodes.in.parentId, 'f');

  // Snapping: a pull of 3 px that ⌘ leaves on and Control turns off.
  const pulls: boolean[] = [];
  (ctx as {snap: ToolContext['snap']}).snap = {...NO_SNAP, snapMove: () => {
    pulls.push(true);
    return {dx: 3, dy: 0, guides: []};
  }};
  // Away from the frame, so the drags stay on the page.
  store.transact('Shift', tx => tx.update('r', {x: 0, y: 400}));
  store.setSelection(['r']);
  const start = 0;
  const move = (mods: Partial<ToolPointerEvent>) => {
    tool.onPointerDown(ev(start + 10, 410, mods), ctx);
    tool.onPointerMove(ev(start + 30, 410, mods), ctx);
    tool.onPointerUp(ev(start + 30, 410, {...mods, buttons: 0}), ctx);
    const x = store.getState().doc.nodes.r.x - start;
    store.undo();
    return x;
  };
  assert.equal(move({mod: true, metaKey: true}), 23, '⌘ (Mac) still snaps');
  assert.equal(move({ctrlKey: true}), 20, 'Control suspends snapping');
  assert.equal(move({}), 23);
});

test('move tool: dragging inside an auto-layout frame reorders the flow', () => {
  const doc = build(add => {
    add('FRAME', 'row', 'page', {x: 0, y: 0, width: 400, height: 100, autoLayout: defaultAutoLayout('HORIZONTAL')});
    add('RECTANGLE', 'p', 'row', {x: 0, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'q', 'row', {x: 100, y: 0, width: 100, height: 100});
    add('RECTANGLE', 's', 'row', {x: 200, y: 0, width: 100, height: 100});
  });
  const {store, drag, click} = toolHarness(doc);
  click(50, 50);
  assert.deepEqual(store.getState().selection, ['p']);
  drag({x: 50, y: 50}, {x: 260, y: 50});
  assert.deepEqual(store.getState().doc.nodes.row.children, ['q', 's', 'p']);
});

test('move tool: over an auto-layout frame the dragged layer follows the pointer and a line shows its slot', () => {
  const doc = build(add => {
    add('FRAME', 'row', 'page', {x: 0, y: 0, width: 400, height: 100, autoLayout: defaultAutoLayout('HORIZONTAL')});
    add('RECTANGLE', 'p', 'row', {x: 0, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'q', 'row', {x: 100, y: 0, width: 100, height: 100});
    add('RECTANGLE', 's', 'row', {x: 200, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'out', 'page', {x: 0, y: 300, width: 50, height: 50});
  });
  const {store, tool, ctx, ev} = toolHarness(doc);
  const items: OverlayItem[][] = [];
  ctx.setOverlayItems = next => void items.push([...next]);
  // From the canvas into the middle of the flow.
  tool.onPointerDown(ev(25, 325), ctx);
  tool.onPointerMove(ev(60, 200), ctx);
  tool.onPointerMove(ev(130, 60), ctx);
  let live = store.getState().doc;
  assert.equal(live.nodes.out.parentId, 'row');
  assert.equal(live.nodes.out.layoutPositioning, 'ABSOLUTE', 'lifted out of the flow while dragged');
  assert.equal(live.nodes.out.x, 105, 'under the pointer, not in a slot');
  assert.equal(live.nodes.out.y, 35);
  assert.deepEqual(live.nodes.row.children, ['p', 'q', 's', 'out'], 'drawn above its siblings');
  // The renderer draws it above everything and unclipped by the (clipping) frame while it moves.
  assert.deepEqual([...tool.lifted() ?? []], ['out']);
  const lifted = tool.lifted();
  tool.onPointerMove(ev(140, 60), ctx);
  assert.equal(tool.lifted(), lifted, 'the same set from frame to frame');
  const marker = items.at(-1)!.find(item => item.kind === 'line');
  assert.ok(marker && marker.kind === 'line' && marker.from.x === 100 && marker.to.x === 100, 'the line stands between the first and the second');
  assert.ok(!items.at(-1)!.some(item => item.kind === 'label'), 'no smart-guide distances inside the flow');
  tool.onPointerUp(ev(140, 60, {buttons: 0}), ctx);
  live = store.getState().doc;
  assert.deepEqual(live.nodes.row.children, ['p', 'out', 'q', 's']);
  assert.equal(tool.lifted(), null, 'nothing is lifted after the drop');
  assert.equal(live.nodes.out.layoutPositioning, 'AUTO', 'the drop puts it into the flow');
  assert.equal(live.nodes.out.x, 100);
  assert.equal(store.getState().history.undo, 'Move');
  store.undo();
  assert.equal(store.getState().doc.nodes.out.parentId, 'page', 'one undo step');
  assert.equal(store.getState().doc.nodes.out.layoutPositioning, 'AUTO');
  // Within the flow: the first one dragged past the last.
  tool.onPointerDown(ev(50, 50), ctx);
  tool.onPointerMove(ev(150, 50), ctx);
  tool.onPointerMove(ev(290, 50), ctx);
  live = store.getState().doc;
  assert.equal(live.nodes.p.x, 240, 'it follows the pointer');
  assert.equal(live.nodes.q.x, 0, 'the others close up behind it');
  const end = items.at(-1)!.find(item => item.kind === 'line');
  const gap = live.nodes.row.autoLayout!.itemSpacing;
  assert.ok(end && end.kind === 'line' && end.from.x === 200 + gap / 2, 'the line follows what is on screen: after the last of them');
  tool.onPointerUp(ev(290, 50, {buttons: 0}), ctx);
  assert.deepEqual(store.getState().doc.nodes.row.children, ['q', 's', 'p']);
  // A hugging row keeps its width while one of its own layers is dragged about in it.
  store.transact('hug', tx => tx.update('row', {layoutSizingHorizontal: 'HUG'}));
  const width = store.getState().doc.nodes.row.width;
  tool.onPointerDown(ev(50, 50), ctx);
  tool.onPointerMove(ev(150, 50), ctx);
  assert.equal(store.getState().doc.nodes.row.width, width);
  tool.onPointerUp(ev(150, 50, {buttons: 0}), ctx);
  assert.equal(store.getState().doc.nodes.row.layoutSizingHorizontal, 'HUG', 'and hugs again after the drop');
});

test('move tool: marquee, frames on the canvas, double click and Esc', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 400, height: 400});
    add('RECTANGLE', 'c1', 'f', {x: 10, y: 10, width: 50, height: 50});
    add('GROUP', 'g', 'f', {x: 300, y: 300, width: 50, height: 50});
    add('RECTANGLE', 'g1', 'g', {x: 0, y: 0, width: 50, height: 50});
    add('TEXT', 't', 'page', {x: 600, y: 0, width: 100, height: 20, text: {...defaultTextProps('Heading'), textAutoResize: 'NONE'}});
    add('RECTANGLE', 'far', 'page', {x: 800, y: 0, width: 50, height: 50});
  });
  const {store, tool, ctx, ev, drag, click, edits} = toolHarness(doc);
  drag({x: 500, y: 500}, {x: 860, y: -10});
  assert.deepEqual(store.getState().selection, ['t', 'far'], 'marquee from the empty canvas');
  drag({x: 200, y: 200}, {x: 390, y: 390});
  assert.deepEqual(store.getState().selection, ['g'], 'dragging a frame’s empty area selects among its layers');
  assert.equal(store.getState().doc.nodes.f.x, 0, 'and does not move the frame');
  click(200, 200);
  assert.deepEqual(store.getState().selection, ['f'], 'a click on the empty area selects the frame');
  click(320, 320);
  assert.deepEqual(store.getState().selection, ['g']);
  tool.onDoubleClick(ev(320, 320), ctx);
  assert.equal(store.getState().context, 'g');
  assert.deepEqual(store.getState().selection, ['g1']);
  const esc = {type: 'keydown' as const, code: 'Escape', key: 'Escape', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, repeat: false};
  tool.onKeyDown(esc, ctx);
  assert.deepEqual(store.getState().selection, ['g']);
  tool.onKeyDown(esc, ctx);
  assert.deepEqual(store.getState().selection, ['f']);
  tool.onKeyDown(esc, ctx);
  assert.deepEqual(store.getState().selection, []);
  click(610, 10);
  tool.onDoubleClick(ev(610, 10), ctx);
  assert.deepEqual(edits, [['t', 'text']]);
  click(20, 20, {mod: true, metaKey: true});
  assert.deepEqual(store.getState().selection, ['c1']);
});

test('move tool: Shift-dragging a frame’s empty area adds what the marquee touches; a Shift-click adds the frame', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 400, height: 400});
    add('RECTANGLE', 'c1', 'f', {x: 10, y: 10, width: 50, height: 50});
    add('RECTANGLE', 'c2', 'f', {x: 300, y: 300, width: 50, height: 50});
    add('RECTANGLE', 'far', 'page', {x: 800, y: 0, width: 50, height: 50});
  });
  const {store, drag, click} = toolHarness(doc);
  click(810, 10);
  drag({x: 200, y: 200}, {x: 390, y: 390}, {shiftKey: true});
  assert.deepEqual(store.getState().selection, ['far', 'c2'], 'the marquee adds the layer it touches');
  assert.equal(store.getState().doc.nodes.f.x, 0, 'nothing moved');
  assert.equal(store.getState().doc.nodes.far.x, 800, 'nothing moved');
  assert.equal(store.getState().history.undo, null, 'no undo step');
  click(810, 10);
  click(200, 200, {shiftKey: true});
  assert.deepEqual(store.getState().selection, ['far', 'f'], 'a Shift-click adds the frame');
  drag({x: 200, y: 200}, {x: 200, y: 260}, {shiftKey: true});
  assert.equal(store.getState().doc.nodes.f.y, 60, 'once selected, a Shift-drag moves it');
});

test('move tool in Dev Mode (ui.devMode): a click and the hover reach the deepest layer, a drag only selects, no editor opens', () => {
  const doc = build(add => {
    add('FRAME', 'screen', 'page', {x: 0, y: 0, width: 400, height: 400});
    add('FRAME', 'card', 'screen', {x: 20, y: 20, width: 300, height: 100});
    add('TEXT', 'title', 'card', {x: 10, y: 10, width: 100, height: 20, text: {...defaultTextProps('Heading'), textAutoResize: 'NONE'}});
    add('GROUP', 'icon', 'card', {x: 200, y: 10, width: 20, height: 20});
    add('RECTANGLE', 'dot', 'icon', {x: 0, y: 0, width: 20, height: 20});
    add('RECTANGLE', 'far', 'page', {x: 800, y: 0, width: 50, height: 50});
  });
  const {store, tool, ctx, ev, drag, click, edits} = toolHarness(doc);
  store.setUI({devMode: true});
  tool.onPointerMove(ev(40, 40, {buttons: 0}), ctx);
  assert.equal(store.getState().hoverId, 'title', 'the hover lights what a click selects');
  click(40, 40);
  assert.deepEqual(store.getState().selection, ['title'], 'one click reaches a text two frames deep');
  click(225, 35);
  assert.deepEqual(store.getState().selection, ['dot'], 'and a shape inside a group');
  assert.equal(store.getState().context, null, 'no frame is entered');
  click(810, 10, {shiftKey: true});
  assert.deepEqual(store.getState().selection, ['dot', 'far'], 'Shift adds');

  // Drags from a layer, a selected one included, draw a marquee; from a frame's empty area (a nested one's too), over its layers.
  click(40, 40);
  drag({x: 40, y: 40}, {x: 830, y: 30});
  assert.deepEqual(store.getState().selection, ['card', 'far'], 'the marquee from the canvas, as in Design');
  drag({x: 300, y: 100}, {x: 35, y: 35});
  assert.deepEqual(store.getState().selection, ['title', 'icon'], 'the marquee among the card’s layers');
  const nodes = store.getState().doc.nodes;
  assert.deepEqual([nodes.title.x, nodes.screen.x, nodes.card.y], [10, 0, 20], 'nothing moved');
  assert.equal(store.getState().history.undo, null, 'no undo step');

  // A double click and Enter open no editor.
  click(40, 40);
  tool.onDoubleClick(ev(40, 40, {detail: 2}), ctx);
  runCommand('select-children', {store, canvasSize: () => ({width: 1000, height: 800}), enterEdit: (id, kind) => void edits.push([id, kind])});
  assert.deepEqual(edits, []);
  assert.deepEqual([store.getState().editing, store.getState().context], [null, null]);

  // Design again: Figma's rules, the card is picked whole and a drag moves it.
  store.setUI({devMode: false});
  click(40, 40);
  assert.deepEqual(store.getState().selection, ['card']);
  tool.onDoubleClick(ev(40, 40, {detail: 2}), ctx);
  tool.onDoubleClick(ev(40, 40, {detail: 2}), ctx);
  assert.deepEqual(edits, [['title', 'text']]);
});

test('move tool: the radius handles inside the corners round every corner, with Alt only theirs; one undo step', () => {
  const doc = build(add => {
    add('RECTANGLE', 'r', 'page', {x: 0, y: 0, width: 200, height: 100});
    add('RECTANGLE', 'small', 'page', {x: 300, y: 0, width: 40, height: 40});
    add('ELLIPSE', 'o', 'page', {x: 0, y: 300, width: 100, height: 100});
  });
  const {store, drag, click, tool, ctx, ev} = toolHarness(doc);
  click(100, 50);
  // A handle stands 12 px in from each corner while the radius is smaller.
  drag({x: 12, y: 12}, {x: 32, y: 32});
  let node = store.getState().doc.nodes.r;
  assert.deepEqual([node.cornerRadius, node.rectangleCornerRadii ?? null, node.x, node.y, node.width], [20, null, 0, 0, 200], 'the travel along the diagonal is the radius; nothing moves');
  // Now it stands at the radius: Alt takes only its corner.
  drag({x: 180, y: 80}, {x: 170, y: 70}, {altKey: true});
  node = store.getState().doc.nodes.r;
  assert.deepEqual(node.rectangleCornerRadii, [20, 20, 30, 20]);
  drag({x: 20, y: 20}, {x: 200, y: 200});
  assert.equal(store.getState().doc.nodes.r.cornerRadius, 50, 'never past half the shorter side');
  assert.equal(store.getState().doc.nodes.r.rectangleCornerRadii ?? null, null, 'without Alt every corner takes it');
  store.undo();
  assert.deepEqual(store.getState().doc.nodes.r.rectangleCornerRadii, [20, 20, 30, 20], 'one undo step per drag');
  // A press on a handle without a drag changes nothing; the cursor over it is the plain arrow.
  const before = store.getState().doc;
  tool.onPointerDown(ev(20, 20), ctx);
  tool.onPointerUp(ev(20, 20, {buttons: 0}), ctx);
  assert.equal(store.getState().doc, before);
  // Too small on screen, or not a rectangle or frame: no radius handles, a press there moves the layer.
  click(320, 20);
  drag({x: 312, y: 12}, {x: 322, y: 22});
  assert.deepEqual([store.getState().doc.nodes.small.x, store.getState().doc.nodes.small.cornerRadius ?? 0], [310, 0]);
  click(50, 350);
  drag({x: 12, y: 312}, {x: 32, y: 332});
  assert.equal(store.getState().doc.nodes.o.x, 20);
});

test('move tool: handles resize, flip, rotate and move line ends', () => {
  const doc = build(add => {
    add('RECTANGLE', 'r', 'page', {x: 100, y: 100, width: 100, height: 50});
    add('LINE', 'l', 'page', {x: 0, y: 400, width: 100, height: 0});
  });
  const {store, drag, click} = toolHarness(doc);
  click(150, 125);
  drag({x: 200, y: 125}, {x: 250, y: 140});
  let r = store.getState().doc.nodes.r;
  assert.deepEqual([r.x, r.y, r.width, r.height], [100, 100, 150, 50], 'the right edge only widens');
  drag({x: 250, y: 125}, {x: 50, y: 125});
  r = store.getState().doc.nodes.r;
  assert.deepEqual([r.x, r.width, !!r.flipX], [50, 50, true], 'past the opposite side it flips');
  store.undo();
  drag({x: 255, y: 92}, {x: 300, y: 200}, {shiftKey: true});
  r = store.getState().doc.nodes.r;
  assert.equal(Math.abs(r.rotation % 15), 0, 'Shift turns in 15° steps');
  assert.notEqual(r.rotation, 0);
  const centre = apply(worldMatrix(store.getState().doc, 'r'), {x: r.width / 2, y: r.height / 2});
  close(centre.x, 175);
  close(centre.y, 125);
  click(50, 400);
  assert.deepEqual(store.getState().selection, ['l']);
  drag({x: 100, y: 400}, {x: 100, y: 500});
  const line = store.getState().doc.nodes.l;
  close(line.width, Math.hypot(100, 100));
  close(line.rotation, -45);
  close(line.x, 0);
  close(line.y, 400);
});

test('move tool: several layers scale as one box and turn about its centre', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 50, height: 50});
    add('RECTANGLE', 'b', 'page', {x: 150, y: 50, width: 50, height: 50, rotation: 90});
  });
  const {store, drag, click} = toolHarness(doc);
  click(25, 25);
  click(175, 25, {shiftKey: true});
  assert.deepEqual(store.getState().selection, ['a', 'b']);
  // b turns about its corner, so it covers 150..200 × 0..50 and the union is 0..200 × 0..50.
  const before = worldBox(store.getState().doc, 'b');
  close(before.y, 0);
  drag({x: 200, y: 25}, {x: 400, y: 25});
  const scaled = store.getState().doc;
  const a = worldBox(scaled, 'a'), b = worldBox(scaled, 'b');
  close(a.x, 0);
  close(a.width, 100);
  close(a.height, 50);
  close(b.x, before.x * 2);
  close(b.width, before.width * 2, 'a turned layer stretches along the page axis too');
  close(b.height, before.height);
  assert.equal(scaled.nodes.b.rotation, 90);
  store.undo();
  // A quarter turn about the union's centre (100, 25), grabbed outside the top-right corner.
  drag({x: 210, y: -10}, {x: 125, y: 140}, {shiftKey: true});
  const turned = store.getState().doc;
  const centre = (id: NodeId) => {
    const box = worldBox(turned, id);
    return {x: box.x + box.width / 2, y: box.y + box.height / 2};
  };
  const pivot = {x: 100, y: 25};
  const distance = (p: Vec) => Math.hypot(p.x - pivot.x, p.y - pivot.y);
  close(distance(centre('a')), 75, 'layers keep their distance to the pivot');
  assert.equal(Math.abs(turned.nodes.a.rotation % 15), 0);
  assert.notEqual(turned.nodes.a.rotation, 0);
});

test('move tool: Alt pressed and released during a drag switches between copying and moving', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page', {x: 0, y: 0, width: 50, height: 50}));
  const {store, tool, ctx, ev, held} = toolHarness(doc);
  const altKey = (type: 'keydown' | 'keyup') => ({type, code: 'AltLeft', key: 'Alt', shiftKey: false, altKey: type === 'keydown', metaKey: false, ctrlKey: false, mod: false, repeat: false});
  tool.onPointerDown(ev(10, 10), ctx);
  tool.onPointerMove(ev(40, 10), ctx);
  assert.equal(store.getState().doc.nodes.r.x, 30);
  held.alt = true;
  tool.onKeyDown(altKey('keydown'), ctx);
  const [copy] = store.getState().selection;
  assert.notEqual(copy, 'r');
  assert.equal(store.getState().doc.nodes.r.x, 0, 'with Alt the original goes back');
  assert.equal(store.getState().doc.nodes[copy].x, 30);
  tool.onPointerMove(ev(60, 10, {altKey: true}), ctx);
  assert.deepEqual(store.getState().selection, [copy], 'the copy keeps its id while the drag goes on');
  held.alt = false;
  tool.onKeyUp(altKey('keyup'), ctx);
  assert.equal(store.getState().doc.nodes[copy], undefined);
  assert.equal(store.getState().doc.nodes.r.x, 50);
  assert.deepEqual(store.getState().selection, ['r']);
  tool.onPointerUp(ev(60, 10, {buttons: 0}), ctx);
  store.undo();
  assert.equal(store.getState().doc.nodes.r.x, 0);
  assert.ok(!store.canUndo());
});

// ── Opacity from the number keys ─────────────────────────────────────────────────────────────────

test('number keys set the opacity of the selection: 1…9 → 10…90 %, 0 → 100 %, two quick digits exactly', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 50, height: 50});
    add('RECTANGLE', 'b', 'page', {x: 100, y: 0, width: 50, height: 50});
    add('RECTANGLE', 'c', 'page', {x: 200, y: 0, width: 50, height: 50, locked: true});
  });
  const {store, ctx} = setup(doc);
  assert.equal(findByShortcut(key('Digit5'), false)?.id, 'opacity-5');
  assert.equal(findByShortcut(key('Numpad5'), true)?.id, 'opacity-5');
  assert.ok(!getCommand('opacity-5')!.enabled!(ctx), 'nothing selected: the key does nothing');
  assert.deepEqual(opacityForDigit(5, null, 0), {value: 0.5, pair: false});
  assert.deepEqual(opacityForDigit(0, null, 0), {value: 1, pair: false});
  assert.deepEqual(opacityForDigit(5, {digit: 5, time: 0}, 300), {value: 0.55, pair: true});
  assert.deepEqual(opacityForDigit(0, {digit: 0, time: 0}, 300), {value: 0, pair: true});
  assert.deepEqual(opacityForDigit(5, {digit: 0, time: 0}, 300), {value: 0.05, pair: true});
  assert.deepEqual(opacityForDigit(3, {digit: 5, time: 0}, 5000), {value: 0.3, pair: false}, 'too late for a pair');
  store.setSelection(['a', 'b', 'c']);
  setOpacityByDigit(ctx, 3, 10_000);
  assert.equal(store.getState().doc.nodes.a.opacity, 0.3);
  assert.equal(store.getState().doc.nodes.b.opacity, 0.3);
  assert.equal(store.getState().doc.nodes.c.opacity, 1, 'locked layers are left alone');
  setOpacityByDigit(ctx, 5, 10_200);
  assert.equal(store.getState().doc.nodes.a.opacity, 0.35, '«3», «5» → 35 %');
  store.undo();
  assert.equal(store.getState().doc.nodes.a.opacity, 1, 'both presses are one undo step');
});

test('move tool: resizing a frame moves its layers by their constraints; with ⌘/Ctrl they stay put', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 200, height: 100});
    add('RECTANGLE', 'r', 'f', {x: 150, y: 50, width: 40, height: 40, constraints: {horizontal: 'MAX', vertical: 'MAX'}});
  });
  const {store, drag} = toolHarness(doc);
  store.setSelection(['f']);
  drag({x: 200, y: 100}, {x: 250, y: 130});
  let live = store.getState().doc;
  assert.equal(live.nodes.f.width, 250);
  assert.equal(live.nodes.r.x, 200, 'pinned to the right: follows the corner');
  assert.equal(live.nodes.r.y, 80);
  store.undo();
  drag({x: 200, y: 100}, {x: 250, y: 130}, {mod: true});
  live = store.getState().doc;
  assert.equal(live.nodes.f.width, 250);
  assert.equal(live.nodes.r.x, 150, '⌘: the layer stays where it was');
  store.undo();
  // From the top-left corner the frame's origin moves: its layers keep their place on the page.
  drag({x: 0, y: 0}, {x: -30, y: -20}, {mod: true});
  live = store.getState().doc;
  assert.equal(live.nodes.f.x, -30);
  assert.equal(live.nodes.r.x, 180, 'shifted inside the frame by what the frame moved');
  assert.deepEqual(worldBox(live, 'r'), worldBox(doc, 'r'));
});

test('N and ⇧N go through the page’s frames in reading order, selecting and fitting each', () => {
  const doc = build(add => {
    add('FRAME', 'b', 'page', {x: 500, y: 10, width: 300, height: 600});
    add('FRAME', 'a', 'page', {x: 0, y: 0, width: 300, height: 600});
    add('FRAME', 'c', 'page', {x: 0, y: 900, width: 300, height: 600});
    add('RECTANGLE', 'inside', 'b', {x: 10, y: 10, width: 20, height: 20});
    add('RECTANGLE', 'loose', 'page', {x: 2000, y: 0, width: 20, height: 20});
  });
  const {store, ctx} = setup(doc);
  assert.equal(findByShortcut(key('KeyN'), false)?.id, 'view.next-frame');
  assert.equal(findByShortcut(key('KeyN', {shiftKey: true}), false)?.id, 'view.previous-frame');
  const next = () => runCommand('view.next-frame', ctx), previous = () => runCommand('view.previous-frame', ctx);
  next();
  assert.deepEqual(store.getState().selection, ['a'], 'nothing selected: the first frame');
  const viewport = currentViewport(store.getState());
  close(viewport.x + 1000 / 2 / viewport.zoom, 150, 'centred on it');
  next();
  assert.deepEqual(store.getState().selection, ['b'], 'the same row first (b sits 10 px lower)');
  next();
  assert.deepEqual(store.getState().selection, ['c']);
  next();
  assert.deepEqual(store.getState().selection, ['a'], 'round again');
  previous();
  assert.deepEqual(store.getState().selection, ['c']);
  store.setSelection(['inside']);
  next();
  assert.deepEqual(store.getState().selection, ['c'], 'from the frame the selection is in');
});

test('⇧X swaps fill and stroke, styles included, in one undo step', () => {
  const red = {type: 'SOLID' as const, color: {r: 1, g: 0, b: 0}, opacity: 1, visible: true, blendMode: 'NORMAL' as const};
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 50, height: 50, fills: [red], strokes: [], strokeWeight: 0, fillStyleId: 'S'});
    add('RECTANGLE', 'locked', 'page', {x: 100, y: 0, width: 50, height: 50, locked: true});
  });
  const {store, ctx, run} = setup(doc);
  assert.equal(findByShortcut(key('KeyX', {shiftKey: true}), false)?.id, 'object.swap-fill-stroke');
  assert.ok(!getCommand('object.swap-fill-stroke')!.enabled!(ctx));
  store.setSelection(['a', 'locked']);
  run('object.swap-fill-stroke');
  const a = store.getState().doc.nodes.a;
  assert.deepEqual(a.fills, []);
  assert.deepEqual(a.strokes, [red]);
  assert.equal(a.strokeStyleId, 'S');
  assert.equal(a.fillStyleId, undefined);
  assert.equal(a.strokeWeight, 1, 'an outline you can see');
  assert.deepEqual(store.getState().doc.nodes.locked.strokes, doc.nodes.locked.strokes, 'locked layers are left alone');
  store.undo();
  assert.deepEqual(store.getState().doc.nodes.a.fills, [red]);
});
