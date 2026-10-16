import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from '../shared/design/defaults';
import {createDesignStore} from '../src/design/engine/store';
import {findByShortcut, getCommand, isEnabled, registerCommand, type CommandContext} from '../src/design/engine/commands/registry';
import {bindFileCommandHost, FILE_COMMAND_IDS, openPortable, registerFileCommands, type FileCommandHost} from '../src/design/engine/commands/file';

// The "File" commands of versions and .rdesign files: menu ids of MAIN_MENU, ⌥⌘S, a host bound by the
// editor, and fallbacks for "Duplicate file" / "Move to trash" that never replace the editor's own.

const measurer = {width: (text: string, font: {size: number}) => text.length * font.size * 0.5, metrics: (font: {size: number}) => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const ctx: CommandContext = {store: createDesignStore({doc: createDocument('page'), measurer}), canvasSize: () => ({width: 800, height: 600})};

function host() {
  const dialogs: [string, Record<string, unknown> | undefined][] = [];
  const toasts: string[] = [];
  const value: FileCommandHost = {
    fileId: 'f1',
    fileName: () => 'Layout',
    openDialog: (id, params) => void dialogs.push([id, params]),
    toast: message => void toasts.push(message),
  };
  return {value, dialogs, toasts};
}

test('the commands register under the main menu ids; fallbacks only where the editor has none', () => {
  const editorDuplicate = {id: 'file.duplicate', label: 'Duplicate file (editor)', run: () => {}};
  const offEditor = registerCommand(editorDuplicate);
  const off = registerFileCommands();
  assert.deepEqual(FILE_COMMAND_IDS, ['file.versions', 'file.save-version', 'file.save-portable', 'file.open-portable', 'file.duplicate', 'file.trash']);
  for (const id of ['file.versions', 'file.save-version', 'file.save-portable', 'file.open-portable', 'file.trash']) assert.ok(getCommand(id), id);
  assert.equal(getCommand('file.duplicate'), editorDuplicate, 'the editor’s own command stays');
  assert.equal(getCommand('file.save-portable')!.label, 'Save to computer (.rdesign)');
  off();
  assert.equal(getCommand('file.versions'), undefined);
  assert.equal(getCommand('file.duplicate'), editorDuplicate, 'undoing ours leaves the editor’s');
  offEditor();
});

test('without an open editor they are disabled; with one, the history opens as a dialog', () => {
  const off = registerFileCommands();
  const versions = getCommand('file.versions')!, save = getCommand('file.save-version')!;
  assert.equal(isEnabled(versions, ctx), false);
  const bound = host();
  const unbind = bindFileCommandHost(bound.value);
  assert.equal(isEnabled(versions, ctx), true);
  void versions.run(ctx);
  void save.run(ctx);
  assert.deepEqual(bound.dialogs, [['versions', undefined], ['versions', {save: true}]]);
  unbind();
  assert.equal(isEnabled(save, ctx), false);
  off();
});

test('⌥⌘S (Ctrl+Alt+S elsewhere) is "Save version" on any keyboard layout', () => {
  const off = registerFileCommands();
  const key = {code: 'KeyS', shiftKey: false, altKey: true};
  assert.equal(findByShortcut({...key, metaKey: true, ctrlKey: false}, true)?.id, 'file.save-version');
  assert.equal(findByShortcut({...key, metaKey: false, ctrlKey: true}, false)?.id, 'file.save-version');
  assert.notEqual(findByShortcut({...key, altKey: false, metaKey: true, ctrlKey: false}, true)?.id, 'file.save-version');
  off();
});

test('opening from the computer takes only .rdesign files and does nothing when the dialog is closed', async () => {
  const toasts: string[] = [];
  const toast = (message: string) => void toasts.push(message);
  await openPortable(toast, async () => null);
  assert.deepEqual(toasts, []);
  await openPortable(toast, async () => new File(['{}'], 'layout.fig'));
  assert.deepEqual(toasts, ['Only .rdesign files can be opened.']);
});
