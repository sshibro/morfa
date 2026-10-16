import type {NodeId} from '../../../../shared/design/types';
import {moveSelectionToPage, moveTargets} from '../../engine/commands/arrange';
import {getCommand, isEnabled, registerCommand, type Command, type CommandContext, type Shortcut} from '../../engine/commands/registry';
import type {DesignStore} from '../../engine/store';
import {editNodes} from '../../engine/user-edit';
import type {MenuItem} from '../../ui/menu-model';
import {tidySeparators} from '../../ui/menu-model';
import {layerTreeState} from './tree-state';

// The left panel's commands, and the row menu of the layers panel built from the command registry:
// the same commands the canvas menu runs, under the ids of MAIN_MENU (`object.group`) or the engine's
// own (`group`), whichever is registered. Anything not registered is left out.

/** "Collapse all layers" (⌥L) and "Rename" (⌘R; several layers: "Rename layers") for the layers panel. */
export const LEFT_PANEL_COMMANDS: Command[] = [
  {
    id: 'layers.collapse-all',
    label: 'Collapse all layers',
    group: 'layers',
    shortcut: {code: 'KeyL', alt: true},
    run: ctx => layerTreeState(ctx.store).collapseAll(),
  },
  {
    id: 'layers.rename',
    label: 'Rename',
    group: 'layers',
    shortcut: {code: 'KeyR', mod: true},
    enabled: ctx => ctx.store.getState().selection.length > 0,
    run: ctx => {
      const {selection} = ctx.store.getState();
      // Several layers: "Rename layers" (names, numbers, find and replace), as Figma's ⌘R.
      if (selection.length > 1 && layerTreeState(ctx.store).requestBatchRename(selection)) return;
      const last = selection.at(-1);
      if (last) layerTreeState(ctx.store).requestRename(last);
    },
  },
];

let registered = false;
/** Idempotent; the layers panel calls it when it mounts. */
export function registerLeftPanelCommands() {
  if (registered) return;
  registered = true;
  for (const command of LEFT_PANEL_COMMANDS) registerCommand(command);
}

