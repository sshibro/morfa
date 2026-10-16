import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {apply} from '../../../../shared/design/geometry';
import type {FontRegistry} from '../contracts';
import {cssColor} from './blend';
import type {Ctx2D} from './canvas';
import {worldOfNode} from './painter';

// A title's corners in page space (its node's origin, top-right and bottom-left), kept per node object with the parent
// matrix they were made under: a pan redraws every title every frame, and only the screen offset changes.
const corners = new WeakMap<SceneNode, {parent: Matrix | null; p0: Vec; p1: Vec; p3: Vec}>();

function cornersOf(doc: DesignDocument, node: SceneNode): {p0: Vec; p1: Vec; p3: Vec} {
  const parentNode = node.parentId ? doc.nodes[node.parentId] : undefined;
  // A top-level title's matrix is its node's alone; a nested one's depends on its parent's (cached by identity too).
  const parent = parentNode && parentNode.type !== 'PAGE' ? worldOfNode(doc, parentNode) : null;
  const kept = corners.get(node);
  if (kept && kept.parent === parent) return kept;
  const world = worldOfNode(doc, node);
  const made = {parent, p0: apply(world, {x: 0, y: 0}), p1: apply(world, {x: node.width, y: 0}), p3: apply(world, {x: 0, y: node.height})};
  corners.set(node, made);
  return made;
}

// What the canvas draws over the design in screen pixels (so it stays crisp at any zoom) and never
// exports: frame titles, section name chips and the dashed outline of component sets. The pixel grid
// belongs to the overlay (src/design/engine/overlay.ts), which knows the "Pixel grid" toggle.

const GREY = '#7A7A7A';
const ACCENT = '#0D99FF';
const COMPONENT = '#9747FF';
const LABEL_SIZE = 11;
const LABELLED = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);

type Labelled = {id: NodeId; kind: 'frame' | 'component' | 'section' | 'set'};
const lists = new WeakMap<DesignDocument, Map<NodeId, Labelled[]>>();

/** Nodes with a title: top-level frames, components, instances, sets and sections, variants inside a
 *  top-level set, and sections inside sections. Cached per document and page. */
export function labelledNodes(doc: DesignDocument, pageId: NodeId): Labelled[] {
  let byPage = lists.get(doc);
  if (!byPage) lists.set(doc, (byPage = new Map()));
  const cached = byPage.get(pageId);
  if (cached) return cached;
  const out: Labelled[] = [];
  const kindOf = (node: SceneNode): Labelled['kind'] =>
    node.type === 'SECTION' ? 'section' : node.type === 'COMPONENT_SET' ? 'set' : node.type === 'COMPONENT' || node.type === 'INSTANCE' ? 'component' : 'frame';
  const visit = (ids: readonly NodeId[] | undefined) => {
    for (const id of ids ?? []) {
      const node = doc.nodes[id];
      // A board's objects (docs/board.md: stickies, shapes and tables are frames) have no title.
      if (!node || node.visible === false || !LABELLED.has(node.type) || node.board) continue;
      out.push({id, kind: kindOf(node)});
      if (node.type === 'SECTION') visit(node.children);
      else if (node.type === 'COMPONENT_SET') {
        for (const variantId of node.children ?? []) {
          const variant = doc.nodes[variantId];
          if (variant?.type === 'COMPONENT' && variant.visible !== false) out.push({id: variantId, kind: 'component'});
        }
      }
    }
  };
  visit(doc.nodes[pageId]?.children);
  byPage.set(pageId, out);
  return out;
}

// A title's fitted text and width depend only on the font, the text and the room: a pan redraws every title every
// frame with the same three, so they are measured once (measureText was the titles' largest cost). Any font that
// finishes loading starts the cache again (its measures may change).
const FITTED_MAX = 4096;
const fitted = new Map<string, {text: string; width: number}>();
let fontEpoch = 0;
let watchingFonts = false;

function watchFonts(): void {
  if (watchingFonts) return;
  watchingFonts = true;
  const set = typeof document !== 'undefined' ? document.fonts : undefined;
  set?.addEventListener?.('loadingdone', () => {
    fontEpoch++;
    fitted.clear();
  });
}

/** `fit` and the width of its result, measured once per font, text and room. */
function fitMeasured(ctx: Ctx2D, text: string, max: number, revision: number): {text: string; width: number} {
  watchFonts();
  const key = `${fontEpoch}|${revision}|${ctx.font}|${max}|${text}`;
  let entry = fitted.get(key);
  if (!entry) {
    if (fitted.size >= FITTED_MAX) fitted.clear();
    const out = fit(ctx, text, max);
    fitted.set(key, (entry = {text: out, width: out ? ctx.measureText(out).width : 0}));
  }
  return entry;
}

/** Ellipsizes `text` to `max` px with the context's current font. */
function fit(ctx: Ctx2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? text.slice(0, lo) + '…' : '';
}

function diamond(ctx: Ctx2D, x: number, y: number, r: number, filled: boolean): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  if (filled) ctx.fill();
  else ctx.stroke();
}

export type LabelOptions = {
  doc: DesignDocument;
  pageId: NodeId;
  /** Page → device px (the same transform the scene was drawn with). */
  scale: number;
  offsetX: number;
  offsetY: number;
  dpr: number;
  selected: ReadonlySet<NodeId>;
  /** The title being renamed on the canvas: its field covers it, so its name is not drawn (a component keeps its icon). */
  editing?: NodeId | null;
  fonts: FontRegistry;
  width: number;
  height: number;
};

