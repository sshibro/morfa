// Catalog Generation in the document (docs/marketplaces.md §Catalog Generation): each action of "Generation" as one undo step through the
// store. A cut-out goes over the photo it came from as the card's product; a brand kit restyles the card by role; variants and WB covers are copies of the card in a row to its right. The layers are
// built by shared/design/marketplace/generation-layers.ts; this file reads the editor's state, checks that the server would store the
// result (as a paste is checked) and commits it. The selection stays as it was, so "Generation" stays open on the card (its "Show"
// selects what was made). No DOM: the tests run it on a store of their own.

import {createNode, newId} from '../../../../shared/design/defaults';
import {apply as applyMatrix, boundsOfPoints, localMatrix} from '../../../../shared/design/geometry';
import {
  boxInCard,
  brandKitChanges,
  buildCardCopies,
  CUT_SOURCE_KEY,
  placeTurned,
  productRegion,
  roleLayers,
  rowOrigin,
  type CardCopy,
  type Picture,
  type WeightsOf,
} from '../../../../shared/design/marketplace/generation-layers';
import type {BrandKit} from '../../../../shared/design/marketplace/brand-kit';
import type {CutOutAnswer} from '../../../../shared/design/marketplace/generation';
import type {Box} from '../../../../shared/design/marketplace/lint';
import {cardMeta, cardOf, descendants, layerRole, withCardMeta, withLayerRole, type LayerRole} from '../../../../shared/design/marketplace/meta';
import {patchIssues} from '../../../../shared/design/schema';
import type {DesignDocument, ImagePaint, NodeId, SceneNode} from '../../../../shared/design/types';
import type {FontRegistry} from '../../engine/contracts';
import {imagePlacement} from '../../engine/render/image-math';
import type {DesignStore} from '../../engine/store';
import {userUpdate} from '../../engine/user-edit';

/** The gap between a card and its copies, in the page's pixels. */
export const COPY_GAP = 80;

/** A layer, picture or change the server would refuse: nothing is changed, and the panel says so. */
export class GenerationRefused extends Error {
  constructor() {
    super('The result cannot be saved in the file, so it was not added.');
  }
}

/** Whether the server stores these layers and pictures as they are (shared/design/schema.ts). */
export const storable = (nodes: readonly SceneNode[], pictures: readonly Picture[] = []) =>
  !patchIssues({nodes: Object.fromEntries(nodes.map(node => [node.id, node])), images: Object.fromEntries(pictures.map(picture => [picture.ref, picture.asset]))}).length;

/** The weights each family has in the editor's font list (a family it does not list gets regular and bold). */
export const fontWeights =
  (fonts: Pick<FontRegistry, 'families'>): WeightsOf =>
  family =>
    fonts.families().find(font => font.family === family)?.weights ?? [400, 700];

const topPicture = (node: SceneNode): ImagePaint | undefined =>
  [...node.fills].reverse().find((paint): paint is ImagePaint => paint.type === 'IMAGE' && paint.visible && !!paint.imageRef);

// ── Cut-outs ────────────────────────────────────────────────────────────────────────────────────

/**
 * The cut-out as a layer where its pixels stood in the source layer: the part of the picture the cut-out kept (`cut.box`) mapped through
 * the source's image placement (fill, fit or crop, a quarter turn) and the source's own turn and mirror. A locked "Product" with the
 * product role; the picture keeps the source's turn and filters, so the product looks exactly as it did. Null when the source is gone
 * or shows no picture.
 */
