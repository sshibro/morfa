import type {DesignDocument, Matrix, NodeId, SceneNode, ShadowEffect} from './types';
import {CONTAINER_TYPES, FRAME_LIKE_TYPES} from './types';
import type {Rect} from './geometry';
import {localMatrix, multiply, transformRect, worldMatrix} from './geometry';
import type {TextLayout, TextMeasurer} from './text-layout';
import {layoutText} from './text-layout';
import {textPathLayout} from './text-path';
import {hasVariableWidth, maxWidthFactor} from './stroke-profile';

// Render bounds: the page-space box of every pixel a node can paint, which is larger than its box
// once strokes reach outside, arrowheads stick out of a line, shadows are offset and blurred or a
// layer blur bleeds. The renderer culls with it, exports size their canvas by it and the tile cache
// invalidates by it, so it errs on the generous side: a few pixels too many cost a little work,
// one pixel too few leaves a cut-off shadow in an exported PNG.
//
// Blur reach: Figma's blur radius r is a Gaussian with σ = r / 2 (the same as CSS box-shadow and
// canvas shadowBlur). 3σ = 1.5 r holds everything brighter than 1/400 of the shadow colour.

/** How far a blur of radius `radius` visibly reaches beyond the shape it blurs. */
export const blurReach = (radius: number) => Math.max(0, radius) * 1.5;

export type Outsets = {left: number; top: number; right: number; bottom: number};
const NONE: Outsets = {left: 0, top: 0, right: 0, bottom: 0};

const isContainer = (node: SceneNode) => CONTAINER_TYPES.includes(node.type);
const isFrameLike = (node: SceneNode) => FRAME_LIKE_TYPES.includes(node.type);
/** Frames that clip their children to their own box. */
export const clipsChildren = (node: SceneNode) => isFrameLike(node) && node.clipsContent !== false;
const hasVisibleStroke = (node: SceneNode) => node.strokeWeight > 0 && node.strokes.some(p => p.visible !== false && p.opacity > 0);

/** True when a LINE or VECTOR draws at least one subpath that does not close, so its stroke has
 *  ends (caps and markers) and no inside or outside. */
export function hasOpenPath(node: SceneNode): boolean {
  if (node.type === 'LINE') return true;
  if (node.type !== 'VECTOR') return false;
  for (const path of node.vectorPaths ?? []) {
    let open = false;
    for (const command of path.commands) {
      if (command.type === 'M') {
        if (open) return true;
        open = true;
      } else if (command.type === 'Z') open = false;
    }
    if (open) return true;
  }
  return false;
}

/** Size of the arrowheads and dots drawn at the ends of an open path, as a reach from the end
 *  point (shared with the renderer's marker shapes in src/design/engine/render/stroke-math.ts). */
export const markerSize = (strokeWeight: number) => 3 * Math.max(strokeWeight, 0) + 2;

/** How far the stroke reaches beyond the box on each side, in local px. Rectangles and frames with
 *  `individualStrokeWeights` reach per side; sharp vector corners with miter joins reach up to the
 *  miter limit; square caps and markers reach past the ends of open paths. */
export function strokeOutsets(node: SceneNode): Outsets {
  if (!hasVisibleStroke(node)) return NONE;
  // A variable width stroke (shared/design/stroke-profile.ts) is centred, as wide as its widest point, without markers.
  if (hasVariableWidth(node)) {
    const reach = (node.strokeWeight * maxWidthFactor(node.variableWidthStrokeProperties)) / 2;
    return {left: reach, top: reach, right: reach, bottom: reach};
  }
  const open = hasOpenPath(node);
  const align = open ? 'CENTER' : node.strokeAlign;
  const factor = align === 'CENTER' ? 0.5 : align === 'OUTSIDE' ? 1 : 0;
  const individual = node.individualStrokeWeights;
  if (individual && (node.type === 'RECTANGLE' || isFrameLike(node))) {
    return {left: individual.left * factor, top: individual.top * factor, right: individual.right * factor, bottom: individual.bottom * factor};
  }
  let reach = node.strokeWeight * factor;
  const sharpCorners = node.type === 'POLYGON' || node.type === 'STAR' || node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION';
  if (sharpCorners && node.strokeJoin === 'MITER') reach *= Math.max(1, node.strokeMiterLimit || 4);
  if (open) {
    if (node.strokeCap === 'SQUARE') reach = Math.max(reach, node.strokeWeight * Math.SQRT1_2);
    const markers = [node.strokeStartMarker, node.strokeEndMarker].filter(m => m && m !== 'NONE');
    if (markers.length) reach = Math.max(reach, markerSize(node.strokeWeight));
  }
  return {left: reach, top: reach, right: reach, bottom: reach};
}

const visibleEffects = (node: SceneNode) => node.effects.filter(effect => effect.visible !== false);

