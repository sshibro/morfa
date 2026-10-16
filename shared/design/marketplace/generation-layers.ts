// Catalog Generation's layers (docs/marketplaces.md §Catalog Generation): what a brand kit, a variant batch and a WB cover set
// put on a card, as ordinary editable layers with their roles. Pure builders over the document: the editor runs them inside one
// transaction (src/design/marketplace/generate/apply.ts), so each action is one undo step, and the tests run them on hand-made cards.
//
// The product layer is the seller's own cut-out: these builders move, scale, turn or mirror it, never repaint it, and the colour check
// (productColorMatch) says when something on the card would change its colours.

import {cloneSubtrees} from '../clone';
import {createNode, defaultAutoLayout, defaultTextProps, defaultTextStyle, newId, solid} from '../defaults';
import {rotationMatrix, toRadians, worldBox} from '../geometry';
import {hexToRgb} from '../board/palette';
import {applyFillsToRange, applyStyleToRange, insertText} from '../text-edit';
import type {BlendMode, DesignDocument, ImageAsset, ImagePaint, ImageRef, NodeId, Paint, RGB, SceneNode} from '../types';
import type {BrandKit} from './brand-kit';
import type {BadgeShape, VariantBackground, VariantComposition} from './generation';
import {overlapArea, type Box} from './lint';
import {cardMeta, descendants, layerRole, withCardMeta, withLayerRole, type CardMeta, type LayerRole} from './meta';
import {marketplaceSpec, type Marketplace} from './specs';

export type Picture = {ref: ImageRef; asset: ImageAsset};
/** On a cut-out: the layer whose photo it was cut from, so cutting that photo again replaces it instead of stacking a second product. */
export const CUT_SOURCE_KEY = 'morfa.mp.cutFrom';
/** The weights a font family has (the editor's font registry); a family it does not know gets [400, 700]. */
export type WeightsOf = (family: string) => readonly number[];

const roundBox = (box: Box): Box => ({x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height))});
/** The family's weight nearest to `wanted`; a tie goes the way CSS goes (heavier for bold, lighter for regular). */
const nearest = (weights: readonly number[], wanted: number) =>
  weights.length
    ? weights.reduce((best, w) => {
        const [d, e] = [Math.abs(w - wanted), Math.abs(best - wanted)];
        return d < e || (d === e && (wanted >= 500 ? w > best : w < best)) ? w : best;
      })
    : wanted;
const imagePaint = (ref: ImageRef, scaleMode: ImagePaint['scaleMode'] = 'FILL'): ImagePaint => ({type: 'IMAGE', imageRef: ref, scaleMode, opacity: 1, visible: true, blendMode: 'NORMAL'});
const hexPaint = (hex: string, opacity = 1): Paint => solid(hexToRgb(hex), opacity);

// ── Reading a card ──────────────────────────────────────────────────────────────────────────────

/** A layer's box in the card frame's own space (axis-aligned, before the card's own turn: cards stand upright on the page). */
export function boxInCard(doc: DesignDocument, cardId: NodeId, id: NodeId): Box {
  const card = worldBox(doc, cardId),
    box = worldBox(doc, id);
  return {x: box.x - card.x, y: box.y - card.y, width: box.width, height: box.height};
}

/** The card's layers with each role, in layer order (bottom first). */
export function roleLayers(doc: DesignDocument, cardId: NodeId): Map<LayerRole, SceneNode[]> {
  const out = new Map<LayerRole, SceneNode[]>();
  for (const node of descendants(doc, cardId)) {
    const role = layerRole(node);
    if (!role) continue;
    const list = out.get(role) ?? [];
    list.push(node);
    out.set(role, list);
  }
  return out;
}

/** The card's product layers, the shown one first (then the others in layer order, top first). */
export function productLayers(doc: DesignDocument, cardId: NodeId): SceneNode[] {
  const all = (roleLayers(doc, cardId).get('product') ?? []).slice().reverse();
  return [...all.filter(node => node.visible), ...all.filter(node => !node.visible)];
}

