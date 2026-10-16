import type {DesignDocument, NodeId, SceneNode} from '../../../../../shared/design/types';
import {apply, invert, localMatrix, multiply, normalizeDegrees, scaling, translation, unionRects, worldBox, worldMatrix} from '../../../../../shared/design/geometry';
import {boxOrigin, placementChanges, placementFor} from '../../../../../shared/design/transaction';
import {topLevelSelection} from '../../../../../shared/design/tree';

// The buttons of the "Rotation" row: mirror the selection (one piece, about its centre on screen,
// as ⇧H / ⇧V do) and turn each layer by 90° about its own centre. Pure: the fields to write per
// node; the section applies them in one transaction. (Alignment, distribution and tidy up are the
// arrange commands' own helpers, src/design/engine/commands/align.ts.)

export type Moves = Map<NodeId, Partial<SceneNode>>;

const turnable = (doc: DesignDocument, selection: readonly NodeId[]) =>
  topLevelSelection(doc, selection).filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE' && !doc.nodes[id].locked);

/** Mirrors each layer about the selection's centre on screen. */
export function flipUpdates(doc: DesignDocument, selection: readonly NodeId[], axis: 'x' | 'y'): Moves {
  const ids = turnable(doc, selection);
  const out: Moves = new Map();
  const bounds = unionRects(ids.map(id => worldBox(doc, id)));
  if (!bounds) return out;
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  const mirror = multiply(multiply(translation(cx, cy), scaling(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1)), translation(-cx, -cy));
  for (const id of ids) {
    const node = doc.nodes[id];
    const local = multiply(invert(worldMatrix(doc, node.parentId!)), multiply(mirror, worldMatrix(doc, id)));
    const prefer = axis === 'x' ? {flipX: !node.flipX, flipY: !!node.flipY} : {flipX: !!node.flipX, flipY: !node.flipY};
    out.set(id, placementChanges(node, placementFor(node, local, prefer)));
  }
  return out;
}

/** Turns each layer by `degrees` (positive is counter-clockwise, as the field) about its own centre. */
export function rotateUpdates(doc: DesignDocument, selection: readonly NodeId[], degrees: number): Moves {
  const out: Moves = new Map();
  for (const id of turnable(doc, selection)) {
    const node = doc.nodes[id];
    const rotation = normalizeDegrees((node.rotation || 0) + degrees);
    const centre = apply(localMatrix(node), {x: node.width / 2, y: node.height / 2});
    out.set(id, {...boxOrigin(centre, node.width, node.height, rotation), rotation});
  }
  return out;
}
