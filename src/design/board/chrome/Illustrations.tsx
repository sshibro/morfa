import {memo, useId} from 'react';

// The three drawn tools of the board's bar (docs/board.md §Chrome): a tall
// marker with a cone tip, a stack of plain notes with two sheets peeking out, and shapes (an outlined square, a circle the bar's
// edge cuts in half, a curved arrow). Morfa's own drawings, much larger than icons: they stand on the bar's bottom edge, cut off
// by it, and rise when hovered or in hand (board.css). The marker's tip and the top note take what was last chosen in the tray.

/** 48 × 80: the barrel from y 24 down, the tip above it. */
export const MarkerArt = memo(function MarkerArt({ink}: {ink: string}) {
  const id = useId();
  return (
    <svg className="bd-art bd-art-marker" viewBox="0 0 48 80" width="48" height="80" aria-hidden="true">
      <defs>
        <linearGradient id={id + 'b'} x1="0" x2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.6" stopColor="#EDEDED" />
          <stop offset="1" stopColor="#CFCFCF" />
        </linearGradient>
      </defs>
      {/* The cone tip in the ink's colour, its collar, then the barrel with a highlight and a band of the ink. */}
      <path d="M19 18 L24 3 L29 18 Z" fill={ink} stroke="rgba(0,0,0,0.3)" strokeWidth="0.75" strokeLinejoin="round" />
      <path d="M15 24 L19 17 H29 L33 24 Z" fill="#2B2B2B" />
      <rect x="12" y="23" width="24" height="60" rx="5" fill={`url(#${id}b)`} stroke="rgba(0,0,0,0.16)" strokeWidth="1" />
      <rect x="12" y="34" width="24" height="6" fill={ink} />
      <rect x="16" y="27" width="3" height="50" rx="1.5" fill="#FFFFFF" opacity="0.9" />
    </svg>
  );
});

/** 80 × 80: the top note 50 px square, two sheets below and to the left. */
export const StickiesArt = memo(function StickiesArt({paper}: {paper: string}) {
  const id = useId();
  return (
    <svg className="bd-art bd-art-stickies" viewBox="0 0 80 80" width="80" height="80" aria-hidden="true">
      <defs>
        <filter id={id + 'f'} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" floodOpacity="0.16" />
        </filter>
      </defs>
      <g filter={`url(#${id}f)`}>
        <rect x="12" y="20" width="50" height="50" rx="2" fill={paper} transform="rotate(-8 37 45)" />
        <rect x="16" y="16" width="50" height="50" rx="2" fill={paper} transform="rotate(-3 41 41)" />
        <rect x="20" y="10" width="50" height="50" rx="2" fill={paper} />
      </g>
      {/* The lower sheets a shade deeper, so the stack reads as paper on paper. */}
      <rect x="12" y="20" width="50" height="50" rx="2" fill="#000" opacity="0.07" transform="rotate(-8 37 45)" />
      <rect x="16" y="16" width="50" height="50" rx="2" fill="#000" opacity="0.04" transform="rotate(-3 41 41)" />
      <rect x="20" y="10" width="50" height="50" rx="2" fill={paper} />
    </svg>
  );
});

/** 76 × 80: the square and the arrow above the bar's edge, the circle across it (about half of it shows at rest). */
export const ShapesArt = memo(function ShapesArt() {
  return (
    <svg className="bd-art bd-art-shapes" viewBox="0 0 76 80" width="76" height="80" aria-hidden="true">
      <rect x="8" y="26" width="34" height="34" rx="4" fill="#FFFFFF" stroke="#1E1E1E" strokeWidth="1.5" />
      <circle cx="56" cy="52" r="15" fill="#FFFFFF" stroke="#1E1E1E" strokeWidth="1.5" />
      <path d="M38 20 C 46 8, 58 8, 64 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M58.5 15.5 L64.5 16.5 L65.5 10.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});
