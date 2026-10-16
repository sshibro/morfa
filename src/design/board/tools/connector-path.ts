import type {DesignDocument, NodeId, Vec} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {childPart, isConnector} from '../../../../shared/design/board/model';
import {samplePath} from '../../../../shared/design/board/connectors';
import {connectorEnds} from './move';

// A connector's path handles (help.figma.com "Create diagrams and flows with connectors": "Drag the path handle for the portion you
// want to move"; "Drag the text label anywhere along the connector's path"). The path runs start → waypoints → end; a waypoint
// (`board.points`, in the connector's parent space) is a handle that moves, and the middle of each stretch between two of them is a
// handle that adds one there. The label's place is `board.labelAt`, the share of the path's length.

export type PathHandle = {kind: 'point' | 'mid'; index: number; at: Vec};

const metaOf = (doc: DesignDocument, id: NodeId) => {
  const node = doc.nodes[id];
  return node && isConnector(node) && node.board?.kind === 'connector' ? node.board : null;
};

/** Page ↔ the connector's parent space (where its waypoints are kept). */
export function parentSpace(doc: DesignDocument, id: NodeId) {
  const parent = doc.nodes[id]?.parentId;
  const toPage = parent && doc.nodes[parent]?.type !== 'PAGE' ? worldMatrix(doc, parent) : null;
  return {
    toPage: (p: Vec) => (toPage ? apply(toPage, p) : p),
    fromPage: (p: Vec) => (toPage ? apply(invert(toPage), p) : p),
  };
}

/** The waypoints and the stretch middles of a connector, in page space. */
export function pathHandles(doc: DesignDocument, id: NodeId): PathHandle[] {
  const meta = metaOf(doc, id);
  const ends = connectorEnds(doc, id);
  if (!meta || !ends) return [];
  const space = parentSpace(doc, id);
  const points = (meta.points ?? []).map(space.toPage);
  const anchors = [ends.start, ...points, ends.end];
  const out: PathHandle[] = points.map((at, index) => ({kind: 'point', index, at}));
  for (let k = 0; k < anchors.length - 1; k++) {
    const a = anchors[k], b = anchors[k + 1];
    out.push({kind: 'mid', index: k, at: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}});
  }
  return out;
}

/** The connector's line as page-space samples. */
function linePolyline(doc: DesignDocument, id: NodeId): Vec[] {
  const line = childPart(nodeId => (nodeId ? doc.nodes[nodeId] : undefined), doc.nodes[id], 'line');
  const commands = line?.vectorPaths?.[0]?.commands;
  if (!line || !commands?.length) return [];
  const m = worldMatrix(doc, line.id);
  return samplePath(commands).map(p => apply(m, p));
}

/** The share of the path's length nearest to `page` (where a dragged label goes), 0…1. */
export function labelFractionAt(doc: DesignDocument, id: NodeId, page: Vec): number {
  const points = linePolyline(doc, id);
  if (points.length < 2) return 0.5;
  let total = 0, best = {distance: Infinity, at: 0};
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k], b = points[k + 1];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    const t = length ? Math.min(1, Math.max(0, ((page.x - a.x) * dx + (page.y - a.y) * dy) / (length * length))) : 0;
    const distance = Math.hypot(a.x + dx * t - page.x, a.y + dy * t - page.y);
    if (distance < best.distance) best = {distance, at: total + length * t};
    total += length;
  }
  return total ? Math.round((best.at / total) * 1000) / 1000 : 0.5;
}
