import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from '../../../shared/design/types';
import {apply, applyLinear, multiply, worldMatrices, worldMatrix, type Rect} from '../../../shared/design/geometry';
import {isComponentLike, isInsideInstance} from '../../../shared/design/tree';
import {pointAlong, textPathSampler} from '../../../shared/design/text-path';
import type {Viewport} from './contracts';
import {nodeOutline} from './hit-test';
import {formatNumber, selectionBox, sizeLabel, type SelectionBox} from './selection';

// The overlay canvas sits above the scene and is drawn in screen (CSS) pixels, so selection
// outlines, handles and labels stay one crisp pixel wide at every zoom. It is redrawn on its own
// when only the selection, the hover or a tool's feedback changes; the scene is not touched.

export const OVERLAY_COLORS = {
  accent: '#0D99FF',
  component: '#9747FF',
  guide: '#F24822',
  /** Auto layout's padding and gap on the canvas (layout-handles.ts). */
  spacing: '#F24FAE',
  spacingFill: 'rgba(242, 79, 174, 0.15)',
  handleFill: '#FFFFFF',
  marqueeFill: 'rgba(13, 153, 255, 0.1)',
  // Figma's look: #F2F2F2 over white, a shade darker over light greys, a faint light line over dark fills.
  pixelGrid: 'rgba(128, 128, 128, 0.1)',
  labelText: '#FFFFFF',
} as const;

/** Side of a resize handle, CSS px. */
export const HANDLE_SIZE = 7;
/** A side of a selection shorter than half this on screen is not grabbed along its length (its
 *  corners are, so a tiny box stays resizable). */
export const TINY_BOX = 24;
/** The pixel grid appears from this zoom on. */
export const PIXEL_GRID_ZOOM = 8;
export const LABEL_FONT = '500 11px "Inter Variable", Inter, system-ui, sans-serif';
/** Above this many selected layers only the union box is drawn: thousands of outlines would cost
 *  more per frame than they tell the user. */
export const MAX_OUTLINED = 500;

/** Feedback a tool or the smart guides ask the overlay to draw. Positions are in page space. */
export type OverlayItem =
  | {kind: 'line'; from: Vec; to: Vec; color?: string; dash?: number[]; width?: number}
  | {kind: 'rect'; rect: Rect; stroke?: string; fill?: string; dash?: number[]}
  | {kind: 'polyline'; points: Vec[]; closed?: boolean; stroke?: string; fill?: string; dash?: number[]}
  | {kind: 'point'; at: Vec; color?: string; shape?: 'cross' | 'dot'}
  /** A pill with text; `offset` moves it in screen px from `at`. */
  | {kind: 'label'; at: Vec; text: string; color?: string; background?: string; offset?: Vec};

export type OverlayScene = {
  doc: DesignDocument;
  pageId: NodeId;
  viewport: Viewport;
  size: {width: number; height: number};
  dpr: number;
  selection: readonly NodeId[];
  hoverId: NodeId | null;
  context: NodeId | null;
  /** Resize handles on the selection box (hidden while moving or rotating). */
  handles: boolean;
  /** The "120 × 48" badge under the selection. */
  sizeBadge: boolean;
  pixelGrid: boolean;
  items: readonly OverlayItem[];
  /** Nodes not outlined (the text being edited draws its own frame). */
  hidden?: ReadonlySet<NodeId>;
};

/** Page space → screen (CSS px) for a viewport. */
export const screenMatrix = (viewport: Viewport): Matrix => [[viewport.zoom, 0, -viewport.x * viewport.zoom], [0, viewport.zoom, -viewport.y * viewport.zoom]];

const colorFor = (doc: DesignDocument, id: NodeId) => (isComponentLike(doc.nodes[id]) || isInsideInstance(doc, id) ? OVERLAY_COLORS.component : OVERLAY_COLORS.accent);

/** What the overlay draws for a selection, in page space: it depends on the document and the selection only, so a pan
 *  or a zoom (a redraw every frame) reuses it instead of measuring thousands of selected layers again. */
export type SelectionMarks = {
  /** The selected ids the overlay outlines (present, not hidden). */
  ids: readonly NodeId[];
  selected: ReadonlySet<NodeId>;
  accent: string;
  /** Each outlined layer's world matrix and box size, with its colour (only up to MAX_OUTLINED layers). */
  outlines: readonly {matrix: Matrix; width: number; height: number; color: string}[];
  box: SelectionBox | null;
};
let marks: {doc: DesignDocument; selection: readonly NodeId[]; hidden: ReadonlySet<NodeId> | undefined; value: SelectionMarks} | null = null;

