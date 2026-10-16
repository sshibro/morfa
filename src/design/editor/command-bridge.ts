import type {DesignDocument, NodeId, SceneNode, Vec} from '../../../shared/design/types';
import {invert, multiply, rotationMatrix, toRadians, translation, worldMatrix} from '../../../shared/design/geometry';
import {placementChanges, placementFor} from '../../../shared/design/transaction';
import {childrenOf, commonParent, forEachDescendant, isFrameLikeNode, isLockedInTree, isVisibleInTree, sortByPaintOrder, type SpatialIndex} from '../../../shared/design/tree';
import {choosePasteTarget, pastePayload, resolvePayload} from '../engine/clipboard';
import {getCommand, isEnabled, listCommands, nudge, pasteData, registerCommand, registerCoreCommands, type Command, type CommandContext, type Shortcut} from '../engine/commands';
import {detachForeignInstances, reportDetached} from '../engine/commands/clipboard';
import {hitsNode} from '../engine/hit-test';
import {isMacPlatform} from '../engine/keyboard';
import {movableSelection, selectionBounds} from '../engine/selection';
import {panByArrows} from '../engine/commands/view';
import {hasTool, registerCoreTools} from '../engine/tools';
import {parseShortcut} from '../ui/shortcuts';
import {MAIN_MENU, type ChromeCommand, type CommandLookup, type MainMenuSection} from './chrome/commands';
import {MODES, TOOLS, type EditorMode, type ToolId} from './chrome/tools';
import {getPreferences, setPreferences} from './preferences';
import {canSelectSame, SAME_LABELS, selectSame, type SameKind} from '../engine/select-same';
import {variantMultiEdit} from '../engine/variant-multi-edit';

// Where the chrome's main menu (ids like `edit.undo`, `object.group`) meets the engine's command
// registry (ids like `undo`, `group`): a menu id is looked up as itself first, so a feature that
// registers `object.boolean-union` appears in the menu the day it lands, then through the alias
// table below. The editor's own generic commands (file, view toggles, selection, panels, help) are
// registered here under their menu ids, and one command per toolbar tool binds its key.

// ── Menu ids ↔ engine ids ────────────────────────────────────────────────────────────────────────

/** Main-menu ids whose work an engine command does under its own id. */
export const MENU_ALIASES: Readonly<Record<string, string>> = {
  'edit.undo': 'undo',
  'edit.redo': 'redo',
  'edit.copy': 'copy',
  'edit.cut': 'cut',
  'edit.paste': 'paste',
  'edit.paste-over': 'paste-in-place',
  'edit.duplicate': 'duplicate',
  'edit.delete': 'delete',
  'edit.select-all': 'select-all',
  'object.frame-selection': 'frame-selection',
  'object.group': 'group',
  'object.ungroup': 'ungroup',
  'object.select-parent': 'select-parent',
  'object.lock': 'toggle-lock',
  'object.hide': 'toggle-visible',
  'object.bring-to-front': 'bring-to-front',
  'object.bring-forward': 'bring-forward',
  'object.send-backward': 'send-backward',
  'object.send-to-back': 'send-to-back',
  'object.flip-horizontal': 'flip-horizontal',
  'object.flip-vertical': 'flip-vertical',
  'view.zoom-in': 'zoom-in',
  'view.zoom-out': 'zoom-out',
  'view.zoom-100': 'zoom-100',
  'view.zoom-fit': 'zoom-fit',
  'view.zoom-selection': 'zoom-selection',
};

/** The registered command a menu id stands for, if any. */
export const resolveCommand = (id: string): Command | undefined => getCommand(id) ?? (MENU_ALIASES[id] ? getCommand(MENU_ALIASES[id]) : undefined);

