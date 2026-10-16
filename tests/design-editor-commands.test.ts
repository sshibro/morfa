// These tests assume a host that is not a Mac (their shortcut cases say so): pin it before any design module loads.
import './helpers/linux-platform';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {worldBox} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {buildClipboardPayload, serializePayload} from '../src/design/engine/clipboard';
import {findByShortcut, getCommand, listCommands, registerCommand, runCommand, type CommandContext, type Shortcut} from '../src/design/engine/commands';
import {handleKeyDown, pressesFocusedControl} from '../src/design/engine/keyboard';
import {createDesignStore} from '../src/design/engine/store';
import {registerTool} from '../src/design/engine/tools';
import {buildMainMenu} from '../src/design/editor/chrome/commands';
import {TOOLS, type ToolId} from '../src/design/editor/chrome/tools';
import {
  bindCommandHost, chromeToolOf, createCommandLookup, EDITOR_COMMAND_IDS, EDITOR_MENU, installEditorCommands, inverseSelection, layersAt, matchingSelection, MENU_ALIASES,
  menuCoverage, paletteEntries, pasteAt, resolveCommand, searchPalette, shortcutFrom, shortcutString, type EditorCommandHost,
} from '../src/design/editor/command-bridge';
import {getPreferences, resetPreferencesCache, setPreferences} from '../src/design/editor/preferences';
import {registerTextCommands} from '../src/design/engine/commands/text';
import {registerFileCommands} from '../src/design/engine/commands/file';
import {registerLeftPanelCommands} from '../src/design/panels/left/commands';
import {registerCodeCommands} from '../src/design/engine/commands/code';
import {registerExportCommands} from '../src/design/engine/commands/export';
import type {FontRegistry, ImageCache} from '../src/design/engine/contracts';
import {groupRows, shortcutRows} from '../src/design/editor/ShortcutsDialog';

// src/design/editor/command-bridge.ts: the main menu's ids meet the engine's registry, the editor's own
// commands (view toggles, selection, rotation, pages, tools), shortcuts that never collide, quick
// actions search, "Select layer" and "Paste here".

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const close = (a: number, b: number, message?: string) => assert.ok(Math.abs(a - b) < 1e-6, message ?? `${a} ≈ ${b}`);

installEditorCommands();
// Every feature's keys take part in the collision check below.
registerTextCommands();
registerLeftPanelCommands();
registerFileCommands();
registerExportCommands(() => {});
registerCodeCommands({fonts: {} as FontRegistry, images: {} as ImageCache, toast: () => {}, openDialog: () => {}});

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void, pages: NodeId[] = []): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  for (const id of pages) tx.addPage(createNode('PAGE', {id, name: id}));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

function setup(doc: DesignDocument) {
  const store = createDesignStore({doc, measurer});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  return {store, ctx, run: (id: string) => assert.ok(runCommand(resolveCommand(id)?.id ?? id, ctx), `${id} ran`)};
}

const key = (shortcut: Shortcut, mac: boolean) => ({
  code: shortcut.code,
  shiftKey: !!shortcut.shift,
  altKey: !!shortcut.alt,
  metaKey: mac ? !!shortcut.mod : false,
  ctrlKey: mac ? !!shortcut.ctrl : !!(shortcut.mod || shortcut.ctrl),
});

// ── Menu ↔ registry ──────────────────────────────────────────────────────────────────────────────

test('every alias points at a registered engine command and the menu shows only what is registered', () => {
  for (const [menuId, engineId] of Object.entries(MENU_ALIASES)) assert.ok(getCommand(engineId), `${menuId} → ${engineId}`);
  const {wired, waiting} = menuCoverage();
  for (const id of ['edit.undo', 'edit.redo', 'object.group', 'view.outlines', 'view.zoom-fit', 'file.rename', 'help.shortcuts', 'edit.select-matching', 'file.export', 'file.export-react', 'edit.copy-css', 'edit.copy-png']) assert.ok(wired.includes(id), id);
  for (const id of ['edit.find', 'help.guide']) assert.ok(waiting.includes(id), `${id} waits for its feature`);
  const {ctx} = setup(build(() => {}));
  const lookup = createCommandLookup(() => ctx);
  const menu = buildMainMenu(EDITOR_MENU, lookup, {onBackToFiles: () => {}});
  const ids = JSON.stringify(menu);
  assert.ok(ids.includes('"edit.undo"') && !ids.includes('edit.find'), 'unregistered ids are left out');
  assert.ok(ids.includes('"menu:preferences"'), 'the editor adds "Preferences"');
  // A feature registering a menu id is found as itself, before any alias.
  assert.equal(lookup('edit.undo')?.label, 'Undo');
  assert.equal(lookup('edit.undo')?.shortcut, 'Mod+KeyZ');
});