/** Picture layers of the card a cut-out can start from: a visible image fill, the largest first. */
export function pictureLayers(doc: DesignDocument, cardId: NodeId): {id: NodeId; name: string; ref: ImageRef; role: LayerRole | null}[] {
  return descendants(doc, cardId)
    .filter(node => node.type !== 'TEXT' && node.fills.some(paint => paint.type === 'IMAGE' && paint.visible && paint.imageRef && doc.images[paint.imageRef]))
    .map(node => ({node, ref: [...node.fills].reverse().find(paint => paint.type === 'IMAGE' && paint.visible && paint.imageRef)! as Extract<Paint, {type: 'IMAGE'}>}))
    .sort((a, b) => b.node.width * b.node.height - a.node.width * a.node.height)
    .map(({node, ref}) => ({id: node.id, name: node.name, ref: ref.imageRef, role: layerRole(node)}));
}

// ── The colour check ────────────────────────────────────────────────────────────────────────────

const PLAIN: ReadonlySet<BlendMode> = new Set(['NORMAL', 'PASS_THROUGH']);
const blends = (node: SceneNode) => !PLAIN.has(node.blendMode) || node.fills.some(paint => paint.visible && !PLAIN.has(paint.blendMode));
/** A layer that tints what is under it: a translucent fill or layer (not a text: letters over a corner change nothing). */
const tints = (node: SceneNode) =>
  node.type !== 'TEXT' && node.fills.some(paint => paint.visible && (paint.opacity < 1 || node.opacity < 1 || paint.type !== 'SOLID' && paint.type !== 'IMAGE'));

export type ColorMatch = {ok: boolean; issues: string[]};

/**
 * "Product colour as in the photo": the product layer is painted as the seller shot it. A warning names what changes its colours: filters on
 * its picture, a layer or picture opacity under 1 (its own or a group's around it), a blend mode other than "Normal", or a layer above
 * it on the card that blends into it (a blend mode or a background blur over a fifth of it) or tints most of it.
 */
export function productColorMatch(doc: DesignDocument, cardId: NodeId, productId: NodeId): ColorMatch {
  const issues: string[] = [];
  const product = doc.nodes[productId];
  if (!product) return {ok: false, issues: ['The product layer was not found.']};
  const picture = [...product.fills].reverse().find(paint => paint.type === 'IMAGE' && paint.visible);
  if (picture?.type === 'IMAGE' && Object.values(picture.filters ?? {}).some(value => typeof value === 'number' && Math.abs(value) > 1e-3))
    issues.push('Filters are applied to the product photo: the colours differ from the shot.');
  if (picture && picture.opacity < 1) issues.push('The product photo is semi-transparent.');
  if (picture && !PLAIN.has(picture.blendMode)) issues.push('The product photo is not in the Normal blend mode.');
  if (product.opacity < 1) issues.push('The product layer is semi-transparent.');
  if (!PLAIN.has(product.blendMode)) issues.push('The product layer is not in the Normal blend mode.');
  // Groups around it change it the same way.
  for (let id = product.parentId; id && id !== cardId; id = doc.nodes[id]?.parentId ?? null) {
    const parent = doc.nodes[id];
    if (!parent) break;
    if (parent.opacity < 1) issues.push(`The group "${parent.name}" with the product is semi-transparent.`);
    if (!PLAIN.has(parent.blendMode)) issues.push(`The group "${parent.name}" with the product is not in the Normal blend mode.`);
  }
  // Layers above it: every later sibling of the product and of each group around it, with what they hold.
  const box = boxInCard(doc, cardId, productId);
  const area = Math.max(1, box.width * box.height);
  const above: SceneNode[] = [];
  for (let id: NodeId | null = productId; id && id !== cardId; id = doc.nodes[id]?.parentId ?? null) {
    const parent = doc.nodes[doc.nodes[id]?.parentId ?? ''];
    if (!parent?.children) break;
    for (const sibling of parent.children.slice(parent.children.indexOf(id) + 1)) {
      const node = doc.nodes[sibling];
      if (node) above.push(node, ...descendants(doc, sibling));
    }
  }
  for (const node of above) {
    if (!node.visible) continue;
    const covered = overlapArea(box, boxInCard(doc, cardId, node.id)) / area;
    if (covered <= 0) continue;
    if ((blends(node) || node.effects.some(effect => effect.visible && effect.type === 'BACKGROUND_BLUR')) && covered >= 0.2)
      issues.push(`The layer "${node.name}" above the product blends with it and changes its colour.`);
    else if (tints(node) && covered >= 0.5) issues.push(`The semi-transparent layer "${node.name}" above the product tints it.`);
  }
  return {ok: !issues.length, issues};
}

