// Browser side of the GPU renderer harness: loaded by gpu-harness.html under the bare Vite
// server of render.ts (scripts/goldens/gpu.ts drives it in headless Chromium with WebGPU — SwiftShader in the cloud,
// the real GPU on the Mac). It paints a fixture page the way the editor's GPU renderer does — the renderer's own
// document shadow, pictures and Canvas2D text sprites, 512 px tiles rasterized by vello into the atlas — reads the
// tiles back and stitches them into the golden's framing, so scripts/goldens/ssim.ts can judge the picture text
// included. `seamFrame` draws one frame of the real scene renderer (tiles composited to the canvas, live layer) at a
// zoom and DPR for the seam screenshots.

import type {DesignDocument, NodeId} from '../../shared/design/types';
import type {Rect} from '../../shared/design/geometry';
import {pageBackground} from '../../shared/design/defaults';
import {renderWasm, type RenderWasmGpu} from '../../shared/design/render-engine';
import {setEngine} from '../../shared/design/engine-switch';
import {createFontRegistry} from '../../src/design/engine/fonts';
import {createImageCache} from '../../src/design/engine/images';
import {whenExportReady} from '../../src/design/engine/export-raster';
import {loadRenderWasm} from '../../src/design/engine/render-wasm';
import {atlasCapacity, createGpuSceneRenderer} from '../../src/design/engine/render/gpu/gpu-scene-renderer';
import {RenderShadow} from '../../src/design/engine/render/gpu/render-shadow';
import {paintSprites} from '../../src/design/engine/render/gpu/text-sprites';
import type {DesignSceneRenderer, RenderStats} from '../../src/design/engine/render/scene-renderer';
import {SpatialIndex} from '../../src/design/engine/render/spatial-index';
import {TILE} from '../../src/design/engine/render/tile-math';
import {FIXTURES, generatedPage} from './fixtures';
import type {GoldenMeta} from './harness';
import {listFixtures, pageArea} from './harness-shared';

const fonts = createFontRegistry({base: '/fonts'});
const images = createImageCache();
const built = new Map<string, DesignDocument>();
const canvas = document.getElementById('scene') as HTMLCanvasElement;
let gpu: RenderWasmGpu | null = null;
let adapter = '';

function documentOf(name: string): DesignDocument {
  let doc = built.get(name);
  if (!doc) {
    // `generated-<layers>`: a page of that many layers in B0's gen-file shape (f20k = 20041, f100k = 100000, f500k = 500000).
    const generated = /^generated-(\d+)$/.exec(name);
    if (generated) built.set(name, (doc = generatedPage(Number(generated[1]))));
    else {
      const fixture = FIXTURES.find(f => f.name === name);
      if (!fixture) throw new Error(`no fixture ${name}`);
      built.set(name, (doc = fixture.build()));
    }
  }
  return doc;
}

async function ready(): Promise<string> {
  if (gpu) return adapter;
  await loadRenderWasm();
  const wasm = renderWasm();
  if (!wasm.GpuRenderer) throw new Error('the web build has no GpuRenderer');
  // One renderer on the one canvas, for the goldens (slot 0) and the seam frames alike: a second WebGPU device on the
  // same canvas loses the first one.
  gpu = await wasm.GpuRenderer.create(canvas, 64);
  adapter = gpu.adapter();
  return adapter;
}

export type GpuGoldenResult = {png: string; meta: GoldenMeta; adapter: string; tiles: number; tileMs: number; sprites: number; counters: string};

