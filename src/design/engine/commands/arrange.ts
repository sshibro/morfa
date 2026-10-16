import type {NodeId, SceneNode} from '../../../../shared/design/types';
import {applyLinear, invert, localMatrix, multiply, scaling, transformRect, translation, unionRects, worldMatrix} from '../../../../shared/design/geometry';
import {placementChanges, placementFor} from '../../../../shared/design/transaction';
import {isInsideInstance, topLevelSelection} from '../../../../shared/design/tree';
import {editableStructure, movableSelection, selectionBounds} from '../selection';
import {userUpdate} from '../user-edit';
import {applyFit, applyFitAlone, resizeSingle, textResizeMode} from '../tools/transform';
import type {Command, CommandContext, Shortcut} from './registry';
import {applyOrder, moveNodesToPage, reorderedChildren, wrapNodes, type OrderMove} from './structure';
import {canPan, panByArrows} from './view';

// Group selection, Ungroup, Frame selection, layer order, Show/hide,
// Lock/unlock, flips and arrow-key nudges.

const state = (ctx: CommandContext) => ctx.store.getState();
const hasEditable = (ctx: CommandContext) => editableStructure(state(ctx).doc, state(ctx).selection).length > 0;
const hasMovable = (ctx: CommandContext) => movableSelection(state(ctx).doc, state(ctx).selection).length > 0;

/** Containers "Ungroup" dissolves; components, variant sets and instances are not undone this way. */
const UNGROUPABLE = new Set<SceneNode['type']>(['GROUP', 'BOOLEAN_OPERATION', 'FRAME', 'SECTION']);

function ungroupTargets(ctx: CommandContext): NodeId[] {
  const {doc, selection} = state(ctx);
  return topLevelSelection(doc, selection).filter(id => UNGROUPABLE.has(doc.nodes[id]?.type) && !isInsideInstance(doc, id));
}

function wrap(ctx: CommandContext, type: 'GROUP' | 'FRAME') {
  const {doc, selection} = state(ctx);
  const ids = editableStructure(doc, selection);
  if (!ids.length) return;
  ctx.store.transact(type === 'GROUP' ? 'Group' : 'Frame selection', tx => {
    const id = wrapNodes(tx, doc, ids, type);
    return id ? {select: [id]} : undefined;
  });
}

function ungroup(ctx: CommandContext) {
  const targets = ungroupTargets(ctx);
  if (!targets.length) return;
  ctx.store.transact('Ungroup', tx => {
    const released: NodeId[] = [];
    for (const id of targets) {
      const node = tx.get(id);
      if (!node?.parentId) continue;
      const parentId = node.parentId;
      let index = (tx.get(parentId)!.children ?? []).indexOf(id);
      for (const child of [...(node.children ?? [])]) {
        tx.move(child, parentId, index++);
        released.push(child);
      }
      tx.remove(id);
    }
    return {select: released};
  });
}

function arrange(ctx: CommandContext, move: OrderMove) {
  const {doc, selection} = state(ctx);
  const byParent = new Map<NodeId, Set<NodeId>>();
  for (const id of editableStructure(doc, selection)) {
    const parentId = doc.nodes[id].parentId!;
    if (!byParent.has(parentId)) byParent.set(parentId, new Set());
    byParent.get(parentId)!.add(id);
  }
  const labels: Record<OrderMove, string> = {forward: 'Bring forward', backward: 'Send backward', front: 'Bring to front', back: 'Send to back'};
  ctx.store.transact(labels[move], tx => {
    for (const [parentId, selected] of byParent) {
      const children = tx.get(parentId)?.children ?? [];
      applyOrder(tx, reorderedChildren(children, selected, move), selected);
    }
  });
}

function toggle(ctx: CommandContext, field: 'visible' | 'locked') {
  const {doc, selection} = state(ctx);
  const ids = topLevelSelection(doc, selection).filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE');
  if (!ids.length) return;
  const value = field === 'visible' ? !ids.some(id => doc.nodes[id].visible) : !ids.every(id => doc.nodes[id].locked);
  ctx.store.transact(field === 'visible' ? (value ? 'Show' : 'Hide') : value ? 'Lock' : 'Unlock', tx => {
    // By hand, so a layer hidden or locked inside an instance keeps that as an override (the main's changes no longer undo it).
    for (const id of ids) userUpdate(tx, id, {[field]: value});
  });
}

/** Frames, components and sections "Resize to fit" applies to: movable, with layers. */
function fitTargets(ctx: CommandContext): NodeId[] {
  const {doc, selection} = state(ctx);
  return movableSelection(doc, selection).filter(id => {
    const node = doc.nodes[id];
    return (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'SECTION') && !!node.children?.length;
  });
}

/** "Resize to fit" (⌥⇧⌘R, Figma's "Resize to fit"): each frame takes the bounds of its layers, which stay
 *  where they are on the page; an auto-layout frame hugs its content instead. */