/** The engine's shortcut in the chrome's string form ('Shift+Mod+KeyZ'). */
export function shortcutString(shortcut: Shortcut): string {
  return [shortcut.ctrl && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', shortcut.mod && 'Mod', shortcut.code].filter(Boolean).join('+');
}

/** The chrome's shortcut string as the engine's Shortcut. */
export function shortcutFrom(text: string): Shortcut | undefined {
  const parsed = parseShortcut(text);
  if (!parsed) return undefined;
  const out: Shortcut = {code: parsed.code};
  if (parsed.mod) out.mod = true;
  if (parsed.shift) out.shift = true;
  if (parsed.alt) out.alt = true;
  if (parsed.ctrl) out.ctrl = true;
  return out;
}

/** Runs a command, reporting a failure (a rejected clipboard, a lost connection) instead of throwing. */
export function runSafely(command: Command, ctx: CommandContext, onError?: (error: unknown) => void) {
  try {
    const result = command.run(ctx);
    if (result && typeof (result as Promise<void>).catch === 'function') (result as Promise<void>).catch(error => onError?.(error));
  } catch (error) {
    onError?.(error);
  }
}

/** The chrome's view of a registered command, run in the canvas's current command context. */
export function chromeCommand(id: string, command: Command, context: () => CommandContext, onError?: (error: unknown) => void): ChromeCommand {
  return {
    id,
    label: command.label,
    shortcut: command.shortcut ? shortcutString(command.shortcut) : undefined,
    run: () => runSafely(command, context(), onError),
    enabled: command.enabled ? () => isEnabled(command, context()) : undefined,
    checked: command.checked ? () => command.checked!(context()) : undefined,
  };
}

/** The lookup EditorLayout's main menu (and the context menu) read: registered ids first, then aliases. */
export function createCommandLookup(context: () => CommandContext, onError?: (error: unknown) => void): CommandLookup {
  return id => {
    const command = resolveCommand(id);
    return command ? chromeCommand(id, command, context, onError) : undefined;
  };
}

/** Menu ids that would show today and those still waiting for their feature (for reports and tests). */
export function menuCoverage(menu: readonly MainMenuSection[] = MAIN_MENU): {wired: string[]; waiting: string[]} {
  const ids: string[] = [];
  const collect = (entries: MainMenuSection['items']) => {
    for (const entry of entries) {
      if (entry === '-') continue;
      if (typeof entry === 'object') collect(entry.items);
      else ids.push(entry);
    }
  };
  for (const section of menu) collect(section.items);
  return {wired: ids.filter(id => resolveCommand(id)), waiting: ids.filter(id => !resolveCommand(id))};
}

// ── The editor's own commands ────────────────────────────────────────────────────────────────────

/** What the commands below need from the open editor. Bound while it is mounted. */
export type EditorCommandHost = {
  renameFile(): void;
  newFile(): void;
  duplicateFile(): void;
  trashFile(): void;
  showLeftTab(tab: 'file' | 'assets'): void;
  toggleQuickActions(): void;
  openDialog(id: string): void;
  selectTool(id: ToolId): void;
  /** The mode at the toolbar's right end (the right panel's tab, or "Draw"), and the modes this person has. */
  mode(): EditorMode;
  modes(): readonly EditorMode[];
  setMode(mode: EditorMode): void;
};

let host: EditorCommandHost | null = null;

/** Binds the open editor's side effects; returns the unbinding. */
export function bindCommandHost(next: EditorCommandHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

const hosted = (run: (h: EditorCommandHost, ctx: CommandContext) => void) => (ctx: CommandContext) => {
  if (host) run(host, ctx);
};
const hasHost = () => host !== null;
const ui = (ctx: CommandContext) => ctx.store.getState().ui;
const toggleUI = (key: 'outlines' | 'layoutGrids' | 'cardZones' | 'rulers' | 'pixelGrid' | 'snapToPixel' | 'pixelPreview' | 'showUI' | 'minimizeUI' | 'multiplayerCursors') => (ctx: CommandContext) =>
  ctx.store.setUI({[key]: !ui(ctx)[key]});

/** "Select inverse": the visible, unlocked layers beside the selection (in the same parent) that are
 *  not selected; with nothing selected, everything in the entered group or on the page. */
export function inverseSelection(doc: DesignDocument, pageId: NodeId, selection: readonly NodeId[], context: NodeId | null): NodeId[] {
  const scope = (selection.length ? commonParent(doc, selection) : null) ?? context ?? pageId;
  const selected = new Set(selection);
  return childrenOf(doc, scope).filter(id => !selected.has(id) && doc.nodes[id]?.visible && !doc.nodes[id]?.locked);
}

/** What makes two layers "matching": their type, component and look (paints, stroke, effects, corners,
 *  type style), not their place, size or name. */
export function matchSignature(node: SceneNode): string {
  return JSON.stringify([
    node.type, node.componentId ?? null, node.fills, node.strokes, node.strokes.length ? node.strokeWeight : 0, node.effects, node.cornerRadius ?? null,
    node.opacity, node.blendMode, node.text ? [node.text.style, node.text.textAlignHorizontal] : null,
  ]);
}

/** "Select matching layers": every visible, unlocked layer of the page that looks like a selected one
 *  (outermost matches only: a match's own children are not added). */
export function matchingSelection(doc: DesignDocument, pageId: NodeId, selection: readonly NodeId[]): NodeId[] {
  const signatures = new Set(selection.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && node.type !== 'PAGE').map(matchSignature));
  if (!signatures.size) return [...selection];
  const out: NodeId[] = [];
  forEachDescendant(doc, pageId, node => {
    if (!node.visible || node.locked) return false;
    if (signatures.has(matchSignature(node))) {
      out.push(node.id);
      return false;
    }
    return undefined;
  });
  return out;
}

/** Turns the movable part of the selection about its centre by `degrees` clockwise on screen. */
export function rotateSelection(ctx: CommandContext, degrees: number, label: string) {
  const {doc, selection} = ctx.store.getState();
  const ids = movableSelection(doc, selection);
  const bounds = selectionBounds(doc, ids);
  if (!bounds) return;
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  const turn = multiply(multiply(translation(cx, cy), rotationMatrix(toRadians(degrees))), translation(-cx, -cy));
  ctx.store.transact(label, tx => {
    for (const id of ids) {
      const node = doc.nodes[id];
      const local = multiply(invert(worldMatrix(doc, node.parentId!)), multiply(turn, worldMatrix(doc, id)));
      tx.update(id, placementChanges(node, placementFor(node, local)));
    }
  });
}

/** "Paste here": the copied layers centred on `point` (page space), in the frame under it. Null when
 *  there was nothing to paste (other content goes to the registered paste handlers). */
export async function pasteAt(ctx: CommandContext, point: Vec, readText: () => Promise<string | null> = readSystemClipboard): Promise<NodeId[] | null> {
  const text = await readText();
  const payload = resolvePayload(text);
  if (!payload) return pasteData(ctx, {text, html: null, files: []}, false);
  const state = ctx.store.getState();
  const target = choosePasteTarget(state.doc, state.pageId, [], payload, {center: point, visible: {x: point.x, y: point.y, width: 0, height: 0}, index: ctx.index?.() ?? null}, false);
  let created: NodeId[] = [];
  let detached = 0;
  ctx.store.transact('Paste', tx => {
    created = pastePayload(tx, payload, target);
    detached = detachForeignInstances(tx, payload, created);
    return {select: created};
  });
  reportDetached(ctx.store, detached);
  return created;
}

async function readSystemClipboard(): Promise<string | null> {
  try {
    return (await globalThis.navigator?.clipboard?.readText()) ?? null;
  } catch {
    return null;
  }
}

/** Layers under a page point, front first, as "Select layer ▸" lists them: visible and unlocked,
 *  not clipped away by a frame above them. */
export function layersAt(doc: DesignDocument, pageId: NodeId, point: Vec, tolerance: number, index: SpatialIndex | null, limit = 24): NodeId[] {
  const reach = Math.max(0, tolerance);
  const candidates: Iterable<NodeId> = index
    ? index.query({x: point.x - reach, y: point.y - reach, width: reach * 2, height: reach * 2})
    : (() => {
      const all: NodeId[] = [];
      forEachDescendant(doc, pageId, node => void all.push(node.id));
      return all;
    })();
  const clipped = new Map<NodeId, boolean>();
  const outsideClip = (id: NodeId): boolean => {
    for (let parent = doc.nodes[doc.nodes[id]?.parentId ?? '']; parent && parent.type !== 'PAGE'; parent = doc.nodes[parent.parentId ?? '']) {
      if (!isFrameLikeNode(parent) || parent.clipsContent === false) continue;
      let out = clipped.get(parent.id);
      if (out === undefined) clipped.set(parent.id, (out = !hitsNode(doc, parent.id, point, 0)));
      if (out) return true;
    }
    return false;
  };
  const hits: NodeId[] = [];
  for (const id of candidates) {
    const node = doc.nodes[id];
    if (!node || node.type === 'PAGE' || !isVisibleInTree(doc, id) || isLockedInTree(doc, id)) continue;
    if (!hitsNode(doc, id, point, tolerance) || outsideClip(id)) continue;
    hits.push(id);
  }
  return sortByPaintOrder(doc, hits).reverse().slice(0, limit);
}

const mac = isMacPlatform();

/** Commands that read only the store and the preferences, registered once (they stay registered: the
 *  engine's own registration also runs once per page load). */
// F6 / ⇧F6 (also with Ctrl, Figma's key on Windows): focus moves between the editor's regions — the canvas, the toolbar,
// the left panel, the right panel — as Figma's keyboard controls (help.figma.com "Use Figma products with a keyboard").
// In each region focus lands where the arrows work: the pressed tool, the layers tree, the selected tab.
const FOCUS_REGIONS = ['canvas', 'toolbar', 'left', 'right'] as const;
type FocusRegion = (typeof FOCUS_REGIONS)[number];

function regionOf(element: Element | null): FocusRegion {
  if (element?.closest('[role="toolbar"][aria-label="Tools"]')) return 'toolbar';
  if (element?.closest('.dz-left')) return 'left';
  if (element?.closest('.dz-right')) return 'right';
  return 'canvas';
}

function focusRegion(region: FocusRegion): boolean {
  if (region === 'canvas') {
    (document.activeElement as HTMLElement | null)?.blur?.();
    return true;
  }
  const root = region === 'toolbar' ? document.querySelector('[role="toolbar"][aria-label="Tools"]') : document.querySelector(region === 'left' ? '.dz-left' : '.dz-right');
  if (!root) return false;
  const preferred = region === 'toolbar' ? root.querySelector<HTMLElement>('button[aria-pressed="true"]')
    : root.querySelector<HTMLElement>('[role="tree"], [role="tab"][aria-selected="true"]');
  const target = preferred ?? root.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"], input:not(:disabled)');
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}

function cycleFocus(step: 1 | -1) {
  if (typeof document === 'undefined') return;
  let index = FOCUS_REGIONS.indexOf(regionOf(document.activeElement));
  for (let tries = 0; tries < FOCUS_REGIONS.length; tries++) {
    index = (index + step + FOCUS_REGIONS.length) % FOCUS_REGIONS.length;
    if (focusRegion(FOCUS_REGIONS[index])) return;
  }
}

const GENERIC_COMMANDS: Command[] = [
  {id: 'object.multi-edit-variants', label: 'Edit all variants', group: 'components',
    enabled: ctx => !!variantMultiEdit(ctx.store.getState().doc, ctx.store.getState().selection),
    run: ctx => {
      const next = variantMultiEdit(ctx.store.getState().doc, ctx.store.getState().selection);
      if (next) ctx.store.setSelection(next);
    }},
  {id: 'view.focus-next-region', label: 'Next region', group: 'view', shortcut: {code: 'F6'}, alternates: [{code: 'F6', ctrl: true}], run: () => cycleFocus(1)},
  {id: 'view.focus-previous-region', label: 'Previous region', group: 'view', shortcut: {code: 'F6', shift: true}, alternates: [{code: 'F6', ctrl: true, shift: true}], run: () => cycleFocus(-1)},
  // Edit
  {id: 'edit.select-none', label: 'Deselect all', group: 'select', enabled: ctx => ctx.store.getState().selection.length > 0, run: ctx => {
    ctx.store.setSelection([]);
    ctx.store.setContext(null);
  }},
  {id: 'edit.select-inverse', label: 'Select inverse', group: 'select', shortcut: {code: 'KeyA', mod: true, shift: true}, run: ctx => {
    const {doc, pageId, selection, context} = ctx.store.getState();
    ctx.store.setSelection(inverseSelection(doc, pageId, selection, context));
  }},
  {id: 'edit.select-matching', label: 'Select matching layers', group: 'select', shortcut: {code: 'KeyA', mod: true, alt: true},
    enabled: ctx => ctx.store.getState().selection.length > 0,
    run: ctx => {
      const {doc, pageId, selection} = ctx.store.getState();
      ctx.store.setContext(null);
      ctx.store.setSelection(matchingSelection(doc, pageId, selection));
    }},
  // "Select all with same" (Figma's Edit ▸ Select all with same …): engine/select-same.ts.
  ...(Object.keys(SAME_LABELS) as SameKind[]).map((kind): Command => ({
    id: `edit.select-same-${kind}`, label: SAME_LABELS[kind], group: 'select',
    enabled: ctx => canSelectSame(ctx.store.getState().doc, ctx.store.getState().selection, kind),
    run: ctx => {
      const {doc, pageId, selection} = ctx.store.getState();
      ctx.store.setContext(null);
      ctx.store.setSelection(selectSame(doc, pageId, selection, kind));
    },
  })),
  // Object
  {id: 'object.rotate-180', label: 'Rotate 180°', group: 'arrange', enabled: ctx => movableSelection(ctx.store.getState().doc, ctx.store.getState().selection).length > 0, run: ctx => rotateSelection(ctx, 180, 'Rotate 180°')},
  {id: 'object.rotate-90-cw', label: 'Rotate 90° clockwise', group: 'arrange', enabled: ctx => movableSelection(ctx.store.getState().doc, ctx.store.getState().selection).length > 0, run: ctx => rotateSelection(ctx, 90, 'Rotate 90°')},
  {id: 'object.rotate-90-ccw', label: 'Rotate 90° counterclockwise', group: 'arrange', enabled: ctx => movableSelection(ctx.store.getState().doc, ctx.store.getState().selection).length > 0, run: ctx => rotateSelection(ctx, -90, 'Rotate 90°')},
  // View
  {id: 'view.pixel-grid', label: 'Pixel grid', group: 'view', shortcut: {code: 'Quote', shift: true}, checked: ctx => ui(ctx).pixelGrid, run: toggleUI('pixelGrid')},
  {id: 'view.snap-pixel-grid', label: 'Snap to pixel grid', group: 'view', shortcut: {code: 'Quote', shift: true, mod: true}, checked: ctx => ui(ctx).snapToPixel, run: toggleUI('snapToPixel')},
  {id: 'view.layout-grids', label: 'Layout grids', group: 'view', shortcut: mac ? {code: 'KeyG', ctrl: true} : {code: 'Digit4', mod: true, shift: true}, checked: ctx => ui(ctx).layoutGrids, run: toggleUI('layoutGrids')},
  // "Marketplaces" (docs/marketplaces.md §Badge zones): the badges, price and favourite icon a marketplace lays over each card frame.
  {id: 'view.card-zones', label: 'Marketplace badge zones', group: 'view', checked: ctx => ui(ctx).cardZones, run: toggleUI('cardZones')},
  {id: 'view.rulers', label: 'Rulers', group: 'view', shortcut: {code: 'KeyR', shift: true}, checked: ctx => ui(ctx).rulers, run: toggleUI('rulers')},
  {id: 'view.outlines', label: 'Outline mode', group: 'view', shortcut: {code: 'KeyY', mod: true}, checked: ctx => ui(ctx).outlines, run: toggleUI('outlines')},
  {id: 'view.pixel-preview', label: 'Pixel preview', group: 'view', checked: ctx => ui(ctx).pixelPreview, run: toggleUI('pixelPreview')},
  // Figma's View ▸ Multiplayer cursors (⌥⌘\): hides the others' cursors, not their selections.
  {id: 'view.multiplayer-cursors', label: 'Multiplayer cursors', group: 'view', shortcut: {code: 'Backslash', mod: true, alt: true}, checked: ctx => ui(ctx).multiplayerCursors, run: toggleUI('multiplayerCursors')},
  // ⌘. as well as ⌘\ (Figma takes both: the backslash sits awkwardly on many layouts).
  {id: 'view.toggle-ui', label: 'Show/hide UI', group: 'view', shortcut: {code: 'Backslash', mod: true}, alternates: [{code: 'Period', mod: true}], run: toggleUI('showUI')},
  // Figma's "Minimize UI": the panels fold into floating bars; the toolbar stays. Shows the interface if ⌘\ hid it.
  {id: 'view.minimize-ui', label: 'Minimize UI', group: 'view', shortcut: {code: 'Backslash', shift: true}, checked: ctx => ui(ctx).minimizeUI, run: ctx => ctx.store.setUI({minimizeUI: !ui(ctx).minimizeUI, showUI: true})},
  {id: 'view.page-previous', label: 'Previous page', group: 'view', shortcut: {code: 'PageUp'}, enabled: ctx => pageStep(ctx, -1) !== null, run: ctx => {
    const page = pageStep(ctx, -1);
    if (page) ctx.store.setPage(page);
  }},
  {id: 'view.page-next', label: 'Next page', group: 'view', shortcut: {code: 'PageDown'}, enabled: ctx => pageStep(ctx, 1) !== null, run: ctx => {
    const page = pageStep(ctx, 1);
    if (page) ctx.store.setPage(page);
  }},
  // Preferences
  {id: 'pref.snap-objects', label: 'Snap to objects', group: 'preferences', checked: () => getPreferences().snapToObjects, run: () => setPreferences({snapToObjects: !getPreferences().snapToObjects})},
  {id: 'pref.hover-sizes', label: 'Show sizes on hover', group: 'preferences', checked: () => getPreferences().hoverSizes, run: () => setPreferences({hoverSizes: !getPreferences().hoverSizes})},
];

function pageStep(ctx: CommandContext, step: 1 | -1): NodeId | null {
  const {doc, pageId} = ctx.store.getState();
  const at = doc.pages.indexOf(pageId);
  return doc.pages[at + step] ?? null;
}

const MODE_COMMAND_LABELS: Record<EditorMode, string> = {draw: 'Draw mode', design: 'Design mode', prototype: 'Prototype mode', code: 'Dev Mode'};

/** Commands that act on the open editor (its file, panels and dialogs): enabled while one is bound. */
const HOSTED_COMMANDS: Command[] = [
  {id: 'file.new', label: 'New file', group: 'file', enabled: hasHost, run: hosted(h => h.newFile())},
  {id: 'file.duplicate', label: 'Duplicate file', group: 'file', enabled: hasHost, run: hosted(h => h.duplicateFile())},
  {id: 'file.rename', label: 'Rename', group: 'file', enabled: hasHost, run: hosted(h => h.renameFile())},
  {id: 'file.trash', label: 'Move to trash', group: 'file', enabled: hasHost, run: hosted(h => h.trashFile())},
  {id: 'view.panel-layers', label: 'Layers', group: 'view', shortcut: {code: 'Digit1', alt: true}, enabled: hasHost, run: hosted(h => h.showLeftTab('file'))},
  {id: 'view.panel-assets', label: 'Assets', group: 'view', shortcut: {code: 'Digit2', alt: true}, enabled: hasHost, run: hosted(h => h.showLeftTab('assets'))},
  // "Actions" (Figma's Actions): ⌘K as in Figma, and ⌘/ and ⌘P, which opened quick actions before.
  {id: 'app.quick-actions', label: 'Actions', group: 'help', shortcut: {code: 'KeyK', mod: true}, alternates: [{code: 'Slash', mod: true}, {code: 'KeyP', mod: true}], enabled: hasHost, run: hosted(h => h.toggleQuickActions())},
  // The modes at the toolbar's right end, each only where the person has it. ⇧D toggles "Code" (Figma's Dev Mode) and "Design".
  ...MODES.map((spec): Command => ({
    id: 'view.mode-' + spec.id,
    label: MODE_COMMAND_LABELS[spec.id],
    group: 'view',
    shortcut: spec.shortcut ? shortcutFrom(spec.shortcut) : undefined,
    enabled: () => !!host?.modes().includes(spec.id),
    checked: () => host?.mode() === spec.id,
    run: hosted(h => h.setMode(spec.id === 'code' && h.mode() === 'code' ? 'design' : spec.id)),
  })),
  {id: 'help.shortcuts', label: 'Keyboard shortcuts', group: 'help', shortcut: {code: 'Slash', ctrl: true, shift: true}, enabled: hasHost, run: hosted(h => h.openDialog('shortcuts'))},
  {id: 'app.preferences', label: 'Preferences…', group: 'preferences', enabled: hasHost, run: hosted(h => h.openDialog('preferences'))},
];

/** The toolbar's tools as commands: their keys, and an entry in quick actions. V and H are the engine's. */
export const TOOL_COMMAND_PREFIX = 'tool-';
const TOOL_COMMANDS: Command[] = (Object.values(TOOLS))
  .filter(spec => spec.id !== 'move' && spec.id !== 'hand')
  .map((spec): Command => ({
    id: TOOL_COMMAND_PREFIX + spec.id,
    label: spec.label,
    group: 'tools',
    shortcut: spec.shortcut ? shortcutFrom(spec.shortcut) : undefined,
    alternates: spec.alternateShortcut ? [shortcutFrom(spec.alternateShortcut)!] : undefined,
    run: spec.id === 'lasso' ? lassoOrMultiEdit : hosted(h => h.selectTool(spec.id)),
  }));

/** Q: inside a component set it is Figma Design's "Edit all variants"; elsewhere Figma Draw's lasso. */
function lassoOrMultiEdit(ctx: CommandContext) {
  const {doc, selection} = ctx.store.getState();
  const next = variantMultiEdit(doc, selection);
  if (next) ctx.store.setSelection(next);
  else hosted(h => h.selectTool('lasso'))(ctx);
}

/** The tool a `tool-*` command selects, or null. */
export const toolOfCommand = (id: string): ToolId | null => {
  if (!id.startsWith(TOOL_COMMAND_PREFIX)) return null;
  const tool = id.slice(TOOL_COMMAND_PREFIX.length);
  return tool in TOOLS ? (tool as ToolId) : null;
};

/** A palette or menu entry is usable at all (a tool whose module has not shipped is not). */
export const commandAvailable = (id: string) => {
  const tool = toolOfCommand(id);
  return tool ? hasTool(tool) : true;
};

let installed = false;

/** Registers the engine's commands and tools, the editor's own commands (unless a feature already
 *  registered the id), and two adjustments of the engine's: ⌘Y is "Outline mode" (as in desktop
 *  design tools; redo stays ⇧⌘Z), and the arrow keys move by the nudge steps of the preferences.
 *  Idempotent. */
export function installEditorCommands() {
  if (installed) return;
  installed = true;
  registerCoreCommands();
  registerCoreTools();
  const redo = getCommand('redo');
  if (redo?.alternates) registerCommand({...redo, alternates: redo.alternates.filter(shortcut => !(shortcut.code === 'KeyY' && shortcut.mod && !shortcut.shift))});
  for (const command of listCommands({includeHidden: true})) {
    const match = /^nudge-(left|right|up|down)(-10)?$/.exec(command.id);
    if (!match) continue;
    const [dx, dy] = {left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1]}[match[1] as 'left' | 'right' | 'up' | 'down'];
    const large = !!match[2];
    registerCommand({...command, run: ctx => {
      // Nothing to move: the arrows pan the canvas (engine/commands/view.ts).
      if (!movableSelection(ctx.store.getState().doc, ctx.store.getState().selection).length) return panByArrows(ctx, dx, dy, large);
      const step = large ? getPreferences().nudgeLarge : getPreferences().nudgeSmall;
      nudge(ctx, dx * step, dy * step);
    }});
  }
  // Defaults: a feature that registered the same id (imported before this runs, or later) keeps its own.
  for (const command of [...GENERIC_COMMANDS, ...HOSTED_COMMANDS]) if (!getCommand(command.id)) registerCommand(command);
  // A toolbar tool gets a key command only when nothing owns the id or the key yet (the drawing tools
  // bind their own; ⇧⌘K is "Place image…").
  for (const command of TOOL_COMMANDS) if (!getCommand(command.id) && !shortcutTaken(command)) registerCommand(command);
}

