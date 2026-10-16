import '../styles/meeting.css';
import type {NodeId} from '../../../shared/design/types';
import type {DesignStore} from '../engine/store';
import type {CanvasController} from '../editor/CanvasView';
import type {LiveSession} from '../realtime/live-session';
import {createMeetingController, type MeetingController} from './controller';
import type {MeetingTargets} from './targets';
import {MeetingCanvasLayer} from './ui/CanvasLayer';
import {MeetingHeader} from './ui/Header';

// "Meeting" (docs/board-meeting.md): the shared timer with music, voting sessions, emotes, cursor chat, high fives and "Get
// attention", built on the co-editing stream. Loaded with `import()` once co-editing runs (src/design/realtime), so none of it is in
// an editor's first load. The design editor mounts `Header` in the right panel's header and `CanvasLayer` over the canvas; a board
// does the same in its own chrome, passing its `targets` (stickies and shapes instead of frames).

export type {MeetingTargets} from './targets';
export {DESIGN_TARGETS} from './targets';
export type {MeetingController} from './controller';

export type Meeting = {
  controller: MeetingController;
  /** The timer pill and "Reactions and meeting", for a header (the design editor's right panel; a board's top-right pill, which passes
   *  `timer="always"` to keep FigJam's timer button there at rest). */
  Header: (props: {timer?: 'always' | 'active'}) => React.JSX.Element;
  /** Over the canvas: bursts, chat bubbles, vote badges, the voting bar, results, spotlight. */
  CanvasLayer: () => React.JSX.Element;
  stop(): void;
};

export function startMeeting(options: {
  fileId: string;
  live: LiveSession;
  store: DesignStore;
  /** The element the canvas is in (pointer events, the others' cursors). */
  host: () => HTMLElement | null;
  canvas: () => CanvasController | null;
  toast: (message: string, kind?: 'error') => void;
  /** Shows these objects (a results row was clicked). */
  reveal?: (ids: NodeId[]) => void;
  /** What a vote counts; frames of a design file when absent. */
  targets?: MeetingTargets;
}): Meeting {
  const controller = createMeetingController(options);
  return {
    controller,
    Header: props => <MeetingHeader controller={controller} timer={props.timer} />,
    CanvasLayer: () => <MeetingCanvasLayer controller={controller} />,
    stop: () => controller.dispose(),
  };
}
