import {memo, type SVGProps} from 'react';

// "Board" (docs/board.md): the board's mark in the file browser (its button, its cards), drawn like src/design/ui/icons.tsx — 16 px,
// 1.5 px strokes, currentColor: a sticky note with a turned corner.

export const IconBoard = memo(function IconBoard({size = 16, ...rest}: Omit<SVGProps<SVGSVGElement>, 'ref'> & {size?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" {...rest}>
      <path d="M2.75 2.75h10.5v7.25l-3.25 3.25H2.75Z" />
      <path d="M13.25 10h-3.25v3.25M5.25 6h5.5M5.25 8.75h3" />
    </svg>
  );
});
