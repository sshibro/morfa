// Comments (docs/design-tool.md §Teams, "Comments"): the wire types of `/api/design-files/:id/comments`, the limits,
// the plain-text and mention rules the editor and the server both check, and how a pin is anchored to a layer so it follows the layer
// when it moves. No zod and no server imports: the design area and the server read the same rules; the server decides every request.
//
// Routes (signed in; the file's `fileAccess` 'view' — every member of its team, or the owner of a personal file; writes refuse a file
// in the trash with 404):
//   GET    /api/design-files/:id/comments?since=<cursor>                  → DesignCommentList (changes after the cursor; all without one)
//   POST   /api/design-files/:id/comments                 DesignThreadCreate → 201 {thread}
//   POST   /api/design-files/:id/comments/read            {threads: id[]}    → {ok}         marks the threads read up to now
//   PATCH  /api/design-files/:id/comments/:threadId       {resolved}         → {thread}     the thread's author or an editor
//   DELETE /api/design-files/:id/comments/:threadId                          → {thread: tombstone}  the author or a manager
//   POST   /api/design-files/:id/comments/:threadId/replies DesignCommentDraft → 201 {thread}
//   PATCH  /api/design-files/:id/comments/:threadId/messages/:commentId DesignCommentDraft → {thread}  its author only
//   DELETE /api/design-files/:id/comments/:threadId/messages/:commentId → {thread}  its author or a manager; the first one takes the thread
import {apply, invert, localMatrix, multiply, worldMatrix, IDENTITY} from './geometry';
import type {DesignDocument, Matrix, NodeId, SceneNode, Vec} from './types';

export const DESIGN_COMMENT_LIMITS = {
  /** Characters of one comment (UTF-16 units, as the editor counts them). */
  textLength: 4000,
  /** Mentions in one comment. */
  mentions: 20,
  /** Characters of one mention, the "@" included. */
  mentionLength: 101,
  /** Threads of one file that are not deleted (open and resolved). */
  threadsPerFile: 1000,
  /** Comments of one thread, the first one included. */
  commentsPerThread: 500,
  /** Comments of one file. */
  commentsPerFile: 5000,
  /** Threads one "mark as read" request marks. */
  readBatch: 500,
  /** |x| and |y| of a pin, as every coordinate of a document (document-limits.ts). */
  coordinate: 1e9,
  /** A layer or page id (schema.ts). */
  idLength: 512,
} as const;

/** How often an open, visible file asks for changes while no real-time channel pushes them. */
export const DESIGN_COMMENT_POLL_MS = 20_000;

/** Where a pin stands. `x`/`y` is its point on the page: for a pin on a layer, where it stood when it was last written, used once the
 *  layer is gone. `nodeId` and `offset` (the point in the layer's own space, before rotation) make it follow the layer. */
export type DesignCommentAnchor = {
  pageId: NodeId;
  x: number;
  y: number;
  nodeId: NodeId | null;
  offset: Vec | null;
};

/** An author or the person who resolved a thread. `id` null: the account was erased ("Deleted account"). */
export type DesignCommentPerson = {id: string | null; name: string};
/** "@Name" in a comment's text: `at` and `length` in UTF-16 units of `text`, the "@" included. */
export type DesignCommentMention = {userId: string; at: number; length: number};

export type DesignComment = {
  id: string;
  author: DesignCommentPerson;
  /** Plain text, never markup. */
  text: string;
  mentions: DesignCommentMention[];
  createdAt: string;
  editedAt: string | null;
  /** The file's change counter when it was written. */
  seq: number;
};

export type DesignCommentThread = {
  id: string;
  deleted?: false;
  /** The file's change counter at the thread's last change (a reply, an edit, resolving). */
  seq: number;
  anchor: DesignCommentAnchor;
  author: DesignCommentPerson;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: DesignCommentPerson | null;
  /** The first comment opens the thread; replies follow, oldest first. */
  comments: DesignComment[];
  /** The caller read the thread up to this counter. */
  readSeq: number;
  /** Comments of others the caller has not read. */
  unread: number;
};
/** A deleted thread, in the changes after a cursor, so an open editor drops it. */
export type DesignCommentTombstone = {id: string; deleted: true; seq: number};
export type DesignCommentChange = DesignCommentThread | DesignCommentTombstone;

/** What the caller may do beyond its own comments. */
export type DesignCommentRights = {
  /** Resolve and reopen any thread (an editor, or the owner of a personal file); everyone resolves the threads they started. */
  resolveAny: boolean;
  /** Delete any comment (the team's owner and admins, the owner of a personal file); everyone deletes their own. */
  deleteAny: boolean;
  /** Mention members (team files only). */
  mention: boolean;
};

