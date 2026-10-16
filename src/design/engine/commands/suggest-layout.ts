import type {DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import {suggestAutoLayout} from '../../../../shared/design/auto-layout-suggest';
import {isAutoLayout} from '../../../../shared/design/constraints';
import type {Rect} from '../../../../shared/design/geometry';
import type {Transaction} from '../../../../shared/design/transaction';
import {isMacPlatform} from '../keyboard';
import type {DesignStore} from '../store';
import {userUpdate} from '../user-edit';
import type {Command} from './registry';
import {wrapNodes} from './structure';

// "Suggest auto layout" (Figma's Suggest auto layout, ⌃⇧A): a whole frame at once. Its layers are read as rows (bands
// that do not overlap top to bottom) or, failing that, as columns; a row or column of several layers is wrapped in an
// auto-layout frame of its own, and the frame gets auto layout over them — nested frames first, bottom up, in one undo
// step. A frame whose layers overlap both ways keeps its free layout. Positions stay as they were (the gaps and paddings
// are read from the layout, shared/design/auto-layout-suggest.ts).

export type Axis = 'x' | 'y';

/** The layers split into bands along `axis`: each band's layers overlap there; consecutive bands do not. In order. */
export function bands(items: readonly {id: NodeId; rect: Rect}[], axis: Axis): NodeId[][] {
  const start = (rect: Rect) => (axis === 'y' ? rect.y : rect.x);
  const size = (rect: Rect) => (axis === 'y' ? rect.height : rect.width);
  const sorted = [...items].sort((a, b) => start(a.rect) - start(b.rect));
  const out: NodeId[][] = [];
  let end = -Infinity;
  for (const item of sorted) {
    const from = start(item.rect), to = from + size(item.rect);
    if (out.length && from < end) {
      out[out.length - 1].push(item.id);
      end = Math.max(end, to);
    } else {
      out.push([item.id]);
      end = to;
    }
  }
  return out;
}

const FREE_FRAMES = new Set<SceneNode['type']>(['FRAME', 'COMPONENT']);
const laidOutChildren = (node: SceneNode, doc: DesignDocument) =>
  (node.children ?? []).map(id => doc.nodes[id]).filter((child): child is SceneNode => !!child && child.visible !== false && child.layoutPositioning !== 'ABSOLUTE');
const rectOf = (node: SceneNode): Rect => ({x: node.x, y: node.y, width: node.width, height: node.height});

/** Turns auto layout on for a frame as ⇧A would (direction, gap, padding, order read from its layers). */
function applySuggestion(tx: Transaction, frameId: NodeId): boolean {
  const suggestion = suggestAutoLayout(tx.doc, [frameId]);
  if (!suggestion || suggestion.frameId !== frameId) return false;
  userUpdate(tx, frameId, {autoLayout: suggestion.autoLayout, layoutSizingHorizontal: suggestion.sizing.horizontal, layoutSizingVertical: suggestion.sizing.vertical});
  suggestion.order.forEach((child, index) => {
    if (tx.get(child)?.parentId === frameId) tx.reorder(child, index);
  });
  return true;
}

/** Lays out one frame and the free frames inside it, bottom up. Returns whether it got auto layout. */
function layOut(tx: Transaction, frameId: NodeId): boolean {
  const frame = tx.get(frameId);
  if (!frame) return false;
  for (const child of laidOutChildren(frame, tx.doc)) if (FREE_FRAMES.has(child.type) && !isAutoLayout(child)) layOut(tx, child.id);
  if (isAutoLayout(frame)) return true;
  const items = laidOutChildren(tx.get(frameId)!, tx.doc).map(node => ({id: node.id, rect: rectOf(node)}));
  if (items.length < 2) return items.length === 1 && applySuggestion(tx, frameId);
  const rows = bands(items, 'y');
  const groups = rows.length > 1 ? rows : bands(items, 'x');
  if (groups.length < 2) return false;
  for (const group of groups) {
    if (group.length < 2) continue;
    // A band whose layers overlap both ways stays a plain frame inside the flow.
    const wrapper = wrapNodes(tx, tx.doc, group, 'FRAME');
    if (wrapper) layOut(tx, wrapper);
  }
  return applySuggestion(tx, frameId);
}

/** The frames ⌃⇧A lays out: the selected free frames (and components) outside instances. */
export const suggestTargets = (doc: DesignDocument, selection: readonly NodeId[]) =>
  selection.filter(id => FREE_FRAMES.has(doc.nodes[id]?.type));

/** Runs "Suggest auto layout" on the selection; one undo step. Returns the frames that got auto layout. */
export function suggestLayoutDeep(store: DesignStore): NodeId[] {
  const {doc, selection} = store.getState();
  const targets = suggestTargets(doc, selection);
  if (!targets.length) return [];
  const done: NodeId[] = [];
  store.transact('Suggest auto layout', tx => {
    for (const id of targets) if (layOut(tx, id)) done.push(id);
  });
  return done;
}

export const SUGGEST_LAYOUT_COMMAND: Command = {
  id: 'object.suggest-auto-layout',
  label: 'Suggest auto layout',
  group: 'object',
  // Figma's keys: ⌃⇧A on a Mac, Ctrl+Alt+Shift+A elsewhere.
  shortcut: isMacPlatform() ? {code: 'KeyA', ctrl: true, shift: true} : {code: 'KeyA', mod: true, alt: true, shift: true},
  enabled: ctx => suggestTargets(ctx.store.getState().doc, ctx.store.getState().selection).length > 0,
  run: ctx => void suggestLayoutDeep(ctx.store),
};