test('a key two commands share goes to the one that can run on the selection', () => {
  const ran: string[] = [];
  const press = {code: 'F13', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false};
  const offA = registerCommand({id: 'zz.first', label: 'A', shortcut: {code: 'F13'}, enabled: () => false, run: () => void ran.push('a')});
  const offB = registerCommand({id: 'zz.second', label: 'B', shortcut: {code: 'F13'}, run: () => void ran.push('b')});
  try {
    assert.equal(findByShortcut(press, false)?.id, 'zz.first', 'without a preference the first registered');
    assert.equal(findByShortcut(press, false, command => command.id !== 'zz.first')?.id, 'zz.second');
    const {ctx} = setup(build(() => {}));
    const event = {...press, key: 'F13', repeat: false, isComposing: false, defaultPrevented: false, target: null, preventDefault() {}} as unknown as KeyboardEvent;
    assert.equal(handleKeyDown(event, {context: () => ctx, mac: false}), true);
    assert.deepEqual(ran, ['b']);
  } finally {
    offA();
    offB();
  }
});

test('Enter presses a control the keyboard focused, not the canvas command; a clicked one leaves it to the canvas', () => {
  const control = (tagName: string, keyboard: boolean, extra: Record<string, unknown> = {}) =>
    ({tagName, type: extra.type, matches: (selector: string) => keyboard && selector === ':focus-visible', hasAttribute: () => !!extra.href, getAttribute: (name: string) => (name === 'role' ? (extra.role as string) ?? null : null)}) as unknown as EventTarget;
  const enter = (target: EventTarget, mods: Partial<KeyboardEvent> = {}) => ({key: 'Enter', target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods});
  assert.equal(pressesFocusedControl(enter(control('BUTTON', true))), true, 'a swatch focus came back to after Escape');
  assert.equal(pressesFocusedControl(enter(control('BUTTON', false))), false, 'a button just clicked with the mouse');
  assert.equal(pressesFocusedControl(enter(control('INPUT', true, {type: 'checkbox'}))), true);
  assert.equal(pressesFocusedControl(enter(control('DIV', true, {role: 'menuitem'}))), true);
  assert.equal(pressesFocusedControl(enter(control('DIV', true))), false, 'the canvas or a plain element');
  assert.equal(pressesFocusedControl(enter(control('BUTTON', true), {shiftKey: true})), false, '⇧Enter stays a command');
  assert.equal(pressesFocusedControl({...enter(control('BUTTON', true)), key: ' '}), false, 'Space stays the canvas’s');
});

test('shortcuts never collide, on a Mac and elsewhere; ⌘Y is outline mode and redo keeps ⇧⌘Z', () => {
  for (const mac of [true, false]) {
    const seen = new Map<string, string>();
    for (const command of listCommands({includeHidden: true})) {
      for (const shortcut of [command.shortcut, ...(command.alternates ?? [])]) {
        if (!shortcut) continue;
        const found = findByShortcut(key(shortcut, mac), mac);
        assert.equal(found?.id, command.id, `${shortcutString(shortcut)} on ${mac ? 'Mac' : 'PC'} runs ${found?.id}, not ${command.id}`);
        const name = JSON.stringify(key(shortcut, mac));
        assert.ok(!seen.has(name) || seen.get(name) === command.id, `${name}: ${seen.get(name)} and ${command.id}`);
        seen.set(name, command.id);
      }
    }
    assert.equal(findByShortcut({code: 'KeyY', metaKey: mac, ctrlKey: !mac, shiftKey: false, altKey: false}, mac)?.id, 'view.outlines');
    assert.equal(findByShortcut({code: 'KeyZ', metaKey: mac, ctrlKey: !mac, shiftKey: true, altKey: false}, mac)?.id, 'redo');
    for (const code of ['Backslash', 'Period']) assert.equal(findByShortcut({code, metaKey: mac, ctrlKey: !mac, shiftKey: false, altKey: false}, mac)?.id, 'view.toggle-ui', `${code} hides the interface, as in Figma`);
  }
  assert.deepEqual(shortcutFrom('Shift+Mod+KeyK'), {code: 'KeyK', mod: true, shift: true});
  assert.equal(shortcutString({code: 'KeyG', ctrl: true}), 'Ctrl+KeyG');
});

// ── The editor's commands ────────────────────────────────────────────────────────────────────────

