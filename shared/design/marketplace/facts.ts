// What Spec Lint reads off a card (shared/design/marketplace/lint.ts `CardFacts`): its frame, texts and layers with their roles and
// boxes in the frame's own space, its export settings and how many pictures its set has. Rendering results (`measured`) and proofing
// are added by the editor (src/design/marketplace/canvas/measure.ts). Owned by the Card Canvas module.
//
// Only what the marketplace's picture shows counts: hidden layers, layers hidden for this marketplace ("Show on") and
// everything outside the frame (an export is cut to the frame) are left out.

import {invert, multiply, transformRect, worldMatrices} from '../geometry';
import {paintChildren, isFrameLikeNode} from '../tree';
import type {DesignDocument, Matrix, NodeId, Paint, RGB, SceneNode} from '../types';
import type {Box, CardFacts} from './lint';
import {cardExportOf, cardsOnPage, isShownOn, layerRole, type CardMeta, type LayerRole} from './meta';
import type {Marketplace} from './specs';

/** A layer of a card as its picture shows it: back to front, with its box in the frame's space (cut to the frame) and the
 *  opacity it is painted with (its own times its ancestors' inside the card). */
export type CardLayer = {node: SceneNode; box: Box; opacity: number; scale: number; depth: number};

const clipBox = (box: Box, frame: Box): Box | null => {
  const x = Math.max(box.x, frame.x), y = Math.max(box.y, frame.y);
  const right = Math.min(box.x + box.width, frame.x + frame.width), bottom = Math.min(box.y + box.height, frame.y + frame.height);
  return right > x && bottom > y ? {x, y, width: right - x, height: bottom - y} : null;
};

/** How much a matrix scales lengths (the square root of its area factor). */
const lengthScale = (m: Matrix) => Math.sqrt(Math.abs(m[0][0] * m[1][1] - m[0][1] * m[1][0])) || 1;

/** The card's layers its picture on `marketplace` shows, back to front (the renderer's order), each cut to the frame and to the
 *  frames above it that clip. Boolean operands and masks are listed too: callers that count paint tell them apart. */
export function cardLayers(doc: DesignDocument, frameId: NodeId, marketplace: Marketplace): CardLayer[] {
  const frame = doc.nodes[frameId];
  if (!frame) return [];
  const world = worldMatrices(doc);
  const toFrame = invert(world(frameId));
  const bounds: Box = {x: 0, y: 0, width: frame.width, height: frame.height};
  const out: CardLayer[] = [];
  const walk = (id: NodeId, opacity: number, depth: number, clip: Box) => {
    if (depth > 64) return;
    for (const childId of paintChildren(doc.nodes[id])) {
      const node = doc.nodes[childId];
      if (!node || !node.visible || !isShownOn(node, marketplace)) continue;
      const m = multiply(toFrame, world(childId));
      const box = clipBox(transformRect(m, {x: 0, y: 0, width: node.width, height: node.height}), clip);
      const own = opacity * node.opacity;
      const clips = isFrameLikeNode(node) && node.clipsContent !== false;
      if (box) out.push({node, box, opacity: own, scale: lengthScale(m), depth});
      // A layer cut away entirely may still have children that reach in (a frame that does not clip lets them out).
      if (box || !clips) walk(childId, own, depth + 1, clips && box ? box : clip);
    }
  };
  walk(frameId, 1, 0, bounds);
  return out;
}

/** The largest font size in a text layer (card px) and the heaviest weight it is set in at that size. */
export function largestType(node: SceneNode, scale = 1): {fontSize: number; fontWeight: number} {
  const text = node.text;
  if (!text) return {fontSize: 0, fontWeight: 400};
  let size = text.style.fontSize, weight = text.style.fontWeight ?? 400;
  for (const run of text.runs) {
    const runSize = run.style.fontSize ?? text.style.fontSize, runWeight = run.style.fontWeight ?? text.style.fontWeight ?? 400;
    if (runSize > size || (runSize === size && runWeight > weight)) {
      size = runSize;
      weight = runWeight;
    }
  }
  return {fontSize: Math.round(size * scale * 100) / 100, fontWeight: weight};
}

const hasImageFill = (node: SceneNode) => node.fills.some(paint => paint.visible !== false && paint.type === 'IMAGE');

/** The solid colour a list of fills paints (the top visible one, not bound to a variable) and its opacity; null for a gradient,
 *  a picture, a colour from a variable, or a half-transparent fill over others (then no one colour). */
function solidInk(fills: readonly Paint[]): {color: RGB; opacity: number} | null {
  const visible = fills.filter(paint => paint.visible !== false && paint.opacity > 0);
  const top = visible[visible.length - 1];
  if (!top || top.type !== 'SOLID' || top.boundVariables?.color) return null;
  if (visible.length > 1 && top.opacity < 1) return null;
  return {color: top.color, opacity: top.opacity};
}

/** The colours a text is set in (its fill and its runs' fills), with the opacity they are painted at (the least of the fills'
 *  times the layer's); null when any of them is not a solid colour (the editor then reads the colour off the picture). */
export function textInk(node: SceneNode, layerOpacity = node.opacity): {colors: RGB[]; opacity: number} | null {
  if (!node.text) return null;
  const base = solidInk(node.fills);
  const runs = node.text.runs.filter(run => run.fills).map(run => solidInk(run.fills!));
  // The base fill shows wherever no run paints its own: needed unless the runs cover every character.
  const covered = node.text.runs.filter(run => run.fills).reduce((sum, run) => sum + run.end - run.start, 0) >= node.text.characters.length;
  const inks = covered ? runs : [base, ...runs];
  if (!inks.length || inks.some(ink => !ink)) return null;
  const solid = inks as {color: RGB; opacity: number}[];
  return {colors: solid.map(ink => ink.color), opacity: Math.min(...solid.map(ink => ink.opacity)) * layerOpacity};
}

