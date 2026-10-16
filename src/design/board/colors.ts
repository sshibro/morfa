import type {DesignDocument, Paint, SceneNode} from '../../../shared/design/types';
import {HIGHLIGHTER_COLORS, MARKER_COLORS, WASHI_COLORS, rgbToHex} from '../../../shared/design/board/palette';
import type {MarkerKind} from './state';

// "Board colors": the colours already drawn with on this board that the tray's palette does not hold, per kind, so a colour
// picked once with the rainbow can be picked again with one click (the owner's picture puts a palette button after the
// rainbow, FigJam's place for colour styles; a board has no colour styles, so it holds the board's own colours).

export const BOARD_COLORS_MAX = 10;

const PALETTES = {marker: MARKER_COLORS, highlighter: HIGHLIGHTER_COLORS, washi: WASHI_COLORS} as const;

const solidHex = (paints: readonly Paint[] | undefined): string | null => {
  const paint = paints?.find(each => each.type === 'SOLID');
  return paint?.type === 'SOLID' ? rgbToHex(paint.color).toUpperCase() : null;
};

/** The ink of one stroke object: a marker's or highlighter's line colour, washi tape's body fill. */
function inkOf(doc: DesignDocument, node: SceneNode): string | null {
  if (node.board?.kind !== 'stroke') return null;
  if (node.board.tool !== 'washi') return solidHex(node.strokes);
  const body = doc.nodes[node.children?.[0] ?? ''];
  return solidHex(body?.fills);
}

/** Colours strokes of `kind` use on the board, newest first, outside the tray's palette; at most BOARD_COLORS_MAX. */
export function boardColors(doc: DesignDocument, kind: Exclude<MarkerKind, 'eraser'>): string[] {
  const known = new Set(PALETTES[kind].map(color => color.hex.toUpperCase()));
  const found: string[] = [];
  const nodes = Object.values(doc.nodes);
  for (let k = nodes.length - 1; k >= 0 && found.length < BOARD_COLORS_MAX; k--) {
    const node = nodes[k];
    if (node.board?.kind !== 'stroke' || node.board.tool !== kind) continue;
    const hex = inkOf(doc, node);
    if (hex && !known.has(hex) && !found.includes(hex)) found.push(hex);
  }
  return found;
}
