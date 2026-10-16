import type {DesignDocument, NodeId, Vec} from '../../../shared/design/types';
import {applyLinear, invert, transformRect, worldMatrix, type Rect} from '../../../shared/design/geometry';
import type {Transaction} from '../../../shared/design/transaction';
import type {Viewport} from './contracts';
import {userUpdate} from './user-edit';

// Figma's "smart selection" spacing (docs/figma-parity.md 2.9, lane FD's request to lane K): layers selected in a row or a
// column with equal gaps between them show a pink bar in each gap; a drag of one sets every gap at once, the first layer
// staying where it is. Pure functions over documents (tested without a canvas); the move tool drags them and draws them.

export type SpacingHandles = {
  /** The axis the layers follow. */
  axis: 'x' | 'y';
  gap: number;
  /** In order along the axis, with their page bounds. */
  items: {id: NodeId; box: Rect}[];
  /** Page-space gaps between neighbours (`index`: after the index-th item), and their bars' middles. */
  gaps: {index: number; area: Rect; at: Vec}[];
};

/** Screen px a bar is long, and how far from it the pointer still grabs it. */
export const SPACING_BAR = 10;
const BAR_REACH = 5;
/** Gaps equal to within this (page px) count as equal. */
const EQUAL = 0.01;
/** Selections larger than this are not checked (a select-all of a big page). */
const MAX_ITEMS = 200;

const pageBox = (doc: DesignDocument, id: NodeId): Rect => transformRect(worldMatrix(doc, id), {x: 0, y: 0, width: doc.nodes[id].width, height: doc.nodes[id].height});

/** The spacing handles of a selection, when it is two or more layers in a row or column with equal gaps, none placed by an
 *  auto layout. */
export function spacingHandles(doc: DesignDocument, ids: readonly NodeId[]): SpacingHandles | null {
  if (ids.length < 2 || ids.length > MAX_ITEMS) return null;
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node || node.type === 'PAGE') return null;
    const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
    if (parent?.autoLayout && parent.autoLayout.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE') return null;
  }
  const boxes = ids.map(id => ({id, box: pageBox(doc, id)}));
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 'width' : 'height';
    const items = [...boxes].sort((a, b) => a.box[axis] - b.box[axis]);
    const gaps: number[] = [];
    for (let i = 0; i + 1 < items.length; i++) gaps.push(items[i + 1].box[axis] - (items[i].box[axis] + items[i].box[size]));
    if (gaps.some(g => g < 0) || gaps.some(g => Math.abs(g - gaps[0]) > EQUAL)) continue;
    const cross = axis === 'x' ? 'y' : 'x', crossSize = axis === 'x' ? 'height' : 'width';
    const out: SpacingHandles['gaps'] = [];
    for (let i = 0; i < gaps.length; i++) {
      const a = items[i].box, b = items[i + 1].box;
      // Across the gap: where the two neighbours overlap, else from one's middle to the other's.
      const lo = Math.max(a[cross], b[cross]), hi = Math.min(a[cross] + a[crossSize], b[cross] + b[crossSize]);
      const [from, to] = lo <= hi ? [lo, hi] : [Math.min(a[cross] + a[crossSize] / 2, b[cross] + b[crossSize] / 2), Math.max(a[cross] + a[crossSize] / 2, b[cross] + b[crossSize] / 2)];
      const start = a[axis] + a[size];
      const area = axis === 'x' ? {x: start, y: from, width: gaps[i], height: to - from} : {x: from, y: start, width: to - from, height: gaps[i]};
      out.push({index: i, area, at: {x: area.x + area.width / 2, y: area.y + area.height / 2}});
    }
    return {axis, gap: Math.round(gaps[0] * 100) / 100, items, gaps: out};
  }
  return null;
}

/** A gap's bar in screen px: across the gap (along the other axis). */
export function spacingBar(handles: SpacingHandles, index: number, viewport: Viewport): [Vec, Vec] {
  const at = handles.gaps[index].at;
  const centre = {x: (at.x - viewport.x) * viewport.zoom, y: (at.y - viewport.y) * viewport.zoom};
  const half = SPACING_BAR / 2;
  return handles.axis === 'x' ? [{x: centre.x, y: centre.y - half}, {x: centre.x, y: centre.y + half}] : [{x: centre.x - half, y: centre.y}, {x: centre.x + half, y: centre.y}];
}

/** The gap whose bar is under the screen point. */
export function hitSpacingHandle(handles: SpacingHandles, screen: Vec, viewport: Viewport): number | null {
  let best: {index: number; d: number} | null = null;
  for (const gap of handles.gaps) {
    const [a, b] = spacingBar(handles, gap.index, viewport);
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((screen.x - a.x) * dx + (screen.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(screen.x - (a.x + dx * t), screen.y - (a.y + dy * t));
    if (d <= BAR_REACH && (!best || d < best.d)) best = {index: gap.index, d};
  }
  return best?.index ?? null;
}

/** The gap whose area holds the page point. */
export function spacingGapAt(handles: SpacingHandles, page: Vec): number | null {
  const gap = handles.gaps.find(({area: r}) => page.x >= r.x && page.x <= r.x + r.width && page.y >= r.y && page.y <= r.y + r.height);
  return gap ? gap.index : null;
}

/** Every gap set to `gap` (whole page px, never below 0): each layer after the first moves along the axis by what the gaps
 *  before it grew, in its parent's own space. Returns the gap set. */
export function applySpacing(tx: Transaction, doc: DesignDocument, handles: SpacingHandles, travel: number): number {
  const gap = Math.max(0, Math.round(handles.gap + travel));
  const step = gap - handles.gap;
  handles.items.forEach(({id}, i) => {
    if (!i) return;
    const node = doc.nodes[id];
    const along = i * step;
    const parentInverse = invert(worldMatrix(doc, node.parentId!));
    const local = applyLinear(parentInverse, handles.axis === 'x' ? {x: along, y: 0} : {x: 0, y: along});
    userUpdate(tx, id, {x: node.x + local.x, y: node.y + local.y});
  });
  return gap;
}