/** Frame titles above top-level frames, section chips inside sections, dashed component-set outlines. */
export function drawLabels(ctx: Ctx2D, o: LabelOptions): void {
  const font = {family: 'Inter', weight: 450, italic: false, size: LABEL_SIZE * o.dpr};
  if (!o.fonts.isLoaded(font)) void o.fonts.ensure(font);
  const revision = (o.fonts.measurer as {revision?: number}).revision ?? 0;
  ctx.save();
  ctx.font = o.fonts.cssFont(font);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const toScreen = (p: {x: number; y: number}) => ({x: p.x * o.scale + o.offsetX, y: p.y * o.scale + o.offsetY});
  for (const {id, kind} of labelledNodes(o.doc, o.pageId)) {
    const node = o.doc.nodes[id];
    if (!node) continue;
    const page = cornersOf(o.doc, node);
    const p0 = toScreen(page.p0), p1 = toScreen(page.p1), p3 = toScreen(page.p3);
    const span = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const minX = Math.min(p0.x, p1.x, p3.x), maxX = Math.max(p0.x, p1.x, p3.x) + Math.abs(p1.x - p0.x);
    const minY = Math.min(p0.y, p1.y, p3.y) - 24 * o.dpr, maxY = Math.max(p0.y, p1.y, p3.y);
    if (maxX < 0 || maxY < 0 || minX > o.width || minY > o.height + Math.abs(p3.y - p0.y)) continue;
    const selected = o.selected.has(id);
    const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    ctx.setTransform(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), p0.x, p0.y);
    if (kind === 'set') {
      // Component sets carry a dashed purple outline wherever they are.
      ctx.save();
      ctx.strokeStyle = COMPONENT;
      ctx.lineWidth = o.dpr;
      ctx.setLineDash([4 * o.dpr, 3 * o.dpr]);
      ctx.strokeRect(0, 0, span, Math.hypot(p3.x - p0.x, p3.y - p0.y));
      ctx.restore();
    }
    if (kind === 'section') {
      if (id !== o.editing) drawSectionChip(ctx, node, span, selected, o.dpr, o.doc.board === true, revision);
      continue;
    }
    if (span < 16 * o.dpr) continue;
    const colour = kind === 'component' || kind === 'set' ? COMPONENT : selected ? ACCENT : GREY;
    ctx.fillStyle = ctx.strokeStyle = colour;
    let x = 0;
    if (kind === 'component' || kind === 'set') {
      const r = 3.5 * o.dpr, cy = -4 * o.dpr - r;
      if (node.type === 'INSTANCE') {
        ctx.lineWidth = 1.2 * o.dpr;
        diamond(ctx, r, cy, r - 0.6 * o.dpr, false);
      } else {
        const q = r / 2;
        diamond(ctx, r, cy - q, q * 0.9, true);
        diamond(ctx, r + q, cy, q * 0.9, true);
        diamond(ctx, r, cy + q, q * 0.9, true);
        diamond(ctx, r - q, cy, q * 0.9, true);
      }
      x = 2 * r + 4 * o.dpr;
    }
    if (id === o.editing) continue;
    const {text} = fitMeasured(ctx, node.name, span - x, revision);
    if (text) ctx.fillText(text, x, -6 * o.dpr);
  }
  ctx.restore();
}

/** A board section's chip (docs/board.md, FigJam's): its own colour made deep enough for white text; grey for a grey section. */
export function boardChipColor(fill: {r: number; g: number; b: number}): string {
  const max = Math.max(fill.r, fill.g, fill.b), min = Math.min(fill.r, fill.g, fill.b), d = max - min;
  if (d < 0.04) return '#6E6E6E';
  const h = max === fill.r ? ((fill.g - fill.b) / d + 6) % 6 : max === fill.g ? (fill.b - fill.r) / d + 2 : (fill.r - fill.g) / d + 4;
  return `hsl(${Math.round(h * 60)} 62% 42%)`;
}

/** The name chip of a section: inside its top-left corner, grey, or accent when selected; on a board, in the section's colour. */
function drawSectionChip(ctx: Ctx2D, node: SceneNode, span: number, selected: boolean, dpr: number, board: boolean, revision: number): void {
  const padding = 6 * dpr, height = 20 * dpr, inset = 6 * dpr;
  const available = span - 2 * inset - 2 * padding;
  if (available < 16 * dpr) return;
  const measured = fitMeasured(ctx, node.name, available, revision);
  const text = measured.text;
  if (!text) return;
  const width = measured.width + 2 * padding;
  const fill = node.fills.find(p => p.visible !== false && p.type === 'SOLID');
  const dark = fill && fill.type === 'SOLID' && 0.2126 * fill.color.r + 0.7152 * fill.color.g + 0.0722 * fill.color.b < 0.45;
  const chip = board && fill?.type === 'SOLID' && !dark ? boardChipColor(fill.color) : null;
  ctx.fillStyle = selected ? ACCENT : chip ?? (dark ? 'rgba(255, 255, 255, 0.16)' : cssColor({r: 0, g: 0, b: 0}, 0.07));
  ctx.beginPath();
  if ('roundRect' in ctx) ctx.roundRect(inset, inset, width, height, 5 * dpr);
  else (ctx as CanvasRenderingContext2D).rect(inset, inset, width, height);
  ctx.fill();
  ctx.fillStyle = selected || chip ? '#FFFFFF' : dark ? '#FFFFFF' : '#1E1E1E';
  ctx.fillText(text, inset + padding, inset + height / 2 + 4 * dpr);
}

