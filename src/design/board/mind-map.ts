import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import {newId} from '../../../shared/design/defaults';
import {createBoardText, createConnector, insertPieces, type BoardBuild, type NewId} from '../../../shared/design/board/create';
import {isConnector} from '../../../shared/design/board/model';
import {apply, invert, worldMatrix} from '../../../shared/design/geometry';
import type {Vec} from '../../../shared/design/types';
import type {Command, CommandContext} from '../engine/commands';
import {currentViewport} from '../engine/store';
import {viewportCenter} from '../engine/viewport';

// Mind maps as FigJam has them (help.figma.com "Create mindmaps in FigJam"): nodes are texts joined by soft grey curves from the
// right of a node to the left of its children. Nothing new is stored: a node's children are the texts its branches run to, so a
// mind map is ordinary texts and connectors (it opens in any editor, copies and undoes as they do). "Mind map" in the shapes
// tray places one; "Start mind map" on a text's toolbar grows the first branch; ⌘↵ adds a child, ⇧⌘↵ a sibling, each open
// for typing (an empty one is taken away with its branch when typing ends).

export const MIND_LINE = '#B3B3B3';
export const MIND_GAP_X = 96;
export const MIND_GAP_Y = 24;
const ROOT_SIZE = 24, CHILD_SIZE = 16;

/** A text that can be a node: a plain board text (not a part of a sticky, shape or table). */
export const isMindNode = (node: SceneNode | undefined): node is SceneNode & {type: 'TEXT'} => node?.type === 'TEXT' && !node.board;

const branchBuild = (newIdFn: NewId, from: NodeId, to: NodeId) =>
  createConnector(newIdFn, {start: {node: from, magnet: 'right'}, end: {node: to, magnet: 'left'}, line: 'curved', color: MIND_LINE, weight: 2, endMarker: 'NONE'});

const endNode = (connector: SceneNode, which: 'start' | 'end') => {
  const end = connector.board?.kind === 'connector' ? connector.board[which] : null;
  return end && 'node' in end ? end.node : null;
};

/** The nodes a node's branches run to, top to bottom. */
export function mindChildren(doc: DesignDocument, id: NodeId): SceneNode[] {
  return Object.values(doc.nodes)
    .filter(node => isConnector(node) && endNode(node, 'start') === id)
    .map(link => doc.nodes[endNode(link, 'end') ?? ''])
    .filter(isMindNode)
    .sort((a, b) => a.y - b.y);
}

/** The node a node's branch comes from, or null for a root. */
export function mindParent(doc: DesignDocument, id: NodeId): SceneNode | null {
  const link = Object.values(doc.nodes).find(node => isConnector(node) && endNode(node, 'end') === id && isMindNode(doc.nodes[endNode(node, 'start') ?? '']));
  return link ? doc.nodes[endNode(link, 'start')!] : null;
}

/** A text already in a mind map (a branch runs to it or from it): the move tool shows its + then. */
export const inMindMap = (doc: DesignDocument, id: NodeId) => isMindNode(doc.nodes[id]) && (!!mindParent(doc, id) || mindChildren(doc, id).length > 0);

/** Where a new child of `parent` goes: right of it, under its last child (or level with it for the first). */
export function childSpot(doc: DesignDocument, parent: SceneNode): {x: number; y: number} {
  const children = mindChildren(doc, parent.id);
  const x = Math.round(children[0]?.x ?? parent.x + parent.width + MIND_GAP_X);
  const last = children[children.length - 1];
  const y = last ? last.y + last.height + MIND_GAP_Y : parent.y + parent.height / 2 - (CHILD_SIZE * 1.2) / 2;
  return {x, y: Math.round(y)};
}

/** A small mind map at `centre`: a topic and three ideas (FigJam's starting map). */
export function createMindMap(newIdFn: NewId, centre: {x: number; y: number}): BoardBuild[] {
  const root = createBoardText(newIdFn, {x: Math.round(centre.x - 160), y: Math.round(centre.y - ROOT_SIZE * 0.6), text: 'Topic or question', size: ROOT_SIZE, weight: 700});
  const builds: BoardBuild[] = [root];
  ['Concept', 'Idea', 'Thought'].forEach((text, k) => {
    const child = createBoardText(newIdFn, {x: Math.round(centre.x + 120), y: Math.round(centre.y - 60 + k * 50 - CHILD_SIZE * 0.6), text, size: CHILD_SIZE});
    builds.push(child, branchBuild(newIdFn, root.id, child.id));
  });
  return builds;
}