async function toBase64Png(rgba: Uint8ClampedArray, width: number, height: number): Promise<string> {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  ctx.putImageData(new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('toBlob failed');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The golden's framing (harness.ts `renderGolden`), painted through the GPU tiles and stitched. */
export async function renderGoldenGpu(fixture: string, pageId: NodeId, dpr: number, maxSide: number, debug: {sprites?: boolean} = {}): Promise<GpuGoldenResult> {
  await ready();
  const doc = documentOf(fixture);
  const page = doc.nodes[pageId];
  if (!page || page.type !== 'PAGE') throw new Error(`no page ${pageId} in ${fixture}`);
  await whenExportReady(doc, [pageId], {fonts, images, timeoutMs: 15_000});
  const whole = pageArea(doc, pageId, fonts) ?? {x: 0, y: 0, width: 100, height: 100};
  const pad = 2;
  const x0 = Math.floor(whole.x - pad), y0 = Math.floor(whole.y - pad);
  const fullW = Math.ceil(whole.x + whole.width + pad) - x0, fullH = Math.ceil(whole.y + whole.height + pad) - y0;
  const width = Math.min(maxSide, Math.ceil(fullW * dpr)), height = Math.min(maxSide, Math.ceil(fullH * dpr));
  const area: Rect = {x: x0, y: y0, width: width / dpr, height: height / dpr};
  const wasm = renderWasm();
  const shadow = new RenderShadow(wasm, images);
  const index = new SpatialIndex();
  index.sync(doc, pageId, fonts.measurer);
  shadow.sync(doc);
  shadow.syncPictures(doc);
  const bg = pageBackground(page);
  const revision = fonts.measurer.revision ?? 0;
  const out = new Uint8ClampedArray(width * height * 4);
  const margin = Math.min(256, Math.ceil(index.blurMargin * dpr));
  const options = JSON.stringify({minSize: 0.5, spriteScale: dpr});
  // Device px of the area's origin at this scale; tiles are on the page's own grid.
  const ox = x0 * dpr, oy = y0 * dpr;
  const i0 = Math.floor(ox / TILE), j0 = Math.floor(oy / TILE);
  const i1 = Math.floor((ox + width - 1e-6) / TILE), j1 = Math.floor((oy + height - 1e-6) / TILE);
  let tiles = 0, sprites = 0, tileMs = 0, counters = '';
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const tileArea = {x: (i * TILE) / dpr, y: (j * TILE) / dpr, width: TILE / dpr, height: TILE / dpr};
      const needed = shadow.doc.sprites_needed(pageId, tileArea.x, tileArea.y, tileArea.width, tileArea.height, dpr, revision);
      if (needed.length && debug.sprites !== false) sprites += paintSprites(shadow.doc, doc, needed, dpr, revision, fonts, images);
      const started = performance.now();
      counters = gpu!.raster_tile(shadow.doc, pageId, dpr, i, j, 0, bg.r, bg.g, bg.b, margin, options);
      const pixels = await gpu!.read_tile(0);
      tileMs += performance.now() - started;
      tiles++;
      for (let ty = 0; ty < TILE; ty++) {
        const y = j * TILE + ty - Math.round(oy);
        if (y < 0 || y >= height) continue;
        for (let tx = 0; tx < TILE; tx++) {
          const x = i * TILE + tx - Math.round(ox);
          if (x < 0 || x >= width) continue;
          const s = (ty * TILE + tx) * 4, d = (y * width + x) * 4;
          out[d] = pixels[s];
          out[d + 1] = pixels[s + 1];
          out[d + 2] = pixels[s + 2];
          out[d + 3] = pixels[s + 3];
        }
      }
    }
  }
  shadow.dispose();
  const png = await toBase64Png(out, width, height);
  return {png, adapter, tiles, tileMs, sprites, counters, meta: {fixture, page: pageId, pageName: page.name, dpr, area, width, height, nodes: Object.keys(doc.nodes).length, textRects: 0, effectRects: 0, paintMs: tileMs}};
}

let scene: {renderer: DesignSceneRenderer; fixture: string} | null = null;
type OffscreenFrame = {pixels: Promise<Uint8Array>; width: number; height: number};
let lastFrame: OffscreenFrame | null = null;

/** One frame of the real GPU scene renderer at `zoom` and `dpr` with the page point (vx, vy) at the canvas corner,
 *  `size` CSS px; resolves after the frame (and the hole filling it schedules) is on screen, for a screenshot. */
export async function seamFrame(fixture: string, pageId: NodeId, zoom: number, dpr: number, vx: number, vy: number, size: {width: number; height: number}, slow = false): Promise<{frames: number; stats: unknown; tilePx: number[]; png?: string}> {
  await ready();
  const doc = documentOf(fixture);
  await whenExportReady(doc, [pageId], {fonts, images, timeoutMs: 15_000});
  if (!scene || scene.fixture !== fixture) {
    scene?.renderer.dispose();
    setEngine('render', 'wasm');
    // `slow`: Chrome's software WebGPU (SwiftShader in the cloud) loses the device on a presented frame after a readback
    // or an effect bitmap, so there the frames are composited off screen and read back (the same quad pass, no
    // present) and the PNG comes from those pixels instead of a screenshot; one tile per frame keeps it short.
    scene = {renderer: createGpuSceneRenderer(canvas, {fonts, images, wasm: renderWasm(), gpu: gpu!, capacity: 64, maxRasterPerFrame: slow ? 1 : undefined, frameSink: slow ? (pixels, width, height) => void (lastFrame = {pixels, width, height}) : undefined}), fixture};
  }
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
  const options = {doc, pageId, viewport: {x: vx, y: vy, zoom}, size, dpr};
  let frames = 0;
  // Several frames: the first paints the view (within its budget), the next ones fill the rest and settle the level.
  for (let k = 0; k < (slow ? 400 : 40); k++) {
    scene.renderer.render(options);
    frames++;
    // Slow adapter: the frame is an off-screen readback; wait for it so the next render can raster its tile.
    if (slow && lastFrame) await lastFrame.pixels;
    await new Promise(resolve => requestAnimationFrame(resolve));
    const stats = (scene.renderer as {stats(): {pending: number; complete: boolean}}).stats();
    if (stats.complete && k > 12) break;
  }
  const screen = zoom * dpr;
  const tilePx: number[] = [];
  for (let i = Math.floor((vx * screen) / TILE); (i * TILE) - vx * screen < size.width * dpr; i++) tilePx.push(Math.round(i * TILE - vx * screen));
  let png: string | undefined;
  if (slow && lastFrame) {
    const {width, height} = lastFrame;
    const rgba = new Uint8ClampedArray((await lastFrame.pixels).buffer.slice(0));
    png = await toBase64Png(rgba.subarray(0, width * height * 4), width, height);
  }
  return {frames, stats: (scene.renderer as {stats(): unknown}).stats(), tilePx, png};
}