/** 'Mod+Shift+KeyG' from the registry's shortcut object (the menus' string format, ui/shortcuts.ts). */
export function shortcutString(shortcut: Shortcut | undefined): string | undefined {
  if (!shortcut) return undefined;
  return [shortcut.ctrl && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', shortcut.mod && 'Mod', shortcut.code].filter(Boolean).join('+');
}

/** Each entry: a command id with its fallbacks, '-' for a separator, or a labelled submenu (`id`: the canvas menu's own id
 *  for the same submenu, so it is not offered twice). */
export type LayerMenuEntry = readonly string[] | '-' | {label: string; items: readonly LayerMenuEntry[]; id?: string};

/** The row menu of the layers panel in Figma's order (the canvas's context menu may share it). */
export const LAYER_MENU: readonly LayerMenuEntry[] = [
  ['edit.copy', 'copy'], ['edit.cut', 'cut'], ['edit.paste', 'paste'],
  {label: 'Copy as', id: 'menu:copy-as', items: [['edit.copy-text'], ['edit.copy-css'], ['edit.copy-svg'], ['edit.copy-png'], ['edit.copy-link']]},
  ['edit.duplicate', 'duplicate'], '-',
  ['object.bring-to-front', 'bring-to-front'], ['object.bring-forward', 'bring-forward'], ['object.send-backward', 'send-backward'], ['object.send-to-back', 'send-to-back'], '-',
  ['object.group', 'group'], ['object.frame-selection', 'frame-selection'], ['object.ungroup', 'ungroup'],
  ['object.flatten', 'flatten'], ['object.outline-stroke', 'outline-stroke'], ['object.mask', 'mask'],
  {label: 'Boolean operations', items: [['object.boolean-union', 'boolean-union'], ['object.boolean-subtract', 'boolean-subtract'], ['object.boolean-intersect', 'boolean-intersect'], ['object.boolean-exclude', 'boolean-exclude']]},
  '-',
  ['object.auto-layout', 'auto-layout'], ['object.create-component', 'create-component'], ['object.go-to-main', 'go-to-main'],
  ['object.reset-instance', 'reset-instance'], ['object.detach-instance', 'detach-instance'], '-',
  ['edit.copy-properties', 'copy-properties'], ['edit.paste-properties', 'paste-properties'], '-',
];

export const findCommand = (ids: readonly string[]) => {
  for (const id of ids) {
    const command = getCommand(id);
    if (command) return command;
  }
  return undefined;
};

function itemsOf(entries: readonly LayerMenuEntry[], ctx: CommandContext, path: string): MenuItem[] {
  const items: MenuItem[] = [];
  entries.forEach((entry, index) => {
    if (entry === '-') {
      items.push({type: 'separator'});
    } else if (Array.isArray(entry)) {
      const command = findCommand(entry);
      if (!command) return;
      items.push({id: command.id, label: command.label, shortcut: shortcutString(command.shortcut), disabled: !isEnabled(command, ctx), onSelect: () => void command.run(ctx)});
    } else {
      const sub = entry as {label: string; items: readonly LayerMenuEntry[]; id?: string};
      const children = itemsOf(sub.items, ctx, `${path}${index}.`);
      if (children.some(child => child.type !== 'separator')) items.push({type: 'submenu', id: sub.id ?? `layer-menu:${path}${index}`, label: sub.label, items: children});
    }
  });
  return items;
}

/** The row menu for the current selection: registered commands, then rename, visibility, lock and delete. */
export function layerMenuItems(ctx: CommandContext, options: {onRename: (id: NodeId) => void}): MenuItem[] {
  const store = ctx.store;
  const {doc, selection} = store.getState();
  const nodes = selection.map(id => doc.nodes[id]).filter(Boolean);
  const anyVisible = nodes.some(node => node.visible);
  const anyUnlocked = nodes.some(node => !node.locked);
  const last = selection.at(-1);
  const remove = findCommand(['edit.delete', 'delete']);
  // "Move to page ▸", as in Figma: the file's other pages.
  const pages = moveTargets(ctx);
  const items: MenuItem[] = [
    ...itemsOf(LAYER_MENU, ctx, ''),
    ...(pages.length ? [{type: 'submenu', id: 'layers.move-to-page', label: 'Move to page', items: pages.map(id => ({id: 'move-to-page:' + id, label: doc.nodes[id]?.name || 'Page', onSelect: () => moveSelectionToPage(ctx, id)}))} satisfies MenuItem] : []),
    ...(last && selection.length === 1 ? [{id: 'layers.rename', label: 'Rename', shortcut: 'Mod+KeyR', onSelect: () => options.onRename(last)} satisfies MenuItem] : []),
    {id: 'layers.toggle-visible', label: anyVisible ? 'Hide' : 'Show', shortcut: 'Shift+Mod+KeyH', disabled: !nodes.length, onSelect: () => setVisible(store, selection, !anyVisible)},
    {id: 'layers.toggle-lock', label: anyUnlocked ? 'Lock' : 'Unlock', shortcut: 'Shift+Mod+KeyL', disabled: !nodes.length, onSelect: () => setLocked(store, selection, anyUnlocked)},
    {type: 'separator'},
    ...(remove ? [{id: remove.id, label: remove.label, shortcut: 'Delete', danger: true, disabled: !isEnabled(remove, ctx), onSelect: () => void remove.run(ctx)} satisfies MenuItem] : []),
  ];
  return tidySeparators(items);
}

export function setVisible(store: DesignStore, ids: readonly NodeId[], visible: boolean) {
  editNodes(store, visible ? 'Show' : 'Hide', ids, node => (node.visible === visible ? null : {visible}));
}

export function setLocked(store: DesignStore, ids: readonly NodeId[], locked: boolean) {
  editNodes(store, locked ? 'Lock' : 'Unlock', ids, node => (node.locked === locked ? null : {locked}));
}
