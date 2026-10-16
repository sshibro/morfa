import './helpers/linux-platform';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from '../shared/design/defaults';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createDesignStore} from '../src/design/engine/store';
import type {CommandContext} from '../src/design/engine/commands';
import {createCommandLookup, EDITOR_MENU, installEditorCommands, resolveCommand} from '../src/design/editor/command-bridge';
import {lookupFrom} from '../src/design/editor/chrome/commands';
import {connectBridge} from '../src/desktop/bridge';
import {desktopHost, desktopMarker, publishEditorMenu, startDesktop, watchEditorMenu, type EditorMenuSource} from '../src/desktop/host';
import {createHost, type HostEvent, type TauriCore, type WebMenu, type WebMenuItem} from '../src/desktop/ipc';
import {editingText, runMenuCommand, webMenu} from '../src/desktop/menu';
import {NAVIGATION_EVENT, type NavigationRequest} from '../src/navigation';

// The desktop app's web side (src/desktop/, docs/desktop.md): the marker check, the typed IPC, the menu sent to the
// native menu bar and the bridge's wiring, against a fake Tauri core.

type Call = {cmd: string; args?: unknown; options?: unknown};

function fakeCore(answers: Record<string, (args: unknown) => unknown> = {}) {
  const calls: Call[] = [];
  let channel: {onmessage: (message: HostEvent) => void} | undefined;
  class Channel<T> {
    onmessage: (message: T) => void = () => {};
    constructor() {
      channel = this as unknown as {onmessage: (message: HostEvent) => void};
    }
  }
  const core: TauriCore = {
    invoke: async <T,>(cmd: string, args?: unknown, options?: unknown) => {
      calls.push({cmd, args, options});
      const answer = answers[cmd];
      return (answer ? await answer(args) : null) as T;
    },
    Channel: Channel as TauriCore['Channel'],
  };
  return {core, calls, emit: (event: HostEvent) => channel!.onmessage(event)};
}

/** Just enough of a window for the bridge: a document with a title, events, a location. */
function fakeScope(hash = '#designs') {
  const target = new EventTarget();
  const title = {textContent: 'Morfa'};
  const observers: (() => void)[] = [];
  const notices: string[] = [];
  const doc = {
    title: 'Morfa',
    activeElement: null as unknown,
    head: {},
    body: {appendChild: (node: {textContent: string}) => notices.push(node.textContent)},
    querySelector: (selector: string) => (selector === 'title' ? title : null),
    createElement: () => ({style: {}, setAttribute() {}, textContent: '', remove() {}}),
    execCommand: (command: string) => {
      notices.push(`exec:${command}`);
      return true;
    },
  };
  const scope = {
    document: doc,
    location: {hash},
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    MutationObserver: class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  };
  return {
    scope: scope as unknown as Window & typeof globalThis,
    doc,
    notices,
    retitle(text: string) {
      doc.title = text;
      for (const observer of observers) observer();
    },
    navigate(next: string) {
      scope.location.hash = next;
      target.dispatchEvent(new Event('hashchange'));
    },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('the bridge loads only where the shell marked the page and Tauri is there', async () => {
  assert.equal(desktopMarker({}), undefined);
  assert.equal(desktopMarker({__MORFA_DESKTOP__: {version: '0.1.0', platform: 'linux'}}), undefined, 'a page cannot claim it alone');
  assert.deepEqual(desktopMarker({__MORFA_DESKTOP__: {version: '0.1.0', platform: 'linux'}, __TAURI_INTERNALS__: {}}), {version: '0.1.0', platform: 'linux'});
  assert.equal(startDesktop({}), undefined, 'a browser imports nothing');
  assert.equal(desktopHost.saveFile, undefined);
});

test('the IPC names the shell commands and moves files as raw bytes', async () => {
  // The file name sent to save_portable stays Cyrillic on purpose: the x-morfa-name header must be percent-encoded for non-ASCII names.
  const {core, calls} = fakeCore({read_font: () => new Uint8Array([1, 2, 3]), take_portable: () => [7, 8], save_portable: () => 'Landing.rdesign'});
  const host = createHost(core);
  assert.deepEqual([...new Uint8Array(await host.readFont(4))], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await host.takePortable('t1'))], [7, 8]);
  assert.equal(await host.savePortable(new Blob(['{"format":"morfa-design"}']), 'Лендинг/v2.rdesign'), 'Landing.rdesign');
  const save = calls.find(call => call.cmd === 'save_portable')!;
  assert.ok(save.args instanceof Uint8Array && new TextDecoder().decode(save.args) === '{"format":"morfa-design"}');
  assert.deepEqual(save.options, {headers: {'x-morfa-name': encodeURIComponent('Лендинг/v2.rdesign')}});
  await host.openWindow('#design/f1');
  await host.reportLocation('f1', 'Landing page — Design');
  assert.deepEqual(calls.map(call => call.cmd), ['read_font', 'take_portable', 'save_portable', 'open_window', 'report_location']);
  assert.deepEqual(calls[3].args, {hash: '#design/f1'});
  assert.deepEqual(calls[4].args, {fileId: 'f1', title: 'Landing page — Design'});
});

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function editorSource(): EditorMenuSource {
  installEditorCommands();
  const store = createDesignStore({doc: createDocument('page'), measurer});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  return {sections: EDITOR_MENU, lookup: createCommandLookup(() => ctx), clipboard: id => resolveCommand(id)?.clipboardEvent};
}

