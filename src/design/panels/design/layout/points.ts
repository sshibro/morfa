import type {DesignDocument, NodeId, Vec} from '../../../../../shared/design/types';
import {apply, applyLinear, invert, multiply, worldMatrix} from '../../../../../shared/design/geometry';
import type {Transaction} from '../../../../../shared/design/transaction';
import {moveAnchors, networkOfNode, parseKey, validKeys, writeNetwork, type AnchorKey} from '../../../engine/vector-edit';
import {displaySpaceId} from './geometry';

// "Point" while a path is edited (Figma shows the selected points' X and Y in the Design panel): the box of the selected
// anchors read in the space the layer's own X and Y are shown in (geometry.ts `displaySpaceId`), and moving them there.

/** Hundredths, as the panel prints positions. */
const clean = (value: number) => Math.round(value * 100) / 100 + 0;

export type PointsBox = {x: number; y: number; count: number};

const displayWorld = (doc: DesignDocument, id: NodeId) => {
  const space = displaySpaceId(doc, id);
  return space ? worldMatrix(doc, space) : worldMatrix(doc, id);
};

/** The top-left of the selected anchors of `id` in its display space, or null with none selected. */
export function selectedPointsBox(doc: DesignDocument, id: NodeId, keys: Iterable<AnchorKey>): PointsBox | null {
  const node = doc.nodes[id];
  if (!node) return null;
  const network = networkOfNode(node);
  const refs = [...validKeys(network, keys)].map(parseKey);
  if (!refs.length) return null;
  const toDisplay = multiply(invert(displayWorld(doc, id)), worldMatrix(doc, id));
  const points = refs.map(ref => apply(toDisplay, network[ref.p].subs[ref.s].anchors[ref.a]));
  return {x: clean(Math.min(...points.map(p => p.x))), y: clean(Math.min(...points.map(p => p.y))), count: refs.length};
}

/** Moves the selected anchors of `id` so their box's `axis` reads `value` in the display space. */
export function moveSelectedPoints(tx: Transaction, id: NodeId, keys: Iterable<AnchorKey>, axis: 'x' | 'y', value: number): void {
  const doc = tx.doc;
  const node = doc.nodes[id];
  const box = selectedPointsBox(doc, id, keys);
  if (!node || !box || !Number.isFinite(value) || value === box[axis]) return;
  const network = networkOfNode(node);
  const refs = [...validKeys(network, keys)].map(parseKey);
  const shift: Vec = axis === 'x' ? {x: value - box.x, y: 0} : {x: 0, y: value - box.y};
  const local = applyLinear(invert(worldMatrix(doc, id)), applyLinear(displayWorld(doc, id), shift));
  writeNetwork(tx, id, moveAnchors(network, refs, local));
}
