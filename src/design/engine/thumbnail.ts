import type {DesignDocument, NodeId} from '../../../shared/design/types';
import {FRAME_LIKE_TYPES} from '../../../shared/design/types';
import type {Rect} from '../../../shared/design/geometry';
import {unionRects} from '../../../shared/design/geometry';
import {renderBounds} from '../../../shared/design/bounds';
import {pageBackground} from '../../../shared/design/defaults';
import {DESIGN_DOCUMENT_CAPS} from '../../../shared/design/limits';
import {cssColor} from './render/blend';
import type {Ctx2D} from './render/canvas';
import {createCanvas} from './render/canvas';
import {paintNodeTree} from './render/painter';
import type {ExportDeps} from './export-raster';
import {encodeCanvas, whenExportReady} from './export-raster';

// The file card's picture (PUT /api/design-files/:id/thumbnail): the first page's top-level content
// fitted into a 4:3 card on the page background. When the page holds many frames spread far apart
// (each would shrink to a speck), the first frame stands for the file instead, as in Figma.

/** What the thumbnail shows: every top-level layer, or the first frame when the layers are spread so
 *  thin that together they fill less than a sixth of their combined area. */
export function thumbnailContent(doc: DesignDocument, measure?: ExportDeps['fonts']): {ids: NodeId[]; bounds: Rect} | null {
  const page = doc.nodes[doc.pages[0]];
  const ids = (page?.children ?? []).filter(id => {
    const node = doc.nodes[id];
    return node && node.visible !== false && node.type !== 'SLICE';
  });
  const boxes = ids.map(id => ({id, rect: renderBounds(doc, id, {measurer: measure?.measurer})})).filter((item): item is {id: NodeId; rect: Rect} => !!item.rect);
  const all = unionRects(boxes.map(item => item.rect));
  if (!all) return null;
  const frames = boxes.filter(item => FRAME_LIKE_TYPES.includes(doc.nodes[item.id].type) || doc.nodes[item.id].type === 'SECTION');
  const covered = boxes.reduce((sum, item) => sum + item.rect.width * item.rect.height, 0);
  if (frames.length > 1 && covered * 6 < all.width * all.height) return {ids: [frames[0].id], bounds: frames[0].rect};
  return {ids: boxes.map(item => item.id), bounds: all};
}

/** Lets input, frames and the editor's own work run before the next slice of a background picture. */
export const nextTask = (): Promise<void> => new Promise(resolve => {
  const scheduler = (globalThis as {scheduler?: {postTask?: (task: () => void, options: {priority: string}) => unknown}}).scheduler;
  if (scheduler?.postTask) scheduler.postTask(resolve, {priority: 'background'});
  else setTimeout(resolve, 0);
});

/** Paints the roots a few at a time, giving way after about `sliceMs`. The card picture is taken while the designer
 *  works (a few seconds after an edit), and a first page of 40 screens of 500 layers painted in one go held the editor
 *  for about 250 ms — a second at a quarter of the speed. `paintNodeTree` paints a list of roots one after the other,
 *  each with its own world transform, so painting them in turn makes the same picture (checked pixel for pixel). */
export async function paintRootsInTurn(paint: (ids: readonly NodeId[]) => void, ids: readonly NodeId[], pause: () => Promise<void> = nextTask, sliceMs = 8, now: () => number = () => performance.now()): Promise<void> {
  let at = 0;
  while (at < ids.length) {
    if (at) await pause();
    const started = now();
    // One root, then more while the slice lasts: each call paints consecutive roots in their order.
    let end = at + 1;
    paint(ids.slice(at, end));
    while (end < ids.length && now() - started < sliceMs) {
      paint(ids.slice(end, end + 1));
      end++;
    }
    at = end;
  }
}

/** Renders the thumbnail: WEBP (PNG where the browser cannot), at most `maxSide` px wide and
 *  512 KB, lowering quality and then size until it fits. */
export async function renderThumbnail(doc: DesignDocument, deps: ExportDeps, maxSide = 480, pause: () => Promise<void> = nextTask): Promise<Blob> {
  const page = doc.nodes[doc.pages[0]];
  const content = thumbnailContent(doc, deps.fonts);
  if (content) await whenExportReady(doc, content.ids, {...deps, timeoutMs: deps.timeoutMs ?? 8000});
  // Stored and shown in both themes: a page without its own colour uses the light canvas.
  const background = cssColor(pageBackground(page));
  let side = Math.max(16, Math.round(maxSide));
  for (let attempt = 0; attempt < 6; attempt++) {
    const width = side, height = Math.round(side * 0.75);
    const canvas = createCanvas(width, height);
    const ctx = (canvas as OffscreenCanvas).getContext('2d') as Ctx2D;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    if (content) {
      const pad = Math.round(Math.min(width, height) * 0.06);
      const b = content.bounds;
      const scale = Math.min((width - 2 * pad) / Math.max(b.width, 1e-6), (height - 2 * pad) / Math.max(b.height, 1e-6), 4);
      const x = (width - b.width * scale) / 2 - b.x * scale, y = (height - b.height * scale) / 2 - b.y * scale;
      const options = {images: deps.images, fonts: deps.fonts, booleanGeometry: deps.booleanGeometry};
      await paintRootsInTurn(ids => paintNodeTree({ctx, transform: [[scale, 0, x], [0, scale, y]], scale}, doc, ids, options), content.ids, pause);
    }
    for (const quality of [0.86, 0.72, 0.55]) {
      let blob: Blob;
      try {
        blob = await encodeCanvas(canvas, 'WEBP', quality);
      } catch {
        blob = await encodeCanvas(canvas, 'PNG');
      }
      if (blob.size <= DESIGN_DOCUMENT_CAPS.thumbnailBytes) return blob;
      if (blob.type === 'image/png') break;
    }
    side = Math.round(side * 0.75);
  }
  throw new Error('Could not fit the file thumbnail into 512 KB.');
}