test('view toggles flip the store’s flags and report them checked', () => {
  const {store, ctx, run} = setup(build(() => {}));
  const lookup = createCommandLookup(() => ctx);
  assert.equal(lookup('view.outlines')?.checked?.(), false);
  run('view.outlines');
  assert.equal(store.getState().ui.outlines, true);
  assert.equal(lookup('view.outlines')?.checked?.(), true);
  for (const [id, flag] of [['view.pixel-grid', 'pixelGrid'], ['view.layout-grids', 'layoutGrids'], ['view.rulers', 'rulers'], ['view.pixel-preview', 'pixelPreview'], ['view.snap-pixel-grid', 'snapToPixel'], ['view.multiplayer-cursors', 'multiplayerCursors'], ['view.toggle-ui', 'showUI']] as const) {
    const before = store.getState().ui[flag];
    run(id);
    assert.equal(store.getState().ui[flag], !before, id);
  }
  // ⇧\ folds the panels (Figma's Minimize UI) and also brings back an interface ⌘\ hid.
  store.setUI({showUI: false, minimizeUI: false});
  run('view.minimize-ui');
  assert.deepEqual([store.getState().ui.minimizeUI, store.getState().ui.showUI], [true, true]);
  assert.equal(lookup('view.minimize-ui')?.checked?.(), true);
  run('view.minimize-ui');
  assert.equal(store.getState().ui.minimizeUI, false);
});

test('pages step forward and back; selection commands pick siblings and look-alikes', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0});
    add('RECTANGLE', 'b', 'page', {x: 200, y: 0});
    add('ELLIPSE', 'c', 'page', {x: 400, y: 0});
    add('FRAME', 'f', 'page', {x: 0, y: 300, width: 400, height: 200});
    add('RECTANGLE', 'd', 'f', {x: 10, y: 10});
    add('RECTANGLE', 'locked', 'page', {x: 600, y: 0, locked: true});
  }, ['page-2']);
  const {store, ctx, run} = setup(doc);
  assert.equal(resolveCommand('view.page-previous')?.enabled?.(ctx), false);
  run('view.page-next');
  assert.equal(store.getState().pageId, 'page-2');
  run('view.page-previous');
  assert.equal(store.getState().pageId, 'page');

  assert.deepEqual(inverseSelection(doc, 'page', ['a'], null), ['b', 'c', 'f']);
  assert.deepEqual(inverseSelection(doc, 'page', ['d'], null), [], 'a lone child has no siblings to take');
  // Same type and look, wherever on the page; locked layers are left alone.
  assert.deepEqual(matchingSelection(doc, 'page', ['a']).sort(), ['a', 'b', 'd']);
  store.setSelection(['a']);
  run('edit.select-matching');
  assert.deepEqual([...store.getState().selection].sort(), ['a', 'b', 'd']);
  run('edit.select-none');
  assert.deepEqual(store.getState().selection, []);
  store.setSelection(['a', 'b']);
  run('edit.select-inverse');
  assert.deepEqual(store.getState().selection, ['c', 'f']);
});

test('rotation commands turn the selection about its centre, clockwise on screen', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page', {x: 100, y: 100, width: 200, height: 100}));
  const {store, run} = setup(doc);
  store.setSelection(['r']);
  const before = worldBox(store.getState().doc, 'r');
  run('object.rotate-90-cw');
  const node = store.getState().doc.nodes.r;
  close(node.rotation, -90, 'positive rotation is counter-clockwise, so a clockwise turn is −90°');
  const after = worldBox(store.getState().doc, 'r');
  close(after.x + after.width / 2, before.x + before.width / 2);
  close(after.y + after.height / 2, before.y + before.height / 2);
  close(after.width, 100);
  close(after.height, 200);
  run('object.rotate-90-ccw');
  close(store.getState().doc.nodes.r.rotation, 0);
  run('object.rotate-180');
  close(Math.abs(store.getState().doc.nodes.r.rotation), 180);
  store.undo();
  close(store.getState().doc.nodes.r.rotation, 0);
});

