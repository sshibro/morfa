// Browser side of the golden harness: loaded by harness.html under a bare Vite dev server
// (render.ts), it paints a fixture page with today's `paintNodeTree` the way a tile does (the spatial index,
// minSize 0.5, tiny text as bars) and answers with the PNG plus two region masks: where text is drawn (the text engine's,
// excluded from the bars) and where shadows and blurs reach (the softer bar). Everything is returned as
// base64 PNG strings so Playwright's `evaluate` can carry it.

import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import type {Rect} from '../../shared/design/geometry';
import {transformRect} from '../../shared/design/geometry';
import {renderBounds, unionRect} from '../../shared/design/bounds';
import {pageBackground} from '../../shared/design/defaults';
import {createFontRegistry} from '../../src/design/engine/fonts';
import {createImageCache} from '../../src/design/engine/images';
import {exportBounds, exportRaster, whenExportReady} from '../../src/design/engine/export-raster';
import {cssColor} from '../../src/design/engine/render/blend';
import {paintNodeTree, worldOfNode} from '../../src/design/engine/render/painter';
import {SpatialIndex} from '../../src/design/engine/render/spatial-index';
import {textLayoutOf, textRegion} from '../../src/design/engine/render/text-draw';
import {GREEK_BELOW_PX} from '../../src/design/engine/render/text-math';
import type {PaintOptions} from '../../src/design/engine/render/types';
import {FIXTURES} from './fixtures';

export type GoldenMeta = {
  fixture: string;
  page: NodeId;
  pageName: string;
  dpr: number;
  /** Page-space rectangle the image covers (the page bounds, clipped to the size cap). */
  area: Rect;
  width: number;
  height: number;
  nodes: number;
  textRects: number;
  effectRects: number;
  paintMs: number;
};
export type GoldenResult = {png: string; textMask: string; effectMask: string; meta: GoldenMeta};

const fonts = createFontRegistry({base: '/fonts'});
const images = createImageCache();
const built = new Map<string, DesignDocument>();

function documentOf(name: string): DesignDocument {
  let doc = built.get(name);
  if (!doc) {
    const fixture = FIXTURES.find(f => f.name === name);
    if (!fixture) throw new Error(`no fixture ${name}`);
    built.set(name, (doc = fixture.build()));
  }
  return doc;
}

const MASK_SLACK_PX = 2;

function isPainted(doc: DesignDocument, node: SceneNode): boolean {
  for (let n: SceneNode | undefined = node; n; n = n.parentId ? doc.nodes[n.parentId] : undefined) {
    if (n.visible === false) return false;
  }
  return true;
}

/** Device-px rectangles of every text node's region and of every node's effect-expanded bounds. */
function regions(doc: DesignDocument, pageId: NodeId, scale: number, origin: {x: number; y: number}): {text: Rect[]; effect: Rect[]} {
  const text: Rect[] = [], effect: Rect[] = [];
  const device = (rect: Rect): Rect => ({x: (rect.x - origin.x) * scale - MASK_SLACK_PX, y: (rect.y - origin.y) * scale - MASK_SLACK_PX, width: rect.width * scale + 2 * MASK_SLACK_PX, height: rect.height * scale + 2 * MASK_SLACK_PX});
  const onPage = (node: SceneNode) => {
    for (let n: SceneNode | undefined = node; n; n = n.parentId ? doc.nodes[n.parentId] : undefined) if (n.id === pageId) return true;
    return false;
  };
  for (const node of Object.values(doc.nodes)) {
    if (node.type === 'PAGE' || !onPage(node) || !isPainted(doc, node)) continue;
    if (node.type === 'TEXT') {
      const region = textRegion(node, textLayoutOf(node, fonts));
      text.push(device(transformRect(worldOfNode(doc, node), region)));
    }
    if (node.effects.some(e => e.visible !== false)) {
      const bounds = renderBounds(doc, node.id, {measurer: fonts.measurer});
      if (bounds) effect.push(device(bounds));
    }
  }
  return {text, effect};
}

async function toBase64(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('toBlob failed');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function maskPng(width: number, height: number, rects: Rect[]): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  for (const r of rects) ctx.fillRect(Math.floor(r.x), Math.floor(r.y), Math.ceil(r.width + (r.x - Math.floor(r.x))), Math.ceil(r.height + (r.y - Math.floor(r.y))));
  return toBase64(canvas);
}

/** Page bounds of a page's visible top-level content (what the editor's "zoom to fit" would frame). */
export function pageArea(doc: DesignDocument, pageId: NodeId): Rect | null {
  let area: Rect | null = null;
  for (const id of doc.nodes[pageId]?.children ?? []) {
    const rect = renderBounds(doc, id, {measurer: fonts.measurer});
    if (rect) area = area ? unionRect(area, rect) : rect;
  }
  return area;
}