const sameShortcut = (a: Shortcut, b: Shortcut) => a.code === b.code && !!a.mod === !!b.mod && !!a.shift === !!b.shift && !!a.alt === !!b.alt && !!a.ctrl === !!b.ctrl;
function shortcutTaken(command: Command): boolean {
  const keys = [command.shortcut, ...(command.alternates ?? [])].filter((key): key is Shortcut => !!key);
  return listCommands({includeHidden: true}).some(other => [other.shortcut, ...(other.alternates ?? [])].some(key => key && keys.some(own => sameShortcut(own, key))));
}

/** What quick actions and the shortcuts dialog list: commands that are not hidden, plus the tool keys
 *  (registered hidden by the drawing tools, still worth finding by name). */
export const listedCommands = (): Command[] => listCommands({includeHidden: true}).filter(command => !command.hidden || command.id.startsWith(TOOL_COMMAND_PREFIX));

/** Ids this module registers (tests, the report). */
export const EDITOR_COMMAND_IDS = [...GENERIC_COMMANDS, ...HOSTED_COMMANDS, ...TOOL_COMMANDS].map(command => command.id);

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────

/** Tools that draw one thing and hand back to "Move", as in Figma. */
export const ONE_SHOT_TOOLS: ReadonlySet<string> = new Set<ToolId>(['frame', 'section', 'slice', 'rectangle', 'line', 'arrow', 'ellipse', 'polygon', 'star', 'image']);

