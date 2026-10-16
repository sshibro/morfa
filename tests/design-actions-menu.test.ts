import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {findByShortcut, runCommand, type CommandContext} from '../src/design/engine/commands';
import {createDesignStore} from '../src/design/engine/store';
import {hasTool, onToolsChange, registerTool, toolsVersion} from '../src/design/engine/tools';
import {actionSections} from '../src/design/editor/actions-model';
import {bindCommandHost, installEditorCommands, paletteEntries, type EditorCommandHost} from '../src/design/editor/command-bridge';
import {groupRows, shortcutRows} from '../src/design/editor/ShortcutsDialog';
import {DEV_TOOL_GROUPS, DRAW_TOOL_GROUPS, MODES, modeForTool, modeHasTool, modesFor, READ_ONLY_TOOL_GROUPS, TOOL_GROUPS, TOOLS, toolGroupsFor, type EditorMode} from '../src/design/editor/chrome/tools';

// "Actions" (src/design/editor/actions-model.ts), the toolbar's groups and modes (chrome/tools.ts) and their commands
// (command-bridge.ts): Figma's Actions menu, honest about what cannot run; the bar's groups as Figma's UI3.

installEditorCommands();

test('"All" lists recent first, then every command by name; a search ranks commands by name and keyword', () => {
  const entries = paletteEntries();
  const runnable = (id: string) => id !== 'tool-rectangle';
  const sections = actionSections(entries, '', ['group', 'unknown', 'tool-rectangle', 'undo', 'redo', 'copy', 'paste'], runnable);
  assert.deepEqual(sections.map(section => section.title), ['Recent', 'All commands']);
  assert.deepEqual(sections[0].entries.map(entry => entry.id), ['group', 'tool-rectangle', 'undo', 'redo', 'copy'], 'up to five, unknown ids dropped');
  const labels = sections[1].entries.map(entry => entry.label);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, 'en')));
  assert.deepEqual(actionSections(entries, '', [], runnable).map(section => section.id), ['all']);
  const first = (query: string) => actionSections(entries, query, [], () => true)[0].entries[0]?.id;
  assert.equal(first('rectang'), 'tool-rectangle');
  // What can run comes first: a match that cannot run now (here the rectangle tool) stands after the runnable ones.
  const found = actionSections(entries, 'rectang', [], runnable)[0].entries.map(entry => entry.id);
  assert.ok(found.includes('tool-rectangle'));
  assert.equal(found.at(-1), 'tool-rectangle');
});

test('the bar’s groups are Figma’s: Hand in the move group; Draw and Dev Mode have their own short bars; every tool is in a design group', () => {
  // Tools that join a group later (text on a path, annotations, measurements, Draw's lasso and brush) come after these.
  assert.deepEqual(TOOL_GROUPS.map(group => group.id), ['move', 'frame', 'shape', 'pen', 'text', 'comment']);
  assert.deepEqual(TOOL_GROUPS.slice(0, 4).map(group => group.tools), [['move', 'hand', 'scale'], ['frame', 'section', 'slice'], ['rectangle', 'line', 'arrow', 'ellipse', 'polygon', 'star', 'image'], ['pen', 'pencil']]);
  assert.equal(TOOL_GROUPS[4].tools[0], 'text');
  assert.equal(TOOL_GROUPS[5].tools[0], 'comment');
  // Every tool has a button somewhere: on the design bar, or (Draw's own) on the Draw bar.
  const placed = new Set([...TOOL_GROUPS, ...DRAW_TOOL_GROUPS].flatMap(group => group.tools));
  for (const id of Object.keys(TOOLS)) assert.ok(placed.has(id as keyof typeof TOOLS), id);
  // Dev Mode's comment group is the design bar's: a tool that joins it there (annotations, measurements) is in Dev Mode too.
  assert.deepEqual(DEV_TOOL_GROUPS.map(group => group.id), ['move', 'comment']);
  assert.deepEqual(DEV_TOOL_GROUPS[0].tools, ['move', 'hand']);
  assert.equal(DEV_TOOL_GROUPS[1], TOOL_GROUPS[5]);
  // Draw: selection, shapes (no picture), the pen, the pencil and text; nothing of frames, slices or comments.
  const draw = DRAW_TOOL_GROUPS.flatMap(group => group.tools);
  for (const id of ['move', 'hand', 'rectangle', 'line', 'arrow', 'ellipse', 'polygon', 'star', 'pen', 'pencil', 'text'] as const) assert.ok(draw.includes(id), id);
  for (const id of ['frame', 'section', 'slice', 'image', 'scale', 'comment'] as const) assert.ok(!draw.includes(id), id);
  assert.deepEqual(DRAW_TOOL_GROUPS.find(group => group.tools.includes('pen'))!.tools, ['pen'], 'the pen and the pencil on buttons of their own');
  assert.equal(toolGroupsFor('prototype'), TOOL_GROUPS);
  assert.equal(toolGroupsFor('draw', true), READ_ONLY_TOOL_GROUPS);
  assert.equal(modeHasTool('code', 'rectangle'), false);
  assert.equal(modeHasTool('draw', 'pencil'), true);
  assert.equal(modeHasTool('draw', 'frame'), false);
  assert.deepEqual(MODES.map(mode => [mode.id, mode.label, mode.shortcut ?? '']), [['draw', 'Draw', ''], ['design', 'Design', ''], ['prototype', 'Prototype', ''], ['code', 'Code', 'Shift+KeyD']]);
  // Only the modes a person has: a read-only file is not drawn on; a team's viewer sees no code.
  assert.deepEqual(modesFor(false, true), ['draw', 'design', 'prototype', 'code']);
  assert.deepEqual(modesFor(true, true), ['design', 'prototype', 'code'], 'a developer');
  assert.deepEqual(modesFor(true, false), ['design', 'prototype'], 'a viewer');
});

