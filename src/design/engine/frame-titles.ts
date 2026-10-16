import type {DesignDocument, Matrix, NodeId, RGB, SceneNode, Vec} from '../../../shared/design/types';
import {apply, multiply, worldMatrix} from '../../../shared/design/geometry';
import type {Viewport} from './contracts';
import {screenMatrix} from './overlay';
import {labelledNodes} from './render/overlays';

// The titles the canvas writes above top-level frames, components and sets, and the name chips inside
// sections (render/overlays.ts draws them). As in Figma they are handles of their layer: a click on a
// title selects it (and a drag moves it), hovering one outlines it, a double click renames it in place.
// Geometry here mirrors the drawing: the title sits on the frame's top edge (turned with it), its text
// 6 px above the edge in 11 px Inter; a section's chip is 6 px inside its top-left corner, 20 px tall.

/** Screen px above the top edge a title takes clicks in. */
const TITLE_REACH = 20;
/** Titles narrower than this on screen are not drawn (render/overlays.ts), so they take no clicks. */
const MIN_SPAN = 16;
const ICON_WIDTH = 11;
const CHIP = {inset: 6, padding: 6, height: 20};
/** A title's baseline stands this far above the frame's top edge (render/overlays.ts). */
const TITLE_BASELINE = 6;
/** The rename field of a title: 18 px tall, so its ring clears the frame's edge; an 18 px line of 11 px Inter puts the
 *  baseline 13 px below its top (half-leading 2.3 + ascent 10.7). A section's field is its chip's size. */
export const TITLE_FIELD = {height: 18, baseline: 13, padding: 4};
export const TITLE_FONT = '450 11px "Inter Variable", Inter, system-ui, sans-serif';

let measurer: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/** Width of a title's text in CSS px (an estimate where there is no canvas, as in node tests). */
export function titleTextWidth(text: string): number {
  let width = widths.get(text);
  if (width !== undefined) return width;
  if (measurer === undefined) {
    measurer = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (measurer) measurer.font = TITLE_FONT;
  }
  width = measurer ? measurer.measureText(text).width : text.length * 6.2;
  if (widths.size > 2000) widths.clear();
  widths.set(text, width);
  return width;
}

// A title's world matrix, asked of the geometry engine once per node object and its ancestors' objects (documents are
// immutable: the same objects make the same matrix). Hovering re-hits the titles on every pointer move and wheel event,
// and asking the engine for every title each time was most of a pan's input handling (lane K, f100k: ~70 %).
// With it, the page-space ends of the title's edge, for the hover's quick look (`frameTitleAt`).
type TitleWorld = {chain: SceneNode[]; matrix: Matrix; start: Vec; end: Vec};
const titleWorlds = new WeakMap<SceneNode, TitleWorld>();

function titleWorld(doc: DesignDocument, node: SceneNode): TitleWorld {
  const kept = titleWorlds.get(node);
  if (kept) {
    // The same ancestors, compared as the chain is walked (no array a hover).
    let k = 0, same = true;
    for (let p = node.parentId ? doc.nodes[node.parentId] : undefined; p; p = p.parentId ? doc.nodes[p.parentId] : undefined) {
      if (kept.chain[k++] !== p) {
        same = false;
        break;
      }
    }
    if (same && k === kept.chain.length) return kept;
  }
  const chain: SceneNode[] = [];
  for (let p = node.parentId ? doc.nodes[node.parentId] : undefined; p; p = p.parentId ? doc.nodes[p.parentId] : undefined) chain.push(p);
  const matrix = worldMatrix(doc, node.id);
  const made = {chain, matrix, start: apply(matrix, {x: 0, y: 0}), end: apply(matrix, {x: node.width, y: 0})};
  titleWorlds.set(node, made);
  return made;
}

/** Screen px a title's box reaches from its frame's top edge, either way (a title above it, a chip inside it). */
const BOX_REACH = Math.max(TITLE_REACH, CHIP.inset + CHIP.height) + 2;

export type TitleBox = {
  id: NodeId;
  /** Screen px: where the title's text starts, the unit vector along the frame's top edge and the
   *  one pointing into the frame. */
  origin: Vec;
  along: Vec;
  down: Vec;
  /** Extent along the edge (from `origin`) and across it (negative: above the edge). */
  width: number;
  top: number;
  bottom: number;
  kind: 'title' | 'chip';
  /** Along the edge from `origin`, where the name's text begins (after a component's icon). */
  textX: number;
  /** Whose colours the name is drawn in: a component's purple, a frame's grey or accent, a section's chip. */
  tone: 'component' | 'frame' | 'section';
};