function commands(items: WebMenuItem[]): Extract<WebMenuItem, {type: 'command'}>[] {
  return items.flatMap(item => (item.type === 'command' ? [item] : item.type === 'submenu' ? commands(item.items) : []));
}

// desktop/src-tauri/src/menu.rs `key_name`: the keys a native menu can show. A new editor shortcut on another key
// still works in the page, but its native item would show no shortcut: add the key there and here.
const NATIVE_KEY = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Backspace|Delete|Enter|Escape|Tab|Space|Arrow(Left|Right|Up|Down)|Page(Up|Down)|Home|End|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/;

test('the editor menu goes to the native menu bar with labels, shortcuts and state', () => {
  const menu: WebMenu = webMenu(editorSource());
  assert.deepEqual(menu.sections.map(section => section.label), ['File', 'Edit', 'View', 'Object', 'Text', 'Arrange', 'Help', 'Preferences'].filter(label => menu.sections.some(section => section.label === label)));
  const all = menu.sections.flatMap(section => commands(section.items));
  const undo = all.find(item => item.id === 'edit.undo')!;
  assert.equal(undo.label, 'Undo');
  assert.equal(undo.shortcut, 'Mod+KeyZ');
  assert.equal(undo.enabled, false, 'nothing to undo in a fresh document');
  assert.equal(all.find(item => item.id === 'edit.copy')?.clipboard, 'copy');
  assert.ok(all.some(item => item.checked !== undefined), 'toggles carry their check mark');
  assert.ok(!all.some(item => item.id === 'edit.find'), 'unbuilt commands stay out, as in the web menu');
  for (const item of all) {
    if (!item.shortcut) continue;
    const parts = item.shortcut.split('+');
    assert.ok(NATIVE_KEY.test(parts[parts.length - 1]), `${item.id}: ${item.shortcut} has a key the native menu knows`);
    assert.ok(parts.slice(0, -1).every(part => ['Ctrl', 'Alt', 'Shift', 'Mod'].includes(part)), item.shortcut);
  }
  for (const section of menu.sections) {
    const walk = (items: WebMenuItem[]) => {
      assert.notEqual(items[0]?.type, 'separator');
      assert.notEqual(items[items.length - 1]?.type, 'separator');
      for (const item of items) if (item.type === 'submenu') walk(item.items);
    };
    walk(section.items);
  }
  assert.deepEqual(webMenu(null), {sections: []});
});

test('a native menu choice runs the command, or the text field’s own edit while one has the keyboard', () => {
  const ran: string[] = [];
  const source: EditorMenuSource = {
    sections: [{id: 'edit', label: 'Edit', items: ['edit.undo', 'object.group']}],
    lookup: lookupFrom([
      {id: 'edit.undo', label: 'Undo', run: () => ran.push('undo')},
      {id: 'object.group', label: 'Group', run: () => ran.push('group'), enabled: () => false},
    ]),
  };
  const {doc, notices} = fakeScope();
  const page = doc as unknown as Document;
  assert.equal(runMenuCommand('edit.undo', source, page), true);
  assert.equal(runMenuCommand('object.group', source, page), false, 'a disabled command does not run');
  assert.equal(runMenuCommand('nothing', source, page), false);
  assert.equal(runMenuCommand('edit.undo', null, page), false, 'no editor, nothing runs');
  doc.activeElement = {tagName: 'INPUT', isContentEditable: false};
  assert.equal(editingText(page), true);
  assert.equal(runMenuCommand('edit.undo', source, page), true);
  assert.deepEqual(ran, ['undo']);
  assert.deepEqual(notices, ['exec:undo']);
});