test('arrow keys move by the nudge steps of the preferences', () => {
  resetPreferencesCache();
  const doc = build(add => add('RECTANGLE', 'r', 'page', {x: 0, y: 0}));
  const {store, ctx} = setup(doc);
  store.setSelection(['r']);
  const right = findByShortcut({code: 'ArrowRight', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false}, true)!;
  const down = findByShortcut({code: 'ArrowDown', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false}, true)!;
  void right.run(ctx);
  void down.run(ctx);
  assert.equal(store.getState().doc.nodes.r.x, 1);
  assert.equal(store.getState().doc.nodes.r.y, 10);
  setPreferences({nudgeSmall: 0.5, nudgeLarge: 8});
  void right.run(ctx);
  void down.run(ctx);
  assert.equal(store.getState().doc.nodes.r.x, 1.5);
  assert.equal(store.getState().doc.nodes.r.y, 18);
  setPreferences({nudgeSmall: 1, nudgeLarge: 10});
  assert.equal(getPreferences().nudgeLarge, 10);
});

test('hosted commands reach the open editor only while it is bound; tool keys select registered tools', () => {
  const {ctx} = setup(build(() => {}));
  const calls: string[] = [];
  const host: EditorCommandHost = {
    renameFile: () => calls.push('rename'), newFile: () => calls.push('new'), duplicateFile: () => calls.push('duplicate'), trashFile: () => calls.push('trash'),
    showLeftTab: tab => calls.push('tab:' + tab), toggleQuickActions: () => calls.push('quick'), openDialog: id => calls.push('dialog:' + id), selectTool: id => calls.push('tool:' + id),
    mode: () => 'design', modes: () => ['draw', 'design', 'prototype', 'code'], setMode: mode => calls.push('mode:' + mode),
  };
  assert.equal(resolveCommand('file.rename')?.enabled?.(ctx), false, 'nothing is bound yet');
  const unbind = bindCommandHost(host);
  for (const id of ['file.rename', 'file.new', 'file.duplicate', 'file.trash', 'view.panel-assets', 'app.quick-actions', 'help.shortcuts', 'app.preferences']) runCommand(id, ctx);
  assert.deepEqual(calls, ['rename', 'new', 'duplicate', 'trash', 'tab:assets', 'quick', 'dialog:shortcuts', 'dialog:preferences']);
  calls.length = 0;
  // Tool keys by physical key: the drawing tools own theirs (R, ⇧L, A, ⇧⌘K place image); a toolbar tool
  // that has none yet (T, until text ships) reaches the host, which says it is not there yet.
  const {store} = setup(build(() => {}));
  const keyCtx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  const press = (code: string, mods: {shift?: boolean; mod?: boolean} = {}) => findByShortcut({code, shiftKey: !!mods.shift, metaKey: !!mods.mod, ctrlKey: false, altKey: false}, true);
  for (const [code, mods, tool] of [['KeyR', {}, 'rectangle'], ['KeyL', {shift: true}, 'arrow'], ['KeyA', {}, 'frame'], ['KeyO', {}, 'ellipse']] as const) {
    void press(code, mods)!.run(keyCtx);
    assert.equal(store.getState().tool, tool, code);
  }
  assert.equal(press('KeyK', {shift: true, mod: true})?.id, 'file.place-image', '⇧⌘K places a picture, no second binding');
  void press('KeyT')?.run(ctx);
  assert.deepEqual(calls, getCommand('tool-text')?.hidden ? [] : ['tool:text']);
  unbind();
  calls.length = 0;
  void press('KeyT')?.run(ctx);
  assert.deepEqual(calls, []);
  for (const tool of Object.keys(TOOLS) as ToolId[]) {
    if (tool !== 'move' && tool !== 'hand') assert.ok(EDITOR_COMMAND_IDS.includes('tool-' + tool), tool);
  }
  assert.equal(chromeToolOf('rectangle'), 'rectangle');
  assert.equal(chromeToolOf('gradient-edit'), null, 'a paint mode lights no toolbar button');
  assert.equal(chromeToolOf('vector-edit'), 'pen', 'the vector editor lights "Pen"');
  assert.equal(chromeToolOf('vector-bend'), 'pen');
  // The vector feature binds P and ⇧P itself; the editor does not add a second binding.
  assert.equal(findByShortcut({code: 'KeyP', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false}, true)?.id, 'tool-pen');
  for (const id of ['object.boolean-union', 'object.boolean-subtract', 'object.boolean-intersect', 'object.boolean-exclude', 'object.flatten', 'object.outline-stroke', 'object.mask']) {
    assert.ok(menuCoverage().wired.includes(id), `${id} is in the menu`);
  }
});

// ── Quick actions ────────────────────────────────────────────────────────────────────────────────

