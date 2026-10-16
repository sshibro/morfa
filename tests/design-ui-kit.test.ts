import {test} from 'node:test';
import assert from 'node:assert/strict';
import {firstIndex, lastIndex, moveIndex, tidySeparators, typeaheadIndex, type MenuItem} from '../src/design/ui/menu-model';
import {formatShortcut, matchesShortcut, parseShortcut} from '../src/design/ui/shortcuts';
import {placeFloating} from '../src/design/ui/position';
import {buildMainMenu, buildMenuItems, lookupFrom, MAIN_MENU, type ChromeCommand} from '../src/design/editor/chrome/commands';
import {DRAW_TOOL_GROUPS, TOOLS, TOOL_GROUPS, toolForKey} from '../src/design/editor/chrome/tools';

const action = (id: string, label: string, extra: Partial<MenuItem> = {}): MenuItem => ({id, label, onSelect: () => {}, ...extra} as MenuItem);

test('menu keyboard movement skips separators, headings and disabled rows, and wraps', () => {
  const items: MenuItem[] = [
    {type: 'label', label: 'Section'},
    action('copy', 'Copy'),
    {type: 'separator'},
    action('paste', 'Paste', {disabled: true}),
    action('delete', 'Delete'),
  ];
  assert.equal(firstIndex(items), 1);
  assert.equal(lastIndex(items), 4);
  assert.equal(moveIndex(items, 1, 1), 4, 'separator and disabled row are skipped');
  assert.equal(moveIndex(items, 4, 1), 1, 'wraps to the top');
  assert.equal(moveIndex(items, 1, -1), 4, 'wraps to the bottom');
  assert.equal(moveIndex([{type: 'separator'}], 0, 1), -1);
});

// Cyrillic is kept on purpose: this test is about Russian type-ahead that folds ё to е.
test('menu type-ahead finds rows by their first letters, Russian and ё-insensitive, cycling on one letter', () => {
  const items: MenuItem[] = [action('a', 'Прямоугольник'), action('b', 'Перо'), action('c', 'Ёлка'), action('d', 'Прозрачность')];
  assert.equal(typeaheadIndex(items, -1, 'п'), 0);
  assert.equal(typeaheadIndex(items, 0, 'п'), 1, 'the same letter moves on');
  assert.equal(typeaheadIndex(items, 1, 'пп'), 3, 'a repeated letter keeps cycling');
  assert.equal(typeaheadIndex(items, 0, 'проз'), 3);
  assert.equal(typeaheadIndex(items, 0, 'ел'), 2);
  assert.equal(typeaheadIndex(items, 0, 'щ'), -1);
});

test('separators left by hidden commands are tidied', () => {
  const tidy = tidySeparators([{type: 'separator'}, action('a', 'A'), {type: 'separator'}, {type: 'separator'}, action('b', 'B'), {type: 'separator'}]);
  assert.deepEqual(tidy.map(item => item.type ?? 'item'), ['item', 'separator', 'item']);
});

test('shortcuts print as the platform writes them and match by physical key', () => {
  assert.equal(formatShortcut('Mod+Shift+KeyZ', true), '⇧⌘Z');
  assert.equal(formatShortcut('Mod+Shift+KeyZ', false), 'Ctrl+Shift+Z');
  assert.equal(formatShortcut('Alt+Mod+KeyC', true), '⌥⌘C');
  assert.equal(formatShortcut('Mod+Backslash', true), '⌘\\');
  assert.equal(formatShortcut('Shift+Digit1', false), 'Shift+1');
  assert.equal(formatShortcut('Mod+Minus', true), '⌘−');
  assert.equal(formatShortcut('KeyV', false), 'V');
  assert.equal(formatShortcut('Ctrl+KeyG', true), '⌃G');
  assert.equal(parseShortcut('Mod+'), null);
  assert.equal(parseShortcut('KeyA+KeyB'), null);
  const event = {code: 'KeyZ', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true};
  assert.ok(matchesShortcut(event, 'Mod+Shift+KeyZ', true));
  assert.ok(!matchesShortcut(event, 'Mod+KeyZ', true), 'an extra Shift is another shortcut');
  assert.ok(!matchesShortcut(event, 'Mod+Shift+KeyZ', false), 'Mod is Ctrl off the Mac');
  // A Russian layout types another letter on KeyZ; the code is the same.
  assert.ok(matchesShortcut({code: 'KeyZ', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false}, 'Mod+KeyZ', false));
});