const sameHidden = (a: ReadonlySet<NodeId> | undefined, b: ReadonlySet<NodeId> | undefined) =>
  a === b || ((a?.size ?? 0) === (b?.size ?? 0) && [...(a ?? [])].every(id => b!.has(id)));

/** The selection's marks, worked out again only when the document, the selection or the hidden layers changed. */
export function selectionMarks(doc: DesignDocument, selection: readonly NodeId[], hidden?: ReadonlySet<NodeId>): SelectionMarks {
  if (marks && marks.doc === doc && marks.selection === selection && sameHidden(marks.hidden, hidden)) return marks.value;
  const ids = selection.filter(id => doc.nodes[id] && !hidden?.has(id));
  const accent = ids.every(id => colorFor(doc, id) === OVERLAY_COLORS.component) ? OVERLAY_COLORS.component : OVERLAY_COLORS.accent;
  const world = worldMatrices(doc);
  const outlines = ids.length > 1 && ids.length <= MAX_OUTLINED
    ? ids.map(id => ({matrix: world(id), width: doc.nodes[id].width, height: doc.nodes[id].height, color: colorFor(doc, id)}))
    : [];
  const value: SelectionMarks = {ids, selected: new Set(selection), accent, outlines, box: ids.length ? selectionBox(doc, ids) : null};
  marks = {doc, selection, hidden, value};
  return value;
}

function tracePolylines(ctx: CanvasRenderingContext2D, m: Matrix, polylines: {points: number[]; closed: boolean}[]) {
  ctx.beginPath();
  for (const {points, closed} of polylines) {
    for (let i = 0; i < points.length; i += 2) {
      const p = apply(m, {x: points[i], y: points[i + 1]});
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    }
    if (closed) ctx.closePath();
  }
}