/** Frame timing of the real GPU scene renderer on a generated page (scripts/goldens/gpu-bench.ts: the renderer's own
 *  side of TARGETS C1–C4 and C11, without the editor around it). */
export type BenchFrames = {
  layers: number; nodes: number; mode: 'pan' | 'zoom'; dpr: number; zoom: number; size: {width: number; height: number};
  /** Building the document in the page and the renderer's first sync of it. */
  buildMs: number; syncMs: number;
  /** From the first `render` to the first frame with a tile on screen, and to the frame where the view is complete and sharp. */
  firstPaintMs: number; completeMs: number;
  frames: number; fps: number; p50: number; p95: number; p99: number; longest: number;
  /** The renderer's work per frame (`stats().frameMs`) over the measured frames. */
  workP95: number; workP99: number;
  atlasBytes: number; tileBytes: number; tiles: number; jsHeapMb: number | null;
  adapter: string; stats: RenderStats;
};

const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0);

/** `mode` pan: 12 CSS px a frame at 25 % zoom over the page's first screens, turning every 2 s (canvas.ts C1/C2);
 *  zoom: a pinch 1× → 4× → 1× in 4 s about the view's centre, repeated (C4). `ms` of measured frames after the first
 *  complete picture. One fresh renderer per call (the atlas sized as the editor sizes it). `slow`: a software WebGPU
 *  adapter (the cloud's SwiftShader) — frames composited off screen and read back, one tile a frame, as `seamFrame`;
 *  its numbers only prove the plumbing. */
export async function benchScene(layers: number, mode: 'pan' | 'zoom', dpr: number, size: {width: number; height: number}, ms: number, slow = false): Promise<BenchFrames> {
  await ready();
  scene?.renderer.dispose();
  scene = null;
  const name = `generated-${layers}`;
  const buildStart = performance.now();
  const doc = documentOf(name);
  const buildMs = performance.now() - buildStart;
  const pageId = doc.pages[0];
  setEngine('render', 'wasm');
  const capacity = Math.min(atlasCapacity((navigator as {deviceMemory?: number}).deviceMemory), gpu!.capacity());
  lastFrame = null;
  const renderer = createGpuSceneRenderer(canvas, {fonts, images, wasm: renderWasm(), gpu: gpu!, capacity, maxRasterPerFrame: slow ? 1 : undefined, frameSink: slow ? (pixels, width, height) => void (lastFrame = {pixels, width, height}) : undefined});
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
  // On the software adapter the frame is an off-screen readback: wait for it before the next render rasters its tile.
  const settle = async () => {
    if (slow && lastFrame) await lastFrame.pixels;
  };
  const zoom = mode === 'zoom' ? 1 : 0.25;
  const viewport = {x: -40, y: -40, zoom};
  const render = () => renderer.render({doc, pageId, viewport: {...viewport}, size, dpr});
  const syncStart = performance.now();
  renderer.indexFor(doc, pageId);
  const syncMs = performance.now() - syncStart;
  // The first picture: frames until the view is complete and sharp (or 20 s).
  const t0 = performance.now();
  let firstPaintMs = -1, completeMs = -1;
  for (let k = 0; k < 1200; k++) {
    render();
    await settle();
    const t = await nextFrame();
    const s = renderer.stats();
    if (firstPaintMs < 0 && s.tiles > 0) firstPaintMs = t - t0;
    if (s.complete && k > 2) {
      completeMs = t - t0;
      break;
    }
  }
  // Warm-up, then the measured frames.
  const times: number[] = [], work: number[] = [];
  const start = await nextFrame();
  let direction = 1, turned = start;
  const center = {x: viewport.x + size.width / 2 / viewport.zoom, y: viewport.y + size.height / 2 / viewport.zoom};
  for (;;) {
    const t = await nextFrame();
    const elapsed = t - start;
    if (elapsed > ms + 1000) break;
    if (elapsed > 1000) {
      times.push(t);
      work.push(renderer.stats().frameMs);
    }
    if (mode === 'pan') {
      if (t - turned > 2000) {
        direction = -direction;
        turned = t;
      }
      viewport.x += (12 * direction) / viewport.zoom;
    } else {
      const phase = ((elapsed / 4000) % 1);
      const z = phase < 0.5 ? 4 ** (phase * 2) : 4 / 4 ** ((phase - 0.5) * 2);
      viewport.zoom = z;
      viewport.x = center.x - size.width / 2 / z;
      viewport.y = center.y - size.height / 2 / z;
    }
    render();
    await settle();
  }
  // On the software adapter the renderer keeps filling holes with off-screen frames of its own, each borrowing the wasm
  // renderer until its readback resolves: wait until a whole animation frame passes without a new one before touching it.
  if (slow) {
    for (let k = 0; k < 60; k++) {
      // Assigned by the frame sink while this function awaits: the narrowing to null above does not hold here.
      const seen = lastFrame as OffscreenFrame | null;
      if (seen) await seen.pixels;
      await nextFrame();
      if (lastFrame === seen) break;
    }
  }
  const deltas = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const sortedWork = [...work].sort((a, b) => a - b);
  const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const stats = renderer.stats();
  const heap = (performance as {memory?: {usedJSHeapSize: number}}).memory?.usedJSHeapSize;
  const out: BenchFrames = {
    layers, nodes: Object.keys(doc.nodes).length, mode, dpr, zoom, size, buildMs, syncMs, firstPaintMs, completeMs,
    frames: deltas.length, fps: span > 0 ? ((times.length - 1) / span) * 1000 : 0,
    p50: percentile(deltas, 0.5), p95: percentile(deltas, 0.95), p99: percentile(deltas, 0.99), longest: deltas.length ? deltas[deltas.length - 1] : 0,
    workP95: percentile(sortedWork, 0.95), workP99: percentile(sortedWork, 0.99),
    atlasBytes: gpu!.memory_bytes(), tileBytes: stats.tileBytes, tiles: stats.tiles, jsHeapMb: heap === undefined ? null : heap / 2 ** 20,
    adapter, stats,
  };
  // The scene renderer owns the GpuRenderer it was given and frees it: the next bench (or golden) makes a fresh one.
  renderer.dispose();
  gpu = null;
  return out;
}

