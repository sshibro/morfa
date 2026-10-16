// Browser side of gpu-dots.ts (lane K): one empty board page's tile, rasterized by the editor's GPU path (vello into the
// atlas, read back) and by its Canvas2D path (background, then paintDotGrid on the tile's raster target), compared pixel by pixel.

import {createDocument, createNode, pageBackground, solid} from '../../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../../shared/design/types';
import {createFontRegistry} from '../../src/design/engine/fonts';
import {createImageCache} from '../../src/design/engine/images';
import {paintNodeTree} from '../../src/design/engine/render/painter';
import {SpatialIndex} from '../../src/design/engine/render/spatial-index';
import {renderWasm, type RenderWasmGpu} from '../../shared/design/render-engine';
import {loadRenderWasm} from '../../src/design/engine/render-wasm';
import {cssColor} from '../../src/design/engine/render/blend';
import {DOT_RGBA, dotSquares, paintDotGrid} from '../../src/design/engine/render/dot-grid';
import {TILE} from '../../src/design/engine/render/tile-math';

export type DotCase = {zoom: number; dpr: number; i: number; j: number; margin: number; background: {r: number; g: number; b: number}};
export type DotResult = DotCase & {scale: number; dots: number; dotPixels: number; differing: number; maxDelta: number; first: string | null};

let gpu: RenderWasmGpu | null = null;

async function ready(): Promise<RenderWasmGpu> {
  if (gpu) return gpu;
  await loadRenderWasm();
  const wasm = renderWasm();
  if (!wasm.GpuRenderer) throw new Error('the web build has no GpuRenderer');
  gpu = await wasm.GpuRenderer.create(document.getElementById('scene') as HTMLCanvasElement, 4);
  return gpu;
}

export async function compareDots(cases: DotCase[]): Promise<DotResult[]> {
  const renderer = await ready();
  const results: DotResult[] = [];
  for (const c of cases) {
    const doc = createDocument('board');
    doc.nodes.board = {...doc.nodes.board, backgroundColor: {...c.background, a: 1}} as typeof doc.nodes.board;
    const shadow = new (renderWasm().RenderDoc)(JSON.stringify(doc));
    const bg = pageBackground(doc.nodes.board);
    // The tile's level scale as the editor picks it at a settled zoom: device px per page px.
    const scale = c.zoom * c.dpr;
    const size = TILE + 2 * c.margin;
    const origin = {x: (c.i * TILE - c.margin) / scale, y: (c.j * TILE - c.margin) / scale};
    const squares = dotSquares(origin, scale, c.dpr, size, size);
    const options = JSON.stringify({minSize: 0.5, spriteScale: scale, dotGrid: {...squares, color: DOT_RGBA}});
    renderer.raster_tile(shadow, 'board', scale, c.i, c.j, 0, bg.r, bg.g, bg.b, c.margin, options);
    const gpuPixels = await renderer.read_tile(0);
    shadow.free();
    // Canvas2D: the scene renderer's full raster (scene-renderer.ts `raster`), margin included, then the tile cut out of it.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', {willReadFrequently: true})!;
    ctx.fillStyle = cssColor(bg);
    ctx.fillRect(0, 0, size, size);
    paintDotGrid(ctx, origin, scale, c.dpr, size, size);
    const cpu = ctx.getImageData(c.margin, c.margin, TILE, TILE).data;
    const paper = [bg.r, bg.g, bg.b].map(v => Math.round(v * 255));
    let differing = 0, maxDelta = 0, first: string | null = null, dotPixels = 0;
    for (let p = 0; p < TILE * TILE; p++) {
      if (cpu[p * 4] !== paper[0] || cpu[p * 4 + 1] !== paper[1] || cpu[p * 4 + 2] !== paper[2]) dotPixels++;
      let delta = 0;
      for (let k = 0; k < 4; k++) delta = Math.max(delta, Math.abs(cpu[p * 4 + k] - gpuPixels[p * 4 + k]));
      if (!delta) continue;
      differing++;
      maxDelta = Math.max(maxDelta, delta);
      first ??= `(${p % TILE}, ${Math.floor(p / TILE)}) canvas2d ${[...cpu.slice(p * 4, p * 4 + 4)]} gpu ${[...gpuPixels.slice(p * 4, p * 4 + 4)]}`;
    }
    results.push({...c, scale, dots: squares.lefts.length * squares.tops.length, dotPixels, differing, maxDelta, first});
  }
  return results;
}

