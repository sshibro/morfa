import {memo, type SVGProps} from 'react';

// "Meeting"'s own glyphs, drawn like src/design/ui/icons.tsx (16-unit grid, 1.5 px strokes, currentColor) but kept here, in the meeting's
// lazy chunk, so the editor's first load does not carry them.

type Props = Omit<SVGProps<SVGSVGElement>, 'ref'> & {size?: number};
const glyph = (name: string, body: React.ReactNode) => {
  const Icon = memo(function Icon({size = 16, ...rest}: Props) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
        {body}
      </svg>
    );
  });
  Icon.displayName = name;
  return Icon;
};
const FILLED = {fill: 'currentColor', stroke: 'none'} as const;

/** The timer: a stopwatch. */
export const IconTimer = glyph('IconTimer', <><circle cx="8" cy="9" r="5" /><path d="M8 6.5V9l1.5 1M6.5 2.25h3M8 2.25V4M12.25 4.25l-.9.9" /></>);
export const IconPause = glyph('IconPause', <><rect x="4.5" y="3.5" width="2.25" height="9" rx="0.75" {...FILLED} /><rect x="9.25" y="3.5" width="2.25" height="9" rx="0.75" {...FILLED} /></>);
export const IconResume = glyph('IconResume', <path d="M5 3.4v9.2a.6.6 0 0 0 .9.5l7.3-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5Z" {...FILLED} />);
export const IconStop = glyph('IconStop', <rect x="4" y="4" width="8" height="8" rx="1.25" {...FILLED} />);
export const IconMusic = glyph('IconMusic', <><path d="M6 11.5V3.75l7-1.5v7.5" /><circle cx="4.5" cy="11.5" r="1.75" /><circle cx="11.5" cy="9.75" r="1.75" /></>);
export const IconVolume = glyph('IconVolume', <><path d="M2.75 6.25v3.5h2.5l3.5 3V3.25l-3.5 3Z" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.75 3.75a6 6 0 0 1 0 8.5" /></>);
export const IconVolumeOff = glyph('IconVolumeOff', <><path d="M2.75 6.25v3.5h2.5l3.5 3V3.25l-3.5 3Z" /><path d="m11 6 3 3M14 6l-3 3" /></>);
/** Reactions: a smiling face. */
export const IconSmile = glyph('IconSmile', <><circle cx="8" cy="8" r="5.75" /><path d="M5.75 9.5a2.75 2.75 0 0 0 4.5 0" /><circle cx="6" cy="6.75" r="0.75" {...FILLED} /><circle cx="10" cy="6.75" r="0.75" {...FILLED} /></>);
/** A vote: a ballot with a tick going into a box. */
export const IconVote = glyph('IconVote', <><path d="M5 8.25V2.75h6v5.5" /><path d="m6.75 5.5 1 1 1.75-2" /><path d="M2.75 8.25h10.5v4.5a.75.75 0 0 1-.75.75h-9a.75.75 0 0 1-.75-.75Z" /></>);
/** "Get attention": a spotlight's beam. */
export const IconSpotlight = glyph('IconSpotlight', <><path d="M3 4.5 6.5 3l1 2.5L4 7Z" /><path d="m6.75 4.25 6 4.5M4.75 6.5l5 5.25" /><path d="M10 13.25c1.75 0 3.25-1 3.25-2.75" /></>);
/** Cursor chat: a speech bubble with an arrow pointer. */
export const IconChat = glyph('IconChat', <><path d="M3 3.75h10a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-.75.75H8l-3 2.25v-2.25H3a.75.75 0 0 1-.75-.75v-6A.75.75 0 0 1 3 3.75Z" /><path d="M5.5 7.5h5" /></>);
export const IconMinus = glyph('IconMinus', <path d="M4 8h8" />);
export const IconPlus = glyph('IconPlus', <path d="M8 4v8M4 8h8" />);
export const IconClose = glyph('IconClose', <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />);
