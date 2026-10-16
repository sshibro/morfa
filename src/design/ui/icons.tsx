import {memo, type ComponentType, type ReactNode, type SVGProps} from 'react';
import type {LayoutMode, NodeType} from '../../../shared/design/types';

// The tool's icons: 16 px, 1.5 px strokes, currentColor (states recolour them through CSS), all
// drawn here on a 16-unit grid. None come from lucide-react: an icon module the site editor also
// imports would be split into a chunk shared by both lazy areas and grow the editor's first load
// (scripts/performance/budgets.mjs), and one hand-drawn set keeps a single optical weight.

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {size?: number};
export type IconComponent = ComponentType<IconProps>;

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

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────
export const IconMove = glyph('IconMove', <path d="M3.75 2.75 12.5 6.9 8.4 8.4 6.75 12.6Z" />);
export const IconScale = glyph('IconScale', <><rect x="2.75" y="6.25" width="7" height="7" rx="1" /><path d="M8 8 13.25 2.75M9.5 2.75h3.75V6.5" /></>);
export const IconHand = glyph('IconHand', <path d="M6.5 7.5V3.25a1 1 0 0 1 2 0V7M8.5 7V2.75a1 1 0 0 1 2 0v4.5M10.5 7.25V4.25a1 1 0 0 1 2 0V9.5c0 2.5-1.9 4.25-4.4 4.25-1.5 0-2.45-.55-3.3-1.6L2.55 9.4a1 1 0 0 1 1.5-1.3L6.5 10.25V7.5" />);
export const IconFrame = glyph('IconFrame', <path d="M5.25 2.5v11M10.75 2.5v11M2.5 5.25h11M2.5 10.75h11" />);
export const IconSection = glyph('IconSection', <><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.25" /><rect x="4.75" y="4.75" width="4" height="2" rx="0.5" {...FILLED} /></>);
export const IconSlice = glyph('IconSlice', <path d="M2.75 6V2.75H6M10 13.25h3.25V10M4.5 11.5l7-7" />);
export const IconRectangle = glyph('IconRectangle', <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1" />);
export const IconEllipse = glyph('IconEllipse', <circle cx="8" cy="8" r="5.25" />);
export const IconLine = glyph('IconLine', <path d="M3 13 13 3" />);
export const IconArrow = glyph('IconArrow', <path d="M3 13 12.5 3.5M7 3.25h5.75V9" />);
export const IconPolygon = glyph('IconPolygon', <path d="M8 2.75 13.5 12.75H2.5Z" />);
export const IconStar = glyph('IconStar', <path d="M8 2.7 9.5 6.54 13.61 6.78 10.43 9.39 11.47 13.37 8 11.15 4.53 13.37 5.57 9.39 2.39 6.78 6.5 6.54Z" />);
export const IconImage = glyph('IconImage', <><rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.25" /><path d="m2.5 11.25 3.25-3.25 3.25 3.25 1.5-1.5 2.75 2.75" /><circle cx="10.25" cy="5.75" r="1" /></>);
export const IconPen = glyph('IconPen', <><path d="M8 13.75 3.5 8.25 5.75 2.25h4.5l2.25 6Z" /><path d="M8 13.75V9.6" /><circle cx="8" cy="8.1" r="1.1" {...FILLED} /></>);
const PENCIL = <path d="M10.75 2.5 13.5 5.25 6 12.75l-3.25.5.5-3.25ZM9.25 4l2.75 2.75" />;
export const IconPencil = glyph('IconPencil', PENCIL);
export const IconText = glyph('IconText', <path d="M3.25 4.75V3h9.5v1.75M8 3v10M6 13h4" />);
/** "Text on path": a T standing on a curve. */
export const IconTextPath = glyph('IconTextPath', <path d="M5 4.1V2.75h6V4.1M8 2.75v6.5M6.75 9.25h2.5M2.75 11.25c1.4 1.35 3.15 2 5.25 2s3.85-.65 5.25-2" />);
/** "Lasso": a loop with its trailing rope. */
export const IconLasso = glyph('IconLasso', <path d="M5.4 10.1C3.8 9.45 2.75 8.3 2.75 6.95c0-2.2 2.35-3.95 5.25-3.95s5.25 1.75 5.25 3.95S10.9 10.9 8 10.9c-.9 0-1.75-.15-2.5-.45-.55.6-.75 1.35-.3 2 .4.6.3 1.3-.3 1.8" />);
/** "Annotation": a note with lines, pinned at its corner. */
export const IconAnnotation = glyph('IconAnnotation', <><path d="M5 11.25V4.25c0-.83.67-1.5 1.5-1.5h5.25c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H5Z" /><path d="M7.25 5.75h3.75M7.25 8.25h2.25" /><circle cx="3.6" cy="12.6" r="1" {...FILLED} /></>);
/** "Measurement": a ruler on the slant. */
export const IconMeasure = glyph('IconMeasure', <><path d="M2.4 10.5 10.5 2.4l3.1 3.1-8.1 8.1Z" /><path d="M5.3 7.6l1.3 1.3M7.6 5.3l1.3 1.3" /></>);

// ── Auto layout ──────────────────────────────────────────────────────────────────────────────────
/** Layer icons of auto-layout frames: the rows or columns they stack (as the layers panel of desktop tools draws them). */
export const IconLayoutVertical = glyph('IconLayoutVertical', <><rect x="3.25" y="3.25" width="9.5" height="4" rx="1" /><rect x="3.25" y="8.75" width="9.5" height="4" rx="1" /></>);
export const IconLayoutHorizontal = glyph('IconLayoutHorizontal', <><rect x="3.25" y="3.25" width="4" height="9.5" rx="1" /><rect x="8.75" y="3.25" width="4" height="9.5" rx="1" /></>);
/** A grid auto-layout frame (Figma's grid flow): four cells. */
export const IconLayoutGrid = glyph('IconLayoutGrid', <><rect x="3.25" y="3.25" width="4" height="4" rx="1" /><rect x="8.75" y="3.25" width="4" height="4" rx="1" /><rect x="3.25" y="8.75" width="4" height="4" rx="1" /><rect x="8.75" y="8.75" width="4" height="4" rx="1" /></>);
export const IconLayoutWrap = glyph('IconLayoutWrap', <path d="M2.75 4.5H11a2.25 2.25 0 0 1 0 4.5H4.75M6.75 7l-2 2 2 2" />);
export const IconPaddingHorizontal = glyph('IconPaddingHorizontal', <><path d="M2.75 3v10M13.25 3v10" /><rect x="5.75" y="5.25" width="4.5" height="5.5" rx="0.75" /></>);
export const IconPaddingVertical = glyph('IconPaddingVertical', <><path d="M3 2.75h10M3 13.25h10" /><rect x="5.25" y="5.75" width="5.5" height="4.5" rx="0.75" /></>);
export const IconPaddingSides = glyph('IconPaddingSides', <><rect x="5.5" y="5.5" width="5" height="5" rx="0.75" /><path d="M8 2.75V4M8 12v1.25M2.75 8H4M12 8h1.25" /></>);
export const IconGapHorizontal = glyph('IconGapHorizontal', <><rect x="2.75" y="3.25" width="3.5" height="9.5" rx="0.75" /><rect x="9.75" y="3.25" width="3.5" height="9.5" rx="0.75" /></>);
export const IconGapVertical = glyph('IconGapVertical', <><rect x="3.25" y="2.75" width="9.5" height="3.5" rx="0.75" /><rect x="3.25" y="9.75" width="9.5" height="3.5" rx="0.75" /></>);

// ── Align and distribute ─────────────────────────────────────────────────────────────────────────
export const IconAlignLeft = glyph('IconAlignLeft', <><path d="M2.75 2.5v11" /><rect x="5" y="4" width="8.25" height="3" rx="0.75" {...FILLED} /><rect x="5" y="9" width="5" height="3" rx="0.75" {...FILLED} /></>);
export const IconAlignCenterH = glyph('IconAlignCenterH', <><path d="M8 2.5v11" /><rect x="3.75" y="4" width="8.5" height="3" rx="0.75" {...FILLED} /><rect x="5.25" y="9" width="5.5" height="3" rx="0.75" {...FILLED} /></>);
export const IconAlignRight = glyph('IconAlignRight', <><path d="M13.25 2.5v11" /><rect x="2.75" y="4" width="8.25" height="3" rx="0.75" {...FILLED} /><rect x="6" y="9" width="5" height="3" rx="0.75" {...FILLED} /></>);
export const IconAlignTop = glyph('IconAlignTop', <><path d="M2.5 2.75h11" /><rect x="4" y="5" width="3" height="8.25" rx="0.75" {...FILLED} /><rect x="9" y="5" width="3" height="5" rx="0.75" {...FILLED} /></>);
export const IconAlignCenterV = glyph('IconAlignCenterV', <><path d="M2.5 8h11" /><rect x="4" y="3.75" width="3" height="8.5" rx="0.75" {...FILLED} /><rect x="9" y="5.25" width="3" height="5.5" rx="0.75" {...FILLED} /></>);
export const IconAlignBottom = glyph('IconAlignBottom', <><path d="M2.5 13.25h11" /><rect x="4" y="2.75" width="3" height="8.25" rx="0.75" {...FILLED} /><rect x="9" y="6" width="3" height="5" rx="0.75" {...FILLED} /></>);
export const IconDistributeH = glyph('IconDistributeH', <><path d="M2.75 2.5v11M13.25 2.5v11" /><rect x="6.5" y="4" width="3" height="8" rx="0.75" {...FILLED} /></>);
export const IconDistributeV = glyph('IconDistributeV', <><path d="M2.5 2.75h11M2.5 13.25h11" /><rect x="4" y="6.5" width="8" height="3" rx="0.75" {...FILLED} /></>);

// ── Constraints, effects, export ─────────────────────────────────────────────────────────────────
export const IconConstraints = glyph('IconConstraints', <><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5" /><rect x="6.5" y="6.5" width="3" height="3" rx="0.5" /><path d="M8 5.25v1.25M5.25 8H6.5" /></>);
/** A square casting a shadow: shadows and blurs. */
export const IconEffects = glyph('IconEffects', <><rect x="2.75" y="2.75" width="8.5" height="8.5" rx="1.5" /><path d="M13.25 5.75v6a1.5 1.5 0 0 1-1.5 1.5h-6" opacity="0.55" /></>);
export const IconExport = glyph('IconExport', <path d="M8 9.25V2.5M5.25 5.25 8 2.5l2.75 2.75M5.5 7H4.25a1 1 0 0 0-1 1v4.25a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H10.5" />);

// ── Paint: fills, strokes, effects, the colour picker ────────────────────────────────────────────
export const IconEyedropper = glyph('IconEyedropper', <path d="M9.25 4.25 11.75 6.75M10.25 2.75l3 3-1.5 1.5-3-3ZM9.75 5.75 4.5 11a1.5 1.5 0 0 0-.4.7l-.35 1.55 1.55-.35a1.5 1.5 0 0 0 .7-.4l5.25-5.25" />);
/** A quarter turn clockwise. */
export const IconRotate = glyph('IconRotate', <path d="M12.75 3.25v3h-3M12.5 6.25A5 5 0 1 0 13 9.5" />);
/** Two arrows trading places: flip a gradient, swap line ends. */
export const IconSwap = glyph('IconSwap', <path d="M2.75 5.5h10.5M10.5 2.75l2.75 2.75-2.75 2.75M13.25 10.5H2.75M5.5 7.75 2.75 10.5l2.75 2.75" />);
/** A box with its sides drawn apart: stroke weights per side. */
export const IconStrokeSides = glyph('IconStrokeSides', <path d="M4.75 2.75h6.5M13.25 4.75v6.5M11.25 13.25h-6.5M2.75 11.25v-6.5" />);
export const IconPaintSolid = glyph('IconPaintSolid', <rect x="3" y="3" width="10" height="10" rx="2" {...FILLED} />);
export const IconPaintGradient = glyph('IconPaintGradient', <><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2" /><path d="M2.75 6.25h10.5" /><path d="M2.75 9.75h10.5" opacity="0.55" /><path d="M5 2.75h6.25a2 2 0 0 1 2 2v1.5h-10.5v-1.5a2 2 0 0 1 2-2Z" {...FILLED} /></>);
/** Six dots: a row that can be dragged. */
export const IconGrip = glyph('IconGrip', <><circle cx="6" cy="4" r="1" {...FILLED} /><circle cx="10" cy="4" r="1" {...FILLED} /><circle cx="6" cy="8" r="1" {...FILLED} /><circle cx="10" cy="8" r="1" {...FILLED} /><circle cx="6" cy="12" r="1" {...FILLED} /><circle cx="10" cy="12" r="1" {...FILLED} /></>);
/** A drop: blend modes. */
export const IconBlend = glyph('IconBlend', <><path d="M8 2.5S3.75 7 3.75 9.75a4.25 4.25 0 0 0 8.5 0C12.25 7 8 2.5 8 2.5Z" /><path d="M8 14V6.5" /></>);
/** Crosshairs: select the layers that use something. */
export const IconTarget = glyph('IconTarget', <><circle cx="8" cy="8" r="4.75" /><path d="M8 1.75v2.5M8 11.75v2.5M1.75 8h2.5M11.75 8h2.5" /></>);
export const IconCrop = glyph('IconCrop', <path d="M4.75 1.75v9.5h9.5M1.75 4.75h9.5v9.5" />);

// ── Boolean operations ───────────────────────────────────────────────────────────────────────────
const SQUARE_A = 'M2.75 2.75h7.5v7.5h-7.5Z';
const SQUARE_B = 'M5.75 5.75h7.5v7.5h-7.5Z';
export const IconUnion = glyph('IconUnion', <path d="M2.75 2.75h7.5v3h3v7.5h-7.5v-3h-3Z" />);
export const IconSubtract = glyph('IconSubtract', <><path d="M2.75 2.75h7.5v3h-4.5v4.5h-3Z" /><path d={SQUARE_B} opacity="0.4" /></>);
export const IconIntersect = glyph('IconIntersect', <><path d={SQUARE_A} opacity="0.4" /><path d={SQUARE_B} opacity="0.4" /><rect x="5.75" y="5.75" width="4.5" height="4.5" {...FILLED} /></>);
export const IconExclude = glyph('IconExclude', <path d={SQUARE_A + SQUARE_B} fillRule="evenodd" fill="currentColor" fillOpacity="0.9" />);
/** "Smooth": one outline with its anchors. */
export const IconFlatten = glyph('IconFlatten', <><path d="M3.5 3.5h9v9h-9Z" /><rect x="2" y="2" width="3" height="3" rx="0.5" {...FILLED} /><rect x="11" y="2" width="3" height="3" rx="0.5" {...FILLED} /><rect x="11" y="11" width="3" height="3" rx="0.5" {...FILLED} /><rect x="2" y="11" width="3" height="3" rx="0.5" {...FILLED} /></>);
/** "Outline stroke": a stroke drawn as its own outline. */
export const IconOutlineStroke = glyph('IconOutlineStroke', <><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2" /><rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.5" /></>);

// ── Vector editing ───────────────────────────────────────────────────────────────────────────────
/** "Bend": a curve and the handle that shapes it. */
export const IconBend = glyph('IconBend', <><path d="M2.75 13.25C3.5 8.75 5.5 6.5 8 6.5s4.5 2.25 5.25 6.75" /><path d="M3.5 6.5h9" /><circle cx="8" cy="6.5" r="1.75" {...FILLED} /><circle cx="3" cy="6.5" r="1.1" {...FILLED} /><circle cx="13" cy="6.5" r="1.1" {...FILLED} /></>);

// ── Text (the "Text" section and the text menu) ─────────────────────────────────────────────────
export const IconTextAlignLeft = glyph('IconTextAlignLeft', <path d="M2.75 4.25h10.5M2.75 8h6.5M2.75 11.75h8.5" />);
export const IconTextAlignCenter = glyph('IconTextAlignCenter', <path d="M2.75 4.25h10.5M4.75 8h6.5M3.75 11.75h8.5" />);
export const IconTextAlignRight = glyph('IconTextAlignRight', <path d="M2.75 4.25h10.5M6.75 8h6.5M4.75 11.75h8.5" />);
export const IconTextAlignJustify = glyph('IconTextAlignJustify', <path d="M2.75 4.25h10.5M2.75 8h10.5M2.75 11.75h6" />);
export const IconTextAlignTop = glyph('IconTextAlignTop', <path d="M2.75 2.75h10.5M8 13.25V5.75M5.25 8.5 8 5.75l2.75 2.75" />);
export const IconTextAlignMiddle = glyph('IconTextAlignMiddle', <path d="M2.75 8h10.5M8 2.25v3.5M8 13.75v-3.5M6 3.75l2 2 2-2M6 12.25l2-2 2 2" />);
export const IconTextAlignBottom = glyph('IconTextAlignBottom', <path d="M2.75 13.25h10.5M8 2.75v7.5M5.25 7.5 8 10.25l2.75-2.75" />);
/** "Auto width": the box grows sideways with the text. */
export const IconTextAutoWidth = glyph('IconTextAutoWidth', <path d="M2.5 8h11M5 5.5 2.5 8 5 10.5M11 5.5l2.5 2.5-2.5 2.5" />);
/** "Auto height": a fixed width, the box grows downwards. */
export const IconTextAutoHeight = glyph('IconTextAutoHeight', <path d="M8 2.5v11M5.5 5 8 2.5 10.5 5M5.5 11 8 13.5l2.5-2.5" />);
/** "Fixed": the box keeps its size. */
export const IconTextFixed = glyph('IconTextFixed', <><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.25" /><path d="M5.5 6h5M5.5 9h3" /></>);
/** "Truncate text": what does not fit ends in an ellipsis. */
export const IconTextTruncate = glyph('IconTextTruncate', <><path d="M2.75 5h10.5M2.75 10.5h4.5" /><circle cx="9.5" cy="10.5" r="0.85" {...FILLED} /><circle cx="11.75" cy="10.5" r="0.85" {...FILLED} /><circle cx="14" cy="10.5" r="0.85" {...FILLED} /></>);
const GLYPH_A = 'M5.25 11.5 8 4.5l2.75 7M6.25 9h3.5';
export const IconLineHeight = glyph('IconLineHeight', <path d={`M2.75 2.25h10.5M2.75 13.75h10.5${GLYPH_A}`} />);
export const IconLetterSpacing = glyph('IconLetterSpacing', <path d={`M2.25 3v10M13.75 3v10${GLYPH_A}`} />);
export const IconParagraphSpacing = glyph('IconParagraphSpacing', <path d="M2.75 2.75h10.5M2.75 5.25h6.5M2.75 10.75h10.5M2.75 13.25h6.5M12 6.5v3M10.75 7.75 12 6.5l1.25 1.25M10.75 8.25 12 9.5l1.25-1.25" />);
/** The first line of a paragraph set in: "Paragraph indent". */
export const IconParagraphIndent = glyph('IconParagraphIndent', <path d="M7.25 3.25h6M2.75 6.75h10.5M2.75 10.25h10.5M2.75 13.25h6.5M2.75 3.25H5.5M4.25 2l1.25 1.25L4.25 4.5" />);
export const IconUnderline = glyph('IconUnderline', <path d="M4.75 2.75V7.5a3.25 3.25 0 0 0 6.5 0V2.75M3.75 13.25h8.5" />);
export const IconStrikethrough = glyph('IconStrikethrough', <path d="M2.75 8h10.5M10.9 4.4C10.45 3.4 9.4 2.75 8 2.75c-1.75 0-3 .9-3 2.25 0 .95.6 1.6 1.6 2M5.1 11.6c.45 1 1.5 1.65 2.9 1.65 1.75 0 3-.9 3-2.25 0-.55-.2-1-.55-1.35" />);
export const IconListNumbered = glyph('IconListNumbered', <path d="M6.75 4.5h6.5M6.75 11.5h6.5M2.6 3.4l.9-.65v3.5M2.4 9.6c.25-.55.75-.85 1.3-.75.65.15.9.85.5 1.4l-1.75 1.95h2.1" />);
export const IconLink = glyph('IconLink', <path d="M7 9a2.4 2.4 0 0 0 3.4 0l2.15-2.15a2.4 2.4 0 0 0-3.4-3.4l-.7.7M9 7a2.4 2.4 0 0 0-3.4 0L3.45 9.15a2.4 2.4 0 0 0 3.4 3.4l.7-.7" />);
/** Styles ("Styles"): four dots, as design tools mark a style picker. */
export const IconStyles = glyph('IconStyles', <><circle cx="5" cy="5" r="1.4" {...FILLED} /><circle cx="11" cy="5" r="1.4" {...FILLED} /><circle cx="5" cy="11" r="1.4" {...FILLED} /><circle cx="11" cy="11" r="1.4" {...FILLED} /></>);
/** Detach a style: a link broken in two. */
export const IconDetachStyle = glyph('IconDetachStyle', <path d="M8.75 4.15 9.6 3.3a2.4 2.4 0 0 1 3.4 3.4l-.85.85M7.25 11.85l-.85.85A2.4 2.4 0 0 1 3 9.3l.85-.85M5.25 2.75v1.5M2.75 5.25h1.5M10.75 13.25v-1.5M13.25 10.75h-1.5" />);
export const IconSliders = glyph('IconSliders', <><path d="M2.75 5h3M9.75 5h3.5M2.75 11h6.5M12.75 11h.5" /><circle cx="7.75" cy="5" r="1.75" /><circle cx="11" cy="11" r="1.75" /></>);

// ── Components ───────────────────────────────────────────────────────────────────────────────────
const diamond = (x: number, y: number, h: number) => `M${x} ${y - h}L${x + h} ${y}L${x} ${y + h}L${x - h} ${y}Z`;
export const IconComponent = glyph('IconComponent', <path d={[diamond(8, 4.1, 2.4), diamond(11.9, 8, 2.4), diamond(8, 11.9, 2.4), diamond(4.1, 8, 2.4)].join('')} />);
export const IconInstance = glyph('IconInstance', <path d={diamond(8, 8, 5.5)} />);
export const IconVariant = glyph('IconVariant', <><path d={diamond(8, 8, 5.5)} /><path d={diamond(8, 8, 2.25)} {...FILLED} /></>);
/** "Detach instance": the instance diamond broken across. */
export const IconDetach = glyph('IconDetach', <path d="M6.6 3.9 8 2.5l1.4 1.4M12.1 6.6 13.5 8 8 13.5 2.5 8l1.4-1.4M3 3l10 10" />);
/** Variables (bind a field, modes): a hexagon. */
export const IconVariable = glyph('IconVariable', <><path d="M8 2.25 12.98 5.13v5.74L8 13.75 3.02 10.87V5.13Z" /><circle cx="8" cy="8" r="1.4" {...FILLED} /></>);
/** BOOLEAN properties and variables: a switch. */
export const IconToggle = glyph('IconToggle', <><rect x="2.25" y="4.75" width="11.5" height="6.5" rx="3.25" /><circle cx="10.5" cy="8" r="1.6" {...FILLED} /></>);
/** Number variables. */
export const IconHash = glyph('IconHash', <path d="M6.25 2.75 5.25 13.25M10.75 2.75l-1 10.5M3.25 6h10M2.75 10h10" />);
export const IconWarning = glyph('IconWarning', <><path d="M7.13 2.75a1 1 0 0 1 1.74 0l5.2 9.5a1 1 0 0 1-.87 1.5H2.8a1 1 0 0 1-.87-1.5Z" /><path d="M8 6.25v3" /><circle cx="8" cy="11.4" r="0.8" {...FILLED} /></>);

// ── Layer types (the layers panel) ───────────────────────────────────────────────────────────────
export const IconGroup = glyph('IconGroup', <path d="M2.75 5V2.75H5M11 2.75h2.25V5M13.25 11v2.25H11M5 13.25H2.75V11M7 2.75h2M7 13.25h2M2.75 7v2M13.25 7v2" />);
export const IconVector = glyph('IconVector', <><path d="M3.25 12.25C5.5 4 10.5 12 12.75 3.75" /><circle cx="3.25" cy="12.25" r="1.25" {...FILLED} /><circle cx="12.75" cy="3.75" r="1.25" {...FILLED} /></>);
export const IconMask = glyph('IconMask', <><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5" /><circle cx="8" cy="8" r="2.75" {...FILLED} /></>);

/** The layers panel's icon for a node; `hints` pick the variants Figma users expect (an image rectangle, an auto-layout frame, a mask). */
export function layerIcon(type: NodeType, hints: {mask?: boolean; image?: boolean; layout?: LayoutMode} = {}): IconComponent {
  if (hints.mask) return IconMask;
  switch (type) {
    case 'FRAME': return hints.layout === 'VERTICAL' ? IconLayoutVertical : hints.layout === 'HORIZONTAL' ? IconLayoutHorizontal : hints.layout === 'GRID' ? IconLayoutGrid : IconFrame;
    case 'GROUP': return IconGroup;
    case 'SECTION': return IconSection;
    case 'COMPONENT': return IconComponent;
    case 'COMPONENT_SET': return IconVariant;
    case 'INSTANCE': return IconInstance;
    case 'BOOLEAN_OPERATION': return IconUnion;
    case 'RECTANGLE': return hints.image ? IconImage : IconRectangle;
    case 'ELLIPSE': return IconEllipse;
    case 'LINE': return IconLine;
    case 'POLYGON': return IconPolygon;
    case 'STAR': return IconStar;
    case 'VECTOR': return IconVector;
    case 'TEXT': return IconText;
    case 'SLICE': return IconSlice;
    default: return IconFrame;
  }
}

// ── General purpose ──────────────────────────────────────────────────────────────────────────────
const EYE = 'M1.75 8S4 3.5 8 3.5 14.25 8 14.25 8 12 12.5 8 12.5 1.75 8 1.75 8Z';
export const IconAppMenu = glyph('IconAppMenu', <path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5" />);
export const IconBack = glyph('IconBack', <path d="M13 8H3M7 4 3 8l4 4" />);
export const IconCheck = glyph('IconCheck', <path d="m3.5 8.5 3 3 6-7" />);
export const IconChevronDown = glyph('IconChevronDown', <path d="M4.5 6.25 8 9.75l3.5-3.5" />);
export const IconChevronLeft = glyph('IconChevronLeft', <path d="M9.75 4.5 6.25 8l3.5 3.5" />);
export const IconChevronRight = glyph('IconChevronRight', <path d="M6.25 4.5 9.75 8l-3.5 3.5" />);
export const IconClock = glyph('IconClock', <><circle cx="8" cy="8" r="5.75" /><path d="M8 5v3.25l2 1.25" /></>);
export const IconCopy = glyph('IconCopy', <><rect x="5.25" y="5.25" width="8" height="8" rx="1.25" /><path d="M10.75 5.25v-1.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.5" /></>);
export const IconDownload = glyph('IconDownload', <path d="M8 2.75v7.5M4.75 7 8 10.25 11.25 7M2.75 13.25h10.5" />);
export const IconExternal = glyph('IconExternal', <path d="M9.5 2.75h3.75V6.5M13.25 2.75 7.5 8.5M11.5 9.25v3a1 1 0 0 1-1 1h-6.75a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h3" />);
export const IconEye = glyph('IconEye', <><path d={EYE} /><circle cx="8" cy="8" r="1.9" /></>);
export const IconEyeOff = glyph('IconEyeOff', <path d="M6.6 3.65A6 6 0 0 1 8 3.5c4 0 6.25 4.5 6.25 4.5a11 11 0 0 1-1.55 2.15M9.35 9.4a1.9 1.9 0 0 1-2.75-2.75M4.4 4.75C2.75 5.95 1.75 8 1.75 8S4 12.5 8 12.5c1.2 0 2.25-.35 3.15-.9M2.75 2.75l10.5 10.5" />);
const FILE = 'M9.25 2.25h-4.5a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1v-7.5ZM9.25 2.25v3h3';
export const IconFile = glyph('IconFile', <path d={FILE} />);
export const IconFileOpen = glyph('IconFileOpen', <><path d={FILE} /><path d="M8 12V8.25M6.25 10 8 8.25 9.75 10" /></>);
export const IconGrid = glyph('IconGrid', <><rect x="2.75" y="2.75" width="4.25" height="4.25" rx="1" /><rect x="9" y="2.75" width="4.25" height="4.25" rx="1" /><rect x="2.75" y="9" width="4.25" height="4.25" rx="1" /><rect x="9" y="9" width="4.25" height="4.25" rx="1" /></>);
export const IconImport = glyph('IconImport', <path d="M8 2.25v7.25M5 6.5l3 3 3-3M2.75 9.5v2.75a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V9.5" />);
export const IconList = glyph('IconList', <><path d="M5.75 4.5h7.5M5.75 8h7.5M5.75 11.5h7.5" /><circle cx="3" cy="4.5" r="0.75" {...FILLED} /><circle cx="3" cy="8" r="0.75" {...FILLED} /><circle cx="3" cy="11.5" r="0.75" {...FILLED} /></>);
export const IconLock = glyph('IconLock', <><rect x="3.25" y="7" width="9.5" height="6.5" rx="1.25" /><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7" /></>);
export const IconUnlock = glyph('IconUnlock', <><rect x="3.25" y="7" width="9.5" height="6.5" rx="1.25" /><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.35-.9" /></>);
export const IconMinus = glyph('IconMinus', <path d="M3.5 8h9" />);
export const IconPlus = glyph('IconPlus', <path d="M8 3.5v9M3.5 8h9" />);
export const IconMonitor = glyph('IconMonitor', <><rect x="2.25" y="3" width="11.5" height="7.5" rx="1.25" /><path d="M5.5 13.25h5M8 10.5v2.75" /></>);
export const IconMoon = glyph('IconMoon', <path d="M13 9.6A5.25 5.25 0 1 1 6.4 3a4.25 4.25 0 0 0 6.6 6.6Z" />);
export const IconSun = glyph('IconSun', <><circle cx="8" cy="8" r="2.75" /><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" /></>);
export const IconMore = glyph('IconMore', <><circle cx="4" cy="8" r="1" {...FILLED} /><circle cx="8" cy="8" r="1" {...FILLED} /><circle cx="12" cy="8" r="1" {...FILLED} /></>);
export const IconOffline = glyph('IconOffline', <path d="M4.5 5.6a3.4 3.4 0 0 0 .25 6.15h6.5M8.1 3.45a3.75 3.75 0 0 1 5.15 3.9 2.4 2.4 0 0 1 .3 3.65M2.75 2.75l10.5 10.5" />);
export const IconPanel = glyph('IconPanel', <><rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" /><path d="M6.25 2.75v10.5" /></>);
export const IconUndo = glyph('IconUndo', <path d="M5.5 3.5 2.75 6.25 5.5 9M3 6.25h6.25a3.75 3.75 0 0 1 0 7.5H7" />);
export const IconPlay = glyph('IconPlay', <path d="M5 3.25v9.5L12.75 8Z" />);
export const IconRename = glyph('IconRename', PENCIL);
export const IconRestore = glyph('IconRestore', <path d="M3 3.25v3.25h3.25M3.35 6.5a5 5 0 1 1 .15 3.75" />);
export const IconSearch = glyph('IconSearch', <><circle cx="7.25" cy="7.25" r="4.25" /><path d="m10.5 10.5 2.75 2.75" /></>);
export const IconTeam = glyph('IconTeam', <><circle cx="6" cy="5.75" r="2.25" /><path d="M2 13a4 4 0 0 1 8 0M10.5 3.6a2.25 2.25 0 0 1 0 4.3M12 9.75A4 4 0 0 1 14 13" /></>);
// ── Teams (docs/design-tool.md §Teams) ──
const FOLDER = 'M2.25 4.25a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1Z';
/** A project: a folder of a team's files. */
export const IconFolder = glyph('IconFolder', <path d={FOLDER} />);
export const IconFolderPlus = glyph('IconFolderPlus', <><path d={FOLDER} /><path d="M8 7.25v3.5M6.25 9h3.5" /></>);
/** "Personal files": one person. */
export const IconUser = glyph('IconUser', <><circle cx="8" cy="5.5" r="2.5" /><path d="M3.5 13.25a4.5 4.5 0 0 1 9 0" /></>);
/** An invite by e-mail that waits for its person: an envelope. */
/** "Invite": a person and a plus. */
export const IconUserPlus = glyph('IconUserPlus', <><circle cx="6.25" cy="5.5" r="2.25" /><path d="M2.25 13a4 4 0 0 1 8 0M12.25 5.75v3.5M10.5 7.5H14" /></>);
/** "Team settings": a cog. */
export const IconSettings = glyph('IconSettings', <><circle cx="8" cy="8" r="2" /><path d="M8 1.75v1.6M8 12.65v1.6M14.25 8h-1.6M3.35 8h-1.6M12.42 3.58l-1.13 1.13M4.71 11.29l-1.13 1.13M12.42 12.42l-1.13-1.13M4.71 4.71 3.58 3.58" /></>);
/** "Leave team": a door with an arrow out. */
export const IconLeave = glyph('IconLeave', <path d="M9.25 3.25h-5a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h5M7 8h6.75M11.25 5.5 13.75 8l-2.5 2.5" />);
export const IconMenu = glyph('IconMenu', <path d="M2.75 4.25h10.5M2.75 8h10.5M2.75 11.75h10.5" />);
export const IconTrash = glyph('IconTrash', <path d="M2.75 4.5h10.5M6.25 4.5V3.25h3.5V4.5M4.25 4.5l.6 8.25a1 1 0 0 0 1 .95h4.3a1 1 0 0 0 1-.95l.6-8.25M6.75 7v4M9.25 7v4" />);
export const IconClose = glyph('IconClose', <path d="m4 4 8 8M12 4l-8 8" />);

// ── Assets and variables (the left panel) ────────────────────────────────────────────────────────
/** A hexagon with a core: variables. */
export const IconVariables = glyph('IconVariables', <><path d="M8 1.9 13.25 4.95v6.1L8 14.1l-5.25-3.05v-6.1Z" /><circle cx="8" cy="8" r="1.6" {...FILLED} /></>);
/** Variable types: colour (a half-filled disc), number (#), string (the text T), boolean (a switch). */
export const IconVarColor = glyph('IconVarColor', <><circle cx="8" cy="8" r="5.25" /><path d="M8 2.75a5.25 5.25 0 0 1 0 10.5Z" {...FILLED} /></>);
export const IconVarNumber = glyph('IconVarNumber', <path d="M6.6 2.75 5.4 13.25M10.6 2.75l-1.2 10.5M3 6h10.25M2.75 10H13" />);
export const IconVarBoolean = glyph('IconVarBoolean', <><rect x="1.75" y="4.5" width="12.5" height="7" rx="3.5" /><circle cx="10.75" cy="8" r="1.75" {...FILLED} /></>);
/** Two chevrons meeting: "Collapse all layers". */
export const IconCollapseAll = glyph('IconCollapseAll', <path d="M5 3 8 6l3-3M5 13l3-3 3 3" />);
export const IconAlert = glyph('IconAlert', <><path d="M7.13 2.75a1 1 0 0 1 1.74 0l5.2 9.25a1 1 0 0 1-.87 1.5H2.8a1 1 0 0 1-.87-1.5Z" /><path d="M8 6.25v3" /><circle cx="8" cy="11.25" r="0.75" {...FILLED} /></>);
export const IconKey = glyph('IconKey', <><circle cx="5.5" cy="10.5" r="2.75" /><path d="m7.45 8.55 5.8-5.8M11 5l1.75 1.75M9.5 6.5l1.25 1.25" /></>);

// ── Find and replace, the guide ─────────────────────────────────────────────────────────────────
export const IconChevronUp = glyph('IconChevronUp', <path d="M4.5 9.75 8 6.25l3.5 3.5" />);
export const IconArrowUp = glyph('IconArrowUp', <path d="M8 13V3.25M4.25 7 8 3.25 11.75 7" />);
export const IconArrowDown = glyph('IconArrowDown', <path d="M8 3v9.75M4.25 9 8 12.75 11.75 9" />);
/** "Now → after" (library updates). */
export const IconArrowRight = glyph('IconArrowRight', <path d="M3 8h9.75M9 4.25 12.75 8 9 11.75" />);
/** "Match case": a capital and a small letter. */
export const IconMatchCase = glyph('IconMatchCase', <><path d="M1.75 12.5 4.75 4l3 8.5M2.85 9.6h3.8" /><circle cx="11.75" cy="10.25" r="2.25" /><path d="M14 8v4.5" /></>);
/** "Match whole word": letters on a bracket that closes around them. */
export const IconWholeWord = glyph('IconWholeWord', <><circle cx="5.25" cy="7.25" r="2" /><path d="M7.25 5.25v4M9 3v6.25" /><circle cx="11" cy="7.25" r="2" /><path d="M2 11.25v1.75h12v-1.75" /></>);
/** "Guide": an open book. */
export const IconBook = glyph('IconBook', <path d="M8 4.5c-1.4-1-3.25-1.5-5.25-1.25v9c2-.25 3.85.25 5.25 1.25 1.4-1 3.25-1.5 5.25-1.25v-9C11.25 3 9.4 3.5 8 4.5Zm0 0v9" />);

// ── Pictures ────────────────────────────────────────────────────────────────────
/** A brush with its tip: edit a picture, paint a mask. */
export const IconBrush = glyph('IconBrush', <><path d="M13.25 2.75 7.6 8.4" /><path d="M7.6 8.4a1.9 1.9 0 0 0-2.7 0c-.75.75-.4 2.1-1.15 2.85-.4.4-.85.55-1 .5.75 1.05 3.1 1.35 4.35.1a1.9 1.9 0 0 0 .5-3.45" /></>);

// ── Comments (src/design/comments) ───────────────────────────────────────────────────────────────
/** "Comment" (C): a round speech bubble whose tip is its bottom-left corner, like the pins on the canvas. */
export const IconComment = glyph('IconComment', <path d="M2.75 13.25V8a5.25 5.25 0 1 1 5.25 5.25Z" />);
/** "Mention": an at sign. */
export const IconMention = glyph('IconMention', <><circle cx="8" cy="8" r="2.25" /><path d="M10.25 5.75V9a1.75 1.75 0 0 0 3.5 0V8a5.75 5.75 0 1 0-2.4 4.68" /></>);

// ── The bar's end (src/design/editor/chrome/Toolbar.tsx) ─────────────────────────────────────────
/** "Actions" (⌘K): a diamond, a circle, a square and a plus, as Figma's Actions button. */
export const IconActions = glyph('IconActions', <><path d="M5 2.4 7.6 5 5 7.6 2.4 5Z" /><circle cx="11.1" cy="5" r="2.35" /><rect x="2.75" y="8.85" width="4.4" height="4.4" rx="1" /><path d="M11.1 8.85v4.4M8.9 11.05h4.4" /></>);
/** "Drawing": a scribble. */
export const IconModeDraw = glyph('IconModeDraw', <path d="M2.75 11.75C4.1 8.4 5.5 5 6.7 5.5c1.35.55-1.95 5.7-.45 6.35 1.5.65 3.55-6.1 4.95-5.45 1 .45-.45 3.35.35 3.85.55.35 1.15-.2 1.7-.85" />);
/** "Design": a ruled corner with a pointer in it. */
export const IconModeDesign = glyph('IconModeDesign', <><path d="M2.75 13V3.5a.75.75 0 0 1 .75-.75H13M5.75 2.75V4.5M8.75 2.75V4.5M2.75 5.75H4.5M2.75 8.75H4.5" /><path d="M7.5 7.25 13 9.55l-2.3.9-.9 2.3Z" /></>);
/** "Prototype": a diamond with a chevron, the way a connection points on. */
export const IconModePrototype = glyph('IconModePrototype', <><path d="M8 2.25 13.75 8 8 13.75 2.25 8Z" /><path d="M7 6 9 8l-2 2" /></>);
/** "Code" (Dev Mode): angle brackets and a slash. */
export const IconCode = glyph('IconCode', <path d="M5.25 4.75 2 8l3.25 3.25M10.75 4.75 14 8l-3.25 3.25M9 3.25 7 12.75" />);