function resizeToFit(ctx: CommandContext) {
  const {doc} = state(ctx);
  const ids = fitTargets(ctx);
  if (!ids.length) return;
  ctx.store.transact('Resize to fit', tx => {
    for (const id of ids) {
      const node = doc.nodes[id];
      if (node.autoLayout && node.autoLayout.layoutMode !== 'NONE') {
        tx.update(id, {layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG'});
        continue;
      }
      const children = (node.children ?? []).map(child => doc.nodes[child]).filter(child => !!child);
      const shown = children.filter(child => child.visible);
      const box = unionRects((shown.length ? shown : children).map(child => transformRect(localMatrix(child), {x: 0, y: 0, width: child.width, height: child.height})));
      if (!box || (box.x === 0 && box.y === 0 && box.width === node.width && box.height === node.height)) continue;
      applyFitAlone(tx, id, resizeSingle(doc, id, {left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height}));
    }
  });
}

/** The pages "Move to page" offers for the selection: every other page, none when nothing can move. */
export function moveTargets(ctx: CommandContext): NodeId[] {
  const {doc, selection, pageId} = state(ctx);
  if (ctx.store.readOnly || !editableStructure(doc, selection).length) return [];
  return doc.pages.filter(id => id !== pageId && doc.nodes[id]?.type === 'PAGE');
}

/** Moves the selection to another page in one undo step; this page keeps showing, with nothing selected. */
export function moveSelectionToPage(ctx: CommandContext, pageId: NodeId) {
  const {doc, selection} = state(ctx);
  const ids = editableStructure(doc, selection);
  if (!ids.length || !moveTargets(ctx).includes(pageId)) return;
  ctx.store.transact('Move to page', tx => {
    moveNodesToPage(tx, doc, ids, pageId);
    return {select: []};
  });
}

/** Mirrors the selection about its centre in page space, as one piece. */
function flip(ctx: CommandContext, axis: 'x' | 'y') {
  const {doc, selection} = state(ctx);
  const ids = movableSelection(doc, selection);
  const bounds = selectionBounds(doc, ids);
  if (!bounds) return;
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  const mirror = multiply(multiply(translation(cx, cy), scaling(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1)), translation(-cx, -cy));
  ctx.store.transact(axis === 'x' ? 'Flip horizontal' : 'Flip vertical', tx => {
    for (const id of ids) {
      const node = doc.nodes[id];
      const local = multiply(invert(worldMatrix(doc, node.parentId!)), multiply(mirror, worldMatrix(doc, id)));
      const prefer = axis === 'x' ? {flipX: !node.flipX, flipY: !!node.flipY} : {flipX: !!node.flipX, flipY: !node.flipY};
      tx.update(id, placementChanges(node, placementFor(node, local, prefer)));
    }
  });
}

/** Arrow keys: moves the selection on screen by `dx`, `dy` px; inside an auto-layout frame the arrow
 *  along its direction moves the layer in the flow instead. Held keys make one undo step. */
export function nudge(ctx: CommandContext, dx: number, dy: number) {
  const {doc, selection} = state(ctx);
  const ids = movableSelection(doc, selection);
  if (!ids.length) return;
  ctx.store.transact('Move', tx => {
    for (const id of ids) {
      const node = doc.nodes[id];
      const parent = doc.nodes[node.parentId!];
      const layout = parent.autoLayout;
      if (layout && layout.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE') {
        const along = layout.layoutMode === 'HORIZONTAL' ? dx : dy;
        if (along) tx.reorder(id, (tx.get(parent.id)!.children ?? []).indexOf(id) + Math.sign(along));
        continue;
      }
      const local = applyLinear(invert(worldMatrix(doc, parent.id)), {x: dx, y: dy});
      tx.update(id, {x: node.x + local.x, y: node.y + local.y});
    }
  }, {coalesce: 'nudge'});
}

/** ⌘/Ctrl + arrows, as in Figma: → and ↓ grow each selected layer by `dw`, `dh` px from its right and bottom sides
 *  (← and ↑ shrink it, never past nothing), along its own axes and through its constraints, as dragging that side
 *  does. Held keys make one undo step. */
export function resizeByKeys(ctx: CommandContext, dw: number, dh: number) {
  const {doc, selection} = state(ctx);
  const ids = movableSelection(doc, selection);
  if (!ids.length) return;
  ctx.store.transact('Resize', tx => {
    for (const id of ids) {
      const node = doc.nodes[id];
      let width = Math.max(0, node.width + dw);
      // A line has a length and no height.
      let height = node.type === 'LINE' ? node.height : Math.max(0, node.height + dh);
      // "Constrain proportions": the other side follows, as the handles and the panel's W and H do.
      if (node.constrainProportions === true && node.type !== 'LINE' && node.width > 0 && node.height > 0) {
        if (dw) height = (width / node.width) * node.height;
        else width = (height / node.height) * node.width;
      }
      if (width === node.width && height === node.height) continue;
      applyFit(tx, id, resizeSingle(doc, id, {left: 0, top: 0, right: width, bottom: height}));
      const mode = textResizeMode(node, {hx: width !== node.width ? 1 : 0, hy: height !== node.height ? 1 : 0});
      if (mode) tx.update(id, mode);
    }
  }, {coalesce: 'resize-keys'});
}

const ARROWS: [code: string, name: string, dx: number, dy: number][] = [
  ['ArrowLeft', 'left', -1, 0],
  ['ArrowRight', 'right', 1, 0],
  ['ArrowUp', 'up', 0, -1],
  ['ArrowDown', 'down', 0, 1],
];

const nudgeCommands: Command[] = ARROWS.flatMap(([code, name, dx, dy]) => [1, 10].map((step): Command => ({
  id: `nudge-${code.slice(5).toLowerCase()}${step === 10 ? '-10' : ''}`,
  label: `Nudge ${name} by ${step} px`,
  group: 'arrange',
  shortcut: (step === 10 ? {code, shift: true} : {code}) satisfies Shortcut,
  hidden: true,
  repeat: true,
  // Nothing selected: the arrows pan the canvas instead (view.ts), as Figma's keyboard controls.
  enabled: ctx => hasMovable(ctx) || canPan(ctx),
  run: ctx => (hasMovable(ctx) ? nudge(ctx, dx * step, dy * step) : panByArrows(ctx, dx, dy, step === 10)),
})));

const RESIZE_NAMES: Record<string, string> = {ArrowLeft: 'Decrease width', ArrowRight: 'Increase width', ArrowUp: 'Decrease height', ArrowDown: 'Increase height'};

/** ⌘/Ctrl + arrows resize (not while a vector or text editor has the arrows). */
const resizeCommands: Command[] = ARROWS.flatMap(([code, , dx, dy]) => [1, 10].map((step): Command => ({
  id: `resize-${code.slice(5).toLowerCase()}${step === 10 ? '-10' : ''}`,
  label: `${RESIZE_NAMES[code]} by ${step} px`,
  group: 'arrange',
  shortcut: (step === 10 ? {code, mod: true, shift: true} : {code, mod: true}) satisfies Shortcut,
  hidden: true,
  repeat: true,
  enabled: ctx => !state(ctx).editing && hasMovable(ctx),
  run: ctx => resizeByKeys(ctx, dx * step, dy * step),
})));

export const ARRANGE_COMMANDS: Command[] = [
  {id: 'group', label: 'Group selection', group: 'arrange', shortcut: {code: 'KeyG', mod: true}, enabled: hasEditable, run: ctx => wrap(ctx, 'GROUP')},
  {id: 'ungroup', label: 'Ungroup', group: 'arrange', shortcut: {code: 'KeyG', mod: true, shift: true}, enabled: ctx => ungroupTargets(ctx).length > 0, run: ungroup},
  {id: 'frame-selection', label: 'Frame selection', group: 'arrange', shortcut: {code: 'KeyG', mod: true, alt: true}, enabled: hasEditable, run: ctx => wrap(ctx, 'FRAME')},
  {id: 'object.resize-to-fit', label: 'Resize to fit', group: 'arrange', shortcut: {code: 'KeyR', mod: true, alt: true, shift: true}, enabled: ctx => fitTargets(ctx).length > 0, run: resizeToFit},
  {id: 'bring-forward', label: 'Bring forward', group: 'order', shortcut: {code: 'BracketRight', mod: true}, enabled: hasEditable, run: ctx => arrange(ctx, 'forward')},
  {id: 'send-backward', label: 'Send backward', group: 'order', shortcut: {code: 'BracketLeft', mod: true}, enabled: hasEditable, run: ctx => arrange(ctx, 'backward')},
  {id: 'bring-to-front', label: 'Bring to front', group: 'order', shortcut: {code: 'BracketRight', mod: true, alt: true}, enabled: hasEditable, run: ctx => arrange(ctx, 'front')},
  {id: 'send-to-back', label: 'Send to back', group: 'order', shortcut: {code: 'BracketLeft', mod: true, alt: true}, enabled: hasEditable, run: ctx => arrange(ctx, 'back')},
  {id: 'toggle-visible', label: 'Show/hide', group: 'layer', shortcut: {code: 'KeyH', mod: true, shift: true}, enabled: ctx => state(ctx).selection.length > 0, run: ctx => toggle(ctx, 'visible')},
  {id: 'toggle-lock', label: 'Lock/unlock', group: 'layer', shortcut: {code: 'KeyL', mod: true, shift: true}, enabled: ctx => state(ctx).selection.length > 0, run: ctx => toggle(ctx, 'locked')},
  {id: 'flip-horizontal', label: 'Flip horizontal', group: 'arrange', shortcut: {code: 'KeyH', shift: true}, enabled: hasMovable, run: ctx => flip(ctx, 'x')},
  {id: 'flip-vertical', label: 'Flip vertical', group: 'arrange', shortcut: {code: 'KeyV', shift: true}, enabled: hasMovable, run: ctx => flip(ctx, 'y')},
  ...nudgeCommands,
  ...resizeCommands,
];
