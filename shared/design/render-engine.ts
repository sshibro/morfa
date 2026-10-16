import {withEngine} from './engine-switch';

// The renderer's own wasm module (crates/render-wasm, scripts/wasm-render-build.sh), the `render` module of the engine
// switch (shared/design/engine-switch.ts). It is not inside `morfa-wasm`: the editor loads it lazily
// (src/design/engine/render-wasm.ts, WebGPU build) and Node loads the CPU build on first use, as the text engine does
// (shared/design/text-engine.ts). What crosses the boundary: the document as the store's own patches, pictures as
// decoded pixels, text as sprites the host paints (text drawing is lane L3's), and rendered pixels back.

/** `RenderDoc` of crates/render-wasm. */
export interface RenderWasmDoc {
  load(json: string): void;
  /** The whole document from the engine shadow's `encode()` (S1's binary codec): the big-file path, no JSON on the way. */
  load_bytes(bytes: Uint8Array): void;
  load_part(json: string): void;
  apply_patch(json: string): void;
  version(): number;
  pages(): string[];
  register_image(ref: string, width: number, height: number, rgba: Uint8Array): void;
  has_image(ref: string): boolean;
  set_text_sprite(id: string, scale: number, x: number, y: number, w: number, h: number, pw: number, ph: number, revision: number, rgba: Uint8Array): void;
  drop_text_sprites(id: string): void;
  clear_text_sprites(): void;
  set_sprite_budget(bytes: number): void;
  sprites_needed(page: string, x: number, y: number, w: number, h: number, scale: number, revision: number): string[];
  page_area(page: string): Float64Array | number[];
  bounds(page: string, id: string): Float64Array | number[];
  blur_margin(page: string): number;
  stats(): string;
  last_counters(): string;
  last_size(): Uint32Array | number[];
  /** CPU build only: straight-alpha RGBA8 of the page rectangle at `scale`. */
  render?(page: string, x: number, y: number, w: number, h: number, scale: number, r: number, g: number, b: number, options: string): Uint8Array;
  free(): void;
}

/** `GpuRenderer` of crates/render-wasm (the WebGPU build). */
export interface RenderWasmGpu {
  adapter(): string;
  capacity(): number;
  resize(width: number, height: number): void;
  raster_tile(doc: RenderWasmDoc, page: string, scale: number, i: number, j: number, slot: number, r: number, g: number, b: number, margin: number, options: string): string;
  frame(doc: RenderWasmDoc, r: number, g: number, b: number, quads: Float32Array, live: string, base: Float64Array, scale: number, options: string, overlay: number): string;
  /** The same frame drawn off screen at the canvas size, read back as RGBA8 (nothing presented): the harness on a software adapter, tests. */
  frame_pixels(doc: RenderWasmDoc, r: number, g: number, b: number, quads: Float32Array, live: string, base: Float64Array, scale: number, options: string, overlay: number): Promise<Uint8Array>;
  upload(width: number, height: number, rgba: Uint8Array): number;
  release(handle: number): void;
  read_tile(slot: number): Promise<Uint8Array>;
  render(doc: RenderWasmDoc, page: string, x: number, y: number, w: number, h: number, scale: number, r: number, g: number, b: number, options: string): Promise<Uint8Array>;
  memory_bytes(): number;
  free(): void;
}

export interface RenderWasm {
  version(): string;
  RenderDoc: {new (json: string): RenderWasmDoc; decode(bytes: Uint8Array): RenderWasmDoc};
  GpuRenderer?: {create(canvas: HTMLCanvasElement, tiles: number): Promise<RenderWasmGpu>};
}

/** Painting options as crates/render-wasm reads them. */
export type RenderWasmOptions = {
  hidden?: string[];
  outlines?: boolean;
  layoutGrids?: boolean;
  paintHiddenRoots?: boolean;
  minSize?: number;
  rootOpacity?: number;
  spriteScale?: number;
  clipToAncestors?: boolean;
  /** A board's dot grid in the raster target's device px (the editor's GPU tiles: src/design/engine/render/dot-grid.ts). */
  dotGrid?: {lefts: number[]; tops: number[]; side: number; color: readonly number[]};
};

/** Counters of one render (`last_counters`). */
export type RenderCounters = {nodes: number; fills: number; strokes: number; layers: number; effectBitmaps: number; backdrops: number; sprites: number; missingSprites: number; missingPictures: number};

type Runtime = {process?: {env?: Record<string, string | undefined>; versions?: {node?: string}; getBuiltinModule?: (id: string) => unknown}};
const runtime = globalThis as Runtime;

let wasm: RenderWasm | null = null;
let loadError: Error | null = null;

/** Installs a loaded module (the browser's loader, tests). */
export function setRenderWasm(module: RenderWasm | null): void {
  wasm = module;
  loadError = null;
}

export const renderWasmLoaded = (): boolean => wasm !== null;

/** In Node the CommonJS build loads on first use (process.getBuiltinModule keeps bundlers from seeing it). */
function loadInNode(): RenderWasm | null {
  const proc = runtime.process;
  const getBuiltin = proc?.getBuiltinModule;
  if (!proc?.versions?.node || typeof getBuiltin !== 'function') return null;
  const {createRequire} = getBuiltin('node:module') as {createRequire: (url: string) => (id: string) => unknown};
  const path = proc.env?.MORFA_WASM_RENDER_PATH ?? new URL('../../server/design/wasm-render/morfa_render_wasm.js', import.meta.url).pathname;
  return createRequire(import.meta.url)(path) as RenderWasm;
}

/** The loaded renderer module; throws when none can be loaded (never a silent fallback). */
export function renderWasm(): RenderWasm {
  if (wasm) return wasm;
  if (!loadError) {
    try {
      wasm = loadInNode();
    } catch (error) {
      loadError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!wasm) throw loadError ?? new Error('render-engine: the renderer wasm is not loaded (scripts/wasm-render-build.sh; in the browser src/design/engine/render-wasm.ts)');
  return wasm;
}

/** True when the module can be loaded here without throwing. */
export function renderWasmAvailable(): boolean {
  try {
    renderWasm();
    return true;
  } catch {
    return false;
  }
}

export const parseCounters = (json: string): RenderCounters => JSON.parse(json) as RenderCounters;

const fetched = new WeakMap<object, Uint8Array>();
/** The open from checkpoint bytes notes the bytes `doc` was decoded from; the renderer's
 *  shadow then loads them as they are (`RenderDoc.load_bytes`) instead of encoding the engine's shadow again. Only that
 *  document object: any change since makes another one, which loads the usual way. */
export function noteCheckpointBytes(doc: object, bytes: Uint8Array): void {
  fetched.set(doc, bytes);
}
/** The bytes `doc` was decoded from, when the open noted them (`noteCheckpointBytes`); else null. */
export const checkpointBytesOf = (doc: object): Uint8Array | null => fetched.get(doc) ?? null;

/** `withEngine('render', …)` with the module's own signature: `ts` paints with Canvas2D, `wasm` through the renderer. */
export const viaRenderEngine = <T>(call: string, ts: () => T, wasm: () => T, options?: {equal?: (ts: T, wasm: T) => string | null; inputs?: unknown}): T => withEngine('render', call, ts, wasm, options);