// ── A board section with "hide contents" (lane G's `board: {kind: 'section', hidden: true}`) ──

export type HiddenResult = {path: 'canvas2d' | 'gpu'; hiddenVsEmpty: number; shownVsEmpty: number};

/** A board page with one section: `children` (layers inside it, one reaching outside it) or none, hidden or not. */
function sectionPage(children: boolean, hidden: boolean): DesignDocument {
  const doc = createDocument('board');
  const section = createNode('SECTION', {id: 's', name: 'Section', x: 40, y: 40, width: 360, height: 240, fills: [solid({r: 0.9, g: 0.95, b: 1})], cornerRadius: 16,
    strokes: [solid({r: 0.2, g: 0.5, b: 0.9})], strokeWeight: 1, strokeAlign: 'INSIDE', board: {kind: 'section', ...(hidden ? {hidden: true} : {})}, children: []}) as SceneNode;
  doc.nodes.s = section;
  doc.nodes.board = {...doc.nodes.board, children: ['s']};
  if (children) {
    const kids = [
      createNode('RECTANGLE', {id: 'k1', parentId: 's', x: 30, y: 40, width: 120, height: 80, fills: [solid({r: 0.9, g: 0.3, b: 0.2})]}),
      createNode('ELLIPSE', {id: 'k2', parentId: 's', x: 200, y: 100, width: 100, height: 100, fills: [solid({r: 0.2, g: 0.7, b: 0.3})]}),
      // Reaching past the section's right edge (a section does not clip).
      createNode('RECTANGLE', {id: 'k3', parentId: 's', x: 320, y: 20, width: 90, height: 40, fills: [solid({r: 0.5, g: 0.2, b: 0.8})]}),
    ] as SceneNode[];
    for (const kid of kids) doc.nodes[kid.id] = kid;
    doc.nodes.s = {...doc.nodes.s, children: kids.map(k => k.id)};
  }
  return doc;
}

const fonts = createFontRegistry({base: '/fonts'});
const images = createImageCache();

function paintCanvas(doc: DesignDocument): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext('2d', {willReadFrequently: true})!;
  ctx.fillStyle = cssColor(pageBackground(doc.nodes.board));
  ctx.fillRect(0, 0, TILE, TILE);
  const index = new SpatialIndex();
  index.sync(doc, 'board', fonts.measurer);
  paintNodeTree({ctx, transform: [[1, 0, 0], [0, 1, 0]], scale: 1}, doc, ['board'], {images, fonts, clip: {x: 0, y: 0, width: TILE, height: TILE}, index, minSize: 0.5});
  return ctx.getImageData(0, 0, TILE, TILE).data;
}

async function paintGpu(doc: DesignDocument): Promise<Uint8Array> {
  const renderer = await ready();
  const shadow = new (renderWasm().RenderDoc)(JSON.stringify(doc));
  const bg = pageBackground(doc.nodes.board);
  renderer.raster_tile(shadow, 'board', 1, 0, 0, 0, bg.r, bg.g, bg.b, 0, JSON.stringify({minSize: 0.5, spriteScale: 1}));
  const pixels = await renderer.read_tile(0);
  shadow.free();
  return pixels;
}

const differing = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let n = 0;
  for (let p = 0; p < a.length; p += 4) if (a[p] !== b[p] || a[p + 1] !== b[p + 1] || a[p + 2] !== b[p + 2] || a[p + 3] !== b[p + 3]) n++;
  return n;
};

/** A hidden section with layers against the same section empty (must be 0), and shown against empty (must not be 0). */
export async function compareHiddenSection(): Promise<HiddenResult[]> {
  const hidden = sectionPage(true, true), empty = sectionPage(false, true), shown = sectionPage(true, false), emptyShown = sectionPage(false, false);
  const out: HiddenResult[] = [];
  out.push({path: 'canvas2d', hiddenVsEmpty: differing(paintCanvas(hidden), paintCanvas(empty)), shownVsEmpty: differing(paintCanvas(shown), paintCanvas(emptyShown))});
  out.push({path: 'gpu', hiddenVsEmpty: differing(await paintGpu(hidden), await paintGpu(empty)), shownVsEmpty: differing(await paintGpu(shown), await paintGpu(emptyShown))});
  return out;
}

(globalThis as {compareHiddenSection?: typeof compareHiddenSection}).compareHiddenSection = compareHiddenSection;
(globalThis as {compareDots?: typeof compareDots}).compareDots = compareDots;
document.title += ' — ready';
