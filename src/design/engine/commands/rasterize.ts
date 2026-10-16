import type {DesignDocument, ImageAsset, ImageRef, NodeId, SceneNode} from '../../../../shared/design/types';
import {createNode, newId} from '../../../../shared/design/defaults';
import {snapshotDocument} from '../../../../shared/design/table-cache';
import {booleanGeometry} from '../../../../shared/design/boolean';
import {invert, multiply, translation, worldMatrix, type Rect} from '../../../../shared/design/geometry';
import {placementChanges, placementFor, type Transaction} from '../../../../shared/design/transaction';
import {sortByPaintOrder} from '../../../../shared/design/tree';
import type {FontRegistry, ImageCache} from '../contracts';
import {exportBounds, exportRaster, ExportError} from '../export-raster';
import {editableStructure} from '../selection';
import type {DesignStore} from '../store';
import {notify, structureRefusal} from './components';
import {registerCommand, type Command, type CommandContext} from './registry';
import {removeNodes} from './structure';

// "Rasterize selection" (Object ▸), as in Figma: the selection painted by the export painter at
// 2×, stored as a picture of the file, and the layers replaced by one rectangle with that picture as
// its fill, on the same box. One undo step (the picture is registered in the same transaction). A
// picture is stored at most 4096 px on its longer side (server/design images), so a larger area is
// refused rather than blurred, and the scale drops below 2× as the area nears that size.

export const RASTER_MAX_SIDE = 4096;
export const RASTER_SCALE = 2;

/** What rasterizing needs from the open file: its fonts and pictures (to paint) and an upload. */
export type RasterizeHost = {
  fonts: FontRegistry;
  images: ImageCache;
  /** POST /api/design-files/:id/images; the picture is registered by the command's transaction. */
  upload(image: Blob, name: string): Promise<{ref: ImageRef; asset: ImageAsset}>;
};

const hosts = new WeakMap<DesignStore, RasterizeHost>();

export function connectRasterize(store: DesignStore, host: RasterizeHost): () => void {
  hosts.set(store, host);
  return () => {
    if (hosts.get(store) === host) hosts.delete(store);
  };
}

/** The layers a rasterization takes: the editable top of the selection, without slices. */
export function rasterTargets(doc: DesignDocument, selection: readonly NodeId[]): NodeId[] {
  return sortByPaintOrder(doc, editableStructure(doc, selection).filter(id => doc.nodes[id].type !== 'SLICE'));
}

/** The picture's scale for an area: 2×, less when that would pass the stored size; null when even
 *  1× would (the area is refused). */
export function rasterScale(bounds: Rect): number | null {
  const side = Math.max(bounds.width, bounds.height);
  if (!(side > 0) || side > RASTER_MAX_SIDE) return null;
  return Math.min(RASTER_SCALE, RASTER_MAX_SIDE / side);
}

/** Every node under the roots, by id, as they are now (to see whether they changed meanwhile). */
function snapshot(doc: DesignDocument, ids: readonly NodeId[]): Map<NodeId, SceneNode> {
  const out = new Map<NodeId, SceneNode>();
  const stack = [...ids];
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node || out.has(node.id)) continue;
    out.set(node.id, node);
    if (node.children) stack.push(...node.children);
  }
  return out;
}

const unchanged = (doc: DesignDocument, before: Map<NodeId, SceneNode>) => [...before].every(([id, node]) => doc.nodes[id] === node);

/** Inside an open transaction: registers the picture, puts a rectangle filled with it on `bounds`
 *  (page space) where the top-most layer was, and removes the layers. Returns the rectangle's id. */
