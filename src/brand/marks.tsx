import {PRODUCT_NAME} from '../../shared/design/product';

// Morfa's mark, drawn inline from the owner's files (assets/brand/, 2026-10-09) so each ground gets its palette: a square, a rounded
// square and a circle, one shape becoming the next. The paths and the lockup's placements are the files' own; only the colours
// change by palette, exactly as the delivered variants do. Used by the app (the sign-in screen,
// the file browser, the editor's menu).

const SQUARE = 'M 0 0.6667 L 1 0.6667 L 1 1.6667 L 0 1.6667 L 0 0.6667 Z';
const ROUNDED = 'M 0.5808 0.3283 L 1.0858 0.3283 A 0.2525 0.2525 0 0 1 1.3383 0.5808 L 1.3383 1.0858 A 0.2525 0.2525 0 0 1 1.0858 1.3383 L 0.5808 1.3383 A 0.2525 0.2525 0 0 1 0.3283 1.0858 L 0.3283 0.5808 A 0.2525 0.2525 0 0 1 0.5808 0.3283 Z';
const CIRCLE = 'M 0.6517 0.5 A 0.515 0.515 0 1 0 1.6817 0.5 A 0.515 0.515 0 1 0 0.6517 0.5 Z';

const WORDMARK = [
  'M 0 4 L 0 1.6 A 1.6 1.6 0 0 1 1.6 0 L 3.8 0 A 1.6 1.6 0 0 1 5.4 1.6 L 5.4 4 L 4.4 4 L 4.4 1.6 A 0.6 0.6 0 0 0 3.2 1.6 L 3.2 4 L 2.2 4 L 2.2 1.6 A 0.6 0.6 0 0 0 1 1.6 L 1 4 Z',
  'M 6.2 2 A 2.08 2.08 0 1 1 10.36 2 A 2.08 2.08 0 1 1 6.2 2 Z M 7.24 2 A 1.04 1.04 0 1 0 9.32 2 A 1.04 1.04 0 1 0 7.24 2 Z',
  'M 11.06 4 L 11.06 1.5 A 1.5 1.5 0 0 1 12.56 0 L 13.16 0 L 13.16 1 L 12.56 1 A 0.5 0.5 0 0 0 12.06 1.5 L 12.06 4 Z',
  'M 14.41 4 L 14.41 1 L 13.71 1 L 13.71 0 L 14.41 0 L 14.41 -0.5 A 1.5 1.5 0 0 1 15.91 -2 L 16.51 -2 L 16.51 -1 L 15.91 -1 A 0.5 0.5 0 0 0 15.41 -0.5 L 15.41 0 L 16.51 0 L 16.51 1 L 15.41 1 L 15.41 4 Z',
  'M 20.42 0.2224 A 2.08 2.08 0 1 0 20.42 3.7776 L 20.42 4 L 21.42 4 L 21.42 0 L 20.42 0 Z M 18.3 2 A 1.04 1.04 0 1 0 20.38 2 A 1.04 1.04 0 1 0 18.3 2 Z',
] as const;

/** The square, the rounded square and the circle, in that order, for each ground the owner delivered a variant for. */
const PALETTES = {
  color: ['#C4C0FF', '#8A82FF', '#4338FF'],
  onBrand: ['#6E66FF', '#A9A3FF', '#FFFFFF'],
  mono: ['#D2D2D2', '#8C8C8C', '#141414'],
  monoOnDark: ['#3A3A3A', '#8C8C8C', '#FFFFFF'],
} as const;

export type Palette = keyof typeof PALETTES;

/** The three shapes in the symbol's own units (0…1.6817 across, −0.015…1.6667 down), for a drawing that places them itself. */
function SymbolShapes({palette}: {palette: Palette}) {
  const [square, rounded, circle] = PALETTES[palette];
  return (
    <>
      <path d={SQUARE} fill={square}/>
      <path d={ROUNDED} fill={rounded}/>
      <path d={CIRCLE} fill={circle}/>
    </>
  );
}

/** The symbol alone, square (its shapes span 0…1.6817 across and −0.015…1.6667 down). */
export function BrandSymbol({palette = 'color', className}: {palette?: Palette; className?: string}) {
  return (
    <svg className={className} viewBox="0 -0.015 1.6817 1.6817" aria-hidden="true" focusable="false">
      <SymbolShapes palette={palette}/>
    </svg>
  );
}

/** Symbol and wordmark as the lockup file places them (580.4 × 120); the wordmark takes the current text colour. */
export function Lockup({palette = 'color', className}: {palette?: Palette; className?: string}) {
  return (
    <svg className={className} viewBox="0 0 580.4 120" role="img" aria-label={PRODUCT_NAME} focusable="false">
      <g transform="translate(0 1.0703666997026768) scale(71.35777998017839)"><SymbolShapes palette={palette}/></g>
      <g transform="translate(152 40) scale(20)" fill="currentColor" fillRule="evenodd">
        {WORDMARK.map(d => <path key={d} d={d}/>)}
      </g>
    </svg>
  );
}
