import type {DesignDocument, Hyperlink, Matrix, NodeId, SceneNode, TextProps, Vec} from '../../../../shared/design/types';
import {FRAME_LIKE_TYPES} from '../../../../shared/design/types';
import {IDENTITY, multiply, transformRect, type Rect} from '../../../../shared/design/geometry';
import {hotspotContains, intersectRect, placedLocal, type Hotspot, type ScrollOffsets} from '../../../../shared/design/prototype';
import {layoutText, offsetAt, type TextMeasurer} from '../../../../shared/design/text-layout';
import {hyperlinkAt} from '../../../../shared/design/text-edit';

// Links in text play in the prototype as in Figma's: a click on linked words opens the address in a new tab, and a link to
// a frame of the file goes to that frame. The player (engine.ts) asks here when a click found no interaction to run.

const hasLink = (text: TextProps | undefined) => !!text && (!!text.style.hyperlink || text.runs.some(run => !!run.style.hyperlink));

/** The texts with a link on a shown frame, where they are now (topmost first), in the frame's space. */
export function linkSpotsOf(doc: DesignDocument, rootId: NodeId, scroll: ScrollOffsets, rootView: {width: number; height: number}): Hotspot[] {
  const out: Hotspot[] = [];
  const root = doc.nodes[rootId];
  if (!root) return out;
  const screen: Rect = {x: 0, y: 0, width: rootView.width, height: rootView.height};
  const walk = (node: SceneNode, m: Matrix, clip: Rect, depth: number) => {
    if (node.visible === false || depth > 256) return;
    if (node.type === 'TEXT' && hasLink(node.text)) {
      const rect = intersectRect(transformRect(m, {x: 0, y: 0, width: node.width, height: node.height}), clip);
      if (rect) out.push({id: node.id, matrix: m, width: node.width, height: node.height, clip, rect});
    }
    if (!node.children || node.type === 'BOOLEAN_OPERATION') return;
    const own = node.id === rootId ? screen : FRAME_LIKE_TYPES.includes(node.type) && node.clipsContent !== false ? transformRect(m, {x: 0, y: 0, width: node.width, height: node.height}) : null;
    const inner = own ? intersectRect(clip, own) : clip;
    if (!inner) return;
    for (const childId of node.children) {
      const child = doc.nodes[childId];
      if (child) walk(child, multiply(m, placedLocal(child, scroll[node.id])), inner, depth + 1);
    }
  };
  walk(root, IDENTITY, screen, 0);
  return out.reverse();
}

/** The link under `point` (frame space): on the ink of a linked character, not just inside the text's box. */
export function linkAt(doc: DesignDocument, spots: readonly Hotspot[], point: Vec, measurer: TextMeasurer): {hyperlink: Hyperlink; spot: Hotspot} | null {
  for (const spot of spots) {
    if (!hotspotContains(spot, point)) continue;
    const node = doc.nodes[spot.id];
    if (!node?.text) continue;
    const [[a, c, e], [b, d, f]] = spot.matrix;
    const det = a * d - b * c;
    if (!det) continue;
    const px = point.x - e, py = point.y - f;
    const local = {x: (d * px - c * py) / det, y: (a * py - b * px) / det};
    const layout = layoutText(node, measurer);
    const hit = offsetAt(layout, local);
    const line = layout.lines[hit.lineIndex];
    if (!line || local.x < line.x || local.x > line.x + line.width || local.y < line.top || local.y > line.top + line.height) continue;
    const found = hyperlinkAt(node.text, hit.offset);
    if (found) return {hyperlink: found.hyperlink, spot};
  }
  return null;
}
