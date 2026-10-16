import {worldBox} from '../../../shared/design/geometry';
import type {DesignDocument, NodeId} from '../../../shared/design/types';
import {registerBoardEmote, type BoardBadge, type BoardClick, type BoardMeetingProps, type BoardObjectsApi} from '../board/meeting';
import {isMeetingEmote} from '../../../shared/design/meeting';
import type {DesignStore} from '../engine/store';
import {isTypingTarget} from '../engine/keyboard';
import type {LiveSession} from '../realtime/live-session';
import {isMacPlatform} from '../ui/shortcuts';
import {createMeetingController, type MeetingController} from './controller';
import {votesWord, type Badge} from './overlay';
import type {MeetingTransport} from './session';
import type {MeetingMode, MeetingSurface, SurfaceFactory} from './surface';
import type {MeetingTargets} from './targets';
import {voteTakesBack} from './touch-take-back';

// "Meeting" on a board, without React (docs/board-meeting.md "On the board", docs/board.md §Meeting slot): what a vote counts there, the
// board's surface for the voting and reactions modes, the badges it draws, and the one controller a board's two places share. A board
// votes for its objects through the board-objects API: `votableObjects` and `objectAtPage` say what a click votes for, `interceptClicks`
// takes the clicks of the two modes (the board's own tools never see them), `setBadges('voting')` draws this person's votes and then the
// results. ⌥-click takes a vote back. The places themselves are in board.tsx.

/** What a vote counts on a board: the votable object under the point (stickies, shapes, stamps, stickers, texts, tables). */
export function boardTargets(board: () => BoardObjectsApi): MeetingTargets {
  return {
    at(_doc, _pageId, point) {
      const api = board();
      const id = api.objectAtPage(point);
      return id && api.votableObjects().includes(id) ? id : null;
    },
    box(doc, id) {
      const box = board().objectBounds(id, 'page');
      if (box) return box;
      const node = doc.nodes[id];
      return node && node.type !== 'PAGE' ? worldBox(doc, id) : null;
    },
    label: boardLabel,
    noun: 'stickies and shapes',
  };
}

/** A results row's name on a board: the words on the object (a sticky's text), else its name. */
export function boardLabel(doc: DesignDocument, id: NodeId): string {
  const node = doc.nodes[id];
  if (!node) return 'Deleted object';
  const label = (textOf(doc, id, 0) || node.name || '').replace(/\s+/g, ' ').trim();
  return label.length > 60 ? label.slice(0, 59) + '…' : label || 'Untitled';
}
function textOf(doc: DesignDocument, id: NodeId, depth: number): string {
  const node = doc.nodes[id];
  if (!node || depth > 4) return '';
  if (node.type === 'TEXT') return node.text?.characters ?? '';
  for (const child of node.children ?? []) {
    const text = textOf(doc, child, depth + 1);
    if (text.trim()) return text;
  }
  return '';
}

/** The vote badges as the board draws them: this person's votes while it runs ("mine"), then everyone's (the winners in the accent). */
export function boardBadges(badges: readonly Badge[]): BoardBadge[] {
  return badges.map(badge =>
    badge.kind === 'mine'
      ? {id: badge.nodeId, count: badge.count, tone: 'mine' as const, label: `Your votes: ${badge.count}`}
      : {id: badge.nodeId, count: badge.count, tone: badge.top ? ('accent' as const) : ('neutral' as const), label: `${badge.count} ${votesWord(badge.count)}`},
  );
}

export type SurfaceEvents = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * The two modes on a board: while one is on, the board offers its canvas clicks here first. Voting: a click on a votable object gives it
 * a vote, ⌥-click takes one back, a click elsewhere stays the board's (select, pan). Reactions: a press bursts the emote (or waves) until
 * the button comes up. Escape leaves either. Entering a mode takes the board's "Move", so a click on empty canvas never draws.
 */