test('floating elements flip to the side with room and stay on screen', () => {
  const viewport = {width: 1000, height: 800};
  const below = placeFloating({x: 100, y: 100, width: 80, height: 24}, {width: 200, height: 300}, viewport, 'bottom-start');
  assert.deepEqual([below.x, below.y, below.side], [100, 128, 'bottom']);
  const flipped = placeFloating({x: 100, y: 700, width: 80, height: 24}, {width: 200, height: 300}, viewport, 'bottom-start');
  assert.equal(flipped.side, 'top');
  assert.equal(flipped.y, 700 - 4 - 300);
  const shifted = placeFloating({x: 950, y: 100, width: 40, height: 24}, {width: 200, height: 100}, viewport, 'bottom-start');
  assert.equal(shifted.x, 1000 - 200 - 8, 'shifted left to stay inside the padding');
  const tall = placeFloating({x: 10, y: 400, width: 40, height: 24}, {width: 200, height: 2000}, viewport, 'bottom-start');
  assert.equal(tall.y, 8, 'a menu taller than the screen starts at the top and scrolls');
  const toolbar = placeFloating({x: 480, y: 750, width: 32, height: 32}, {width: 200, height: 120}, viewport, 'top-start', 8);
  assert.deepEqual([toolbar.side, toolbar.y], ['top', 750 - 8 - 120]);
  assert.match(toolbar.origin, /px 120px$/, 'it grows from the edge facing its anchor');
});

const commands: ChromeCommand[] = [
  {id: 'edit.undo', label: 'Undo', shortcut: 'Mod+KeyZ', run: () => {}, enabled: () => false},
  {id: 'edit.redo', label: 'Redo', shortcut: 'Mod+Shift+KeyZ', run: () => {}},
  {id: 'view.rulers', label: 'Rulers', shortcut: 'Shift+KeyR', run: () => {}, checked: () => true},
  {id: 'object.boolean-union', label: 'Union', run: () => {}},
];

test('the main menu shows only registered commands, with their state read on open', () => {
  const lookup = lookupFrom(commands);
  const menu = buildMainMenu(MAIN_MENU, lookup, {onBackToFiles: () => {}});
  const labels = menu.map(item => ('label' in item ? item.label : '—'));
  assert.deepEqual(labels, ['Back to files', '—', 'Edit', 'View', 'Object'], 'sections without commands are left out');
  const edit = menu.find(item => item.type === 'submenu' && item.label === 'Edit');
  assert.ok(edit && edit.type === 'submenu');
  assert.deepEqual(edit.items.map(item => ('label' in item ? item.label : '—')), ['Undo', 'Redo']);
  assert.equal((edit.items[0] as {disabled?: boolean}).disabled, true);
  const view = buildMenuItems(MAIN_MENU.find(section => section.id === 'view')!.items, lookup);
  assert.equal((view[0] as {checked?: boolean}).checked, true);
  const object = buildMenuItems(MAIN_MENU.find(section => section.id === 'object')!.items, lookup);
  assert.equal(object.length, 1);
  assert.equal(object[0].type, 'submenu', 'a submenu appears once one of its commands exists');
});

test('every main-menu id is unique and every tool has a group, an English name and a known shortcut', () => {
  const ids: string[] = [];
  const walk = (entries: readonly unknown[]) => entries.forEach(entry => {
    if (typeof entry === 'string' && entry !== '-') ids.push(entry);
    else if (entry && typeof entry === 'object') walk((entry as {items: unknown[]}).items);
  });
  MAIN_MENU.forEach(section => walk(section.items));
  assert.equal(new Set(ids).size, ids.length);
  // Every tool is on a bar: "Design"'s groups, or (Figma Draw's lasso and brush) only "Draw"'s.
  const grouped = new Set([...TOOL_GROUPS, ...DRAW_TOOL_GROUPS].flatMap(group => group.tools));
  assert.deepEqual([...grouped].sort(), Object.keys(TOOLS).sort());
  for (const drawOnly of ['lasso', 'brush'] as const) {
    assert.ok(!TOOL_GROUPS.some(group => group.tools.includes(drawOnly)), drawOnly);
    assert.ok(DRAW_TOOL_GROUPS.some(group => group.tools.includes(drawOnly)), drawOnly);
  }
  // English names, capitalised once ("Text on path" is two more lowercase words).
  for (const tool of Object.values(TOOLS)) assert.match(tool.label, /^[A-Z][a-z]+( [a-z]+)*$/);
  const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({code, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra});
  assert.equal(toolForKey(key('KeyV'), true), 'move');
  assert.equal(toolForKey(key('KeyA'), true), 'frame');
  assert.equal(toolForKey(key('KeyS', {shiftKey: true}), true), 'section');
  assert.equal(toolForKey(key('KeyL', {shiftKey: true}), false), 'arrow');
  assert.equal(toolForKey(key('KeyK', {shiftKey: true, metaKey: true}), true), 'image');
  assert.equal(toolForKey(key('KeyK', {shiftKey: true, ctrlKey: true}), false), 'image');
  assert.equal(toolForKey(key('KeyY'), true), 'annotation');
  assert.equal(toolForKey(key('KeyM', {shiftKey: true}), false), 'measure');
  assert.equal(toolForKey(key('KeyQ'), true), 'lasso');
  assert.equal(toolForKey(key('KeyB'), false), 'brush');
  assert.equal(toolForKey(key('KeyY', {metaKey: true}), true), null, '⌘Y is outline mode, not a tool');
  assert.equal(toolForKey(key('KeyZ', {metaKey: true}), true), null, '⌘Z is not a tool');
  assert.equal(toolForKey(key('KeyV', {altKey: true}), true), null);
});