/** The node a mind-map key acts on: the text being typed into, or the one selected. */
function nodeOf(ctx: CommandContext): SceneNode | null {
  const state = ctx.store.getState();
  const id = state.editing?.kind === 'text' ? state.editing.id : state.selection.length === 1 ? state.selection[0] : null;
  const node = id ? state.doc.nodes[id] : undefined;
  return isMindNode(node) ? node : null;
}

/** A child of `parent` from its + (the move tool's dot), as ⌘↵ makes one. */
export const growMindChild = (ctx: Pick<CommandContext, 'store' | 'enterEdit'>, parent: SceneNode) => grow(ctx, parent, 'Child node');

/** Adds an empty node under `parent`, joined by a branch, and opens it for typing; an empty one goes with its branch when typing ends. */
function grow(ctx: Pick<CommandContext, 'store' | 'enterEdit'>, parent: SceneNode, label: string) {
  const {doc} = ctx.store.getState();
  const at = childSpot(doc, parent);
  const child = createBoardText(newId, {...at, text: '', size: CHILD_SIZE});
  const link = branchBuild(newId, parent.id, child.id);
  ctx.store.setEditing(null);
  ctx.store.transact(label, tx => {
    insertPieces(tx, child, parent.parentId!);
    insertPieces(tx, link, ctx.store.getState().pageId);
  }, {select: [child.id]});
  if (!ctx.enterEdit) return;
  ctx.enterEdit(child.id, 'text');
  const off = ctx.store.subscribe(() => {
    const state = ctx.store.getState();
    if (state.editing?.id === child.id) return;
    off();
    if (!state.doc.nodes[child.id] && state.doc.nodes[link.id]) ctx.store.transact('Delete branch', tx => tx.remove(link.id));
  });
}

const editable = (ctx: CommandContext) => !ctx.store.readOnly && !!nodeOf(ctx);

export const MIND_COMMANDS: Command[] = [
  {
    id: 'board.mind-child', label: 'Mind map: child node', group: 'board', enabled: editable,
    run: ctx => {
      const node = nodeOf(ctx);
      if (node?.parentId) grow(ctx, node, 'Child node');
    },
  },
  {
    id: 'board.mind-sibling', label: 'Mind map: sibling node', group: 'board', enabled: editable,
    run: ctx => {
      const node = nodeOf(ctx);
      if (!node?.parentId) return;
      const parent = mindParent(ctx.store.getState().doc, node.id);
      // A root has no siblings: its first child instead.
      grow(ctx, parent ?? node, parent ? 'Sibling node' : 'Child node');
    },
  },
  {
    id: 'board.mind-map', label: 'Mind map', group: 'board', enabled: ctx => !ctx.store.readOnly,
    run: ctx => {
      const state = ctx.store.getState();
      const builds = createMindMap(newId, viewportCenter(currentViewport(state), ctx.canvasSize()));
      ctx.store.transact('Mind map', tx => {
        for (const build of builds) insertPieces(tx, build, state.pageId);
      }, {select: [builds[0].id]});
    },
  },
];

/** The mind map text under `page` that a dragged object would join (FigJam: "Drag and hover the object over the node"), not
 *  `except` itself; null when none. */
export function mindTargetAt(doc: DesignDocument, page: Vec, except: NodeId): SceneNode | null {
  for (const node of Object.values(doc.nodes)) {
    if (node.id === except || !inMindMap(doc, node.id)) continue;
    const local = apply(invert(worldMatrix(doc, node.id)), page);
    if (local.x >= 0 && local.y >= 0 && local.x <= node.width && local.y <= node.height) return node;
  }
  return null;
}

/** Joins `objectId` to the map as a child of `nodeId` with a branch (none when one already runs between them; a node of a map moves
 *  from its old parent); one undo step. */
export function joinMindMap(store: CommandContext['store'], nodeId: NodeId, objectId: NodeId): boolean {
  const doc = store.getState().doc;
  if (store.readOnly || !doc.nodes[nodeId] || !doc.nodes[objectId]) return false;
  const joined = Object.values(doc.nodes).some(node => isConnector(node) && [endNode(node, 'start'), endNode(node, 'end')].sort().join() === [nodeId, objectId].sort().join());
  if (joined) return false;
  // A node of a map dropped on another node moves there: its old branch goes.
  const old = Object.values(doc.nodes).find(node => isConnector(node) && endNode(node, 'end') === objectId && isMindNode(doc.nodes[endNode(node, 'start') ?? '']));
  const link = branchBuild(newId, nodeId, objectId);
  store.transact('Join mind map', tx => {
    if (old) tx.remove(old.id);
    insertPieces(tx, link, store.getState().pageId);
  }, {select: [objectId]});
  return true;
}