/** Grows `rect` (in the node's local space) by what the node's effects paint outside it. */
export function expandByEffects(rect: Rect, node: SceneNode): Rect {
  let {x: minX, y: minY} = rect;
  let maxX = rect.x + rect.width, maxY = rect.y + rect.height;
  const base = {minX, minY, maxX, maxY};
  for (const effect of visibleEffects(node)) {
    if (effect.type !== 'DROP_SHADOW') continue;
    const shadow = effect as ShadowEffect;
    const grow = Math.max(0, shadow.spread) + blurReach(shadow.radius);
    minX = Math.min(minX, base.minX + shadow.offset.x - grow);
    minY = Math.min(minY, base.minY + shadow.offset.y - grow);
    maxX = Math.max(maxX, base.maxX + shadow.offset.x + grow);
    maxY = Math.max(maxY, base.maxY + shadow.offset.y + grow);
  }
  const layerBlur = visibleEffects(node).find(effect => effect.type === 'LAYER_BLUR');
  if (layerBlur) {
    const grow = blurReach(layerBlur.radius);
    minX -= grow; minY -= grow; maxX += grow; maxY += grow;
  }
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

/** The box a text layout draws into, in the node's local space (lines can overflow a fixed box). */
export function textLayoutBounds(layout: TextLayout): Rect | null {
  if (!layout.lines.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of layout.lines) {
    // A list marker hangs left of the line; glyphs may reach past the line box (tall ascenders in a
    // tight line height), so the box also covers the font's own ascent and descent.
    const left = line.marker ? Math.min(line.x, line.marker.x) : line.x;
    let right = line.x + line.width;
    for (const run of line.runs) right = Math.max(right, run.x + run.width);
    minX = Math.min(minX, left);
    maxX = Math.max(maxX, right);
    minY = Math.min(minY, line.top, line.baseline - (line.ascent || 0));
    maxY = Math.max(maxY, line.top + line.height, line.baseline + (line.descent || 0));
  }
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

export const unionRect = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return {x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y};
};

/** What the node paints by itself (fills, strokes, markers, its own effects), without children,
 *  in its local space. Text includes the laid-out lines when a measurer is given (or a layout). */
export function localRenderBounds(node: SceneNode, text?: TextMeasurer | TextLayout | null): Rect {
  let rect: Rect = {x: 0, y: 0, width: Math.max(0, node.width), height: Math.max(0, node.height)};
  if (node.type === 'TEXT' && node.text && text) {
    const layout = 'lines' in text ? text : layoutText(node, text);
    // A text on a path paints its glyphs along the path (shared/design/text-path.ts), wherever they reach.
    const lines = node.textPath ? textPathLayout(node, layout).bounds : textLayoutBounds(layout);
    if (lines) rect = unionRect(rect, lines);
  }
  const out = strokeOutsets(node);
  rect = {x: rect.x - out.left, y: rect.y - out.top, width: rect.width + out.left + out.right, height: rect.height + out.top + out.bottom};
  return expandByEffects(rect, node);
}

/** Grows a page-space rectangle by a container's effects, whose offsets turn with the container. */
export function expandWorldByEffects(rect: Rect, node: SceneNode, world: Matrix): Rect {
  let out = rect;
  for (const effect of visibleEffects(node)) {
    if (effect.type === 'DROP_SHADOW') {
      const shadow = effect as ShadowEffect;
      const grow = Math.max(0, shadow.spread) + blurReach(shadow.radius);
      const dx = world[0][0] * shadow.offset.x + world[0][1] * shadow.offset.y;
      const dy = world[1][0] * shadow.offset.x + world[1][1] * shadow.offset.y;
      out = unionRect(out, {x: rect.x + dx - grow, y: rect.y + dy - grow, width: rect.width + 2 * grow, height: rect.height + 2 * grow});
    } else if (effect.type === 'LAYER_BLUR') {
      const grow = blurReach(effect.radius);
      out = unionRect(out, {x: rect.x - grow, y: rect.y - grow, width: rect.width + 2 * grow, height: rect.height + 2 * grow});
    }
  }
  return out;
}

export type RenderBoundsOptions = {
  /** Measures text so overflowing lines count; without it a text node is its box. */
  measurer?: TextMeasurer;
  /** Count the node itself even when it is hidden (exporting a hidden layer). Hidden descendants never count. */
  includeHidden?: boolean;
};

/** Page-space bounds of everything the node and its visible descendants paint, given the node's
 *  world matrix. Null when nothing is painted (hidden, a slice, an empty group). */
export function subtreeRenderBounds(doc: DesignDocument, node: SceneNode, world: Matrix, options: RenderBoundsOptions = {}): Rect | null {
  if (node.visible === false && !options.includeHidden) return null;
  if (node.type === 'SLICE') return null;
  const childOptions = options.includeHidden ? {...options, includeHidden: false} : options;
  if (!isContainer(node) || node.type === 'BOOLEAN_OPERATION') {
    return transformRect(world, localRenderBounds(node, options.measurer));
  }
  if (clipsChildren(node)) return transformRect(world, localRenderBounds(node, options.measurer));
  // Groups, sections, pages and frames that let children out: the union of what the children paint,
  // then the container's own effects around that union.
  let rect: Rect | null = node.type === 'GROUP' || node.type === 'PAGE' ? null : transformRect(world, localRenderBounds({...node, effects: []}, options.measurer));
  for (const childId of node.children ?? []) {
    const child = doc.nodes[childId];
    if (!child) continue;
    const childRect = subtreeRenderBounds(doc, child, multiply(world, localMatrix(child)), childOptions);
    if (childRect) rect = rect ? unionRect(rect, childRect) : childRect;
  }
  return rect && expandWorldByEffects(rect, node, world);
}

/** Page-space bounds of what the node paints (with its descendants), or null when it paints nothing.
 *  A slice answers with its box: that is the region it exports. */
export function renderBounds(doc: DesignDocument, id: NodeId, options: RenderBoundsOptions = {}): Rect | null {
  const node = doc.nodes[id];
  if (!node) return null;
  const world = worldMatrix(doc, id);
  if (node.type === 'SLICE') return transformRect(world, {x: 0, y: 0, width: node.width, height: node.height});
  return subtreeRenderBounds(doc, node, world, options);
}