test('a key that picks a tool the mode’s bar lacks shows the mode whose bar has it', () => {
  const all = modesFor(false, true);
  assert.equal(modeForTool('code', 'rectangle', false, all), 'design');
  assert.equal(modeForTool('draw', 'frame', false, all), 'design');
  assert.equal(modeForTool('prototype', 'pen', false, all), 'prototype');
  assert.equal(modeForTool('code', 'comment', false, all), 'code');
  assert.equal(modeForTool('draw', 'pencil', false, all), 'draw');
  // Draw's own tools (the lasso, the brush, once registered) take "Design" to "Draw".
  const designTools = new Set(TOOL_GROUPS.flatMap(group => group.tools));
  for (const id of DRAW_TOOL_GROUPS.flatMap(group => group.tools).filter(id => !designTools.has(id))) assert.equal(modeForTool('design', id, false, all), 'draw', id);
  // A read-only file keeps its mode: its bar is the same in every mode.
  assert.equal(modeForTool('code', 'move', true, modesFor(true, true)), 'code');
});

test('a tool shows once its module registers: the registry tells the bar', () => {
  let heard = 0;
  const off = onToolsChange(() => heard++);
  const before = toolsVersion();
  const remove = registerTool('zz-late-tool', () => ({id: 'zz-late-tool', cursor: 'default'}));
  assert.ok(hasTool('zz-late-tool'));
  assert.equal(heard, 1);
  assert.ok(toolsVersion() > before);
  remove();
  assert.equal(hasTool('zz-late-tool'), false);
  assert.equal(heard, 2);
  off();
});

test('⌘K opens "Actions" (⌘/ and ⌘P still do); ⇧D toggles "Code" and "Design"; the modes are commands', () => {
  const store = createDesignStore({doc: createDocument('page'), measurer: {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})}});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  let mode: EditorMode = 'design';
  let modes: readonly EditorMode[] = modesFor(false, true);
  const calls: string[] = [];
  const host: EditorCommandHost = {
    renameFile: () => {}, newFile: () => {}, duplicateFile: () => {}, trashFile: () => {}, showLeftTab: () => {}, openDialog: () => {}, selectTool: () => {},
    toggleQuickActions: () => calls.push('actions'), mode: () => mode, modes: () => modes, setMode: next => {
      mode = next;
      calls.push(next);
    },
  };
  const unbind = bindCommandHost(host);
  for (const mac of [true, false]) {
    for (const code of ['KeyK', 'Slash', 'KeyP']) assert.equal(findByShortcut({code, metaKey: mac, ctrlKey: !mac, shiftKey: false, altKey: false}, mac)?.id, 'app.quick-actions', code);
    assert.equal(findByShortcut({code: 'KeyD', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false}, mac)?.id, 'view.mode-code');
  }
  runCommand('app.quick-actions', ctx);
  runCommand('view.mode-code', ctx);
  runCommand('view.mode-code', ctx);
  runCommand('view.mode-prototype', ctx);
  runCommand('view.mode-draw', ctx);
  assert.deepEqual(calls, ['actions', 'code', 'design', 'prototype', 'draw']);
  // A viewer has no "Code" and a read-only file no "Draw": those commands are off.
  modes = modesFor(true, false);
  assert.equal(runCommand('view.mode-code', ctx), false);
  assert.equal(runCommand('view.mode-draw', ctx), false);
  assert.equal(runCommand('view.mode-prototype', ctx), true);
  unbind();
});

test('"Keyboard shortcuts" lists ⌘K "Actions" under "General" and ⇧D "Dev Mode" under "View"', () => {
  const rows = shortcutRows();
  const row = (id: string) => rows.find(each => each.id === id);
  assert.deepEqual(row('app.quick-actions'), {id: 'app.quick-actions', label: 'Actions', shortcut: 'Mod+KeyK', group: 'General'});
  assert.deepEqual(row('view.mode-code'), {id: 'view.mode-code', label: 'Dev Mode', shortcut: 'Shift+KeyD', group: 'View'});
  // Each key once in the dialog: no other row claims ⌘K or ⇧D.
  for (const shortcut of ['Mod+KeyK', 'Shift+KeyD']) assert.equal(rows.filter(each => each.shortcut === shortcut).length, 1, shortcut);
  assert.ok(groupRows(rows).some(group => group.group === 'General' && group.rows.some(each => each.id === 'app.quick-actions')));
});