function traceBox(ctx: CanvasRenderingContext2D, m: Matrix, width: number, height: number) {
  const points = [{x: 0, y: 0}, {x: width, y: 0}, {x: width, y: height}, {x: 0, y: height}].map(p => apply(m, p));
  const axisAligned = Math.abs(m[0][1]) < 1e-9 && Math.abs(m[1][0]) < 1e-9;
  ctx.beginPath();
  points.forEach((p, i) => {
    // Axis-aligned edges land on half pixels so a 1 px line is one device pixel at 1×.
    const x = axisAligned ? Math.round(p.x) + 0.5 : p.x, y = axisAligned ? Math.round(p.y) + 0.5 : p.y;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.closePath();
}

/** Draws the outline the user sees for a node: its shape for shapes, its box for the rest. */
export function strokeNodeOutline(ctx: CanvasRenderingContext2D, doc: DesignDocument, id: NodeId, viewport: Viewport, color: string, width = 1) {
  const node = doc.nodes[id];
  if (!node) return;
  const m = multiply(screenMatrix(viewport), worldMatrix(doc, id));
  tracePolylines(ctx, m, nodeOutline(node));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash([]);
  ctx.stroke();
}

/** Corner and edge-midpoint positions of a box in its local space, with the handle direction. */
export function handleAnchors(width: number, height: number, withEdges: boolean): {hx: -1 | 0 | 1; hy: -1 | 0 | 1; local: Vec}[] {
  const out: {hx: -1 | 0 | 1; hy: -1 | 0 | 1; local: Vec}[] = [];
  for (const hy of [-1, 0, 1] as const) for (const hx of [-1, 0, 1] as const) {
    if (!hx && !hy) continue;
    if ((!hx || !hy) && !withEdges) continue;
    out.push({hx, hy, local: {x: ((hx + 1) / 2) * width, y: ((hy + 1) / 2) * height}});
  }
  return out;
}

/** Screen size of a box's sides (for the "tiny box" rule). */
export function screenExtent(box: SelectionBox, viewport: Viewport): {width: number; height: number} {
  const m = multiply(screenMatrix(viewport), box.matrix);
  const u = applyLinear(m, {x: box.width, y: 0}), v = applyLinear(m, {x: 0, y: box.height});
  return {width: Math.hypot(u.x, u.y), height: Math.hypot(v.x, v.y)};
}

export const isLineBox = (doc: DesignDocument, box: SelectionBox) => !!box.nodeId && doc.nodes[box.nodeId]?.type === 'LINE';

/** Layers whose corners a radius handle rounds on the canvas, as in Figma. */
const RADIUS_HANDLE_TYPES = new Set<SceneNode['type']>(['RECTANGLE', 'FRAME', 'COMPONENT', 'INSTANCE']);
/** A radius handle stands this far in from its corner (screen px) until the radius reaches further. */
export const RADIUS_HANDLE_INSET = 12;
/** Radius handles show on a layer at least this big on screen (smaller ones keep the room for resizing). */
const RADIUS_HANDLES_FROM = 56;
/** Corners in the order of `rectangleCornerRadii`: top-left, top-right, bottom-right, bottom-left, and the way in. */
export const RADIUS_CORNERS = [{x: 0, y: 0, dx: 1, dy: 1}, {x: 1, y: 0, dx: -1, dy: 1}, {x: 1, y: 1, dx: -1, dy: -1}, {x: 0, y: 1, dx: 1, dy: -1}] as const;

/** The corner radii of a layer, top-left first. */
export const cornerRadii = (node: SceneNode): [number, number, number, number] =>
  node.rectangleCornerRadii ?? [node.cornerRadius ?? 0, node.cornerRadius ?? 0, node.cornerRadius ?? 0, node.cornerRadius ?? 0];

/** The radius handles of a single selected rectangle or frame, in screen px (none for anything else, or when it is
 *  small on screen): each on its corner's diagonal, at the radius or `RADIUS_HANDLE_INSET` in, whichever is further. */
export function radiusHandles(doc: DesignDocument, box: SelectionBox, viewport: Viewport): {corner: 0 | 1 | 2 | 3; at: Vec}[] {
  const node = box.nodeId ? doc.nodes[box.nodeId] : undefined;
  if (!node || !RADIUS_HANDLE_TYPES.has(node.type) || node.locked) return [];
  const extent = screenExtent(box, viewport);
  if (Math.min(extent.width, extent.height) < RADIUS_HANDLES_FROM) return [];
  const m = multiply(screenMatrix(viewport), box.matrix);
  const scale = Math.min(extent.width / Math.max(box.width, 1e-9), extent.height / Math.max(box.height, 1e-9));
  const radii = cornerRadii(node);
  const limit = Math.min(box.width, box.height) / 2;
  return RADIUS_CORNERS.map((corner, index) => {
    const inset = Math.max(Math.min(radii[index], limit), RADIUS_HANDLE_INSET / scale);
    return {corner: index as 0 | 1 | 2 | 3, at: apply(m, {x: corner.x * box.width + corner.dx * inset, y: corner.y * box.height + corner.dy * inset})};
  });
}

/** A single selected text on a path ("Text on path", shared/design/text-path.ts): its path through `toScreen`, and
 *  its start handle — the point of the path where the text is anchored (`startOffset`) — in screen px. Null for anything
 *  else (or a locked text). */
export function textPathHandle(doc: DesignDocument, box: SelectionBox, viewport: Viewport): {at: Vec; path: Vec[]; closed: boolean} | null {
  const node = box.nodeId ? doc.nodes[box.nodeId] : undefined;
  if (!node || node.type !== 'TEXT' || !node.textPath || node.locked) return null;
  const sampler = textPathSampler(node.textPath);
  if (!sampler) return null;
  const at = pointAlong(sampler, Math.max(0, Math.min(1, node.textPath.startOffset)) * sampler.length, true);
  if (!at) return null;
  const m = multiply(screenMatrix(viewport), box.matrix);
  return {at: apply(m, at.point), path: sampler.points.map(p => apply(m, p)), closed: sampler.closed};
}

function drawHandle(ctx: CanvasRenderingContext2D, at: Vec, angle: number, color: string, round = false) {
  ctx.save();
  ctx.translate(Math.round(at.x) + 0.5, Math.round(at.y) + 0.5);
  ctx.rotate(angle);
  ctx.beginPath();
  if (round) ctx.arc(0, 0, HANDLE_SIZE / 2, 0, Math.PI * 2);
  else ctx.rect(-HANDLE_SIZE / 2, -HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
  ctx.fillStyle = OVERLAY_COLORS.handleFill;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.restore();
}

/** Radius of a radius handle's dot, CSS px. */
export const RADIUS_HANDLE_SIZE = 3;

function drawRadiusHandle(ctx: CanvasRenderingContext2D, at: Vec, color: string) {
  ctx.beginPath();
  ctx.arc(Math.round(at.x) + 0.5, Math.round(at.y) + 0.5, RADIUS_HANDLE_SIZE, 0, Math.PI * 2);
  ctx.fillStyle = OVERLAY_COLORS.handleFill;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.stroke();
}

/** A pill label centred on `at` horizontally with its top at `at.y` (screen px). */
export function drawLabel(ctx: CanvasRenderingContext2D, at: Vec, text: string, options: {background?: string; color?: string; anchor?: 'top' | 'center'} = {}) {
  ctx.save();
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const width = Math.ceil(ctx.measureText(text).width) + 8;
  const height = 18;
  const left = Math.round(at.x - width / 2);
  const top = Math.round(options.anchor === 'center' ? at.y - height / 2 : at.y);
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, 3);
  ctx.fillStyle = options.background ?? OVERLAY_COLORS.accent;
  ctx.fill();
  ctx.fillStyle = options.color ?? OVERLAY_COLORS.labelText;
  ctx.fillText(text, left + width / 2, top + height / 2 + 0.5);
  ctx.restore();
}

/** The marquee rectangle (screen px). */
export function drawMarquee(ctx: CanvasRenderingContext2D, rect: Rect) {
  const x = Math.round(rect.x) + 0.5, y = Math.round(rect.y) + 0.5;
  ctx.save();
  ctx.fillStyle = OVERLAY_COLORS.marqueeFill;
  ctx.fillRect(x, y, Math.round(rect.width), Math.round(rect.height));
  ctx.strokeStyle = OVERLAY_COLORS.accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, Math.round(rect.width), Math.round(rect.height));
  ctx.restore();
}

/** One device pixel wide, on whole device pixels (as Figma draws it): a CSS pixel would be two on a Retina screen. */
function drawPixelGrid(ctx: CanvasRenderingContext2D, viewport: Viewport, size: {width: number; height: number}, dpr: number) {
  const {zoom} = viewport;
  const ratio = dpr > 0 ? dpr : 1;
  const onDevicePixel = (screen: number) => (Math.round(screen * ratio) + 0.5) / ratio;
  ctx.save();
  ctx.beginPath();
  const startX = Math.ceil(viewport.x), endX = viewport.x + size.width / zoom;
  for (let x = startX; x <= endX; x++) {
    const sx = onDevicePixel((x - viewport.x) * zoom);
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, size.height);
  }
  const startY = Math.ceil(viewport.y), endY = viewport.y + size.height / zoom;
  for (let y = startY; y <= endY; y++) {
    const sy = onDevicePixel((y - viewport.y) * zoom);
    ctx.moveTo(0, sy);
    ctx.lineTo(size.width, sy);
  }
  ctx.strokeStyle = OVERLAY_COLORS.pixelGrid;
  ctx.lineWidth = 1 / ratio;
  ctx.stroke();
  ctx.restore();
}