/** Engine tools that work inside a mode and light a toolbar tool: the vector editor's selection and
 *  bend tools belong to "Pen". */
const ENGINE_TOOL_ALIASES: Readonly<Record<string, ToolId>> = {'vector-edit': 'pen', 'vector-bend': 'pen'};

/** The toolbar tool an engine tool id shows as (the ids are shared); null for a mode no toolbar
 *  button stands for (gradient editing, image crop, eyedropper): no button is lit then. */
export function chromeToolOf(engineTool: string): ToolId | null {
  return engineTool in TOOLS ? (engineTool as ToolId) : ENGINE_TOOL_ALIASES[engineTool] ?? null;
}

// ── The main menu of the editor ──────────────────────────────────────────────────────────────────

/** MAIN_MENU plus "Preferences" (Figma keeps its preferences in the main menu too). */
export const EDITOR_MENU: readonly MainMenuSection[] = [
  ...MAIN_MENU,
  {id: 'preferences', label: 'Preferences', items: ['pref.snap-objects', 'view.snap-pixel-grid', 'pref.hover-sizes', '-', 'app.preferences']},
];

// ── Quick actions search ─────────────────────────────────────────────────────────────────────────

export type PaletteEntry = {id: string; label: string; shortcut?: string; group?: string; keywords: string};

