import {useCallback} from 'react';
import type {DesignDocument, NodeId, Vec} from '../../../shared/design/types';
import type {CommandContext} from '../engine/commands';
import {HIT_TOLERANCE_PX} from '../engine/hit-test';
import {layerMenuItems} from '../panels/left';
import {layerIcon} from '../ui/icons';
import {useContextMenu} from '../ui/Menu';
import {isPhone} from '../ui/viewport';
import {tidySeparators, type MenuItem} from '../ui/menu-model';
import type {CommandLookup} from './chrome/commands';
import {applicable} from './context-menu-model';
import {layersAt} from './command-bridge';
import type {EditorSession} from './editor-session';

// The canvas's right-click menu, built from the same command lookup as the main menu so it offers
// exactly what is registered: with a selection, Figma's order (clipboard, "Select layer ▸" with
// the layers under the pointer, grouping, components, order, flips, visibility); on the empty canvas,
// pasting, the interface and the zoom. Items a feature has not registered yet are left out.

export type CanvasMenuRequest = {clientX: number; clientY: number};

export type CanvasMenuDeps = {
  session: EditorSession;
  lookup: CommandLookup;
  /** The pointer in page space (from the canvas's view helpers). */
  pageAt(clientX: number, clientY: number): Vec | null;
  zoom(): number;
  pasteHere(point: Vec): void;
  /** The canvas's command context (the row menu's commands run in it). */
  context(): CommandContext;
  /** "Rename" from the menu: the layers panel puts the name in edit. */
  rename(id: NodeId): void;
  /** A comment pinned at this page point (absent: the file takes no comments). Offered on a phone only (PhoneEditorLayout). */
  commentAt?(point: Vec): void;
};

/** One registered command as a menu row (label override for state-dependent wording). */
function commandItem(lookup: CommandLookup, id: string, label?: string): MenuItem | null {
  const command = lookup(id);
  if (!command) return null;
  return {
    id,
    label: label ?? command.label,
    shortcut: command.shortcut,
    disabled: command.enabled ? !command.enabled() : false,
    ...(command.checked ? {checked: command.checked()} : {}),
    onSelect: command.run,
  };
}

function submenu(id: string, label: string, items: (MenuItem | null)[]): MenuItem | null {
  const present = tidySeparators(items.filter((item): item is MenuItem => !!item));
  return present.some(item => item.type !== 'separator') ? {type: 'submenu', id, label, items: present} : null;
}

const SEPARATOR: MenuItem = {type: 'separator'};

