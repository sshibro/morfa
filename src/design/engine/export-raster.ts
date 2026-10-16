import type {DesignDocument, NodeId, SceneNode, VectorPath} from '../../../shared/design/types';
import {FRAME_LIKE_TYPES} from '../../../shared/design/types';
import type {Rect} from '../../../shared/design/geometry';
import {transformRect, unionRects, worldBox, worldMatrix} from '../../../shared/design/geometry';
import {renderBounds} from '../../../shared/design/bounds';
import type {FontSpec} from '../../../shared/design/text-layout';
import {fontSpecOf} from '../../../shared/design/text-layout';
import type {FontRegistry, ImageCache} from './contracts';
import type {AnyCanvas, Ctx2D} from './render/canvas';
import {createCanvas} from './render/canvas';
import {paintNodeTree} from './render/painter';

// PNG, JPG and WEBP export ("Export"): the selected layers painted by the same painter as the
// canvas, at the size the export setting asks for, after every font and picture they use has
// arrived. Frames export exactly their box (clipped, like an artboard); other layers export
// everything they paint, shadows and strokes included.

export type RasterFormat = 'PNG' | 'JPG' | 'WEBP';
export type RasterExportSettings = {
  format: RasterFormat;
  constraint: {type: 'SCALE' | 'WIDTH' | 'HEIGHT'; value: number};
  /** 0..1 for JPG and WEBP (default 0.92). */
  quality?: number;
};
export type ExportDeps = {
  images: ImageCache;
  fonts: FontRegistry;
  booleanGeometry?: (doc: DesignDocument, id: NodeId) => readonly VectorPath[] | null;
  /** Longest wait for fonts and pictures before painting with what has arrived (default 20 s). */
  timeoutMs?: number;
};

export const EXPORT_MAX_SIDE = 16384;
/** 256 Mpx, a little under the 2^28 px a Chromium canvas holds. */
export const EXPORT_MAX_PIXELS = 256_000_000;

export class ExportError extends Error {
  constructor(message: string, readonly code: 'too_large' | 'empty' | 'format') {
    super(message);
    this.name = 'ExportError';
  }
}

const MIME: Record<RasterFormat, string> = {PNG: 'image/png', JPG: 'image/jpeg', WEBP: 'image/webp'};
const isFrameLike = (node: SceneNode) => FRAME_LIKE_TYPES.includes(node.type);

/** Output size in px for bounds under a constraint: SCALE multiplies, WIDTH/HEIGHT fit one side.
 *  Throws a Russian ExportError when the image would be empty or larger than browsers can encode. */
export function exportPixelSize(bounds: Rect, constraint: RasterExportSettings['constraint']): {width: number; height: number; scale: number} {
  if (!(bounds.width > 0) || !(bounds.height > 0)) throw new ExportError('Nothing to export: the layer has no visible content.', 'empty');
  const value = Number.isFinite(constraint.value) && constraint.value > 0 ? constraint.value : 1;
  const scale = constraint.type === 'WIDTH' ? value / bounds.width : constraint.type === 'HEIGHT' ? value / bounds.height : value;
  const width = Math.max(1, Math.round(bounds.width * scale)), height = Math.max(1, Math.round(bounds.height * scale));
  if (width > EXPORT_MAX_SIDE || height > EXPORT_MAX_SIDE || width * height > EXPORT_MAX_PIXELS) {
    const format = (n: number) => n.toLocaleString('en-US');
    throw new ExportError(
      `The image is too large: ${format(width)} × ${format(height)} px. The browser saves at most ${format(EXPORT_MAX_SIDE)} px per side and 256 MP — reduce the export scale.`,
      'too_large',
    );
  }
  return {width, height, scale};
}

/** Page-space area an export of `ids` covers: a frame's box, or what another layer paints. */
export function exportBounds(doc: DesignDocument, ids: readonly NodeId[], fonts?: FontRegistry): Rect | null {
  const rects: Rect[] = [];
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    const rect = isFrameLike(node) || node.type === 'SLICE' ? worldBox(doc, id) : renderBounds(doc, id, {measurer: fonts?.measurer, includeHidden: true});
    if (rect) rects.push(rect);
  }
  return unionRects(rects);
}

/** Every face the text under `rootId` sets type in. */
export function fontSpecsUnder(doc: DesignDocument, rootId: NodeId): FontSpec[] {
  const out = new Map<string, FontSpec>();
  const stack = [rootId];
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    if (node.text) {
      for (const style of [node.text.style, ...node.text.runs.map(run => ({...node.text!.style, ...run.style}))]) {
        const spec = fontSpecOf(style);
        out.set(`${spec.family}|${spec.weight}|${spec.italic}`, spec);
      }
    }
    if (node.children) stack.push(...node.children);
  }
  return [...out.values()];
}

