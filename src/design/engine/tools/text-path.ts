import type {DesignDocument, NodeId, Paint, PathCommand, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {BLACK, createNode, defaultTextProps, defaultTextStyle, newId, solid} from '../../../../shared/design/defaults';
import {subpaths} from '../../../../shared/design/paths';
import {nodeGeometry} from '../../../../shared/design/shapes';
import {projectOnPath, textPathSampler} from '../../../../shared/design/text-path';
import {isLockedInTree} from '../../../../shared/design/tree';
import {HIT_TOLERANCE_PX, pickAt} from '../hit-test';
import {lastTextStyle, textEditorDeps} from '../text-editor/registry';
import {TextTool} from './text';
import type {ToolContext, ToolPointerEvent} from './types';

// "Text on path" (the Text group's second tool, Figma's Text on path): a click on a shape, a line or a vector starts a
// text that follows its outline from the point clicked (the shape itself stays; the text keeps its own copy of the path,
// as Figma's text paths do). A click on a text that already follows a path opens it, as "Text" does. Typing, the caret,
// selection and Escape are the text editor's (TextTool's session). Elsewhere the click does nothing: the cursor says
// where a path can take text, and the hover outline shows which.

/** Layers whose outline can carry text (their geometry is their own; frames and groups are boxes, booleans are results). */
const PATH_TYPES = new Set<SceneNode['type']>(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'VECTOR']);

/** The subpath of `node` nearest `local` (its own space), or null when it draws no outline. */
export function pathUnder(node: SceneNode, local: Vec): {commands: PathCommand[]; offset: number} | null {
  if (!PATH_TYPES.has(node.type)) return null;
  let best: {commands: PathCommand[]; offset: number; distance: number} | null = null;
  for (const path of nodeGeometry(node)) for (const part of subpaths(path.commands)) {
    if (part.length < 2) continue;
    const sampler = textPathSampler({commands: part, startOffset: 0, side: 'LEFT'});
    if (!sampler) continue;
    const hit = projectOnPath(sampler, local);
    if (!best || hit.distance < best.distance) best = {commands: part, offset: sampler.length ? hit.s / sampler.length : 0, distance: hit.distance};
  }
  return best && {commands: best.commands, offset: Math.round(best.offset * 1000) / 1000};
}

/** A new text on `shape`'s outline, starting where `page` falls on it: a sibling just above the shape with the shape's
 *  box and turn, so the path keeps its place. Null when the shape has no outline. */
export function textOnPathNode(doc: DesignDocument, shape: SceneNode, page: Vec, style = defaultTextStyle(), fills: Paint[] = [solid(BLACK)]): {node: SceneNode; parentId: NodeId; index: number} | null {
  if (!shape.parentId) return null;
  const local = apply(invert(worldMatrix(doc, shape.id)), page);
  const path = pathUnder(shape, local);
  if (!path) return null;
  const parent = doc.nodes[shape.parentId];
  const index = Math.max(0, (parent?.children ?? []).indexOf(shape.id) + 1);
  const node = createNode('TEXT', {
    id: newId(), parentId: shape.parentId, name: 'Text on path',
    x: shape.x, y: shape.y, width: shape.width, height: shape.height, rotation: shape.rotation, flipX: shape.flipX, flipY: shape.flipY,
    fills, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
    ...(shape.layoutPositioning === 'ABSOLUTE' || (parent?.autoLayout && parent.autoLayout.layoutMode !== 'NONE') ? {layoutPositioning: 'ABSOLUTE' as const} : {}),
    text: {...defaultTextProps(''), style, textAutoResize: 'NONE', textAlignVertical: 'BOTTOM'},
    textPath: {commands: path.commands, startOffset: path.offset, side: 'LEFT'},
  });
  if (!node.flipX) delete node.flipX;
  if (!node.flipY) delete node.flipY;
  return {node, parentId: shape.parentId, index};
}

export class TextPathTool extends TextTool {
  readonly id: string = 'text-path';
  readonly cursor: string = 'crosshair';

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    // Typing into a text already: the text editor's clicks (caret, words, leaving it).
    if (this.session || this.press) return super.onPointerDown(e, ctx);
    const target = this.targetAt(e.page, ctx);
    if (!target) return;
    if (target.type === 'TEXT') return super.onPointerDown(e, ctx);
    this.clickCount(e);
    this.start(target, e.page, ctx);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    if (this.session || this.press) return super.onPointerMove(e, ctx);
    const target = this.targetAt(e.page, ctx);
    ctx.setCursor(target ? 'text' : null);
    ctx.store.setHover(target?.id ?? null);
  }

  /** The layer a click would act on: a text on a path (to edit), or a shape whose outline can carry text. */
  private targetAt(page: Vec, ctx: ToolContext): SceneNode | null {
    const state = ctx.store.getState();
    const tolerance = HIT_TOLERANCE_PX * ctx.view.pixel();
    const id = pickAt(state.doc, state.pageId, page, {deep: true, tolerance, index: ctx.index()});
    const node = id ? state.doc.nodes[id] : undefined;
    if (!node || isLockedInTree(state.doc, node.id)) return null;
    if (node.type === 'TEXT') return node.textPath ? node : null;
    return PATH_TYPES.has(node.type) ? node : null;
  }

  private start(shape: SceneNode, page: Vec, ctx: ToolContext) {
    const {store} = ctx;
    if (!textEditorDeps(store)) return;
    const remembered = lastTextStyle(store);
    const style = remembered ? {...defaultTextStyle(), ...remembered.style} : defaultTextStyle();
    const fills = remembered?.fills.length ? remembered.fills.map(paint => ({...paint})) : [solid(BLACK)];
    const made = textOnPathNode(store.getState().doc, shape, page, style, fills);
    if (!made) return;
    const {node, parentId, index} = made;
    store.setHover(null);
    const gesture = store.gesture('Text on path');
    gesture.update(tx => {
      tx.create(node, parentId, index);
      return {select: [node.id]};
    });
    if (!store.getState().doc.nodes[node.id]) {
      gesture.cancel();
      return;
    }
    this.open(ctx, node.id, {offset: 0}, {gesture, parentId, index, node});
  }
}

export const createTextPathTool = () => new TextPathTool();
