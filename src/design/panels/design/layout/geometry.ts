import type {DesignDocument, Matrix, NodeId, SceneNode} from '../../../../../shared/design/types';
import {IDENTITY, apply, applyLinear, invert, localMatrix, multiply, normalizeDegrees, worldMatrices, worldMatrix} from '../../../../../shared/design/geometry';
import {boxOrigin, placementFor} from '../../../../../shared/design/transaction';
import {isAutoLayout, resizeUpdates, type NodeUpdates} from '../../../../../shared/design/constraints';

// Position and size as the "Position" section shows them. X and Y are read in the space of the
// container a designer thinks in: the parent, or for a layer inside groups (and boolean operations)
// the nearest frame or page above them, as Figma does — a group is a selection convenience, not a
// coordinate system. Size edits go through `resizeUpdates`, so children follow their constraints
// and a hugging or filling side becomes fixed.

/** Groups and boolean operations are transparent to the panel's coordinates. */
const TRANSPARENT = new Set<SceneNode['type']>(['GROUP', 'BOOLEAN_OPERATION']);

/** The container whose space X and Y are shown in. */
export function displaySpaceId(doc: DesignDocument, id: NodeId): NodeId | null {
  let parent = doc.nodes[doc.nodes[id]?.parentId ?? ''];
  while (parent && TRANSPARENT.has(parent.type) && parent.parentId) parent = doc.nodes[parent.parentId];
  return parent?.id ?? null;
}

/** Parent space → display space (identity unless the node sits in a group). */
export function parentToDisplay(doc: DesignDocument, id: NodeId): Matrix {
  const node = doc.nodes[id];
  const space = displaySpaceId(doc, id);
  if (!node?.parentId || !space || space === node.parentId) return IDENTITY;
  return multiply(invert(worldMatrix(doc, space)), worldMatrix(doc, node.parentId));
}

export type DisplayPlacement = {x: number; y: number; rotation: number};

/** X, Y and rotation of the node as the panel prints them. */
export function displayPlacement(doc: DesignDocument, node: SceneNode): DisplayPlacement {
  return placementIn(node, parentToDisplay(doc, node.id));
}

function placementIn(node: SceneNode, toDisplay: Matrix): DisplayPlacement {
  if (toDisplay === IDENTITY) return {x: clean(node.x), y: clean(node.y), rotation: normalizeDegrees(node.rotation || 0)};
  const placed = placementFor(node, multiply(toDisplay, localMatrix(node)));
  return {x: clean(placed.x), y: clean(placed.y), rotation: placed.rotation};
}

/** `displayPlacement` for many layers of one document (the panel over a 5 000-layer selection): the matrices of the
 *  parents and display spaces they share are worked out once. Each answer equals `displayPlacement`'s. */
export function displayPlacements(doc: DesignDocument): (node: SceneNode) => DisplayPlacement {
  const world = worldMatrices(doc);
  const byParent = new Map<NodeId, Matrix>();
  return node => {
    const parentId = node.parentId;
    if (!parentId) return placementIn(node, IDENTITY);
    let toDisplay = byParent.get(parentId);
    if (!toDisplay) {
      const space = displaySpaceId(doc, node.id);
      toDisplay = !space || space === parentId ? IDENTITY : multiply(invert(world(space)), world(parentId));
      byParent.set(parentId, toDisplay);
    }
    return placementIn(node, toDisplay);
  };
}

/** Rounds float noise (99.99999999 → 100) so fields agree across a selection. */
export function clean(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** The fields that put the node's displayed X (or Y) at `value`. */
export function positionUpdate(doc: DesignDocument, node: SceneNode, axis: 'x' | 'y', value: number): Partial<SceneNode> {
  const shown = displayPlacement(doc, node);
  const delta = value - shown[axis];
  if (!delta) return {};
  const local = applyLinear(invert(parentToDisplay(doc, node.id)), axis === 'x' ? {x: delta, y: 0} : {x: 0, y: delta});
  return {x: clean(node.x + local.x), y: clean(node.y + local.y)};
}

/** The fields that turn the node to the displayed rotation `degrees`, about its centre (as typing
 *  into Figma's rotation field does). */
export function rotationUpdate(doc: DesignDocument, node: SceneNode, degrees: number): Partial<SceneNode> {
  const shown = displayPlacement(doc, node).rotation;
  const toDisplay = parentToDisplay(doc, node.id);
  const mirrored = toDisplay[0][0] * toDisplay[1][1] - toDisplay[1][0] * toDisplay[0][1] < 0;
  const delta = (degrees - shown) * (mirrored ? -1 : 1);
  if (Math.abs(delta) < 1e-9) return {};
  const rotation = normalizeDegrees((node.rotation || 0) + delta);
  const centre = apply(localMatrix(node), {x: node.width / 2, y: node.height / 2});
  return {...boxOrigin(centre, node.width, node.height, rotation), rotation};
}

/** Layers whose place an auto-layout parent decides: their X and Y cannot be typed. */
export function isInFlow(doc: DesignDocument, node: SceneNode): boolean {
  return node.layoutPositioning !== 'ABSOLUTE' && isAutoLayout(doc.nodes[node.parentId ?? '']);
}

/** A side the size fields may not set: a line has no height. */
export const hasHeight = (node: SceneNode) => node.type !== 'LINE';

/** The updates that give the node a new width and/or height (keeping its top-left corner); with
 *  `keepRatio` the other side follows. Children follow their constraints. */
export function sizeUpdates(doc: DesignDocument, id: NodeId, size: {width?: number; height?: number}, keepRatio = false): NodeUpdates {
  const node = doc.nodes[id];
  if (!node) return new Map();
  let width = Math.max(0, size.width ?? node.width), height = hasHeight(node) ? Math.max(0, size.height ?? node.height) : 0;
  if (keepRatio && node.width > 0 && node.height > 0) {
    if (size.width !== undefined && size.height === undefined) height = clean((width * node.height) / node.width);
    else if (size.height !== undefined && size.width === undefined) width = clean((height * node.width) / node.height);
  }
  return resizeUpdates(doc, id, {x: node.x, y: node.y, width, height});
}
