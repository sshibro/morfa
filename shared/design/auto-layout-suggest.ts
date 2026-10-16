import type {AutoLayout, DesignDocument, LayoutSizing, NodeId, SceneNode} from './types';
import {FRAME_LIKE_TYPES} from './types';
import {defaultAutoLayout} from './defaults';
import {unionRects, worldBox} from './geometry';
import type {Rect} from './geometry';
import {boundsOf, isAutoLayout} from './constraints';

// "Add auto layout" (⇧A). On a frame without auto layout it turns the frame's layout on; on
// anything else (several layers, one layer, an auto-layout frame) it wraps the selection in a new
// auto-layout frame. Either way the result should look like what was there: the direction is the
// one the items are spread along, the order is their order on screen, the gap is the typical gap
// between them, the padding (for an existing frame) is the room around them, and the cross-axis
// alignment is the edge or centre line they share.

export type AutoLayoutSuggestion = {
  /** The frame that gets auto layout, or null: wrap the items in a new frame with `box`. */
  frameId: NodeId | null;
  autoLayout: AutoLayout;
  /** The items in flow order (first = left or top), to become the frame's children in that order. */
  order: NodeId[];
  /** The frame's box: its own for an existing frame, else the items' bounds in their common
   *  parent's space (in page space when they have different parents). */
  box: Rect;
  sizing: {horizontal: LayoutSizing; vertical: LayoutSizing};
};

/** Figma's spacing for a new auto layout with nothing to infer it from. */
const DEFAULT_SPACING = 10;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const spread = (values: readonly number[]) => Math.max(...values) - Math.min(...values);

/** The cross-axis alignment the items share: the line (start, centre or end) they lie closest to,
 *  preferring start, then centre, on a tie within half a pixel. */
function inferAlignment(rects: readonly Rect[], horizontal: boolean): AutoLayout['counterAxisAlignItems'] {
  if (rects.length < 2) return 'MIN';
  const start = (r: Rect) => (horizontal ? r.y : r.x), size = (r: Rect) => (horizontal ? r.height : r.width);
  const candidates: [AutoLayout['counterAxisAlignItems'], number][] = [
    ['MIN', spread(rects.map(start))],
    ['CENTER', spread(rects.map(r => start(r) + size(r) / 2))],
    ['MAX', spread(rects.map(r => start(r) + size(r)))],
  ];
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) if (candidate[1] < best[1] - 0.5) best = candidate;
  return best[0];
}

/** What ⇧A would do with `ids` (null when there is nothing to lay out). */
export function suggestAutoLayout(doc: DesignDocument, ids: readonly NodeId[]): AutoLayoutSuggestion | null {
  const nodes = ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && node.type !== 'PAGE');
  if (!nodes.length) return null;
  const single = nodes.length === 1 ? nodes[0] : null;
  const frame = single && FRAME_LIKE_TYPES.includes(single.type) && !isAutoLayout(single) ? single : null;

  let items: SceneNode[], rects: Rect[], box: Rect;
  if (frame) {
    items = (frame.children ?? []).map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node);
    rects = items.map(node => boundsOf(node));
    box = {x: frame.x, y: frame.y, width: frame.width, height: frame.height};
  } else {
    items = nodes;
    const shared = nodes.every(node => node.parentId === nodes[0].parentId);
    rects = nodes.map(node => (shared ? boundsOf(node) : worldBox(doc, node.id)));
    box = unionRects(rects)!;
  }

  // Hidden items keep their place in the order but do not shape the inference.
  const shown = items.map((node, i) => ({node, rect: rects[i], index: i})).filter(entry => entry.node.visible);
  const centres = shown.map(({rect}) => ({x: rect.x + rect.width / 2, y: rect.y + rect.height / 2}));
  const horizontal = shown.length < 2 || spread(centres.map(c => c.x)) >= spread(centres.map(c => c.y));
  const along = (r: Rect) => (horizontal ? r.x : r.y), across = (r: Rect) => (horizontal ? r.y : r.x);
  const length = (r: Rect) => (horizontal ? r.width : r.height);

  const ordered = items.map((node, index) => ({node, rect: rects[index], index}))
    .sort((a, b) => along(a.rect) - along(b.rect) || across(a.rect) - across(b.rect) || a.index - b.index);
  const flow = ordered.filter(entry => entry.node.visible);
  const gaps = flow.slice(1).map((entry, i) => along(entry.rect) - (along(flow[i].rect) + length(flow[i].rect)));

  const autoLayout = defaultAutoLayout(horizontal ? 'HORIZONTAL' : 'VERTICAL');
  autoLayout.itemSpacing = gaps.length ? Math.round(median(gaps)) : DEFAULT_SPACING;
  autoLayout.counterAxisAlignItems = inferAlignment(flow.map(entry => entry.rect), horizontal);
  if (frame && flow.length) {
    const content = unionRects(flow.map(entry => entry.rect))!;
    const room = (value: number) => Math.max(0, Math.round(value));
    autoLayout.paddingLeft = room(content.x);
    autoLayout.paddingTop = room(content.y);
    autoLayout.paddingRight = room(frame.width - content.x - content.width);
    autoLayout.paddingBottom = room(frame.height - content.y - content.height);
    if (flow.length === 1) {
      // One item: its place in the frame is the alignment (padding then keeps the frame's size).
      const [lead, trail] = horizontal ? [autoLayout.paddingTop, autoLayout.paddingBottom] : [autoLayout.paddingLeft, autoLayout.paddingRight];
      autoLayout.counterAxisAlignItems = Math.abs(lead - trail) <= 1 && lead > 0 ? 'CENTER' : 'MIN';
    }
  }
  // An empty frame keeps its size; anything with content hugs it.
  const sizing: LayoutSizing = frame && !flow.length ? 'FIXED' : 'HUG';
  return {frameId: frame?.id ?? null, autoLayout, order: ordered.map(entry => entry.node.id), box, sizing: {horizontal: sizing, vertical: sizing}};
}
