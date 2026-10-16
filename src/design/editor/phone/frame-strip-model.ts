import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import type {Rect} from '../../../../shared/design/geometry';
import {isFrameLikeNode} from '../../../../shared/design/tree';
import type {Viewport} from '../../engine/contracts';
import {fitRect} from '../../engine/viewport';

// The phone's frame strip (Figma's app has a preview slider): the page's
// top-level frames in a row, a tap shows the frame whole between the bars. Pure, tested in node.

/** CSS px kept around a frame shown from the strip. */
const STRIP_FIT_PADDING = 16;

export type StripFrame = {id: NodeId; name: string};

/** The page's top-level frames (sections' frames too, as Figma's slider lists them), in layer order, hidden ones left out. */
export function stripFrames(doc: DesignDocument, pageId: NodeId): StripFrame[] {
  const out: StripFrame[] = [];
  const walk = (ids: readonly NodeId[] | undefined) => {
    for (const id of ids ?? []) {
      const node = doc.nodes[id];
      if (!node || node.visible === false) continue;
      if (node.type === 'SECTION') walk(node.children);
      else if (isFrameLikeNode(node) && node.type !== 'GROUP') out.push({id, name: node.name || 'Frame'});
    }
  };
  walk(doc.nodes[pageId]?.children);
  return out;
}

/** The viewport that shows `rect` whole in the part of a `size` canvas left between `top` and `bottom` px of bars. */
export function viewportBetweenBars(size: {width: number; height: number}, rect: Rect, top: number, bottom: number): Viewport {
  const room = {width: size.width, height: Math.max(1, size.height - top - bottom)};
  const fitted = fitRect(room, rect, STRIP_FIT_PADDING);
  return {...fitted, y: fitted.y - top / fitted.zoom};
}
