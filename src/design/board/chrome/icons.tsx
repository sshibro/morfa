import {memo, type ComponentType, type ReactNode, type SVGProps} from 'react';

// The board's own icons (docs/board.md §Look): its toolbar is larger and friendlier than the design toolbar, so these are drawn on
// a 24-unit grid with 1.75 px strokes in currentColor. Names start with Bd so they never meet src/design/ui/icons.tsx.

export type BdIconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {size?: number};
export type BdIcon = ComponentType<BdIconProps>;

function glyph(name: string, body: ReactNode): BdIcon {
  const Icon = memo(function Icon({size = 24, ...rest}: BdIconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true" focusable="false" {...rest}>
        {body}
      </svg>
    );
  });
  Icon.displayName = name;
  return Icon;
}

const FILLED = {fill: 'currentColor', stroke: 'none'} as const;

export const BdMove = glyph('BdMove', <path d="M6 4.5 18.5 10.4 12.6 12.6 10.2 18.6Z" />);
export const BdHand = glyph('BdHand', <path d="M9.5 11V5a1.5 1.5 0 0 1 3 0v5.5M12.5 10V4.25a1.5 1.5 0 0 1 3 0V11M15.5 10.5V6.5a1.5 1.5 0 0 1 3 0v7.25c0 3.6-2.7 6-6.25 6-2.15 0-3.5-.8-4.75-2.3L4.1 13.6a1.45 1.45 0 0 1 2.2-1.9L9.5 15V11" />);
export const BdText = glyph('BdText', <path d="M5.5 7V5h13v2M12 5v14M9.5 19h5" />);
export const BdSection = glyph('BdSection', <><rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" /><rect x="6.5" y="7.5" width="6" height="2.75" rx="1" {...FILLED} /></>);
export const BdTable = glyph('BdTable', <><rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" /><path d="M3.75 9.75h16.5M3.75 14.5h16.5M9.25 4.75v14.5M14.75 4.75v14.5" /></>);
export const BdStamp = glyph('BdStamp', <><path d="M9.75 4.75h4.5l-.75 5.5h3.25a2.5 2.5 0 0 1 2.5 2.5v1.5H4.75v-1.5a2.5 2.5 0 0 1 2.5-2.5h3.25Z" /><path d="M5.75 17.25h12.5v2H5.75Z" /></>);
export const BdComment = glyph('BdComment', <path d="M12 19.25a7.25 7.25 0 1 0-6.4-3.85L4.75 19.25l3.9-.85A7.2 7.2 0 0 0 12 19.25Z" />);
export const BdActions = glyph('BdActions', <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><circle cx="17.25" cy="7.25" r="3.25" /><path d="M7.25 13.5 10.5 19.5H4Z" /><path d="M17.25 14v6M14.25 17h6" /></>);
export const BdPlus = glyph('BdPlus', <path d="M12 5.5v13M5.5 12h13" />);
export const BdMindMap = glyph('BdMindMap', <><rect x="3.75" y="10" width="5.5" height="4" rx="2" /><rect x="14.75" y="4.75" width="5.5" height="4" rx="2" /><rect x="14.75" y="15.25" width="5.5" height="4" rx="2" /><path d="M9.25 12c2.75 0 2.5-5.25 5.5-5.25M9.25 12c2.75 0 2.5 5.25 5.5 5.25" /></>);
export const BdAlignObjects = glyph('BdAlignObjects', <><path d="M4.75 4.75v14.5" /><rect x="7.75" y="6.25" width="11.5" height="4" rx="1.25" /><rect x="7.75" y="13.75" width="7" height="4" rx="1.25" /></>);
export const BdPicture = glyph('BdPicture', <><rect x="3.75" y="5.75" width="16.5" height="12.5" rx="2.5" /><circle cx="9" cy="10" r="1.5" /><path d="m5 17 4.5-4.25 3 2.75 2.75-2.5L19.5 17" /></>);
export const BdMergeRight = glyph('BdMergeRight', <><rect x="3.75" y="6.75" width="16.5" height="10.5" rx="2" /><path d="M9 12h6M13 10l2 2-2 2" /></>);
export const BdMergeDown = glyph('BdMergeDown', <><rect x="6.75" y="3.75" width="10.5" height="16.5" rx="2" /><path d="M12 9v6M10 13l2 2 2-2" /></>);
export const BdUnmerge = glyph('BdUnmerge', <><rect x="3.75" y="6.75" width="16.5" height="10.5" rx="2" /><path d="M12 6.75v3M12 14.25v3M9.5 12h-3M14.5 12h3" /></>);
export const BdEye = glyph('BdEye', <><path d="M3.75 12s3-5.75 8.25-5.75S20.25 12 20.25 12s-3 5.75-8.25 5.75S3.75 12 3.75 12Z" /><circle cx="12" cy="12" r="2.5" /></>);
export const BdEyeOff = glyph('BdEyeOff', <><path d="M9.6 6.6A8.5 8.5 0 0 1 12 6.25c5.25 0 8.25 5.75 8.25 5.75a14.6 14.6 0 0 1-2.4 3.05M6.2 8.2A14.4 14.4 0 0 0 3.75 12s3 5.75 8.25 5.75a8.3 8.3 0 0 0 3.6-.8" /><path d="M4.75 4.75l14.5 14.5" /></>);
export const BdClose = glyph('BdClose', <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />);
export const BdMinus = glyph('BdMinus', <path d="M6 12h12" />);
export const BdHelp = glyph('BdHelp', <><circle cx="12" cy="12" r="8.25" /><path d="M9.75 9.75a2.25 2.25 0 1 1 3.4 1.95c-.7.4-1.15.95-1.15 1.8v.5" /><circle cx="12" cy="16.75" r="0.6" {...FILLED} /></>);
export const BdChevronDown = glyph('BdChevronDown', <path d="m7.5 10 4.5 4.5 4.5-4.5" />);
export const BdSidebar = glyph('BdSidebar', <><rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" /><path d="M14.75 4.75v14.5" /></>);
export const BdShare = glyph('BdShare', <path d="M12 4.75v10M8.25 8.5 12 4.75l3.75 3.75M5.75 13.5v4a1.75 1.75 0 0 0 1.75 1.75h9a1.75 1.75 0 0 0 1.75-1.75v-4" />);
export const BdPages = glyph('BdPages', <><rect x="5.75" y="3.75" width="11" height="13.5" rx="2" /><path d="M8.75 20.25h8a2 2 0 0 0 2-2V8.75" /></>);
export const BdLock = glyph('BdLock', <><rect x="5.75" y="10.75" width="12.5" height="8.5" rx="2" /><path d="M8.75 10.75v-2.5a3.25 3.25 0 0 1 6.5 0v2.5" /></>);
export const BdUnlock = glyph('BdUnlock', <><rect x="5.75" y="10.75" width="12.5" height="8.5" rx="2" /><path d="M8.75 10.75v-2.5a3.25 3.25 0 0 1 6.2-1.35" /></>);
export const BdMore = glyph('BdMore', <><circle cx="6.5" cy="12" r="1.25" {...FILLED} /><circle cx="12" cy="12" r="1.25" {...FILLED} /><circle cx="17.5" cy="12" r="1.25" {...FILLED} /></>);
export const BdSearch = glyph('BdSearch', <><circle cx="10.75" cy="10.75" r="5.5" /><path d="m15 15 4.25 4.25" /></>);
export const BdPalette = glyph('BdPalette', <><path d="M12 4.25a7.75 7.75 0 1 0 0 15.5c1.1 0 1.75-.7 1.75-1.6 0-.95-.75-1.4-.75-2.3 0-.95.8-1.6 1.8-1.6h1.7a3.25 3.25 0 0 0 3.25-3.25C19.75 7.35 16.3 4.25 12 4.25Z" /><circle cx="8.25" cy="11" r="1.1" {...FILLED} /><circle cx="10.75" cy="7.75" r="1.1" {...FILLED} /><circle cx="14.75" cy="8.25" r="1.1" {...FILLED} /></>);
export const BdSparkle = glyph('BdSparkle', <path d="M12 4.5c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6ZM18.25 15.5c.25 1.4.85 2 2.25 2.25-1.4.25-2 .85-2.25 2.25-.25-1.4-.85-2-2.25-2.25 1.4-.25 2-.85 2.25-2.25Z" />);
export const BdAuthor = glyph('BdAuthor', <><circle cx="12" cy="9" r="3.25" /><path d="M6 19c.75-3 3.1-4.75 6-4.75S17.25 16 18 19" /></>);
export const BdWide = glyph('BdWide', <rect x="3.75" y="7.25" width="16.5" height="9.5" rx="1.5" />);
export const BdSquare = glyph('BdSquare', <rect x="6.25" y="6.25" width="11.5" height="11.5" rx="1.5" />);

// Connector lines and arrowheads.
export const BdLineStraight = glyph('BdLineStraight', <path d="M5 19 19 5" />);
export const BdLineElbow = glyph('BdLineElbow', <path d="M5 18.5h5.5a2 2 0 0 0 2-2v-9a2 2 0 0 1 2-2H19" />);
export const BdLineCurved = glyph('BdLineCurved', <path d="M5 18.5C13 18.5 11 5.5 19 5.5" />);
export const BdDashed = glyph('BdDashed', <path d="M4.5 12h3M10.5 12h3M16.5 12h3" />);

// The marker tray.
export const BdEraser = glyph('BdEraser', <><path d="M8.5 19.25h11M13.6 5.6l4.8 4.8a1.5 1.5 0 0 1 0 2.1l-6.5 6.75H8.25L5.6 16.6a1.5 1.5 0 0 1 0-2.1l5.9-8.9a1.5 1.5 0 0 1 2.1 0Z" /><path d="m9.25 11 5 5" /></>);
export const BdThin = glyph('BdThin', <path d="M5 15c3-5 5.5 3 8-1.5S17 9 19 9" strokeWidth={1.5} />);
export const BdThick = glyph('BdThick', <path d="M5 15c3-5 5.5 3 8-1.5S17 9 19 9" strokeWidth={4} />);

// Text sizes, the handwriting face.
export const BdHandwriting = glyph('BdHandwriting', <path d="M4.75 16.5c1.6-4.4 3.3-9.1 4.6-9.1 1.6 0-1.9 9 .4 9 1.4 0 2.25-3.4 3.4-3.4 1.2 0 .2 3.2 1.6 3.2 1.25 0 2.5-1.6 4.5-1.6" />);
export const BdBold = glyph('BdBold', <path d="M7.5 5.25h5.25a3.25 3.25 0 0 1 0 6.5H7.5ZM7.5 11.75h6a3.5 3.5 0 0 1 0 7h-6Z" strokeWidth={2} />);
export const BdAlignLeft = glyph('BdAlignLeft', <path d="M5 7h14M5 12h9M5 17h12" />);
export const BdAlignCenter = glyph('BdAlignCenter', <path d="M5 7h14M7.5 12h9M6 17h12" />);
export const BdAlignRight = glyph('BdAlignRight', <path d="M5 7h14M10 12h9M7 17h12" />);
export const BdFit = glyph('BdFit', <><path d="M4.75 9V5.75a1 1 0 0 1 1-1H9M15 4.75h3.25a1 1 0 0 1 1 1V9M19.25 15v3.25a1 1 0 0 1-1 1H15M9 19.25H5.75a1 1 0 0 1-1-1V15" /><rect x="8.5" y="8.5" width="7" height="7" rx="1" /></>);
export const BdRowAdd = glyph('BdRowAdd', <><rect x="3.75" y="4.75" width="16.5" height="9" rx="2" /><path d="M12 16.5v4M10 18.5h4" /></>);
export const BdColumnAdd = glyph('BdColumnAdd', <><rect x="3.75" y="4.75" width="9" height="14.5" rx="2" /><path d="M17 12h4M19 10v4" /></>);
export const BdSort = glyph('BdSort', <path d="M7 5v14M4 16l3 3 3-3M13 7h7M13 12h5M13 17h3" />);
export const BdTidy = glyph('BdTidy', <><rect x="4.25" y="4.25" width="6.5" height="6.5" rx="1.25" /><rect x="13.25" y="4.25" width="6.5" height="6.5" rx="1.25" /><rect x="4.25" y="13.25" width="6.5" height="6.5" rx="1.25" /><rect x="13.25" y="13.25" width="6.5" height="6.5" rx="1.25" /></>);
export const BdTrash = glyph('BdTrash', <path d="M5 7h14M10 7V5.25h4V7M7 7l.75 12.25h8.5L17 7M10.25 10.5v5.5M13.75 10.5v5.5" />);
export const BdDuplicate = glyph('BdDuplicate', <><rect x="8.25" y="8.25" width="11" height="11" rx="2" /><path d="M15.75 8.25v-2.5a1.5 1.5 0 0 0-1.5-1.5h-8a1.5 1.5 0 0 0-1.5 1.5v8a1.5 1.5 0 0 0 1.5 1.5h2.5" /></>);
export const BdStrike = glyph('BdStrike', <path d="M5 12h14M15.75 7.75c-.5-1.6-2-2.5-3.9-2.5-2.2 0-3.85 1.2-3.85 2.95 0 1.4.95 2.25 2.6 2.8M8 16c.45 1.75 2 2.75 4.1 2.75 2.35 0 4-1.25 4-3.05 0-.8-.3-1.45-.9-1.95" />);
export const BdList = glyph('BdList', <><path d="M9.5 7h10M9.5 12h10M9.5 17h10" /><circle cx="5.25" cy="7" r="1.1" {...FILLED} /><circle cx="5.25" cy="12" r="1.1" {...FILLED} /><circle cx="5.25" cy="17" r="1.1" {...FILLED} /></>);
export const BdLink = glyph('BdLink', <path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />);
