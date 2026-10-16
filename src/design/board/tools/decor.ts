import type {NodeId, Vec} from '../../../../shared/design/types';
import {apply, worldMatrix, type Rect} from '../../../../shared/design/geometry';
import {childPart, isSticky} from '../../../../shared/design/board/model';
import {comparePaintPaths, isAncestor, paintPath, type SpatialIndex} from '../../../../shared/design/tree';
import type {DesignDocument} from '../../../../shared/design/types';
import type {Viewport} from '../../engine/contracts';
import type {EditorState} from '../../engine/store';
import {pageToScreen, visiblePageRect} from '../../engine/viewport';
import {drawStampAuthor, stampLabelTarget} from './stamp-label';

// What the board draws over the canvas beside the tools (docs/board.md §Stickies): the grey hint in an empty sticky, and who put
// the hovered stamp (stamp-label.ts). On its own
// layer (src/design/board/editor/Decor.tsx) whatever tool is in hand, so it is never exported, printed or seen in a thumbnail; at
// most a screenful of notes is looked at.

export const STICKY_PLACEHOLDER = 'Write something';
const MAX_NOTES = 400;

/** Draws the hints in CSS px of a canvas `size` big showing `viewport`; the context is already scaled for the device pixels.
 *  `touch`: the screen has no hover (a selected stamp shows who put it). */
export function drawBoardDecor(ctx2d: CanvasRenderingContext2D, state: EditorState, viewport: Viewport, size: {width: number; height: number}, index: SpatialIndex | null, touch = false) {
  drawStampAuthor(ctx2d, state.doc, stampLabelTarget(state.hoverId, state.selection, touch), viewport);
  if (viewport.zoom < 0.2 || !index) return;
  const visible = visiblePageRect(viewport, size);
  const seen = new Set<NodeId>();
  const toScreen = (point: Vec) => pageToScreen(viewport, point);
  let count = 0;
  ctx2d.save();
  ctx2d.textBaseline = 'top';
  for (const id of index.query(visible)) {
    if (count > MAX_NOTES) break;
    const node = state.doc.nodes[id];
    if (!isSticky(node) || seen.has(id) || !node.visible) continue;
    seen.add(id);
    const text = childPart(nodeId => (nodeId ? state.doc.nodes[nodeId] : undefined), node, 'text');
    if (!text?.text || text.text.characters.length || state.editing?.id === text.id) continue;
    count++;
    const m = worldMatrix(state.doc, text.id);
    const corner = apply(m, {x: 0, y: 0});
    const origin = toScreen(corner);
    const fontSize = text.text.style.fontSize * viewport.zoom;
    if (fontSize < 5) continue;
    const line = {x: corner.x, y: corner.y, width: text.width, height: text.text.style.fontSize * 1.2};
    if (hintCovered(state.doc, index, id, line)) continue;
    ctx2d.font = `400 ${fontSize}px "${text.text.style.fontFamily}", "Inter Variable", Inter, system-ui, sans-serif`;
    ctx2d.fillStyle = 'rgba(30, 30, 30, 0.38)';
    ctx2d.fillText(STICKY_PLACEHOLDER, origin.x, origin.y + fontSize * 0.1, Math.max(0, text.width * viewport.zoom));
  }
  ctx2d.restore();
}

/** True when something painted after the note (another note, a shape, a stroke) meets its hint's line: the hint, drawn over the
 *  canvas, would otherwise show through whatever lies on the note. */
export function hintCovered(doc: DesignDocument, index: SpatialIndex, stickyId: NodeId, line: Rect): boolean {
  const own = paintPath(doc, stickyId);
  for (const id of index.query(line)) {
    if (id === stickyId || isAncestor(doc, stickyId, id) || isAncestor(doc, id, stickyId)) continue;
    const node = doc.nodes[id];
    if (!node || node.visible === false) continue;
    if (comparePaintPaths(paintPath(doc, id), own) > 0) return true;
  }
  return false;
}