// ── Where the product stands ────────────────────────────────────────────────────────────────────

/** The marketplace's badge zones in the frame's pixels. */
export const zoneBoxes = (marketplace: Marketplace, frame: {width: number; height: number}): Box[] =>
  marketplaceSpec(marketplace).safeZones.map(zone => ({x: zone.x * frame.width, y: zone.y * frame.height, width: zone.width * frame.width, height: zone.height * frame.height}));

/**
 * Where the product may stand: the frame inside a margin, below the marketplace's top badges and the card's texts at the top, above its
 * bottom badges and the texts at the bottom. Falls back to the frame inside the margin when that leaves too little.
 */
export function productRegion(marketplace: Marketplace, frame: {width: number; height: number}, keepOut: readonly Box[] = []): Box {
  const {width: W, height: H} = frame;
  const margin = Math.round(Math.min(W, H) * 0.06);
  let top = margin,
    bottom = H - margin;
  for (const box of [...zoneBoxes(marketplace, frame), ...keepOut]) {
    const middle = box.y + box.height / 2;
    if (middle < H * 0.45) top = Math.max(top, box.y + box.height + H * 0.02);
    else if (middle > H * 0.55) bottom = Math.min(bottom, box.y - H * 0.02);
  }
  if (bottom - top < H * 0.35) return {x: margin, y: margin, width: W - 2 * margin, height: H - 2 * margin};
  return roundBox({x: margin, y: top, width: W - 2 * margin, height: bottom - top});
}

/** x and y of a box of `width` × `height` turned by `rotation` degrees so that its centre stays at `centre` (localMatrix's order). */
export function placeTurned(centre: {x: number; y: number}, width: number, height: number, rotation: number): {x: number; y: number} {
  const m = rotationMatrix(-toRadians(rotation));
  const half = {x: m[0][0] * (width / 2) + m[0][1] * (height / 2), y: m[1][0] * (width / 2) + m[1][1] * (height / 2)};
  return {x: Math.round(centre.x - half.x), y: Math.round(centre.y - half.y)};
}

// ── Background layers ────────────────────────────────────────────────────────────────────────────────

/** The fills of a variant's own background. */
export function backgroundFills(background: VariantBackground): Paint[] {
  switch (background.kind) {
    case 'solid':
      return [hexPaint(background.color)];
    case 'linear':
    case 'radial': {
      const stop = (hex: string, position: number) => ({position, color: {...hexToRgb(hex), a: 1}});
      return [{
        type: background.kind === 'linear' ? 'GRADIENT_LINEAR' : 'GRADIENT_RADIAL', opacity: 1, visible: true, blendMode: 'NORMAL',
        gradientStops: [stop(background.from, 0), stop(background.to, 1)],
        gradientHandlePositions: background.kind === 'linear' ? [{x: 0.5, y: 0}, {x: 0.5, y: 1}, {x: 0, y: 0}] : [{x: 0.5, y: 0.45}, {x: 0.5, y: 1.1}, {x: 1.15, y: 0.45}],
      }];
    }
  }
}

export const backgroundLayer = (cardId: NodeId, frame: {width: number; height: number}, fills: Paint[], id = newId()): SceneNode =>
  createNode('RECTANGLE', {
    id, parentId: cardId, name: 'Background', x: 0, y: 0, width: frame.width, height: frame.height, fills,
    constraints: {horizontal: 'STRETCH', vertical: 'STRETCH'}, pluginData: withLayerRole(undefined, 'background'),
  });

