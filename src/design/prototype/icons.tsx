import {memo, type ReactNode} from 'react';
import type {IconComponent, IconProps} from '../ui/icons';

// Icons of the "Prototype" tab and the player, drawn like src/design/ui/icons.tsx (16 px grid,
// 1.5 px strokes, currentColor). Kept with the feature and named `IconProto…` so they never clash
// with the shared set; glyphs the shared set has (restore, warning, link) are taken from there.

const FILLED = {fill: 'currentColor', stroke: 'none'} as const;

function glyph(name: string, body: ReactNode): IconComponent {
  const Icon = memo(function Icon({size = 16, ...rest}: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true" focusable="false" {...rest}>
        {body}
      </svg>
    );
  });
  Icon.displayName = name;
  return Icon;
}

/** A flow's starting point: a pennant with a play mark. */
export const IconProtoFlow = glyph('IconProtoFlow', <><path d="M3.75 13.75V2.75" /><path d="M3.75 3h7.9l-1.9 2.75 1.9 2.75h-7.9" /></>);
/** An interaction: a pointer tapping. */
export const IconProtoInteraction = glyph('IconProtoInteraction', <><path d="M6.25 8.25V3.5a1.25 1.25 0 0 1 2.5 0v3.75l2.6.55a1.5 1.5 0 0 1 1.15 1.7l-.6 3.25a1.5 1.5 0 0 1-1.5 1.25H8.1a1.5 1.5 0 0 1-1.2-.6L4.4 10.1a1.15 1.15 0 0 1 1.85-1.35" /></>);
/** A device turned on its side. */
export const IconProtoRotate = glyph('IconProtoRotate', <><rect x="5.75" y="2.25" width="7" height="11.5" rx="1.5" /><path d="M2.5 9.75a4.25 4.25 0 0 0 2 3.5M2.25 12.25l.25 1.25 1.25-.25" /></>);
export const IconProtoArrowLeft = glyph('IconProtoArrowLeft', <path d="M13 8H3M7 4 3 8l4 4" />);
export const IconProtoArrowRight = glyph('IconProtoArrowRight', <path d="M3 8h10M9 4l4 4-4 4" />);
export const IconProtoArrowUp = glyph('IconProtoArrowUp', <path d="M8 13V3M4 7l4-4 4 4" />);
export const IconProtoArrowDown = glyph('IconProtoArrowDown', <path d="M8 3v10M4 9l4 4 4-4" />);

/** Action glyphs of the interaction details: an overlay over a screen, a swap, scroll to a layer, change a variant, close. */
export const IconProtoOverlay = glyph('IconProtoOverlay', <><path d="M2.75 10.25v-6.5a1 1 0 0 1 1-1h6.5" /><rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1" /></>);
export const IconProtoSwap = glyph('IconProtoSwap', <path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" />);
export const IconProtoScrollTo = glyph('IconProtoScrollTo', <path d="M8 2.75v8M4.75 7.75 8 11l3.25-3.25M3.25 13.25h9.5" />);
export const IconProtoChangeTo = glyph('IconProtoChangeTo', <path d="m8 2.5 5.5 5.5L8 13.5 2.5 8Z" />);
export const IconProtoCloseOverlay = glyph('IconProtoCloseOverlay', <><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.25" /><path d="m6 6 4 4M10 6l-4 4" /></>);
/** "Show hotspots": a dashed box with a pointer. */
export const IconProtoHotspots = glyph('IconProtoHotspots', <><path d="M2.75 6V3.75a1 1 0 0 1 1-1H6M10 2.75h2.25a1 1 0 0 1 1 1V6M2.75 10v2.25a1 1 0 0 0 1 1H6" /><path d="m8.5 8.5 5 1.75-2.1.9-.9 2.1Z" {...FILLED} /></>);
/** "Zoom to fit" / "100%". */
export const IconProtoFit = glyph('IconProtoFit', <path d="M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10" />);
export const IconProtoActualSize = glyph('IconProtoActualSize', <><rect x="2.75" y="3.75" width="10.5" height="8.5" rx="1.25" /><path d="M6 6.5v3M9 6.5v3" /></>);
/** The player full screen: arrows out to two corners, and back in. */
export const IconProtoFullscreen = glyph('IconProtoFullscreen', <path d="M9.75 2.75h3.5v3.5M13.25 2.75 9 7M6.25 13.25h-3.5v-3.5M2.75 13.25 7 9" />);
export const IconProtoExitFullscreen = glyph('IconProtoExitFullscreen', <path d="M9 3.25V7h3.75M9 7l4.25-4.25M7 12.75V9H3.25M7 9l-4.25 4.25" />);

/** "Select matching interactions": two pointers, one the copy of the other. */
export const IconProtoMatching = glyph('IconProtoMatching', <><path d="M3 2.75 7.5 7.5l-2 .35-.9 1.9Z" /><path d="M8.5 7.75 13 12.5l-2 .35-.9 1.9Z" /></>);