/**
 * How many pictures the card's listing has: the cards of its set (`group`) for the same marketplace and SKU, one per slide. Variants
 * and WB's personalized covers of one slide are alternatives, not more pictures; a card with no slide counts as its own. A card with
 * no set is one picture.
 */
export function cardImagesInSet(doc: DesignDocument, frameId: NodeId, meta: CardMeta): number {
  if (!meta.group) return 1;
  const slides = new Set<string>([meta.slide ?? frameId]);
  for (const pageId of doc.pages) {
    for (const card of cardsOnPage(doc, pageId)) {
      const other = card.meta;
      if (other.group !== meta.group || other.marketplace !== meta.marketplace || (other.sku ?? '') !== (meta.sku ?? '')) continue;
      slides.add(other.slide ?? card.id);
    }
  }
  return slides.size;
}

export function collectCardFacts(doc: DesignDocument, frameId: NodeId, meta: CardMeta, extra: Pick<CardFacts, 'measured' | 'proofing'> = {}): CardFacts | null {
  const frame = doc.nodes[frameId];
  if (!frame || !isFrameLikeNode(frame)) return null;
  const texts: CardFacts['texts'][number][] = [];
  const layers: CardFacts['layers'][number][] = [];
  for (const {node, box, scale} of cardLayers(doc, frameId, meta.marketplace)) {
    const role = layerRole(node);
    if (node.type === 'TEXT' && node.text) texts.push({id: node.id, name: node.name, characters: node.text.characters, ...largestType(node, scale), box});
    const image = hasImageFill(node);
    if (role || image) layers.push({id: node.id, name: node.name, role, box, ...(image ? {image} : {})});
  }
  const settings = cardExportOf(meta);
  return {
    marketplace: meta.marketplace,
    frame: {id: frameId, width: frame.width, height: frame.height},
    export: {format: settings.format, scale: settings.scale, quality: settings.quality},
    texts,
    layers,
    imagesInSet: cardImagesInSet(doc, frameId, meta),
    ...(extra.measured ? {measured: extra.measured} : {}),
    ...(extra.proofing ? {proofing: extra.proofing} : {}),
  };
}

/** Roles that light or shade the product rather than hide it. */
const SEE_THROUGH: ReadonlySet<LayerRole> = new Set(['shadow', 'light', 'background']);
/** Layers painted fainter than this hide nothing. */
const FAINT = 0.25;
/** Sample points across a product's box, a side. */
const GRID = 48;

/** Whether a layer paints over what is under it: a leaf with a visible fill or stroke (a text always), a frame with a fill. */
function paintsCover(node: SceneNode): boolean {
  if (node.isMask || node.type === 'GROUP' || node.type === 'SECTION' || node.type === 'SLICE') return false;
  if (node.type === 'TEXT') return true;
  const role = layerRole(node);
  if (role && SEE_THROUGH.has(role)) return false;
  const shows = (paints: SceneNode['fills']) => paints.some(paint => paint.visible !== false && paint.opacity >= FAINT);
  return shows(node.fills) || (!isFrameLikeNode(node) && node.strokeWeight > 0 && shows(node.strokes));
}

/**
 * Product layer → the share (0..1) of its box covered by layers painted above it on `marketplace`: packaging, badges, texts. Boxes,
 * not pixels: a round badge counts as its square and a text as its box, so the figure leans high; Spec Lint warns from 25 % and
 * fails from 50 %. Faint layers (under 25 % opacity), shadows, light and background layers, groups and masks cover nothing.
 */
export function productCoverage(doc: DesignDocument, frameId: NodeId, marketplace: Marketplace): Record<NodeId, number> {
  const layers = cardLayers(doc, frameId, marketplace);
  const out: Record<NodeId, number> = {};
  layers.forEach((product, index) => {
    if (layerRole(product.node) !== 'product') return;
    const box = product.box;
    const above: Box[] = [];
    // Layers after the product in paint order are above it, except its own descendants (deeper, right after it) and a boolean
    // operation's operands (shapes, not paint).
    for (let k = index + 1; k < layers.length; k++) {
      const layer = layers[k];
      if (insideOf(doc, layer.node, product.node.id) || operandOfBoolean(doc, layer.node)) continue;
      if (layer.opacity < FAINT || !paintsCover(layer.node)) continue;
      const overlap = clipBox(layer.box, box);
      if (overlap) above.push(overlap);
    }
    if (!above.length) {
      out[product.node.id] = 0;
      return;
    }
    let covered = 0;
    for (let row = 0; row < GRID; row++) {
      const y = box.y + ((row + 0.5) / GRID) * box.height;
      for (let column = 0; column < GRID; column++) {
        const x = box.x + ((column + 0.5) / GRID) * box.width;
        if (above.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)) covered++;
      }
    }
    out[product.node.id] = Math.round((covered / (GRID * GRID)) * 1000) / 1000;
  });
  return out;
}

function insideOf(doc: DesignDocument, node: SceneNode, ancestorId: NodeId): boolean {
  for (let parent = node.parentId, depth = 0; parent && depth < 64; parent = doc.nodes[parent]?.parentId ?? null, depth++) if (parent === ancestorId) return true;
  return false;
}

const operandOfBoolean = (doc: DesignDocument, node: SceneNode) => doc.nodes[node.parentId ?? '']?.type === 'BOOLEAN_OPERATION';
