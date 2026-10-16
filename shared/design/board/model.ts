import type {DesignDocument, NodeId, SceneNode} from '../types';
import type {BoardKind, BoardMeta, BoardPart} from './types';

// "Board" (docs/board.md §Objects): questions about board layers that every module asks — is this layer a board object, which
// object does a layer belong to, which part of it is it. Pure, no DOM.

/** Kinds a click selects as a whole (hit-test.ts `liftToSelectable`): the object, never a layer inside it. */
const OBJECT_KINDS: ReadonlySet<BoardKind> = new Set<BoardKind>(['sticky', 'shape', 'connector', 'stamp', 'sticker', 'table', 'stroke']);

export const boardKind = (node: SceneNode | undefined): BoardKind | null => node?.board?.kind ?? null;

/** A board object (selected, moved, voted on as a whole). */
export const isBoardObject = (node: SceneNode | undefined): boolean => !!node?.board && OBJECT_KINDS.has(node.board.kind);

export const isSticky = (node: SceneNode | undefined): boolean => node?.board?.kind === 'sticky';
export const isShapeWithText = (node: SceneNode | undefined): boolean => node?.board?.kind === 'shape';
export const isConnector = (node: SceneNode | undefined): boolean => node?.board?.kind === 'connector';
export const isTable = (node: SceneNode | undefined): boolean => node?.board?.kind === 'table';
export const isStamp = (node: SceneNode | undefined): boolean => node?.board?.kind === 'stamp';
export const isStroke = (node: SceneNode | undefined): boolean => node?.board?.kind === 'stroke';

export const partOf = (node: SceneNode | undefined): BoardPart | null => (node?.board?.kind === 'part' ? node.board.part : null);

export type NodeLookup = (id: NodeId | null | undefined) => SceneNode | undefined;

/** The board object a layer belongs to (itself when it is one), or null. Parts are found within a few levels. */
export function boardObjectOf(get: NodeLookup, id: NodeId): SceneNode | null {
  let node = get(id);
  for (let depth = 0; node && depth < 6; depth++) {
    if (isBoardObject(node)) return node;
    if (!node.board || node.board.kind !== 'part') return null;
    node = get(node.parentId);
  }
  return null;
}

/** The direct child of `owner` that is the given part (the sticky's text, a connector's line...). */
export function childPart(get: NodeLookup, owner: SceneNode | undefined, part: BoardPart): SceneNode | undefined {
  for (const childId of owner?.children ?? []) {
    const child = get(childId);
    if (partOf(child) === part) return child;
  }
  return undefined;
}

/** What a vote can be cast on (the meeting module, docs/board.md §Meeting slot). */
export const isVotable = (node: SceneNode | undefined): boolean =>
  !!node && (node.type === 'TEXT' ? !node.board : !!node.board && ['sticky', 'shape', 'stamp', 'sticker', 'table'].includes(node.board.kind));

export const part = (value: BoardPart): BoardMeta => ({kind: 'part', part: value});

const hiddenCache = new WeakMap<DesignDocument, ReadonlySet<NodeId> | null>();

/** What board sections with their contents hidden (FigJam's "Hide section") hold, directly: the renderer leaves these out (their
 *  subtrees with them). Null when no section hides anything. Cached per document (a moment: the node table itself is written in
 *  place, docs/decisions/in-place-table.md). */
export function hiddenSectionChildren(doc: DesignDocument): ReadonlySet<NodeId> | null {
  if (hiddenCache.has(doc)) return hiddenCache.get(doc)!;
  let out: Set<NodeId> | null = null;
  for (const node of Object.values(doc.nodes)) {
    if (node.type === 'SECTION' && node.board?.kind === 'section' && node.board.hidden) for (const id of node.children ?? []) (out ??= new Set()).add(id);
  }
  hiddenCache.set(doc, out);
  return out;
}