/** English words people type for commands whose id does not already say it. */
const EXTRA_KEYWORDS: Record<string, string> = {
  'delete': 'remove erase',
  'select-all': 'select all',
  'frame-selection': 'wrap in frame',
  'toggle-visible': 'hide show visibility',
  'toggle-lock': 'lock unlock',
  'bring-to-front': 'order arrange',
  'send-to-back': 'order arrange',
  'zoom-fit': 'fit all',
  'view.toggle-ui': 'hide ui interface panels',
  'view.minimize-ui': 'minimize collapse panels sidebar ui',
  'view.outlines': 'outline mode wireframe',
  'app.quick-actions': 'actions quick actions command palette search',
  'view.mode-draw': 'draw mode', 'view.mode-design': 'design mode', 'view.mode-prototype': 'prototype mode',
  'view.mode-code': 'dev mode developer code inspect',
  'help.shortcuts': 'keyboard hotkeys',
  'app.preferences': 'settings preferences',
  'edit.select-matching': 'select same similar',
  'object.multi-edit-variants': 'multi-edit variants q',
  'view.focus-next-region': 'f6 focus keyboard', 'view.focus-previous-region': 'f6 focus keyboard',
  'edit.select-same-fill': 'select same fill', 'edit.select-same-stroke': 'select same stroke',
  'edit.select-same-effect': 'select same effect', 'edit.select-same-text': 'select same text',
  'edit.select-same-font': 'select same font', 'edit.select-same-instance': 'select same instance component',
  'edit.select-inverse': 'invert inverse',
  'file.trash': 'delete file',
  'file.duplicate': 'duplicate copy file',
  // Extra words people type for a command whose label says it another way.
  'arrange.align-left': 'align', 'arrange.align-center-h': 'align center', 'arrange.align-right': 'align',
  'arrange.align-top': 'align', 'arrange.align-center-v': 'align middle', 'arrange.align-bottom': 'align',
  'arrange.distribute-h': 'distribute spacing', 'arrange.distribute-v': 'distribute spacing', 'arrange.tidy-up': 'tidy up',
  'object.mask': 'mask', 'edit.pick-color': 'color picker eyedropper',
  'text.bold': 'font weight', 'text.italic': 'font', 'text.underline': 'font', 'text.strikethrough': 'font strike',
  'text.size-increase': 'font size bigger', 'text.size-decrease': 'font size smaller',
  'text.weight-increase': 'font weight bolder', 'text.weight-decrease': 'font weight lighter',
  'text.letter-spacing-increase': 'letter spacing tracking', 'text.letter-spacing-decrease': 'letter spacing tracking',
  'text.line-height-increase': 'line height leading', 'text.line-height-decrease': 'line height leading',
  'text.align-left': 'text align', 'text.align-center': 'text align', 'text.align-right': 'text align', 'text.align-justify': 'text align',
  'tool-rectangle': 'shape', 'tool-ellipse': 'circle oval shape', 'tool-polygon': 'triangle shape', 'tool-star': 'shape',
  'tool-frame': 'artboard', 'tool-text': 'type', 'tool-image': 'picture photo', 'tool-pen': 'vector path',
  'tool-pencil': 'draw', 'tool-hand': 'pan', 'tool-scale': 'scale', 'duplicate': 'copy',
  'object.flatten': 'flatten', 'object.outline-stroke': 'outline stroke', 'view.pixel-grid': 'pixel grid',
  'object.create-component': 'component symbol', 'object.detach-instance': 'detach', 'object.select-instances': 'select instances',
  'object.swap-fill-stroke': 'swap fill stroke',
  'object.remove-fill': 'remove fill', 'object.remove-stroke': 'remove stroke',
  // Figma's English names of the Text, Comment and Draw tools.
  'tool-text-path': 'text on path type on a path', 'tool-annotation': 'annotation annotate dev mode',
  'tool-measure': 'measurement measure redline distance dev mode', 'tool-lasso': 'lasso freehand selection',
  'tool-brush': 'brush draw variable width stroke', 'view.annotations': 'annotations measurements show hide dev mode',
};