export type DesignCommentList = {
  threads: DesignCommentChange[];
  /** The file's change counter: pass it as `since` for the next changes. */
  cursor: number;
  you: {id: string; name: string};
  rights: DesignCommentRights;
};
export type DesignCommentDraft = {text: string; mentions: DesignCommentMention[]};
export type DesignThreadCreate = DesignCommentDraft & {anchor: DesignCommentAnchor};

export const DESIGN_COMMENT_PARAM = 'comment';
/** The link to a thread: `<app>/#design/<file>?comment=<thread>` opens the file with the thread. */
export const designCommentLink = (base: {origin: string; pathname: string}, fileId: string, threadId: string) =>
  `${base.origin}${base.pathname}#design/${encodeURIComponent(fileId)}?${DESIGN_COMMENT_PARAM}=${encodeURIComponent(threadId)}`;

/** A thread or comment id (a UUID). */
export const DESIGN_COMMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NODE_ID = /^[A-Za-z0-9_:;.,-]+$/;
const isNodeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= DESIGN_COMMENT_LIMITS.idLength && NODE_ID.test(value);
const isCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= DESIGN_COMMENT_LIMITS.coordinate;

// ── Text and mentions ────────────────────────────────────────────────────────────────────────────

// Control characters other than the line break and the tab: nothing a person types, and they would hide text.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** Line breaks as the editor keeps them (\n) and the text without the spaces around it; mentions are counted in this text. */
export const tidyCommentText = (text: string): string => text.replace(/\r\n?/g, '\n').trim();

/** Why a comment's text is refused, in the editor's words, or null. Plain text only: it is shown as text, never as markup. */
export function commentTextIssue(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return 'Write a comment.';
  if (text.length > DESIGN_COMMENT_LIMITS.textLength) return `The comment is longer than ${DESIGN_COMMENT_LIMITS.textLength} characters.`;
  if (CONTROL.test(text) || !wellFormed(text)) return 'The comment contains invalid characters.';
  if (text !== tidyCommentText(text)) return 'Remove the spaces at the start and end of the comment.';
  return null;
}

/** No lone surrogate halves (they cannot be stored as UTF-8). */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Why the mentions of `text` are refused, or null: each one an "@…" of the text, in order, not overlapping, at most 20. Whether the
 *  people are members of the file's team is the server's check. */
export function mentionsIssue(text: string, mentions: unknown): string | null {
  if (!Array.isArray(mentions)) return 'Check the mentions.';
  if (mentions.length > DESIGN_COMMENT_LIMITS.mentions) return `A comment can mention no more than ${DESIGN_COMMENT_LIMITS.mentions} people.`;
  let end = 0;
  for (const mention of mentions as DesignCommentMention[]) {
    if (!mention || typeof mention !== 'object') return 'Check the mentions.';
    const {userId, at, length} = mention;
    if (typeof userId !== 'string' || !userId || userId.length > 200) return 'Check the mentions.';
    if (!Number.isInteger(at) || !Number.isInteger(length) || at < end || length < 2 || length > DESIGN_COMMENT_LIMITS.mentionLength) return 'Check the mentions.';
    if (at + length > text.length || text[at] !== '@') return 'Check the mentions.';
    end = at + length;
  }
  return null;
}

/** The text cut into plain runs and mentions, for rendering as text nodes (never markup). Mentions that do not fit are left as text. */
export function commentSegments(text: string, mentions: readonly DesignCommentMention[]): Array<{text: string; userId?: string}> {
  const out: Array<{text: string; userId?: string}> = [];
  let at = 0;
  for (const mention of mentions) {
    if (mention.at < at || mention.at + mention.length > text.length) continue;
    if (mention.at > at) out.push({text: text.slice(at, mention.at)});
    out.push({text: text.slice(mention.at, mention.at + mention.length), userId: mention.userId});
    at = mention.at + mention.length;
  }
  if (at < text.length) out.push({text: text.slice(at)});
  return out;
}

/** Keeps mentions in step with an edit of the text between `start` and `end` (replaced by `inserted` characters): a mention the edit
 *  touches is dropped (it no longer reads as the name), the ones after it move. */
export function shiftMentions(mentions: readonly DesignCommentMention[], start: number, end: number, inserted: number): DesignCommentMention[] {
  const delta = inserted - (end - start);
  const out: DesignCommentMention[] = [];
  for (const mention of mentions) {
    const mentionEnd = mention.at + mention.length;
    if (mentionEnd <= start) out.push(mention);
    else if (mention.at >= end) out.push({...mention, at: mention.at + delta});
  }
  return out;
}