export async function renderGolden(fixture: string, pageId: NodeId, dpr: number, maxSide: number): Promise<GoldenResult> {
  const doc = documentOf(fixture);
  const page = doc.nodes[pageId];
  if (!page || page.type !== 'PAGE') throw new Error(`no page ${pageId} in ${fixture}`);
  await whenExportReady(doc, [pageId], {fonts, images, timeoutMs: 15_000});
  const whole = pageArea(doc, pageId) ?? {x: 0, y: 0, width: 100, height: 100};
  // One px of page space around, snapped out, then the size cap from the top-left (big pages: the first screens).
  const pad = 2;
  const x0 = Math.floor(whole.x - pad), y0 = Math.floor(whole.y - pad);
  const fullW = Math.ceil(whole.x + whole.width + pad) - x0, fullH = Math.ceil(whole.y + whole.height + pad) - y0;
  const width = Math.min(maxSide, Math.ceil(fullW * dpr)), height = Math.min(maxSide, Math.ceil(fullH * dpr));
  const area: Rect = {x: x0, y: y0, width: width / dpr, height: height / dpr};

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = cssColor(pageBackground(page));
  ctx.fillRect(0, 0, width, height);
  const index = new SpatialIndex();
  index.sync(doc, pageId, fonts.measurer);
  const options: PaintOptions = {
    images,
    fonts,
    clip: {x: 0, y: 0, width, height},
    index,
    minSize: 0.5,
    greekBelow: GREEK_BELOW_PX,
  };
  const started = performance.now();
  paintNodeTree({ctx, transform: [[dpr, 0, -x0 * dpr], [0, dpr, -y0 * dpr]], scale: dpr}, doc, [pageId], options);
  const paintMs = performance.now() - started;
  const {text, effect} = regions(doc, pageId, dpr, {x: x0, y: y0});
  const [png, textMask, effectMask] = await Promise.all([toBase64(canvas), maskPng(width, height, text), maskPng(width, height, effect)]);
  return {
    png, textMask, effectMask,
    meta: {fixture, page: pageId, pageName: page.name, dpr, area, width, height, nodes: Object.keys(doc.nodes).length, textRects: text.length, effectRects: effect.length, paintMs},
  };
}

export type FrameExportResult = {png: string; textMask: string; effectMask: string; width: number; height: number; bounds: Rect; paintMs: number};

/** `exportRaster` of one layer (the editor's own PNG export at `scale`), with the text and effect masks of its page in
 *  the picture's frame: the reference the server's raster (scripts/render/raster-diff.ts) is scored against. */
export async function exportFrame(fixture: string, id: NodeId, scale: number): Promise<FrameExportResult> {
  const doc = documentOf(fixture);
  const node = doc.nodes[id];
  if (!node) throw new Error(`no layer ${id} in ${fixture}`);
  let pageId: NodeId = id;
  while (doc.nodes[pageId]?.type !== 'PAGE') pageId = doc.nodes[pageId].parentId!;
  await whenExportReady(doc, [id], {fonts, images, timeoutMs: 15_000});
  const bounds = exportBounds(doc, [id], fonts);
  if (!bounds) throw new Error(`${fixture}/${id} paints nothing`);
  const started = performance.now();
  const blob = await exportRaster(doc, [id], {format: 'PNG', constraint: {type: 'SCALE', value: scale}}, {fonts, images, timeoutMs: 15_000});
  const paintMs = performance.now() - started;
  const bitmap = await createImageBitmap(blob);
  const {width, height} = bitmap;
  bitmap.close();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const {text, effect} = regions(doc, pageId, scale, {x: bounds.x, y: bounds.y});
  const [textMask, effectMask] = await Promise.all([maskPng(width, height, text), maskPng(width, height, effect)]);
  return {png: btoa(binary), textMask, effectMask, width, height, bounds, paintMs};
}

export function listFixtures(): {name: string; source: string; pages: {id: NodeId; name: string; nodes: number}[]}[] {
  return FIXTURES.map(fixture => {
    const doc = documentOf(fixture.name);
    const count = (pageId: NodeId) => {
      let n = 0;
      const stack = [pageId];
      while (stack.length) {
        const node = doc.nodes[stack.pop()!];
        if (!node) continue;
        n++;
        if (node.children) stack.push(...node.children);
      }
      return n;
    };
    return {name: fixture.name, source: fixture.source, pages: doc.pages.map(id => ({id, name: doc.nodes[id].name, nodes: count(id)}))};
  });
}

declare global {
  interface Window {
    goldens: {listFixtures: typeof listFixtures; renderGolden: typeof renderGolden; exportFrame: typeof exportFrame; fontsIdle(): Promise<void>};
  }
}
window.goldens = {listFixtures, renderGolden, exportFrame, fontsIdle: () => fonts.whenIdle()};
document.getElementById('out')!.textContent = `goldens harness: ${FIXTURES.length} fixtures`;
document.getElementById('out')!.dataset.state = 'ready';