/** Every command quick actions can offer: registered, not hidden. */
export function paletteEntries(commands: readonly Command[] = listedCommands()): PaletteEntry[] {
  return commands.map(command => ({
    id: command.id,
    label: command.label,
    shortcut: command.shortcut ? shortcutString(command.shortcut) : undefined,
    group: command.group,
    keywords: [command.id.replace(/[.\-_]+/g, ' '), EXTRA_KEYWORDS[command.id] ?? ''].join(' '),
  }));
}

const fold = (text: string) => text.toLocaleLowerCase('en');

/** Scores at or above this come from the query's letters standing together in the text (a prefix,
 *  a word start or a substring); below it, only from the letters appearing in order. */
const WHOLE_MATCH = 300;

/** How well `token` matches `text` as a whole: a prefix beats a word start, which beats a substring; −1 is none. */
function wholeScore(text: string, token: string): number {
  if (text.startsWith(token)) return 1000 - text.length;
  const words = text.split(/[\s/(),."-]+/);
  if (words.some(word => word.startsWith(token))) return 800 - text.length;
  const at = text.indexOf(token);
  return at >= 0 ? 600 - at : -1;
}

/** How well `token` matches `text` (folded): a whole match first; then letters in order with
 *  word-start bonuses; −1 is no match. */
function tokenScore(text: string, token: string): number {
  if (!token) return 0;
  const whole = wholeScore(text, token);
  if (whole >= 0) return whole;
  let score = 100, from = 0, previous = -2;
  for (const char of token) {
    const found = text.indexOf(char, from);
    if (found < 0) return -1;
    if (found === 0 || /[\s/(-]/.test(text[found - 1])) score += 12;
    if (found === previous + 1) score += 6;
    score -= Math.min(10, found - from);
    previous = found;
    from = found + 1;
  }
  return Math.min(WHOLE_MATCH - 1, Math.max(1, score));
}

/** The entry's score for every token (−1 when one does not match) and whether each token matched as
 *  a whole (not as scattered letters). */
function entryScore(entry: PaletteEntry, tokens: readonly string[]): {score: number; whole: boolean} {
  const label = fold(entry.label), keywords = fold(entry.keywords);
  let total = 0, whole = true;
  for (const token of tokens) {
    const inLabel = tokenScore(label, token), inKeywords = tokenScore(keywords, token);
    const best = Math.max(inLabel, inKeywords >= 0 ? inKeywords - 50 : -1);
    if (best < 0) return {score: -1, whole: false};
    if (inLabel < WHOLE_MATCH && inKeywords < WHOLE_MATCH) whole = false;
    total += best;
  }
  return {score: total, whole};
}

/** Ranks entries for a query: matches only, best first, recently run ones lifted. An empty query lists
 *  the recent ones first, then the rest by label. */
export function searchPalette(entries: readonly PaletteEntry[], query: string, recent: readonly string[] = []): PaletteEntry[] {
  const recency = (id: string) => {
    const at = recent.indexOf(id);
    return at < 0 ? 0 : (recent.length - at) * 40;
  };
  const text = fold(query.trim());
  if (!text) {
    const byRecent = recent.map(id => entries.find(entry => entry.id === id)).filter((entry): entry is PaletteEntry => !!entry);
    const rest = entries.filter(entry => !recent.includes(entry.id)).sort((a, b) => a.label.localeCompare(b.label, 'en'));
    return [...byRecent, ...rest];
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  const scored: {entry: PaletteEntry; score: number; whole: boolean}[] = [];
  for (const entry of entries) {
    const result = entryScore(entry, tokens);
    if (result.score >= 0) scored.push({entry, score: result.score + recency(entry.id), whole: result.whole});
  }
  // Letters scattered through a label are a guess: offered only when nothing matches as words do
  // ("rect" lists "Rectangle", not every label that happens to contain those letters in order).
  const kept = scored.some(item => item.whole) ? scored.filter(item => item.whole) : scored;
  return kept.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label, 'en')).map(item => item.entry);
}