/** Where each visible title is on screen, top-most last. With `near` (a screen point), only the titles whose box could
 *  hold it: the others' edges are farther from it than a box reaches. */
export function titleBoxes(doc: DesignDocument, pageId: NodeId, viewport: Viewport, near?: Vec): TitleBox[] {
  const out: TitleBox[] = [];
  const toScreen = screenMatrix(viewport);
  const reach = BOX_REACH / viewport.zoom;
  const at = near && {x: near.x / viewport.zoom + viewport.x, y: near.y / viewport.zoom + viewport.y};
  for (const {id, kind} of labelledNodes(doc, pageId)) {
    const node = doc.nodes[id];
    if (!node || node.locked) continue;
    const world = titleWorld(doc, node);
    if (at) {
      const {start, end} = world;
      if (at.x < Math.min(start.x, end.x) - reach || at.x > Math.max(start.x, end.x) + reach || at.y < Math.min(start.y, end.y) - reach || at.y > Math.max(start.y, end.y) + reach) continue;
    }
    const m = multiply(toScreen, world.matrix);
    const p0 = apply(m, {x: 0, y: 0}), p1 = apply(m, {x: node.width, y: 0});
    const span = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (span < MIN_SPAN) continue;
    const along = {x: (p1.x - p0.x) / span, y: (p1.y - p0.y) / span};
    const down = {x: -along.y, y: along.x};
    const text = titleTextWidth(node.name);
    if (kind === 'section') {
      const available = span - 2 * CHIP.inset - 2 * CHIP.padding;
      if (available < MIN_SPAN) continue;
      const origin = {x: p0.x + along.x * CHIP.inset, y: p0.y + along.y * CHIP.inset};
      out.push({id, origin, along, down, width: Math.min(available, text) + 2 * CHIP.padding, top: CHIP.inset, bottom: CHIP.inset + CHIP.height, kind: 'chip', textX: CHIP.padding, tone: 'section'});
      continue;
    }
    const icon = kind === 'component' || kind === 'set' ? ICON_WIDTH : 0;
    out.push({id, origin: p0, along, down, width: Math.min(span, icon + text + 4), top: -TITLE_REACH, bottom: -1, kind: 'title', textX: icon, tone: icon ? 'component' : 'frame'});
  }
  return out;
}

/** The layer whose title (or section chip) is under a screen point, or null. */
export function frameTitleAt(doc: DesignDocument, pageId: NodeId, screen: Vec, viewport: Viewport): NodeId | null {
  const boxes = titleBoxes(doc, pageId, viewport, screen);
  for (let k = boxes.length - 1; k >= 0; k--) {
    const box = boxes[k];
    const dx = screen.x - box.origin.x, dy = screen.y - box.origin.y;
    const u = dx * box.along.x + dy * box.along.y, v = dx * box.down.x + dy * box.down.y;
    if (u >= 0 && u <= box.width && v >= box.top && v <= box.bottom) return box.id;
  }
  return null;
}

/** Where the rename field of a title goes, in the title's own frame (along and across its edge from `origin`): its
 *  left edge, its top and its side padding, so the field's text lands exactly on the name it replaces (same x, same
 *  baseline). A section's field takes the chip's place. */
export function titleFieldPlacement(box: Pick<TitleBox, 'kind' | 'top' | 'textX'>): {x: number; y: number; padding: number; height: number} {
  if (box.kind === 'chip') return {x: 0, y: box.top, padding: CHIP.padding, height: CHIP.height};
  return {x: box.textX - TITLE_FIELD.padding, y: -TITLE_BASELINE - TITLE_FIELD.baseline, padding: TITLE_FIELD.padding, height: TITLE_FIELD.height};
}

/** A ground darker than this luminance takes the dark field and white text (the split section chips draw with). */
export const isDarkGround = (color: RGB) => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b < 0.45;

/** What the rename field of `node` stands on: a section's chip sits on the section's own fill, a title on the canvas. It
 *  follows the canvas, not the editor's theme (a light page in the dark theme keeps a light field). */
export function titleGround(node: Pick<SceneNode, 'type' | 'fills'>, canvas: RGB): 'light' | 'dark' {
  if (node.type === 'SECTION') {
    const fill = node.fills.find(paint => paint.visible !== false && paint.type === 'SOLID');
    if (fill && fill.type === 'SOLID') return isDarkGround(fill.color) ? 'dark' : 'light';
  }
  return isDarkGround(canvas) ? 'dark' : 'light';
}
