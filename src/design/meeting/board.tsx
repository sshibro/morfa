import '../styles/meeting.css';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {registerBoardMeeting, type BoardMeetingProps} from '../board/meeting';
import {acquireBoardMeeting, releaseBoardMeeting, type BoardMeetingShared} from './board-adapter';
import {MeetingCanvasLayer} from './ui/CanvasLayer';
import {MeetingHeader} from './ui/Header';

// "Meeting" on a board (docs/board-meeting.md "On the board", docs/board.md §Meeting slot). The board loads this module lazily
// (src/design/board/features.ts) and renders what it registers: `Controls` in its top-right pill (the timer, always there as in FigJam,
// and "Reactions and meeting") and `CanvasLayer` over its canvas (bursts, cursor chat, the voting and emote bars, results, spotlight). Both
// share one controller per open board (board-adapter.ts), made once co-editing runs.

/** The shared controller once co-editing runs (null before); the latest props reach it after each render (services, the board API). */
function useBoardMeeting(props: BoardMeetingProps): BoardMeetingShared | null {
  const live = props.realtime?.live ?? null;
  const [entry, setEntry] = useState<BoardMeetingShared | null>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
    if (entry) entry.props = props;
  });
  useEffect(() => {
    if (!live) return;
    const got = acquireBoardMeeting(latest.current, live);
    setEntry(got);
    return () => {
      setEntry(null);
      releaseBoardMeeting(live, got);
    };
  }, [live]);
  return entry;
}

/** In the board's top-right pill: the timer (always shown, FigJam's way) and "Reactions and meeting". */
export function BoardMeetingControls(props: BoardMeetingProps) {
  const entry = useBoardMeeting(props);
  if (!entry) return null;
  return (
    <div className="dz-meet-board">
      <MeetingHeader controller={entry.controller} timer="always" />
    </div>
  );
}

/** Over the board's canvas: everything the meeting draws there. */
export function BoardMeetingCanvasLayer(props: BoardMeetingProps) {
  const entry = useBoardMeeting(props);
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!entry) return;
    entry.layer = holder.current;
    return () => {
      if (entry.layer === holder.current) entry.layer = null;
    };
  }, [entry]);
  return (
    <div className="dz-meet-board" ref={holder}>
      {entry && <MeetingCanvasLayer controller={entry.controller} />}
    </div>
  );
}

registerBoardMeeting({Controls: BoardMeetingControls, CanvasLayer: BoardMeetingCanvasLayer});
