import type {DesignDocument, NodeId, Vec} from '../../../../shared/design/types';
import {worldBox} from '../../../../shared/design/geometry';
import type {Viewport} from '../../engine/contracts';
import {pageToScreen} from '../../engine/viewport';

// Who put a stamp (help.figma.com "Stamps, emotes, and high-fives": "Hover your cursor over a stamp on the board to see who
// added it"): a small dark label over the hovered stamp, drawn on the board's decor layer, never saved. The name is what the
// stamp keeps (`board.by`); a stamp placed without a name shows nothing.

const LABEL_GAP = 6;
const LABEL_PAD = 6;
const LABEL_HEIGHT = 20;

/** The stamp under the hover (the stamp itself or its drawing) and who put it, or null. */
export function hoveredStampAuthor(doc: DesignDocument, hoverId: NodeId | null): {id: NodeId; name: string} | null {
  let node = hoverId ? doc.nodes[hoverId] : undefined;
  for (let depth = 0; node && depth < 2; depth++) {
    if (node.board?.kind === 'stamp') return node.board.by ? {id: node.id, name: node.board.by} : null;
    node = node.parentId ? doc.nodes[node.parentId] : undefined;
  }
  return null;
}

/** Whose label shows: the hovered stamp's; with no hover on a touch screen, the one selected stamp's (a tap selects it), so a
 *  finger can ask who put a stamp too. */
export function stampLabelTarget(hoverId: NodeId | null, selection: readonly NodeId[], touch: boolean): NodeId | null {
  return hoverId ?? (touch && selection.length === 1 ? selection[0] : null);
}

/** Draws the label centred over the stamp, in CSS px of the decor canvas (already scaled for device pixels). */
export function drawStampAuthor(ctx2d: CanvasRenderingContext2D, doc: DesignDocument, hoverId: NodeId | null, viewport: Viewport): void {
  const stamp = hoveredStampAuthor(doc, hoverId);
  if (!stamp) return;
  const box = worldBox(doc, stamp.id);
  const top: Vec = pageToScreen(viewport, {x: box.x + box.width / 2, y: box.y});
  ctx2d.save();
  ctx2d.font = '500 12px "Inter Variable", Inter, system-ui, sans-serif';
  const width = Math.ceil(ctx2d.measureText(stamp.name).width) + LABEL_PAD * 2;
  const x = Math.round(top.x - width / 2), y = Math.round(top.y - LABEL_GAP - LABEL_HEIGHT);
  ctx2d.fillStyle = '#1E1E1E';
  ctx2d.beginPath();
  ctx2d.roundRect(x, y, width, LABEL_HEIGHT, 6);
  ctx2d.fill();
  ctx2d.fillStyle = '#FFFFFF';
  ctx2d.textBaseline = 'middle';
  ctx2d.fillText(stamp.name, x + LABEL_PAD, y + LABEL_HEIGHT / 2 + 0.5);
  ctx2d.restore();
}
