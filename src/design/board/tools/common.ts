import type {DesignDocument, NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {newId} from '../../../../shared/design/defaults';
import {frameAtPoint, type SpatialIndex} from '../../../../shared/design/tree';
import {boardObjectOf, isConnector, isStroke} from '../../../../shared/design/board/model';
import {insertPieces, type BoardBuild, type NewId} from '../../../../shared/design/board/create';
import {nearestMagnet} from '../../../../shared/design/board/connectors';
import type {ConnectorEnd, ConnectorMagnet} from '../../../../shared/design/board/types';
import {HIT_TOLERANCE_PX, pickAt} from '../../engine/hit-test';
import type {DesignStore, EditorState} from '../../engine/store';
import type {ToolContext} from '../../engine/tools/types';

// What the board's tools share (docs/board.md §Tools): where a new object goes (the section under the pointer, else the page),
// ids that a drag replays frame after frame, and what a connector's end attaches to.

/** Ids made once and handed out again in the same order on every frame of a drag (a gesture re-runs its recipe). */
export function replayIds(): {next: NewId; reset(): void} {
  const made: string[] = [];
  let at = 0;
  return {
    next: () => {
      if (at >= made.length) made.push(newId());
      return made[at++];
    },
    reset: () => void (at = 0),
  };
}

/** The container a new object at `page` goes into (a section under the point, or the page) and the point in its space. */
export function placement(state: EditorState, page: Vec, index: SpatialIndex | null): {parentId: NodeId; local: Vec} {
  const parentId = frameAtPoint(state.doc, state.pageId, page, new Set(), index) ?? state.pageId;
  return {parentId, local: parentId === state.pageId ? page : apply(invert(worldMatrix(state.doc, parentId)), page)};
}

/** Adds a build as one undo step and selects it. */
export function insertBuild(store: DesignStore, label: string, build: BoardBuild, parentId: NodeId, options: {select?: boolean} = {}): NodeId | null {
  store.transact(label, tx => {
    insertPieces(tx, build, parentId);
  }, options.select === false ? {} : {select: [build.id]});
  return store.getState().doc.nodes[build.id] ? build.id : null;
}

/** What a connector's end may attach to: the board object (or the top layer) under the point, never a connector or a stroke. */
export function attachableAt(state: EditorState, page: Vec, ctx: Pick<ToolContext, 'view' | 'index'>, exclude: ReadonlySet<NodeId> = new Set()): SceneNode | null {
  const picked = pickAt(state.doc, state.pageId, page, {tolerance: HIT_TOLERANCE_PX * ctx.view.pixel(), index: ctx.index()});
  if (!picked || exclude.has(picked)) return null;
  const object = boardObjectOf(id => (id ? state.doc.nodes[id] : undefined), picked) ?? state.doc.nodes[picked];
  if (!object || exclude.has(object.id) || isConnector(object) || isStroke(object) || object.type === 'SECTION' || object.locked) return null;
  return object;
}

/** Screen px from a side's middle within which an end snaps to that side (else the side facing the other end). */
export const MAGNET_SNAP_PX = 14;

/** The end a pointer at `page` makes: on the object under it (its nearest side when close to it), or a free point in the page. */
export function endAt(state: EditorState, page: Vec, ctx: Pick<ToolContext, 'view' | 'index'>, exclude?: ReadonlySet<NodeId>, anywhere = false): {end: ConnectorEnd; object: SceneNode | null} {
  const object = attachableAt(state, page, ctx, exclude);
  if (!object) return {end: {x: page.x, y: page.y}, object: null};
  // ⌘ (Ctrl) held: the end stays at that very point of the object instead of a side (FigJam), as a share of its box.
  if (anywhere) {
    const local = apply(invert(worldMatrix(state.doc, object.id)), page);
    const unit = (value: number, size: number) => Math.min(1, Math.max(0, size > 0 ? value / size : 0.5));
    return {end: {node: object.id, at: {x: unit(local.x, object.width), y: unit(local.y, object.height)}}, object};
  }
  const near = nearestMagnet({node: object, world: worldMatrix(state.doc, object.id)}, page);
  const magnet: ConnectorMagnet = near.distance * ctx.view.viewport().zoom <= MAGNET_SNAP_PX ? near.magnet : 'auto';
  return {end: {node: object.id, magnet}, object};
}

/** The four side middles of an object in page space (where connection dots and magnets are drawn). */
export function sideMiddles(doc: DesignDocument, id: NodeId): {magnet: 'top' | 'right' | 'bottom' | 'left'; at: Vec; out: Vec}[] {
  const node = doc.nodes[id];
  if (!node) return [];
  const m = worldMatrix(doc, id);
  const centre = apply(m, {x: node.width / 2, y: node.height / 2});
  const sides = [
    {magnet: 'top' as const, local: {x: node.width / 2, y: 0}},
    {magnet: 'right' as const, local: {x: node.width, y: node.height / 2}},
    {magnet: 'bottom' as const, local: {x: node.width / 2, y: node.height}},
    {magnet: 'left' as const, local: {x: 0, y: node.height / 2}},
  ];
  return sides.map(side => {
    const at = apply(m, side.local);
    const length = Math.hypot(at.x - centre.x, at.y - centre.y) || 1;
    return {magnet: side.magnet, at, out: {x: (at.x - centre.x) / length, y: (at.y - centre.y) / length}};
  });
}

/** Rounded rectangle path on a 2D context (screen px). */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  if ('roundRect' in ctx) ctx.roundRect(x, y, width, height, radius);
  else (ctx as CanvasRenderingContext2D).rect(x, y, width, height);
}

/** The board's accent (the purple of its chrome; selection stays the editor's blue). */
export const BOARD_ACCENT = '#9747FF';