export function drawItems(ctx: CanvasRenderingContext2D, items: readonly OverlayItem[], viewport: Viewport) {
  const m = screenMatrix(viewport);
  for (const item of items) {
    ctx.save();
    switch (item.kind) {
      case 'line': {
        const a = apply(m, item.from), b = apply(m, item.to);
        const lineWidth = item.width ?? 1;
        // Axis-aligned hairlines (smart guides) land on pixel centres so they stay one pixel wide.
        if (lineWidth % 2 === 1) {
          if (Math.abs(a.x - b.x) < 1e-6) a.x = b.x = Math.round(a.x) + 0.5;
          else if (Math.abs(a.y - b.y) < 1e-6) a.y = b.y = Math.round(a.y) + 0.5;
        }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = item.color ?? OVERLAY_COLORS.guide;
        ctx.lineWidth = lineWidth;
        ctx.setLineDash(item.dash ?? []);
        ctx.stroke();
        break;
      }
      case 'rect':
      case 'polyline': {
        const points = item.kind === 'rect'
          ? [{x: item.rect.x, y: item.rect.y}, {x: item.rect.x + item.rect.width, y: item.rect.y}, {x: item.rect.x + item.rect.width, y: item.rect.y + item.rect.height}, {x: item.rect.x, y: item.rect.y + item.rect.height}]
          : item.points;
        ctx.beginPath();
        points.map(p => apply(m, p)).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        if (item.kind === 'rect' || item.closed) ctx.closePath();
        if (item.fill) {
          ctx.fillStyle = item.fill;
          ctx.fill();
        }
        if (item.stroke ?? !item.fill) {
          ctx.strokeStyle = item.stroke ?? OVERLAY_COLORS.guide;
          ctx.lineWidth = 1;
          ctx.setLineDash(item.dash ?? []);
          ctx.stroke();
        }
        break;
      }
      case 'point': {
        const p = apply(m, item.at);
        ctx.strokeStyle = ctx.fillStyle = item.color ?? OVERLAY_COLORS.guide;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (item.shape === 'dot') {
          ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.moveTo(p.x - 3, p.y - 3);
          ctx.lineTo(p.x + 3, p.y + 3);
          ctx.moveTo(p.x + 3, p.y - 3);
          ctx.lineTo(p.x - 3, p.y + 3);
          ctx.stroke();
        }
        break;
      }
      case 'label': {
        const p = apply(m, item.at);
        drawLabel(ctx, {x: p.x + (item.offset?.x ?? 0), y: p.y + (item.offset?.y ?? 0)}, item.text, {background: item.background ?? OVERLAY_COLORS.guide, color: item.color, anchor: 'center'});
        break;
      }
    }
    ctx.restore();
  }
}