export function cutOutLayer(doc: DesignDocument, sourceId: NodeId, cut: Pick<CutOutAnswer, 'ref' | 'box' | 'source'>, id: NodeId = newId()): SceneNode | null {
  const source = doc.nodes[sourceId];
  const paint = source && source.type !== 'TEXT' ? topPicture(source) : undefined;
  if (!source?.parentId || !paint) return null;
  const asset = doc.images[paint.imageRef];
  const iw = asset?.width || cut.source.width,
    ih = asset?.height || cut.source.height;
  const {matrix} = imagePlacement(paint, source.width, source.height, iw, ih);
  const [x0, y0, x1, y1] = [cut.box.x * iw, cut.box.y * ih, (cut.box.x + cut.box.width) * iw, (cut.box.y + cut.box.height) * ih];
  const local = boundsOfPoints([{x: x0, y: y0}, {x: x1, y: y0}, {x: x1, y: y1}, {x: x0, y: y1}].map(point => applyMatrix(matrix, point)));
  const centre = applyMatrix(localMatrix(source), {x: local.x + local.width / 2, y: local.y + local.height / 2});
  const width = Math.max(1, Math.round(local.width)),
    height = Math.max(1, Math.round(local.height));
  const parent = doc.nodes[source.parentId];
  const picture: ImagePaint = {
    type: 'IMAGE', imageRef: cut.ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL',
    ...(paint.scaleMode !== 'CROP' && paint.rotation ? {rotation: paint.rotation} : {}),
    ...(paint.filters ? {filters: paint.filters} : {}),
  };
  return createNode('RECTANGLE', {
    id, parentId: source.parentId, name: 'Product', width, height, ...placeTurned(centre, width, height, source.rotation || 0),
    rotation: source.rotation || 0, flipX: !!source.flipX, flipY: !!source.flipY, fills: [picture], locked: true,
    constraints: source.constraints, ...(parent?.autoLayout ? {layoutPositioning: 'ABSOLUTE' as const} : {}),
    pluginData: {...withLayerRole(undefined, 'product'), [CUT_SOURCE_KEY]: layerRole(source) === 'product' ? source.pluginData?.[CUT_SOURCE_KEY] ?? sourceId : sourceId},
  });
}

/** Puts a cut-out over its source as the card's product (one undo step): just above it, the source hidden. Cutting again replaces what
 *  was cut before from the same photo (a product layer cut again is replaced too), so a card never stacks two copies of one product.
 *  Returns the new layer, or null when the source is gone. */
export function placeCutOut(store: DesignStore, sourceId: NodeId, cut: CutOutAnswer, label = 'Remove background'): NodeId | null {
  const doc = store.getState().doc;
  const layer = cutOutLayer(doc, sourceId, cut);
  const source = doc.nodes[sourceId];
  if (!layer || !source?.parentId) return null;
  if (!storable([layer], [{ref: cut.ref, asset: cut.asset}])) throw new GenerationRefused();
  const origin = layer.pluginData?.[CUT_SOURCE_KEY];
  const card = cardOf(doc, sourceId);
  const earlier = (card ? descendants(doc, card.id) : [])
    .filter(node => node.id === sourceId ? layerRole(node) === 'product' : layerRole(node) === 'product' && node.pluginData?.[CUT_SOURCE_KEY] === origin)
    .map(node => node.id);
  store.transact(label, tx => {
    tx.setImage(cut.ref, cut.asset);
    const parent = tx.get(source.parentId!)!;
    tx.create(layer, parent.id, (parent.children ?? []).indexOf(sourceId) + 1);
    for (const id of earlier) tx.remove(id);
    if (!earlier.includes(sourceId)) userUpdate(tx, sourceId, {visible: false});
  });
  return layer.id;
}

/** A product photo the seller uploads: a picture layer in the card where a product stands (one undo step), to cut out next. */
export function insertProductPhoto(store: DesignStore, cardId: NodeId, picture: Picture): NodeId | null {
  const doc = store.getState().doc;
  const card = doc.nodes[cardId];
  const meta = cardMeta(card);
  if (!card || !meta) return null;
  const region = productRegion(meta.marketplace, card, keepOuts(doc, cardId));
  const scale = Math.min(region.width / Math.max(1, picture.asset.width), region.height / Math.max(1, picture.asset.height));
  const width = Math.max(1, Math.round(picture.asset.width * scale)),
    height = Math.max(1, Math.round(picture.asset.height * scale));
  const layer = createNode('RECTANGLE', {
    id: newId(), parentId: cardId, name: picture.asset.name?.slice(0, 100) || 'Product photo', width, height,
    x: Math.round(region.x + (region.width - width) / 2), y: Math.round(region.y + region.height - height),
    fills: [{type: 'IMAGE', imageRef: picture.ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}],
    ...(card.autoLayout ? {layoutPositioning: 'ABSOLUTE' as const} : {}),
  });
  if (!storable([layer], [picture])) throw new GenerationRefused();
  store.transact('Product photo', tx => {
    tx.setImage(picture.ref, picture.asset);
    tx.create(layer, cardId);
  });
  return layer.id;
}

// ── Keep-outs ───────────────────────────────────────────────────────────────────────────────────

const KEEP_OUT: ReadonlySet<LayerRole> = new Set(['headline', 'badge', 'benefit', 'logo', 'store-logo']);
/** The card's texts, badges and logos (direct parts of the card) a product photo stays clear of. */
function keepOuts(doc: DesignDocument, cardId: NodeId): Box[] {
  const out: Box[] = [];
  for (const [role, nodes] of roleLayers(doc, cardId)) if (KEEP_OUT.has(role)) for (const node of nodes) if (node.visible) out.push(boxInCard(doc, cardId, node.id));
  return out;
}