/** The menu for the current selection (or the empty canvas), with `under` the layers at the pointer. */
export function canvasMenuItems(input: {
  doc: DesignDocument;
  selection: readonly NodeId[];
  under: readonly NodeId[];
  lookup: CommandLookup;
  pasteHere: () => void;
  selectLayer: (id: NodeId) => void;
  /** The layers panel's row menu for this selection (`layerMenuItems`). */
  shared: readonly MenuItem[];
  /** "Comment here", first on the empty canvas: a phone's long press leads to a comment as in Figma's app. */
  commentHere?: () => void;
}): MenuItem[] {
  const {doc, selection, under, lookup} = input;
  // Like Figma's, the menu offers what applies to this selection: a command that cannot run on it
  // ("Ungroup" on a circle) is left out rather than greyed.
  const item = (id: string, label?: string) => {
    const entry = commandItem(lookup, id, label);
    return entry && entry.type !== 'separator' && 'disabled' in entry && entry.disabled ? null : entry;
  };
  const pasteHere: MenuItem = {id: 'edit.paste-here', label: 'Paste here', onSelect: input.pasteHere};
  const selected = selection.map(id => doc.nodes[id]).filter(node => !!node);

  if (!selected.length) {
    return tidySeparators([
      ...(input.commentHere ? [{id: 'comment.here', label: 'Comment here', onSelect: input.commentHere}, SEPARATOR] : []),
      pasteHere,
      item('edit.select-all'),
      SEPARATOR,
      item('view.toggle-ui'),
      item('view.rulers'),
      submenu('menu:zoom', 'Zoom', [item('view.zoom-in'), item('view.zoom-out'), SEPARATOR, item('view.zoom-fit'), item('view.zoom-100')]),
    ].filter((entry): entry is MenuItem => !!entry));
  }

  const layers = under.length > 1 || (under.length === 1 && !selection.includes(under[0]))
    ? submenu('menu:select-layer', 'Select layer', under.map(id => {
      const node = doc.nodes[id];
      const Icon = layerIcon(node.type, {mask: node.isMask, image: node.fills.some(fill => fill.type === 'IMAGE'), layout: node.autoLayout?.layoutMode});
      return {id: 'layer:' + id, label: node.name || 'Untitled', icon: <Icon />, checked: selection.includes(id), onSelect: () => input.selectLayer(id)};
    }))
    : null;

  // The layers panel's row menu (panels/left LAYER_MENU) is the core, so both menus run the same
  // commands; the canvas adds what only it can: paste at the pointer, "Copy as", the layers
  // under the pointer, flips and the component commands the row menu leaves out.
  const items: MenuItem[] = applicable(input.shared);
  const present = new Set(items.flatMap(entry => ('id' in entry ? [entry.id] : [])));
  const fresh = (entry: MenuItem | null) => entry && !('id' in entry && present.has(entry.id)) ? entry : null;
  const list = (...entries: (MenuItem | null)[]) => entries.map(fresh).filter((entry): entry is MenuItem => !!entry);
  const indexOf = (ids: readonly string[]) => items.findIndex(entry => 'id' in entry && ids.includes(entry.id));

  const paste = indexOf(['edit.paste', 'paste']);
  items.splice(paste >= 0 ? paste + 1 : 0, 0, ...list(pasteHere, item('edit.paste-over'), item('edit.paste-replace'),
    submenu('menu:copy-as', 'Copy as', [item('edit.copy-text'), item('edit.copy-css'), item('edit.copy-svg'), item('edit.copy-png'), item('edit.copy-link')])));
  if (layers) {
    const firstBreak = items.findIndex(entry => entry.type === 'separator');
    items.splice(firstBreak >= 0 ? firstBreak + 1 : items.length, 0, layers, SEPARATOR);
  }
  const extras = list(
    submenu('menu:flip', 'Flip', [item('object.flip-horizontal'), item('object.flip-vertical'), SEPARATOR, item('object.rotate-180'), item('object.rotate-90-cw'), item('object.rotate-90-ccw')]),
    item('object.remove-auto-layout'),
    item('object.create-multiple-components'),
    item('object.combine-variants'),
    item('object.add-variant'),
    item('object.create-instance'),
    item('object.push-to-main'),
    item('object.restore-component'),
    item('object.select-instances'),
  );
  if (extras.length) {
    const tail = indexOf(['layers.rename', 'layers.toggle-visible']);
    items.splice(tail >= 0 ? tail : items.length, 0, ...extras, SEPARATOR);
  }
  return tidySeparators(items);
}

/** The canvas's context menu: `open` it from CanvasView's `onContextMenu`, render `element`. */
export function useCanvasContextMenu(deps: CanvasMenuDeps) {
  const menu = useContextMenu();
  const {session, lookup, pageAt, zoom, pasteHere, context, rename, commentAt} = deps;
  const open = useCallback((request: CanvasMenuRequest) => {
    const {store} = session;
    const state = store.getState();
    const point = pageAt(request.clientX, request.clientY);
    const under = point ? layersAt(state.doc, state.pageId, point, HIT_TOLERANCE_PX / Math.max(zoom(), 1e-6), session.spatialIndex(state.doc, state.pageId)) : [];
    const items = canvasMenuItems({
      doc: state.doc,
      selection: state.selection,
      under,
      lookup,
      pasteHere: () => {
        if (point) pasteHere(point);
      },
      selectLayer: id => {
        store.setContext(null);
        store.setSelection([id]);
      },
      shared: state.selection.length ? layerMenuItems(context(), {onRename: rename}) : [],
      commentHere: commentAt && point && isPhone() ? () => commentAt(point) : undefined,
    });
    if (items.length) menu.open({x: request.clientX, y: request.clientY}, items);
  }, [menu, session, lookup, pageAt, zoom, pasteHere, context, rename, commentAt]);
  return {open, element: menu.element, isOpen: menu.isOpen};
}
