// What the canvas tools do to a document, each as one step through the store: colour styles, a picture as a new layer or in a layer's
// image fill, and where a new top-level layer goes on a page. Every layer, style and picture is checked with the server's schema
// before it enters the store (as a paste is): one the server would refuse is left out (`refused`), so a tool can never stop the file
// from saving. No DOM.
import {createNode, newId} from '../../../shared/design/defaults';
import {patchIssues} from '../../../shared/design/schema';
import type {DesignDocument, ImageAsset, ImageRef, NodeId, Paint, SceneNode, Style, StyleId, Vec} from '../../../shared/design/types';
import type {DesignStore} from '../engine/store';
import {userUpdate} from '../engine/user-edit';
import {hexPaint} from './build';

/** Whether the server stores this layer, style or picture as it is (shared/design/schema.ts; the tree's links are the
 *  transaction's). */
export const storableNode = (node: SceneNode) => !patchIssues({nodes: {[node.id]: node}}).length;
const storableStyle = (style: Style) => !patchIssues({styles: {[style.id]: style}}).length;
const storablePicture = (picture: {ref: ImageRef; asset: ImageAsset}) => !patchIssues({images: {[picture.ref]: picture.asset}}).length;

/** A picture or layer the server would refuse: nothing is changed. */
export class PictureRefused extends Error {
  constructor() {
    super('The picture cannot be stored in the file.');
  }
}

/** Adds colour styles "<group>/<name>" (one step, named `label`); returns their ids and how many the server would not store. */
export function applyPalette(store: DesignStore, swatches: readonly {name: string; color: string}[], group: string, label: string): {ids: StyleId[]; refused: number} {
  const ids: StyleId[] = [];
  let refused = 0;
  const prefix = group.trim().replace(/\/+$/, '');
  store.transact(label, tx => {
    for (const swatch of swatches) {
      const id = newId();
      const style: Style = {id, type: 'FILL', name: prefix ? `${prefix}/${swatch.name}` : swatch.name, description: '', paints: [hexPaint(swatch.color)]};
      if (!storableStyle(style)) {
        refused++;
        continue;
      }
      tx.setStyle(style);
      ids.push(id);
    }
  });
  return {ids, refused};
}

const GAP = 80;
const overlaps = (a: {x: number; y: number; width: number; height: number}, b: {x: number; y: number; width: number; height: number}) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Where a new screen goes on the page: at `box` if nothing top-level is there, otherwise to the right of what it would cover, as a
 *  new frame lands beside the others rather than on top of them. Only the page's own layers are read (no scan of the tree). */
export function freeSpot(doc: DesignDocument, pageId: NodeId, box: {x: number; y: number; width: number; height: number}): {x: number; y: number} {
  const others = (doc.nodes[pageId]?.children ?? []).map(id => doc.nodes[id]).filter(node => !!node && node.visible !== false && !node.rotation);
  let spot = {...box};
  for (let round = 0; round < 50; round++) {
    const hit = others.filter(node => overlaps(spot, node));
    if (!hit.length) break;
    spot = {...spot, x: Math.max(...hit.map(node => node.x + node.width)) + GAP};
  }
  return {x: Math.round(spot.x), y: Math.round(spot.y)};
}

// ── Pictures ────────────────────────────────────────────────────────────────────────────────────

const imageFill = (ref: ImageRef): Paint => ({type: 'IMAGE', imageRef: ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'});

/** A picture's size on the canvas: its own, no larger than `max`, in its proportions. */
function fitPicture(width: number, height: number, max: {width: number; height: number}): {width: number; height: number} {
  const scale = Math.min(1, max.width / width, max.height / height);
  return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

/** A picture as a new layer on the current page, centred on `at`, selected (one step with the picture's record). */
export function insertPicture(store: DesignStore, picture: {ref: ImageRef; asset: ImageAsset}, at: Vec, max: {width: number; height: number}, name: string): NodeId {
  const id = newId();
  const size = fitPicture(picture.asset.width || 1024, picture.asset.height || 1024, max);
  const pageId = store.getState().pageId;
  const layer = {
    ...createNode('RECTANGLE', {id, name: name.slice(0, 100) || 'Image', fills: [imageFill(picture.ref)]}),
    x: Math.round(at.x - size.width / 2),
    y: Math.round(at.y - size.height / 2),
    width: size.width,
    height: size.height,
    parentId: pageId,
  };
  if (!storablePicture(picture) || !storableNode(layer)) throw new PictureRefused();
  store.transact('Image', tx => {
    tx.setImage(picture.ref, picture.asset);
    tx.create(layer, pageId);
    return {select: [id]};
  });
  return id;
}

/**
 * Puts a picture into a layer's fills (one step): the image fill that is on top takes the new picture with its own scale mode and
 * filters; a layer without one gets an image fill on top. False when the layer is gone.
 */
export function fillWithPicture(store: DesignStore, id: NodeId, picture: {ref: ImageRef; asset: ImageAsset}): boolean {
  const node = store.getState().doc.nodes[id];
  if (!node || node.type === 'PAGE') return false;
  let at = -1;
  for (let i = node.fills.length - 1; i >= 0; i--) {
    if (node.fills[i]!.type === 'IMAGE') {
      at = i;
      break;
    }
  }
  const fills = at >= 0
    ? node.fills.map((paint, i) => (i === at && paint.type === 'IMAGE' ? {...paint, imageRef: picture.ref, visible: true} : paint))
    : [...node.fills, imageFill(picture.ref)];
  const change: Partial<SceneNode> = {fills};
  if (!storablePicture(picture) || !storableNode({...node, ...change})) throw new PictureRefused();
  store.transact('Image', tx => {
    tx.setImage(picture.ref, picture.asset);
    userUpdate(tx, id, change);
    return {select: [id]};
  });
  return true;
}