test('the bridge connects, fills the hooks, follows the menu and the location, and opens files the shell hands it', async () => {
  const {core, calls, emit} = fakeCore({
    connect: () => ({version: '0.1.0', platform: 'linux', appOrigin: 'https://app.morfa.example', window: 'w1'}),
    list_fonts: () => [],
    take_portable: () => new TextEncoder().encode('{"x":1}'),
    pick_portable: () => ({token: 't9', name: 'plan.rdesign', size: 7}),
    save_portable: () => 'plan.rdesign',
  });
  const page = fakeScope('#design/f1');
  page.doc.title = 'Landing page — Design';
  const opened: File[] = [];
  const navigations: NavigationRequest[] = [];
  const previousWindow = (globalThis as {window?: unknown}).window;
  (globalThis as {window?: unknown}).window = page.scope;
  page.scope.addEventListener(NAVIGATION_EVENT, event => navigations.push((event as CustomEvent<NavigationRequest>).detail));
  let ran = 0;
  try {
    const bridge = (await connectBridge({core, scope: page.scope, menuDelay: 1, openPortable: async file => (opened.push(file), {fileId: 'new1'})}))!;
    assert.ok(bridge);
    assert.equal(typeof (page.scope as {queryLocalFonts?: unknown}).queryLocalFonts, 'function', 'local fonts installed');
    assert.deepEqual(calls.filter(call => call.cmd === 'report_location').map(call => call.args), [{fileId: 'f1', title: 'Landing page — Design'}]);

    // The editor's menu goes to the shell once, and again only when it changed.
    const withdraw = publishEditorMenu({sections: [{id: 'edit', label: 'Edit', items: ['edit.undo']}], lookup: lookupFrom([{id: 'edit.undo', label: 'Undo', shortcut: 'Mod+KeyZ', run: () => ran++}])});
    await settle();
    const menus = () => calls.filter(call => call.cmd === 'set_menu').map(call => (call.args as {menu: WebMenu}).menu);
    assert.equal(menus().length, 1);
    assert.equal(commands(menus()[0].sections[0].items)[0].id, 'edit.undo');
    page.scope.dispatchEvent(new Event('keyup'));
    await settle();
    assert.equal(menus().length, 1, 'unchanged menus are not sent again');
    emit({type: 'menu', command: 'edit.undo'});
    assert.equal(ran, 1);
    withdraw();
    await settle();
    assert.deepEqual(menus().at(-1), {sections: []}, 'leaving the editor clears its menu');

    // Location: hash and title changes are reported once each.
    page.navigate('#designs');
    page.retitle('Design — files');
    await settle();
    assert.deepEqual(calls.filter(call => call.cmd === 'report_location').map(call => call.args).slice(1), [{fileId: null, title: 'Landing page — Design'}, {fileId: null, title: 'Design — files'}]);

    // Save and open go through the native dialogs.
    await desktopHost.saveFile!(new Blob(['{}']), 'plan.rdesign');
    assert.ok(page.notices.some(text => text.includes('plan.rdesign')));
    const picked = await desktopHost.pickFile!('.rdesign');
    assert.equal(picked?.name, 'plan.rdesign');
    assert.equal(await picked?.text(), '{"x":1}');
    assert.equal(await desktopHost.pickFile!('image/*'), null, 'only portable files go through the shell');
    desktopHost.openWindow!('#design/f2');
    assert.deepEqual(calls.find(call => call.cmd === 'open_window')?.args, {hash: '#design/f2'});

    // The shell hands over a file (menu, "Open with", argument): it opens as a new file here.
    emit({type: 'portable', token: 't1', name: 'drop.rdesign'});
    await settle();
    assert.equal(opened[0]?.name, 'drop.rdesign');
    emit({type: 'files'});
    assert.deepEqual(navigations, [{kind: 'design', fileId: 'new1'}, {view: 'designs'}]);

    bridge.stop();
    assert.equal(desktopHost.saveFile, undefined, 'stopping takes the hooks back');
  } finally {
    (globalThis as {window?: unknown}).window = previousWindow;
  }
});

test('the bridge does nothing without Tauri', async () => {
  assert.equal(await connectBridge({scope: fakeScope().scope}), null);
});

test('the editor menu publication follows the editor', () => {
  const seen: (EditorMenuSource | null)[] = [];
  const stop = watchEditorMenu(source => seen.push(source));
  const source = {sections: [], lookup: () => undefined} satisfies EditorMenuSource;
  const withdraw = publishEditorMenu(source);
  withdraw();
  withdraw();
  stop();
  publishEditorMenu(source)();
  assert.deepEqual(seen, [null, source, null]);
});
