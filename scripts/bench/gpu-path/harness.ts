// Browser side of scripts/bench/gpu-path/run.ts: the GPU scene renderer of lane L4 driven through a pan with frame titles
// on, as the editor drives it, on its real renderer document (crates/render-wasm's RenderDoc, the web build) and a stub
// GPU (tile rasters and frames return at once: no WebGPU in the cloud containers). What it times is the editor-side
// work of a GPU frame — the sync, the text sprites Canvas2D paints for new tiles, the quads, the options, the titles —
// with the GPU's own work taken out; the Canvas2D renderer pans the same document for comparison.
import type {DesignDocument} from '../../../shared/design/types';
import type {RenderWasm, RenderWasmGpu} from '../../../shared/design/render-engine';
import {createFontRegistry} from '../../../src/design/engine/fonts';
import {createImageCache} from '../../../src/design/engine/images';
import {createCanvasSceneRenderer, type DesignSceneRenderer} from '../../../src/design/engine/render/scene-renderer';
import {createGpuSceneRenderer} from '../../../src/design/engine/render/gpu/gpu-scene-renderer';
import {generatedPage} from '../../goldens/fixtures';

type Phases = Record<string, number>;
const fonts = createFontRegistry({base: '/fonts'});
const images = createImageCache();

const COUNTERS = JSON.stringify({nodes: 0, fills: 0, strokes: 0, layers: 0, effectBitmaps: 0, backdrops: 0, sprites: 0, missingSprites: 0, missingPictures: 0});
const stubGpu = (): RenderWasmGpu => ({
  adapter: () => 'stub', capacity: () => 1024, resize() {}, raster_tile: () => COUNTERS, frame: () => '', frame_pixels: async () => new Uint8Array(0),
  upload: () => 0, release() {}, read_tile: async () => new Uint8Array(0), render: async () => new Uint8Array(0), memory_bytes: () => 0, free() {},
} as unknown as RenderWasmGpu);

let built: DesignDocument | null = null;
const documentOf = (layers: number) => (built ??= generatedPage(layers));

async function pan(engine: 'gpu' | 'canvas2d', layers: number, frames: number): Promise<{total: number[]; phases: Phases[]}> {
  const wasmModule = await import(/* @vite-ignore */ '/src/design/wasm-render/morfa_render_wasm.js' as string) as RenderWasm & {default(): Promise<unknown>};
  await wasmModule.default();
  const doc = documentOf(layers);
  const old = document.getElementById('scene')!;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = old.style.cssText;
  old.replaceWith(canvas);
  canvas.id = 'scene';
  const renderer: DesignSceneRenderer = engine === 'gpu'
    ? createGpuSceneRenderer(canvas, {fonts, images, wasm: wasmModule, gpu: stubGpu(), capacity: 1024})
    : createCanvasSceneRenderer(canvas, {fonts, images});
  const size = {width: 1440, height: 900}, dpr = 2, zoom = 0.25;
  const selected = new Set<string>();
  const options = (x: number) => ({doc, pageId: doc.pages[0], viewport: {x, y: -40, zoom}, size, dpr, labels: {selected, editing: null}});
  // Settle: the first picture and its ring, as the editor shows the file before a pan.
  for (let k = 0; k < 120; k++) {
    renderer.render(options(-40));
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  await fonts.whenIdle();
  const total: number[] = [], phases: Phases[] = [];
  for (let k = 0; k < frames; k++) {
    const started = performance.now();
    renderer.render(options(-40 + k * 14 / zoom / dpr));
    total.push(performance.now() - started);
    const p = (renderer.stats() as {phases?: Phases}).phases;
    if (p) phases.push(p);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  renderer.dispose();
  return {total, phases};
}

/** Every text of the golden fixtures (and a 100k page's first screens) painted as a sprite on a reused canvas and on a new
 *  one, at three scales, interleaved so the reused canvases are reused: the bytes must be equal. */
async function spriteCheck(): Promise<{sprites: number; differing: string[]}> {
  const {FIXTURES} = await import('../../goldens/fixtures');
  const {paintSprite} = await import('../../../src/design/engine/render/gpu/text-sprites');
  const {textLayoutOf, textRegion} = await import('../../../src/design/engine/render/text-draw');
  const {whenExportReady} = await import('../../../src/design/engine/export-raster');
  let sprites = 0;
  const differing: string[] = [];
  for (const fixture of FIXTURES) {
    const doc = fixture.build();
    await whenExportReady(doc, doc.pages, {fonts, images, timeoutMs: 15_000});
    await fonts.whenIdle();
    const texts = Object.values(doc.nodes).filter(n => n.type === 'TEXT' && n.text).slice(0, 400);
    for (const scale of [0.37, 1, 2]) for (const node of texts) {
      const layout = textLayoutOf(node, fonts), region = textRegion(node, layout);
      const reused = paintSprite(doc, node, layout, region, scale, fonts, images);
      const fresh = paintSprite(doc, node, layout, region, scale, fonts, images, true);
      if (!reused || !fresh) continue;
      sprites++;
      let same = reused.width === fresh.width && reused.height === fresh.height && reused.rgba.length === fresh.rgba.length;
      for (let k = 0; same && k < reused.rgba.length; k++) if (reused.rgba[k] !== fresh.rgba[k]) same = false;
      if (!same) differing.push(`${fixture.name}/${node.id}@${scale}`);
    }
  }
  return {sprites, differing};
}

declare global {
  interface Window {
    gpuPath: {pan: typeof pan; spriteCheck: typeof spriteCheck};
  }
}
window.gpuPath = {pan, spriteCheck};
document.getElementById('out')!.textContent = 'gpu-path harness';
document.getElementById('out')!.dataset.state = 'ready';
