import type {NodeId, Vec} from '../../../shared/design/types';
import type {DesignStore} from '../engine/store';
import type {Badge} from './overlay';
import {connectMeetingTools, EMOTE_TOOL, registerMeetingTools, VOTE_TOOL} from './tools';

// Where "Meeting"'s two modes live in an editor (docs/board-meeting.md): voting (a click gives an object a vote) and reactions (a press
// bursts the chosen emote). A design file makes them tools of its canvas (tools.ts: the toolbar gives way to their bars, Escape leaves
// them); a board offers clicks to the meeting first (`interceptClicks` of src/design/board/meeting.ts) and draws the vote badges itself
// (`setBadges`). The controller speaks only to this.

export type MeetingMode = 'vote' | 'emote';

/** What the controller lets a surface call. */
export type SurfaceHooks = {
  /** The votable object under a page point, or null. */
  targetAt(page: Vec): NodeId | null;
  /** The object's box on the page (the hover outline), or null. */
  box(id: NodeId): {x: number; y: number; width: number; height: number} | null;
  /** One more of this person's votes for it (says so when none are left). */
  vote(id: NodeId): void;
  /** One of this person's votes back from it. */
  unvote(id: NodeId): void;
  /** The reactions mode: a press at `page` starts bursts (or a wave), moves keep them under the pointer, the release ends them. */
  press(page: Vec): void;
  move(page: Vec): void;
  release(): void;
  /** The chosen emote as a cursor. */
  cursor(): string;
  /** The hover outline's colour. */
  accent(): string;
};

export type MeetingSurface = {
  kind: 'design' | 'board';
  mode(): MeetingMode | null;
  /** Enters a mode, or leaves the meeting's mode (null) for the editor's own. */
  setMode(mode: MeetingMode | null): void;
  /** No tool or mode of the editor's own is busy: a vote that starts may take this editor into voting. */
  idle(): boolean;
  subscribe(listener: () => void): () => void;
  /** Draws the vote badges itself (a board); absent: the meeting's overlay draws them as buttons (a design file). */
  badges?(badges: readonly Badge[]): void;
  /** How a vote is taken back here, for the voting bar. */
  takeBack: string;
  dispose(): void;
};

export type SurfaceFactory = (hooks: SurfaceHooks) => MeetingSurface;

/** A design file: the two modes are canvas tools (src/design/meeting/tools.ts). */
export function designSurface(store: DesignStore): SurfaceFactory {
  return hooks => {
    registerMeetingTools();
    const off = connectMeetingTools(store, {
      vote: {targetAt: hooks.targetAt, box: hooks.box, vote: hooks.vote, accent: hooks.accent},
      emote: {cursor: hooks.cursor, press: hooks.press, move: hooks.move, release: hooks.release},
    });
    const mode = (): MeetingMode | null => {
      const tool = store.getState().tool;
      return tool === VOTE_TOOL ? 'vote' : tool === EMOTE_TOOL ? 'emote' : null;
    };
    return {
      kind: 'design',
      mode,
      setMode(next) {
        if (next === 'emote' && mode() === 'emote') store.setTool('move'); // the tool takes the new emote's cursor as it starts again
        if (next) store.setTool(next === 'vote' ? VOTE_TOOL : EMOTE_TOOL);
        else if (mode()) store.setTool('move');
      },
      idle: () => store.getState().tool === 'move',
      subscribe: listener => store.subscribe(listener, {slice: 'tool'}),
      takeBack: 'click your dot to remove a vote',
      dispose: off,
    };
  };
}
