// Card Canvas: the edits behind "Card" (docs/marketplaces.md §Frames and the new card, §Layer roles). Each is one undo step
// through the store's transaction, so a card is made, refitted, moved to another marketplace or given layer roles the way any
// other property changes, and co-editing and autosave see an ordinary patch of `pluginData`.

import {apply, worldMatrix} from '../../../../shared/design/geometry';
import {isAutoLayout, resizeUpdates, scaleUpdates} from '../../../../shared/design/constraints';
import {newId} from '../../../../shared/design/defaults';
import {
  cardMeta, LAYER_ROLE_LABELS, layerRole, withCardMeta, withLayerRole, withLayerShownOn, type LayerRole,
} from '../../../../shared/design/marketplace/meta';
import {marketplaceSpec, type Marketplace} from '../../../../shared/design/marketplace/specs';
import type {NodeId, SceneNode} from '../../../../shared/design/types';
import type {DesignStore} from '../../engine/store';

/** `pluginData` with nothing left in it is dropped rather than kept as `{}`. */
const tidy = (data: Record<string, string>) => (Object.keys(data).length ? data : undefined);

/** Whether a frame of this size has the marketplace's proportions (Ozon also takes Ozon fresh's square), within 1 %. */
export function hasMarketplaceAspect(size: {width: number; height: number}, marketplace: Marketplace): boolean {
  if (!(size.width > 0) || !(size.height > 0)) return false;
  const spec = marketplaceSpec(marketplace);
  const actual = size.width / size.height;
  const near = (wanted: number) => Math.abs(actual - wanted) / wanted <= 0.01;
  return near(spec.aspect.width / spec.aspect.height) || spec.altFrames.some(frame => near(frame.width / frame.height));
}

/** "Make card": the frame becomes the marketplace's card, the first of a new set. */
export function makeCard(store: DesignStore, frameId: NodeId, marketplace: Marketplace): void {
  store.transact(`Card ${marketplaceSpec(marketplace).short}`, tx => {
    const node = tx.get(frameId);
    if (!node) return;
    tx.update(frameId, {pluginData: withCardMeta(node.pluginData, {v: 1, marketplace, group: newId()})});
    return {select: [frameId]};
  });
}

/** "Not a card": the frame is a plain frame again; its layers keep their roles (harmless outside a card). */
export function unmakeCard(store: DesignStore, frameId: NodeId): void {
  store.transact('Not a card', tx => {
    const node = tx.get(frameId);
    if (!node) return;
    tx.update(frameId, {pluginData: tidy(withCardMeta(node.pluginData, null))});
    return {select: [frameId]};
  });
}

/** The card moves to another marketplace; a name in the "WB · Main photo" pattern follows. */
export function setCardMarketplace(store: DesignStore, frameId: NodeId, marketplace: Marketplace): void {
  store.transact(`Card ${marketplaceSpec(marketplace).short}`, tx => {
    const node = tx.get(frameId);
    const meta = cardMeta(node);
    if (!node || !meta || meta.marketplace === marketplace) return;
    const partial: Partial<SceneNode> = {pluginData: withCardMeta(node.pluginData, {...meta, marketplace})};
    const prefix = `${marketplaceSpec(meta.marketplace).short} · `;
    if (node.name.startsWith(prefix)) partial.name = `${marketplaceSpec(marketplace).short} · ${node.name.slice(prefix.length)}`;
    tx.update(frameId, partial);
    return {select: [frameId]};
  });
}

/**
 * "Fit to 900 × 1200": the frame and everything in it scaled to fit inside the marketplace's frame, then the frame grown to
 * it with its layers' constraints, and what was pinned to the top-left moved to the middle of the new room. One undo step.
 */
export function fitCardFrame(store: DesignStore, frameId: NodeId, marketplace: Marketplace): void {
  const target = marketplaceSpec(marketplace).frame;
  store.transact(`Fit to ${target.width} × ${target.height}`, tx => {
    const node = tx.get(frameId);
    if (!node || !(node.width > 0) || !(node.height > 0)) return;
    const k = Math.min(target.width / node.width, target.height / node.height);
    if (Math.abs(k - 1) > 1e-9) {
      const origin = apply(worldMatrix(tx.doc, frameId), {x: 0, y: 0});
      for (const [id, partial] of scaleUpdates(tx.doc, [frameId], origin, k, k)) tx.update(id, partial);
    }
    const scaled = tx.get(frameId)!;
    const room = {x: target.width - scaled.width, y: target.height - scaled.height};
    for (const [id, partial] of resizeUpdates(tx.doc, frameId, {x: scaled.x, y: scaled.y, width: target.width, height: target.height})) tx.update(id, partial);
    if (!isAutoLayout(scaled)) {
      for (const childId of scaled.children ?? []) {
        const child = tx.get(childId);
        if (!child) continue;
        const dx = child.constraints.horizontal === 'MIN' ? Math.round(room.x / 2) : 0;
        const dy = child.constraints.vertical === 'MIN' ? Math.round(room.y / 2) : 0;
        if (dx || dy) tx.update(childId, {x: child.x + dx, y: child.y + dy});
      }
    }
    return {select: [frameId]};
  });
}

/** "Role on the card". "Product" also locks the layer (the seller's real product: nothing moves it by accident and AI never redraws
 *  it); leaving "Product" unlocks it again. */
export function setLayerRole(store: DesignStore, nodeId: NodeId, role: LayerRole | null): void {
  store.transact(role ? `Role: ${LAYER_ROLE_LABELS[role].toLowerCase()}` : 'No role', tx => {
    const node = tx.get(nodeId);
    if (!node || layerRole(node) === role) return;
    const partial: Partial<SceneNode> = {pluginData: tidy(withLayerRole(node.pluginData, role))};
    if (role === 'product') partial.locked = true;
    else if (layerRole(node) === 'product' && node.locked) partial.locked = false;
    tx.update(nodeId, partial);
    return {select: [nodeId]};
  });
}

/** "Show on": the marketplaces whose pictures show the layer (all of them: the key is dropped). */
export function setLayerShownOn(store: DesignStore, nodeId: NodeId, shown: readonly Marketplace[]): void {
  store.transact('Show on marketplaces', tx => {
    const node = tx.get(nodeId);
    if (!node) return;
    tx.update(nodeId, {pluginData: tidy(withLayerShownOn(node.pluginData, shown))});
    return {select: [nodeId]};
  });
}