/** The box of a soft shadow under the product: a flat ellipse near its foot. */
export function shadowBox(product: Box): Box {
  const width = product.width * 0.82,
    height = Math.max(10, product.height * 0.07);
  return roundBox({x: product.x + (product.width - width) / 2, y: product.y + product.height - height * 0.55, width, height});
}

// ── Brand kit ───────────────────────────────────────────────────────────────────────────────────

const luminance = ({r, g, b}: RGB) => [r, g, b].map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** The colour of text on `fill`: the kit's background or text colour that reads best on it (WCAG AA, 4.5:1), else white or black. */
export function readableOn(fill: string, colors: BrandKit['colors']): string {
  const base = hexToRgb(fill);
  const best = (list: string[]) => list.reduce((found, hex) => (contrast(hexToRgb(hex), base) > contrast(hexToRgb(found), base) + 0.01 ? hex : found));
  const own = best([colors.background, colors.text]);
  return contrast(hexToRgb(own), base) >= 4.5 ? own : best(['#ffffff', '#000000']);
}

/** A text layer in a family and colour: the style and fills of every character, each weight kept as near as the family has. */
function restyleText(node: SceneNode, family: string, color: string | null, weightsOf: WeightsOf): Partial<SceneNode> | null {
  if (node.type !== 'TEXT' || !node.text) return null;
  const length = node.text.characters.length;
  const weights = weightsOf(family);
  let text = {...node.text, style: {...node.text.style, fontFamily: family, fontWeight: nearest(weights, node.text.style.fontWeight)}};
  text = applyStyleToRange(text, 0, length, {fontFamily: family});
  text = {...text, runs: text.runs.map(run => (run.style.fontWeight === undefined ? run : {...run, style: {...run.style, fontWeight: nearest(weights, run.style.fontWeight)}}))};
  const change: Partial<SceneNode> = {text, textStyleId: undefined};
  if (color) {
    const paints = [hexPaint(color)];
    const applied = applyFillsToRange(text, node.fills, 0, length, paints);
    change.text = applied.text;
    change.fills = applied.fills;
    change.fillStyleId = undefined;
  }
  return change;
}

const textsIn = (doc: DesignDocument, node: SceneNode): SceneNode[] => (node.type === 'TEXT' ? [node] : descendants(doc, node.id).filter(each => each.type === 'TEXT'));
const solidFills = (node: SceneNode) => node.fills.length > 0 && node.fills.every(paint => paint.type !== 'IMAGE');

/**
 * What applying a brand kit changes on a card, by role: headlines take the heading font and the text colour, benefits the body font and
 * the text colour, badges the accent with readable text in the body font, a plain background the kit's background, the logo and the
 * store's logo layers the kit's pictures (`pictures`: the kit's url → the picture the file may use). Layers the kit has nothing for keep
 * what they have. One change per layer, for the editor to apply in one undo step.
 */
