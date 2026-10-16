import {memo, type ComponentType, type ReactNode, type SVGProps} from 'react';

// Icons of the structural sections ("Position", "Auto layout", "Layout grid", "Layer", "Export"),
// drawn like the kit's set (src/design/ui/icons.tsx): 16 px, 1.5 px strokes, currentColor, a 16-unit
// grid. They live with the sections that use them so parallel features do not edit one file.

type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {size?: number};
export type PanelIcon = ComponentType<IconProps>;
const FILLED = {fill: 'currentColor', stroke: 'none'} as const;

function glyph(name: string, body: ReactNode): PanelIcon {
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

// ── Position ─────────────────────────────────────────────────────────────────────────────────────
/** The rotation field's prefix: an angle. */
export const IconAngle = glyph('IconAngle', <><path d="M3 12.75h10M3 12.75 10.5 4" /><path d="M7.4 12.6a3.6 3.6 0 0 0-.85-2.6" /></>);
export const IconRotateCw = glyph('IconRotateCw', <><path d="M12.75 7.75a4.75 4.75 0 1 1-1.4-3.35" /><path d="M12.5 2.75v2.5H10" /></>);
export const IconFlipHorizontal = glyph('IconFlipHorizontal', <><path d="M8 2.25v11.5" strokeDasharray="1.5 2" /><path d="M5.75 4.5 2.5 11.5h3.25ZM10.25 4.5l3.25 7h-3.25Z" /></>);
export const IconFlipVertical = glyph('IconFlipVertical', <><path d="M2.25 8h11.5" strokeDasharray="1.5 2" /><path d="M4.5 5.75 11.5 2.5v3.25ZM4.5 10.25l7 3.25v-3.25Z" /></>);
export const IconLink = glyph('IconLink', <><path d="M6.75 9.25 9.25 6.75" /><path d="M8.5 4.75 9.6 3.65a2.47 2.47 0 0 1 3.5 3.5L12 8.25" /><path d="M7.5 11.25 6.4 12.35a2.47 2.47 0 0 1-3.5-3.5L4 7.75" /></>);
export const IconUnlink = glyph('IconUnlink', <><path d="M8.5 4.75 9.6 3.65a2.47 2.47 0 0 1 3.5 3.5L12 8.25" /><path d="M7.5 11.25 6.4 12.35a2.47 2.47 0 0 1-3.5-3.5L4 7.75" /><path d="M2.75 4.5h1.5M4.5 2.75v1.5M13.25 11.5h-1.5M11.5 13.25v-1.5" /></>);
/** "Absolute position": a layer pinned inside a frame, out of the flow. */
export const IconAbsolute = glyph('IconAbsolute', <><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5" strokeDasharray="2 2" /><rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.75" {...FILLED} /></>);
export const IconCornerRadius = glyph('IconCornerRadius', <path d="M3.25 12.75V8a4.75 4.75 0 0 1 4.75-4.75h4.75" />);
export const IconCorners = glyph('IconCorners', <path d="M2.75 6V4.75a2 2 0 0 1 2-2H6M10 2.75h1.25a2 2 0 0 1 2 2V6M13.25 10v1.25a2 2 0 0 1-2 2H10M6 13.25H4.75a2 2 0 0 1-2-2V10" />);
export const IconCornerTL = glyph('IconCornerTL', <path d="M4.25 12V7.75a3.5 3.5 0 0 1 3.5-3.5H12" />);
export const IconCornerTR = glyph('IconCornerTR', <path d="M4 4.25h4.25a3.5 3.5 0 0 1 3.5 3.5V12" />);
export const IconCornerBR = glyph('IconCornerBR', <path d="M11.75 4v4.25a3.5 3.5 0 0 1-3.5 3.5H4" />);
export const IconCornerBL = glyph('IconCornerBL', <path d="M12 11.75H7.75a3.5 3.5 0 0 1-3.5-3.5V4" />);
/** Corner smoothing: a squircle. */
export const IconSmoothing = glyph('IconSmoothing', <path d="M8 2.75c4.4 0 5.25.85 5.25 5.25S12.4 13.25 8 13.25 2.75 12.4 2.75 8 3.6 2.75 8 2.75Z" />);
export const IconMinMax = glyph('IconMinMax', <path d="M2.75 4.5v7M13.25 4.5v7M5 8h6M6.5 6.5 5 8l1.5 1.5M9.5 6.5 11 8l-1.5 1.5" />);

// ── Auto layout ──────────────────────────────────────────────────────────────────────────────────
export const IconArrowDown = glyph('IconArrowDown', <path d="M8 2.75v10.5M4.5 9.75 8 13.25l3.5-3.5" />);
export const IconArrowRight = glyph('IconArrowRight', <path d="M2.75 8h10.5M9.75 4.5 13.25 8l-3.5 3.5" />);
/** "Freeform" flow: three blocks placed freely (no auto layout). */
export const IconFreeform = glyph('IconFreeform', <><rect x="2.75" y="2.75" width="4" height="4" rx="1" /><rect x="9.25" y="5.25" width="4" height="4" rx="1" /><rect x="4.25" y="9.25" width="4" height="4" rx="1" /></>);
/** "Add auto layout": a column of two blocks with a plus beside them. */
export const IconAutoLayoutAdd = glyph('IconAutoLayoutAdd', <><rect x="2.75" y="2.75" width="4.5" height="10.5" rx="1" /><path d="M10 3.25v4M8 5.25h4" /><rect x="9.25" y="9.75" width="4" height="3.5" rx="1" /></>);
export const IconWrap = glyph('IconWrap', <path d="M2.75 4.25h8a2.5 2.5 0 0 1 0 5H4.5M6.5 7.25l-2 2 2 2M2.75 13.25h4" />);
export const IconSliders = glyph('IconSliders', <path d="M2.75 4.75h6M11.75 4.75h1.5M2.75 11.25h1.5M7.25 11.25h6M10.25 3.25v3M5.75 9.75v3" />);
export const IconPadLeft = glyph('IconPadLeft', <><path d="M2.75 2.75v10.5" /><rect x="6" y="4.75" width="7.25" height="6.5" rx="1" opacity="0.45" /></>);
export const IconPadRight = glyph('IconPadRight', <><path d="M13.25 2.75v10.5" /><rect x="2.75" y="4.75" width="7.25" height="6.5" rx="1" opacity="0.45" /></>);
export const IconPadTop = glyph('IconPadTop', <><path d="M2.75 2.75h10.5" /><rect x="4.75" y="6" width="6.5" height="7.25" rx="1" opacity="0.45" /></>);
export const IconPadBottom = glyph('IconPadBottom', <><path d="M2.75 13.25h10.5" /><rect x="4.75" y="2.75" width="6.5" height="7.25" rx="1" opacity="0.45" /></>);

// ── Layout grids ─────────────────────────────────────────────────────────────────────────────────
export const IconGridSquare = glyph('IconGridSquare', <path d="M2.75 2.75h10.5v10.5H2.75ZM6.25 2.75v10.5M9.75 2.75v10.5M2.75 6.25h10.5M2.75 9.75h10.5" />);
export const IconGridColumns = glyph('IconGridColumns', <><rect x="2.75" y="2.75" width="2.5" height="10.5" rx="0.5" {...FILLED} opacity="0.85" /><rect x="6.75" y="2.75" width="2.5" height="10.5" rx="0.5" {...FILLED} opacity="0.85" /><rect x="10.75" y="2.75" width="2.5" height="10.5" rx="0.5" {...FILLED} opacity="0.85" /></>);
export const IconGridRows = glyph('IconGridRows', <><rect x="2.75" y="2.75" width="10.5" height="2.5" rx="0.5" {...FILLED} opacity="0.85" /><rect x="2.75" y="6.75" width="10.5" height="2.5" rx="0.5" {...FILLED} opacity="0.85" /><rect x="2.75" y="10.75" width="10.5" height="2.5" rx="0.5" {...FILLED} opacity="0.85" /></>);
/** Styles: four dots, as the style pickers of every section. */
export const IconStyles = glyph('IconStyles', <><circle cx="5" cy="5" r="1.4" {...FILLED} /><circle cx="11" cy="5" r="1.4" {...FILLED} /><circle cx="5" cy="11" r="1.4" {...FILLED} /><circle cx="11" cy="11" r="1.4" {...FILLED} /></>);
export const IconDetach = glyph('IconDetach', <><path d="M6.5 5.25 7.6 4.15a2.47 2.47 0 0 1 3.5 3.5L10 8.75M9.5 10.75 8.4 11.85a2.47 2.47 0 0 1-3.5-3.5L6 7.25" /><path d="M2.75 2.75l10.5 10.5" /></>);

// ── Layer ────────────────────────────────────────────────────────────────────────────────────────
/** Blend modes: two overlapping circles. */
export const IconBlend = glyph('IconBlend', <><circle cx="6.25" cy="8" r="3.75" /><circle cx="9.75" cy="8" r="3.75" /></>);
/** Opacity: a half-filled drop. */
export const IconOpacity = glyph('IconOpacity', <><path d="M8 2.5 4.6 7a4.25 4.25 0 1 0 6.8 0Z" /><path d="M8 13.25V2.5L11.4 7a4.25 4.25 0 0 1-3.4 6.25Z" {...FILLED} /></>);

// ── Export ───────────────────────────────────────────────────────────────────────────────────────
export const IconTidy = glyph('IconTidy', <><rect x="2.75" y="2.75" width="4" height="4" rx="1" /><rect x="9.25" y="2.75" width="4" height="4" rx="1" /><rect x="2.75" y="9.25" width="4" height="4" rx="1" /><rect x="9.25" y="9.25" width="4" height="4" rx="1" /></>);
/** "Shape builder": a square and a circle overlapping, their shared piece filled. */
export const IconShapeBuilder = glyph('IconShapeBuilder', <><rect x="2.25" y="2.25" width="7.5" height="7.5" rx="1" /><circle cx="10" cy="10" r="3.75" /><path d="M6.4 9.75h3.35V6.4a3.75 3.75 0 0 0-3.35 3.35Z" fill="currentColor" stroke="none" /></>);
/** "Edit all variants": a pointer over three stacked boxes. */
export const IconMultiEdit = glyph('IconMultiEdit', <><rect x="2.25" y="2.25" width="7" height="3" rx="0.75" /><rect x="2.25" y="6.5" width="7" height="3" rx="0.75" /><rect x="2.25" y="10.75" width="7" height="3" rx="0.75" /><path d="m10 7.5 4 4.25-1.75.25-.75 1.75Z" /></>);
/** "Automatic placement" in a grid: cells filled in order, an arrow running through them. */
export const IconAutoPlace = glyph('IconAutoPlace', <><rect x="2.25" y="2.25" width="4.5" height="4.5" rx="1" /><rect x="9.25" y="2.25" width="4.5" height="4.5" rx="1" /><rect x="2.25" y="9.25" width="4.5" height="4.5" rx="1" /><path d="M10.25 11.5h3.5M12.25 10l1.5 1.5-1.5 1.5" /></>);
