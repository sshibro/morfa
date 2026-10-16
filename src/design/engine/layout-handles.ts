import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from '../../../shared/design/types';
import {apply, invert, localMatrix, multiply, transformRect, worldMatrix, type Rect} from '../../../shared/design/geometry';
import type {Viewport} from './contracts';
import {screenMatrix} from './overlay';

// Auto layout's padding and gap on the canvas (Figma: "Adjust padding and spacing on the canvas"; docs/figma-parity.md 3.5,
// lane FD's request to lane K): a selected auto-layout frame shows each padding band and each gap between its layers in
// pink where the pointer is, with a bar in the middle that a drag moves. Pure functions over documents, so they are tested
// without a canvas; the move tool drags them (tools/move.ts) and the overlay draws them (overlay.ts `layoutHandleItems`).

export type PaddingSide = 'top' | 'right' | 'bottom' | 'left';

export type LayoutHandle =
  /** A padding band of the frame (frame-local), its bar's middle, and which way is inward. */
  | {kind: 'padding'; side: PaddingSide; area: Rect; at: Vec; inward: Vec; value: number}
  /** The gap after the flow's `index`-th layer (frame-local), its bar's middle, and the flow's direction. */
  | {kind: 'gap'; index: number; area: Rect; at: Vec; along: Vec; value: number};

/** The handles of `id` when it is an auto-layout frame (horizontal or vertical) shown big enough to hold them. */
export type LayoutHandles = {id: NodeId; matrix: Matrix; handles: LayoutHandle[]};

/** Screen px a bar is long, and how far from it the pointer still grabs it. */
export const LAYOUT_BAR = 12;
const BAR_REACH = 5;
/** A bar never sits nearer an edge than this (screen px), so the edge's resize handle stays where it is. */
const BAR_INSET = 7;
/** Below this on screen (CSS px), a frame shows no padding or gap handles. */
const MIN_SCREEN = 48;

const flowChildren = (doc: DesignDocument, node: SceneNode): SceneNode[] =>
  (node.children ?? []).map(id => doc.nodes[id]).filter((child): child is SceneNode => !!child && child.visible !== false && child.layoutPositioning !== 'ABSOLUTE');

export function layoutHandles(doc: DesignDocument, id: NodeId, viewport: Viewport): LayoutHandles | null {
  const node = doc.nodes[id];
  const layout = node?.autoLayout;
  if (!node || !layout || (layout.layoutMode !== 'HORIZONTAL' && layout.layoutMode !== 'VERTICAL')) return null;
  const matrix = worldMatrix(doc, id);
  const scale = Math.hypot(matrix[0][0], matrix[1][0]) * viewport.zoom;
  if (!(scale > 0) || node.width * scale < MIN_SCREEN || node.height * scale < MIN_SCREEN) return null;
  const w = node.width, h = node.height;
  const inset = BAR_INSET / scale;
  const {paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left} = layout;
  const middle = (pad: number, size: number) => Math.min(size / 2, Math.max(pad / 2, inset));
  const handles: LayoutHandle[] = [
    {kind: 'padding', side: 'top', area: {x: 0, y: 0, width: w, height: Math.max(0, top)}, at: {x: w / 2, y: middle(top, h)}, inward: {x: 0, y: 1}, value: top},
    {kind: 'padding', side: 'right', area: {x: w - Math.max(0, right), y: 0, width: Math.max(0, right), height: h}, at: {x: w - middle(right, w), y: h / 2}, inward: {x: -1, y: 0}, value: right},
    {kind: 'padding', side: 'bottom', area: {x: 0, y: h - Math.max(0, bottom), width: w, height: Math.max(0, bottom)}, at: {x: w / 2, y: h - middle(bottom, h)}, inward: {x: 0, y: -1}, value: bottom},
    {kind: 'padding', side: 'left', area: {x: 0, y: 0, width: Math.max(0, left), height: h}, at: {x: middle(left, w), y: h / 2}, inward: {x: 1, y: 0}, value: left},
  ];
  // Gaps between neighbours of one row (a wrapping frame's rows are not drawn: their breaks move with the gap).
  if (layout.layoutWrap !== 'WRAP') {
    const horizontal = layout.layoutMode === 'HORIZONTAL';
    const boxes = flowChildren(doc, node).map(child => transformRect(localMatrix(child), {x: 0, y: 0, width: child.width, height: child.height}));
    const spread = layout.primaryAxisAlignItems === 'SPACE_BETWEEN';
    const crossStart = horizontal ? top : left, crossEnd = horizontal ? h - bottom : w - right;
    for (let i = 0; i + 1 < boxes.length; i++) {
      const a = boxes[i], b = boxes[i + 1];
      const start = horizontal ? a.x + a.width : a.y + a.height;
      const end = horizontal ? b.x : b.y;
      if (end < start) continue;
      const area = horizontal ? {x: start, y: crossStart, width: end - start, height: Math.max(0, crossEnd - crossStart)} : {x: crossStart, y: start, width: Math.max(0, crossEnd - crossStart), height: end - start};
      const at = {x: area.x + area.width / 2, y: area.y + area.height / 2};
      handles.push({kind: 'gap', index: i, area, at, along: horizontal ? {x: 1, y: 0} : {x: 0, y: 1}, value: spread ? Math.round((end - start) * 100) / 100 : layout.itemSpacing});
    }
  }
  return {id, matrix, handles};
}