/** Waits until the fonts and pictures under the roots are usable (or the timeout passes). */
export async function whenExportReady(doc: DesignDocument, rootIds: readonly NodeId[], deps: ExportDeps): Promise<void> {
  const work = Promise.all(rootIds.flatMap(id => [...fontSpecsUnder(doc, id).map(spec => deps.fonts.ensure(spec)), deps.images.whenReady(doc, id)]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, deps.timeoutMs ?? 20_000);
  });
  await Promise.race([work.then(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
}

export async function encodeCanvas(canvas: AnyCanvas, format: RasterFormat, quality?: number): Promise<Blob> {
  const type = MIME[format];
  const q = format === 'PNG' ? undefined : Math.min(1, Math.max(0, quality ?? 0.92));
  const blob = 'convertToBlob' in canvas
    ? await canvas.convertToBlob({type, quality: q})
    : await new Promise<Blob | null>(resolve => (canvas as HTMLCanvasElement).toBlob(resolve, type, q));
  if (!blob) throw new ExportError('Could not save the image: the browser ran out of memory.', 'too_large');
  if (blob.type !== type) throw new ExportError(`This browser cannot save ${format}. Choose PNG or JPG.`, 'format');
  return blob;
}

/** Order of nodes as they paint (for exporting several layers together). */
function paintOrder(doc: DesignDocument, ids: readonly NodeId[]): NodeId[] {
  const path = (id: NodeId) => {
    const out: number[] = [];
    for (let node = doc.nodes[id]; node?.parentId; node = doc.nodes[node.parentId]) out.unshift(doc.nodes[node.parentId]?.children?.indexOf(node.id) ?? 0);
    const page = doc.pages.indexOf(rootOf(doc, id));
    return [page, ...out];
  };
  const paths = new Map(ids.map(id => [id, path(id)]));
  return [...ids].sort((a, b) => {
    const pa = paths.get(a)!, pb = paths.get(b)!;
    for (let k = 0; k < Math.min(pa.length, pb.length); k++) if (pa[k] !== pb[k]) return pa[k] - pb[k];
    return pa.length - pb.length;
  });
}

function rootOf(doc: DesignDocument, id: NodeId): NodeId {
  let node = doc.nodes[id];
  while (node?.parentId) node = doc.nodes[node.parentId];
  return node?.id ?? id;
}

function paintArea(doc: DesignDocument, rootIds: readonly NodeId[], bounds: Rect, settings: RasterExportSettings, deps: ExportDeps, background: string | null): Promise<Blob> {
  const {width, height} = exportPixelSize(bounds, settings.constraint);
  const canvas = createCanvas(width, height);
  const ctx = (canvas as OffscreenCanvas).getContext('2d') as Ctx2D | null;
  if (!ctx) throw new ExportError('Could not save the image: the browser ran out of memory.', 'too_large');
  if (background || settings.format === 'JPG') {
    ctx.fillStyle = background ?? '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
  }
  const sx = width / bounds.width, sy = height / bounds.height;
  paintNodeTree({ctx, transform: [[sx, 0, -bounds.x * sx], [0, sy, -bounds.y * sy]], scale: Math.sqrt(sx * sy)}, doc, rootIds, {
    images: deps.images,
    fonts: deps.fonts,
    booleanGeometry: deps.booleanGeometry,
    paintHiddenRoots: true,
  });
  return encodeCanvas(canvas, settings.format, settings.quality);
}

/** Exports layers as one picture. A single slice exports the region under it (`exportRegion`). */
export async function exportRaster(doc: DesignDocument, ids: readonly NodeId[], settings: RasterExportSettings, deps: ExportDeps): Promise<Blob> {
  const present = ids.filter(id => doc.nodes[id]);
  if (present.length === 1 && doc.nodes[present[0]].type === 'SLICE') return exportRegion(doc, present[0], settings, deps);
  if (!present.length) throw new ExportError('Nothing to export: select a layer.', 'empty');
  await whenExportReady(doc, present, deps);
  const bounds = exportBounds(doc, present, deps.fonts);
  if (!bounds) throw new ExportError('Nothing to export: the layer has no visible content.', 'empty');
  return paintArea(doc, paintOrder(doc, present), bounds, settings, deps, null);
}

/** Exports everything visible under a slice's box on its page ("Slice"). Transparent for PNG and
 *  WEBP; JPG gets white where nothing is painted. */
export async function exportRegion(doc: DesignDocument, sliceId: NodeId, settings: RasterExportSettings, deps: ExportDeps): Promise<Blob> {
  const slice = doc.nodes[sliceId];
  if (!slice) throw new ExportError('Nothing to export: select a layer.', 'empty');
  const pageId = rootOf(doc, sliceId);
  const page = doc.nodes[pageId];
  const bounds = transformRect(worldMatrix(doc, sliceId), {x: 0, y: 0, width: slice.width, height: slice.height});
  const roots = (page?.children ?? []).filter(id => doc.nodes[id]?.visible !== false);
  await whenExportReady(doc, roots, deps);
  return paintArea(doc, [pageId], bounds, settings, deps, null);
}