export function boardSurface(board: () => BoardObjectsApi, store: DesignStore, events: SurfaceEvents = window): SurfaceFactory {
  return hooks => {
    let mode: MeetingMode | null = null;
    let offClicks: (() => void) | null = null;
    let endPress: (() => void) | null = null;
    const listeners = new Set<() => void>();
    const vote = (click: BoardClick) => {
      const id = hooks.targetAt(click.page);
      if (!id) return false;
      if (click.altKey || voteTakesBack(store)) hooks.unvote(id);
      else hooks.vote(id);
      return true;
    };
    const react = (click: BoardClick) => {
      endPress?.();
      hooks.press(click.page);
      const up = () => endPress?.();
      events.addEventListener('pointerup', up, true);
      events.addEventListener('pointercancel', up, true);
      events.addEventListener('blur', up);
      endPress = () => {
        endPress = null;
        events.removeEventListener('pointerup', up, true);
        events.removeEventListener('pointercancel', up, true);
        events.removeEventListener('blur', up);
        hooks.release();
      };
      return true;
    };
    const escape = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Escape' || key.defaultPrevented || isTypingTarget(key.target)) return;
      surface.setMode(null);
    };
    const surface: MeetingSurface = {
      kind: 'board',
      mode: () => mode,
      setMode(next) {
        if (next === mode) return;
        offClicks?.();
        offClicks = null;
        endPress?.();
        if (mode) events.removeEventListener('keydown', escape, true);
        mode = next;
        if (next) {
          if (store.getState().tool !== 'move') store.setTool('move');
          offClicks = board().interceptClicks(next === 'vote' ? vote : react);
          // Capture: before the canvas's own Escape (which clears the selection and marks the key used); after the board's (its sheets).
          events.addEventListener('keydown', escape, true);
        }
        for (const listener of [...listeners]) listener();
      },
      idle: () => mode === null && store.getState().tool === 'move' && !store.getState().editing,
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      badges: badges => board().setBadges('voting', boardBadges(badges)),
      takeBack: `${isMacPlatform() ? '⌥' : 'Alt'} + click an object to remove a vote`,
      dispose() {
        surface.setMode(null);
        board().setBadges('voting', []);
        listeners.clear();
      },
    };
    return surface;
  };
}

/** The element the board's canvas is in: the nearest ancestor of the meeting's layer that holds a canvas (its pointer moves and the
 *  others' cursors are there). */
export function canvasHostOf(layer: HTMLElement | null): HTMLElement | null {
  for (let node = layer?.parentElement ?? null; node; node = node.parentElement) if (node.querySelector('canvas')) return node;
  return null;
}

// ── One controller per open board, shared by its two places ────────────────────────────────────

export type BoardMeetingShared = {controller: MeetingController; users: number; layer: HTMLElement | null; props: BoardMeetingProps; offEmote?: () => void};
const shared = new WeakMap<LiveSession, BoardMeetingShared>();

/** The board's controller for this live session (made on first use; `transport` and `events` for tests). */
export function acquireBoardMeeting(props: BoardMeetingProps, live: LiveSession, test: {transport?: MeetingTransport; events?: SurfaceEvents} = {}): BoardMeetingShared {
  let entry = shared.get(live);
  if (!entry) {
    const made: BoardMeetingShared = {controller: null as unknown as MeetingController, users: 0, layer: null, props};
    const board = () => made.props.board;
    made.controller = createMeetingController({
      fileId: props.services.fileId,
      live,
      store: props.services.store,
      host: () => canvasHostOf(made.layer),
      canvas: () => made.props.services.canvas?.() ?? null,
      toast: (message, kind) => made.props.services.toast(message, kind),
      reveal: ids => made.props.services.revealNodes(ids),
      targets: boardTargets(board),
      surface: boardSurface(board, props.services.store, test.events),
      transport: test.transport,
    });
    shared.set(live, made);
    // ⇧-click with the board's stamp tool bursts the stamp's emote through this meeting (board/meeting.ts).
    made.offEmote = registerBoardEmote((page, emote) => {
      made.controller.emote.burst(page, isMeetingEmote(emote) ? emote : 'heart');
      return true;
    });
    entry = made;
  }
  entry.props = props;
  entry.users++;
  return entry;
}
/** One of the two places is gone; the last one disposes the controller. */
export function releaseBoardMeeting(live: LiveSession, entry: BoardMeetingShared) {
  entry.users--;
  if (entry.users > 0 || shared.get(live) !== entry) return;
  shared.delete(live);
  entry.offEmote?.();
  entry.controller.dispose();
}

