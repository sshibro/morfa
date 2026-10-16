// The phone's bottom sheets: two stops, about half the screen and nearly all of it,
// and where a drag of the handle lets go. Pure, so it is tested without a browser (tests/design-phone-sheet.test.ts).

export type SheetStop = 'half' | 'full';

/** What stays above a full sheet: the top bar's row, so the file and its actions remain in reach. */
export const FULL_SHEET_GAP = 56;
/** Below this share of the half stop a let-go closes the sheet. */
const CLOSE_SHARE = 0.6;
/** Px per ms: a let-go faster than this follows the flick's direction rather than the nearest stop. */
const FLICK_SPEED = 0.5;

export function sheetHeight(stop: SheetStop, screenHeight: number): number {
  return stop === 'half' ? Math.round(screenHeight / 2) : screenHeight - FULL_SHEET_GAP;
}

/** The stop a sheet settles on when the handle is let go at `height`, moving up at `velocity` px/ms (negative: down). */
export function sheetStopAfterDrag(height: number, velocity: number, screenHeight: number): SheetStop | 'closed' {
  const half = sheetHeight('half', screenHeight), full = sheetHeight('full', screenHeight);
  if (velocity >= FLICK_SPEED) return height >= half ? 'full' : 'half';
  if (velocity <= -FLICK_SPEED) return height <= half ? 'closed' : 'half';
  if (height < half * CLOSE_SHARE) return 'closed';
  return Math.abs(height - full) < Math.abs(height - half) ? 'full' : 'half';
}