test('quick actions find commands by name and keyword, recent first', () => {
  const entries = paletteEntries();
  const ids = (query: string, recent: string[] = []) => searchPalette(entries, query, recent).map(entry => entry.id);
  assert.equal(ids('group')[0], 'group');
  assert.equal(ids('rectang')[0], 'tool-rectangle');
  assert.ok(ids('outline').includes('view.outlines'));
  assert.ok(ids('wireframe').includes('view.outlines'), 'a keyword finds a command its label does not say');
  assert.ok(ids('rcg').length >= 0, 'a subsequence query does not throw');
  assert.deepEqual(ids('zzzzqqq'), []);
  // Words people type for a command whose label says it another way.
  assert.equal(ids('mask')[0], 'object.mask');
  assert.ok(ids('align').includes('arrange.align-left'));
  assert.equal(ids('font bold')[0], 'text.bold');
  // Scattered letters are offered only when nothing matches as a word.
  assert.deepEqual(ids('rectang'), ['tool-rectangle'], 'no scattered-letter matches beside a whole-word one');
  assert.ok(!ids('hide').includes('select-children'));
  // Empty query: recent first, then everything by label; a recent one also ranks higher in a search.
  assert.deepEqual(ids('', ['view.outlines', 'group']).slice(0, 2), ['view.outlines', 'group']);
  const plain = ids('select'), lifted = ids('select', ['edit.select-matching']);
  assert.ok(lifted.indexOf('edit.select-matching') <= plain.indexOf('edit.select-matching'));
  assert.equal(lifted[0], 'edit.select-matching');
});

test('the shortcuts dialog lists every command with a key, grouped', () => {
  const groups = groupRows(shortcutRows());
  const names = groups.map(group => group.group);
  assert.ok(names.indexOf('General') < names.indexOf('Tools') && names.indexOf('Tools') < names.indexOf('Edit'));
  const all = groups.flatMap(group => group.rows);
  for (const id of ['undo', 'group', 'view.outlines', 'tool-rectangle', 'hold-space']) assert.ok(all.some(row => row.id === id), id);
  assert.ok(!all.some(row => /^nudge-(left|right|up|down)/.test(row.id)), 'nudges are summed up in two rows');
  assert.ok(all.some(row => row.id === 'nudge') && all.some(row => row.id === 'nudge-large'));
});

// ── Canvas helpers ───────────────────────────────────────────────────────────────────────────────

test('"Select layer" lists the layers under the pointer, front first, without clipped or hidden ones', () => {
  const doc = build(add => {
    add('FRAME', 'frame', 'page', {x: 0, y: 0, width: 300, height: 300});
    add('RECTANGLE', 'back', 'frame', {x: 10, y: 10, width: 100, height: 100});
    add('ELLIPSE', 'front', 'frame', {x: 50, y: 50, width: 100, height: 100});
    add('RECTANGLE', 'hidden', 'frame', {x: 50, y: 50, visible: false});
    add('RECTANGLE', 'clipped', 'frame', {x: 280, y: 0, width: 100, height: 100});
  });
  assert.deepEqual(layersAt(doc, 'page', {x: 80, y: 80}, 0, null), ['front', 'back', 'frame']);
  assert.deepEqual(layersAt(doc, 'page', {x: 350, y: 50}, 0, null), [], 'outside the clipping frame nothing shows');
  const index = {query: () => ['back', 'front', 'frame', 'hidden']};
  assert.deepEqual(layersAt(doc, 'page', {x: 80, y: 80}, 0, index), ['front', 'back', 'frame']);
});

test('"Paste here" centres the copied layers on the pointer, inside the frame there', async () => {
  const doc = build(add => {
    add('FRAME', 'frame', 'page', {x: 1000, y: 0, width: 400, height: 400});
    add('RECTANGLE', 'r', 'page', {x: 0, y: 0, width: 100, height: 50});
  });
  const {store, ctx} = setup(doc);
  const text = serializePayload(buildClipboardPayload(doc, ['r'])!);
  assert.equal(await pasteAt(ctx, {x: 0, y: 0}, async () => 'just text'), null, 'nothing to paste says so');
  const created = (await pasteAt(ctx, {x: 1200, y: 200}, async () => text))!;
  assert.equal(created.length, 1);
  const pasted = store.getState().doc.nodes[created[0]];
  assert.equal(pasted.parentId, 'frame');
  const box = worldBox(store.getState().doc, created[0]);
  close(box.x + box.width / 2, 1200);
  close(box.y + box.height / 2, 200);
  assert.deepEqual(store.getState().selection, created);
});

test('registered tools are what the toolbar offers', () => {
  const off = registerTool('star', () => ({id: 'star', cursor: 'crosshair'}));
  const entries = paletteEntries();
  assert.ok(entries.some(entry => entry.id === 'tool-star'));
  off();
});