export function brandKitChanges(doc: DesignDocument, cardId: NodeId, kit: BrandKit, weightsOf: WeightsOf, pictures: ReadonlyMap<string, Picture> = new Map()): {id: NodeId; change: Partial<SceneNode>}[] {
  const out = new Map<NodeId, Partial<SceneNode>>();
  const add = (id: NodeId, change: Partial<SceneNode> | null) => change && out.set(id, {...out.get(id), ...change});
  const {colors, fonts} = kit;
  const picture = (asset: ImageAsset | null) => (asset ? pictures.get(asset.url) ?? null : null);
  for (const [role, nodes] of roleLayers(doc, cardId)) {
    for (const node of nodes) {
      if (role === 'headline') for (const text of textsIn(doc, node)) add(text.id, restyleText(text, fonts.heading, colors.text, weightsOf));
      else if (role === 'benefit') for (const text of textsIn(doc, node)) add(text.id, restyleText(text, fonts.body, colors.text, weightsOf));
      else if (role === 'badge') {
        if (node.type === 'TEXT') add(node.id, restyleText(node, fonts.body, colors.accent, weightsOf));
        else {
          if (solidFills(node) || !node.fills.length) add(node.id, {fills: [hexPaint(colors.accent)], fillStyleId: undefined});
          for (const text of textsIn(doc, node)) add(text.id, restyleText(text, fonts.body, readableOn(colors.accent, colors), weightsOf));
        }
      } else if (role === 'background' && node.type !== 'TEXT' && solidFills(node)) add(node.id, {fills: [hexPaint(colors.background)], fillStyleId: undefined});
      else if (role === 'logo' || role === 'watermark' || role === 'store-logo') {
        const next = picture(role === 'store-logo' ? kit.storeLogo : kit.logo);
        if (!next || node.type === 'TEXT') continue;
        const at = node.fills.map(paint => paint.type).lastIndexOf('IMAGE');
        add(node.id, {fills: at >= 0 ? node.fills.map((paint, i): Paint => (i === at && paint.type === 'IMAGE' ? {...paint, imageRef: next.ref, scaleMode: 'FIT'} : paint)) : [...node.fills, imagePaint(next.ref, 'FIT')]});
      }
    }
  }
  return [...out].map(([id, change]) => ({id, change}));
}

// ── New badge layers ────────────────────────────────────────────────────────────────────────────

/** A badge: an auto-layout frame in the kit's accent holding its text in the body font, its corners by `shape`. Returns the frame
 *  and its text, parents first. */
export function badgeLayers(parentId: NodeId, at: {x: number; y: number}, frame: {width: number}, badge: {shape: BadgeShape; text: string}, kit: Pick<BrandKit, 'fonts' | 'colors'>, weightsOf: WeightsOf, makeId: () => NodeId = newId): SceneNode[] {
  const scale = frame.width / 900;
  const fontSize = Math.round(28 * scale);
  const padX = Math.round((badge.shape === 'round' ? 22 : 20) * scale),
    padY = Math.round((badge.shape === 'round' ? 22 : 10) * scale);
  const height = Math.round(fontSize * 1.2 + 2 * padY);
  const width = Math.round(badge.text.length * fontSize * 0.6 + 2 * padX);
  const frameId = makeId();
  const box = createNode('FRAME', {
    id: frameId, parentId, name: 'Badge', x: Math.round(at.x), y: Math.round(at.y), width, height, fills: [hexPaint(kit.colors.accent)],
    ...badgeCorners(badge.shape, height),
    autoLayout: {...defaultAutoLayout('HORIZONTAL'), primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER',
      paddingLeft: padX, paddingRight: padX, paddingTop: padY, paddingBottom: padY},
    layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', pluginData: withLayerRole(undefined, 'badge'),
  });
  const text = createNode('TEXT', {
    id: makeId(), parentId: frameId, name: badge.text, fills: [hexPaint(readableOn(kit.colors.accent, kit.colors))],
    text: {...defaultTextProps(badge.text), style: {...defaultTextStyle(), fontFamily: kit.fonts.body, fontWeight: nearest(weightsOf(kit.fonts.body), 600), fontSize}},
    width: Math.round(badge.text.length * fontSize * 0.6), height: Math.round(fontSize * 1.2),
  });
  return [box, text];
}

/** The corners of a badge's shape: a pill, a rectangle, a tag (square on the left) or a round seal. */
export function badgeCorners(shape: BadgeShape, height: number): Partial<SceneNode> {
  const r = Math.round(height * 0.22);
  switch (shape) {
    case 'pill':
    case 'round':
      return {cornerRadius: Math.round(height / 2), rectangleCornerRadii: null};
    case 'rect':
      return {cornerRadius: r, rectangleCornerRadii: null};
    case 'tag':
      return {cornerRadius: 0, rectangleCornerRadii: [0, Math.round(height / 2), Math.round(height / 2), 0]};
  }
}

// ── Copies of a card: variants and cover sets ───────────────────────────────────────────────────