/** The bar of a handle in screen px: its two ends (across the band: parallel to the side for padding, across the flow for
 *  a gap). */
export function barOf(handles: LayoutHandles, handle: LayoutHandle, viewport: Viewport): [Vec, Vec] {
  const m = multiply(screenMatrix(viewport), handles.matrix);
  const centre = apply(m, handle.at);
  // The bar runs along the band (padding) or across the flow (gap): perpendicular to `inward` / `along`.
  const normal = handle.kind === 'padding' ? handle.inward : handle.along;
  const dir = apply(m, {x: handle.at.x - normal.y, y: handle.at.y + normal.x});
  const len = Math.hypot(dir.x - centre.x, dir.y - centre.y) || 1;
  const ux = (dir.x - centre.x) / len, uy = (dir.y - centre.y) / len;
  const half = LAYOUT_BAR / 2;
  return [{x: centre.x - ux * half, y: centre.y - uy * half}, {x: centre.x + ux * half, y: centre.y + uy * half}];
}

const distanceToSegment = (p: Vec, [a, b]: [Vec, Vec]) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
};

/** The handle whose bar is under the screen point, nearest first. */
export function hitLayoutHandle(handles: LayoutHandles, screen: Vec, viewport: Viewport): LayoutHandle | null {
  let best: {handle: LayoutHandle; d: number} | null = null;
  for (const handle of handles.handles) {
    const d = distanceToSegment(screen, barOf(handles, handle, viewport));
    if (d <= BAR_REACH && (!best || d < best.d)) best = {handle, d};
  }
  return best?.handle ?? null;
}

/** The handle whose area holds the screen point (what the pointer hovers: shown with its bar). Gaps before padding. */
export function layoutHandleAt(handles: LayoutHandles, screen: Vec, viewport: Viewport): LayoutHandle | null {
  const hit = hitLayoutHandle(handles, screen, viewport);
  if (hit) return hit;
  const local = apply(invert(multiply(screenMatrix(viewport), handles.matrix)), screen);
  const inside = (r: Rect) => local.x >= r.x && local.x <= r.x + r.width && local.y >= r.y && local.y <= r.y + r.height;
  return handles.handles.find(h => h.kind === 'gap' && inside(h.area)) ?? handles.handles.find(h => h.kind === 'padding' && h.area.width > 0 && h.area.height > 0 && inside(h.area)) ?? null;
}

const OPPOSITE: Record<PaddingSide, PaddingSide> = {top: 'bottom', bottom: 'top', left: 'right', right: 'left'};
const FIELD = {top: 'paddingTop', right: 'paddingRight', bottom: 'paddingBottom', left: 'paddingLeft'} as const;

/** What a drag of a padding bar by `travel` frame-local units inward sets: that side; with `alt` the opposite one too; with
 *  `alt` and `shift` all four (Figma's modifiers). Whole units, never below 0. */
export function paddingDrag(start: SceneNode, side: PaddingSide, travel: number, mods: {alt: boolean; shift: boolean}): Partial<SceneNode> {
  const layout = start.autoLayout!;
  const value = Math.max(0, Math.round(layout[FIELD[side]] + travel));
  const sides: PaddingSide[] = mods.alt && mods.shift ? ['top', 'right', 'bottom', 'left'] : mods.alt ? [side, OPPOSITE[side]] : [side];
  const next = {...layout};
  for (const each of sides) next[FIELD[each]] = value;
  return {autoLayout: next};
}

/** What a drag of a gap bar by `travel` frame-local units along the flow sets: the gap grows by the travel (from the gap
 *  shown when it was "Auto", which then becomes a fixed gap, as the panel does). Whole units. */
export function gapDrag(start: SceneNode, shown: number, travel: number): Partial<SceneNode> {
  const layout = start.autoLayout!;
  const itemSpacing = Math.round(shown + travel);
  return {autoLayout: {...layout, itemSpacing, ...(layout.primaryAxisAlignItems === 'SPACE_BETWEEN' ? {primaryAxisAlignItems: 'MIN' as const} : {})}};
}

/** `local` travel of a page-space drag along a frame-local direction. */
export function travelAlong(handles: LayoutHandles, from: Vec, to: Vec, direction: Vec): number {
  const inv = invert(handles.matrix);
  const a = apply(inv, from), b = apply(inv, to);
  return (b.x - a.x) * direction.x + (b.y - a.y) * direction.y;
}