/** Draws everything the engine itself shows over the scene. The caller clears the canvas and sets
 *  the device-pixel transform first. */
export function drawOverlay(ctx: CanvasRenderingContext2D, scene: OverlayScene) {
  const {doc, viewport} = scene;
  const toScreen = screenMatrix(viewport);
  if (scene.pixelGrid && viewport.zoom >= PIXEL_GRID_ZOOM) drawPixelGrid(ctx, viewport, scene.size, scene.dpr);

  if (scene.context && doc.nodes[scene.context] && doc.nodes[scene.context].type !== 'PAGE') {
    const node = doc.nodes[scene.context];
    traceBox(ctx, multiply(toScreen, worldMatrix(doc, node.id)), node.width, node.height);
    ctx.strokeStyle = colorFor(doc, node.id);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const {selected, ids, accent, outlines, box} = selectionMarks(doc, scene.selection, scene.hidden);
  if (scene.hoverId && !selected.has(scene.hoverId) && doc.nodes[scene.hoverId] && !scene.hidden?.has(scene.hoverId)) {
    strokeNodeOutline(ctx, doc, scene.hoverId, viewport, colorFor(doc, scene.hoverId), 1.5);
  }

  if (!ids.length) {
    drawItems(ctx, scene.items, viewport);
    return;
  }
  for (const outline of outlines) {
    traceBox(ctx, multiply(toScreen, outline.matrix), outline.width, outline.height);
    ctx.strokeStyle = outline.color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (box) {
    const m = multiply(toScreen, box.matrix);
    const line = isLineBox(doc, box);
    if (!line) {
      traceBox(ctx, m, box.width, box.height);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      const a = apply(m, {x: 0, y: 0}), b = apply(m, {x: box.width, y: 0});
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const axis = applyLinear(m, {x: 1, y: 0});
    const angle = Math.atan2(axis.y, axis.x);
    if (scene.handles) {
      if (line) {
        drawHandle(ctx, apply(m, {x: 0, y: 0}), angle, accent, true);
        drawHandle(ctx, apply(m, {x: box.width, y: 0}), angle, accent, true);
      } else {
        // Corners only, as in Figma: the sides are grabbed anywhere along their length (transform.ts).
        for (const anchor of handleAnchors(box.width, box.height, false)) drawHandle(ctx, apply(m, anchor.local), angle, accent);
        // The radius handles inside the corners of a rectangle or a frame.
        for (const handle of radiusHandles(doc, box, viewport)) drawRadiusHandle(ctx, handle.at, accent);
        // A text on a path: its path, and the handle that moves where the text starts along it.
        const textPath = textPathHandle(doc, box, viewport);
        if (textPath) {
          ctx.beginPath();
          textPath.path.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          if (textPath.closed) ctx.closePath();
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.stroke();
          drawHandle(ctx, textPath.at, 0, accent, true);
        }
      }
    }
    if (scene.sizeBadge) {
      const corners = [{x: 0, y: 0}, {x: box.width, y: 0}, {x: box.width, y: box.height}, {x: 0, y: box.height}].map(p => apply(m, p));
      const bottom = Math.max(...corners.map(p => p.y));
      const centre = (Math.min(...corners.map(p => p.x)) + Math.max(...corners.map(p => p.x))) / 2;
      const node = box.nodeId ? doc.nodes[box.nodeId] : null;
      const text = node?.type === 'LINE' ? formatNumber(node.width) : sizeLabel(box.width, box.height);
      drawLabel(ctx, {x: centre, y: bottom + 8}, text, {background: accent});
    }
  }
  drawItems(ctx, scene.items, viewport);
}