export type CardCopy = {
  meta: CardMeta;
  name: string;
  /** null keeps the master's background. */
  background: VariantBackground | null;
  /** null keeps the master's badge. */
  badge: {shape: BadgeShape; text: string} | null;
  /** null keeps the product where the master has it. */
  composition: VariantComposition | null;
};

/**
 * Copies of the master card side by side, each an ordinary card frame of editable layers: its meta (`group` the master's set, `variant`
 * or `audience`), and, as asked, a new background, badge and product placement. The product layers are the master's (the
 * seller's own cut-outs), moved, scaled, turned or mirrored; with several, a copy shows the one its composition names and hides the
 * rest. Where the master has no badge layer the copy gets one in the kit's style. Nodes come parents first, in the order
 * to create them; each copy's root has the master's parent.
 */
export function buildCardCopies(input: {
  doc: DesignDocument;
  cardId: NodeId;
  copies: readonly CardCopy[];
  /** Where the first copy's top-left goes in the master's parent; the others follow to the right. */
  origin: {x: number; y: number};
  gap: number;
  kit: Pick<BrandKit, 'fonts' | 'colors'>;
  weightsOf: WeightsOf;
  makeId?: () => NodeId;
}): {nodes: SceneNode[]; frameIds: NodeId[]} {
  const {doc, cardId} = input;
  const makeId = input.makeId ?? newId;
  const master = doc.nodes[cardId];
  const masterMeta = cardMeta(master);
  if (!master || !masterMeta) return {nodes: [], frameIds: []};
  const frame = {width: master.width, height: master.height};
  const roles = roleLayers(doc, cardId);
  const products = productLayers(doc, cardId);
  const slot = products[0];
  const slotBox = slot && slot.parentId === cardId ? {x: slot.x, y: slot.y, width: slot.width, height: slot.height} : null;
  const background = (roles.get('background') ?? []).find(node => node.parentId === cardId && node.type !== 'TEXT');
  const headlines = (roles.get('headline') ?? []).flatMap(node => textsIn(doc, node));
  const badge = (roles.get('badge') ?? [])[0];
  const shadows = (roles.get('shadow') ?? []).filter(node => node.parentId === cardId);
  const nodes: SceneNode[] = [];
  const frameIds: NodeId[] = [];
  input.copies.forEach((copy, index) => {
    const cloned = cloneSubtrees(doc.nodes, [cardId], makeId);
    const fresh = new Map(cloned.nodes.map(node => [node.id, node]));
    const byOld = (id: NodeId) => fresh.get(cloned.ids.get(id) ?? '');
    const root = cloned.nodes[0];
    root.x = Math.round(input.origin.x + index * (frame.width + input.gap));
    root.y = Math.round(input.origin.y);
    root.name = copy.name;
    root.pluginData = withCardMeta(root.pluginData, copy.meta);
    const extra: SceneNode[] = [];
    // Background: the master's own layer takes the new fills; a card without one gets one at the bottom.
    if (copy.background) {
      const fills = backgroundFills(copy.background);
      const own = background && byOld(background.id);
      if (own) Object.assign(own, {fills, fillStyleId: undefined});
      else extra.push(backgroundLayer(root.id, frame, fills, makeId()));
    }
    // Product: the composition's layer shown in the master's place, the others hidden.
    let productBox: Box | null = null;
    if (copy.composition && slotBox && products.length) {
      const chosen = products[copy.composition.product % products.length];
      for (const product of products) {
        const clone = byOld(product.id);
        if (!clone) continue;
        clone.visible = product.id === chosen.id;
        if (product.id !== chosen.id || clone.parentId !== root.id) continue;
        const fit = Math.min(slotBox.width / Math.max(1, chosen.width), slotBox.height / Math.max(1, chosen.height));
        const base = chosen.id === slot.id ? 1 : fit;
        const width = chosen.width * base * copy.composition.scale,
          height = chosen.height * base * copy.composition.scale;
        const centre = {x: slotBox.x + slotBox.width / 2 + copy.composition.dx * frame.width, y: slotBox.y + slotBox.height / 2 + copy.composition.dy * frame.height};
        const rotation = (chosen.rotation || 0) + copy.composition.rotation;
        Object.assign(clone, {width: Math.round(width), height: Math.round(height), rotation, flipX: copy.composition.mirror ? !chosen.flipX : !!chosen.flipX, ...placeTurned(centre, width, height, rotation)});
        productBox = {x: centre.x - width / 2, y: centre.y - height / 2, width, height};
      }
      if (productBox) for (const shadow of shadows) {
        const clone = byOld(shadow.id);
        if (clone) Object.assign(clone, shadowBox(productBox));
      }
    }
    // Badge: the master's badge takes the words and the shape; a card without one gets one under the headline.
    if (copy.badge) {
      const own = badge && byOld(badge.id);
      if (own) {
        const texts = own.type === 'TEXT' ? [own] : cloned.nodes.filter(node => node.type === 'TEXT' && isInside(fresh, node, own.id));
        const first = texts[0];
        if (first?.text) first.text = insertText(first.text, 0, first.text.characters.length, copy.badge.text);
        if (own.type !== 'TEXT') Object.assign(own, badgeCorners(copy.badge.shape, own.height));
      } else {
        const headline = headlines[0] ? byOld(headlines[0].id) : undefined;
        const below = headline ? boxBelow(doc, cardId, headline, headlines[0]) : null;
        const at = below ?? {x: Math.round(frame.width * 0.07), y: Math.round(Math.max(...zoneBoxes(masterMeta.marketplace, frame).filter(box => box.y < frame.height / 2).map(box => box.y + box.height), 0) + frame.height * 0.02)};
        extra.push(...badgeLayers(root.id, at, frame, copy.badge, input.kit, input.weightsOf, makeId));
      }
    }
    // New layers: a background goes first (the bottom), the rest on top, after the copy's own layers.
    const bottom = extra.filter(node => layerRole(node) === 'background');
    const top = extra.filter(node => layerRole(node) !== 'background');
    nodes.push(root, ...bottom, ...cloned.nodes.slice(1), ...top);
    frameIds.push(root.id);
  });
  return {nodes, frameIds};
}