export function replaceWithPicture(tx: Transaction, ids: readonly NodeId[], bounds: Rect, picture: {ref: ImageRef; asset: ImageAsset}, makeId: () => NodeId = newId): NodeId | null {
  const ordered = sortByPaintOrder(tx.doc, ids.filter(id => tx.get(id)));
  const top = ordered.at(-1);
  const parentId = top ? tx.get(top)!.parentId : null;
  if (!top || !parentId) return null;
  if (!tx.doc.images[picture.ref]) tx.setImage(picture.ref, picture.asset);
  const single = ordered.length === 1 ? tx.get(top)! : null;
  const rect = createNode('RECTANGLE', {
    id: makeId(),
    name: single?.name || 'Image',
    width: bounds.width,
    height: bounds.height,
    fills: [{type: 'IMAGE', imageRef: picture.ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}],
    ...(single ? {constraints: {...single.constraints}, layoutPositioning: single.layoutPositioning} : {}),
  });
  Object.assign(rect, placementChanges(rect, placementFor(rect, multiply(invert(worldMatrix(tx.doc, parentId)), translation(bounds.x, bounds.y)))));
  const index = (tx.get(parentId)!.children ?? []).indexOf(top) + 1;
  tx.create(rect, parentId, index);
  removeNodes(tx, ordered);
  return rect.id;
}

let busy = false;

/** Paints, uploads and replaces. Explains every refusal in a toast. */
export async function rasterizeSelection(ctx: CommandContext): Promise<NodeId | null> {
  const {store} = ctx;
  const host = hosts.get(store);
  if (!host || busy) return null;
  // The command's own document: it spans awaits (the picture, its upload), and the store's table may be written in place
  // meanwhile; `unchanged` below still compares the live table's node objects with the ones pictured.
  const {doc: live, selection} = store.getState();
  const doc = snapshotDocument(live);
  const refusal = structureRefusal(doc, selection, 'group');
  if (refusal) {
    notify(store, refusal);
    return null;
  }
  const ids = rasterTargets(doc, selection);
  if (!ids.length) return null;
  const bounds = exportBounds(doc, ids, host.fonts);
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) {
    notify(store, 'Nothing to rasterize: the selection has no visible content.');
    return null;
  }
  const scale = rasterScale(bounds);
  if (scale === null) {
    const size = (n: number) => Math.round(n).toLocaleString('en-US');
    notify(store, `The area is too large: ${size(bounds.width)} × ${size(bounds.height)} px. You can rasterize up to ${size(RASTER_MAX_SIDE)} px on the longer side.`);
    return null;
  }
  busy = true;
  try {
    const before = snapshot(doc, ids);
    const png = await exportRaster(doc, ids, {format: 'PNG', constraint: {type: 'SCALE', value: scale}}, {images: host.images, fonts: host.fonts, booleanGeometry});
    const picture = await host.upload(png, `${(ids.length === 1 && doc.nodes[ids[0]].name) || 'Image'}.png`);
    // The layers changed while the picture was made (an edit, an undo): the picture is stale.
    if (!unchanged(store.getState().doc, before)) {
      notify(store, 'The layers changed while the image was being prepared. Rasterize again.');
      return null;
    }
    let created: NodeId | null = null;
    store.transact('Rasterize', tx => {
      created = replaceWithPicture(tx, ids, bounds, picture);
      return created ? {select: [created]} : undefined;
    });
    return created;
  } catch (error) {
    notify(store, error instanceof ExportError || error instanceof Error ? error.message || 'Could not rasterize the selection.' : 'Could not rasterize the selection.');
    return null;
  } finally {
    busy = false;
  }
}

export const RASTERIZE_COMMANDS: Command[] = [
  {
    id: 'object.rasterize',
    label: 'Rasterize selection',
    group: 'object',
    enabled: ctx => hosts.has(ctx.store) && rasterTargets(ctx.store.getState().doc, ctx.store.getState().selection).length > 0,
    run: ctx => void rasterizeSelection(ctx),
  },
];

let registered = false;
/** Idempotent. */
export function registerRasterizeCommands() {
  if (registered) return;
  registered = true;
  for (const command of RASTERIZE_COMMANDS) registerCommand(command);
}
