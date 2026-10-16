import type {ComponentType} from 'react';
import type {NodeId, Vec} from '../../../shared/design/types';
import type {Rect} from '../../../shared/design/geometry';
import type {EditorServices} from '../editor/services';
import type {Realtime} from '../realtime';

// "Board" (docs/board.md §Meeting slot): the board editor's plug-in point for the meeting features (timer with music,
// voting sessions, emotes, cursor chat, spotlight, high five), which live in their own module and mount in both editors.
// This file is types and a registry only: no React tree, no engine code, so the meeting module can import it statically
// without pulling the board into its chunk, and the board can render whatever was registered without importing it.

/** A badge drawn at a board object's top-right corner, over the canvas: a vote count, a reaction count. */
export type BoardBadge = {
  /** The board object (as `objectAt*` answers it). A badge of an object that is gone or on another page is not drawn. */
  id: NodeId;
  /** The number shown; 0 hides the badge. */
  count: number;
  /** Read by screen readers and shown as a tooltip, e.g. "3 votes". */
  label?: string;
  /** `accent`: the board's purple; `mine`: filled (the viewer took part); `neutral`: grey. Default `accent`. */
  tone?: 'accent' | 'mine' | 'neutral';
};

/** A primary click on the canvas, as an interceptor sees it (see `interceptClicks`). */
export type BoardClick = {
  /** The board object under the pointer, null on empty canvas. */
  id: NodeId | null;
  /** Page coordinates of the click. */
  page: Vec;
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  altKey: boolean;
  mod: boolean;
};

/** What the board offers a meeting feature about its objects. Valid while the board editor is open. */
export type BoardObjectsApi = {
  /** The board object under a page point (a sticky, shape, stamp, sticker, text, table, connector or a marker stroke; never the
   *  page and never a section itself — the object inside it), top-most first, or null. Children of an object (a sticky's text)
   *  answer the object. */
  objectAtPage(point: Vec): NodeId | null;
  /** The same for a pointer position in client px (`event.clientX/Y`); null outside the canvas. */
  objectAtClient(clientX: number, clientY: number): NodeId | null;
  /** The object's box: in page coordinates, or in client px. Null when it is not on the current page. */
  objectBounds(id: NodeId, space?: 'page' | 'client'): Rect | null;
  /** The objects a vote can be cast on, on the current page, top-level first (stickies, shapes, stamps, stickers, texts,
   *  tables; not connectors or marker strokes). */
  votableObjects(): NodeId[];
  /** Replaces the badges of one source ('voting', 'reactions'...); an empty list removes them. Drawn by the board over the
   *  canvas, following pans and zooms. */
  setBadges(source: string, badges: readonly BoardBadge[]): void;
  /** While registered, a primary click on the canvas (with any tool) is offered to `handler` first; when it returns true the
   *  click is consumed and the canvas does nothing (no selection, no drawing). Returns the unregister function. The last
   *  registered interceptor is asked first. */
  interceptClicks(handler: (click: BoardClick) => boolean): () => void;
  /** The current page and a subscription to page changes (votes are per page). */
  pageId(): NodeId;
  onPageChange(listener: (pageId: NodeId) => void): () => void;
};

/** Props of what the meeting module registers. */
export type BoardMeetingProps = {
  /** The open file's services (store, fonts, toast, canvas controller, readOnly...). */
  services: EditorServices;
  /** Co-editing and presence once loaded (null before, or offline): `realtime.live` has the peers and the presence channel. */
  realtime: Realtime | null;
  board: BoardObjectsApi;
  /** Which editor mounts it: the board's chrome here. */
  editor: 'board';
};

/** The two places the board renders the meeting module: `Controls` inside the top-right pill (between the people here and the
 *  board's own buttons: timer, voting, spotlight...), `CanvasLayer` over the canvas (a full-size layer whose own box takes no
 *  pointer events: cursor chat, emotes, the spotlight frame, high fives; give interactive children `pointer-events: auto`). */
export type BoardMeetingModule = {
  Controls?: ComponentType<BoardMeetingProps>;
  CanvasLayer?: ComponentType<BoardMeetingProps>;
};

let registered: BoardMeetingModule | null = null;
const listeners = new Set<() => void>();

/** Called once by the meeting module (from its own entry point, before or after a board opens). Returns the undo. */
export function registerBoardMeeting(module: BoardMeetingModule): () => void {
  registered = module;
  for (const listener of [...listeners]) listener();
  return () => {
    if (registered !== module) return;
    registered = null;
    for (const listener of [...listeners]) listener();
  };
}

export const boardMeeting = (): BoardMeetingModule | null => registered;

export function subscribeBoardMeeting(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Emotes from the board (help.figma.com "Stamps, emotes, and high-fives": "Hold shift and click anywhere on the board to release a
// burst of emotes") ──

/** A stamp's emote, by the meeting's ids (heart, like, dislike, fire…); a stamp without one bursts a heart. */
export type BoardEmoteHandler = (page: {x: number; y: number}, emote: string) => boolean;
let emoteHandler: BoardEmoteHandler | null = null;

/** Set by the meeting module while a board's meeting runs; returns the undo. */
export function registerBoardEmote(handler: BoardEmoteHandler): () => void {
  emoteHandler = handler;
  return () => {
    if (emoteHandler === handler) emoteHandler = null;
  };
}

/** Bursts an emote at a page point; false while no meeting runs (offline, before co-editing loads). */
export const boardEmote = (page: {x: number; y: number}, emote: string): boolean => emoteHandler?.(page, emote) ?? false;