const isInside = (nodes: ReadonlyMap<NodeId, SceneNode>, node: SceneNode, ancestor: NodeId): boolean => {
  for (let parent = node.parentId, depth = 0; parent && depth < 64; depth++) {
    if (parent === ancestor) return true;
    parent = nodes.get(parent)?.parentId ?? null;
  }
  return false;
};
/** Just under a headline: from its box in the master (a cloned headline) or its own (a new one). */
function boxBelow(doc: DesignDocument, cardId: NodeId, headline: SceneNode, masterText: SceneNode | undefined): {x: number; y: number} {
  const box = masterText && doc.nodes[masterText.id] ? boxInCard(doc, cardId, masterText.id) : {x: headline.x, y: headline.y, width: headline.width, height: headline.height};
  return {x: Math.round(box.x), y: Math.round(box.y + box.height + 16)};
}

/** Where a row of `count` copies of a `width` × `height` card goes in its parent: right of the master, past anything standing there. */
export function rowOrigin(doc: DesignDocument, cardId: NodeId, count: number, gap: number): {x: number; y: number} {
  const card = doc.nodes[cardId];
  const parent = doc.nodes[card?.parentId ?? ''];
  if (!card || !parent) return {x: 0, y: 0};
  const total = count * card.width + (count - 1) * gap;
  const others = (parent.children ?? []).map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && node.id !== cardId && node.visible);
  let spot = {x: card.x + card.width + gap, y: card.y, width: total, height: card.height};
  for (let round = 0; round < 100; round++) {
    const hit = others.filter(node => overlapArea(spot, node) > 0);
    if (!hit.length) break;
    spot = {...spot, x: Math.max(...hit.map(node => node.x + node.width)) + gap};
  }
  return {x: Math.round(spot.x), y: Math.round(spot.y)};
}