// ── Brand kit ───────────────────────────────────────────────────────────────────────────────────

/** The card's layers that show a kit picture: its logos and watermark. */
export function kitPictureRoles(doc: DesignDocument, cardId: NodeId): {logo: boolean; storeLogo: boolean} {
  const roles = roleLayers(doc, cardId);
  return {logo: !!(roles.get('logo')?.length || roles.get('watermark')?.length), storeLogo: !!roles.get('store-logo')?.length};
}

/** A brand kit on the card (one undo step): fonts, colours and logos by role (generation-layers.ts brandKitChanges). `pictures` maps the
 *  kit's picture urls to the pictures this file holds (the server's KitPicturesAnswer). Returns how many layers changed. */
export function applyBrandKit(store: DesignStore, cardId: NodeId, kit: BrandKit, weightsOf: WeightsOf, pictures: ReadonlyMap<string, Picture> = new Map()): number {
  const doc = store.getState().doc;
  const changes = brandKitChanges(doc, cardId, kit, weightsOf, pictures);
  if (!changes.length) return 0;
  const used = [...pictures.values()];
  const changed = changes.map(({id, change}) => ({...doc.nodes[id], ...change}) as SceneNode);
  if (!storable(changed, used)) throw new GenerationRefused();
  store.transact('Apply brand kit', tx => {
    for (const picture of used) tx.setImage(picture.ref, picture.asset);
    for (const {id, change} of changes) userUpdate(tx, id, change);
  });
  return changes.length;
}

/** A kit picture (an icon, a logo) placed on the card (one undo step): its own size up to a fifth of the card, top-left inside the margin,
 *  with `role` when it is a logo. */
export function insertKitPicture(store: DesignStore, cardId: NodeId, picture: Picture, role: LayerRole | null, name: string): NodeId | null {
  const card = store.getState().doc.nodes[cardId];
  if (!card) return null;
  const side = Math.round(Math.min(card.width, card.height) / 5);
  const scale = Math.min(1, side / Math.max(1, picture.asset.width), side / Math.max(1, picture.asset.height));
  const margin = Math.round(Math.min(card.width, card.height) * 0.06);
  const layer = createNode('RECTANGLE', {
    id: newId(), parentId: cardId, name: name.slice(0, 100) || 'Icon', x: margin, y: margin,
    width: Math.max(1, Math.round(picture.asset.width * scale)), height: Math.max(1, Math.round(picture.asset.height * scale)),
    fills: [{type: 'IMAGE', imageRef: picture.ref, scaleMode: 'FIT', opacity: 1, visible: true, blendMode: 'NORMAL'}],
    ...(card.autoLayout ? {layoutPositioning: 'ABSOLUTE' as const} : {}), ...(role ? {pluginData: withLayerRole(undefined, role)} : {}),
  });
  if (!storable([layer], [picture])) throw new GenerationRefused();
  store.transact('Picture from the brand kit', tx => {
    tx.setImage(picture.ref, picture.asset);
    tx.create(layer, cardId);
  });
  return layer.id;
}

// ── Copies: variants and WB covers ──────────────────────────────────────────────────────────────

/**
 * Copies of the card in a row to its right (one undo step), each an ordinary card frame of editable layers (buildCardCopies). The master
 * joins the copies' set: a master without a group takes its own id as one, as slide kits do. Returns the new frames,
 * left to right.
 */
export function insertCopies(store: DesignStore, cardId: NodeId, copies: readonly CardCopy[], kit: Pick<BrandKit, 'fonts' | 'colors'>, weightsOf: WeightsOf, label: string): NodeId[] {
  const doc = store.getState().doc;
  const master = doc.nodes[cardId];
  const meta = cardMeta(master);
  if (!master?.parentId || !meta || !copies.length) return [];
  const built = buildCardCopies({doc, cardId, copies, origin: rowOrigin(doc, cardId, copies.length, COPY_GAP), gap: COPY_GAP, kit, weightsOf});
  if (!storable(built.nodes)) throw new GenerationRefused();
  const group = copies[0].meta.group;
  store.transact(label, tx => {
    if (group && meta.group !== group) tx.update(cardId, {pluginData: withCardMeta(master.pluginData, {...meta, group})});
    for (const node of built.nodes) tx.create(node, node.parentId ?? master.parentId!);
  });
  return built.frameIds;
}