declare global {
  interface Window {
    gpuHarness: {ready: typeof ready; listFixtures: typeof listFixtures; renderGoldenGpu: typeof renderGoldenGpu; seamFrame: typeof seamFrame; benchScene: typeof benchScene; gpu: () => RenderWasmGpu | null; wasm: typeof renderWasm; documentOf: typeof documentOf; canvas: HTMLCanvasElement; shadowOf: (fixture: string) => RenderShadow; sprites: (shadow: RenderShadow, fixture: string, ids: NodeId[], scale: number) => number; createScene: (fixture: string, slow?: boolean) => DesignSceneRenderer; lastFrame: () => Promise<unknown> | null; sceneRender: (renderer: DesignSceneRenderer, fixture: string, zoom: number, dpr: number, vx: number, vy: number, size: {width: number; height: number}) => unknown};
  }
}
// `gpu`, `wasm`, `documentOf`, `canvas`: for probes from the driver (a step-by-step repro of a device loss).
window.gpuHarness = {
  ready, listFixtures: () => listFixtures(documentOf), renderGoldenGpu, seamFrame, benchScene, gpu: () => gpu, wasm: renderWasm, documentOf, canvas,
  shadowOf: fixture => {
    const doc = documentOf(fixture);
    const shadow = new RenderShadow(renderWasm(), images);
    shadow.sync(doc);
    shadow.syncPictures(doc);
    return shadow;
  },
  sprites: (shadow, fixture, ids, scale) => paintSprites(shadow.doc, documentOf(fixture), ids, scale, fonts.measurer.revision ?? 0, fonts, images),
  lastFrame: () => lastFrame?.pixels ?? null,
  createScene: (fixture, slow = false) => {
    void documentOf(fixture);
    setEngine('render', 'wasm');
    return createGpuSceneRenderer(canvas, {fonts, images, wasm: renderWasm(), gpu: gpu!, capacity: 64, maxRasterPerFrame: slow ? 1 : undefined, frameSink: slow ? (pixels, width, height) => void (lastFrame = {pixels, width, height}) : undefined});
  },
  sceneRender: (renderer, fixture, zoom, dpr, vx, vy, size) => {
    const doc = documentOf(fixture);
    renderer.render({doc, pageId: 't1', viewport: {x: vx, y: vy, zoom}, size, dpr});
    return (renderer as {stats(): unknown}).stats();
  },
};
document.getElementById('out')!.textContent = `gpu harness: ${FIXTURES.length} fixtures`;
document.getElementById('out')!.dataset.state = 'ready';