// ── Anchors ──────────────────────────────────────────────────────────────────────────────────────

/** Why an anchor is refused, or null. */
export function anchorIssue(anchor: unknown): string | null {
  const value = anchor as Partial<DesignCommentAnchor> | null;
  if (!value || typeof value !== 'object') return 'Choose a place for the comment.';
  if (!isNodeId(value.pageId) || !isCoordinate(value.x) || !isCoordinate(value.y)) return 'Choose a place for the comment.';
  if (value.nodeId === null || value.nodeId === undefined) return value.offset === null || value.offset === undefined ? null : 'Choose a place for the comment.';
  if (!isNodeId(value.nodeId) || !value.offset || !isCoordinate(value.offset.x) || !isCoordinate(value.offset.y)) return 'Choose a place for the comment.';
  return null;
}

const insideBox = (node: SceneNode, local: Vec) => local.x >= 0 && local.y >= 0 && local.x <= node.width && local.y <= node.height;
const isTarget = (node: SceneNode) =>
  node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE' || node.type === 'SECTION';

/**
 * The layer a pin dropped at the page-space `point` follows: the innermost visible frame, component, variant set, instance or section
 * whose box holds the point (top-most first, locked ones too: a comment does not change them; an instance is not entered), or null for
 * the canvas itself. Walks only the containers under the point.
 */
export function commentTargetAt(doc: DesignDocument, pageId: NodeId, point: Vec): NodeId | null {
  const search = (parentId: NodeId, world: Matrix): NodeId | null => {
    const parent = doc.nodes[parentId];
    const children = parent?.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const child = doc.nodes[children[i]];
      if (!child || !child.visible) continue;
      if (child.type !== 'GROUP' && !isTarget(child)) continue;
      const m = multiply(world, localMatrix(child));
      if (child.type === 'GROUP') {
        const inner = search(child.id, m);
        if (inner) return inner;
        continue;
      }
      const inside = insideBox(child, apply(invert(m), point));
      const clips = child.type !== 'SECTION' && child.clipsContent !== false;
      if (child.type !== 'INSTANCE' && (inside || !clips)) {
        const inner = search(child.id, m);
        if (inner) return inner;
      }
      if (inside) return child.id;
    }
    return null;
  };
  return doc.nodes[pageId]?.type === 'PAGE' ? search(pageId, IDENTITY) : null;
}

/** The anchor of a pin dropped at `point` on the page: on the layer under it, or on the canvas. */
export function anchorAt(doc: DesignDocument, pageId: NodeId, point: Vec): DesignCommentAnchor {
  const x = round(point.x),
    y = round(point.y);
  const nodeId = commentTargetAt(doc, pageId, point);
  if (!nodeId) return {pageId, x, y, nodeId: null, offset: null};
  const local = apply(invert(worldMatrix(doc, nodeId)), point);
  return {pageId, x, y, nodeId, offset: {x: round(local.x), y: round(local.y)}};
}

/** Two decimals: a pin needs no more, and the stored numbers stay short. */
const round = (value: number) => Math.round(value * 100) / 100;

/** The node an anchor follows when it is still on the anchor's page, else undefined. */
function anchoredNode(doc: DesignDocument, anchor: DesignCommentAnchor): SceneNode | undefined {
  if (!anchor.nodeId || !anchor.offset) return undefined;
  const node = doc.nodes[anchor.nodeId];
  if (!node || node.type === 'PAGE') return undefined;
  let page: SceneNode | undefined = node;
  for (let depth = 0; page && page.type !== 'PAGE' && depth < 1000; depth++) page = page.parentId ? doc.nodes[page.parentId] : undefined;
  return page?.id === anchor.pageId ? node : undefined;
}

/** Where the pin stands on its page now: on its layer while the layer is there (it moves, resizes and rotates with it), else at the
 *  point it was last written at. `attached` says which. */
export function anchorPoint(doc: DesignDocument, anchor: DesignCommentAnchor): {x: number; y: number; attached: boolean} {
  const node = anchoredNode(doc, anchor);
  if (!node || !anchor.offset) return {x: anchor.x, y: anchor.y, attached: false};
  const point = apply(worldMatrix(doc, node.id), anchor.offset);
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? {x: point.x, y: point.y, attached: true} : {x: anchor.x, y: anchor.y, attached: false};
}
